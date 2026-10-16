import { z } from "zod";
import {
  type Checkpoint,
  type EngineManifest,
  type Protocol,
  type Snapshot,
} from "@rosettatab/shared";
import {
  CampaignQueue,
  campaignCounts,
  type Campaign,
  type Assignment,
  type VolunteerPresence,
} from "./campaign-queue";
import { bundledTask } from "./browser-tasks";
import { loadPeerIdentity } from "./peer-identity";
import {
  PeerConnection,
  decodePeerCode,
  type PeerConnectionDiagnostics,
} from "./peer-connection";
import type {
  ConnectivityUpdate,
  IceCandidate,
} from "./connectivity-signaling";
import {
  NostrDiscovery,
  loadNostrIdentity,
  networkSettingsSchema,
  defaultNetworkSettings,
  type DiscoveredPeer,
  type NetworkSettings,
  type NostrIdentity,
  type RelayStatus,
  type ConnectivitySignal,
} from "./nostr-discovery";
import { bundledTurn, resolveNetworkSettings } from "./network-settings";
import { getState, putState } from "./storage";
import {
  canonicalStringify,
  NETWORK_VERSION,
  campaignDescriptionSchema,
  hashPeerJob,
  peerSha256,
  signPeerMessage,
  validatePeerJob,
  validatePeerResult,
  verifyPeerMessage,
  type NetworkMessage,
  type NetworkPresence,
  type NetworkCampaignInfo,
  type NetworkProgress,
  type PeerIdentity,
  type PeerJob,
  type PeerResult,
  type SignedPeerMessage,
} from "./peer-protocol";

export interface NetworkIncoming {
  envelope: SignedPeerMessage;
  hash: string;
  peerId: string;
  status: "offered" | "accepted" | "complete" | "released";
  result?: SignedPeerMessage;
  receipt?: "received" | "obsolete";
}
interface NetworkLedger {
  version: 1;
  incoming: NetworkIncoming[];
  bindings: Record<string, string>;
}
export interface ConnectionAttempt {
  attempt: number;
  startedAt: number;
  endedAt: number;
  reason: "superseded" | "automatic-retry" | "manual-retry" | "expired";
  connection: PeerConnectionDiagnostics;
}
export interface NetworkPeer {
  id: string;
  nostrPublicKey: string;
  seenAt: number;
  presence: NetworkPresence;
  connected: boolean;
  connectionError?: string;
  connection?: PeerConnectionDiagnostics;
  connectionHistory?: ConnectionAttempt[];
  campaigns?: NetworkCampaignInfo[];
}
export interface NetworkView {
  identityId?: string;
  nostrPublicKey?: string;
  settings: NetworkSettings;
  relays: RelayStatus[];
  peers: NetworkPeer[];
  campaigns: Campaign[];
  incoming: NetworkIncoming[];
  error?: string;
  cooldownUntil?: number;
}
const ledgerSchema = z
  .object({
    version: z.literal(1),
    incoming: z
      .array(
        z
          .object({
            envelope: z.unknown(),
            hash: z.string().regex(/^[a-f0-9]{64}$/),
            peerId: z.string().regex(/^[a-f0-9]{64}$/),
            status: z.enum(["offered", "accepted", "complete", "released"]),
            result: z.unknown().optional(),
            receipt: z.enum(["received", "obsolete"]).optional(),
          })
          .strict(),
      )
      .max(100),
    bindings: z
      .record(
        z.string().regex(/^[a-f0-9]{64}$/),
        z.string().regex(/^[a-f0-9]{64}$/),
      )
      .refine((r) => Object.keys(r).length <= 200),
  })
  .strict();

/** One controller per computing-tab Web Lock. Nostr never receives scientific payloads. */
export class VolunteerNetwork {
  private identity?: PeerIdentity;
  private nostrIdentity?: NostrIdentity;
  private discovery?: NostrDiscovery;
  private queue?: CampaignQueue;
  private ledger: NetworkLedger = { version: 1, incoming: [], bindings: {} };
  private durableLedger: NetworkLedger = structuredClone(this.ledger);
  private pendingSignals = new Map<
    string,
    { key: string; signals: ConnectivitySignal[]; at: number }
  >();
  private peers = new Map<string, NetworkPeer>();
  private pendingIce = new Map<
    string,
    { sessionId: string; candidates: RTCIceCandidateInit[]; at: number }[]
  >();
  private links = new Map<
    string,
    {
      link: PeerConnection;
      startedAt: number;
      attempt: number;
      lastFailure?: PeerConnectionDiagnostics;
      offerCode?: string;
      offerAt?: number;
      answered?: boolean;
      sessionId?: string;
      localCode?: string;
      signalAt?: number;
      basePublished?: boolean;
      candidates: IceCandidate[];
      candidateHistory: IceCandidate[];
      candidatesSentAt?: number;
      candidateCount: number;
      candidateTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  private connectionHistory = new Map<string, ConnectionAttempt[]>();
  private connectionSequence = 0;
  private requested = new Map<string, number>();
  private sending = new WeakMap<PeerConnection, Set<string>>();
  private serialAction: Promise<unknown> = Promise.resolve();
  private initializing?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private scheduleTimer?: ReturnType<typeof setTimeout>;
  private announcementTimer?: ReturnType<typeof setTimeout>;
  private announcedAt = 0;
  private cooldownTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private observedJobs = new Set<string>();
  private latestProgress?: { jobId: string; progress: NetworkProgress };
  private progressSentAt = 0;
  private observedState = "";
  private current: NetworkView = {
    settings: structuredClone(defaultNetworkSettings),
    relays: [],
    peers: [],
    campaigns: [],
    incoming: [],
  };
  constructor(
    readonly manifest: EngineManifest,
    readonly callbacks: {
      update(view: NetworkView): void;
      accept(job: PeerJob, hash: string): Promise<void>;
      available(): boolean;
    },
  ) {}
  get view(): NetworkView {
    return structuredClone(this.current);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.serialAction
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error("Network closed.");
        return work();
      });
    this.serialAction = next.catch(() => {});
    return next;
  }
  private emit() {
    if (this.disposed) return;
    const now = Date.now();
    this.current.peers = [...this.peers.values()]
      .filter((p) => p.presence.expiresAt > now)
      .map((p) => ({
        ...p,
        connected: !!this.links.get(p.id)?.link.connected,
        connection: this.links.get(p.id)?.link.diagnostics(),
        connectionHistory: this.connectionHistory.get(p.id) ?? [],
      }));
    this.current.campaigns = this.queue?.campaigns ?? [];
    this.current.incoming = this.ledger.incoming;
    this.callbacks.update(this.view);
  }
  private fail(message: string) {
    this.current.error = message;
    this.emit();
  }
  private async persist() {
    if (this.disposed) throw new Error("Network closed.");
    try {
      await putState("network-ledger", this.ledger);
      this.durableLedger = structuredClone(this.ledger);
    } catch (e) {
      this.ledger = structuredClone(this.durableLedger);
      throw e;
    }
    this.emit();
  }
  initialize(): Promise<void> {
    return (this.initializing ??= this.serial(async () => {
      this.identity = await loadPeerIdentity();
      this.nostrIdentity = await loadNostrIdentity();
      this.current.identityId = this.identity.id;
      this.current.nostrPublicKey = this.nostrIdentity.publicKey;
      const settings = await getState<unknown>("network-settings");
      this.current.settings = resolveNetworkSettings(settings);
      if (JSON.stringify(settings) !== JSON.stringify(this.current.settings)) {
        await putState("network-settings", this.current.settings);
      }
      this.queue = new CampaignQueue(this.identity.id, this.manifest, {
        read: () => getState("campaign-ledger"),
        write: (value) => {
          if (this.disposed) throw new Error("Network closed.");
          return putState("campaign-ledger", value);
        },
      });
      await this.queue.initialize();
      const saved = await getState<unknown>("network-ledger");
      if (saved !== undefined) {
        const parsed = ledgerSchema.parse(saved);
        const incoming: NetworkIncoming[] = [];
        const ids = new Set<string>();
        for (const entry of parsed.incoming) {
          const envelope = await verifyPeerMessage(
            entry.envelope,
            entry.peerId,
          );
          const m = this.assignment(envelope);
          if (ids.has(m.job.id))
            throw new Error("Saved network job IDs conflict.");
          ids.add(m.job.id);
          await validatePeerJob(
            m.job,
            {
              ...this.manifest,
              ...m.job.engine,
              verified: true,
              supportedProtocols: [m.job.protocol],
            },
            { now: m.job.createdAt },
          );
          if (m.job.models !== 1 || (await hashPeerJob(m.job)) !== entry.hash)
            throw new Error("Saved network input binding is invalid.");
          let result: SignedPeerMessage | undefined;
          if (entry.result) {
            result = await verifyPeerMessage(entry.result, this.identity.id);
            if (
              result.payload.type !== "network" ||
              result.payload.message.kind !== "result"
            )
              throw new Error("Saved network result is invalid.");
            const r = result.payload.message;
            if (
              r.campaignId !== m.campaignId ||
              r.attemptId !== m.attemptId ||
              r.leaseToken !== m.leaseToken
            )
              throw new Error("Saved network result binding is invalid.");
            await validatePeerResult(r.result, m.job);
          }
          if (
            (entry.status === "complete") !== !!result ||
            (entry.receipt && !result)
          )
            throw new Error("Saved delivery status is inconsistent.");
          incoming.push({
            envelope,
            hash: entry.hash,
            peerId: entry.peerId,
            status: entry.status,
            ...(entry.receipt ? { receipt: entry.receipt } : {}),
            ...(result ? { result } : {}),
          });
        }
        this.ledger = { version: 1, bindings: parsed.bindings, incoming };
        this.durableLedger = structuredClone(this.ledger);
      }
      await this.recover();
      const checkpoint = await getState<Checkpoint>("checkpoint");
      for (const entry of this.ledger.incoming)
        if (
          entry.status === "accepted" &&
          !entry.result &&
          (checkpoint?.peer?.jobId !== this.assignment(entry.envelope).job.id ||
            checkpoint.peer.jobHash !== entry.hash)
        )
          entry.status = "released";
      await this.persist();
      if (this.disposed) return;
      await this.restartDiscovery();
      if (this.disposed) return;
      this.timer = setInterval(
        () =>
          void this.tick().catch(() =>
            this.fail("Network update failed. Saved work is retained."),
          ),
        12_000,
      );
      this.emit();
    }));
  }
  private assignment(envelope: SignedPeerMessage) {
    if (
      envelope.payload.type !== "network" ||
      envelope.payload.message.kind !== "assignment"
    )
      throw new Error("Not a network assignment.");
    return envelope.payload.message;
  }
  private async restartDiscovery() {
    this.discovery?.stop();
    this.discovery = undefined;
    for (const id of this.links.keys()) this.closeLink(id);
    this.peers.clear();
    this.requested.clear();
    this.pendingSignals.clear();
    this.pendingIce.clear();
    this.connectionHistory.clear();
    this.announcedAt = 0;
    if (this.announcementTimer) clearTimeout(this.announcementTimer);
    this.announcementTimer = undefined;
    this.current.relays = [];
    if (!this.current.settings.enabled || this.disposed) return;
    const discovery = new NostrDiscovery(
      this.nostrIdentity!,
      this.current.settings,
      {
        presence: (peer) =>
          void this.serial(() => this.presence(peer)).catch(() =>
            this.fail("A network presence record was rejected."),
          ),
        signal: (key, signal) =>
          void this.serial(() => this.signal(key, signal)).catch(() =>
            this.fail("A connection signal was rejected or expired."),
          ),
        status: (relays) => {
          if (!this.disposed && this.discovery === discovery) {
            this.current.relays = relays;
            this.emit();
          }
        },
        opened: () => void this.tick().catch(() => {}),
      },
    );
    this.discovery = discovery;
    await discovery.start();
  }
  async configure(raw: NetworkSettings) {
    const settings = networkSettingsSchema.parse(raw);
    // Saving an empty TURN URL is an intentional opt-out, even for older callers.
    if (bundledTurn) settings.bundledTurnApplied = true;
    await this.initialize();
    return this.serial(async () => {
      await putState("network-settings", settings);
      this.current.settings = settings;
      this.current.error = undefined;
      const previous = this.discovery?.settings;
      if (
        !previous ||
        settings.enabled !== previous.enabled ||
        settings.room !== previous.room ||
        settings.stun !== previous.stun ||
        settings.turn !== previous.turn ||
        settings.turnUsername !== previous.turnUsername ||
        settings.turnCredential !== previous.turnCredential ||
        canonicalStringify(settings.relays) !==
          canonicalStringify(previous.relays)
      )
        await this.restartDiscovery();
      else {
        await this.announce();
        await this.schedule();
      }
      this.emit();
    });
  }
  private async presence(peer: DiscoveredPeer) {
    if (!this.current.settings.enabled) return;
    if (peer.peerId === this.identity!.id) return;
    const bound = this.ledger.bindings[peer.peerId];
    if (bound && bound !== peer.nostrPublicKey)
      throw new Error("Nostr key differs from the saved participant binding.");
    const previous = this.peers.get(peer.peerId);
    if (previous && previous.presence.issuedAt >= peer.presence.issuedAt)
      return;
    if (!previous && this.peers.size >= 32) return;
    if (!bound) {
      if (Object.keys(this.ledger.bindings).length >= 200) return;
      this.ledger.bindings[peer.peerId] = peer.nostrPublicKey;
      await this.persist();
    }
    this.peers.set(peer.peerId, {
      id: peer.peerId,
      nostrPublicKey: peer.nostrPublicKey,
      seenAt: peer.seenAt,
      presence: peer.presence,
      connected: false,
      ...(previous?.connectionError
        ? { connectionError: previous.connectionError }
        : {}),
      ...(previous?.campaigns ? { campaigns: previous.campaigns } : {}),
    });
    const pending = this.pendingSignals.get(peer.peerId);
    if (pending) {
      this.pendingSignals.delete(peer.peerId);
      if (
        pending.key === peer.nostrPublicKey &&
        pending.at > Date.now() - 45_000
      )
        for (const signal of pending.signals)
          await this.signal(pending.key, signal);
    }
    this.ensureLink(peer.peerId);
    await this.schedule();
    this.emit();
  }
  private related(peer: NetworkPeer) {
    return (
      this.queue!.retiredWorkerIds.includes(peer.id) ||
      this.queue!.campaigns.some((c) =>
        c.attempts.some(
          (a) =>
            a.lease?.workerId === peer.id || a.outcome?.workerId === peer.id,
        ),
      ) ||
      this.queue!.campaigns.some(
        (c) =>
          c.state === "active" &&
          !!c.description &&
          campaignCounts(c).waiting > 0,
      ) ||
      peer.presence.campaigns.some((c) => c.waiting > 0) ||
      this.ledger.incoming.some(
        (e) =>
          e.peerId === peer.id &&
          (e.status === "accepted" || (e.result && !e.receipt)),
      )
    );
  }
  private makeLink(peerId: string): PeerConnection {
    const link = new PeerConnection(this.identity!, {
      status: (state) => {
        if (state === "connected")
          void this.serial(async () => {
            if (this.links.get(peerId)?.link !== link) return;
            const peer = this.peers.get(peerId);
            if (peer) delete peer.connectionError;
            await this.announce();
            await this.retry(peerId);
            await this.schedule();
            this.emit();
          }).catch(() => {});
        else {
          if (
            state === "connecting" &&
            this.links.get(peerId)?.link === link &&
            link.diagnostics().remoteDescription
          ) {
            const peer = this.peers.get(peerId);
            if (peer) delete peer.connectionError;
          }
          this.emit();
        }
      },
      message: (raw) =>
        void this.serial(() => this.receive(peerId, raw)).catch(() =>
          this.fail(
            "Rejected a network message whose identity or job contract did not match.",
          ),
        ),
      error: (message) => this.linkFailed(peerId, link, message),
      candidate: (sessionId, candidate) => {
        const entry = this.links.get(peerId);
        if (!entry || entry.link !== link || entry.candidateCount >= 128)
          return;
        entry.candidateCount++;
        entry.sessionId = sessionId;
        entry.candidates.push(candidate);
        entry.candidateHistory.push(candidate);
        this.flushCandidates(peerId);
      },
    });
    this.links.set(peerId, {
      link,
      startedAt: Date.now(),
      attempt: ++this.connectionSequence,
      candidates: [],
      candidateHistory: [],
      candidateCount: 0,
    });
    return link;
  }
  private closeLink(
    peerId: string,
    reason: ConnectionAttempt["reason"] = "superseded",
  ) {
    const entry = this.links.get(peerId);
    if (!entry) return;
    if (entry.candidateTimer) clearTimeout(entry.candidateTimer);
    const history = this.connectionHistory.get(peerId) ?? [];
    history.push({
      attempt: entry.attempt,
      startedAt: entry.startedAt,
      endedAt: Date.now(),
      reason,
      connection: structuredClone(
        entry.lastFailure ?? entry.link.diagnostics(),
      ),
    });
    this.connectionHistory.set(peerId, history.slice(-4));
    this.links.delete(peerId);
    entry.link.disconnect();
  }
  private linkFailed(peerId: string, link: PeerConnection, message?: string) {
    if (this.disposed || this.links.get(peerId)?.link !== link) return;
    const peer = this.peers.get(peerId);
    const entry = this.links.get(peerId)!;
    const diagnostics = link.diagnostics();
    if (
      diagnostics.iceState === "failed" ||
      diagnostics.transportState === "failed"
    )
      entry.lastFailure = structuredClone(diagnostics);
    if (peer) peer.connectionError = message ?? link.connectionFailure();
    this.emit();
  }
  private flushCandidates(peerId: string) {
    const entry = this.links.get(peerId),
      peer = this.peers.get(peerId),
      discovery = this.discovery;
    if (
      !entry ||
      !peer ||
      !discovery ||
      !entry.basePublished ||
      !entry.sessionId ||
      !entry.candidates.length ||
      entry.candidateTimer ||
      entry.link.connected
    )
      return;
    entry.candidateTimer = setTimeout(() => {
      entry.candidateTimer = undefined;
      if (
        this.disposed ||
        this.links.get(peerId) !== entry ||
        this.discovery !== discovery
      )
        return;
      const candidates = entry.candidates.splice(0, 8);
      entry.candidatesSentAt = Date.now();
      void discovery
        .connectivity(peer.nostrPublicKey, this.identity!.id, {
          type: "ice",
          sessionId: entry.sessionId!,
          candidates,
        })
        .catch(() =>
          this.linkFailed(
            peerId,
            entry.link,
            "Connection candidate update could not be sent through Nostr. Retrying connection setup.",
          ),
        );
      this.flushCandidates(peerId);
    }, 250);
  }
  private receiveCandidates(
    peerId: string,
    update: Extract<ConnectivityUpdate, { type: "ice" }>,
  ) {
    const entry = this.links.get(peerId);
    if (entry?.link.sessionId === update.sessionId) {
      void entry.link
        .addRemoteCandidates(update.sessionId, update.candidates)
        .catch(() => {});
      return;
    }
    // Ephemeral relays may deliver ICE before the corresponding invitation.
    const pending = (this.pendingIce.get(peerId) ?? []).filter(
      (p) => p.at > Date.now() - 45_000,
    );
    let session = pending.find((p) => p.sessionId === update.sessionId);
    if (!session) {
      if (pending.length >= 2) pending.shift();
      session = { sessionId: update.sessionId, candidates: [], at: Date.now() };
      pending.push(session);
    }
    session.candidates.push(
      ...update.candidates.slice(
        0,
        Math.max(0, 128 - session.candidates.length),
      ),
    );
    this.pendingIce.set(peerId, pending);
  }
  private drainCandidates(peerId: string) {
    const entry = this.links.get(peerId);
    const pending = this.pendingIce.get(peerId);
    if (!entry || !pending) return;
    for (const session of pending)
      if (
        session.sessionId === entry.link.sessionId &&
        session.at > Date.now() - 45_000
      )
        void entry.link
          .addRemoteCandidates(session.sessionId, session.candidates)
          .catch(() => {});
    const rest = pending.filter(
      (p) => p.sessionId !== entry.link.sessionId && p.at > Date.now() - 45_000,
    );
    if (rest.length) this.pendingIce.set(peerId, rest);
    else this.pendingIce.delete(peerId);
  }
  private retryCandidates(peerId: string) {
    const entry = this.links.get(peerId);
    if (
      !entry ||
      entry.link.connected ||
      entry.candidates.length ||
      !entry.candidateHistory.length ||
      Date.now() - (entry.candidatesSentAt ?? 0) < 12_000
    )
      return;
    entry.candidates = [...entry.candidateHistory];
    this.flushCandidates(peerId);
  }
  private async publishCode(peerId: string, code: string) {
    const entry = this.links.get(peerId),
      peer = this.peers.get(peerId),
      discovery = this.discovery;
    if (!entry || !peer || !discovery) return;
    entry.localCode = code;
    entry.signalAt = Date.now();
    await discovery.signal(peer.nostrPublicKey, this.identity!.id, code);
    if (
      this.disposed ||
      this.links.get(peerId) !== entry ||
      this.discovery !== discovery
    )
      return;
    entry.basePublished = true;
    entry.sessionId = entry.link.sessionId;
    this.drainCandidates(peerId);
    this.flushCandidates(peerId);
  }
  private ensureLink(peerId: string) {
    const peer = this.peers.get(peerId);
    if (!peer || !this.related(peer) || this.identity!.id > peerId) return;
    const existing = this.links.get(peerId);
    if (existing?.link.connected) return;
    if (existing && Date.now() - existing.startedAt < 60_000) {
      // Relay acceptance is not recipient delivery. Re-envelope the same signed
      // invitation so a receiver that subscribed late gets another opportunity.
      if (
        existing.localCode &&
        !existing.answered &&
        Date.now() - (existing.signalAt ?? 0) >= 12_000
      )
        void this.publishCode(peerId, existing.localCode).catch(() =>
          this.linkFailed(peerId, existing.link),
        );
      const diagnostics = existing.link.diagnostics();
      if (
        Date.now() - existing.startedAt > 25_000 &&
        !peer.connectionError &&
        (!diagnostics.remoteDescription ||
          diagnostics.iceState === "failed" ||
          diagnostics.transportState === "failed")
      )
        this.linkFailed(peerId, existing.link);
      return;
    }
    this.closeLink(peerId, "automatic-retry");
    const link = this.makeLink(peerId);
    delete peer.connectionError;
    const discovery = this.discovery;
    // ICE must never hold the durable ledger queue or block other volunteers.
    void link
      .createInvitation(this.iceSettings())
      .then(async (code) => {
        if (
          this.disposed ||
          this.discovery !== discovery ||
          this.links.get(peerId)?.link !== link
        )
          return;
        await this.publishCode(peerId, code);
      })
      .catch((error) =>
        this.linkFailed(
          peerId,
          link,
          error instanceof Error ? error.message : undefined,
        ),
      );
  }
  private iceSettings() {
    const {
      stun,
      turn = "",
      turnUsername = "",
      turnCredential = "",
    } = this.current.settings;
    return { stun, turn, username: turnUsername, credential: turnCredential };
  }
  private async signal(key: string, signal: ConnectivitySignal) {
    if (!this.current.settings.enabled) return;
    const peer = this.peers.get(signal.senderId);
    if (!peer) {
      const pending = this.pendingSignals.get(signal.senderId);
      if (pending && pending.key === key && pending.at > Date.now() - 45_000) {
        if (pending.signals.length < 16) pending.signals.push(signal);
      } else if (this.pendingSignals.size < 32) {
        this.pendingSignals.set(signal.senderId, {
          key,
          signals: [signal],
          at: Date.now(),
        });
      }
      return;
    }
    if (
      !peer ||
      peer.nostrPublicKey !== key ||
      peer.presence.expiresAt <= Date.now()
    )
      return;
    if (signal.version === 2) {
      if (signal.update.type === "ice")
        this.receiveCandidates(peer.id, signal.update);
      else if (this.identity!.id < peer.id && this.related(peer)) {
        const entry = this.links.get(peer.id);
        if (
          !entry?.link.connected &&
          (!entry || Date.now() - entry.startedAt >= 8_000)
        ) {
          this.closeLink(peer.id);
          this.ensureLink(peer.id);
        }
      }
      return;
    }
    const code = await decodePeerCode(signal.code);
    if (code.senderId !== peer.id || code.payload.type !== "pairing")
      throw new Error("Signal identity mismatch.");
    if (code.payload.pairing.kind === "offer") {
      if (peer.id > this.identity!.id) return; // Deterministic initiator prevents glare.
      const existing = this.links.get(peer.id);
      if (existing?.link.connected) return;
      if (existing?.offerCode === signal.code) {
        // A repeated offer means its answer may have been missed. Reuse the
        // established session instead of restarting ICE or duplicating jobs.
        if (
          existing.localCode &&
          Date.now() - (existing.signalAt ?? 0) >= 8_000
        )
          void this.publishCode(peer.id, existing.localCode).catch(() =>
            this.linkFailed(peer.id, existing.link),
          );
        return;
      }
      if ((existing?.offerAt ?? 0) >= code.payload.pairing.createdAt) return;
      this.closeLink(peer.id);
      const link = this.makeLink(peer.id);
      delete peer.connectionError;
      this.links.get(peer.id)!.offerCode = signal.code;
      this.links.get(peer.id)!.offerAt = code.payload.pairing.createdAt;
      const discovery = this.discovery;
      void link
        .joinInvitation(signal.code, this.iceSettings())
        .then(async (reply) => {
          if (
            this.disposed ||
            this.discovery !== discovery ||
            this.links.get(peer.id)?.link !== link
          )
            return;
          await this.publishCode(peer.id, reply);
        })
        .catch(() => this.linkFailed(peer.id, link));
    } else {
      const entry = this.links.get(peer.id);
      if (
        !entry ||
        entry.answered ||
        entry.link.connected ||
        code.payload.pairing.sessionId !== entry.link.sessionId
      )
        return;
      entry.answered = true;
      void entry.link.connectReply(signal.code).catch(() => {
        if (this.links.get(peer.id) !== entry) return;
        entry.answered = false;
        this.linkFailed(peer.id, entry.link);
      });
    }
  }
  private available() {
    return (
      (this.current.cooldownUntil ?? 0) <= Date.now() &&
      this.callbacks.available() &&
      !this.ledger.incoming.some(
        (e) =>
          e.status === "accepted" ||
          (e.status === "offered" &&
            this.assignment(e.envelope).expiresAt > Date.now()),
      )
    );
  }
  private async envelope(message: NetworkMessage) {
    return signPeerMessage(this.identity!, { type: "network", message });
  }
  private async send(peerId: string, envelope: SignedPeerMessage) {
    if (this.disposed) return false;
    // Local participation uses the same signed assignment/result/receipt path.
    // It needs no loopback socket, client, or second scientific implementation.
    if (peerId === this.identity?.id) {
      await this.receive(peerId, envelope);
      return true;
    }
    const link = this.links.get(peerId)?.link;
    if (!link?.connected || link.remoteId !== peerId) return false;
    const message =
      envelope.payload.type === "network"
        ? envelope.payload.message
        : undefined;
    const key = message
      ? `${message.kind}:${"leaseToken" in message ? message.leaseToken : ""}:${message.kind === "result" ? message.result.id : ""}`
      : envelope.id;
    let pending = this.sending.get(link);
    if (!pending) this.sending.set(link, (pending = new Set()));
    if (pending.has(key)) return true;
    pending.add(key);
    // The channel already preserves send order. Slow bulk transfers must not
    // block the ledger, result receipts or heartbeats to every other volunteer.
    // Durable assignments/results stay in the outbox until acknowledged.
    void link
      .send(envelope)
      .catch(() => this.linkFailed(peerId, link))
      .finally(() => pending!.delete(key));
    return true;
  }
  private async announce() {
    if (!this.current.settings.enabled || this.disposed) return;
    const issuedAt = Date.now();
    const message: NetworkPresence = {
      kind: "presence",
      networkVersion: NETWORK_VERSION,
      nostrPublicKey: this.nostrIdentity!.publicKey,
      issuedAt,
      expiresAt: issuedAt + 45_000,
      engine: {
        id: this.manifest.id as PeerJob["engine"]["id"],
        sourceSha: this.manifest.sourceSha as PeerJob["engine"]["sourceSha"],
        hashes: this.manifest.hashes as PeerJob["engine"]["hashes"],
      },
      protocols: this.manifest.supportedProtocols ?? [],
      automatic: this.current.settings.automatic,
      available: this.available(),
      campaigns: this.queue!.campaigns.filter(
        (c) => c.state === "active" && !!c.description,
      ).map((c) => ({
        id: c.id,
        protocol: c.protocol,
        ...(({ total, completed, waiting }) => ({
          total,
          completed,
          waiting,
        }))(campaignCounts(c)),
      })),
    };
    const envelope = await this.envelope(message);
    // Coalesce rapid job/progress/connection updates. Direct peers still get
    // fresh availability immediately; public relays get at most one per 10s.
    if (issuedAt - this.announcedAt >= 10_000) {
      this.announcedAt = issuedAt;
      if (this.announcementTimer) clearTimeout(this.announcementTimer);
      this.announcementTimer = undefined;
      this.discovery?.announce(envelope);
    } else if (!this.announcementTimer) {
      this.announcementTimer = setTimeout(
        () => {
          this.announcementTimer = undefined;
          void this.serial(() => this.announce()).catch(() => {});
        },
        10_000 - (issuedAt - this.announcedAt),
      );
    }
    for (const [id, { link }] of this.links)
      if (link.connected) {
        await this.send(id, envelope);
        // Research context stays on the direct encrypted link, not public relays.
        await this.send(
          id,
          await this.envelope({
            kind: "catalog",
            campaigns: this.queue!.campaigns.filter(
              (c) => c.state === "active" && !!c.description,
            ).map((c) => ({
              id: c.id,
              title: c.title,
              description: c.description!,
              protocol: c.protocol,
              ...(({ waiting, completed, total }) => ({
                waiting,
                completed,
                total,
              }))(campaignCounts(c)),
            })),
          }),
        );
      }
  }
  private volunteer(
    peer: NetworkPeer,
    automatic = peer.presence.automatic,
  ): VolunteerPresence {
    return {
      id: peer.id,
      seenAt: peer.seenAt,
      automatic,
      available: peer.presence.available,
      engine: peer.presence.engine,
      protocols: peer.presence.protocols,
    };
  }
  private async schedule() {
    if (!this.current.settings.enabled) return;
    const candidates = [...this.peers.values()]
      .filter(
        (p) =>
          p.presence.expiresAt > Date.now() &&
          this.links.get(p.id)?.link.connected,
      )
      .map((p) => this.volunteer(p));
    // Give already-online volunteers a brief chance to finish their direct
    // handshake before a warm local scorer consumes the whole new campaign.
    const waitingForLinks = this.queue!.campaigns.some(
      (c) =>
        c.state === "active" &&
        Date.now() - c.createdAt < 5_000 &&
        [...this.peers.values()].some(
          (p) =>
            p.presence.expiresAt > Date.now() &&
            p.presence.automatic &&
            p.presence.available &&
            p.presence.protocols.includes(c.protocol) &&
            !this.links.get(p.id)?.link.connected,
        ),
    );
    if (waitingForLinks && !this.scheduleTimer)
      this.scheduleTimer = setTimeout(() => {
        this.scheduleTimer = undefined;
        void this.tick().catch(() =>
          this.fail("Could not schedule saved work."),
        );
      }, 5_100);
    candidates.push({
      id: this.identity!.id,
      seenAt: Date.now(),
      automatic: true,
      available: !waitingForLinks && this.available(),
      engine: {
        id: this.manifest.id as PeerJob["engine"]["id"],
        sourceSha: this.manifest.sourceSha as PeerJob["engine"]["sourceSha"],
        hashes: this.manifest.hashes as PeerJob["engine"]["hashes"],
      },
      protocols: this.manifest.supportedProtocols ?? [],
    });
    const assignments = await this.queue!.assign(candidates);
    for (const assignment of assignments) await this.deliver(assignment);
  }
  private async deliver(a: Assignment) {
    await this.send(
      a.lease.workerId,
      await this.envelope({
        kind: "assignment",
        campaignId: a.campaignId,
        attemptId: a.attemptId,
        index: a.index,
        leaseToken: a.lease.token,
        expiresAt: a.lease.expiresAt,
        job: a.lease.job,
      }),
    );
  }
  async submit(input: {
    title: string;
    description: string;
    protocol: Protocol;
    seed: number;
    models: number;
    participateLocal?: boolean;
    inputPdb?: string;
    originalInput?: PeerJob["input"]["original"];
  }) {
    await this.initialize();
    return this.serial(async () => {
      const pdb = input.inputPdb ?? (await bundledTask(input.protocol)).pdb;
      const campaign = await this.queue!.submit({
        title: input.title,
        description: campaignDescriptionSchema.parse(input.description),
        protocol: input.protocol,
        seed: input.seed,
        models: input.models,
        participateLocal: input.participateLocal ?? true,
        input: {
          pdb,
          sha256: await peerSha256(pdb),
          ...(input.originalInput ? { original: input.originalInput } : {}),
        },
      });
      await this.announce();
      for (const id of this.peers.keys()) this.ensureLink(id);
      await this.schedule();
      this.emit();
      return campaign;
    });
  }
  async request(peerId: string, campaignId: string) {
    await this.initialize();
    return this.serial(async () => {
      if (!this.available())
        throw new Error(
          "Finish or stop the current calculation before requesting another.",
        );
      const key = peerId + ":" + campaignId;
      this.requested.set(key, Date.now() + 45_000);
      const sent = await this.send(
        peerId,
        await this.envelope({ kind: "request", campaignId }),
      );
      if (!sent) {
        this.requested.delete(key);
        throw new Error("The direct browser link is not ready yet.");
      }
    });
  }
  private async receive(peerId: string, raw: unknown) {
    const envelope = await verifyPeerMessage(raw, peerId);
    if (envelope.payload.type !== "network")
      throw new Error("Unexpected channel command.");
    const m = envelope.payload.message;
    if (
      !this.current.settings.enabled &&
      m.kind !== "result" &&
      m.kind !== "receipt"
    )
      return;
    if (m.kind === "presence") {
      const peer = this.peers.get(peerId);
      if (
        !peer ||
        m.nostrPublicKey !== peer.nostrPublicKey ||
        m.expiresAt <= Date.now() ||
        m.expiresAt - m.issuedAt !== 45_000 ||
        m.issuedAt > Date.now() + 30_000
      )
        throw new Error("Invalid direct presence.");
      if (m.issuedAt > peer.presence.issuedAt) {
        peer.presence = m;
        peer.seenAt = Date.now();
      }
      await this.schedule();
      this.emit();
      return;
    }
    if (m.kind === "catalog") {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      const ids = new Set<string>();
      for (const c of m.campaigns) {
        if (
          ids.has(c.id) ||
          c.waiting + c.completed > c.total ||
          !peer.presence.campaigns.some(
            (p) => p.id === c.id && p.protocol === c.protocol,
          )
        )
          throw new Error(
            "Research catalog differs from the publisher's live announcement.",
          );
        ids.add(c.id);
      }
      peer.campaigns = m.campaigns;
      this.emit();
      return;
    }
    if (m.kind === "request") {
      const peer = this.peers.get(peerId);
      if (!peer) return;
      const assignments = await this.queue!.assign(
        [this.volunteer(peer, true)],
        m.campaignId,
      );
      for (const a of assignments) await this.deliver(a);
      this.emit();
      return;
    }
    if (m.kind === "assignment") {
      const prior = this.ledger.incoming.find(
        (e) => this.assignment(e.envelope).job.id === m.job.id,
      );
      if (prior) {
        const previous = this.assignment(prior.envelope);
        if (
          prior.peerId !== peerId ||
          prior.hash !== (await hashPeerJob(m.job)) ||
          previous.leaseToken !== m.leaseToken ||
          previous.campaignId !== m.campaignId ||
          previous.attemptId !== m.attemptId ||
          previous.index !== m.index
        )
          throw new Error("Conflicting assignment.");
        if (prior.result) await this.send(peerId, prior.result);
        else if (prior.status === "released")
          await this.send(
            peerId,
            await this.envelope({
              kind: "release",
              campaignId: m.campaignId,
              attemptId: m.attemptId,
              leaseToken: m.leaseToken,
            }),
          );
        return;
      }
      await validatePeerJob(m.job, this.manifest);
      if (
        m.job.models !== 1 ||
        m.expiresAt <= Date.now() ||
        m.expiresAt > Date.now() + 150_000
      )
        throw new Error("Invalid assignment budget or expiry.");
      if (!this.available() || this.ledger.incoming.length >= 100) {
        await this.send(
          peerId,
          await this.envelope({
            kind: "release",
            campaignId: m.campaignId,
            attemptId: m.attemptId,
            leaseToken: m.leaseToken,
          }),
        );
        await this.announce();
        return;
      }
      if (!m.job.description)
        throw new Error(
          "A research description is required for new assignments.",
        );
      const entry: NetworkIncoming = {
        envelope,
        peerId,
        hash: await hashPeerJob(m.job),
        status: "offered",
      };
      this.ledger.incoming.unshift(entry);
      await this.persist();
      const requested = this.requested.get(peerId + ":" + m.campaignId) ?? 0;
      if (
        peerId === this.identity!.id ||
        this.current.settings.automatic ||
        requested > Date.now()
      ) {
        this.requested.delete(peerId + ":" + m.campaignId);
        await this.acceptWithin(entry);
      }
      return;
    }
    if (m.kind === "renew" || m.kind === "release") {
      if (m.kind === "renew")
        await this.queue!.renew(
          peerId,
          m.campaignId,
          m.attemptId,
          m.leaseToken,
          m.progress,
        );
      else {
        await this.queue!.release(
          peerId,
          m.campaignId,
          m.attemptId,
          m.leaseToken,
        );
        const peer = this.peers.get(peerId);
        if (peer) peer.presence.available = false;
      }
      this.emit();
      return;
    }
    if (m.kind === "result") {
      const receipt = await this.queue!.complete(
        peerId,
        m.campaignId,
        m.attemptId,
        m.leaseToken,
        m.result,
        envelope,
      );
      await this.send(
        peerId,
        await this.envelope({
          kind: "receipt",
          campaignId: m.campaignId,
          attemptId: m.attemptId,
          leaseToken: m.leaseToken,
          resultId: receipt.resultId,
          status: receipt.status,
        }),
      );
      await this.announce();
      await this.schedule();
      this.emit();
      return;
    }
    const entry = this.ledger.incoming.find((e) => {
      const a = this.assignment(e.envelope);
      return (
        e.peerId === peerId &&
        a.campaignId === m.campaignId &&
        a.attemptId === m.attemptId &&
        a.leaseToken === m.leaseToken
      );
    });
    if (
      !entry?.result ||
      entry.result.payload.type !== "network" ||
      entry.result.payload.message.kind !== "result" ||
      entry.result.payload.message.result.id !== m.resultId
    )
      throw new Error("Unknown result receipt.");
    if (entry.receipt && entry.receipt !== m.status)
      throw new Error("Conflicting receipt.");
    entry.receipt = m.status;
    await this.persist();
  }
  private async acceptWithin(entry: NetworkIncoming) {
    const m = this.assignment(entry.envelope);
    if (
      entry.status !== "offered" ||
      m.expiresAt <= Date.now() ||
      !this.callbacks.available()
    )
      throw new Error(
        "This assignment is expired or the computing tab is busy.",
      );
    entry.status = "accepted";
    await this.persist();
    // Acknowledge acceptance before potentially expensive WASM initialization.
    await this.send(
      entry.peerId,
      await this.envelope({
        kind: "renew",
        campaignId: m.campaignId,
        attemptId: m.attemptId,
        leaseToken: m.leaseToken,
        progress: { state: "loading", fraction: 0, snapshots: 0, elapsedMs: 0 },
      }),
    );
    try {
      await this.callbacks.accept(m.job, entry.hash);
    } catch (error) {
      entry.status = "released";
      await this.persist();
      await this.send(
        entry.peerId,
        await this.envelope({
          kind: "release",
          campaignId: m.campaignId,
          attemptId: m.attemptId,
          leaseToken: m.leaseToken,
        }),
      );
      throw error;
    }
    await this.announce();
    await this.retry(entry.peerId);
  }
  async accept(jobId: string) {
    await this.initialize();
    return this.serial(async () => {
      const entry = this.ledger.incoming.find(
        (e) => this.assignment(e.envelope).job.id === jobId,
      );
      if (!entry) throw new Error("Unknown assignment.");
      await this.acceptWithin(entry);
    });
  }
  async observe(snapshot: Snapshot) {
    await this.initialize();
    return this.serial(async () => {
      const stateKey = `${snapshot.state}:${snapshot.peerJobId ?? ""}`;
      if (
        snapshot.state === "complete" &&
        snapshot.peerJobId &&
        stateKey !== this.observedState
      ) {
        // Small Score jobs still cold-start Rosetta. Rest between automatic
        // assignments so a continuous queue does not become back-to-back starts.
        this.current.cooldownUntil = Date.now() + 30_000;
        if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
        this.cooldownTimer = setTimeout(() => {
          this.cooldownTimer = undefined;
          void this.tick().catch(() => {});
        }, 30_100);
      }
      if (snapshot.peerJobId) this.observedJobs.add(snapshot.peerJobId);
      if (
        snapshot.peerJobId &&
        [
          "loading",
          "running",
          "paused",
          "uploading",
          "complete",
          "error",
        ].includes(snapshot.state)
      ) {
        this.latestProgress = {
          jobId: snapshot.peerJobId,
          progress: {
            state: snapshot.state as NetworkProgress["state"],
            fraction: Math.max(
              0,
              Math.min(
                1,
                snapshot.total > 0 ? snapshot.completed / snapshot.total : 0,
              ),
            ),
            snapshots:
              snapshot.snapshotSequence ?? snapshot.frames?.length ?? 0,
            elapsedMs: Math.max(0, snapshot.elapsedMs),
            ...(Number.isFinite(snapshot.energy)
              ? { energy: snapshot.energy }
              : {}),
          },
        };
        if (Date.now() - this.progressSentAt >= 3_000) {
          this.progressSentAt = Date.now();
          for (const entry of this.ledger.incoming)
            if (
              entry.status === "accepted" &&
              this.assignment(entry.envelope).job.id === snapshot.peerJobId
            )
              await this.retry(entry.peerId);
        }
      }
      if (snapshot.state === "complete") await this.recover();
      for (const entry of this.ledger.incoming) {
        if (entry.status !== "accepted" || entry.result) continue;
        const a = this.assignment(entry.envelope);
        if (
          (!snapshot.peerJobId &&
            this.observedJobs.has(a.job.id) &&
            ["idle", "error"].includes(snapshot.state)) ||
          (snapshot.peerJobId === a.job.id && snapshot.state === "error")
        ) {
          entry.status = "released";
          await this.persist();
          await this.send(
            entry.peerId,
            await this.envelope({
              kind: "release",
              campaignId: a.campaignId,
              attemptId: a.attemptId,
              leaseToken: a.leaseToken,
            }),
          );
        }
      }
      if (stateKey !== this.observedState) {
        this.observedState = stateKey;
        await this.announce();
        await this.schedule();
      }
      this.emit();
    });
  }
  private async recover() {
    const pending = this.ledger.incoming.filter(
      (entry) => !entry.result && entry.status !== "released",
    );
    // A completed dashboard emits clock/resource updates indefinitely. Avoid
    // deserializing every saved PDB/trajectory again once delivery is durable,
    // or when this device has no incoming work to recover at all.
    if (!pending.length) return;
    const records = (await getState<Checkpoint[]>("browser-results")) ?? [];
    for (const entry of pending) {
      const a = this.assignment(entry.envelope);
      const record = records.find(
        (r) =>
          r.peer?.jobId === a.job.id &&
          r.peer.publisherId === entry.peerId &&
          r.peer.jobHash === entry.hash,
      );
      if (!record) continue;
      const model = record.batch?.models[0] ?? {
        task: record.task,
        result: record.result,
        history: record.history,
      };
      if (!model.result) continue;
      if (
        !record.engineManifest?.verified ||
        Object.entries(a.job.engine.hashes).some(
          ([name, hash]) => record.engineManifest?.hashes?.[name] !== hash,
        )
      )
        throw new Error("Completed model used a different scientific engine.");
      const result: PeerResult = {
        id: crypto.randomUUID(),
        jobId: a.job.id,
        inputSha256: a.job.input.sha256,
        engine: a.job.engine,
        completedAt: Date.now(),
        models: [
          {
            modelIndex: model.task.modelIndex,
            seed: model.task.seed,
            protocol: model.task.protocol,
            pdb: model.result.pdb,
            sha256: await peerSha256(model.result.pdb),
            energy: model.result.energy,
            elapsedMs: model.result.elapsedMs,
            history: (model.history ?? []).slice(-2000),
          },
        ],
      };
      await validatePeerResult(result, a.job);
      entry.result = await this.envelope({
        kind: "result",
        campaignId: a.campaignId,
        attemptId: a.attemptId,
        leaseToken: a.leaseToken,
        result,
      });
      entry.status = "complete";
      await this.persist();
      await this.send(entry.peerId, entry.result);
      await this.announce();
    }
  }
  private async retry(peerId: string) {
    for (const entry of this.ledger.incoming) {
      if (entry.peerId !== peerId || entry.receipt) continue;
      const a = this.assignment(entry.envelope);
      if (entry.status === "accepted" || entry.result)
        await this.send(
          peerId,
          await this.envelope({
            kind: "renew",
            campaignId: a.campaignId,
            attemptId: a.attemptId,
            leaseToken: a.leaseToken,
            ...(this.latestProgress?.jobId === a.job.id
              ? { progress: this.latestProgress.progress }
              : {}),
          }),
        );
      if (entry.result) await this.send(peerId, entry.result);
    }
    for (const c of this.queue!.campaigns)
      for (const a of c.attempts)
        if (
          a.lease?.workerId === peerId &&
          a.lease.expiresAt > Date.now() &&
          !a.lease.progress &&
          !a.outcome
        )
          await this.deliver({
            campaignId: c.id,
            attemptId: a.id,
            index: a.index,
            lease: a.lease,
          });
  }
  async tick() {
    await this.initialize();
    return this.serial(async () => {
      if (!this.current.settings.enabled) return;
      for (const [id, peer] of this.peers)
        if (peer.presence.expiresAt < Date.now() - 60_000) {
          this.closeLink(id, "expired");
          this.pendingIce.delete(id);
          this.connectionHistory.delete(id);
          this.peers.delete(id);
        }
      await this.recover();
      await this.announce();
      for (const id of this.peers.keys()) {
        this.ensureLink(id);
        this.retryCandidates(id);
        await this.retry(id);
      }
      await this.retry(this.identity!.id);
      await this.schedule();
      this.emit();
    });
  }
  async campaignState(id: string, state: "active" | "paused" | "cancelled") {
    await this.initialize();
    return this.serial(async () => {
      await this.queue!.setState(id, state);
      await this.announce();
      await this.schedule();
      this.emit();
    });
  }
  async removeCampaign(id: string) {
    await this.initialize();
    return this.serial(async () => {
      await this.queue!.remove(id, { cancelActive: true });
      // Publish the withdrawn catalog only after the deletion is durable.
      await this.announce();
      await this.schedule();
      this.emit();
    });
  }
  async retryConnections() {
    await this.initialize();
    return this.serial(async () => {
      if (!this.current.settings.enabled) return;
      for (const peer of this.peers.values()) {
        if (
          this.links.get(peer.id)?.link.connected ||
          peer.presence.expiresAt <= Date.now()
        )
          continue;
        this.closeLink(peer.id, "manual-retry");
        delete peer.connectionError;
        if (this.identity!.id < peer.id) this.ensureLink(peer.id);
        else
          await this.discovery?.connectivity(
            peer.nostrPublicKey,
            this.identity!.id,
            { type: "reconnect" },
          );
      }
      await this.announce();
      this.emit();
    });
  }
  connectionDiagnostics() {
    // Intentionally excludes addresses, SDP, identities, room, credentials and scientific data.
    const bundle =
      typeof document === "undefined"
        ? undefined
        : document
            .querySelector<HTMLScriptElement>('script[type="module"][src]')
            ?.src.split("/")
            .at(-1);
    return {
      schema: "rotab-connectivity-diagnostics-v2",
      runtimeBundle:
        bundle && /^index-[A-Za-z0-9_-]+\.js$/.test(bundle)
          ? bundle
          : undefined,
      checkedAt: new Date().toISOString(),
      relays: this.current.relays.map((r) => ({
        url: new URL(r.url).origin,
        state: r.state,
        accepted: !!r.acceptedAt,
      })),
      devices: this.current.peers.map((p, index) => ({
        device: index + 1,
        connected: p.connected,
        connection: p.connection,
        history: p.connectionHistory ?? [],
      })),
    };
  }
  async exportRecords() {
    await this.initialize();
    return this.serial(async () => ({
      schema: "rotab-network-record-v1",
      publisher: await this.queue!.exportRecords(),
      incoming: structuredClone(this.ledger.incoming),
      scientificValidation: "not-verified",
    }));
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.scheduleTimer) clearTimeout(this.scheduleTimer);
    if (this.announcementTimer) clearTimeout(this.announcementTimer);
    if (this.cooldownTimer) clearTimeout(this.cooldownTimer);
    this.discovery?.stop();
    for (const id of this.links.keys()) this.closeLink(id);
    this.pendingIce.clear();
    this.pendingSignals.clear();
    this.connectionHistory.clear();
  }
}
