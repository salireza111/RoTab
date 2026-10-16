import { beforeAll, beforeEach, afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  ENGINE_ID,
  SOURCE_SHA,
  initialSnapshot,
  type Checkpoint,
  type Completion,
  type EngineManifest,
  type Task,
} from "@rosettatab/shared";
import { PeerCollaboration } from "./peer-collaboration";
import {
  canonicalStringify,
  generatePeerIdentity,
  hashPeerJob,
  peerSha256,
  signPeerMessage,
  verifyPeerMessage,
  type PeerIdentity,
  type PeerJob,
  type PeerResult,
  type SignedPeerMessage,
} from "./peer-protocol";

// These are controller tests: transport/storage and completed scientific records
// are fixtures. They do not constitute a WebRTC or Rosetta execution proof.
const mocks = vi.hoisted(() => ({
  state: new Map<string, unknown>(),
  links: [] as any[],
  bundled: vi.fn(),
}));
vi.mock("./storage", () => ({
  getState: async (key: string) => structuredClone(mocks.state.get(key)),
  putState: async (key: string, value: unknown) => {
    if (value === undefined) mocks.state.delete(key);
    else mocks.state.set(key, structuredClone(value));
  },
}));
vi.mock("./browser-tasks", () => ({
  bundledTask: (...args: unknown[]) => mocks.bundled(...args),
}));
vi.mock("./peer-connection", () => ({
  PeerConnection: class {
    connected = false;
    remoteId?: string;
    sent: SignedPeerMessage[] = [];
    constructor(
      readonly identity: PeerIdentity,
      readonly callbacks: any,
    ) {
      mocks.links.push(this);
    }
    async createInvitation() {
      return "invitation";
    }
    async joinInvitation() {
      return "reply";
    }
    async connectReply() {}
    async connectionKind() {
      return "direct";
    }
    async send(message: SignedPeerMessage) {
      this.sent.push(structuredClone(message));
    }
    disconnect() {
      this.connected = false;
      this.remoteId = undefined;
      this.callbacks.status("disconnected");
    }
  },
}));
const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
const hashes = {
  "rosetta.mjs": "a".repeat(64),
  "rosetta.wasm": "b".repeat(64),
  "rosetta.data": "c".repeat(64),
};
const manifest: EngineManifest = {
  id: ENGINE_ID,
  sourceSha: SOURCE_SHA,
  verified: true,
  module: "rosetta.mjs",
  database: "rosetta.data",
  hashes,
  supportedProtocols: ["score", "relax"],
  reason: "Controller fixture; no scientific execution",
};
let bob: PeerIdentity, stranger: PeerIdentity;
const controllers: PeerCollaboration[] = [];
beforeAll(async () => {
  [bob, stranger] = await Promise.all([
    generatePeerIdentity(),
    generatePeerIdentity(),
  ]);
});
beforeEach(() => {
  mocks.state.clear();
  mocks.links.length = 0;
  mocks.bundled.mockReset();
  mocks.bundled.mockResolvedValue({ pdb });
});
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.restoreAllMocks();
});
function create(
  accept: (job: PeerJob, hash: string) => Promise<void> = vi.fn(async () => {}),
) {
  const controller = new PeerCollaboration(manifest, {
    update: vi.fn(),
    accept,
  });
  controllers.push(controller);
  return controller;
}
async function connect(controller: PeerCollaboration, peer = bob) {
  await controller.initialize();
  const link = mocks.links.at(-1);
  link.remoteId = peer.id;
  link.connected = true;
  link.callbacks.status("connected", peer.id);
  await expect.poll(() => controller.view.state).toBe("connected");
  await expect
    .poll(() =>
      link.sent.some(
        (message: SignedPeerMessage) => message.payload.type === "hello",
      ),
    )
    .toBe(true);
  return link;
}
async function remoteJob(overrides: Partial<PeerJob> = {}): Promise<PeerJob> {
  const now = Date.now();
  return {
    id: crypto.randomUUID(),
    title: "Peer Trp-cage",
    createdAt: now - 100,
    expiresAt: now + 60_000,
    publisherId: bob.id,
    engine: { id: ENGINE_ID, sourceSha: SOURCE_SHA, hashes },
    protocol: "relax",
    seed: 17,
    models: 2,
    input: { pdb, sha256: await peerSha256(pdb) },
    ...overrides,
  };
}
async function offer(
  controller: PeerCollaboration,
  link: any,
  offeredJob?: PeerJob,
) {
  const job = offeredJob ?? (await remoteJob());
  link.callbacks.message(await signPeerMessage(bob, { type: "job", job }));
  await expect
    .poll(() => controller.view.jobs.some((entry) => entry.job.id === job.id))
    .toBe(true);
  return job;
}
function completed(job: PeerJob, jobHash: string): Checkpoint {
  const task = (modelIndex: number): Task => ({
    id: `${job.id}:${modelIndex}`,
    jobId: job.id,
    title: job.title,
    protocol: job.protocol,
    pdb: job.input.pdb,
    inputHash: job.input.sha256,
    seed: job.seed + modelIndex,
    modelIndex,
    engineId: ENGINE_ID,
    sourceSha: SOURCE_SHA,
    state: "leased",
    attemptToken: crypto.randomUUID(),
    clientId: null,
    leaseUntil: null,
    result: null,
    rejection: null,
  });
  const completion: Completion = {
    attemptToken: crypto.randomUUID(),
    pdb,
    energy: -48.1,
    elapsedMs: 500,
    engineId: ENGINE_ID,
    sourceSha: SOURCE_SHA,
  };
  return {
    task: task(0),
    result: completion,
    engineManifest: manifest,
    taskSource: "peer",
    startedAt: Date.now() - 1_000,
    status: "running",
    peer: {
      jobId: job.id,
      publisherId: job.publisherId,
      jobHash,
      models: job.models,
    },
    batch: {
      parallelism: 2,
      models: Array.from({ length: job.models }, (_, modelIndex) => ({
        task: task(modelIndex),
        result: completion,
        history: [12, 1, -48.1],
        startedAt: Date.now() - 1_000,
        status: "complete",
      })),
    },
  };
}
async function remoteResult(job: PeerJob): Promise<PeerResult> {
  return {
    id: crypto.randomUUID(),
    jobId: job.id,
    inputSha256: job.input.sha256,
    engine: job.engine,
    completedAt: Date.now(),
    models: Array.from({ length: job.models }, (_, modelIndex) => ({
      modelIndex,
      seed: job.seed + modelIndex,
      protocol: job.protocol,
      pdb,
      sha256: job.input.sha256,
      energy: -48.1,
      elapsedMs: 500,
      history: [12, 1, -48.1],
    })),
  };
}

it("persists an admitted signed offer before explicit acceptance and restores the same identity", async () => {
  const accept = vi.fn(async (job: PeerJob, hash: string) => {
    const saved = mocks.state.get("peer-ledger") as any;
    expect(saved.jobs[0].job).toEqual(job);
    expect(saved.jobs[0].hash).toBe(hash);
    expect(saved.jobs[0].status).toBe("offered");
  });
  const controller = create(accept),
    link = await connect(controller);
  const job = await offer(controller, link);
  expect(accept).not.toHaveBeenCalled();
  await controller.acceptJob(job.id);
  expect(accept).toHaveBeenCalledOnce();
  expect(controller.view.jobs[0].status).toBe("accepted");
  expect(accept.mock.calls[0][1]).toBe(await hashPeerJob(job));
  const id = controller.view.identityId;
  controller.dispose();
  const restored = create();
  await restored.initialize();
  expect(restored.view.identityId).toBe(id);
  expect(restored.view.jobs).toHaveLength(1);
  expect(restored.callbacks.accept).not.toHaveBeenCalled();
});

it("rejects altered signatures/hashes, unknown identities and conflicting job IDs without running work", async () => {
  const controller = create(),
    link = await connect(controller),
    job = await remoteJob();
  const envelope = await signPeerMessage(bob, { type: "job", job });
  const tampered = structuredClone(envelope);
  if (tampered.payload.type !== "job") throw new Error("Fixture payload");
  tampered.payload.job.seed++;
  link.callbacks.message(tampered);
  await expect.poll(() => controller.view.error).toContain("Rejected");
  expect(controller.view.jobs).toHaveLength(0);
  link.callbacks.message(
    await signPeerMessage(stranger, {
      type: "job",
      job: { ...job, publisherId: stranger.id },
    }),
  );
  link.callbacks.message(
    await signPeerMessage(bob, {
      type: "job",
      job: { ...job, input: { ...job.input, sha256: "0".repeat(64) } },
    }),
  );
  await offer(controller, link, job);
  link.callbacks.message(envelope);
  link.callbacks.message(
    await signPeerMessage(bob, {
      type: "job",
      job: { ...job, title: "Conflicting replacement" },
    }),
  );
  await expect
    .poll(
      () =>
        (mocks.state.get("peer-ledger") as any)?.events.filter(
          (event: any) => event.code === "message-rejected",
        ).length,
    )
    .toBe(4);
  expect(controller.view.jobs).toHaveLength(1);
  expect(controller.view.jobs[0].job.title).toBe(job.title);
  expect(controller.callbacks.accept).not.toHaveBeenCalled();
});

it("keeps completed real-format records in an offline outbox until a signed matching receipt", async () => {
  const controller = create(),
    link = await connect(controller),
    job = await offer(controller, link);
  await controller.acceptJob(job.id);
  controller.disconnect();
  const hash = await hashPeerJob(job);
  mocks.state.set("browser-results", [completed(job, hash)]);
  await controller.observe({
    ...initialSnapshot(),
    state: "complete",
    peerJobId: job.id,
    completedModels: 2,
    elapsedMs: 1_000,
  });
  expect(controller.view.results).toHaveLength(1);
  const outbox = controller.view.results[0];
  expect(outbox.delivery).toBe("pending");
  expect(outbox.result.models.map((model) => model.seed)).toEqual([17, 18]);
  expect(canonicalStringify(outbox)).not.toContain("frames");
  const id = outbox.result.id;
  const reconnected = await connect(controller);
  await expect
    .poll(
      () =>
        reconnected.sent.filter(
          (message: SignedPeerMessage) => message.payload.type === "result",
        ).length,
    )
    .toBe(1);
  const sent = reconnected.sent.find(
    (message: SignedPeerMessage) => message.payload.type === "result",
  );
  expect(
    (await verifyPeerMessage(sent, controller.view.identityId!)).payload.type,
  ).toBe("result");
  const receipt = await signPeerMessage(bob, {
    type: "receipt",
    jobId: job.id,
    resultId: id,
  });
  reconnected.callbacks.message(receipt);
  await expect
    .poll(() => controller.view.results[0].delivery)
    .toBe("acknowledged");
  reconnected.callbacks.message(receipt);
  await controller.retry();
  expect(controller.view.results).toHaveLength(1);
  expect(controller.view.results[0].scientificValidation).toBe("not-verified");
});

it("recovers a completed job after browser restart without a second result or connection", async () => {
  const controller = create(),
    link = await connect(controller),
    job = await offer(controller, link);
  await controller.acceptJob(job.id);
  mocks.state.set("browser-results", [completed(job, await hashPeerJob(job))]);
  controller.dispose();
  const restored = create();
  await restored.initialize();
  expect(restored.view.results).toHaveLength(1);
  expect(restored.view.results[0].delivery).toBe("pending");
  const resultId = restored.view.results[0].result.id;
  restored.dispose();
  const again = create();
  await again.initialize();
  expect(again.view.results).toHaveLength(1);
  expect(again.view.results[0].result.id).toBe(resultId);
  expect(again.callbacks.accept).not.toHaveBeenCalled();
});

it("adopts a durable explicitly accepted checkpoint after a crash before the offer status was saved", async () => {
  const controller = create(),
    link = await connect(controller);
  const job = await offer(controller, link);
  expect(controller.view.jobs[0].status).toBe("offered");
  const checkpoint = completed(job, await hashPeerJob(job));
  delete checkpoint.result;
  for (const model of checkpoint.batch!.models) {
    delete model.result;
    model.status = "queued";
  }
  mocks.state.set("checkpoint", checkpoint);
  controller.dispose();
  const restored = create();
  await restored.initialize();
  expect(restored.view.jobs[0].status).toBe("accepted");
  expect(restored.view.jobs[0].progress).toMatchObject({
    state: "paused",
    completed: 0,
    total: 2,
  });
  expect(restored.callbacks.accept).not.toHaveBeenCalled();
  expect(restored.view.results).toHaveLength(0);
  await restored.observe({
    ...initialSnapshot(),
    state: "running",
    peerJobId: job.id,
    completedModels: 1,
    elapsedMs: 500,
  });
  expect(restored.view.jobs[0].progress?.completed).toBe(1);
  mocks.state.delete("checkpoint");
  mocks.state.set("browser-results", [completed(job, await hashPeerJob(job))]);
  await restored.observe({
    ...initialSnapshot(),
    state: "complete",
    peerJobId: job.id,
    completedModels: 2,
    elapsedMs: 1_000,
  });
  expect(restored.view.results).toHaveLength(1);
  expect(restored.view.results[0].delivery).toBe("pending");
});

it("deduplicates returned outputs, acknowledges duplicates and rejects changed results without scientific acceptance", async () => {
  const controller = create(),
    link = await connect(controller);
  await controller.publish({
    description: "Compare independent Trp-cage models.",
    title: "My target",
    protocol: "relax",
    models: 2,
    seed: 17,
    useImported: false,
  });
  const job = controller.view.jobs[0].job,
    result = await remoteResult(job);
  const envelope = await signPeerMessage(bob, { type: "result", result });
  link.callbacks.message(envelope);
  await expect.poll(() => controller.view.results.length).toBe(1);
  await expect
    .poll(
      () =>
        link.sent.filter(
          (message: SignedPeerMessage) => message.payload.type === "receipt",
        ).length,
    )
    .toBe(1);
  link.callbacks.message(envelope);
  await expect
    .poll(
      () =>
        link.sent.filter(
          (message: SignedPeerMessage) => message.payload.type === "receipt",
        ).length,
    )
    .toBe(2);
  const changed = structuredClone(result);
  changed.models[0].energy--;
  link.callbacks.message(
    await signPeerMessage(bob, { type: "result", result: changed }),
  );
  link.callbacks.message(
    await signPeerMessage(bob, {
      type: "result",
      result: { ...result, id: crypto.randomUUID() },
    }),
  );
  await expect
    .poll(
      () =>
        (mocks.state.get("peer-ledger") as any).events.filter(
          (event: any) => event.code === "message-rejected",
        ).length,
    )
    .toBe(2);
  expect(controller.view.results).toHaveLength(1);
  expect(controller.view.results[0].result.models[0].energy).toBe(-48.1);
  expect(controller.view.results[0].scientificValidation).toBe("not-verified");
  expect(controller.view.jobs[0].status).toBe("complete");
});

it("serializes acceptance, throttles signed progress and releases the busy guard after a local stop", async () => {
  const controller = create(),
    link = await connect(controller),
    one = await offer(controller, link),
    two = await offer(controller, link);
  await controller.acceptJob(one.id);
  await expect(controller.acceptJob(two.id)).rejects.toThrow("Finish or stop");
  const start = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(start);
  const snapshot = {
    ...initialSnapshot(),
    state: "running" as const,
    peerJobId: one.id,
    completedModels: 0,
    elapsedMs: 10,
  };
  await controller.observe(snapshot);
  await controller.observe(snapshot);
  expect(
    link.sent.filter(
      (message: SignedPeerMessage) => message.payload.type === "progress",
    ),
  ).toHaveLength(2); // acceptance + one observation
  vi.mocked(Date.now).mockReturnValue(start + 1_100);
  await controller.observe(snapshot);
  expect(
    link.sent.filter(
      (message: SignedPeerMessage) => message.payload.type === "progress",
    ),
  ).toHaveLength(3);
  await controller.observe(initialSnapshot());
  await controller.acceptJob(two.id);
  expect(controller.callbacks.accept).toHaveBeenCalledTimes(2);
});

it("does not leak a queued target/result when a different peer connects during preparation", async () => {
  const controller = create(),
    link = await connect(controller);
  let resolve!: (value: { pdb: string }) => void;
  mocks.bundled.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const publishing = controller.publish({
    description: "Compare independent Trp-cage models.",
    title: "Pinned target",
    protocol: "score",
    models: 1,
    seed: 17,
    useImported: false,
  });
  await expect.poll(() => typeof resolve).toBe("function");
  link.remoteId = stranger.id;
  resolve({ pdb });
  await publishing;
  expect(controller.view.jobs[0].peerId).toBe(bob.id);
  expect(
    link.sent.filter(
      (message: SignedPeerMessage) => message.payload.type === "job",
    ),
  ).toHaveLength(0);
  await controller.retry();
  expect(
    link.sent.filter(
      (message: SignedPeerMessage) => message.payload.type === "job",
    ),
  ).toHaveLength(0);
  link.remoteId = bob.id;
  await controller.retry();
  expect(
    link.sent.filter(
      (message: SignedPeerMessage) => message.payload.type === "job",
    ),
  ).toHaveLength(1);
});

it("does not overwrite a new owner's ledger after disposal while an input is loading", async () => {
  const controller = create();
  const link = await connect(controller);
  let resolve!: (value: { pdb: string }) => void;
  mocks.bundled.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const publishing = controller.publish({
    description: "Compare independent Trp-cage models.",
    title: "Old owner",
    protocol: "score",
    models: 1,
    seed: 17,
    useImported: false,
  });
  await expect.poll(() => typeof resolve).toBe("function");
  controller.dispose();
  const next = create();
  await next.initialize();
  const saved = structuredClone(mocks.state.get("peer-ledger"));
  resolve({ pdb });
  await expect(publishing).rejects.toThrow("closed");
  expect(mocks.state.get("peer-ledger")).toEqual(saved);
  expect(
    link.sent.filter(
      (message: SignedPeerMessage) => message.payload.type === "job",
    ),
  ).toHaveLength(0);
  expect(next.view.jobs).toHaveLength(0);
});

it("exports experiment evidence without private keys, SDP, TURN credentials or raw connection errors", async () => {
  const controller = create(),
    link = await connect(controller);
  await controller.publish({
    description: "Compare independent Trp-cage models.",
    title: "Exportable target",
    protocol: "score",
    models: 1,
    seed: 17,
    useImported: false,
  });
  link.callbacks.error(
    "https://192.168.1.45/private?credential=secret TURN password SDP v=0",
  );
  await expect.poll(() => controller.view.error).toContain("connection failed");
  const record = (await controller.exportRecords()) as any;
  expect(record.schema).toBe("rosettatab-peer-record-v1");
  expect(record.jobs[0].envelope.payload.type).toBe("job");
  expect(record.scientificValidation).toBe("not-verified");
  const text = canonicalStringify(record);
  for (const secret of [
    "privateKey",
    "192.168.1.45",
    "credential",
    "secret",
    '"sdp"',
    '"pairing"',
  ])
    expect(text).not.toContain(secret);
  const stored = mocks.state.get("peer-identity") as PeerIdentity;
  expect(stored.privateKey.extractable).toBe(false);
  const exportedJob = record.jobs[0].job;
  expect(await peerSha256(canonicalStringify(exportedJob))).toBe(
    record.jobs[0].hash,
  );
});

it("rejects unsupported imported targets and invalid stored signatures without deleting evidence", async () => {
  const controller = create(),
    link = await connect(controller);
  await expect(
    controller.publish({
      description: "Compare independent Trp-cage models.",
      title: "No import",
      protocol: "score",
      models: 1,
      seed: 17,
      useImported: true,
    }),
  ).rejects.toThrow("Import");
  mocks.state.set("benchmark-input", {
    task: { pdb: "HETATM" + pdb.slice(6) },
  });
  await expect(
    controller.publish({
      description: "Compare independent Trp-cage models.",
      title: "Bad import",
      protocol: "score",
      models: 1,
      seed: 17,
      useImported: true,
    }),
  ).rejects.toThrow("Ligands");
  const job = await offer(controller, link);
  const ledger = structuredClone(mocks.state.get("peer-ledger")) as any;
  ledger.jobs[0].job.title = "Storage tampering";
  mocks.state.set("peer-ledger", ledger);
  controller.dispose();
  const restored = create();
  await expect(restored.initialize()).rejects.toThrow("integrity");
  expect((mocks.state.get("peer-ledger") as any).jobs[0].job.id).toBe(job.id);
});

it("publishes a direct uploaded target with its own hash without replacing the local benchmark", async () => {
  const controller = create();
  await connect(controller);
  const input = pdb + "\nREMARK upload identity test\n";
  mocks.state.set("benchmark-input", { task: { pdb } });
  await controller.publish({
    description: "Compare independent Trp-cage models.",
    title: "Uploaded target",
    protocol: "score",
    seed: 23,
    models: 3,
    useImported: true,
    inputPdb: input,
  });
  const job = controller.view.jobs[0].job;
  expect(job.input.pdb).toBe(input);
  expect(job.input.sha256).toBe(await peerSha256(input));
  expect(job).toMatchObject({ seed: 23, models: 3, protocol: "score" });
  expect(mocks.state.get("benchmark-input")).toEqual({ task: { pdb } });
  await expect(
    controller.publish({
      description: "Compare independent Trp-cage models.",
      title: "Invalid upload",
      protocol: "score",
      seed: 23,
      models: 1,
      useImported: true,
      inputPdb: "invalid",
    }),
  ).rejects.toThrow();
  expect(controller.view.jobs).toHaveLength(1);
});
