import {
  ENGINE_ID,
  SOURCE_SHA,
  initialSnapshot,
  type Snapshot,
  type Checkpoint,
  type EngineManifest,
  type Metric,
  type Task,
  type StructureSnapshot,
  type BrowserModelCheckpoint,
  protocolSchema,
  type Protocol,
} from "@rosettatab/shared";
import { api } from "./api";
import {
  clientId,
  getState,
  putState,
  readPreferences,
  completeBrowserTask,
} from "./storage";
import { bundledTask } from "./browser-tasks";
import { visibleResourceMetrics, wasmHeapMetric } from "./telemetry";
import { BrowserModelPool } from "./browser-pool";
import { compileScientificModule } from "./science-module";
import { validWorkerCount } from "./compute-settings";
import {
  canonicalStringify,
  peerSha256,
  validatePeerJob,
  type PeerJob,
} from "./peer-protocol";
import {
  appendFrame,
  applyFrameDelta,
  makeFrameDelta,
} from "./snapshot-frames";

type BenchmarkInput = {
  task: Task;
  metadata: Record<string, unknown>;
  runProtocol?: Protocol;
};
type PeerInput = { job: PeerJob; jobHash: string };

type Command = "start" | "demo" | "pause" | "stop" | "refresh";
export class Session {
  readonly id = crypto.randomUUID();
  readonly channel = new BroadcastChannel("rosettatab:session-v1");
  snapshot = initialSnapshot();
  owner = false;
  manifest?: EngineManifest;
  worker?: Worker;
  browserPool?: BrowserModelPool;
  checkpoint?: Checkpoint;
  timer?: ReturnType<typeof setInterval>;
  heartbeat?: ReturnType<typeof setInterval>;
  queueTimer?: ReturnType<typeof setTimeout>;
  uploadTimer?: ReturnType<typeof setTimeout>;
  disposed = false;
  release?: () => void;
  abort = new AbortController();
  action = Promise.resolve();
  private initialized = false;
  private controlEpoch = 0;
  private checkpointWrites = Promise.resolve();
  private broadcastFrames: StructureSnapshot[] = [];
  private broadcastFrameKey?: string;
  constructor(readonly update: (snapshot: Snapshot, owner: boolean) => void) {
    this.channel.onmessage = (e) => {
      if (e.data.type === "snapshot" && !this.owner) {
        this.snapshot = {
          ...e.data.snapshot,
          frames:
            e.data.snapshot.frames ??
            applyFrameDelta(this.snapshot.frames ?? [], e.data.frameDelta),
        };
        this.update(this.snapshot, false);
      }
      if (e.data.type === "hello" && this.owner) this.broadcast(true);
      if (e.data.type === "command" && this.owner) this.enqueue(e.data.command);
    };
    this.channel.postMessage({ type: "hello" });
    void navigator.locks
      .request(
        "rosettatab:compute-v1",
        { signal: this.abort.signal },
        async () => {
          if (this.disposed) return;
          this.owner = true;
          this.snapshot.ownerId = this.id;
          await this.initialize();
          await new Promise<void>((resolve) => {
            this.release = resolve;
            if (this.disposed) resolve();
          });
        },
      )
      .catch((e) => {
        if (e.name !== "AbortError")
          this.set({
            state: "error",
            message: "Exclusive tab ownership is unavailable.",
          });
      });
  }
  async initialize() {
    this.snapshot.metrics = [];
    const handover = ["loading", "running", "uploading", "waiting"].includes(
      this.snapshot.state,
    );
    this.manifest = await fetch("./engine/engine-metadata.json")
      .then((r) => r.json())
      .catch(() => undefined);
    if (
      this.manifest?.verified &&
      (this.manifest.id !== ENGINE_ID || this.manifest.sourceSha !== SOURCE_SHA)
    )
      this.manifest = {
        ...this.manifest,
        verified: false,
        reason:
          "The installed scientific engine belongs to another version. Install the matching verified extension build.",
      };
    this.checkpoint = await getState<Checkpoint>("checkpoint");
    if (this.checkpoint && !this.checkpoint.taskSource) {
      if (readPreferences().apiUrl) {
        this.checkpoint.taskSource = "research";
        this.checkpoint.serverUrl = readPreferences().apiUrl;
      } else {
        await putState(
          "archived-server-checkpoint:" + this.checkpoint.task.id,
          this.checkpoint,
        );
        this.checkpoint = undefined;
        await putState("checkpoint", undefined);
      }
    }
    if (
      this.checkpoint &&
      (this.checkpoint.task.engineId !== ENGINE_ID ||
        this.checkpoint.task.sourceSha !== SOURCE_SHA)
    ) {
      // Keep prior results locally across engine upgrades; never execute or
      // relabel them as a task for the new scientific application identity.
      await putState(
        "archived-checkpoint:" + this.checkpoint.task.engineId,
        this.checkpoint,
      );
      this.checkpoint = undefined;
      await putState("checkpoint", undefined);
    }
    this.snapshot.mode = "browser";
    this.snapshot.taskSource =
      this.checkpoint?.taskSource ?? (await this.nextTaskSource());
    if (this.checkpoint)
      this.set({
        state: "paused",
        taskSource: this.checkpoint.taskSource,
        peerJobId: this.checkpoint.peer?.jobId,
        title: this.checkpoint.task.title,
        description: this.checkpoint.task.description,
        publisherId: this.checkpoint.peer?.publisherId,
        pdb: this.checkpoint.result?.pdb ?? this.checkpoint.task.pdb,
        startingPdb: this.checkpoint.task.pdb,
        taskId: this.checkpoint.task.id,
        protocol: this.checkpoint.task.protocol,
        energy: this.checkpoint.result?.energy,
        bestEnergy:
          this.checkpoint.bestEnergy ?? this.checkpoint.result?.energy,
        history:
          this.checkpoint.history ??
          (this.checkpoint.result ? [this.checkpoint.result.energy] : []),
        frames: this.checkpoint.frames ?? [],
        elapsedMs:
          this.checkpoint.result?.elapsedMs ??
          Date.now() - this.checkpoint.startedAt,
        completed: this.checkpoint.result ? 1 : 0,
        total: 1,
        message:
          "Checkpoint recovered. Resume to continue or submit your saved result.",
        checkpointAt: this.checkpoint.startedAt,
        ...this.batchView(this.checkpoint),
      });
    else if (!this.manifest?.verified)
      this.set({
        state: "unavailable",
        message:
          this.manifest?.reason ??
          "The verified Rosetta engine is not installed.",
      });
    else {
      const saved = (await getState<Checkpoint[]>("browser-results"))?.[0];
      if (
        (!readPreferences().apiUrl || saved?.taskSource === "peer") &&
        saved?.result &&
        saved.task.engineId === ENGINE_ID &&
        saved.task.sourceSha === SOURCE_SHA
      )
        this.set({
          state: "complete",
          taskSource: saved.taskSource ?? "bundled",
          peerJobId: saved.peer?.jobId,
          title: saved.task.title,
          description: saved.task.description,
          publisherId: saved.peer?.publisherId,
          taskId: saved.task.id,
          protocol: saved.task.protocol,
          pdb: saved.result.pdb,
          startingPdb: saved.task.pdb,
          energy: saved.result.energy,
          bestEnergy: saved.bestEnergy ?? saved.result.energy,
          history: saved.history ?? [saved.result.energy],
          frames: saved.frames ?? [],
          elapsedMs: saved.result.elapsedMs,
          completed: 1,
          total: 1,
          message:
            "Your last browser calculation is saved on this device. It has not been submitted for volunteer credit.",
          ...this.batchView(saved),
        });
      else
        this.set({
          message: readPreferences().apiUrl
            ? "Ready for a hosted research task. All calculations run in browser WebAssembly."
            : "Ready to run real Rosetta in browser WebAssembly. No server or separate application is needed.",
        });
    }
    this.timer = setInterval(() => {
      void this.sampleMetrics();
      if (
        this.checkpoint &&
        ["loading", "running"].includes(this.snapshot.state)
      )
        this.snapshot.elapsedMs = Date.now() - this.checkpoint.startedAt;
      if (this.owner) this.broadcast();
    }, 1000);
    await this.sampleMetrics();
    this.initialized = true;
    if (
      (handover &&
        (this.checkpoint ||
          (this.snapshot.taskSource !== "peer" && this.manifest?.verified))) ||
      (readPreferences().automatic &&
        this.snapshot.taskSource !== "peer" &&
        (this.checkpoint || this.manifest?.verified))
    )
      this.enqueue("start");
  }
  command(command: Command) {
    if (this.owner) this.enqueue(command);
    else this.channel.postMessage({ type: "command", command });
  }
  /** Called only by the local recipient's explicit acceptance control. */
  acceptPeerJob(job: PeerJob, jobHash: string): Promise<void> {
    const accepted = this.action.then(async () => {
      this.assertPeerAcceptanceAvailable();
      const epoch = this.controlEpoch;
      const validated = await validatePeerJob(job, this.manifest!);
      if ((await peerSha256(canonicalStringify(validated))) !== jobHash)
        throw new Error("The peer job record has an invalid hash.");
      this.assertPeerAcceptanceAvailable();
      if (epoch !== this.controlEpoch)
        throw new Error("Peer job acceptance was interrupted.");
      const saved = (await getState<Checkpoint[]>("browser-results")) ?? [];
      if (saved.some((record) => record.peer?.jobId === validated.id))
        throw new Error("This peer job has already completed on this device.");
      if (this.disposed || epoch !== this.controlEpoch)
        throw new Error("Peer job acceptance was interrupted.");
      await putState("peer-input", { job: validated, jobHash });
      if (this.disposed || epoch !== this.controlEpoch)
        throw new Error("Peer job acceptance was interrupted.");
      try {
        await this.start();
      } catch (error) {
        if (!this.disposed && epoch === this.controlEpoch)
          this.set({
            state: "error",
            message: error instanceof Error ? error.message : String(error),
          });
        throw error;
      }
    });
    // Rejections belong to the acceptance control; leave the existing scientific
    // state untouched and keep the command queue usable for later controls.
    this.action = accepted.catch(() => {});
    return accepted;
  }
  private assertPeerAcceptanceAvailable() {
    if (!this.owner || !this.initialized || this.disposed)
      throw new Error("Accept this job in the ready computing tab.");
    if (
      this.checkpoint ||
      !["idle", "complete", "error"].includes(this.snapshot.state)
    )
      throw new Error(
        "Finish or stop the current calculation before accepting a peer job.",
      );
  }
  private enqueue(command: Command) {
    if (command === "pause" || command === "stop") {
      this.controlEpoch++;
      if (this.queueTimer) clearTimeout(this.queueTimer);
      if (this.uploadTimer) clearTimeout(this.uploadTimer);
      this.terminateWorkers();
      this.set({ metrics: [], activeWorkers: 0 });
    }
    this.action = this.action
      .then(async () => {
        if (!this.initialized) return;
        if (command === "start") await this.start();
        if (command === "demo") {
          if (
            this.checkpoint ||
            !["idle", "complete", "error"].includes(this.snapshot.state)
          )
            throw new Error(
              "Finish or stop the current calculation before starting the demo.",
            );
          await this.start("bundled");
        }
        if (command === "pause") await this.pause();
        if (command === "stop") await this.stop();
        if (command === "refresh") {
          // A preference update can choose the source for a pristine idle view,
          // but cannot dismiss a completed result or disturb saved/running work.
          if (
            this.checkpoint ||
            this.snapshot.taskId ||
            !["idle", "unavailable"].includes(this.snapshot.state)
          )
            return;
          this.set({
            mode: "browser",
            taskSource: await this.nextTaskSource(),
            state: !this.manifest?.verified ? "unavailable" : "idle",
            message: this.manifest?.verified
              ? "Ready for a Rosetta calculation."
              : (this.manifest?.reason ?? "Engine unavailable."),
          });
        }
      })
      .catch((error) =>
        this.set({
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        }),
      );
  }
  set(patch: Partial<Snapshot>) {
    this.snapshot = {
      ...this.snapshot,
      ...patch,
      ownerId: this.owner ? this.id : this.snapshot.ownerId,
    };
    this.broadcast();
  }
  broadcast(fullFrames = false) {
    this.update({ ...this.snapshot }, this.owner);
    if (this.owner) {
      const frames = this.snapshot.frames ?? [];
      const key = `${this.snapshot.taskId ?? ""}:${this.snapshot.focusedModel ?? 0}`;
      const frameDelta = makeFrameDelta(
        this.broadcastFrames ?? [],
        frames,
        fullFrames || this.broadcastFrameKey !== key,
      );
      const { frames: _frames, ...snapshot } = this.snapshot;
      this.channel.postMessage({
        type: "snapshot",
        snapshot,
        ...(frameDelta ? { frameDelta } : {}),
      });
      this.broadcastFrames = frames;
      this.broadcastFrameKey = key;
    }
  }
  async start(sourceOverride?: "bundled") {
    if (this.disposed) return;
    if (this.queueTimer) clearTimeout(this.queueTimer);
    if (
      this.snapshot.state === "running" ||
      this.snapshot.state === "loading" ||
      this.snapshot.state === "uploading"
    )
      return;
    if (
      !this.manifest?.verified ||
      this.manifest.sourceSha !== SOURCE_SHA ||
      this.manifest.id !== ENGINE_ID
    ) {
      this.set({
        state: "unavailable",
        message: this.manifest?.reason ?? "Verified engine unavailable.",
      });
      return;
    }
    const epoch = this.controlEpoch;
    const previousHashes = this.checkpoint?.engineManifest?.hashes;
    if (
      previousHashes &&
      ["rosetta.mjs", "rosetta.wasm", "rosetta.data"].some(
        (name) => previousHashes[name] !== this.manifest?.hashes?.[name],
      )
    ) {
      this.set({
        state: "error",
        message:
          "This saved run uses a different scientific engine. Stop it before starting a new run.",
      });
      return;
    }
    const preferences = readPreferences();
    const source =
      this.checkpoint?.taskSource ??
      sourceOverride ??
      (await this.nextTaskSource());
    this.set({
      state: "loading",
      mode: "browser",
      taskSource: source,
      peerJobId: this.checkpoint?.peer?.jobId,
      description: this.checkpoint?.task.description,
      publisherId: this.checkpoint?.peer?.publisherId,
      message:
        source === "peer"
          ? "Preparing the accepted peer target…"
          : source !== "research"
            ? "Preparing the protein packaged with this extension…"
            : "Looking for an available Rosetta task…",
    });
    if (this.checkpoint && source === "research") {
      try {
        await this.taskApi(this.checkpoint, "renew", {
          attemptToken: this.checkpoint.task.attemptToken,
        });
      } catch (e) {
        if ((e as any).status === 409) {
          this.checkpoint = undefined;
          await putState("checkpoint", undefined);
        } else throw e;
      }
    }
    if (this.disposed || epoch !== this.controlEpoch) return;
    if (!this.checkpoint && source === "peer") {
      const imported = await getState<PeerInput>("peer-input");
      if (!imported)
        throw new Error("The accepted peer job is no longer available.");
      const job = await validatePeerJob(imported.job, this.manifest);
      if ((await peerSha256(canonicalStringify(job))) !== imported.jobHash)
        throw new Error("The saved peer job record has an invalid hash.");
      if (this.disposed || epoch !== this.controlEpoch) return;
      const startedAt = Date.now();
      const models = Array.from(
        { length: job.models },
        (_, modelIndex): BrowserModelCheckpoint => ({
          task: {
            id: `${job.id}:${modelIndex}`,
            jobId: job.id,
            title: job.title,
            ...(job.description ? { description: job.description } : {}),
            protocol: job.protocol,
            pdb: job.input.pdb,
            inputHash: job.input.sha256,
            seed: job.seed + modelIndex,
            modelIndex,
            engineId: ENGINE_ID,
            sourceSha: SOURCE_SHA,
            state: "leased" as const,
            attemptToken: crypto.randomUUID(),
            clientId: null,
            leaseUntil: null,
            result: null,
            rejection: null,
          },
          startedAt,
          status: "queued" as const,
        }),
      );
      this.checkpoint = {
        task: models[0].task,
        engineManifest: structuredClone(this.manifest),
        taskSource: "peer",
        peer: {
          jobId: job.id,
          publisherId: job.publisherId,
          jobHash: imported.jobHash,
          models: job.models,
        },
        startedAt,
        status: "running",
        batch: {
          models,
          parallelism: Math.min(
            job.models,
            validWorkerCount(preferences.workerCount),
          ),
          dutyCycle: preferences.dutyCycle,
        },
      };
      await this.persistCheckpoint(this.checkpoint);
    }
    if (this.checkpoint?.taskSource === "peer")
      await this.clearConsumedPeerInput(this.checkpoint);
    if (!this.checkpoint && source !== "research") {
      if (
        source === "bundled" &&
        !this.manifest.supportedProtocols?.includes(preferences.browserProtocol)
      )
        throw new Error(
          "The selected protocol has not passed this engine's verification gates.",
        );
      const imported =
        source === "benchmark"
          ? await getState<BenchmarkInput>("benchmark-input")
          : undefined;
      if (source === "benchmark" && !imported)
        throw new Error("The imported benchmark is no longer available.");
      const task = imported
        ? {
            ...imported.task,
            protocol: protocolSchema.parse(
              imported.runProtocol ?? imported.task.protocol,
            ),
          }
        : await bundledTask(preferences.browserProtocol);
      if (!this.manifest.supportedProtocols?.includes(task.protocol))
        throw new Error(
          "The imported benchmark protocol is not verified in this engine.",
        );
      if (this.disposed || epoch !== this.controlEpoch) return;
      const count = validWorkerCount(preferences.workerCount);
      const jobId = crypto.randomUUID();
      const models = Array.from({ length: count }, (_, modelIndex) => ({
        task: {
          ...task,
          id: crypto.randomUUID(),
          jobId,
          modelIndex,
          seed: ((task.seed - 1 + modelIndex) % 2_000_000_000) + 1,
          attemptToken: crypto.randomUUID(),
          result: null,
        },
        startedAt: Date.now(),
        status: "queued" as const,
      }));
      this.checkpoint = {
        task: models[0].task,
        engineManifest: structuredClone(this.manifest),
        taskSource: source,
        startedAt: Date.now(),
        status: "running",
        batch: { models, parallelism: count, dutyCycle: preferences.dutyCycle },
        ...(imported
          ? {
              benchmark: {
                id: task.id,
                kind: "coordinate-replay" as const,
                metadata: imported.metadata,
              },
            }
          : {}),
      };
      await this.persistCheckpoint(this.checkpoint);
    }
    if (!this.checkpoint) {
      const { task } = await api<{ task: Checkpoint["task"] | null }>(
        "/v1/leases/claim",
        { clientId: clientId(), engineId: ENGINE_ID, sourceSha: SOURCE_SHA },
        undefined,
        preferences.apiUrl,
      );
      if (this.disposed || epoch !== this.controlEpoch) {
        if (task)
          await api(
            `/v1/leases/${task.id}/release`,
            {
              attemptToken: task.attemptToken,
            },
            undefined,
            preferences.apiUrl,
          ).catch(() => {});
        return;
      }
      if (!task) {
        this.set({
          state: "waiting",
          message:
            "The task queue is empty. Your computer is idle; checking again in 30 seconds.",
        });
        this.queueTimer = setTimeout(() => {
          if (!this.disposed && this.snapshot.state === "waiting")
            this.enqueue("start");
        }, 30_000);
        return;
      }
      this.checkpoint = {
        task,
        taskSource: "research",
        serverUrl: preferences.apiUrl,
        startedAt: Date.now(),
        status: "running",
      };
      await putState("checkpoint", this.checkpoint);
    }
    const cp = this.checkpoint;
    if (cp.taskSource !== "research") {
      await this.runBrowserBatch(cp, epoch);
      return;
    }
    if (cp.taskSource === "research")
      this.heartbeat = setInterval(() => {
        void this.taskApi(cp, "renew", {
          attemptToken: cp.task.attemptToken,
        }).catch((e) => {
          this.worker?.terminate();
          this.worker = undefined;
          this.snapshot.metrics = [];
          if (this.heartbeat) clearInterval(this.heartbeat);
          this.set({
            state: "paused",
            activeWorkers: 0,
            message: `Lease renewal failed. Work is paused: ${e.message}`,
          });
        });
      }, 30_000);
    if (cp.result) {
      await this.upload();
      return;
    }
    cp.status = "running";
    // An unfinished segment replays from its seed, so old coordinates must not
    // masquerade as frames from this finishing attempt.
    cp.history = [];
    cp.frames = [];
    cp.bestEnergy = undefined;
    await putState("checkpoint", cp);
    if (this.disposed || epoch !== this.controlEpoch) return;
    this.set({
      state: "loading",
      mode: "browser",
      taskId: cp.task.id,
      title: cp.task.title,
      description: cp.task.description,
      publisherId: cp.peer?.publisherId,
      protocol: cp.task.protocol,
      pdb: cp.task.pdb,
      startingPdb: cp.task.pdb,
      energy: undefined,
      bestEnergy: undefined,
      completed: 0,
      total: 1,
      history: [],
      frames: [],
      snapshotSequence: 0,
      snapshotSource: undefined,
      snapshotStep: undefined,
      snapshotAt: undefined,
      message: "Loading the packaged Rosetta engine…",
      metrics: [],
      parallelism: 1,
      activeWorkers: 1,
      completedModels: 0,
      totalModels: 1,
      focusedModel: 0,
      modelResults: [],
    });
    const worker = new Worker(new URL("./science.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker = worker;
    worker.onmessage = (event) => {
      if (this.worker !== worker || this.disposed) return;
      const data = event.data;
      if (data.type === "telemetry")
        this.set({ metrics: this.heapMetrics(data.heapBytes) });
      if (data.type === "phase")
        this.set({
          message:
            data.phase === "Running Rosetta"
              ? "Preparing and scoring your protein. This first step can take a few minutes."
              : "Preparing the Rosetta engine packaged with this extension…",
        });
      if (data.type === "snapshot") {
        const trajectory = appendFrame(cp, cp.task.id, {
          pdb: data.pdb,
          energy: data.energy,
          sequence: data.sequence,
          elapsedMs: Date.now() - cp.startedAt,
          source: data.source,
          step: data.iteration,
        });
        cp.bestEnergy = Math.min(cp.bestEnergy ?? Infinity, data.energy);
        this.set({
          state: "running",
          pdb: data.pdb,
          energy: data.energy,
          bestEnergy: Math.min(
            this.snapshot.bestEnergy ?? Infinity,
            data.energy,
          ),
          ...trajectory,
          snapshotSequence: data.sequence,
          snapshotSource: data.source,
          snapshotStep: data.iteration,
          snapshotAt: data.timestamp,
          completed: Math.min(0.99, data.progress),
          elapsedMs: Date.now() - cp.startedAt,
          metrics: this.heapMetrics(data.heapBytes),
          message:
            data.source === "minimizing"
              ? "Live minimization: adjusting protein coordinates and measuring energy."
              : data.source === "packing"
                ? "Live packing: searching side-chain arrangements and measuring energy."
                : "Rosetta is optimizing this structure. Live coordinates and energy come from the calculation.",
        });
      }
      if (data.type === "error") {
        worker.terminate();
        this.worker = undefined;
        this.snapshot.metrics = [];
        if (this.heartbeat) clearInterval(this.heartbeat);
        this.set({ state: "error", message: data.message, activeWorkers: 0 });
      }
      if (data.type === "result") {
        worker.terminate();
        this.worker = undefined;
        this.snapshot.metrics = [];
        cp.result = {
          attemptToken: cp.task.attemptToken!,
          pdb: data.pdb,
          energy: data.energy,
          elapsedMs: Date.now() - cp.startedAt,
          engineId: ENGINE_ID,
          sourceSha: SOURCE_SHA,
        };
        cp.status = "uploading";
        appendFrame(
          cp,
          cp.task.id,
          {
            pdb: data.pdb,
            energy: data.energy,
            elapsedMs: cp.result.elapsedMs,
            source: "final",
          },
          cp.history?.at(-1) !== data.energy,
        );
        cp.bestEnergy = Math.min(
          this.snapshot.bestEnergy ?? Infinity,
          data.energy,
        );
        const resultEpoch = this.controlEpoch;
        this.set({
          pdb: data.pdb,
          energy: data.energy,
          history: cp.history,
          frames: cp.frames,
          bestEnergy: cp.bestEnergy,
          completed: 1,
          completedModels: 1,
          activeWorkers: 0,
          metrics: [],
        });
        this.action = this.action
          .then(() => putState("checkpoint", cp))
          .then(() => {
            if (!this.disposed && resultEpoch === this.controlEpoch)
              return this.upload();
          })
          .catch((e) => this.set({ state: "paused", message: e.message }));
      }
    };
    worker.onerror = (e) => {
      this.worker = undefined;
      worker.terminate();
      this.snapshot.metrics = [];
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.set({ state: "error", message: e.message, activeWorkers: 0 });
    };
    worker.postMessage({
      type: "run",
      task: cp.task,
      dutyCycle: readPreferences().dutyCycle,
    });
  }
  private async nextTaskSource(): Promise<
    "bundled" | "benchmark" | "research" | "peer"
  > {
    if (await getState<PeerInput>("peer-input")) return "peer";
    if (readPreferences().apiUrl) return "research";
    return (await getState<BenchmarkInput>("benchmark-input"))
      ? "benchmark"
      : "bundled";
  }
  private async clearConsumedPeerInput(checkpoint: Checkpoint) {
    if (!checkpoint.peer) return;
    const input = await getState<PeerInput>("peer-input");
    if (
      input?.job.id === checkpoint.peer.jobId &&
      input.jobHash === checkpoint.peer.jobHash
    )
      await putState("peer-input", undefined);
  }
  private persistCheckpoint(checkpoint: Checkpoint): Promise<void> {
    const saved = structuredClone(checkpoint);
    this.checkpointWrites = (this.checkpointWrites ?? Promise.resolve())
      .catch(() => {})
      .then(() => putState("checkpoint", saved));
    return this.checkpointWrites;
  }
  private terminateWorkers() {
    this.worker?.terminate();
    this.worker = undefined;
    this.browserPool?.stop();
    this.browserPool = undefined;
  }
  private batchView(checkpoint: Checkpoint): Partial<Snapshot> {
    if (!checkpoint.batch) return {};
    return new BrowserModelPool({
      models: checkpoint.batch.models,
      parallelism: checkpoint.batch.parallelism,
      dutyCycle: checkpoint.batch.dutyCycle ?? readPreferences().dutyCycle,
      onUpdate: () => {},
      onBoundary: async () => {},
      onComplete: () => {},
      onError: () => {},
    }).view();
  }
  private async runBrowserBatch(cp: Checkpoint, epoch: number) {
    const preferences = readPreferences();
    // Single-worker checkpoints from older extensions remain resumable with
    // their original attempt and seed rather than silently growing a new batch.
    cp.batch ??= {
      parallelism: 1,
      dutyCycle: preferences.dutyCycle,
      models: [
        {
          task: cp.task,
          result: cp.result,
          history: cp.history,
          frames: cp.frames,
          bestEnergy: cp.bestEnergy,
          startedAt: cp.startedAt,
          status: cp.result ? "complete" : "queued",
        },
      ],
    };
    cp.batch.parallelism = Math.max(
      1,
      Math.min(
        cp.batch.models.length,
        validWorkerCount(preferences.workerCount),
      ),
    );
    cp.batch.dutyCycle = preferences.dutyCycle;
    cp.status = "running";
    await this.persistCheckpoint(cp);
    if (this.disposed || epoch !== this.controlEpoch) return;
    this.set({
      state: "loading",
      mode: "browser",
      taskSource: cp.taskSource,
      peerJobId: cp.peer?.jobId,
      taskId: cp.task.id,
      title: cp.task.title,
      description: cp.task.description,
      publisherId: cp.peer?.publisherId,
      protocol: cp.task.protocol,
      elapsedMs: Date.now() - cp.startedAt,
      message: "Loading Rosetta for independent seeded models…",
      ...this.batchView(cp),
    });
    // A single worker compiles inside its disposable execution context. Keeping
    // a compiled 117 MB engine in the long-lived page also keeps its native code
    // alive after the worker's heap has been released. Sharing is useful only
    // when independent models are allowed to run concurrently.
    const compiledModule =
      cp.batch.parallelism > 1 ? await compileScientificModule() : undefined;
    if (this.disposed || epoch !== this.controlEpoch) return;
    const pool = new BrowserModelPool({
      compiledModule,
      stageStartup: true,
      models: cp.batch.models,
      parallelism: cp.batch.parallelism,
      dutyCycle: cp.batch.dutyCycle,
      onUpdate: (view) => {
        if (this.browserPool !== pool || this.disposed) return;
        this.set({
          ...view,
          state: view.energy === undefined ? "loading" : "running",
          elapsedMs: Date.now() - cp.startedAt,
          message: `${view.completedModels} of ${view.totalModels} models complete. ${view.activeWorkers} browser workers active.`,
        });
      },
      onBoundary: async () => {
        cp.history = pool.view().history;
        cp.frames = pool.view().frames;
        cp.bestEnergy = pool.view().bestEnergy;
        await this.persistCheckpoint(cp);
      },
      onComplete: () => {
        this.action = this.action
          .then(async () => {
            if (
              this.disposed ||
              epoch !== this.controlEpoch ||
              this.browserPool !== pool
            )
              return;
            const best = cp.batch!.models.reduce((current, model) =>
              model.result!.energy < current.result!.energy ? model : current,
            );
            cp.result = {
              ...best.result!,
              elapsedMs: Date.now() - cp.startedAt,
            };
            cp.history = best.history;
            cp.frames = best.frames;
            cp.bestEnergy = pool.view().bestEnergy;
            cp.status = "uploading";
            await this.persistCheckpoint(cp);
            if (this.disposed || epoch !== this.controlEpoch) return;
            await completeBrowserTask(cp);
            await this.clearConsumedPeerInput(cp);
            if (this.disposed || epoch !== this.controlEpoch) return;
            const view = pool.view();
            this.browserPool = undefined;
            this.checkpoint = undefined;
            this.set({
              ...view,
              state: "complete",
              taskSource: cp.taskSource,
              peerJobId: cp.peer?.jobId,
              elapsedMs: cp.result.elapsedMs,
              completed: cp.batch!.models.length,
              total: cp.batch!.models.length,
              activeWorkers: 0,
              metrics: [],
              checkpointAt: Date.now(),
              message: `${cp.batch!.models.length} browser model${cp.batch!.models.length === 1 ? "" : "s"} complete. Results saved locally.`,
            });
            if (
              cp.taskSource !== "peer" &&
              readPreferences().automatic &&
              !this.disposed
            )
              this.enqueue("start");
          })
          .catch((error) => {
            this.terminateWorkers();
            this.set({
              state: "paused",
              metrics: [],
              activeWorkers: 0,
              message: `Results remain available to retry saving. ${error.message}`,
            });
          });
      },
      onError: (message) => {
        if (this.browserPool !== pool || this.disposed) return;
        this.browserPool = undefined;
        cp.status = "paused";
        void this.persistCheckpoint(cp).catch(() => {});
        this.set({
          state: "error",
          metrics: [],
          activeWorkers: 0,
          message: `${message} Completed models are saved. Resume to retry unfinished models.`,
        });
      },
    });
    this.browserPool = pool;
    pool.start();
  }
  private heapMetrics(bytes: number | undefined): Metric[] {
    const metric = wasmHeapMetric(bytes);
    return metric ? [metric] : [];
  }
  async upload() {
    const cp = this.checkpoint;
    if (!cp?.result) return;
    const epoch = this.controlEpoch;
    if (cp.taskSource !== "research") {
      await completeBrowserTask(cp);
      await this.clearConsumedPeerInput(cp);
      this.checkpoint = undefined;
      if (this.disposed || epoch !== this.controlEpoch) return;
      this.set({
        state: "complete",
        taskSource: cp.taskSource ?? "bundled",
        peerJobId: cp.peer?.jobId,
        completed: 1,
        elapsedMs: cp.result.elapsedMs,
        checkpointAt: Date.now(),
        message:
          "Calculation complete. Rosetta ran entirely in browser WebAssembly; the result is saved on this device. This standalone run earns no volunteer credit.",
      });
      if (
        cp.taskSource !== "peer" &&
        readPreferences().automatic &&
        !this.disposed
      )
        this.enqueue("start");
      return;
    }
    let retry = true;
    this.set({
      state: "uploading",
      message:
        "Result saved locally. Waiting for the server to verify your calculation…",
    });
    try {
      await this.taskApi(cp, "complete", cp.result);
      let status: { state: string; rejection?: string; nativeEnergy?: number };
      for (;;) {
        if (this.disposed || epoch !== this.controlEpoch) return;
        status = await this.taskApi(cp, "status", {
          attemptToken: cp.task.attemptToken,
        });
        if (status.state !== "validating") break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      if (status.state !== "accepted") {
        retry = status.state === "leased";
        throw new Error(status.rejection ?? "Result was not accepted.");
      }
      if (this.disposed || epoch !== this.controlEpoch) return;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.checkpoint = undefined;
      await putState("checkpoint", undefined);
      this.set({
        state: "complete",
        completed: 1,
        checkpointAt: Date.now(),
        message:
          "The server verified and accepted this result. Thank you for contributing.",
      });
      if (readPreferences().automatic && !this.disposed) this.enqueue("start");
    } catch (e) {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.set({
        state: "paused",
        message: `Result remains saved locally. ${(e as Error).message}`,
      });
      if (
        retry &&
        (e as any).status !== 409 &&
        !this.disposed &&
        epoch === this.controlEpoch
      ) {
        this.scheduleUploadRetry(cp, epoch);
      }
    }
  }
  private scheduleUploadRetry(cp: Checkpoint, epoch: number) {
    this.uploadTimer = setTimeout(() => {
      if (
        this.disposed ||
        epoch !== this.controlEpoch ||
        this.checkpoint !== cp
      )
        return;
      this.action = this.action
        .then(async () => {
          await this.taskApi(cp, "renew", {
            attemptToken: cp.task.attemptToken,
          });
          if (this.disposed || epoch !== this.controlEpoch) return;
          await this.upload();
        })
        .catch((e) => {
          this.set({
            state: "paused",
            message: `Result remains saved locally. ${e.message}`,
          });
          if (e.status !== 409 && !this.disposed && epoch === this.controlEpoch)
            this.scheduleUploadRetry(cp, epoch);
        });
    }, 15_000);
  }
  async pause() {
    if (this.queueTimer) clearTimeout(this.queueTimer);
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.checkpoint) {
      this.checkpoint.status = "paused";
      await this.persistCheckpoint(this.checkpoint);
    }
    this.set({
      state: "paused",
      message:
        "Paused. Completed segments are saved; the unfinished segment will replay on resume.",
    });
  }
  async stop() {
    if (this.queueTimer) clearTimeout(this.queueTimer);
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.terminateWorkers();
    this.snapshot.metrics = [];
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.checkpoint?.taskSource === "research") {
      await this.taskApi(this.checkpoint, "release", {
        attemptToken: this.checkpoint.task.attemptToken,
      }).catch(() => {});
    }
    this.checkpoint = undefined;
    await this.checkpointWrites?.catch(() => {});
    await putState("checkpoint", undefined);
    await putState("peer-input", undefined);
    this.set({
      ...initialSnapshot(),
      taskId: undefined,
      peerJobId: undefined,
      title: undefined,
      description: undefined,
      publisherId: undefined,
      protocol: undefined,
      pdb: undefined,
      startingPdb: undefined,
      energy: undefined,
      bestEnergy: undefined,
      totalModels: undefined,
      completedModels: undefined,
      modelResults: undefined,
      taskSource: await this.nextTaskSource(),
      message: "Stopped. No new calculation will start without consent.",
    });
  }
  private taskApi<T>(
    checkpoint: Checkpoint,
    operation: string,
    body: unknown,
  ): Promise<T> {
    return api<T>(
      `/v1/leases/${checkpoint.task.id}/${operation}`,
      body,
      undefined,
      checkpoint.serverUrl,
    );
  }
  sampleMetrics() {
    // UI heap measurements belong to each viewing tab, so ResourcePanel reads
    // those locally. Only the single scientific worker's allocation is shared.
    this.snapshot.metrics = visibleResourceMetrics(
      this.snapshot.metrics,
    ).filter((metric) => metric.name === "engine");
  }
  dispose() {
    this.disposed = true;
    this.terminateWorkers();
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.queueTimer) clearTimeout(this.queueTimer);
    if (this.uploadTimer) clearTimeout(this.uploadTimer);
    this.channel.close();
    this.abort.abort();
    // Keep voluntary ownership handover behind completed boundary writes. A
    // destroyed browser context releases its lock itself; an uncommitted model
    // then replays from its recorded seed in the last durable checkpoint.
    void (this.checkpointWrites ?? Promise.resolve())
      .catch(() => {})
      .then(() => this.release?.());
  }
}
