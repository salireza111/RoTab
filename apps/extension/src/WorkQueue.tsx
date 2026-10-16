import { ArrowUpRight, ListOrdered, Network } from "lucide-react";
import { PROTOCOLS, type Snapshot } from "@rosettatab/shared";
import { queueCounts, type QueueView } from "./work-queue";

export function WorkQueue({
  view,
  snapshot,
  now,
  openPeers,
  compact = false,
}: {
  view?: QueueView;
  snapshot: Snapshot;
  now: number;
  openPeers(): void;
  compact?: boolean;
}) {
  const counts = queueCounts(view, now);
  const current =
    snapshot.taskId &&
    !["idle", "complete", "unavailable"].includes(snapshot.state);
  const unfinished = current
    ? Math.max(0, (snapshot.totalModels ?? 1) - (snapshot.completedModels ?? 0))
    : 0;
  const jobs = (view?.jobs ?? [])
    .filter(
      (j) =>
        j.status !== "complete" &&
        j.status !== "cancelled" &&
        j.id !== snapshot.peerJobId,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  const visibleJobs = compact ? jobs.slice(0, current ? 2 : 3) : jobs;
  const remainingJobs = jobs.length - visibleJobs.length;
  return (
    <section
      className={"work-queue" + (compact ? " work-queue-compact" : "")}
      aria-label="Work queue"
    >
      <div className="queue-heading">
        <h2>
          <ListOrdered size={17} /> Work queue
        </h2>
        <button
          onClick={openPeers}
          aria-label="Review queued tasks"
          title="Review queued tasks"
        >
          {!compact && "Review tasks"} <ArrowUpRight size={14} />
        </button>
      </div>
      <div className="queue-stats">
        <div>
          <b>{counts.waiting}</b>
          <span>{compact ? "To review" : "Awaiting approval"}</span>
        </div>
        <div>
          <b>
            {counts.models +
              (view?.jobs.some((j) => j.id === snapshot.peerJobId && j.local)
                ? 0
                : unfinished) +
              (view?.network?.remaining ?? 0)}
          </b>
          <span>{compact ? "Models left" : "Models remaining"}</span>
        </div>
        <div title="Recently observed participants in this room; not a global online-user count.">
          <b>
            {view?.network?.enabled
              ? view.network.observed
              : (counts.connected ?? "—")}
            <Network size={13} />
          </b>
          <span>
            {view?.network?.enabled
              ? compact
                ? "Room peers"
                : "Observed room peers"
              : "Connected peer"}
          </span>
        </div>
      </div>
      <div className="queue-list">
        {current && (
          <div className="queue-item queue-current">
            <i />
            <div>
              <b>{snapshot.title || "Browser calculation"}</b>
              <span>
                {snapshot.state} · {snapshot.completedModels ?? 0}/
                {snapshot.totalModels ?? 1} models
              </span>
            </div>
            <span>Current</span>
          </div>
        )}
        {visibleJobs.map((job, index) => {
          const expired = job.status === "offered" && job.expiresAt <= now;
          return (
            <button key={job.id} className="queue-item" onClick={openPeers}>
              <span className="queue-number">{index + 1}</span>
              <div>
                <b title={job.title}>{job.title}</b>
                <span>
                  {PROTOCOLS.find((p) => p.id === job.protocol)?.label ??
                    job.protocol}{" "}
                  ·{" "}
                  {job.direction === "sent"
                    ? `${job.completed}/${job.models} complete · ${job.active ?? 0} computing`
                    : `${job.models - job.completed} models`}
                </span>
              </div>
              <span>
                {expired
                  ? "Expired"
                  : job.status === "offered"
                    ? "Review"
                    : job.status}
              </span>
            </button>
          );
        })}
        {!current && jobs.length === 0 && (
          <p className="queue-empty">No pending tasks</p>
        )}
      </div>
      <div className="queue-foot">
        <span>
          {compact
            ? `${counts.complete} completed`
            : `This browser · ${counts.complete} peer tasks completed`}
        </span>
        {remainingJobs > 0 && (
          <button onClick={openPeers}>
            +{remainingJobs} more <ArrowUpRight size={12} />
          </button>
        )}
        {!!view?.pendingDeliveries && (
          <span>
            {view.pendingDeliveries}{" "}
            {compact
              ? `result${view.pendingDeliveries === 1 ? "" : "s"} pending`
              : `result ${view.pendingDeliveries === 1 ? "delivery" : "deliveries"} pending`}
          </span>
        )}
      </div>
    </section>
  );
}
