import { afterEach, expect, it, vi } from "vitest";
import {
  ENGINE_ID,
  SOURCE_SHA,
  type BrowserModelCheckpoint,
  type Task,
} from "@rosettatab/shared";
import { BrowserModelPool } from "./browser-pool";

class TransportWorker {
  onmessage?: (event: { data: any }) => void;
  onerror?: (event: { message: string }) => void;
  terminate = vi.fn();
  postMessage = vi.fn();
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}
function models(count: number): BrowserModelCheckpoint[] {
  return Array.from({ length: count }, (_, index) => ({
    task: {
      id: `attempt-${index}`,
      jobId: "one-batch",
      seed: 17 + index,
      modelIndex: index,
      title: "Scheduler transport fixture",
      protocol: "relax",
      pdb: "input fixture; not a scientific test",
      inputHash: "fixture",
      engineId: ENGINE_ID,
      sourceSha: SOURCE_SHA,
      state: "leased",
      attemptToken: `token-${index}`,
      clientId: null,
      leaseUntil: null,
      result: null,
      rejection: null,
    } satisfies Task,
    startedAt: 0,
    status: "queued",
  }));
}
function setup(count = 2, parallelism = count, saved = models(count)) {
  const workers: TransportWorker[] = [];
  const options = {
    models: saved,
    parallelism,
    dutyCycle: 25,
    makeWorker: () => {
      const worker = new TransportWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    onUpdate: vi.fn(),
    onBoundary: vi.fn(async () => {}),
    onComplete: vi.fn(),
    onError: vi.fn(),
  };
  const pool = new BrowserModelPool(options);
  return { pool, workers, options, saved };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
afterEach(() => vi.restoreAllMocks());

it("runs separate seeded models concurrently and aggregates progress without mixing trajectories", () => {
  const { pool, workers } = setup();
  pool.start();
  expect(workers).toHaveLength(2);
  expect(
    workers.map((worker) => worker.postMessage.mock.calls[0][0].task.seed),
  ).toEqual([17, 18]);
  workers[0].emit({
    type: "snapshot",
    pdb: "model zero",
    energy: -10,
    progress: 0.25,
  });
  workers[1].emit({
    type: "snapshot",
    pdb: "model one",
    energy: -20,
    progress: 0.5,
  });
  expect(pool.view()).toMatchObject({
    activeWorkers: 2,
    parallelism: 2,
    completedModels: 0,
    totalModels: 2,
    completed: 0.75,
    total: 2,
    focusedModel: 0,
    pdb: "model zero",
    energy: -10,
    bestEnergy: -20,
    history: [-10],
    frames: [
      { id: "attempt-0:1", pdb: "model zero", energy: -10, historyIndex: 0 },
    ],
  });
  pool.stop();
});

it("stages cold initialization, then reaches the requested parallelism without restarting warm models", () => {
  const { options, workers } = setup(3);
  const pool = new BrowserModelPool({ ...options, stageStartup: true });
  pool.start();
  expect(workers).toHaveLength(1);
  workers[0].emit({ type: "telemetry", heapBytes: 128 * 1024 ** 2 });
  expect(workers).toHaveLength(1);
  workers[0].emit({ type: "ready" });
  expect(workers).toHaveLength(2);
  workers[0].emit({ type: "ready" });
  expect(workers).toHaveLength(2);
  workers[1].emit({ type: "ready" });
  expect(workers).toHaveLength(3);
  expect(pool.view()).toMatchObject({ parallelism: 3, activeWorkers: 3 });
  pool.stop();
  workers[2].emit({ type: "ready" });
  expect(pool.workers.size).toBe(0);
  expect(
    workers.every((worker) => worker.terminate.mock.calls.length === 1),
  ).toBe(true);
});

it("reports the sum of actual live worker allocations and omits incomplete or stale measurements", async () => {
  let now = 10_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const { pool, workers } = setup();
  pool.start();
  workers[0].emit({ type: "telemetry", heapBytes: 256 * 1024 ** 2 });
  expect(pool.view().metrics).toEqual([]);
  workers[1].emit({ type: "telemetry", heapBytes: 128 * 1024 ** 2 });
  expect(pool.view().metrics?.[0]).toMatchObject({
    value: 384 * 1024 ** 2,
    unit: "bytes",
  });
  now += 5001;
  expect(pool.view().metrics).toEqual([]);
  workers[1].emit({ type: "telemetry", heapBytes: 128 * 1024 ** 2 });
  expect(pool.view().metrics).toEqual([]);
  workers[0].emit({ type: "result", pdb: "completed zero", energy: -30 });
  await flush();
  expect(pool.view().metrics?.[0].value).toBe(128 * 1024 ** 2);
  pool.stop();
  expect(pool.view().metrics).toEqual([]);
});

it("waits for every completed-model boundary to be persisted and ignores duplicate completion messages", async () => {
  const { pool, workers, options, saved } = setup();
  let finish!: () => void;
  const stored = new Promise<void>((resolve) => {
    finish = resolve;
  });
  options.onBoundary.mockImplementation(() => stored);
  pool.start();
  workers[0].emit({ type: "result", pdb: "completed zero", energy: -30 });
  workers[0].emit({ type: "result", pdb: "duplicate zero", energy: -300 });
  workers[1].emit({ type: "result", pdb: "completed one", energy: -40 });
  expect(options.onBoundary).toHaveBeenCalledTimes(2);
  expect(options.onComplete).not.toHaveBeenCalled();
  expect(saved[0].result?.energy).toBe(-30);
  expect(
    workers.every(
      (worker) => worker.onmessage === null && worker.onerror === null,
    ),
  ).toBe(true);
  expect(pool.view()).toMatchObject({
    completed: 2,
    total: 2,
    activeWorkers: 0,
    completedModels: 2,
  });
  finish();
  await flush();
  expect(options.onComplete).toHaveBeenCalledOnce();
  expect(pool.view()).toMatchObject({
    focusedModel: 1,
    pdb: "completed one",
    energy: -40,
  });
  expect(pool.view().modelResults?.map((result) => result.seed)).toEqual([
    17, 18,
  ]);
});

it("resumes only unfinished recorded attempts and can use fewer workers after a pause", async () => {
  const first = setup(3);
  first.pool.start();
  first.workers[1].emit({
    type: "snapshot",
    pdb: "unfinished frame",
    energy: -5,
    progress: 0.2,
  });
  first.workers[0].emit({ type: "result", pdb: "saved zero", energy: -30 });
  await flush();
  first.pool.stop();
  expect(
    first.workers.every((worker) => worker.terminate.mock.calls.length === 1),
  ).toBe(true);
  const resumed = setup(3, 1, first.saved);
  expect(resumed.saved[1].frames?.[0].pdb).toBe("unfinished frame");
  resumed.pool.start();
  expect(resumed.saved[1].frames).toEqual([]);
  expect(resumed.saved[1].history).toEqual([]);
  expect(resumed.saved[0].frames?.at(-1)?.pdb).toBe("saved zero");
  expect(resumed.workers).toHaveLength(1);
  expect(resumed.workers[0].postMessage.mock.calls[0][0].task).toMatchObject({
    id: "attempt-1",
    seed: 18,
  });
  expect(resumed.pool.view()).toMatchObject({
    completedModels: 1,
    totalModels: 3,
    activeWorkers: 1,
  });
  resumed.workers[0].emit({ type: "result", pdb: "saved one", energy: -40 });
  await flush();
  expect(resumed.workers).toHaveLength(2);
  expect(resumed.workers[1].postMessage.mock.calls[0][0].task).toMatchObject({
    id: "attempt-2",
    seed: 19,
  });
  resumed.workers[1].emit({ type: "result", pdb: "saved two", energy: -50 });
  await flush();
  expect(resumed.options.onComplete).toHaveBeenCalledOnce();
  expect(resumed.saved[0].result?.pdb).toBe("saved zero");
});

it("keeps shared code available for queued models until they have launched", async () => {
  const { options, workers } = setup(3, 2);
  const module = new WebAssembly.Module(
    new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]),
  );
  const pool = new BrowserModelPool({ ...options, compiledModule: module });
  pool.start();
  workers[0].emit({ type: "result", pdb: "first", energy: -10 });
  await flush();
  expect(workers).toHaveLength(3);
  expect(
    workers.map((worker) => worker.postMessage.mock.calls[0][0].compiledModule),
  ).toEqual([module, module, module]);
  pool.stop();
  expect(
    workers.every(
      (worker) => worker.onmessage === null && worker.onerror === null,
    ),
  ).toBe(true);
  expect(pool.view().metrics).toEqual([]);
  expect(pool.view().modelResults?.[0].pdb).toBe("first");
});

it("stops the entire pool on a worker error while retaining completed model output", async () => {
  const { pool, workers, options, saved } = setup(3);
  pool.start();
  workers[0].emit({ type: "result", pdb: "saved zero", energy: -30 });
  await flush();
  workers[1].onerror?.({ message: "WASM allocation failed" });
  workers[2].emit({ type: "result", pdb: "late invalid output", energy: -100 });
  expect(options.onError).toHaveBeenCalledExactlyOnceWith(
    "WASM allocation failed",
  );
  expect(saved[0].result?.pdb).toBe("saved zero");
  expect(saved[1].result).toBeUndefined();
  expect(saved[2].result).toBeUndefined();
  expect(pool.view()).toMatchObject({
    activeWorkers: 0,
    completedModels: 1,
    metrics: [],
  });
  expect(
    workers.every((worker) => worker.terminate.mock.calls.length === 1),
  ).toBe(true);
  expect(options.onComplete).not.toHaveBeenCalled();
});

it("cleans up already-started workers if creating another worker fails", () => {
  const { workers, options } = setup(3);
  const factory = options.makeWorker;
  options.makeWorker = () => {
    if (workers.length) throw new Error("Worker quota reached");
    return factory();
  };
  const pool = new BrowserModelPool(options);
  pool.start();
  expect(workers).toHaveLength(1);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(options.onError).toHaveBeenCalledExactlyOnceWith(
    "Worker quota reached",
  );
  expect(pool.view().activeWorkers).toBe(0);
});
