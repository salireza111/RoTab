import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { ENGINE_ID, SOURCE_SHA, type EngineManifest } from "@rosettatab/shared";
import {
  generatePeerIdentity,
  signPeerMessage,
  peerSha256,
  type PeerEngine,
  type PeerResult,
} from "./peer-protocol";
import {
  CAMPAIGN_LEASE_MS,
  VOLUNTEER_PRESENCE_MS,
  CampaignQueue,
  campaignCounts,
  type Assignment,
  type CampaignStore,
  type VolunteerPresence,
} from "./campaign-queue";

// Coordinate/energy fixtures test accounting only, not Rosetta execution.
const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
const engine: PeerEngine = {
  id: ENGINE_ID,
  sourceSha: SOURCE_SHA,
  hashes: {
    "rosetta.mjs": "a".repeat(64),
    "rosetta.wasm": "b".repeat(64),
    "rosetta.data": "c".repeat(64),
  },
};
const manifest: EngineManifest = {
  ...engine,
  verified: true,
  module: "rosetta.mjs",
  database: "rosetta.data",
  reason: "Accounting test fixture only",
  supportedProtocols: ["score", "relax"],
};
const publisher = "1".repeat(64),
  alice = "2".repeat(64),
  bob = "3".repeat(64);
let input: { pdb: string; sha256: string };
beforeAll(async () => {
  input = { pdb, sha256: await peerSha256(pdb) };
});

function setup() {
  let now = 1_800_000_000_000;
  let saved: unknown;
  let failWrite = false;
  const store: CampaignStore = {
    read: async () => structuredClone(saved),
    write: async (value) => {
      if (failWrite) throw new Error("Storage full");
      saved = structuredClone(value);
    },
  };
  const queue = new CampaignQueue(publisher, manifest, store, () => now);
  const volunteer = (id = alice): VolunteerPresence => ({
    id,
    seenAt: now,
    automatic: true,
    available: true,
    engine: structuredClone(engine),
    protocols: ["score", "relax"],
  });
  const submit = (models = 3) =>
    queue.submit({
      title: "Trp-cage",
      description: "Compare independent Trp-cage models.",
      protocol: "score",
      seed: 17,
      models,
      input,
    });
  const result = (assignment: Assignment): PeerResult => ({
    id: crypto.randomUUID(),
    jobId: assignment.lease.job.id,
    inputSha256: input.sha256,
    engine: structuredClone(engine),
    completedAt: now,
    models: [
      {
        modelIndex: 0,
        seed: assignment.lease.job.seed,
        protocol: "score",
        pdb,
        sha256: input.sha256,
        energy: -48.1,
        elapsedMs: 1_000,
        history: [-48.1],
      },
    ],
  });
  const complete = (a: Assignment, r = result(a), worker = a.lease.workerId) =>
    queue.complete(worker, a.campaignId, a.attemptId, a.lease.token, r);
  return {
    queue,
    store,
    volunteer,
    submit,
    result,
    complete,
    tick: (ms: number) => {
      now += ms;
    },
    now: () => now,
    saved: () => structuredClone(saved),
    fail: (value: boolean) => {
      failWrite = value;
    },
  };
}

describe("publisher-owned browser campaign queue", () => {
  it("submits without a connection and persists stable independent attempts", async () => {
    const s = setup(),
      campaign = await s.submit(7);
    expect(campaignCounts(campaign)).toEqual({
      total: 7,
      completed: 0,
      assigned: 0,
      waiting: 7,
    });
    expect(campaign.attempts.map((a) => a.seed)).toEqual([
      17, 18, 19, 20, 21, 22, 23,
    ]);
    expect(new Set(campaign.attempts.map((a) => a.id)).size).toBe(7);
    const restored = new CampaignQueue(publisher, manifest, s.store, s.now);
    await restored.initialize();
    expect(restored.campaigns).toEqual(s.queue.campaigns);
    campaign.attempts[0].seed = 999;
    expect(s.queue.campaigns[0].attempts[0].seed).toBe(17);
  });
  it("keeps legacy records readable but does not assign undocumented campaigns", async () => {
    const s = setup();
    await s.submit(1);
    const legacy = s.saved() as any;
    delete legacy.campaigns[0].description;
    await s.store.write(legacy);
    const restored = new CampaignQueue(publisher, manifest, s.store, s.now);
    await restored.initialize();
    expect(restored.campaigns).toHaveLength(1);
    expect(await restored.assign([s.volunteer()])).toEqual([]);
    expect(restored.campaigns[0].description).toBeUndefined();
  });
  it("validates coordinates, hashes, seed range, model budget and measured engine before saving", async () => {
    const s = setup();
    for (const bad of [
      { description: "" },
      { description: "   " },
      { description: "a".repeat(241) },
      { models: 0 },
      { models: 1_001 },
      { models: Infinity },
      { seed: 2_000_000_000 },
      { input: { pdb, sha256: "0".repeat(64) } },
    ]) {
      await expect(
        s.queue.submit({
          title: "Target",
          description: "Compare independent Trp-cage models.",
          protocol: "score",
          models: 2,
          seed: 17,
          input,
          ...bad,
        }),
      ).rejects.toThrow();
      expect(s.queue.campaigns).toEqual([]);
    }
    const unverified = new CampaignQueue(
      publisher,
      { ...manifest, verified: false },
      s.store,
      s.now,
    );
    await expect(
      unverified.submit({
        title: "Target",
        description: "Compare independent Trp-cage models.",
        protocol: "score",
        models: 1,
        seed: 17,
        input,
      }),
    ).rejects.toThrow(/unverified/);
    expect(s.saved()).toBeUndefined();
  });
  it("assigns automatically to two distinct eligible volunteers, each receiving one model", async () => {
    const s = setup();
    await s.submit(5);
    const assignments = await s.queue.assign([
      s.volunteer(),
      s.volunteer(),
      s.volunteer(bob),
    ]);
    expect(assignments).toHaveLength(2);
    expect(assignments.map((a) => a.lease.workerId)).toEqual([alice, bob]);
    expect(assignments.map((a) => a.lease.job.seed)).toEqual([17, 18]);
    expect(assignments.every((a) => a.lease.job.models === 1)).toBe(true);
    expect(
      assignments.every(
        (a) =>
          a.lease.job.description === "Compare independent Trp-cage models.",
      ),
    ).toBe(true);
    expect(await s.queue.assign([s.volunteer(), s.volunteer(bob)])).toEqual([]);
    expect(campaignCounts(s.queue.campaigns[0], s.now())).toEqual({
      total: 5,
      completed: 0,
      assigned: 2,
      waiting: 3,
    });
  });
  it("excludes opted-out, busy, stale, incompatible and own-identity browsers", async () => {
    const s = setup();
    await s.submit();
    for (const candidate of [
      { ...s.volunteer(), automatic: false },
      { ...s.volunteer(), available: false },
      { ...s.volunteer(), seenAt: s.now() - VOLUNTEER_PRESENCE_MS },
      { ...s.volunteer(), seenAt: s.now() + 1 },
      { ...s.volunteer(), protocols: [] },
      {
        ...s.volunteer(),
        engine: {
          ...engine,
          hashes: { ...engine.hashes, "rosetta.wasm": "d".repeat(64) },
        },
      },
      s.volunteer(publisher),
    ])
      expect(await s.queue.assign([candidate])).toEqual([]);
  });
  it("serializes competing scheduling calls and reserves a worker across campaigns", async () => {
    const s = setup();
    await Promise.all([s.submit(1), s.submit(1)]);
    const [a, b] = await Promise.all([
      s.queue.assign([s.volunteer()]),
      s.queue.assign([s.volunteer()]),
    ]);
    expect(a).toHaveLength(1);
    expect(b).toEqual([]);
    expect(
      s.queue.campaigns.flatMap((c) => c.attempts).filter((a) => a.lease),
    ).toHaveLength(1);
  });
  it("distributes one of four attempts to the publisher and each ready volunteer when locally opted in", async () => {
    const s = setup();
    const campaign = await s.queue.submit({
      title: "Shared target",
      description: "Compare independent models.",
      protocol: "score",
      seed: 17,
      models: 4,
      input,
      participateLocal: true,
    });
    const assignments = await s.queue.assign([
      s.volunteer(publisher),
      s.volunteer(alice),
      s.volunteer(bob),
    ]);
    expect(assignments.map((a) => a.lease.workerId)).toEqual([
      publisher,
      alice,
      bob,
    ]);
    expect(new Set(assignments.map((a) => a.attemptId)).size).toBe(3);
    expect(campaignCounts(s.queue.campaigns[0], s.now())).toMatchObject({
      assigned: 3,
      waiting: 1,
    });
    await s.complete(assignments[0]);
    const next = await s.queue.assign(
      [s.volunteer(publisher), s.volunteer(alice), s.volunteer(bob)],
      campaign.id,
    );
    expect(next).toHaveLength(1);
    expect(next[0].lease.workerId).toBe(publisher);
    expect(next[0].lease.job.seed).toBe(20);
  });
  it("binds live progress to a current authenticated lease and ignores older telemetry", async () => {
    const s = setup();
    await s.submit(1);
    const [a] = await s.queue.assign([s.volunteer()]);
    const progress = {
      state: "running" as const,
      fraction: 0.4,
      snapshots: 3,
      elapsedMs: 8_000,
      energy: -42,
    };
    expect(
      await s.queue.renew(
        bob,
        a.campaignId,
        a.attemptId,
        a.lease.token,
        progress,
      ),
    ).toBe(false);
    expect(
      await s.queue.renew(
        alice,
        a.campaignId,
        a.attemptId,
        crypto.randomUUID(),
        progress,
      ),
    ).toBe(false);
    expect(s.queue.campaigns[0].attempts[0].lease?.progress).toBeUndefined();
    expect(
      await s.queue.renew(
        alice,
        a.campaignId,
        a.attemptId,
        a.lease.token,
        progress,
      ),
    ).toBe(true);
    expect(s.queue.campaigns[0].attempts[0].lease?.progress).toEqual({
      ...progress,
      receivedAt: s.now(),
    });
    await s.queue.renew(alice, a.campaignId, a.attemptId, a.lease.token, {
      ...progress,
      fraction: 0.1,
      elapsedMs: 100,
    });
    expect(s.queue.campaigns[0].attempts[0].lease?.progress?.fraction).toBe(
      0.4,
    );
    await expect(
      s.queue.renew(alice, a.campaignId, a.attemptId, a.lease.token, {
        ...progress,
        fraction: 2,
      }),
    ).rejects.toThrow();
    s.tick(CAMPAIGN_LEASE_MS + 1);
    expect(
      await s.queue.renew(
        alice,
        a.campaignId,
        a.attemptId,
        a.lease.token,
        progress,
      ),
    ).toBe(true);
  });
  it("scopes an explicit request to the selected campaign", async () => {
    const s = setup(),
      requested = await s.submit(1),
      other = await s.submit(1);
    const [assignment] = await s.queue.assign([s.volunteer()], requested.id);
    expect(assignment.campaignId).toBe(requested.id);
    expect(
      s.queue.campaigns.find((c) => c.id === other.id)!.attempts[0].lease,
    ).toBeUndefined();
    expect(
      await s.queue.assign([s.volunteer(bob)], crypto.randomUUID()),
    ).toEqual([]);
  });
  it("persists the worker's signed result and rejects altered assignment or output proofs", async () => {
    const s = setup(),
      identity = await generatePeerIdentity();
    await s.submit(1);
    const [assignment] = await s.queue.assign([s.volunteer(identity.id)]),
      result = s.result(assignment);
    const message = {
      kind: "result" as const,
      campaignId: assignment.campaignId,
      attemptId: assignment.attemptId,
      leaseToken: assignment.lease.token,
      result,
    };
    for (const altered of [
      { ...message, leaseToken: crypto.randomUUID() },
      {
        ...message,
        result: { ...result, models: [{ ...result.models[0], energy: 1 }] },
      },
    ]) {
      const proof = await signPeerMessage(identity, {
        type: "network",
        message: altered,
      });
      await expect(
        s.queue.complete(
          identity.id,
          assignment.campaignId,
          assignment.attemptId,
          assignment.lease.token,
          result,
          proof,
        ),
      ).rejects.toThrow(/differs/);
    }
    const proof = await signPeerMessage(identity, { type: "network", message });
    await s.queue.complete(
      identity.id,
      assignment.campaignId,
      assignment.attemptId,
      assignment.lease.token,
      result,
      proof,
    );
    const restored = new CampaignQueue(publisher, manifest, s.store, s.now);
    await restored.initialize();
    expect(restored.campaigns[0].attempts[0].outcome?.signedResult).toEqual(
      proof,
    );
    const corrupted: any = s.saved();
    corrupted.campaigns[0].attempts[0].outcome.signedResult.payload.message
      .result.models[0].energy++;
    await expect(
      new CampaignQueue(
        publisher,
        manifest,
        { ...s.store, read: async () => corrupted },
        s.now,
      ).initialize(),
    ).rejects.toThrow();
  });
  it("renews only the current token, including a delayed heartbeat before reassignment", async () => {
    const s = setup();
    await s.submit(1);
    const [a] = await s.queue.assign([s.volunteer()]);
    s.tick(50_000);
    expect(
      await s.queue.renew(bob, a.campaignId, a.attemptId, a.lease.token),
    ).toBe(false);
    expect(
      await s.queue.renew(
        alice,
        a.campaignId,
        a.attemptId,
        crypto.randomUUID(),
      ),
    ).toBe(false);
    expect(
      await s.queue.renew(alice, a.campaignId, a.attemptId, a.lease.token),
    ).toBe(true);
    s.tick(CAMPAIGN_LEASE_MS);
    expect(
      await s.queue.renew(alice, a.campaignId, a.attemptId, a.lease.token),
    ).toBe(true);
  });
  it("receipts a late valid result while its token is still current, including after reload", async () => {
    const s = setup();
    await s.submit(1);
    const [a] = await s.queue.assign([s.volunteer()]);
    s.tick(CAMPAIGN_LEASE_MS + 5_000);
    const restored = new CampaignQueue(publisher, manifest, s.store, s.now);
    await restored.initialize();
    const result = s.result(a);
    expect(
      (
        await restored.complete(
          alice,
          a.campaignId,
          a.attemptId,
          a.lease.token,
          result,
        )
      ).status,
    ).toBe("received");
    expect(
      (
        await restored.complete(
          alice,
          a.campaignId,
          a.attemptId,
          a.lease.token,
          result,
        )
      ).status,
    ).toBe("received");
  });
  it("reassigns abandoned work with the same seed/attempt and a fresh job/token", async () => {
    const s = setup();
    await s.submit(1);
    const [a] = await s.queue.assign([s.volunteer()]);
    s.tick(CAMPAIGN_LEASE_MS);
    const [b] = await s.queue.assign([s.volunteer(bob)]);
    expect(b.attemptId).toBe(a.attemptId);
    expect(b.lease.job.seed).toBe(a.lease.job.seed);
    expect(b.lease.token).not.toBe(a.lease.token);
    expect(b.lease.job.id).not.toBe(a.lease.job.id);
    expect((await s.complete(a)).status).toBe("obsolete");
    expect((await s.complete(b)).status).toBe("received");
    expect(campaignCounts(s.queue.campaigns[0], s.now()).completed).toBe(1);
  });
  it("accepts exact retry once, returns a stable receipt and rejects conflicting content", async () => {
    const s = setup();
    await s.submit(1);
    const [a] = await s.queue.assign([s.volunteer()]),
      result = s.result(a);
    const first = await s.complete(a, result);
    expect(await s.complete(a, result)).toEqual(first);
    await expect(
      s.complete(a, {
        ...result,
        models: [{ ...result.models[0], energy: 999 }],
      }),
    ).rejects.toThrow(/different result/);
    expect((await s.complete(a, result, bob)).status).toBe("obsolete");
    expect(s.queue.campaigns[0].state).toBe("complete");
    expect(s.queue.campaigns[0].attempts[0].outcome?.scientificValidation).toBe(
      "not-verified",
    );
  });
  it("validates output identity, engine, seed, protocol, hashes and cardinality", async () => {
    const s = setup();
    await s.submit(1);
    const [a] = await s.queue.assign([s.volunteer()]),
      valid = s.result(a);
    for (const bad of [
      { ...valid, jobId: crypto.randomUUID() },
      { ...valid, inputSha256: "0".repeat(64) },
      {
        ...valid,
        engine: {
          ...engine,
          hashes: { ...engine.hashes, "rosetta.data": "d".repeat(64) },
        },
      },
      { ...valid, models: [{ ...valid.models[0], seed: 99 }] },
      {
        ...valid,
        models: [{ ...valid.models[0], protocol: "relax" as const }],
      },
      { ...valid, models: [{ ...valid.models[0], sha256: "0".repeat(64) }] },
      { ...valid, models: [valid.models[0], valid.models[0]] },
    ])
      await expect(s.complete(a, bad)).rejects.toThrow();
    expect(s.queue.campaigns[0].attempts[0].outcome).toBeUndefined();
    expect((await s.complete(a, valid)).status).toBe("received");
  });
  it("keeps late results obsolete across reload and accepts current delivery after reload", async () => {
    const s = setup();
    await s.submit(1);
    const [a] = await s.queue.assign([s.volunteer()]);
    const restored = new CampaignQueue(publisher, manifest, s.store, s.now);
    await restored.initialize();
    const result = s.result(a);
    expect(
      (
        await restored.complete(
          alice,
          a.campaignId,
          a.attemptId,
          a.lease.token,
          result,
        )
      ).status,
    ).toBe("received");
    const again = new CampaignQueue(publisher, manifest, s.store, s.now);
    await again.initialize();
    expect(await again.exportRecords()).toMatchObject({
      scientificValidation: "not-verified",
      campaigns: [{ state: "complete" }],
    });
    expect(
      (
        await again.complete(
          alice,
          a.campaignId,
          a.attemptId,
          a.lease.token,
          result,
        )
      ).status,
    ).toBe("received");
  });
  it("pauses new assignments while preserving running work; cancellation fences its results", async () => {
    const s = setup(),
      campaign = await s.submit(2);
    const [a] = await s.queue.assign([s.volunteer()]);
    await s.queue.setState(campaign.id, "paused");
    expect(await s.queue.assign([s.volunteer(bob)])).toEqual([]);
    expect(
      await s.queue.renew(alice, a.campaignId, a.attemptId, a.lease.token),
    ).toBe(true);
    expect((await s.complete(a)).status).toBe("received");
    await s.queue.setState(campaign.id, "active");
    const [b] = await s.queue.assign([s.volunteer(bob)]);
    await s.queue.setState(campaign.id, "cancelled");
    expect(s.queue.retiredWorkerIds).toContain(bob);
    expect((await s.complete(b)).status).toBe("obsolete");
    await expect(s.queue.setState(campaign.id, "active")).rejects.toThrow(
      /finished/,
    );
    await s.queue.remove(campaign.id);
    expect(s.queue.campaigns).toEqual([]);
    expect(s.queue.retiredWorkerIds).toContain(bob);
  });
  it("releases only the matching lease and never removes a running campaign", async () => {
    const s = setup(),
      campaign = await s.submit(1);
    const [a] = await s.queue.assign([s.volunteer()]);
    expect(
      await s.queue.release(bob, a.campaignId, a.attemptId, a.lease.token),
    ).toBe(false);
    expect(
      await s.queue.release(alice, a.campaignId, a.attemptId, a.lease.token),
    ).toBe(true);
    expect(campaignCounts(s.queue.campaigns[0], s.now()).waiting).toBe(1);
    await expect(s.queue.remove(campaign.id)).rejects.toThrow(/finished/);
  });
  it("withdraws explicitly removed active campaigns and acknowledges delayed returns after reload", async () => {
    const s = setup(),
      campaign = await s.submit(2);
    const [first, second] = await s.queue.assign([
      s.volunteer(),
      s.volunteer(bob),
    ]);
    await s.complete(first);
    const delayed = s.result(second);
    await s.queue.remove(campaign.id, { cancelActive: true });
    expect(s.queue.campaigns).toEqual([]);
    expect((s.saved() as any).campaigns).toEqual([]);
    expect(s.queue.retiredWorkerIds).toEqual([alice, bob]);
    expect(await s.queue.assign([s.volunteer(), s.volunteer(bob)])).toEqual([]);
    expect(
      await s.queue.renew(
        bob,
        second.campaignId,
        second.attemptId,
        second.lease.token,
      ),
    ).toBe(false);
    const restored = new CampaignQueue(publisher, manifest, s.store, s.now);
    await restored.initialize();
    expect(restored.retiredWorkerIds).toEqual([alice, bob]);
    expect(
      await restored.complete(
        bob,
        second.campaignId,
        second.attemptId,
        second.lease.token,
        delayed,
      ),
    ).toMatchObject({ status: "obsolete", resultId: delayed.id });
    expect(((await restored.exportRecords()) as any).campaigns).toEqual([]);
  });
  it("keeps running work and saved results intact when removal cannot be persisted", async () => {
    const s = setup(),
      campaign = await s.submit(2);
    const [first, second] = await s.queue.assign([
      s.volunteer(),
      s.volunteer(bob),
    ]);
    await s.complete(first);
    const before = s.queue.campaigns;
    s.fail(true);
    await expect(
      s.queue.remove(campaign.id, { cancelActive: true }),
    ).rejects.toThrow(/Storage full/);
    expect(s.queue.campaigns).toEqual(before);
    s.fail(false);
    expect((await s.complete(second)).status).toBe("received");
  });
  it("does not expose leases or count results until durable storage succeeds", async () => {
    const s = setup();
    s.fail(true);
    await expect(s.submit(1)).rejects.toThrow(/Storage full/);
    expect(s.queue.campaigns).toEqual([]);
    s.fail(false);
    await s.submit(1);
    s.fail(true);
    await expect(s.queue.assign([s.volunteer()])).rejects.toThrow(
      /Storage full/,
    );
    expect(s.queue.campaigns[0].attempts[0].lease).toBeUndefined();
    s.fail(false);
    const [a] = await s.queue.assign([s.volunteer()]);
    s.fail(true);
    await expect(s.complete(a)).rejects.toThrow(/Storage full/);
    expect(s.queue.campaigns[0].attempts[0].outcome).toBeUndefined();
  });
  it("rejects swapped identities and tampered stored completion/input/seed records", async () => {
    const s = setup();
    await s.submit(1);
    const [a] = await s.queue.assign([s.volunteer()]);
    await s.complete(a);
    await expect(
      new CampaignQueue(bob, manifest, s.store, s.now).initialize(),
    ).rejects.toThrow(/different browser identity/);
    for (const alter of [
      (ledger: any) => {
        ledger.campaigns[0].attempts[0].seed++;
      },
      (ledger: any) => {
        ledger.campaigns[0].input.sha256 = "0".repeat(64);
      },
      (ledger: any) => {
        ledger.campaigns[0].attempts[0].outcome.result.models[0].energy++;
      },
      (ledger: any) => {
        ledger.campaigns[0].state = "active";
      },
    ]) {
      const corrupted = s.saved();
      alter(corrupted);
      await expect(
        new CampaignQueue(
          publisher,
          manifest,
          { ...s.store, read: async () => corrupted },
          s.now,
        ).initialize(),
      ).rejects.toThrow();
    }
  });
  it("preserves historical records after an engine update but does not assign them", async () => {
    const s = setup();
    await s.submit(1);
    const upgraded = new CampaignQueue(
      publisher,
      {
        ...manifest,
        hashes: { ...engine.hashes, "rosetta.wasm": "d".repeat(64) },
      },
      s.store,
      s.now,
    );
    await upgraded.initialize();
    expect(upgraded.campaigns).toHaveLength(1);
    expect(await upgraded.assign([s.volunteer()])).toEqual([]);
    expect(await upgraded.exportRecords()).toMatchObject({
      campaigns: [{ engine }],
    });
  });
});
