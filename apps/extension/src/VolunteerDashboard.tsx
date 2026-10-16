import { useEffect, useState } from "react";
import { ArrowUpRight, Network, Settings2 } from "lucide-react";
import { PROTOCOLS, type Snapshot } from "@rosettatab/shared";
import { defaultNetworkSettings } from "./nostr-discovery";
import type { VolunteerNetworkState } from "./useVolunteerNetwork";
import type { VolunteerNetwork } from "./volunteer-network";
import "./volunteer-dashboard.css";
import { tabIndicator } from "./network-status";

export function VolunteerDashboard({
  network,
  owner,
  snapshot,
  unavailable,
  advanced,
  compact = false,
}: {
  network: VolunteerNetworkState;
  owner: boolean;
  snapshot: Snapshot;
  unavailable: boolean;
  advanced(): void;
  compact?: boolean;
}) {
  const settings = network.view?.settings ?? defaultNetworkSettings;
  const [automatic, setAutomatic] = useState(settings.automatic);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => setAutomatic(settings.automatic), [settings.automatic]);
  const ready = !!network.summary && !unavailable && !busy;
  const automaticEnabled = network.summary
    ? network.summary.enabled && network.summary.automatic
    : settings.enabled && automatic;
  const indicator = tabIndicator(snapshot, network.summary, network.error);
  const idle = ["idle", "complete", "error"].includes(snapshot.state);
  const available = (network.view?.peers ?? []).flatMap((peer) =>
    (peer.campaigns ?? [])
      .filter((c) => c.waiting > 0)
      .map((c) => ({ ...c, peer })),
  );
  const perform = async (
    work: (controller: VolunteerNetwork) => Promise<unknown>,
  ) => {
    if (!network.controller || !owner || !ready) return;
    setBusy(true);
    setError("");
    try {
      await work(network.controller);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Could not update volunteering.",
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="volunteer-setup" aria-label="Volunteer setup">
      <div className="volunteer-connection">
        <div
          className="volunteer-connected"
          role="status"
          title={indicator.label}
        >
          <span className="network-dot" data-state={indicator.state} />
          <span>
            {indicator.state === "error"
              ? "Needs attention"
              : indicator.state === "working"
                ? "Computing"
                : indicator.state === "local"
                  ? "Local benchmark"
                  : network.summary?.connected
                    ? "Live"
                    : network.summary?.enabled
                      ? "Connecting…"
                      : "Offline"}
          </span>
          {!compact && (
            <small>
              {network.summary?.observed ?? 0} peers ·{" "}
              {network.summary?.ready ?? 0} ready
            </small>
          )}
        </div>
        <button
          className={automaticEnabled ? "secondary" : "primary"}
          disabled={!ready}
          onClick={() => {
            setBusy(true);
            setError("");
            void network
              .setVolunteering(!automaticEnabled)
              .catch((e) =>
                setError(
                  e instanceof Error
                    ? e.message
                    : "Could not update volunteering.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        >
          <Network size={14} />{" "}
          {automaticEnabled ? "Pause new tasks" : "Start volunteering"}
        </button>
        <button
          className="icon-control"
          aria-label="Volunteer settings"
          title="Volunteer settings"
          onClick={advanced}
        >
          <Settings2 size={15} />
        </button>
      </div>
      {!compact && !owner && (
        <p className="volunteer-status">
          This tab shares the computing tab’s volunteer session.
        </p>
      )}
      {!compact && settings.enabled && idle && (
        <div className="volunteer-available" aria-label="Available research">
          {available.length === 0 ? (
            <p className="volunteer-status">Waiting for a research task…</p>
          ) : (
            available.slice(0, 2).map((c) => (
              <article className="volunteer-project" key={c.peer.id + c.id}>
                <div>
                  <strong>{c.title}</strong>
                  <p className="research-description" title={c.description}>
                    {c.description}
                  </p>
                  <small>
                    {PROTOCOLS.find((p) => p.id === c.protocol)?.label} ·{" "}
                    {c.waiting} models queued
                  </small>
                </div>
                <button
                  className="primary"
                  disabled={!ready || !c.peer.connected}
                  onClick={() =>
                    void perform((n) => n.request(c.peer.id, c.id))
                  }
                >
                  Contribute <ArrowUpRight size={14} />
                </button>
              </article>
            ))
          )}
          {available.length > 2 && (
            <button className="secondary" onClick={advanced}>
              View all research <ArrowUpRight size={13} />
            </button>
          )}
        </div>
      )}
      {!compact && snapshot.taskSource === "peer" && snapshot.peerJobId && (
        <aside className="research-context" aria-label="Research description">
          <div>
            <strong>{snapshot.title}</strong>
            {snapshot.publisherId && (
              <small title={snapshot.publisherId}>
                From {snapshot.publisherId.slice(0, 8)}
              </small>
            )}
          </div>
          {snapshot.description && (
            <p className="research-description" title={snapshot.description}>
              {snapshot.description}
            </p>
          )}
        </aside>
      )}
      {(error || network.error || network.view?.error) && (
        <p className="volunteer-error" role="alert">
          {error || network.error || network.view?.error}
        </p>
      )}
    </div>
  );
}
