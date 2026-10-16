import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ENGINE_ID,
  SOURCE_SHA,
  initialSnapshot,
  type Checkpoint,
  type Task,
} from "@rosettatab/shared";
import { Session } from "./session";

const state = vi.hoisted(() => ({
  stored: new Map<string, any>(),
  preferences: {
    apiUrl: "",
    browserProtocol: "score",
    dutyCycle: 25,
    workerCount: 2,
    automatic: false,
  },
  api: vi.fn(),
  compile: vi.fn(),
}));
vi.mock("./science-module", () => ({
  compileScientificModule: state.compile,
}));
vi.mock("./storage", () => ({
  readPreferences: () => state.preferences,
  clientId: () => "fixture-client",
  getState: async (key: string) => structuredClone(state.stored.get(key)),
  putState: async (key: string, value: unknown) => {
    if (value === undefined) state.stored.delete(key);
    else state.stored.set(key, structuredClone(value));
  },
  completeBrowserTask: async (checkpoint: Checkpoint) => {
    state.stored.set("browser-results", [
      structuredClone(checkpoint),
      ...(state.stored.get("browser-results") ?? []).filter(
        (saved: Checkpoint) => saved.task.id !== checkpoint.task.id,
      ),
    ]);
    state.stored.delete("checkpoint");
  },
}));
vi.mock("./api", () => ({ api: state.api }));
vi.mock("./browser-tasks", () => ({ bundledTask: async () => task() }));

function task(): Task {
  return {
    id: "input-attempt",
    jobId: "input-job",
    title: "Pool transport fixture",
    protocol: "score",
    pdb: "starting fixture (not a scientific test)",
    inputHash: "fixture",
    seed: 17,
    modelIndex: 0,
    engineId: ENGINE_ID,
    sourceSha: SOURCE_SHA,
    state: "leased",
    attemptToken: "input-token",
    clientId: null,
    leaseUntil: null,
    result: null,
    rejection: null,
  };
}
class TransportWorker {
  static all: TransportWorker[] = [];
  onmessage?: (event: { data: any }) => void;
  onerror?: (event: { message: string }) => void;
  terminate = vi.fn();
  postMessage = vi.fn((_message: any) =>
    queueMicrotask(() => this.emit({ type: "ready" })),
  );
  constructor() {
    TransportWorker.all.push(this);
  }
  emit(data: unknown) {
    this.onmessage?.({ data });
  }
}
function owner() {
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    id: "owner-tab",
    owner: true,
    initialized: true,
    controlEpoch: 0,
    action: Promise.resolve(),
    checkpointWrites: Promise.resolve(),
    snapshot: initialSnapshot(),
    update: vi.fn(),
    channel: { postMessage: vi.fn() },
    manifest: {
      id: ENGINE_ID,
      sourceSha: SOURCE_SHA,
      verified: true,
      supportedProtocols: ["score"],
    },
  });
  return session;
}
beforeEach(() => {
  state.stored.clear();
  state.api.mockReset();
  state.compile
    .mockReset()
    .mockResolvedValue(
      new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
    );
  state.preferences.apiUrl = "";
  state.preferences.workerCount = 2;
  state.preferences.dutyCycle = 25;
  TransportWorker.all = [];
  vi.stubGlobal("Worker", TransportWorker);
  vi.stubGlobal("navigator", { hardwareConcurrency: 4 });
});
afterEach(() => vi.unstubAllGlobals());

it("keeps single-worker compilation out of the page and releases callbacks without losing saved output", async () => {
  state.preferences.workerCount = 1;
  const session = owner();
  await session.start();
  expect(state.compile).not.toHaveBeenCalled();
  expect(TransportWorker.all).toHaveLength(1);
  const worker = TransportWorker.all[0];
  expect(worker.postMessage.mock.calls[0][0].compiledModule).toBeUndefined();
  worker.emit({
    type: "snapshot",
    pdb: "initial",
    energy: 10,
    source: "initial",
  });
  worker.emit({ type: "result", pdb: "final", energy: -10 });
  await vi.waitFor(() => expect(session.snapshot.state).toBe("complete"));
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onmessage).toBeNull();
  expect(worker.onerror).toBeNull();
  expect(session.snapshot.activeWorkers).toBe(0);
  expect(session.snapshot.frames?.map((frame) => frame.pdb)).toEqual([
    "initial",
    "final",
  ]);
  expect(state.stored.get("browser-results")[0].result.pdb).toBe("final");
});

it("terminates single-worker startup immediately when cancelled", async () => {
  state.preferences.workerCount = 1;
  const session = owner();
  await session.start();
  const worker = TransportWorker.all[0];
  session.command("stop");
  await session.action;
  worker.emit({ type: "result", pdb: "late", energy: -10 });
  expect(worker.terminate).toHaveBeenCalledOnce();
  expect(worker.onmessage).toBeNull();
  expect(state.compile).not.toHaveBeenCalled();
  expect(session.snapshot.activeWorkers).toBe(0);
  expect(state.stored.has("browser-results")).toBe(false);
});

it("cancels startup before allocating any workers when stopped during shared compilation", async () => {
  const session = owner();
  let finish!: (module: WebAssembly.Module) => void;
  state.compile.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  session.command("start");
  await vi.waitFor(() => expect(state.compile).toHaveBeenCalledTimes(1));
  session.command("stop");
  finish(new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])));
  await session.action;
  expect(TransportWorker.all).toHaveLength(0);
  expect(session.checkpoint).toBeUndefined();
  expect(session.snapshot.activeWorkers).toBe(0);
});

it("retains attempts after a compile failure and recompiles only once when resumed", async () => {
  const session = owner();
  state.compile.mockRejectedValueOnce(new Error("Compile allocation failed"));
  session.command("start");
  await session.action;
  const ids = session.checkpoint!.batch!.models.map((model) => model.task.id);
  expect(session.snapshot.state).toBe("error");
  expect(TransportWorker.all).toHaveLength(0);
  session.command("start");
  await session.action;
  expect(state.compile).toHaveBeenCalledTimes(2);
  expect(TransportWorker.all).toHaveLength(2);
  expect(
    session.checkpoint!.batch!.models.map((model) => model.task.id),
  ).toEqual(ids);
  session.command("stop");
  await session.action;
});

it("persists every local model output once and keeps the run anchor while selecting the best final model", async () => {
  const session = owner();
  await session.start();
  const anchor = session.checkpoint!.task.id;
  expect(session.checkpoint!.engineManifest).toEqual(session.manifest);
  expect(TransportWorker.all).toHaveLength(2);
  expect(state.compile).toHaveBeenCalledTimes(1);
  expect(
    TransportWorker.all[0].postMessage.mock.calls[0][0].compiledModule,
  ).toBe(TransportWorker.all[1].postMessage.mock.calls[0][0].compiledModule);
  expect(session.snapshot).toMatchObject({
    parallelism: 2,
    activeWorkers: 2,
    totalModels: 2,
    taskId: anchor,
  });
  TransportWorker.all[0].emit({
    type: "result",
    pdb: "completed model zero",
    energy: -10,
  });
  await vi.waitFor(() =>
    expect(state.stored.get("checkpoint").batch.models[0].result.energy).toBe(
      -10,
    ),
  );
  expect(state.stored.has("browser-results")).toBe(false);
  TransportWorker.all[1].emit({
    type: "result",
    pdb: "completed model one",
    energy: -20,
  });
  TransportWorker.all[1].emit({
    type: "result",
    pdb: "duplicate model one",
    energy: -200,
  });
  await vi.waitFor(() => expect(session.snapshot.state).toBe("complete"));
  const saved: Checkpoint[] = state.stored.get("browser-results");
  expect(saved).toHaveLength(1);
  expect(saved[0].task.id).toBe(anchor);
  expect(saved[0].result?.pdb).toBe("completed model one");
  expect(saved[0].batch?.models.map((model) => model.result?.pdb)).toEqual([
    "completed model zero",
    "completed model one",
  ]);
  expect(session.snapshot).toMatchObject({
    state: "complete",
    taskId: anchor,
    completed: 2,
    total: 2,
    activeWorkers: 0,
    energy: -20,
    pdb: "completed model one",
    metrics: [],
  });
  expect(state.stored.has("checkpoint")).toBe(false);
  expect(state.api).not.toHaveBeenCalled();
});

it("pause and owner handover resume only unfinished original attempts", async () => {
  const first = owner();
  await first.start();
  const attempts = first.checkpoint!.batch!.models.map((model) => ({
    id: model.task.id,
    seed: model.task.seed,
  }));
  TransportWorker.all[0].emit({
    type: "result",
    pdb: "durable model zero",
    energy: -10,
  });
  await vi.waitFor(() =>
    expect(state.stored.get("checkpoint").batch.models[0].result).toBeDefined(),
  );
  TransportWorker.all[1].emit({
    type: "snapshot",
    pdb: "unfinished live frame",
    energy: -5,
    sequence: 1,
    source: "initial",
    progress: 0.1,
  });
  first.command("pause");
  await first.action;
  expect(
    state.stored.get("checkpoint").batch.models[1].frames[0],
  ).toMatchObject({
    pdb: "unfinished live frame",
    energy: -5,
    historyIndex: 0,
  });
  expect(first.snapshot.activeWorkers).toBe(0);
  expect(
    TransportWorker.all.every(
      (worker) => worker.terminate.mock.calls.length === 1,
    ),
  ).toBe(true);
  const recovered = owner();
  recovered.checkpoint = structuredClone(state.stored.get("checkpoint"));
  state.preferences.dutyCycle = 75;
  await recovered.start();
  expect(TransportWorker.all).toHaveLength(3);
  expect(
    TransportWorker.all[2].postMessage.mock.calls[0][0].task,
  ).toMatchObject(attempts[1]);
  expect(TransportWorker.all[2].postMessage.mock.calls[0][0].dutyCycle).toBe(
    75,
  );
  expect(recovered.checkpoint!.batch!.models[0].execution?.dutyCycle).toBe(25);
  expect(recovered.checkpoint!.batch!.models[1].execution?.dutyCycle).toBe(75);
  expect(recovered.checkpoint!.batch!.models[1].frames).toEqual([]);
  expect(recovered.checkpoint!.batch!.models[0].frames?.at(-1)?.pdb).toBe(
    "durable model zero",
  );
  expect(recovered.snapshot.completedModels).toBe(1);
  TransportWorker.all[2].emit({
    type: "result",
    pdb: "durable model one",
    energy: -20,
  });
  await vi.waitFor(() => expect(recovered.snapshot.state).toBe("complete"));
  expect(state.stored.get("browser-results")).toHaveLength(1);
});

it("restores completed real frames and avoids repeating coordinate payloads on clock broadcasts", async () => {
  state.preferences.workerCount = 1;
  const first = owner();
  await first.start();
  TransportWorker.all[0].emit({
    type: "snapshot",
    pdb: "initial real coordinates",
    energy: 10,
    source: "initial",
    sequence: 1,
    progress: 0,
  });
  TransportWorker.all[0].emit({
    type: "snapshot",
    pdb: "final real coordinates",
    energy: -10,
    source: "final",
    sequence: 2,
    progress: 1,
  });
  TransportWorker.all[0].emit({
    type: "result",
    pdb: "final real coordinates",
    energy: -10,
  });
  await vi.waitFor(() => expect(first.snapshot.state).toBe("complete"));
  const stored = state.stored.get("browser-results")[0];
  expect(stored.frames).toHaveLength(2);
  expect(stored.frames).toEqual(stored.batch.models[0].frames);
  const recovered = owner();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => recovered.manifest })),
  );
  await recovered.initialize();
  clearInterval(recovered.timer);
  expect(recovered.snapshot).toMatchObject({
    state: "complete",
    history: [10, -10],
    frames: [
      { pdb: "initial real coordinates", historyIndex: 0, energy: 10 },
      { pdb: "final real coordinates", historyIndex: 1, energy: -10 },
    ],
  });
  const transport = recovered.channel.postMessage as ReturnType<typeof vi.fn>;
  transport.mockClear();
  recovered.broadcast(true);
  const full = transport.mock.calls.at(-1)![0];
  expect(full.snapshot.frames).toBeUndefined();
  expect(full.frameDelta.additions).toEqual(recovered.snapshot.frames);
  recovered.broadcast();
  expect(transport.mock.calls.at(-1)![0].frameDelta).toBeUndefined();
  expect(transport.mock.calls.at(-1)![0].snapshot.history).toEqual([10, -10]);
});

it("runs imported coordinate benchmark models locally and preserves input metadata", async () => {
  state.stored.set("benchmark-input", {
    task: task(),
    metadata: { source: "published-coordinate-fixture" },
  });
  const session = owner();
  await session.start();
  expect(session.snapshot.taskSource).toBe("benchmark");
  expect(session.checkpoint?.benchmark).toEqual({
    id: "input-attempt",
    kind: "coordinate-replay",
    metadata: { source: "published-coordinate-fixture" },
  });
  expect(
    TransportWorker.all.map(
      (worker) => worker.postMessage.mock.calls[0][0].task.seed,
    ),
  ).toEqual([17, 18]);
  TransportWorker.all[0].emit({
    type: "result",
    pdb: "benchmark zero",
    energy: -10,
  });
  TransportWorker.all[1].emit({
    type: "result",
    pdb: "benchmark one",
    energy: -20,
  });
  await vi.waitFor(() => expect(session.snapshot.state).toBe("complete"));
  expect(state.stored.get("browser-results")[0].benchmark.metadata.source).toBe(
    "published-coordinate-fixture",
  );
  expect(state.api).not.toHaveBeenCalled();
});

it("uses the explicit imported run protocol without rewriting original benchmark provenance", async () => {
  const imported = {
    task: task(),
    metadata: {
      protocol: "score",
      reference: { protocol: "score", energy: -10 },
    },
    runProtocol: "relax",
  };
  state.stored.set("benchmark-input", imported);
  const session = owner();
  session.manifest!.supportedProtocols = ["score", "relax"];
  await session.start();
  expect(session.snapshot.protocol).toBe("relax");
  expect(session.checkpoint?.benchmark?.metadata).toEqual(imported.metadata);
  expect(state.stored.get("benchmark-input")).toEqual(imported);
  expect(
    TransportWorker.all.map(
      (worker) => worker.postMessage.mock.calls[0][0].task.protocol,
    ),
  ).toEqual(["relax", "relax"]);
  session.command("pause");
  await session.action;
  state.stored.set("benchmark-input", { ...imported, runProtocol: "score" });
  await session.start();
  // A saved computation always resumes its own protocol, even if the next-run
  // input changes elsewhere. The imported scoring reference stays intact.
  expect(session.checkpoint?.task.protocol).toBe("relax");
  expect(
    TransportWorker.all.at(-1)!.postMessage.mock.calls[0][0].task.protocol,
  ).toBe("relax");
});

it("rejects an unverified imported run protocol before launching a worker", async () => {
  state.stored.set("benchmark-input", {
    task: task(),
    metadata: { protocol: "score" },
    runProtocol: "relax",
  });
  const session = owner();
  await expect(session.start()).rejects.toThrow("not verified");
  expect(TransportWorker.all).toHaveLength(0);
});

it("a follower forwards Start to the owner without creating workers", async () => {
  const session = owner();
  session.owner = false;
  session.command("start");
  await session.action;
  expect(session.channel.postMessage).toHaveBeenCalledExactlyOnceWith({
    type: "command",
    command: "start",
  });
  expect(TransportWorker.all).toHaveLength(0);
  expect(state.stored.size).toBe(0);
});

it("refuses to mix engine artifacts in a recovered run and allows Stop to clear it", async () => {
  const session = owner();
  session.manifest!.hashes = {
    "rosetta.mjs": "a",
    "rosetta.wasm": "b",
    "rosetta.data": "c",
  };
  await session.start();
  session.command("pause");
  await session.action;
  session.manifest!.hashes["rosetta.wasm"] = "different-artifact";
  await session.start();
  expect(TransportWorker.all).toHaveLength(2);
  expect(session.snapshot).toMatchObject({ state: "error" });
  expect(session.snapshot.message).toContain("different scientific engine");
  await session.stop();
  expect(state.stored.has("checkpoint")).toBe(false);
  expect(session.snapshot.state).toBe("idle");
});
