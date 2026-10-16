import { expect, it } from "vitest";
import {
  projectNetworkQueue,
  projectQueue,
  queueCounts,
  type QueueView,
} from "./work-queue";
import type { PeerView } from "./peer-collaboration";
import type { NetworkView } from "./volunteer-network";

it("counts only unexpired incoming offers, never published targets or completed work", () => {
  const base = {
    id: "one",
    title: "Target",
    protocol: "score" as const,
    models: 3,
    completed: 0,
    direction: "received" as const,
    status: "offered",
    expiresAt: 200,
    createdAt: 1,
  };
  const view: QueueView = {
    updatedAt: 100,
    connected: true,
    pendingDeliveries: 0,
    jobs: [
      base,
      { ...base, id: "expired", expiresAt: 100 },
      { ...base, id: "outgoing", direction: "sent" },
      { ...base, id: "finished", status: "complete", completed: 3 },
      { ...base, id: "active", status: "running", completed: 1 },
    ],
  };
  expect(queueCounts(view, 100)).toEqual({
    waiting: 1,
    models: 3,
    complete: 1,
    connected: 1,
  });
  expect(queueCounts(view, 201)).toMatchObject({ waiting: 0, models: 0 });
  expect(queueCounts(view, 15_100).connected).toBeUndefined();
  expect(queueCounts(undefined).connected).toBeUndefined();
});
it("projects no target bytes, keys, connection codes, or claimed online volunteers", () => {
  const peer = {
    state: "connected",
    remoteId: "friend",
    jobs: [
      {
        job: {
          id: "job",
          title: "Target",
          protocol: "score",
          models: 2,
          createdAt: 1,
          expiresAt: 300,
          input: { pdb: "private target" },
        },
        direction: "received",
        status: "running",
        progress: { state: "paused", completed: 50 },
        envelope: { signature: "secret" },
      },
    ],
    results: [
      { direction: "sent", delivery: "pending" },
      { direction: "received", delivery: "received" },
    ],
  } as unknown as PeerView;
  const view = projectQueue(peer, 100);
  expect(view).toMatchObject({
    updatedAt: 100,
    connected: true,
    pendingDeliveries: 1,
    jobs: [{ completed: 2, status: "paused" }],
  });
  expect(JSON.stringify(view)).not.toMatch(
    /private target|signature|friend|online/,
  );
  expect(projectQueue({ ...peer, remoteId: undefined }).connected).toBe(false);
});
it("shares network queue metadata without scientific bytes, identities or signed envelopes", () => {
  const view = {
    settings: { enabled: true },
    peers: [
      {
        connected: true,
        nostrPublicKey: "secret-key",
        presence: { expiresAt: 300, automatic: true, available: true },
      },
      {
        connected: false,
        presence: { expiresAt: 99, automatic: true, available: true },
      },
    ],
    campaigns: [
      {
        id: "campaign",
        title: "Published target",
        protocol: "score",
        createdAt: 1,
        state: "active",
        models: 3,
        attempts: [{ outcome: { result: "private output" } }, {}, {}],
      },
    ],
    incoming: [
      {
        status: "complete",
        result: { signature: "private-signature" },
        envelope: {
          payload: {
            type: "network",
            message: {
              kind: "assignment",
              expiresAt: 300,
              job: {
                id: "job",
                title: "Target",
                protocol: "score",
                createdAt: 1,
                input: { pdb: "private input" },
              },
            },
          },
        },
      },
    ],
  } as unknown as NetworkView;
  const projected = projectNetworkQueue(view, 100);
  expect(projected).toMatchObject({
    connected: true,
    pendingDeliveries: 1,
    network: {
      enabled: true,
      observed: 1,
      available: 1,
      remaining: 2,
      completed: 1,
    },
    jobs: [
      {
        id: "campaign",
        completed: 1,
        status: "active",
        direction: "sent",
        active: 0,
      },
      { id: "job", completed: 1, status: "complete" },
    ],
  });
  expect(JSON.stringify(projected)).not.toMatch(
    /private|signature|secret-key|nostrPublicKey/,
  );
});
