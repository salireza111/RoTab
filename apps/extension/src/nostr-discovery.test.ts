import { beforeAll, describe, expect, it } from "vitest";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
} from "nostr-tools/pure";
import { ENGINE_ID, SOURCE_SHA } from "@rosettatab/shared";
import {
  generatePeerIdentity,
  signPeerMessage,
  type PeerIdentity,
} from "./peer-protocol";
import {
  checkedNostrEvent,
  decodePresence,
  decryptSignal,
  encryptedSignal,
  encryptedConnectivitySignal,
  networkSettingsSchema,
  defaultNetworkSettings,
  roomTopic,
  NOSTR_PRESENCE_KIND,
  type NostrIdentity,
} from "./nostr-discovery";

let alice: NostrIdentity,
  bob: NostrIdentity,
  roTab: PeerIdentity,
  topic: string;
const now = Date.now();
beforeAll(async () => {
  const a = generateSecretKey(),
    b = generateSecretKey();
  alice = { secret: a, publicKey: getPublicKey(a) };
  bob = { secret: b, publicKey: getPublicKey(b) };
  roTab = await generatePeerIdentity();
  topic = await roomTopic("test-room");
});
async function presence(key = alice.publicKey) {
  return signPeerMessage(roTab, {
    type: "network",
    message: {
      kind: "presence",
      networkVersion: 3,
      nostrPublicKey: key,
      issuedAt: now,
      expiresAt: now + 45_000,
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
      automatic: false,
      available: true,
      campaigns: [
        {
          id: crypto.randomUUID(),
          protocol: "score",
          total: 4,
          waiting: 4,
          completed: 0,
        },
      ],
    },
  });
}
describe("Nostr browser rendezvous", () => {
  it("discovers by default but requires computation opt-in and secure bounded relay settings", () => {
    expect(defaultNetworkSettings.enabled).toBe(true);
    expect(defaultNetworkSettings.automatic).toBe(false);
    expect(networkSettingsSchema.parse(defaultNetworkSettings)).toEqual(
      defaultNetworkSettings,
    );
    for (const relays of [
      ["ws://relay.test"],
      ["https://relay.test"],
      ["wss://user:password@relay.test"],
      ["wss://relay.test?secret=x"],
      [],
      Array(4).fill("wss://relay.test"),
    ])
      expect(() =>
        networkSettingsSchema.parse({ ...defaultNetworkSettings, relays }),
      ).toThrow();
  });
  it("binds persistent RoTab identity, Nostr identity, room and live announcement", async () => {
    const envelope = await presence();
    const event = finalizeEvent(
      {
        kind: NOSTR_PRESENCE_KIND,
        created_at: Math.floor(now / 1000),
        tags: [["t", topic]],
        content: JSON.stringify(envelope),
      },
      alice.secret,
    );
    const checked = checkedNostrEvent(
      JSON.parse(JSON.stringify(event)),
      topic,
      now,
    );
    const peer = await decodePresence(checked, now);
    expect(peer.peerId).toBe(roTab.id);
    expect(peer.nostrPublicKey).toBe(alice.publicKey);
    expect(peer.presence.campaigns[0].waiting).toBe(4);
    expect(JSON.stringify(event)).not.toMatch(/ATOM|HETATM|privateKey|secret/);
    await expect(decodePresence(checked, now + 45_000)).rejects.toThrow(
      /lifetime/,
    );
    const wrongBinding = finalizeEvent(
      { ...event, content: JSON.stringify(await presence(bob.publicKey)) },
      alice.secret,
    );
    await expect(decodePresence(wrongBinding, now)).rejects.toThrow(/binding/);
  });
  it("rejects tampering, wrong rooms, stale events and excessive input before decryption", () => {
    const event = encryptedSignal(
      alice,
      bob.publicKey,
      topic,
      roTab.id,
      "RT1.test-invitation",
      now,
    );
    expect(
      checkedNostrEvent(JSON.parse(JSON.stringify(event)), topic, now).id,
    ).toBe(event.id);
    expect(() =>
      checkedNostrEvent(
        { ...event, content: event.content.slice(0, -2) + "AA" },
        topic,
        now,
      ),
    ).toThrow(/signature/);
    expect(() => checkedNostrEvent(event, "0".repeat(64), now)).toThrow(/room/);
    expect(() => checkedNostrEvent(event, topic, now + 61_000)).toThrow(
      /Stale/,
    );
    expect(() =>
      checkedNostrEvent({ ...event, content: "x".repeat(120_001) }, topic, now),
    ).toThrow();
  });
  it("encrypts connection codes for the intended recipient with authenticated NIP-44", () => {
    const code = "RT1.test-private-connection-code";
    const event = encryptedSignal(
      alice,
      bob.publicKey,
      topic,
      roTab.id,
      code,
      now,
    );
    expect(event.content).not.toContain(code);
    const decoded = decryptSignal(
      checkedNostrEvent(JSON.parse(JSON.stringify(event)), topic, now),
      bob,
      topic,
      now,
    );
    expect(decoded).toMatchObject({
      code,
      senderId: roTab.id,
      recipient: bob.publicKey,
    });
    expect(() => decryptSignal(event, alice, topic, now)).toThrow(/recipient/);
    expect(() => decryptSignal(event, bob, "0".repeat(64), now)).toThrow(
      /binding/,
    );
    expect(() => decryptSignal(event, bob, topic, now + 45_000)).toThrow(
      /lifetime/,
    );
    expect(
      encryptedSignal(alice, bob.publicKey, topic, roTab.id, code, now).content,
    ).not.toBe(event.content);
  });
  it("rejects invalid inner signatures even when the relay envelope is correctly signed", async () => {
    const envelope = await presence();
    envelope.signature = "A".repeat(86);
    const event = finalizeEvent(
      {
        kind: NOSTR_PRESENCE_KIND,
        created_at: Math.floor(now / 1000),
        tags: [["t", topic]],
        content: JSON.stringify(envelope),
      },
      alice.secret,
    );
    await expect(decodePresence(event, now)).rejects.toThrow(/signature/);
  });
});

it("authenticates encrypted late ICE separately from the compatible v1 invitation", () => {
  const update = {
    type: "ice" as const,
    sessionId: crypto.randomUUID(),
    candidates: [
      {
        candidate: "candidate:1 1 udp 123 203.0.113.1 4567 typ relay",
        sdpMid: "0",
        sdpMLineIndex: 0,
      },
    ],
  };
  const event = encryptedConnectivitySignal(
    alice,
    bob.publicKey,
    topic,
    roTab.id,
    update,
    now,
  );
  expect(
    checkedNostrEvent(JSON.parse(JSON.stringify(event)), topic, now).id,
  ).toBe(event.id);
  expect(decryptSignal(event, bob, topic, now)).toMatchObject({
    version: 2,
    update,
    senderId: roTab.id,
  });
  expect(event.content).not.toContain("203.0.113.1");
  expect(() => decryptSignal(event, bob, topic, now + 45_000)).toThrow();
  expect(() =>
    encryptedConnectivitySignal(
      alice,
      bob.publicKey,
      topic,
      roTab.id,
      { ...update, candidates: Array(9).fill(update.candidates[0]) },
      now,
    ),
  ).toThrow();
  expect(() =>
    encryptedConnectivitySignal(
      alice,
      bob.publicKey,
      topic,
      roTab.id,
      { ...update, pdb: "ATOM" } as any,
      now,
    ),
  ).toThrow();
  expect(() =>
    encryptedConnectivitySignal(
      alice,
      bob.publicKey,
      topic,
      roTab.id,
      { type: "result", result: "scientific" } as any,
      now,
    ),
  ).toThrow();
  expect(
    decryptSignal(
      encryptedSignal(
        alice,
        bob.publicKey,
        topic,
        roTab.id,
        "RT1.original",
        now,
      ),
      bob,
      topic,
      now,
    ),
  ).toMatchObject({ version: 1, code: "RT1.original" });
});
