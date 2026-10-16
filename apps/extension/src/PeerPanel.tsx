import { useEffect, useRef, useState } from "react";
import { Copy, Download, Link2, Network, Send, Unplug, X } from "lucide-react";
import {
  PROTOCOLS,
  type EngineManifest,
  type Protocol,
  type Snapshot,
} from "@rosettatab/shared";
import type { Session } from "./session";
import { Modal } from "./Modal";
import { getState, putState, type Preferences } from "./storage";
import { importProteinFile, type ImportedBenchmark } from "./benchmark";
import { defaultPeerIce, type PeerIceSettings } from "./peer-connection";
import { PeerCollaboration, type PeerView } from "./peer-collaboration";
import "./peer-panel.css";
import { MAX_CAMPAIGN_DESCRIPTION } from "./peer-protocol";
import { ProteinImportSummary } from "./ProteinImportSummary";

function download(value: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([value], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
const shortId = (id: string) =>
  id
    .slice(0, 32)
    .match(/.{1,8}/g)!
    .join(" ");

/** Remains mounted when its dialog closes: the computing tab owns the connection. */
export function PeerPanel({
  open,
  close,
  owner,
  manifest,
  session,
  snapshot,
  preferences,
  onView,
}: {
  open: boolean;
  close: () => void;
  owner: boolean;
  manifest?: EngineManifest;
  session?: Session;
  snapshot: Snapshot;
  preferences: Preferences;
  onView?: (view: PeerView) => void;
}) {
  const controller = useRef<PeerCollaboration | undefined>(undefined);
  const onViewRef = useRef(onView);
  onViewRef.current = onView;
  const [view, setView] = useState<PeerView>();
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [incoming, setIncoming] = useState(""),
    [outgoing, setOutgoing] = useState("");
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [ice, setIce] = useState<PeerIceSettings>({ ...defaultPeerIce });
  const [protocol, setProtocol] = useState<Protocol>(
    preferences.browserProtocol,
  );
  const [models, setModels] = useState(1),
    [seed, setSeed] = useState(17);
  const [description, setDescription] = useState("");
  const [title, setTitle] = useState("Trp-cage peer experiment");
  const [targetDraft, setTargetDraft] = useState<ImportedBenchmark>();
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [useImported, setUseImported] = useState(false),
    [importedTitle, setImportedTitle] = useState("");
  useEffect(() => {
    if (!owner || !session || !manifest?.verified) return;
    let alive = true;
    setView(undefined);
    setIncoming("");
    setOutgoing("");
    setAwaitingReply(false);
    const active = new PeerCollaboration(manifest, {
      update: (next) => {
        if (alive) {
          setView({ ...next });
          onViewRef.current?.(next);
        }
      },
      accept: (job, hash) => session.acceptPeerJob(job, hash),
    });
    controller.current = active;
    void active.initialize().catch(() => {
      if (alive) setError("Peer storage could not be initialized.");
    });
    return () => {
      alive = false;
      active.dispose();
      controller.current = undefined;
    };
  }, [owner, manifest, session]);
  useEffect(() => {
    if (controller.current)
      void controller.current
        .observe(snapshot)
        .catch(() =>
          setError(
            "The peer result remains saved locally. Open collaboration and retry.",
          ),
        );
  }, [snapshot, view?.identityId]);
  useEffect(() => {
    if (!open || !owner) return;
    let alive = true;
    setDraftLoaded(false);
    void (async () => {
      const [draft, benchmark, options] = await Promise.all([
        getState<ImportedBenchmark>("peer-target-draft"),
        getState<ImportedBenchmark>("benchmark-input"),
        getState<{
          title: string;
          description?: string;
          protocol: Protocol;
          models: number;
          seed: number;
          useImported: boolean;
        }>("peer-publish-options"),
      ]);
      if (!alive) return;
      const input = draft ?? benchmark;
      setTargetDraft(input);
      setImportedTitle(input?.task.title ?? "");
      if (options) {
        setDescription(options.description ?? "");
        if (typeof options.title === "string")
          setTitle(options.title.slice(0, 120));
        if (PROTOCOLS.some((p) => p.id === options.protocol))
          setProtocol(options.protocol);
        if (
          Number.isInteger(options.models) &&
          options.models >= 1 &&
          options.models <= 4
        )
          setModels(options.models);
        if (
          Number.isInteger(options.seed) &&
          options.seed >= 1 &&
          options.seed <= 1_999_999_997
        )
          setSeed(options.seed);
        setUseImported(options.useImported === true && !!input);
      } else if (draft) {
        setUseImported(true);
        setTitle(draft.task.title);
        setProtocol(draft.task.protocol);
        setSeed(draft.task.seed);
      }
      setDraftLoaded(true);
    })().catch(() => setError("Could not restore the saved target."));
    return () => {
      alive = false;
    };
  }, [open, owner]);
  useEffect(() => {
    if (!open || !owner || !draftLoaded) return;
    void putState("peer-publish-options", {
      title,
      description,
      protocol,
      models,
      seed,
      useImported,
    }).catch(() => setError("Could not save the target settings."));
  }, [
    open,
    owner,
    draftLoaded,
    title,
    description,
    protocol,
    models,
    seed,
    useImported,
  ]);
  const perform = async (
    action: (active: PeerCollaboration) => Promise<unknown>,
  ) => {
    if (!controller.current || busy) return;
    setBusy(true);
    setError("");
    try {
      await action(controller.current);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message.slice(0, 220)
          : "The peer action failed. Saved work is retained.",
      );
    } finally {
      setBusy(false);
    }
  };
  if (!open) return null;
  const connected = view?.state === "connected";
  const ready = owner && !!view?.identityId && !busy;
  const working = [
    "loading",
    "running",
    "paused",
    "uploading",
    "waiting",
  ].includes(snapshot.state);
  const stateLabels: Record<string, string> = {
    idle: "Not connected",
    disconnected: "Disconnected",
    gathering: "Preparing connection…",
    waiting: "Invitation ready",
    connecting: "Connecting…",
    connected: "Connected",
    failed: "Connection failed",
  };
  const accept = (id: string) =>
    perform(async (active) => {
      await active.acceptJob(id);
      close();
    });
  return (
    <Modal close={close} confirm={close} label="Peer collaboration">
      <section className="small-modal peer-panel">
        <div className="peer-panel-heading">
          <div>
            <span className="peer-eyebrow">PRIVATE PILOT</span>
            <h2>
              <Network size={19} /> Peer collaboration
            </h2>
          </div>
          <button
            className="peer-icon-button"
            aria-label="Close peer collaboration"
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        {!owner ? (
          <p className="peer-notice">
            Open collaboration in the computing tab. Linked tabs share its
            calculation.
          </p>
        ) : !manifest?.verified ? (
          <p className="peer-notice">
            The verified Rosetta engine is required for peer calculations.
          </p>
        ) : (
          <>
            <div className="peer-identity-card">
              <div
                className="peer-connection-status"
                data-peer-state={view?.state ?? "idle"}
              >
                <i /> {stateLabels[view?.state ?? "idle"]}
                {connected && (
                  <small>
                    {view?.path === "relayed"
                      ? "Relayed"
                      : view?.path === "direct"
                        ? "Direct"
                        : "WebRTC"}
                  </small>
                )}
              </div>
              {view?.identityId && (
                <div>
                  <span>Your participant ID</span>
                  <code
                    className="peer-fingerprint"
                    data-peer-id={view.identityId}
                    title={view.identityId}
                  >
                    {shortId(view.identityId)}
                  </code>
                  <button
                    className="peer-icon-button"
                    aria-label="Copy participant ID"
                    title="Copy full participant ID"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(view.identityId!)
                        .catch(() =>
                          setError("Select the ID and copy it manually."),
                        )
                    }
                  >
                    <Copy size={13} />
                  </button>
                </div>
              )}
              {view?.remoteId && (
                <div>
                  <span>Volunteer ID</span>
                  <code
                    className="peer-remote-fingerprint"
                    title={view.remoteId}
                  >
                    {shortId(view.remoteId)}
                  </code>
                </div>
              )}
            </div>
            {
              <section
                id="peer-target-composer"
                className="peer-publish"
                aria-label="Publish peer target"
              >
                <h3>Publish a target</h3>
                <label className="peer-target-upload">
                  Upload protein · PDB or benchmark JSON
                  <input
                    aria-label="Upload peer target"
                    type="file"
                    accept=".pdb,.ent,.pdb.gz,.ent.gz,.json"
                    disabled={busy || !ready || !draftLoaded}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      event.target.value = "";
                      if (!file) return;
                      void perform(async () => {
                        const input = await importProteinFile(file);
                        if (
                          !manifest.supportedProtocols?.includes(
                            input.task.protocol,
                          )
                        )
                          throw new Error(
                            "This target's protocol is not supported by the packaged engine.",
                          );
                        await putState("peer-target-draft", input);
                        setTargetDraft(input);
                        setImportedTitle(input.task.title);
                        setUseImported(true);
                        setTitle(input.task.title);
                        setProtocol(input.task.protocol);
                        setSeed(input.task.seed);
                      });
                    }}
                  />
                </label>
                {targetDraft && useImported && (
                  <ProteinImportSummary input={targetDraft} />
                )}
                <div className="peer-form-row">
                  <label>
                    Target input
                    <select
                      aria-label="Target input"
                      value={useImported ? "imported" : "bundled"}
                      onChange={(event) =>
                        setUseImported(event.target.value === "imported")
                      }
                    >
                      <option value="bundled">Bundled Trp-cage · 1L2Y</option>
                      <option value="imported" disabled={!importedTitle}>
                        {importedTitle || "Upload a protein above"}
                      </option>
                    </select>
                  </label>
                  <label>
                    Protocol
                    <select
                      aria-label="Peer calculation protocol"
                      value={protocol}
                      onChange={(event) =>
                        setProtocol(event.target.value as Protocol)
                      }
                    >
                      {PROTOCOLS.filter((p) =>
                        manifest.supportedProtocols?.includes(p.id),
                      ).map((p) => (
                        <option value={p.id} key={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
                <p className="peer-protocol-budget" role="status">
                  {PROTOCOLS.find((p) => p.id === protocol)?.description}
                </p>
                <label>
                  Target title
                  <input
                    aria-label="Target title"
                    value={title}
                    maxLength={120}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </label>
                <label>
                  Research description{" "}
                  <small>
                    {description.length}/{MAX_CAMPAIGN_DESCRIPTION}
                  </small>
                  <textarea
                    aria-label="Target description"
                    required
                    rows={3}
                    maxLength={MAX_CAMPAIGN_DESCRIPTION}
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="What will these calculations help you investigate?"
                  />
                </label>
                <div className="peer-form-row">
                  <label>
                    Independent models · 1–4
                    <input
                      aria-label="Models"
                      type="number"
                      min={1}
                      max={4}
                      value={models}
                      onChange={(event) =>
                        setModels(Number(event.target.value))
                      }
                    />
                  </label>
                  <label>
                    Random seed
                    <input
                      aria-label="Random seed"
                      type="number"
                      min={1}
                      max={2_000_000_000 - models + 1}
                      value={seed}
                      onChange={(event) => setSeed(Number(event.target.value))}
                    />
                  </label>
                </div>
                <button
                  className="primary"
                  disabled={
                    !ready ||
                    !connected ||
                    !title.trim() ||
                    !description.trim() ||
                    !Number.isInteger(models) ||
                    models < 1 ||
                    models > 4 ||
                    !Number.isInteger(seed) ||
                    seed < 1 ||
                    seed + models - 1 > 2_000_000_000
                  }
                  onClick={() =>
                    void perform((active) =>
                      active.publish({
                        title: title.trim(),
                        description,
                        protocol,
                        seed,
                        models,
                        useImported,
                        inputPdb: useImported
                          ? targetDraft?.task.pdb
                          : undefined,
                        originalInput:
                          useImported && targetDraft?.metadata.preparation
                            ? {
                                pdb: targetDraft.metadata.pdb,
                                sha256:
                                  targetDraft.metadata.preparation
                                    .originalSha256,
                                preparationPolicy:
                                  targetDraft.metadata.preparation.policy,
                              }
                            : undefined,
                      }),
                    )
                  }
                >
                  <Send size={14} /> Send target
                </button>
                {!connected && (
                  <a className="peer-connect-link" href="#peer-pairing">
                    Connect a volunteer to send this target ↓
                  </a>
                )}
                {connected && (
                  <p className="peer-recipient" title={view?.remoteId}>
                    To volunteer · {shortId(view!.remoteId!)}
                  </p>
                )}
              </section>
            }
            {!connected && (
              <div className="peer-pairing" id="peer-pairing">
                <p className="peer-description">
                  Exchange invitation and reply codes with your friend. Compare
                  fingerprints through the same trusted conversation.
                </p>
                <div className="peer-actions">
                  <button
                    className="primary"
                    disabled={!ready}
                    onClick={() =>
                      void perform(async (active) => {
                        setAwaitingReply(false);
                        setOutgoing(await active.createInvitation(ice));
                        setAwaitingReply(true);
                      })
                    }
                  >
                    <Link2 size={14} /> Create invitation
                  </button>
                </div>
                <label>
                  Incoming connection code
                  <textarea
                    aria-label="Incoming connection code"
                    value={incoming}
                    spellCheck={false}
                    onChange={(event) => setIncoming(event.target.value)}
                    placeholder="Paste your friend's invitation or reply"
                    rows={3}
                  />
                </label>
                <div className="peer-actions">
                  <button
                    className="secondary"
                    disabled={!ready || !incoming.trim()}
                    onClick={() =>
                      void perform(async (active) => {
                        setAwaitingReply(false);
                        setOutgoing(await active.joinInvitation(incoming, ice));
                      })
                    }
                  >
                    Join invitation
                  </button>
                  <button
                    className="secondary"
                    disabled={!ready || !incoming.trim() || !awaitingReply}
                    onClick={() =>
                      void perform(async (active) => {
                        await active.connectReply(incoming);
                        setAwaitingReply(false);
                      })
                    }
                  >
                    Connect reply
                  </button>
                </div>
                {outgoing && (
                  <label>
                    Outgoing connection code
                    <textarea
                      aria-label="Outgoing connection code"
                      value={outgoing}
                      readOnly
                      spellCheck={false}
                      rows={3}
                    />
                    <button
                      className="secondary"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(outgoing)
                          .catch(() =>
                            setError(
                              "Select the outgoing code and copy it manually.",
                            ),
                          )
                      }
                    >
                      <Copy size={13} /> Copy code
                    </button>
                  </label>
                )}
                <details className="peer-network-settings">
                  <summary>Connection settings</summary>
                  <label>
                    STUN server
                    <input
                      aria-label="STUN server"
                      value={ice.stun}
                      onChange={(event) =>
                        setIce({ ...ice, stun: event.target.value })
                      }
                      placeholder="Leave blank for a local-network test"
                    />
                  </label>
                  <label>
                    TURN URL
                    <input
                      aria-label="TURN URL"
                      value={ice.turn}
                      onChange={(event) =>
                        setIce({ ...ice, turn: event.target.value })
                      }
                      placeholder="turns:relay.example.org:5349"
                    />
                  </label>
                  <div className="peer-form-row">
                    <label>
                      TURN username
                      <input
                        aria-label="TURN username"
                        value={ice.username}
                        autoComplete="off"
                        onChange={(event) =>
                          setIce({ ...ice, username: event.target.value })
                        }
                      />
                    </label>
                    <label>
                      TURN credential
                      <input
                        aria-label="TURN credential"
                        value={ice.credential}
                        type="password"
                        autoComplete="off"
                        onChange={(event) =>
                          setIce({ ...ice, credential: event.target.value })
                        }
                      />
                    </label>
                  </div>
                  <p className="peer-description">
                    STUN assists discovery; TURN relays data when direct
                    connections fail. Credentials stay in this tab and are
                    excluded from exports.
                  </p>
                </details>
              </div>
            )}
            {!!view?.jobs.length && (
              <section className="peer-jobs" aria-label="Peer jobs">
                <h3>Targets</h3>
                {[...view.jobs].reverse().map((entry) => (
                  <article
                    className="peer-job"
                    data-job-id={entry.job.id}
                    data-direction={entry.direction}
                    data-job-status={entry.status}
                    key={entry.job.id}
                  >
                    <div>
                      <strong>{entry.job.title}</strong>
                      {entry.job.description && (
                        <p className="research-description">
                          {entry.job.description}
                        </p>
                      )}
                      <span>
                        {entry.direction === "sent" ? "Sent" : "Received"} ·{" "}
                        {
                          PROTOCOLS.find((p) => p.id === entry.job.protocol)
                            ?.label
                        }{" "}
                        · {entry.job.models}{" "}
                        {entry.job.models === 1 ? "model" : "models"}
                      </span>
                    </div>
                    <small>
                      {entry.status === "offered"
                        ? entry.direction === "sent"
                          ? "Awaiting acceptance"
                          : "Awaiting your acceptance"
                        : entry.status}
                    </small>
                    <div className="peer-record-binding">
                      <span title={entry.job.id}>Target · {entry.job.id}</span>
                      <span title={entry.peerId}>
                        {entry.direction === "sent" ? "Volunteer" : "Publisher"}{" "}
                        · {shortId(entry.peerId)}
                      </span>
                    </div>
                    <div className="peer-input-identity">
                      <span>
                        Seed {entry.job.seed}
                        {entry.job.models > 1
                          ? `–${entry.job.seed + entry.job.models - 1}`
                          : ""}
                      </span>
                      <code title={`Input SHA-256: ${entry.job.input.sha256}`}>
                        {entry.job.input.sha256.slice(0, 12)}
                      </code>
                      <button
                        className="secondary"
                        aria-label={`Download target ${entry.job.title}`}
                        onClick={() =>
                          download(
                            entry.job.input.pdb,
                            `rotab-target-${entry.job.id}.pdb`,
                            "chemical/x-pdb",
                          )
                        }
                      >
                        <Download size={12} /> Input
                      </button>
                    </div>
                    {entry.progress && (
                      <div className="peer-job-progress">
                        <progress
                          max={entry.progress.total || 1}
                          value={entry.progress.completed}
                        />
                        <span>
                          {entry.progress.completed}/{entry.progress.total} ·{" "}
                          {entry.progress.state}
                        </span>
                      </div>
                    )}
                    {entry.direction === "received" &&
                      entry.status === "offered" && (
                        <button
                          className="primary"
                          disabled={!ready || working}
                          title={
                            working
                              ? "Finish or stop the current calculation first"
                              : undefined
                          }
                          onClick={() => void accept(entry.job.id)}
                        >
                          Accept and calculate
                        </button>
                      )}
                  </article>
                ))}
              </section>
            )}
            {!!view?.results.length && (
              <section className="peer-results" aria-label="Peer results">
                <h3>Results</h3>
                {[...view.results].reverse().map((entry) => (
                  <article
                    className="peer-result"
                    data-result-id={entry.result.id}
                    data-direction={entry.direction}
                    data-delivery={entry.delivery}
                    key={entry.result.id}
                  >
                    <div>
                      <strong>
                        {view.jobs.find(
                          (job) => job.job.id === entry.result.jobId,
                        )?.job.title ?? "Rosetta result"}
                      </strong>
                      <span>
                        {entry.direction === "received"
                          ? "Received"
                          : entry.delivery === "acknowledged"
                            ? "Receipt confirmed"
                            : "Saved · awaiting delivery"}{" "}
                        · Score unverified
                      </span>
                    </div>
                    <div className="peer-record-binding">
                      <span>Target · {entry.result.jobId}</span>
                      <span title={entry.envelope.senderId}>
                        Calculated by · {shortId(entry.envelope.senderId)}
                      </span>
                      <span title={entry.result.inputSha256}>
                        Input SHA-256 · {entry.result.inputSha256.slice(0, 16)}
                      </span>
                    </div>
                    <div className="peer-models">
                      {entry.result.models.map((model) => (
                        <div key={model.modelIndex}>
                          <span>
                            Model {model.modelIndex + 1} · Seed {model.seed}{" "}
                            <b>
                              {model.energy.toFixed(3)} <small>REU</small>
                            </b>
                          </span>
                          <button
                            className="secondary"
                            aria-label={`Download result protein model ${model.modelIndex + 1}`}
                            onClick={() =>
                              download(
                                model.pdb,
                                `rotab-peer-${entry.result.jobId}-${model.modelIndex + 1}.pdb`,
                                "chemical/x-pdb",
                              )
                            }
                          >
                            <Download size={13} /> Protein
                          </button>
                        </div>
                      ))}
                    </div>
                  </article>
                ))}
              </section>
            )}
            <div className="peer-footer">
              <button
                className="secondary"
                disabled={!ready || !connected}
                onClick={() => void perform((active) => active.retry())}
              >
                <Send size={13} /> Send saved results
              </button>
              <button
                className="secondary"
                disabled={!ready}
                onClick={() =>
                  void perform(async (active) =>
                    download(
                      JSON.stringify(await active.exportRecords(), null, 2) +
                        "\n",
                      `rotab-peer-records-${Date.now()}.json`,
                      "application/json",
                    ),
                  )
                }
              >
                <Download size={13} /> Export peer records
              </button>
              <button
                className="secondary"
                disabled={
                  !ready ||
                  (!connected &&
                    view?.state !== "waiting" &&
                    view?.state !== "connecting")
                }
                onClick={() => {
                  controller.current?.disconnect();
                  setOutgoing("");
                  setAwaitingReply(false);
                  setIncoming("");
                }}
              >
                <Unplug size={13} /> Disconnect
              </button>
            </div>
            <p className="peer-scope">
              Packaged Rosetta · browser computation · official submission
              disabled
            </p>
          </>
        )}
        {(error || view?.error) && (
          <p className="peer-error" role="status">
            {error || view?.error}
          </p>
        )}
      </section>
    </Modal>
  );
}
