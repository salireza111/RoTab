import {
  ENGINE_ID,
  SOURCE_SHA,
  type BrowserModelCheckpoint,
  type Snapshot,
} from "@rosettatab/shared";
import { wasmHeapMetric } from "./telemetry";
import { appendFrame } from "./snapshot-frames";

interface PoolOptions {
  models: BrowserModelCheckpoint[];
  parallelism: number;
  dutyCycle: number;
  onUpdate: (view: Partial<Snapshot>) => void;
  onBoundary: (model: BrowserModelCheckpoint) => Promise<void>;
  onComplete: () => void;
  onError: (message: string) => void;
  compiledModule?: WebAssembly.Module;
  stageStartup?: boolean;
  makeWorker?: () => Worker;
}

// One worker runs one independent seeded model. Scientific protocols remain
// single-threaded; this pool increases model throughput without subdividing one
// Rosetta trajectory or sharing its mutable state between workers.
export class BrowserModelPool {
  readonly workers = new Map<number, Worker>();
  private readonly live = new Map<number, Partial<Snapshot>>();
  private readonly memory = new Map<
    number,
    { bytes: number; timestamp: number }
  >();
  private stopped = false;
  private pendingBoundaries = 0;
  private finished = false;
  private starting?: number;
  private publishedAt = 0;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private readonly options: PoolOptions;
  constructor(options: PoolOptions) {
    this.options = { ...options };
  }

  start() {
    this.fill();
    this.publish(true);
    this.maybeComplete();
  }

  stop() {
    this.stopped = true;
    if (this.publishTimer) clearTimeout(this.publishTimer);
    for (const worker of this.workers.values()) this.terminate(worker);
    this.workers.clear();
    this.memory.clear();
    this.live.clear();
    this.options.compiledModule = undefined;
    for (const model of this.options.models)
      if (!model.result) model.status = "queued";
  }

  private fill() {
    if (this.stopped) return;
    for (const [index, model] of this.options.models.entries()) {
      if (this.options.stageStartup && this.starting !== undefined) break;
      if (this.workers.size >= this.options.parallelism) break;
      if (model.result || this.workers.has(index)) continue;
      try {
        this.launch(index, model);
      } catch (error) {
        this.fail(error instanceof Error ? error.message : String(error));
        return;
      }
    }
  }

  private launch(index: number, model: BrowserModelCheckpoint) {
    const worker = this.options.makeWorker
      ? this.options.makeWorker()
      : new Worker(new URL("./science.worker.ts", import.meta.url), {
          type: "module",
        });
    this.workers.set(index, worker);
    if (this.options.stageStartup) this.starting = index;
    model.status = "running";
    model.startedAt = Date.now();
    model.execution = {
      parallelism: this.options.parallelism,
      dutyCycle: this.options.dutyCycle,
    };
    model.history = [];
    model.frames = [];
    model.bestEnergy = undefined;
    worker.onmessage = ({ data }) => {
      if (this.stopped || this.workers.get(index) !== worker) return;
      if (data.type === "ready" && this.starting === index) {
        this.starting = undefined;
        this.fill();
        this.publish(true);
        return;
      }
      if (
        typeof data.heapBytes === "number" &&
        Number.isFinite(data.heapBytes) &&
        data.heapBytes >= 0
      )
        this.memory.set(index, {
          bytes: data.heapBytes,
          timestamp: Date.now(),
        });
      if (data.type === "snapshot") {
        if (
          typeof data.energy !== "number" ||
          !Number.isFinite(data.energy) ||
          typeof data.pdb !== "string" ||
          !data.pdb
        ) {
          this.fail("The scientific worker returned an invalid energy.");
          return;
        }
        appendFrame(model, model.task.id, {
          pdb: data.pdb,
          energy: data.energy,
          sequence: data.sequence,
          elapsedMs: Date.now() - model.startedAt,
          source: data.source,
          step: data.iteration,
        });
        model.bestEnergy = Math.min(model.bestEnergy ?? Infinity, data.energy);
        this.live.set(index, {
          pdb: data.pdb,
          energy: data.energy,
          snapshotSequence: data.sequence,
          snapshotSource: data.source,
          snapshotStep: data.iteration,
          snapshotAt: data.timestamp,
          completed: Math.max(0, Math.min(0.99, Number(data.progress) || 0)),
        });
      }
      if (data.type === "error") {
        this.fail(data.message || "A Rosetta model failed.");
        return;
      }
      if (data.type === "result") {
        if (
          typeof data.pdb !== "string" ||
          !data.pdb ||
          typeof data.energy !== "number" ||
          !Number.isFinite(data.energy)
        ) {
          this.fail("The scientific worker returned an invalid model.");
          return;
        }
        this.terminate(worker);
        this.workers.delete(index);
        if (this.starting === index) this.starting = undefined;
        this.memory.delete(index);
        model.result = {
          attemptToken: model.task.attemptToken!,
          pdb: data.pdb,
          energy: data.energy,
          elapsedMs: Date.now() - model.startedAt,
          engineId: ENGINE_ID,
          sourceSha: SOURCE_SHA,
        };
        model.status = "complete";
        model.bestEnergy = Math.min(model.bestEnergy ?? Infinity, data.energy);
        appendFrame(
          model,
          model.task.id,
          {
            pdb: data.pdb,
            energy: data.energy,
            elapsedMs: model.result.elapsedMs,
            source: "final",
          },
          model.history?.at(-1) !== data.energy,
        );
        this.live.delete(index);
        this.pendingBoundaries++;
        this.publish(true);
        void this.options.onBoundary(model).then(
          () => {
            this.pendingBoundaries--;
            if (this.stopped) return;
            this.fill();
            this.publish(true);
            this.maybeComplete();
          },
          (error) =>
            this.fail(error instanceof Error ? error.message : String(error)),
        );
        return;
      }
      if (
        data.type === "telemetry" ||
        data.type === "snapshot" ||
        data.type === "phase"
      )
        this.publish();
    };
    worker.onerror = (error) => {
      if (this.workers.get(index) === worker)
        this.fail(error.message || "A Rosetta worker stopped unexpectedly.");
    };
    worker.postMessage({
      type: "run",
      task: model.task,
      dutyCycle: this.options.dutyCycle,
      compiledModule: this.options.compiledModule,
    });
    // postMessage has synchronously cloned the immutable module. Once every
    // unfinished model has its own worker, the page no longer needs to retain
    // the compiler's module; running workers own the remaining references.
    if (
      this.options.models.every(
        (candidate, index) => candidate.result || this.workers.has(index),
      )
    )
      this.options.compiledModule = undefined;
  }

  private terminate(worker: Worker) {
    // Break host-side callbacks as well as shutting down the worker isolate.
    // Persisted coordinates/history live in the model checkpoint, not here.
    worker.onmessage = null;
    worker.onerror = null;
    worker.terminate();
  }

  view(): Partial<Snapshot> {
    const { models, parallelism } = this.options;
    const completedModels = models.filter((model) => model.result).length;
    const unfinished = models.findIndex((model) => !model.result);
    const focusedModel =
      unfinished >= 0
        ? unfinished
        : models.reduce(
            (best, model, index) =>
              (model.result?.energy ?? Infinity) <
              (models[best]?.result?.energy ?? Infinity)
                ? index
                : best,
            0,
          );
    const focus = models[focusedModel],
      live = this.live.get(focusedModel);
    const latestFrame = focus?.frames?.at(-1);
    const now = Date.now();
    // A partial sum would understate allocation. Hide the aggregate until every
    // alive worker has reported a fresh measurement.
    const readings = [...this.workers.keys()].map((index) =>
      this.memory.get(index),
    );
    const allFresh =
      readings.length > 0 &&
      readings.every((reading) => reading && now - reading.timestamp <= 5000);
    const metric = allFresh
      ? wasmHeapMetric(
          readings.reduce((sum, reading) => sum + reading!.bytes, 0),
          Math.min(...readings.map((reading) => reading!.timestamp)),
        )
      : undefined;
    if (metric)
      metric.scope = `${this.workers.size} shared scientific worker${this.workers.size === 1 ? "" : "s"}' allocated WASM linear memory`;
    return {
      parallelism,
      activeWorkers: this.workers.size,
      completedModels,
      totalModels: models.length,
      focusedModel,
      completed: models.reduce(
        (sum, model, index) =>
          sum + (model.result ? 1 : (this.live.get(index)?.completed ?? 0)),
        0,
      ),
      total: models.length,
      pdb:
        focus?.result?.pdb ?? live?.pdb ?? latestFrame?.pdb ?? focus?.task.pdb,
      startingPdb: focus?.task.pdb,
      energy: focus?.result?.energy ?? live?.energy ?? latestFrame?.energy,
      bestEnergy: models.reduce<number | undefined>((best, model) => {
        const energy = model.bestEnergy ?? model.result?.energy;
        return energy === undefined ? best : Math.min(best ?? Infinity, energy);
      }, undefined),
      history: focus?.history ?? [],
      frames: focus?.frames ?? [],
      snapshotSequence: live?.snapshotSequence ?? latestFrame?.sequence,
      snapshotSource: live?.snapshotSource ?? latestFrame?.source,
      snapshotStep: live?.snapshotStep ?? latestFrame?.step,
      snapshotAt: live?.snapshotAt,
      modelResults: models.flatMap((model) =>
        model.result
          ? [
              {
                modelIndex: model.task.modelIndex,
                seed: model.task.seed,
                pdb: model.result.pdb,
                energy: model.result.energy,
                elapsedMs: model.result.elapsedMs,
              },
            ]
          : [],
      ),
      metrics: metric ? [metric] : [],
    };
  }

  private publish(immediate = false) {
    if (this.stopped) return;
    const remaining = 200 - (Date.now() - this.publishedAt);
    // Aggregate worker events before broadcasting to every viewing tab. Keep
    // independent model history internally without multiplying UI refresh rate.
    if (!immediate && remaining > 0) {
      this.publishTimer ??= setTimeout(() => {
        this.publishTimer = undefined;
        this.publish(true);
      }, remaining);
      return;
    }
    if (this.publishTimer) clearTimeout(this.publishTimer);
    this.publishTimer = undefined;
    this.publishedAt = Date.now();
    this.options.onUpdate(this.view());
  }
  private maybeComplete() {
    if (
      this.stopped ||
      this.finished ||
      this.pendingBoundaries ||
      !this.options.models.every((model) => model.result)
    )
      return;
    this.finished = true;
    this.options.compiledModule = undefined;
    this.options.onComplete();
  }
  private fail(message: string) {
    if (this.stopped) return;
    this.stop();
    this.options.onError(message);
  }
}
