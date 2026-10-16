import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  ENGINE_ID,
  SOURCE_SHA,
  initialSnapshot,
  type Checkpoint,
  type EngineManifest,
  type Snapshot,
} from "@rosettatab/shared";
import { Session } from "./session";
import { hashPeerJob, peerSha256, type PeerJob } from "./peer-protocol";

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
  bundled: vi.fn(),
}));
vi.mock("./storage", () => ({
  readPreferences: () => state.preferences,
  clientId: () => "local-client",
  getState: async (key: string) => structuredClone(state.stored.get(key)),
  putState: async (key: string, value: unknown) => {
    if (value === undefined) state.stored.delete(key);
    else state.stored.set(key, structuredClone(value));
  },
  completeBrowserTask: async (checkpoint: Checkpoint) => {
    state.stored.set("browser-results", [
      structuredClone(checkpoint),
      ...(state.stored.get("browser-results") ?? []).filter(
        (record: Checkpoint) => record.task.id !== checkpoint.task.id,
      ),
    ]);
    state.stored.delete("checkpoint");
  },
}));
vi.mock("./api", () => ({ api: state.api }));
vi.mock("./browser-tasks", () => ({ bundledTask: state.bundled }));
vi.mock("./science-module", () => ({
  compileScientificModule: async () =>
    new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])),
}));

const inputPdb = readFileSync(
  new URL("../public/fixtures/1l2y.pdb", import.meta.url),
  "utf8",
);
const hashes = {
  "rosetta.mjs": "a".repeat(64),
  "rosetta.wasm": "b".repeat(64),
  "rosetta.data": "c".repeat(64),
};
const manifest: EngineManifest = {
  id: ENGINE_ID,
  sourceSha: SOURCE_SHA,
  verified: true,
  supportedProtocols: ["score"],
  hashes,
  module: "rosetta.mjs",
  database: "rosetta.data",
  reason: "Orchestration test build; workers are mocked.",
};

class TransportWorker {
  static all: TransportWorker[] = [];
  onmessage?: (event: { data: any }) => void;
  onerror?: (event: { message: string }) => void;
  terminate = vi.fn();
  postMessage = vi.fn((_message: any) =>
    queueMicrotask(() => this.onmessage?.({ data: { type: "ready" } })),
  );
  constructor() {
    TransportWorker.all.push(this);
  }
  result(energy: number) {
    this.onmessage?.({ data: { type: "result", pdb: inputPdb, energy } });
  }
}
const sessions: Session[] = [];
function owner() {
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    id: crypto.randomUUID(),
    owner: true,
    initialized: true,
    controlEpoch: 0,
    action: Promise.resolve(),
    checkpointWrites: Promise.resolve(),
    snapshot: initialSnapshot(),
    update: vi.fn(),
    channel: { postMessage: vi.fn() },
    manifest: structuredClone(manifest),
  });
  sessions.push(session);
  return session;
}
async function job(models = 4): Promise<PeerJob> {
  return {
    id: crypto.randomUUID(),
    title: "Peer input orchestration fixture",
    description: "Compare independent Trp-cage models.",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    publisherId: "d".repeat(64),
    engine: { id: ENGINE_ID, sourceSha: SOURCE_SHA, hashes: { ...hashes } },
    protocol: "score",
    seed: 101,
    models,
    input: { pdb: inputPdb, sha256: await peerSha256(inputPdb) },
  };
}
async function accept(session: Session, input: PeerJob) {
  await session.acceptPeerJob(input, await hashPeerJob(input));
}
beforeEach(() => {
  state.stored.clear();
  state.api.mockReset();
  state.bundled.mockReset();
  state.preferences.apiUrl = "";
  state.preferences.workerCount = 2;
  state.preferences.dutyCycle = 25;
  state.preferences.automatic = false;
  TransportWorker.all = [];
  vi.stubGlobal("Worker", TransportWorker);
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ json: async () => structuredClone(manifest) })),
  );
});
afterEach(() => {
  for (const session of sessions.splice(0)) {
    clearInterval(session.timer);
    clearInterval(session.heartbeat);
    clearTimeout(session.queueTimer);
    clearTimeout(session.uploadTimer);
    session.browserPool?.stop();
  }
  vi.unstubAllGlobals();
});

it("runs exactly the accepted models with stable IDs/seeds and local limits, saves once and never auto-continues", async () => {
  state.preferences.apiUrl = "https://research.example.org";
  state.preferences.automatic = true;
  state.stored.set("benchmark-input", { task: "should not run" });
  const session = owner(),
    input = await job();
  const jobHash = await hashPeerJob(input);
  await session.acceptPeerJob(input, jobHash);
  expect(session.checkpoint?.peer).toEqual({
    jobId: input.id,
    publisherId: input.publisherId,
    jobHash,
    models: 4,
  });
  expect(
    session.checkpoint?.batch?.models.map((model) => ({
      id: model.task.id,
      jobId: model.task.jobId,
      index: model.task.modelIndex,
      seed: model.task.seed,
      inputHash: model.task.inputHash,
    })),
  ).toEqual(
    Array.from({ length: 4 }, (_, index) => ({
      id: `${input.id}:${index}`,
      jobId: input.id,
      index,
      seed: 101 + index,
      inputHash: input.input.sha256,
    })),
  );
  expect(session.snapshot).toMatchObject({
    taskSource: "peer",
    peerJobId: input.id,
    description: input.description,
    publisherId: input.publisherId,
    totalModels: 4,
    parallelism: 2,
    activeWorkers: 2,
  });
  expect(state.stored.has("peer-input")).toBe(false);
  expect(TransportWorker.all).toHaveLength(2);
  expect(TransportWorker.all[0].postMessage.mock.calls[0][0].dutyCycle).toBe(
    25,
  );
  TransportWorker.all[0].result(-10);
  await vi.waitFor(() => expect(TransportWorker.all).toHaveLength(3));
  TransportWorker.all[1].result(-20);
  await vi.waitFor(() => expect(TransportWorker.all).toHaveLength(4));
  TransportWorker.all[2].result(-30);
  TransportWorker.all[3].result(-40);
  TransportWorker.all[3].result(-400);
  await vi.waitFor(() => expect(session.snapshot.state).toBe("complete"));
  await session.action;
  expect(TransportWorker.all).toHaveLength(4);
  const records: Checkpoint[] = state.stored.get("browser-results");
  expect(records).toHaveLength(1);
  expect(records[0].peer).toEqual({
    jobId: input.id,
    publisherId: input.publisherId,
    jobHash,
    models: 4,
  });
  expect(records[0].batch?.models.map((model) => model.result?.energy)).toEqual(
    [-10, -20, -30, -40],
  );
  expect(session.snapshot).toMatchObject({
    taskSource: "peer",
    peerJobId: input.id,
    description: input.description,
    publisherId: input.publisherId,
    total: 4,
    completed: 4,
    energy: -40,
  });
  expect(state.stored.has("checkpoint")).toBe(false);
  expect(state.api).not.toHaveBeenCalled();
  expect(state.bundled).not.toHaveBeenCalled();
  await expect(accept(session, input)).rejects.toThrow("already completed");
  expect(TransportWorker.all).toHaveLength(4);
});

it("does not grow a one-model peer job to the local worker count", async () => {
  state.preferences.workerCount = 4;
  const session = owner(),
    input = await job(1);
  await accept(session, input);
  expect(TransportWorker.all).toHaveLength(1);
  expect(session.snapshot).toMatchObject({ parallelism: 1, totalModels: 1 });
  TransportWorker.all[0].result(-10);
  await vi.waitFor(() => expect(session.snapshot.state).toBe("complete"));
});

it.each([
  "loading",
  "running",
  "paused",
  "uploading",
  "waiting",
  "unavailable",
] as const)(
  "rejects peer acceptance during %s without changing current work",
  async (status) => {
    const session = owner(),
      input = await job();
    session.snapshot.state = status;
    const before = structuredClone(session.snapshot);
    await expect(accept(session, input)).rejects.toThrow("Finish or stop");
    expect(session.snapshot).toEqual(before);
    expect(state.stored.size).toBe(0);
    expect(TransportWorker.all).toHaveLength(0);
  },
);

it("rejects owners with checkpoints and followers or initializing tabs", async () => {
  const input = await job();
  for (const mode of ["checkpoint", "follower", "initializing"]) {
    const session = owner();
    if (mode === "checkpoint")
      session.checkpoint = { status: "paused" } as Checkpoint;
    if (mode === "follower") session.owner = false;
    if (mode === "initializing") Object.assign(session, { initialized: false });
    await expect(accept(session, input)).rejects.toThrow();
  }
  expect(TransportWorker.all).toHaveLength(0);
  expect(state.stored.size).toBe(0);
});

it("revalidates exact engine and input hashes and acceptance provenance without touching an existing completed view", async () => {
  const session = owner(),
    input = await job();
  session.snapshot.state = "complete";
  session.snapshot.pdb = "previous completed model";
  const before = structuredClone(session.snapshot);
  const altered = structuredClone(input);
  altered.engine.hashes["rosetta.wasm"] = "f".repeat(64);
  await expect(accept(session, altered)).rejects.toThrow("hash differs");
  await expect(session.acceptPeerJob(input, "0".repeat(64))).rejects.toThrow(
    "invalid hash",
  );
  const badCoordinates = structuredClone(input);
  badCoordinates.input.sha256 = "0".repeat(64);
  await expect(accept(session, badCoordinates)).rejects.toThrow("input hash");
  expect(session.snapshot).toEqual(before);
  expect(state.stored.size).toBe(0);
  expect(TransportWorker.all).toHaveLength(0);
  session.snapshot.state = "error";
  await accept(session, input);
  expect(TransportWorker.all).toHaveLength(2);
});

it("restores paused peer metadata and only resumes unfinished original attempts with current local settings", async () => {
  const first = owner(),
    input = await job(3);
  await accept(first, input);
  TransportWorker.all[0].result(-10);
  await vi.waitFor(() => expect(TransportWorker.all).toHaveLength(3));
  first.command("pause");
  await first.action;
  const saved: Checkpoint = state.stored.get("checkpoint");
  expect(saved.peer?.jobId).toBe(input.id);
  expect(saved.batch?.models[0].result?.energy).toBe(-10);
  state.preferences.automatic = true;
  state.preferences.workerCount = 1;
  state.preferences.dutyCycle = 75;
  const recovered = owner();
  await recovered.initialize();
  await recovered.action;
  expect(recovered.snapshot).toMatchObject({
    state: "paused",
    taskSource: "peer",
    peerJobId: input.id,
    description: input.description,
    publisherId: input.publisherId,
    completedModels: 1,
  });
  expect(TransportWorker.all).toHaveLength(3);
  await recovered.start();
  expect(TransportWorker.all).toHaveLength(4);
  expect(TransportWorker.all[3].postMessage.mock.calls[0][0]).toMatchObject({
    dutyCycle: 75,
    task: { id: `${input.id}:1`, seed: 102 },
  });
  TransportWorker.all[3].result(-20);
  await vi.waitFor(() => expect(TransportWorker.all).toHaveLength(5));
  expect(
    TransportWorker.all[4].postMessage.mock.calls[0][0].task,
  ).toMatchObject({ id: `${input.id}:2`, seed: 103 });
  TransportWorker.all[4].result(-30);
  await vi.waitFor(() => expect(recovered.snapshot.state).toBe("complete"));
  expect(state.stored.get("browser-results")).toHaveLength(1);
  expect(
    state.stored.get("browser-results")[0].batch.models[0].execution.dutyCycle,
  ).toBe(25);
  expect(TransportWorker.all).toHaveLength(5);
  expect(state.api).not.toHaveBeenCalled();
});

it("restores a completed peer job even with an API configured and never grants new consent on startup", async () => {
  const first = owner(),
    input = await job(1);
  await accept(first, input);
  TransportWorker.all[0].result(-10);
  await vi.waitFor(() => expect(first.snapshot.state).toBe("complete"));
  state.preferences.apiUrl = "https://research.example.org";
  state.preferences.automatic = true;
  const recovered = owner();
  await recovered.initialize();
  await recovered.action;
  expect(recovered.snapshot).toMatchObject({
    state: "complete",
    taskSource: "peer",
    peerJobId: input.id,
    description: input.description,
    publisherId: input.publisherId,
    energy: -10,
  });
  expect(TransportWorker.all).toHaveLength(1);
  expect(state.api).not.toHaveBeenCalled();
});

it("keeps crash-staged peer input ahead of API/benchmark but requires explicit resume and clears it on stop", async () => {
  const input = await job(1);
  state.stored.set("peer-input", {
    job: input,
    jobHash: await hashPeerJob(input),
  });
  state.stored.set("benchmark-input", { task: "should not run" });
  state.preferences.apiUrl = "https://research.example.org";
  state.preferences.automatic = true;
  const session = owner();
  await session.initialize();
  await session.action;
  expect(session.snapshot).toMatchObject({ state: "idle", taskSource: "peer" });
  expect(TransportWorker.all).toHaveLength(0);
  await session.stop();
  expect(state.stored.has("peer-input")).toBe(false);
  expect(session.snapshot).toMatchObject({
    state: "idle",
    taskSource: "research",
  });
  expect(state.api).not.toHaveBeenCalled();
});

it("an explicit bundled demo preserves an imported target and bypasses its source", async () => {
  state.preferences.apiUrl = "https://research.example.org";
  const imported = {
    task: { id: "private-upload", title: "Keep my uploaded target" },
  };
  state.stored.set("benchmark-input", imported);
  state.bundled.mockResolvedValue({
    id: "bundled-demo",
    title: "Demo",
    protocol: "score",
    seed: 17,
    pdb: inputPdb,
    models: 1,
  });
  const session = owner();
  await session.start("bundled");
  expect(session.snapshot.taskSource).toBe("bundled");
  expect(state.api).not.toHaveBeenCalled();
  expect(state.stored.get("benchmark-input")).toEqual(imported);
  expect(state.bundled).toHaveBeenCalledWith("score");
  expect(TransportWorker.all).toHaveLength(state.preferences.workerCount);
});

it("stopping peer work clears the displayed publisher and research context", async () => {
  const session = owner(),
    input = await job(1);
  await accept(session, input);
  await session.stop();
  expect(session.snapshot.description).toBeUndefined();
  expect(session.snapshot.publisherId).toBeUndefined();
  expect(session.snapshot.peerJobId).toBeUndefined();
  expect(session.snapshot.taskId).toBeUndefined();
});
