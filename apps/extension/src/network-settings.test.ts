import { describe, expect, it } from "vitest";
import { bundledTurnSchema, resolveNetworkSettings } from "./network-settings";

const fallback = {
  stun: "stun:relay.test:80",
  turn: "turns:relay.test:443?transport=tcp",
  turnUsername: "fixture-user",
  turnCredential: "fixture-access",
};
describe("bundled pilot TURN defaults", () => {
  it("configures fresh installations without authorizing computation", () => {
    expect(resolveNetworkSettings(undefined, fallback)).toMatchObject({
      ...fallback,
      enabled: true,
      automatic: false,
      bundledTurnApplied: true,
    });
  });
  it("upgrades missing TURN without changing room, relays, or disabled discovery", () => {
    const saved = {
      ...resolveNetworkSettings(undefined),
      enabled: false,
      automatic: false,
      room: "private-test-room",
      relays: ["wss://relay.test"],
    };
    const resolved = resolveNetworkSettings(saved, fallback);
    expect(resolved).toMatchObject({
      ...saved,
      ...fallback,
      bundledTurnApplied: true,
    });
    expect(saved.turn).toBeUndefined();
  });
  it("preserves an existing custom TURN service and STUN configuration", () => {
    const saved = {
      ...resolveNetworkSettings(undefined),
      stun: "",
      turn: "turn:custom.test:3478",
      turnUsername: "custom-user",
      turnCredential: "custom-access",
    };
    expect(resolveNetworkSettings(saved, fallback)).toEqual({
      ...saved,
      bundledTurnApplied: true,
    });
  });
  it("does not restore a bundled relay deliberately cleared by its user", () => {
    const saved = {
      ...resolveNetworkSettings(undefined, fallback),
      turn: "",
      turnUsername: "",
      turnCredential: "",
    };
    expect(resolveNetworkSettings(saved, fallback)).toEqual(saved);
  });
  it("keeps normal builds without shared access and migrates the legacy room", () => {
    const defaults = resolveNetworkSettings(undefined);
    expect(defaults.turn).toBeUndefined();
    expect(defaults.bundledTurnApplied).toBeUndefined();
    expect(
      resolveNetworkSettings({ ...defaults, room: "rotab-pilot-v2" }, fallback)
        .room,
    ).toBe("rotab-pilot-v3");
  });
  it("rejects incomplete provider access, account fields and malformed endpoints", () => {
    for (const invalid of [
      { ...fallback, turnCredential: "" },
      { ...fallback, apiKey: "not-accepted" },
      { ...fallback, turn: "https://relay.test" },
      { ...fallback, turn: "turns:user:secret@relay.test" },
    ])
      expect(bundledTurnSchema.safeParse(invalid).success).toBe(false);
  });
});
