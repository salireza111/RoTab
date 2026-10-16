import { useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Download,
  Pause,
  Play,
  Square,
  Trash2,
} from "lucide-react";
import { PROTOCOLS, validatePdb } from "@rosettatab/shared";
import { campaignCounts, type Campaign } from "./campaign-queue";

const short = (id: string) => id.slice(0, 12);
function download(value: string, name: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
function modelState(campaign: Campaign, attempt: Campaign["attempts"][number]) {
  if (attempt.outcome) return "Complete";
  if (campaign.state === "cancelled") return "Cancelled";
  if (attempt.lease) {
    const progress = attempt.lease.progress;
    if (attempt.lease.expiresAt <= Date.now()) return "Awaiting reassignment";
    return progress
      ? `${progress.state} · ${Math.round(progress.fraction * 100)}%${Date.now() - progress.receivedAt < 25_000 ? "" : " · awaiting update"}`
      : "Assigned · waiting to start";
  }
  return campaign.state === "paused" ? "Paused" : "Queued";
}

function CampaignDetails({
  campaign,
  identityId,
}: {
  campaign: Campaign;
  identityId?: string;
}) {
  const [page, setPage] = useState(0);
  const stats = useMemo(
    () => validatePdb(campaign.input.pdb),
    [campaign.input.pdb],
  );
  const pages = Math.ceil(campaign.models / 20);
  const attempts = campaign.attempts.slice(page * 20, (page + 1) * 20);
  return (
    <>
      <h4>Research description</h4>
      <p className="campaign-description">
        {campaign.description ||
          "No description was provided for this older campaign."}
      </p>
      <dl className="campaign-facts">
        <div>
          <dt>Submitted</dt>
          <dd>
            {new Date(campaign.createdAt).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </dd>
        </div>
        <div>
          <dt>Input structure</dt>
          <dd>
            {stats.residues.toLocaleString()} residues ·{" "}
            {stats.atoms.toLocaleString()} atoms
          </dd>
        </div>
        <div>
          <dt>Model seeds</dt>
          <dd>
            {campaign.seed}
            {campaign.models > 1
              ? `–${campaign.seed + campaign.models - 1}`
              : ""}
          </dd>
        </div>
        <div>
          <dt>This browser participates</dt>
          <dd>{campaign.participateLocal ? "Yes" : "No"}</dd>
        </div>
      </dl>
      <div className="network-actions campaign-downloads">
        <button
          type="button"
          onClick={() =>
            download(
              campaign.input.pdb,
              `${campaign.id}-input.pdb`,
              "chemical/x-pdb",
            )
          }
        >
          <Download size={14} /> Input PDB
        </button>
        <button
          type="button"
          onClick={() =>
            download(
              JSON.stringify(
                {
                  schema: "rotab-campaign-detail-v1",
                  exportedAt: Date.now(),
                  campaign,
                  scientificValidation: "not-verified",
                },
                null,
                2,
              ),
              `${campaign.id}-records.json`,
            )
          }
        >
          <Download size={14} /> Campaign records
        </button>
      </div>
      <h4>Models</h4>
      <div
        className="campaign-model-table"
        tabIndex={0}
        role="region"
        aria-label="Campaign models"
      >
        <table>
          <thead>
            <tr>
              <th>Model / seed</th>
              <th>Status / worker</th>
              <th>Energy</th>
              <th>File</th>
            </tr>
          </thead>
          <tbody>
            {attempts.map((attempt) => {
              const record = attempt.outcome ?? attempt.lease;
              const energy =
                attempt.outcome?.result.models[0].energy ??
                attempt.lease?.progress?.energy;
              return (
                <tr key={attempt.id} data-model-index={attempt.index}>
                  <td>
                    <strong>Model {attempt.index + 1}</strong>
                    <small>Seed {attempt.seed}</small>
                  </td>
                  <td>
                    <span>{modelState(campaign, attempt)}</span>
                    {record && (
                      <small title={record.workerId}>
                        {record.workerId === identityId
                          ? "This browser"
                          : short(record.workerId)}
                      </small>
                    )}
                  </td>
                  <td>
                    {energy === undefined ? "—" : `${energy.toFixed(3)} REU`}
                  </td>
                  <td>
                    {attempt.outcome && (
                      <button
                        type="button"
                        aria-label={`Download model ${attempt.index + 1}`}
                        onClick={() =>
                          download(
                            attempt.outcome!.result.models[0].pdb,
                            `${campaign.id}-model-${attempt.index + 1}.pdb`,
                            "chemical/x-pdb",
                          )
                        }
                      >
                        <Download size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 && (
        <nav className="campaign-pagination" aria-label="Model pages">
          <button
            type="button"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            Previous
          </button>
          <span>
            {page + 1} / {pages}
          </span>
          <button
            type="button"
            disabled={page + 1 === pages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      )}
      {campaign.attempts.some((attempt) => attempt.outcome) && (
        <p className="network-disclosure">
          Returned energies and structures are not independently verified.
        </p>
      )}
      <details className="campaign-provenance">
        <summary>Scientific provenance</summary>
        <dl className="campaign-facts">
          <div>
            <dt>Campaign ID</dt>
            <dd>
              <code>{campaign.id}</code>
            </dd>
          </div>
          <div>
            <dt>Engine</dt>
            <dd>
              <code>{campaign.engine.id}</code>
            </dd>
          </div>
          <div>
            <dt>Source commit</dt>
            <dd>
              <code>{campaign.engine.sourceSha}</code>
            </dd>
          </div>
          <div>
            <dt>Input SHA-256</dt>
            <dd>
              <code>{campaign.input.sha256}</code>
            </dd>
          </div>
        </dl>
      </details>
    </>
  );
}

export function CampaignCard({
  campaign: c,
  identityId,
  ready,
  onState,
  onRemove,
}: {
  campaign: Campaign;
  identityId?: string;
  ready: boolean;
  onState(state: "active" | "paused" | "cancelled"): void;
  onRemove(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const removeButton = useRef<HTMLButtonElement>(null);
  const counts = campaignCounts(c),
    detailsId = `campaign-details-${c.id}`;
  return (
    <article
      className="network-campaign"
      data-campaign-id={c.id}
      data-completed={counts.completed}
    >
      <button
        type="button"
        className="network-campaign-open"
        aria-label={`View details for ${c.title}`}
        aria-expanded={expanded}
        aria-controls={detailsId}
        onClick={() => setExpanded(!expanded)}
      >
        <span className="campaign-heading">
          <span>
            <strong>{c.title}</strong>
            <span className="campaign-subtitle">
              {PROTOCOLS.find((p) => p.id === c.protocol)?.label} · {c.state}
            </span>
          </span>
          <ChevronDown size={18} aria-hidden="true" />
        </span>
        <progress value={counts.completed} max={counts.total} />
        <span className="network-counts">
          <span>
            {counts.completed}/{counts.total} complete
          </span>
          <span>
            {counts.assigned} assigned · {counts.waiting}{" "}
            {c.state === "cancelled" ? "unfinished" : "queued"}
          </span>
        </span>
      </button>
      <ul className="campaign-workers" aria-label="Model activity">
        {c.attempts
          .filter((a) => a.lease || a.outcome)
          .slice(-8)
          .map((attempt) => {
            const record = attempt.outcome ?? attempt.lease!;
            const progress = attempt.lease?.progress;
            const fresh = progress && Date.now() - progress.receivedAt < 25_000;
            const energy =
              attempt.outcome?.result.models[0].energy ?? progress?.energy;
            return (
              <li
                key={attempt.id}
                data-attempt-index={attempt.index}
                data-worker-id={record.workerId}
              >
                <div>
                  <strong>Model {attempt.index + 1}</strong>
                  <span>
                    {record.workerId === identityId
                      ? "This browser"
                      : short(record.workerId)}
                  </span>
                </div>
                <div>
                  <span
                    className="network-dot"
                    data-state={
                      attempt.outcome
                        ? "live"
                        : fresh && progress.state === "running"
                          ? "working"
                          : "idle"
                    }
                  />
                  <span>{modelState(c, attempt)}</span>
                  {energy !== undefined && (
                    <small>{energy.toFixed(2)} REU</small>
                  )}
                </div>
                {progress && !attempt.outcome && (
                  <progress max={1} value={progress.fraction} />
                )}
              </li>
            );
          })}
      </ul>
      <div className="network-actions">
        {["active", "paused"].includes(c.state) && (
          <>
            <button
              type="button"
              aria-label={
                c.state === "paused" ? "Resume campaign" : "Pause campaign"
              }
              disabled={!ready}
              onClick={() =>
                onState(c.state === "paused" ? "active" : "paused")
              }
            >
              {c.state === "paused" ? <Play size={15} /> : <Pause size={15} />}
            </button>
            <button
              type="button"
              aria-label="Cancel campaign"
              disabled={!ready}
              onClick={() => onState("cancelled")}
            >
              <Square size={15} />
            </button>
          </>
        )}
        <button
          type="button"
          className="campaign-remove"
          ref={removeButton}
          aria-label={`Remove campaign ${c.title}`}
          disabled={!ready || removing}
          onClick={() => setRemoving(true)}
        >
          <Trash2 size={14} /> Remove
        </button>
      </div>
      {removing && (
        <div
          className="campaign-remove-confirm"
          role="group"
          aria-label={`Confirm removal of ${c.title}`}
        >
          <p>
            Remove this campaign and its saved results? New assignments stop.
            Models already running may finish, but their returns will be
            discarded.
          </p>
          <div className="network-actions">
            <button
              type="button"
              autoFocus
              disabled={!ready}
              onClick={() => {
                setRemoving(false);
                setTimeout(() => removeButton.current?.focus(), 0);
              }}
            >
              Keep campaign
            </button>
            <button
              type="button"
              className="campaign-remove"
              disabled={!ready}
              onClick={onRemove}
            >
              Remove campaign
            </button>
          </div>
        </div>
      )}
      <section
        id={detailsId}
        className="campaign-details"
        aria-label={`Details for ${c.title}`}
        hidden={!expanded}
      >
        {expanded && <CampaignDetails campaign={c} identityId={identityId} />}
      </section>
    </article>
  );
}
