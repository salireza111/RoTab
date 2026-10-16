import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import {
  NostrDiscovery,
  defaultNetworkSettings,
  type RelayStatus,
} from "./nostr-discovery";
import { generatePeerIdentity, signPeerMessage } from "./peer-protocol";
import { ENGINE_ID, SOURCE_SHA } from "@rosettatab/shared";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  bufferedAmount = 0;
  sent: any[] = [];
  onopen?: () => void;
  onmessage?: (event: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(readonly url: string) {
    Socket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(packet: unknown[]) {
    this.onmessage?.({ data: JSON.stringify(packet) });
  }
  close() {
    this.readyState = 3;
    this.onclose?.();
  }
  get events() {
    return this.sent.filter((p) => p[0] === "EVENT");
  }
}
let discovery: NostrDiscovery;
let statuses: RelayStatus[];
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  statuses = [];
  vi.stubGlobal("WebSocket", Socket);
});
afterEach(() => {
  discovery?.stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function setup() {
  const secret = generateSecretKey();
  const identity = { secret, publicKey: getPublicKey(secret) };
  discovery = new NostrDiscovery(
    identity,
    {
      ...defaultNetworkSettings,
      relays: ["wss://reject.test", "wss://healthy.test"],
    },
    {
      presence: vi.fn(),
      signal: vi.fn(),
      opened: vi.fn(),
      status: (s) => {
        statuses = s;
      },
    },
  );
  await discovery.start();
  const peer = await generatePeerIdentity();
  const announce = async () =>
    discovery.announce(
      await signPeerMessage(peer, {
        type: "network",
        message: {
          kind: "presence",
          networkVersion: 3,
          nostrPublicKey: identity.publicKey,
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
      }),
    );
  return { sockets: Socket.instances, announce, peer };
}
it("isolates rejection, preserves its reason, and retries through a healthy relay", async () => {
  const {
    sockets: [bad, good],
    announce,
    peer,
  } = await setup();
  bad.open();
  good.open();
  expect(statuses.every((s) => s.state === "connecting")).toBe(true);
  await announce();
  const id = bad.events[0][1].id;
  bad.receive(["OK", id, false, "rate-limited: slow down"]);
  good.receive(["OK", id, true, ""]);
  expect(statuses.find((s) => s.url === bad.url)).toMatchObject({
    state: "rejected",
    error: expect.stringContaining("rate-limited: slow down"),
  });
  expect(statuses.find((s) => s.url === good.url)).toMatchObject({
    state: "connected",
    acceptedAt: expect.any(Number),
  });
  const recipient = getPublicKey(generateSecretKey());
  await discovery.signal(recipient, peer.id, "RT1.fixture");
  expect(bad.events).toHaveLength(1);
  expect(good.events).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(16_000);
  expect(bad.events.length).toBeGreaterThan(1);
  // An unrelated OK may not erase a relay rejection.
  bad.receive(["OK", "0".repeat(64), true, ""]);
  expect(statuses.find((s) => s.url === bad.url)?.state).toBe("rejected");
});
it("queues signals before socket open and discards expired ephemeral events", async () => {
  const {
    sockets: [first, second],
    peer,
  } = await setup();
  await discovery.signal(
    getPublicKey(generateSecretKey()),
    peer.id,
    "RT1.private",
  );
  first.open();
  expect(first.events).toHaveLength(1);
  expect(JSON.stringify(first.events)).not.toContain("RT1.private");
  await vi.advanceTimersByTimeAsync(46_000);
  second.open();
  expect(second.events).toHaveLength(0);
});
it("retains only the latest presence for a newly opened relay", async () => {
  const {
    sockets: [first, second],
    announce,
  } = await setup();
  first.open();
  await announce();
  await vi.advanceTimersByTimeAsync(10_000);
  await announce();
  second.open();
  expect(second.events).toHaveLength(1);
  expect(second.events[0][1].id).toBe(first.events.at(-1)[1].id);
  const subscription = second.sent.find((p) => p[0] === "REQ")[1];
  second.receive([
    "CLOSED",
    subscription,
    "blocked: public subscriptions unavailable",
  ]);
  expect(statuses.find((s) => s.url === second.url)?.error).toContain(
    "blocked: public subscriptions unavailable",
  );
  second.receive(["EOSE", subscription]);
  expect(statuses.find((s) => s.url === second.url)?.state).toBe("rejected");
  await vi.advanceTimersByTimeAsync(62_000);
  expect(Socket.instances.filter((s) => s.url === second.url)).toHaveLength(2);
});
