import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import {
  ENGINE_ID,
  SOURCE_SHA,
  initialSnapshot,
  type EngineManifest,
} from "@rosettatab/shared";
import {
  generatePeerIdentity,
  signPeerMessage,
  peerSha256,
} from "./peer-protocol";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";

const fixture = vi.hoisted(() => ({
  state: new Map<string, unknown>(),
  links: [] as any[],
  signals: [] as any[],
  blockSends: false,
  peerIdentity: undefined as any,
  nostrIdentity: undefined as any,
  reads: [] as string[],
}));
vi.mock("./storage", () => ({
  getState: async (key: string) => {
    fixture.reads.push(key);
    return structuredClone(fixture.state.get(key));
  },
  putState: async (key: string, value: unknown) => {
    fixture.state.set(key, structuredClone(value));
  },
}));
vi.mock("./peer-identity", () => ({
  loadPeerIdentity: async () => fixture.peerIdentity,
}));
vi.mock("./nostr-discovery", async (original) => ({
  ...(await original<object>()),
  loadNostrIdentity: async () => fixture.nostrIdentity,
  NostrDiscovery: class {
    constructor(
      readonly identity: unknown,
      readonly settings: unknown,
      readonly callbacks: any,
    ) {}
    async start() {}
    announce() {}
    async signal(...args: unknown[]) {
      fixture.signals.push(args);
    }
    async connectivity(...args: unknown[]) {
      fixture.signals.push(args);
    }
    stop() {}
  },
}));
vi.mock("./peer-connection", () => ({
  decodePeerCode: vi.fn(),
  PeerConnection: class {
    connected = false;
    remoteId?: string;
    sessionId = crypto.randomUUID();
    diagnostics() {
      return {
        state: "waiting",
        iceState: "new",
        transportState: "new",
        gatheringState: "complete",
        remoteDescription: false,
        localCandidateTypes: [],
        remoteCandidateTypes: [],
        turnConfigured: false,
        iceServerErrors: [],
      };
    }
    connectionFailure() {
      return "No connection reply received.";
    }
    async addRemoteCandidates() {}
    async joinInvitation() {
      return "RT1.answer";
    }
    async connectReply() {}
    resolve?: (code: string) => void;
    constructor(
      readonly identity: unknown,
      readonly callbacks: any,
    ) {
      fixture.links.push(this);
    }
    createInvitation() {
      return new Promise<string>((resolve) => {
        this.resolve = resolve;
      });
    }
    disconnect() {}
    async send() {
      if (fixture.blockSends) await new Promise(() => {});
    }
  },
}));
import { VolunteerNetwork } from "./volunteer-network";
import { decodePeerCode } from "./peer-connection";

const manifest: EngineManifest = {
  id: ENGINE_ID,
  sourceSha: SOURCE_SHA,
  verified: true,
  module: "rosetta.mjs",
  database: "rosetta.data",
  reason: "Transport test only",
  hashes: {
    "rosetta.mjs": "a".repeat(64),
    "rosetta.wasm": "b".repeat(64),
    "rosetta.data": "c".repeat(64),
  },
  supportedProtocols: ["score"],
};
let controller: VolunteerNetwork;
afterEach(() => {
  controller?.dispose();
  fixture.state.clear();
  fixture.links = [];
  fixture.signals = [];
  fixture.blockSends = false;
  fixture.reads = [];
  vi.mocked(decodePeerCode).mockReset();
  vi.restoreAllMocks();
});

it("does not repeatedly deserialize saved trajectories on completed dashboard updates with no recoverable incoming work", async () => {
  fixture.peerIdentity = await generatePeerIdentity();
  const secret = generateSecretKey();
  fixture.nostrIdentity = { secret, publicKey: getPublicKey(secret) };
  fixture.state.set("browser-results", [
    { result: { pdb: "saved large trajectory" } },
  ]);
  controller = new VolunteerNetwork(manifest, {
    update: vi.fn(),
    accept: vi.fn(),
    available: () => false,
  });
  await controller.initialize();
  for (let i = 0; i < 3; i++) {
    await controller.observe({ ...initialSnapshot(), state: "complete" });
    await controller.tick();
  }
  expect(fixture.reads).not.toContain("browser-results");
  expect(fixture.state.get("browser-results")).toHaveLength(1);
});

it("recovers an accepted model and delivers its receipt before skipping later history reads", async () => {
  fixture.peerIdentity = await generatePeerIdentity();
  const secret = generateSecretKey();
  fixture.nostrIdentity = { secret, publicKey: getPublicKey(secret) };
  let available = true;
  const accept = vi.fn(async () => {
    available = false;
  });
  controller = new VolunteerNetwork(manifest, {
    update: vi.fn(),
    accept,
    available: () => available,
  });
  await controller.initialize();
  const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
  await controller.submit({
    title: "Recovery and cleanup",
    description: "Transport-only result recovery fixture.",
    protocol: "score",
    seed: 17,
    models: 1,
    inputPdb: pdb,
  });
  expect(accept).toHaveBeenCalledOnce();
  const entry = controller.view.incoming[0];
  if (
    entry.envelope.payload.type !== "network" ||
    entry.envelope.payload.message.kind !== "assignment"
  )
    throw new Error("Expected an accepted assignment");
  const job = entry.envelope.payload.message.job;
  fixture.state.set("browser-results", [
    {
      peer: {
        jobId: job.id,
        publisherId: fixture.peerIdentity.id,
        jobHash: entry.hash,
      },
      engineManifest: manifest,
      task: { modelIndex: 0, seed: 17, protocol: "score" },
      result: { pdb, energy: 32.334836814, elapsedMs: 1000 },
      history: [32.334836814],
    },
  ]);
  fixture.reads = [];
  vi.mocked(decodePeerCode).mockReset();
  vi.restoreAllMocks();
  await controller.observe({
    ...initialSnapshot(),
    state: "complete",
    peerJobId: job.id,
  });
  expect(controller.view.incoming[0].receipt).toBe("received");
  expect(controller.view.campaigns[0].state).toBe("complete");
  expect(
    controller.view.campaigns[0].attempts[0].outcome?.result.models[0].pdb,
  ).toBe(pdb);
  expect(fixture.reads.filter((key) => key === "browser-results")).toHaveLength(
    1,
  );
  for (let i = 0; i < 3; i++) {
    await controller.observe({
      ...initialSnapshot(),
      state: "complete",
      peerJobId: job.id,
    });
    await controller.tick();
  }
  expect(fixture.reads.filter((key) => key === "browser-results")).toHaveLength(
    1,
  );
  expect(controller.view.incoming[0].result).toBeDefined();
});

it("keeps ticks and persisted work moving while six ICE handshakes are pending", async () => {
  const identities = await Promise.all(
    Array.from({ length: 7 }, () => generatePeerIdentity()),
  );
  identities.sort((a, b) => a.id.localeCompare(b.id));
  fixture.peerIdentity = identities[0];
  const secret = generateSecretKey();
  fixture.nostrIdentity = { secret, publicKey: getPublicKey(secret) };
  controller = new VolunteerNetwork(manifest, {
    update: vi.fn(),
    accept: vi.fn(),
    available: () => false,
  });
  await controller.initialize();
  const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
  await controller.submit({
    title: "Concurrent routing",
    description: "Test the browser transport without running science.",
    protocol: "score",
    seed: 17,
    models: 6,
    inputPdb: pdb,
    participateLocal: false,
  });
  for (const identity of identities.slice(1)) {
    const key = getPublicKey(generateSecretKey());
    const envelope = await signPeerMessage(identity, {
      type: "network",
      message: {
        kind: "presence",
        networkVersion: 3,
        nostrPublicKey: key,
        issuedAt: Date.now(),
        expiresAt: Date.now() + 45_000,
        engine: {
          id: ENGINE_ID,
          sourceSha: SOURCE_SHA,
          hashes: {
            "rosetta.mjs": "a".repeat(64),
            "rosetta.wasm": "b".repeat(64),
            "rosetta.data": "c".repeat(64),
          },
        },
        protocols: ["score"],
        automatic: true,
        available: true,
        campaigns: [],
      },
    });
    const network = controller as any;
    await network.serial(() =>
      network.presence({
        peerId: identity.id,
        nostrPublicKey: key,
        envelope,
        presence: (envelope.payload as any).message,
        seenAt: Date.now(),
      }),
    );
  }
  expect(fixture.links).toHaveLength(6);
  // Previously the first presence call held the serial queue for up to 8s.
  await controller.tick();
  expect((await controller.exportRecords()).publisher).toBeDefined();
  expect(fixture.signals).toHaveLength(0);
  for (const link of fixture.links) link.resolve("RT1.fixture");
  await vi.waitFor(() => expect(fixture.signals).toHaveLength(6));
  fixture.blockSends = true;
  fixture.links.forEach((link, i) => {
    link.connected = true;
    link.remoteId = identities[i + 1].id;
  });
  await controller.tick();
  expect(
    controller.view.campaigns[0].attempts.filter((a) => a.lease),
  ).toHaveLength(6);
  expect(fixture.state.get("campaign-ledger")).toBeDefined();
  expect(await peerSha256(pdb)).toMatch(/^[a-f0-9]{64}$/);
});

it("reconnects to a former worker after campaign deletion and publisher restart", async () => {
  const [publisher, worker] = (
    await Promise.all([generatePeerIdentity(), generatePeerIdentity()])
  ).sort((a, b) => a.id.localeCompare(b.id));
  fixture.peerIdentity = publisher;
  const secret = generateSecretKey();
  fixture.nostrIdentity = { secret, publicKey: getPublicKey(secret) };
  const callbacks = {
    update: vi.fn(),
    accept: vi.fn(),
    available: () => false,
  };
  controller = new VolunteerNetwork(manifest, callbacks);
  await controller.initialize();
  const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
  const campaign = await controller.submit({
    title: "Removed target",
    description: "Late-return transport fixture.",
    protocol: "score",
    seed: 17,
    models: 1,
    inputPdb: pdb,
    participateLocal: false,
  });
  const engine = {
    id: manifest.id,
    sourceSha: manifest.sourceSha,
    hashes: manifest.hashes,
  };
  await (controller as any).queue.assign([
    {
      id: worker.id,
      seenAt: Date.now(),
      automatic: true,
      available: true,
      engine,
      protocols: ["score"],
    },
  ]);
  await controller.removeCampaign(campaign.id);
  expect(controller.view.campaigns).toEqual([]);
  expect(fixture.state.get("campaign-ledger")).toMatchObject({
    campaigns: [],
    retiredWorkers: [worker.id],
  });
  controller.dispose();
  controller = new VolunteerNetwork(manifest, callbacks);
  await controller.initialize();
  const key = getPublicKey(generateSecretKey());
  const issuedAt = Date.now();
  const envelope = await signPeerMessage(worker, {
    type: "network",
    message: {
      kind: "presence",
      networkVersion: 3,
      nostrPublicKey: key,
      issuedAt,
      expiresAt: issuedAt + 45_000,
      engine: engine as any,
      protocols: ["score"],
      automatic: true,
      available: false,
      campaigns: [],
    },
  });
  const network = controller as any;
  await network.serial(() =>
    network.presence({
      peerId: worker.id,
      nostrPublicKey: key,
      envelope,
      presence: (envelope.payload as any).message,
      seenAt: Date.now(),
    }),
  );
  // The lower-ID publisher initiates despite having no remaining campaign.
  expect(fixture.links).toHaveLength(1);
  await controller.tick();
});

async function connectedFixture(responder = false) {
  const ids = (
    await Promise.all([generatePeerIdentity(), generatePeerIdentity()])
  ).sort((a, b) => a.id.localeCompare(b.id));
  const local = ids[responder ? 1 : 0],
    remote = ids[responder ? 0 : 1];
  fixture.peerIdentity = local;
  const secret = generateSecretKey();
  fixture.nostrIdentity = { secret, publicKey: getPublicKey(secret) };
  controller = new VolunteerNetwork(manifest, {
    update: vi.fn(),
    accept: vi.fn(),
    available: () => false,
  });
  await controller.initialize();
  await controller.submit({
    title: "Connectivity fixture",
    description: "Exercise retries without running scientific work.",
    protocol: "score",
    seed: 17,
    models: 1,
    inputPdb: readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8"),
    participateLocal: false,
  });
  const key = getPublicKey(generateSecretKey()),
    issuedAt = Date.now();
  const envelope = await signPeerMessage(remote, {
    type: "network",
    message: {
      kind: "presence",
      networkVersion: 3,
      nostrPublicKey: key,
      issuedAt,
      expiresAt: issuedAt + 45_000,
      engine: {
        id: ENGINE_ID,
        sourceSha: SOURCE_SHA,
        hashes: manifest.hashes as any,
      },
      protocols: ["score"],
      automatic: true,
      available: true,
      campaigns: [],
    },
  });
  const network = controller as any;
  await network.serial(() =>
    network.presence({
      peerId: remote.id,
      nostrPublicKey: key,
      envelope,
      presence: (envelope.payload as any).message,
      seenAt: issuedAt,
    }),
  );
  return { network, key, remote, issuedAt };
}
it("resends a missed invitation without duplicating the link or pending work", async () => {
  const { issuedAt } = await connectedFixture();
  fixture.links[0].resolve("RT1.original");
  await vi.waitFor(() => expect(fixture.signals).toHaveLength(1));
  vi.spyOn(Date, "now").mockReturnValue(issuedAt + 13_000);
  await controller.tick();
  expect(fixture.signals.map((s) => s[2])).toEqual([
    "RT1.original",
    "RT1.original",
  ]);
  expect(fixture.links).toHaveLength(1);
  expect(controller.view.campaigns[0].attempts).toHaveLength(1);
  expect(controller.view.campaigns[0].attempts[0].lease).toBeUndefined();
});
it("resends a cached answer to a repeated offer, keeping the same session", async () => {
  const { network, key, remote, issuedAt } = await connectedFixture(true);
  vi.mocked(decodePeerCode).mockResolvedValue({
    senderId: remote.id,
    payload: {
      type: "pairing",
      pairing: {
        kind: "offer",
        sessionId: crypto.randomUUID(),
        createdAt: issuedAt,
      },
    },
  } as any);
  const signal = { version: 1, senderId: remote.id, code: "RT1.offer" };
  await network.serial(() => network.signal(key, signal));
  await vi.waitFor(() => expect(fixture.signals).toHaveLength(1));
  await network.serial(() => network.signal(key, signal));
  expect(fixture.signals).toHaveLength(1);
  vi.spyOn(Date, "now").mockReturnValue(issuedAt + 9_000);
  await network.serial(() => network.signal(key, signal));
  expect(fixture.signals.map((s) => s[2])).toEqual([
    "RT1.answer",
    "RT1.answer",
  ]);
  expect(fixture.links).toHaveLength(1);
});
it("ignores an old answer without poisoning the current invitation", async () => {
  const { network, key, remote } = await connectedFixture();
  const link = fixture.links[0];
  link.connectReply = vi.fn(async () => {});
  vi.mocked(decodePeerCode).mockResolvedValue({
    senderId: remote.id,
    payload: {
      type: "pairing",
      pairing: { kind: "answer", sessionId: crypto.randomUUID() },
    },
  } as any);
  await network.serial(() =>
    network.signal(key, { version: 1, senderId: remote.id, code: "RT1.stale" }),
  );
  expect(link.connectReply).not.toHaveBeenCalled();
  vi.mocked(decodePeerCode).mockResolvedValue({
    senderId: remote.id,
    payload: {
      type: "pairing",
      pairing: { kind: "answer", sessionId: link.sessionId },
    },
  } as any);
  await network.serial(() =>
    network.signal(key, {
      version: 1,
      senderId: remote.id,
      code: "RT1.current",
    }),
  );
  expect(link.connectReply).toHaveBeenCalledExactlyOnceWith("RT1.current");
  expect(controller.view.peers[0].connectionError).toBeUndefined();
});
it("retains bounded out-of-order ICE until its session exists and rejects a different Nostr binding", async () => {
  const { network, key, remote } = await connectedFixture(true);
  const sessionId = crypto.randomUUID(),
    candidates = [
      { candidate: "candidate:1 1 udp 1 203.0.113.1 1234 typ relay" },
    ];
  const signal = {
    version: 2,
    senderId: remote.id,
    update: { type: "ice", sessionId, candidates },
  };
  await network.serial(() => network.signal("0".repeat(64), signal));
  expect(network.pendingIce.size).toBe(0);
  for (let i = 0; i < 150; i++)
    await network.serial(() => network.signal(key, signal));
  expect(network.pendingIce.get(remote.id)[0].candidates).toHaveLength(128);
  const link = network.makeLink(remote.id);
  link.sessionId = sessionId;
  link.addRemoteCandidates = vi.fn(async () => {});
  network.drainCandidates(remote.id);
  expect(link.addRemoteCandidates).toHaveBeenCalledOnce();
  expect(link.addRemoteCandidates.mock.calls[0][0]).toBe(sessionId);
  expect(network.pendingIce.size).toBe(0);
});

it("retries failed links without deleting campaigns or disturbing connected peers", async () => {
  const { network, remote } = await connectedFixture();
  const campaign = controller.view.campaigns[0];
  const first = fixture.links[0];
  await controller.retryConnections();
  expect(fixture.links).toHaveLength(2);
  expect(network.links.get(remote.id).link).not.toBe(first);
  expect(controller.view.campaigns[0]).toEqual(campaign);
  const second = fixture.links[1];
  second.connected = true;
  await controller.retryConnections();
  expect(fixture.links).toHaveLength(2);
  expect(network.links.get(remote.id).link).toBe(second);
});
it("repeats late candidates while a connection is incomplete after relay acceptance", async () => {
  const { issuedAt } = await connectedFixture();
  const link = fixture.links[0];
  link.resolve("RT1.original");
  await vi.waitFor(() => expect(fixture.signals).toHaveLength(1));
  link.callbacks.candidate(link.sessionId, {
    candidate: "candidate:1 1 udp 1 203.0.113.1 1234 typ relay",
  });
  await vi.waitFor(() => expect(fixture.signals).toHaveLength(2), {
    timeout: 1500,
  });
  vi.spyOn(Date, "now").mockReturnValue(issuedAt + 14_000);
  await controller.tick();
  await vi.waitFor(
    () =>
      expect(fixture.signals.filter((s) => s[2].type === "ice")).toHaveLength(
        2,
      ),
    { timeout: 1500 },
  );
  const ice = fixture.signals.filter((s) => s[2].type === "ice");
  expect(ice[0][2]).toEqual(ice[1][2]);
});

it("does not mark replied connection checks as failed at the 25 second warning", async () => {
  const { issuedAt } = await connectedFixture();
  const link = fixture.links[0];
  const initial = link.diagnostics();
  link.diagnostics = () => ({
    ...initial,
    remoteDescription: true,
    iceState: "checking",
    transportState: "connecting",
    remoteCandidateTypes: ["host"],
  });
  vi.spyOn(Date, "now").mockReturnValue(issuedAt + 26_000);
  await controller.tick();
  expect(controller.view.peers[0].connectionError).toBeUndefined();
  expect(fixture.links).toHaveLength(1);
});

it("retains the failed attempt across retries with a bounded redacted history", async () => {
  const { remote } = await connectedFixture();
  const first = fixture.links[0];
  const initial = first.diagnostics();
  first.diagnostics = () => ({ ...initial, iceState: "failed" });
  first.callbacks.error("Route checks failed");
  // A transient later status must not erase the confirmed failure evidence.
  first.diagnostics = () => initial;
  await controller.retryConnections();
  const report = controller.connectionDiagnostics();
  expect(report.schema).toBe("rotab-connectivity-diagnostics-v2");
  expect(report.devices[0].connection?.iceState).toBe("new");
  expect(report.devices[0].history[0]).toMatchObject({
    attempt: 1,
    reason: "manual-retry",
    connection: { iceState: "failed" },
  });
  expect(JSON.stringify(report)).not.toContain(remote.id);
  expect(JSON.stringify(report)).not.toContain(fixture.peerIdentity.id);
  for (let i = 0; i < 5; i++) await controller.retryConnections();
  expect(controller.connectionDiagnostics().devices[0].history).toHaveLength(4);
  expect(controller.view.campaigns[0].attempts).toHaveLength(1);
});

it("exports only the built runtime filename and never a URL or query string", async () => {
  await connectedFixture();
  let src = "chrome-extension://private-profile/assets/index-A1_b-2.js";
  vi.stubGlobal("document", { querySelector: () => ({ src }) });
  try {
    expect(controller.connectionDiagnostics().runtimeBundle).toBe(
      "index-A1_b-2.js",
    );
    src += "?credential=private";
    expect(controller.connectionDiagnostics().runtimeBundle).toBeUndefined();
  } finally {
    vi.unstubAllGlobals();
  }
});
