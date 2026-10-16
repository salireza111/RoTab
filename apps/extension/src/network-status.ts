import type { Snapshot } from "@rosettatab/shared";
import type { NetworkView } from "./volunteer-network";

/** Metadata only: shared tabs never broadcast uploaded coordinates or keys. */
export interface NetworkSummary {
  updatedAt: number;
  enabled: boolean;
  automatic: boolean;
  connected: boolean;
  connecting: boolean;
  failed: boolean;
  observed: number;
  ready: number;
  error?: string;
}
export function summarizeNetwork(view: NetworkView): NetworkSummary {
  const peers = view.peers.filter((p) => p.presence.expiresAt > Date.now());
  return {
    updatedAt: Date.now(),
    enabled: view.settings.enabled,
    automatic: view.settings.automatic,
    connected:
      peers.some((p) => p.connected) ||
      view.relays.some((r) => r.state === "connected"),
    connecting: view.relays.some((r) => r.state === "connecting"),
    failed:
      !peers.some((p) => p.connected) &&
      view.relays.length > 0 &&
      view.relays.every((r) => ["offline", "rejected"].includes(r.state)),
    observed: peers.length,
    ready: peers.filter(
      (p) => p.connected && p.presence.automatic && p.presence.available,
    ).length,
    ...(view.error ? { error: view.error } : {}),
  };
}
export const INDICATOR_COLORS = {
  live: "#24965b",
  working: "#24965b",
  local: "#d99a15",
  idle: "#8b9097",
  error: "#cf4545",
};
export function tabIndicator(
  snapshot: Snapshot,
  summary?: NetworkSummary,
  error?: string,
) {
  const fresh = summary && Date.now() - summary.updatedAt < 20_000;
  if (
    error ||
    (fresh && summary.error) ||
    snapshot.state === "error" ||
    snapshot.state === "unavailable"
  )
    return { state: "error" as const, label: "Error — open RoTab for details" };
  const working = ["loading", "running", "uploading"].includes(snapshot.state);
  if (working && ["benchmark", "bundled"].includes(snapshot.taskSource ?? ""))
    return { state: "local" as const, label: "Local benchmark running" };
  if (working)
    return { state: "working" as const, label: "Computing a research model" };
  if (fresh && summary.enabled && summary.connected)
    return {
      state: "live" as const,
      label: summary.automatic
        ? "Live — volunteering"
        : "Live — ready to volunteer",
    };
  if (fresh && summary.enabled && summary.failed)
    return { state: "error" as const, label: "Network connection failed" };
  return {
    state: "idle" as const,
    label:
      fresh && summary.enabled
        ? "Connecting to the network…"
        : "Idle — network disconnected",
  };
}
export type TabIndicator = ReturnType<typeof tabIndicator>;
