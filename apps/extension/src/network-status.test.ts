import { expect, it } from "vitest";
import { initialSnapshot } from "@rosettatab/shared";
import {
  tabIndicator,
  summarizeNetwork,
  type NetworkSummary,
} from "./network-status";
import { defaultNetworkSettings } from "./nostr-discovery";

it("keeps network presence distinct from real work, local benchmarks, errors and stale tabs", () => {
  const snapshot = initialSnapshot();
  const live: NetworkSummary = {
    updatedAt: Date.now(),
    enabled: true,
    automatic: false,
    connected: true,
    connecting: false,
    failed: false,
    observed: 0,
    ready: 0,
  };
  expect(tabIndicator(snapshot).state).toBe("idle");
  expect(tabIndicator(snapshot, live).state).toBe("live");
  expect(
    tabIndicator(snapshot, { ...live, updatedAt: Date.now() - 25_000 }).state,
  ).toBe("idle");
  expect(
    tabIndicator({ ...snapshot, state: "running", taskSource: "peer" }, live)
      .state,
  ).toBe("working");
  expect(
    tabIndicator(
      { ...snapshot, state: "running", taskSource: "benchmark" },
      live,
    ).state,
  ).toBe("local");
  expect(
    tabIndicator({ ...snapshot, state: "paused", taskSource: "peer" }, live)
      .state,
  ).toBe("live");
  expect(
    tabIndicator(snapshot, { ...live, connected: false, failed: true }).state,
  ).toBe("error");
  expect(tabIndicator({ ...snapshot, state: "error" }, live).state).toBe(
    "error",
  );
});
it("keeps a surviving direct session live when rendezvous relays are unavailable", () => {
  const summary = summarizeNetwork({
    settings: defaultNetworkSettings,
    relays: [{ url: "wss://relay.test", state: "rejected" }],
    peers: [
      {
        id: "a".repeat(64),
        nostrPublicKey: "b".repeat(64),
        seenAt: Date.now(),
        connected: true,
        presence: {
          expiresAt: Date.now() + 45000,
          automatic: true,
          available: true,
        } as any,
      },
    ],
    campaigns: [],
    incoming: [],
  });
  expect(summary.connected).toBe(true);
  expect(summary.failed).toBe(false);
  expect(tabIndicator(initialSnapshot(), summary).state).toBe("live");
});
