import { useEffect, useRef, useState } from "react";
import { Copy, Download, Network, RotateCw, Send, X } from "lucide-react";
import {
  PROTOCOLS,
  type EngineManifest,
  type Protocol,
  type Snapshot,
} from "@rosettatab/shared";
import { Modal } from "./Modal";
import { getState, putState, type Preferences } from "./storage";
import { importProteinFile, type ImportedBenchmark } from "./benchmark";
import { ProteinImportSummary } from "./ProteinImportSummary";
import {
  defaultNetworkSettings,
  type NetworkSettings,
} from "./nostr-discovery";
import { VolunteerNetwork } from "./volunteer-network";
import type { VolunteerNetworkState } from "./useVolunteerNetwork";
import { MAX_CAMPAIGN_DESCRIPTION } from "./peer-protocol";
import { CampaignCard } from "./CampaignCard";
import { checkTurn } from "./turn-check";
import { bundledTurn } from "./network-settings";
import "./network-panel.css";

function download(value: string, name: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const short = (id: string) => id.slice(0, 12);
export function NetworkPanel({
  open,
  close,
  owner,
  manifest,
  network,
  snapshot,
  preferences,
  openDirect,
}: {
  open: boolean;
  close(): void;
  owner: boolean;
  manifest?: EngineManifest;
  network: VolunteerNetworkState;
  snapshot: Snapshot;
  preferences: Preferences;
  openDirect(): void;
}) {
  const { controller, view, error: networkError } = network;
  const campaignsHeading = useRef<HTMLHeadingElement>(null);
  const turnCheck = useRef<AbortController | undefined>(undefined);
  const [turnStatus, setTurnStatus] = useState("");
  const [draft, setDraft] = useState<NetworkSettings>(
    structuredClone(defaultNetworkSettings),
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [description, setDescription] = useState("");
  const [title, setTitle] = useState("Trp-cage campaign"),
    [protocol, setProtocol] = useState<Protocol>(preferences.browserProtocol);
  const [models, setModels] = useState(4),
    [seed, setSeed] = useState(17);
  const [participateLocal, setParticipateLocal] = useState(true);
  const [target, setTarget] = useState<ImportedBenchmark>(),
    [useImported, setUseImported] = useState(false),
    [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (open && view?.identityId) setDraft(view.settings);
  }, [open, controller, view?.identityId]);
  useEffect(() => {
    setTurnStatus("");
    return () => turnCheck.current?.abort();
  }, [open, draft.turn, draft.turnUsername, draft.turnCredential, draft.stun]);
  // A linked tab can change volunteering while this dialog is open.
  useEffect(() => {
    if (view)
      setDraft((current) => ({
        ...current,
        automatic: view.settings.automatic,
      }));
  }, [view?.settings.automatic]);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoaded(false);
    void Promise.all([
      getState<ImportedBenchmark>("network-target-draft"),
      getState<{
        title: string;
        description?: string;
        protocol: Protocol;
        models: number;
        seed: number;
        useImported: boolean;
        participateLocal?: boolean;
      }>("network-publish-options"),
    ])
      .then(([target, options]) => {
        if (!alive) return;
        setTarget(target);
        if (options) {
          setTitle(options.title);
          setDescription(options.description ?? "");
          setProtocol(options.protocol);
          setModels(options.models);
          setSeed(options.seed);
          setUseImported(options.useImported && !!target);
          setParticipateLocal(options.participateLocal !== false);
        } else setUseImported(!!target);
        setLoaded(true);
      })
      .catch(() => setError("The saved target could not be restored."));
    return () => {
      alive = false;
    };
  }, [open]);
  useEffect(() => {
    if (open && owner && loaded)
      void putState("network-publish-options", {
        title,
        description,
        protocol,
        models,
        seed,
        useImported,
        participateLocal,
      }).catch(() => setError("Target settings could not be saved."));
  }, [
    open,
    owner,
    loaded,
    title,
    description,
    protocol,
    models,
    seed,
    useImported,
    participateLocal,
  ]);
  const perform = async (
    work: (active: VolunteerNetwork) => Promise<unknown>,
  ) => {
    if (!controller || busy) return;
    setBusy(true);
    setError("");
    try {
      await work(controller);
    } catch (e) {
      setError(
        e instanceof Error ? e.message.slice(0, 220) : "Network action failed.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (!open) return null;
  const ready = owner && !!view?.identityId && loaded && !busy;
  const peers = view?.peers ?? [];
  const pending =
    view?.incoming.filter((e) => e.result && !e.receipt).length ?? 0;
  return (
    <Modal
      close={close}
      label="Volunteer network"
      confirmDisabled={busy}
      confirm={async () => {
        if (!owner || !controller || !view) {
          close();
          return;
        }
        setBusy(true);
        setError("");
        try {
          await controller.configure({
            ...draft,
            enabled: view.settings.enabled,
          });
          close();
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Could not save network settings.",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <section className="small-modal network-panel">
        <header>
          <h2>
            <Network size={20} /> Volunteer network
          </h2>
          <button aria-label="Close volunteer network" onClick={close}>
            <X size={20} />
          </button>
        </header>
        {!owner ? (
          <div className="network-owner-link">
            <p>This session is managed in the main tab.</p>
            <button
              onClick={() =>
                void network.locateOwner().catch((e) => setError(String(e)))
              }
            >
              Go to main tab
            </button>
          </div>
        ) : !manifest?.verified ? (
          <p>The verified browser engine is unavailable.</p>
        ) : (
          <>
            <div
              className="network-status"
              data-network-enabled={view?.settings.enabled ?? false}
            >
              <span>
                {view?.settings.enabled ? "Nostr network" : "Network offline"}
              </span>
              <span>
                {peers.length} observed ·{" "}
                {peers.filter((p) => p.connected).length} connected
              </span>
            </div>
            <div className="network-identity">
              <span>Participant ID</span>
              <code
                data-participant-id={view?.identityId}
                title={view?.identityId}
              >
                {view?.identityId ? short(view.identityId) : "…"}
              </code>
              <button
                aria-label="Copy participant ID"
                disabled={!view?.identityId}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(view!.identityId!)
                    .catch(() =>
                      setError("Select and copy the participant ID."),
                    )
                }
              >
                <Copy size={14} />
              </button>
            </div>
            <details className="network-advanced">
              <summary>Connection settings</summary>
              <section
                aria-label="Network connection"
                className="network-section"
              >
                <div className="network-row network-connection-row">
                  <label>
                    Room
                    <input
                      aria-label="Network room"
                      value={draft.room}
                      onChange={(e) =>
                        setDraft({ ...draft, room: e.target.value })
                      }
                    />
                  </label>
                  <label className="network-check">
                    <input
                      type="checkbox"
                      aria-label="Continue network tasks automatically"
                      checked={draft.automatic}
                      onChange={(e) =>
                        setDraft({ ...draft, automatic: e.target.checked })
                      }
                    />
                    <span>Continue automatically</span>
                  </label>
                </div>
                <details>
                  <summary>Relay settings</summary>
                  {bundledTurn &&
                    draft.turn === bundledTurn.turn &&
                    draft.turnUsername === bundledTurn.turnUsername &&
                    draft.turnCredential === bundledTurn.turnCredential && (
                      <p className="network-disclosure">
                        Shared pilot TURN is configured. No account or manual
                        setup is needed. The pilot operator supplies relay
                        access; provider availability and quota apply.
                      </p>
                    )}
                  <label>
                    Relays · one secure URL per line
                    <textarea
                      aria-label="Nostr relays"
                      rows={3}
                      value={draft.relays.join("\n")}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          relays: e.target.value
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </label>
                  <label>
                    STUN server
                    <input
                      aria-label="Network STUN server"
                      value={draft.stun}
                      onChange={(e) =>
                        setDraft({ ...draft, stun: e.target.value })
                      }
                    />
                  </label>
                  <label>
                    TURN server · optional, for restrictive networks
                    <input
                      aria-label="Network TURN server"
                      placeholder="turns:your-relay:5349"
                      value={draft.turn ?? ""}
                      onChange={(e) =>
                        setDraft({ ...draft, turn: e.target.value })
                      }
                    />
                  </label>
                  {!!draft.turn && (
                    <div className="network-row">
                      <label>
                        TURN username
                        <input
                          aria-label="Network TURN username"
                          autoComplete="off"
                          value={draft.turnUsername ?? ""}
                          onChange={(e) =>
                            setDraft({ ...draft, turnUsername: e.target.value })
                          }
                        />
                      </label>
                      <label>
                        TURN credential
                        <input
                          aria-label="Network TURN credential"
                          type="password"
                          autoComplete="off"
                          value={draft.turnCredential ?? ""}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              turnCredential: e.target.value,
                            })
                          }
                        />
                      </label>
                    </div>
                  )}
                  <div className="network-actions">
                    <button
                      disabled={
                        !ready ||
                        !draft.turn?.trim() ||
                        !draft.turnUsername ||
                        !draft.turnCredential
                      }
                      onClick={() =>
                        void perform(async () => {
                          const check = new AbortController();
                          turnCheck.current = check;
                          setTurnStatus("Checking TURN relay…");
                          try {
                            const result = await checkTurn(
                              {
                                stun: draft.stun,
                                turn: draft.turn ?? "",
                                username: draft.turnUsername ?? "",
                                credential: draft.turnCredential ?? "",
                              },
                              check.signal,
                            );
                            if (!check.signal.aborted)
                              setTurnStatus(
                                `TURN relay available (${(result.elapsedMs / 1000).toFixed(1)}s). Apply network settings on both devices, then retry connections. This checks relay allocation only.`,
                              );
                          } catch (error) {
                            if (!check.signal.aborted) {
                              setTurnStatus("");
                              throw error;
                            }
                          } finally {
                            if (turnCheck.current === check)
                              turnCheck.current = undefined;
                          }
                        })
                      }
                    >
                      Test TURN
                    </button>
                  </div>
                  {turnStatus && (
                    <p className="network-disclosure" role="status">
                      {turnStatus}
                    </p>
                  )}
                  <details className="network-turn-setup">
                    <summary>Need a TURN service?</summary>
                    <ol>
                      <li>
                        Create a managed TURN account, for example with{" "}
                        <a
                          href="https://www.metered.ca/docs/turn-server-service/creating-turn-credentials/"
                          target="_blank"
                          rel="noreferrer"
                        >
                          Metered
                        </a>
                        . No server installation is needed.
                      </li>
                      <li>
                        In its dashboard, create a TURN credential, then open
                        Get credential → Show ICE servers array.
                      </li>
                      <li>
                        Copy the provided turns: URL using TCP port 443,
                        username and password into the fields above on both
                        devices.
                      </li>
                      <li>
                        Select Test TURN, Apply network settings, then Retry
                        connections under Live devices.
                      </li>
                    </ol>
                    <p>
                      Use generated TURN credentials, never an account password
                      or provider API secret. Provider quotas and charges apply.
                      Newly created credentials may take a few minutes to work.
                    </p>
                  </details>
                  <p className="setting-description">
                    Custom TURN credentials are saved locally and omitted from
                    diagnostics.
                    {bundledTurn &&
                      " This pilot includes shared relay credentials that recipients can extract."}{" "}
                    A TURN operator can see connection metadata; WebRTC data
                    remains encrypted.
                  </p>
                </details>
                <p className="network-disclosure">
                  Relays see your connection metadata, participant presence and
                  work counts. Connection signals are encrypted; protein files
                  and results travel through WebRTC. Room names are public, not
                  passwords.
                </p>
                <div className="network-actions">
                  <button
                    className="primary"
                    disabled={!ready}
                    onClick={() =>
                      void perform((c) =>
                        c.configure({ ...draft, enabled: true }),
                      )
                    }
                  >
                    {view?.settings.enabled
                      ? "Apply network settings"
                      : "Join Nostr network"}
                  </button>
                  {view?.settings.enabled && (
                    <button
                      className="secondary"
                      disabled={!ready}
                      onClick={() =>
                        void perform((c) =>
                          c.configure({ ...view.settings, enabled: false }),
                        )
                      }
                    >
                      Leave network
                    </button>
                  )}
                </div>
                {!!view?.relays.length && (
                  <ul className="network-relays">
                    {view.relays.map((r) => (
                      <li key={r.url}>
                        <span>{new URL(r.url).host}</span>
                        <span title={r.error}>
                          {r.state}
                          {r.acceptedAt ? " · writes accepted" : ""}
                        </span>
                        {r.error && (
                          <small className="network-relay-error">
                            {r.error}
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </details>
            <section
              className="network-section network-composer"
              aria-label="Submit campaign"
            >
              <h3>Submit a target</h3>
              <label>
                Upload protein · PDB, gzip or benchmark JSON
                <input
                  type="file"
                  aria-label="Upload network target"
                  accept=".pdb,.ent,.pdb.gz,.ent.gz,.json"
                  disabled={!ready}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    e.target.value = "";
                    if (!file) return;
                    void perform(async () => {
                      const imported = await importProteinFile(file);
                      if (
                        !manifest.supportedProtocols?.includes(
                          imported.task.protocol,
                        )
                      )
                        throw new Error(
                          "This protocol is unavailable in the packaged engine.",
                        );
                      await putState("network-target-draft", imported);
                      setTarget(imported);
                      setUseImported(true);
                      setTitle(imported.task.title);
                      setProtocol(imported.task.protocol);
                      setSeed(imported.task.seed);
                    });
                  }}
                />
              </label>
              {target && useImported && <ProteinImportSummary input={target} />}
              <div className="network-row">
                <label>
                  Target input
                  <select
                    aria-label="Network target input"
                    value={useImported ? "imported" : "bundled"}
                    onChange={(e) =>
                      setUseImported(e.target.value === "imported")
                    }
                  >
                    <option value="bundled">Bundled Trp-cage · 1L2Y</option>
                    <option value="imported" disabled={!target}>
                      {target?.task.title ?? "Upload a protein above"}
                    </option>
                  </select>
                </label>
                <label>
                  Protocol
                  <select
                    aria-label="Network protocol"
                    value={protocol}
                    onChange={(e) => setProtocol(e.target.value as Protocol)}
                  >
                    {PROTOCOLS.filter((p) =>
                      manifest.supportedProtocols?.includes(p.id),
                    ).map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <label className="network-check">
                <input
                  type="checkbox"
                  aria-label="Participate on this browser"
                  checked={participateLocal}
                  onChange={(e) => setParticipateLocal(e.target.checked)}
                />
                <span>Also calculate on this browser</span>
              </label>
              <p className="network-budget">
                {PROTOCOLS.find((p) => p.id === protocol)?.description}
              </p>
              <label>
                Title
                <input
                  aria-label="Campaign title"
                  value={title}
                  maxLength={120}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                Research description{" "}
                <small>
                  {description.length}/{MAX_CAMPAIGN_DESCRIPTION}
                </small>
                <textarea
                  aria-label="Campaign description"
                  required
                  rows={3}
                  maxLength={MAX_CAMPAIGN_DESCRIPTION}
                  value={description}
                  placeholder="What are volunteers helping you investigate?"
                  onChange={(e) => setDescription(e.target.value)}
                />
              </label>
              <div className="network-row">
                <label>
                  Independent models
                  <input
                    aria-label="Campaign models"
                    type="number"
                    min={1}
                    max={1000}
                    value={models}
                    onChange={(e) => setModels(Number(e.target.value))}
                  />
                </label>
                <label>
                  Starting seed
                  <input
                    aria-label="Campaign seed"
                    type="number"
                    min={1}
                    max={2_000_000_000 - models + 1}
                    value={seed}
                    onChange={(e) => setSeed(Number(e.target.value))}
                  />
                </label>
              </div>
              <button
                className="primary"
                disabled={
                  !ready ||
                  !title.trim() ||
                  !description.trim() ||
                  !Number.isInteger(models) ||
                  models < 1 ||
                  models > 1000 ||
                  !Number.isInteger(seed) ||
                  seed < 1 ||
                  seed + models - 1 > 2_000_000_000
                }
                onClick={() =>
                  void perform((c) =>
                    c.submit({
                      title,
                      description,
                      protocol,
                      seed,
                      models,
                      participateLocal,
                      inputPdb: useImported ? target?.task.pdb : undefined,
                      originalInput:
                        useImported && target?.metadata.preparation
                          ? {
                              pdb: target.metadata.pdb,
                              sha256:
                                target.metadata.preparation.originalSha256,
                              preparationPolicy:
                                target.metadata.preparation.policy,
                            }
                          : undefined,
                    }),
                  )
                }
              >
                <Send size={14} /> Submit campaign
              </button>
              {!view?.settings.enabled && (
                <p className="network-disclosure">
                  Saved locally. Join the network to announce queued work.
                </p>
              )}
            </section>
            <section className="network-section" aria-label="Your campaigns">
              <h3 ref={campaignsHeading} tabIndex={-1}>
                Your campaigns
              </h3>
              {!view?.campaigns.length && <p>No campaigns submitted.</p>}
              {view?.campaigns.map((campaign) => (
                <CampaignCard
                  key={campaign.id}
                  campaign={campaign}
                  identityId={view.identityId}
                  ready={ready}
                  onState={(state) =>
                    void perform((n) => n.campaignState(campaign.id, state))
                  }
                  onRemove={() =>
                    void perform(async (n) => {
                      await n.removeCampaign(campaign.id);
                      campaignsHeading.current?.focus();
                    })
                  }
                />
              ))}
            </section>
            <section className="network-section" aria-label="Live devices">
              <div className="network-device-heading">
                <h3>Live devices</h3>
                <button
                  type="button"
                  disabled={
                    !ready ||
                    !view?.settings.enabled ||
                    !peers.some((p) => !p.connected)
                  }
                  onClick={() => void perform((n) => n.retryConnections())}
                >
                  <RotateCw size={14} /> Retry connections
                </button>
              </div>
              <ul className="network-devices">
                <li>
                  <span>This browser</span>
                  <span>
                    {(view?.cooldownUntil ?? 0) > Date.now()
                      ? "Cooling down · 30s between models"
                      : ["loading", "running", "paused"].includes(
                            snapshot.state,
                          )
                        ? snapshot.state
                        : "Ready"}
                  </span>
                </li>
                {peers.map((p) => (
                  <li key={p.id}>
                    <code title={p.id}>{short(p.id)}</code>
                    <span title={p.connectionError}>
                      {!p.connected
                        ? p.connectionError
                          ? "Connection unavailable"
                          : p.connection?.state === "gathering"
                            ? "Finding a route…"
                            : p.connection?.state === "waiting"
                              ? "Waiting for reply…"
                              : p.connection
                                ? "Connecting…"
                                : "Online · no work"
                        : !p.presence.automatic
                          ? "Online · volunteering paused"
                          : !p.presence.available
                            ? "Busy"
                            : "Ready"}
                    </span>
                    {p.connection && !p.connected && (
                      <small className="network-route-detail">
                        {p.connection.remoteDescription
                          ? "Reply received"
                          : "Awaiting connection reply"}
                        {" · Local routes: "}
                        {p.connection.localCandidateTypes.join(", ") ||
                          "none yet"}
                        {" · TURN "}
                        {p.connection.turnConfigured
                          ? "configured"
                          : "not configured"}
                      </small>
                    )}
                    {!!p.connectionHistory?.length && !p.connected && (
                      <small className="network-route-detail">
                        {p.connectionHistory.some(
                          (attempt) =>
                            attempt.connection.iceState === "failed" ||
                            attempt.connection.transportState === "failed",
                        )
                          ? "An earlier attempt failed connection checks; its details are kept in the diagnostic report."
                          : "Previous setup attempts are kept in the diagnostic report."}
                      </small>
                    )}
                    {p.connectionError && (
                      <small className="network-relay-error">
                        {p.connectionError}
                      </small>
                    )}
                  </li>
                ))}
              </ul>
              <button
                type="button"
                disabled={!ready}
                onClick={() => {
                  if (controller)
                    download(
                      JSON.stringify(
                        controller.connectionDiagnostics(),
                        null,
                        2,
                      ),
                      "rotab-connection-diagnostics.json",
                    );
                }}
              >
                <Download size={14} /> Download connection diagnostics
              </button>
            </section>
            <section
              className="network-section"
              aria-label="Available network work"
            >
              <h3>Available work</h3>
              {!peers.some((p) =>
                p.presence.campaigns.some((c) => c.waiting > 0),
              ) && (
                <p>
                  {view?.settings.enabled
                    ? "Waiting for work announcements…"
                    : "Join the network to discover work."}
                </p>
              )}
              {peers.flatMap((p) =>
                p.presence.campaigns
                  .filter((c) => c.waiting > 0)
                  .map((c) => (
                    <article className="network-campaign" key={p.id + c.id}>
                      <div>
                        <strong>
                          {p.campaigns?.find((info) => info.id === c.id)
                            ?.title ??
                            PROTOCOLS.find((v) => v.id === c.protocol)?.label}
                        </strong>
                        {p.campaigns?.find((info) => info.id === c.id)
                          ?.description && (
                          <p className="research-description">
                            {
                              p.campaigns.find((info) => info.id === c.id)!
                                .description
                            }
                          </p>
                        )}
                        <span>
                          {PROTOCOLS.find((v) => v.id === c.protocol)?.label} ·{" "}
                          {c.waiting} queued
                        </span>
                        <span>
                          Publisher {short(p.id)} ·{" "}
                          {p.connected ? "Connected" : "Connecting…"}
                        </span>
                      </div>
                      <button
                        className="primary"
                        disabled={
                          !ready ||
                          !p.connected ||
                          !["idle", "complete", "error"].includes(
                            snapshot.state,
                          )
                        }
                        onClick={() =>
                          void perform((n) => n.request(p.id, c.id))
                        }
                      >
                        Calculate one model
                      </button>
                    </article>
                  )),
              )}
              {view?.incoming
                .filter((e) => e.status === "offered")
                .map((e) => {
                  if (
                    e.envelope.payload.type !== "network" ||
                    e.envelope.payload.message.kind !== "assignment"
                  )
                    return null;
                  const a = e.envelope.payload.message;
                  return (
                    <article className="network-campaign" key={a.job.id}>
                      <div>
                        <strong>{a.job.title}</strong>
                        {a.job.description && (
                          <p className="research-description">
                            {a.job.description}
                          </p>
                        )}
                      </div>
                      <button
                        className="primary"
                        disabled={!ready || a.expiresAt <= Date.now()}
                        onClick={() => void perform((n) => n.accept(a.job.id))}
                      >
                        Accept and calculate
                      </button>
                    </article>
                  );
                })}
            </section>
            <footer className="network-footer">
              <span>
                {pending} deliveries pending · returned energies unverified
              </span>
              <div className="network-actions">
                <button
                  disabled={!ready}
                  onClick={() =>
                    void perform(async (n) =>
                      download(
                        JSON.stringify(await n.exportRecords(), null, 2),
                        "rotab-network-records.json",
                      ),
                    )
                  }
                >
                  <Download size={14} /> Export records
                </button>
                <button
                  onClick={() => {
                    close();
                    openDirect();
                  }}
                >
                  Direct pairing
                </button>
              </div>
            </footer>
            <p className="network-disclosure">
              Keep the publishing tab open to distribute work and collect
              results. Other tabs share its session.
            </p>
          </>
        )}
        {(error || networkError || view?.error) && (
          <p className="network-error" role="alert">
            {error || networkError || view?.error}
          </p>
        )}
      </section>
    </Modal>
  );
}
