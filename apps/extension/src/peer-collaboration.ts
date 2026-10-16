import {
  ENGINE_ID,
  SOURCE_SHA,
  type Checkpoint,
  type EngineManifest,
  type Protocol,
  type Snapshot,
} from "@rosettatab/shared";
import { bundledTask } from "./browser-tasks";
import { getState, putState } from "./storage";
import { loadPeerIdentity } from "./peer-identity";
import {
  PeerConnection,
  type PeerIceSettings,
  type PeerLinkState,
} from "./peer-connection";
import {
  canonicalStringify,
  campaignDescriptionSchema,
  hashPeerJob,
  peerSha256,
  signPeerMessage,
  validatePeerJob,
  validatePeerResult,
  verifyPeerMessage,
  type PeerIdentity,
  type PeerJob,
  type PeerResult,
  type SignedPeerMessage,
} from "./peer-protocol";

export interface PeerJobEntry {
  job: PeerJob;
  envelope: SignedPeerMessage;
  peerId: string;
  hash: string;
  direction: "sent" | "received";
  status: "offered" | "accepted" | "running" | "complete";
  progress?: {
    state: string;
    completed: number;
    total: number;
    elapsedMs: number;
  };
}
export interface PeerResultEntry {
  result: PeerResult;
  envelope: SignedPeerMessage;
  peerId: string;
  hash: string;
  direction: "sent" | "received";
  delivery: "pending" | "acknowledged" | "received";
  scientificValidation: "not-verified";
}
export interface PeerView {
  identityId?: string;
  remoteId?: string;
  state: PeerLinkState;
  path: "direct" | "relayed" | "unknown";
  jobs: PeerJobEntry[];
  results: PeerResultEntry[];
  error?: string;
}
type EventCode =
  | "identity-ready"
  | "connected"
  | "disconnected"
  | "connection-error"
  | "job-published"
  | "job-received"
  | "job-accepted"
  | "result-created"
  | "result-received"
  | "result-acknowledged"
  | "delivery-pending"
  | "message-rejected";
interface PeerEvent {
  code: EventCode;
  at: number;
  jobId?: string;
}
interface Ledger {
  version: 1;
  jobs: PeerJobEntry[];
  results: PeerResultEntry[];
  events: PeerEvent[];
}
const EVENT_CODES = new Set<EventCode>([
  "identity-ready",
  "connected",
  "disconnected",
  "connection-error",
  "job-published",
  "job-received",
  "job-accepted",
  "result-created",
  "result-received",
  "result-acknowledged",
  "delivery-pending",
  "message-rejected",
]);
const hashPattern = /^[a-f0-9]{64}$/;
const uuidPattern = /^[a-f0-9-]{36}$/i;
const progressStates = new Set([
  "idle",
  "accepted",
  "loading",
  "running",
  "paused",
  "uploading",
  "complete",
  "error",
  "unavailable",
  "waiting",
]);

/** Durable two-person orchestration around the existing Rosetta worker/session. */
export class PeerCollaboration {
  private identity?: PeerIdentity;
  private link?: PeerConnection;
  private ledger: Ledger = { version: 1, jobs: [], results: [], events: [] };
  private current: PeerView = {
    state: "idle",
    path: "unknown",
    jobs: [],
    results: [],
  };
  private action: Promise<unknown> = Promise.resolve();
  private initializing?: Promise<void>;
  private disposed = false;
  private accepting = false;
  private activePeerJob?: string;
  private lastProgress = new Map<string, number>();
  constructor(
    readonly manifest: EngineManifest,
    readonly callbacks: {
      update(view: PeerView): void;
      accept(job: PeerJob, jobHash: string): Promise<void>;
    },
  ) {}
  get view(): PeerView {
    return structuredClone(this.current);
  }
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.action
      .catch(() => {})
      .then(async () => {
        if (this.disposed) throw new Error("Peer collaboration was closed.");
        return work();
      });
    this.action = next.catch(() => {});
    return next;
  }
  private emit() {
    if (this.disposed) return;
    this.current.jobs = this.ledger.jobs;
    this.current.results = this.ledger.results;
    this.callbacks.update(this.view);
  }
  private event(code: EventCode, jobId?: string) {
    this.ledger.events.push({
      code,
      at: Date.now(),
      ...(jobId ? { jobId } : {}),
    });
    this.ledger.events = this.ledger.events.slice(-100);
  }
  private async persist() {
    if (this.disposed) throw new Error("Peer collaboration was closed.");
    await putState("peer-ledger", this.ledger);
    this.emit();
  }
  private rejectMessage() {
    this.current.error =
      "Rejected a peer message: its identity, integrity or admitted job contract did not match.";
    this.event("message-rejected");
    this.emit();
  }
  initialize(): Promise<void> {
    return (this.initializing ??= this.serial(async () => {
      const [savedIdentity, savedLedger] = await Promise.all([
        getState<PeerIdentity>("peer-identity"),
        getState<Ledger>("peer-ledger"),
      ]);
      if (!savedIdentity && savedLedger?.jobs?.length)
        throw new Error(
          "The saved peer identity is missing; existing experiment records were preserved.",
        );
      this.identity = await loadPeerIdentity();
      if (this.disposed) throw new Error("Peer collaboration was closed.");
      if (savedLedger) this.ledger = await this.readLedger(savedLedger);
      await this.reconcileCheckpoint();
      if (this.disposed) throw new Error("Peer collaboration was closed.");
      this.current.identityId = this.identity.id;
      this.link = new PeerConnection(this.identity, {
        status: (state, remoteId) => {
          void this.serial(async () => {
            this.current.state = state;
            this.current.remoteId = remoteId;
            this.current.path =
              state === "connected"
                ? await this.link!.connectionKind()
                : "unknown";
            this.current.error = undefined;
            this.event(state === "connected" ? "connected" : "disconnected");
            await this.persist();
            if (state === "connected" && remoteId) {
              await this.send(
                await signPeerMessage(this.identity!, {
                  type: "hello",
                  peerId: this.identity!.id,
                }),
                remoteId,
              );
              await this.retryWithin();
            }
          }).catch(() => {
            if (!this.disposed) {
              this.current.error =
                "The peer connection changed before delivery. Saved results remain available.";
              this.emit();
            }
          });
        },
        message: (raw) => {
          void this.serial(async () => {
            try {
              await this.receive(raw);
            } catch {
              this.rejectMessage();
              await this.persist();
            }
          }).catch(() => {});
        },
        error: () => {
          void this.serial(async () => {
            this.current.error =
              "The peer connection failed. Reconnect with fresh codes; saved work remains on this device.";
            this.event("connection-error");
            await this.persist();
          }).catch(() => {});
        },
      });
      this.event("identity-ready");
      await this.recoverCompletions();
      await this.persist();
    }));
  }
  private async readLedger(raw: Ledger): Promise<Ledger> {
    if (
      raw.version !== 1 ||
      !Array.isArray(raw.jobs) ||
      !Array.isArray(raw.results) ||
      raw.jobs.length > 20 ||
      raw.results.length > 20 ||
      !Array.isArray(raw.events)
    )
      throw new Error("The saved peer records failed their integrity checks.");
    const jobs: PeerJobEntry[] = [];
    const jobIds = new Set<string>();
    for (const entry of raw.jobs) {
      if (
        !["sent", "received"].includes(entry.direction) ||
        !["offered", "accepted", "running", "complete"].includes(
          entry.status,
        ) ||
        !hashPattern.test(entry.peerId) ||
        jobIds.has(entry.job.id)
      )
        throw new Error("The saved peer jobs failed their integrity checks.");
      const envelope = await verifyPeerMessage(
        entry.envelope,
        entry.direction === "sent" ? this.identity!.id : entry.peerId,
      );
      if (
        envelope.payload.type !== "job" ||
        canonicalStringify(envelope.payload.job) !==
          canonicalStringify(entry.job) ||
        (await hashPeerJob(entry.job)) !== entry.hash
      )
        throw new Error("The saved peer jobs failed their integrity checks.");
      jobIds.add(entry.job.id);
      jobs.push({
        job: envelope.payload.job,
        envelope,
        peerId: entry.peerId,
        hash: entry.hash,
        direction: entry.direction,
        status: entry.status,
      });
    }
    const results: PeerResultEntry[] = [];
    const resultIds = new Set<string>();
    for (const entry of raw.results) {
      const job = jobs.find(
        (candidate) =>
          candidate.job.id === entry.result.jobId &&
          candidate.peerId === entry.peerId &&
          candidate.direction !== entry.direction,
      );
      if (
        !job ||
        resultIds.has(entry.result.id) ||
        !["sent", "received"].includes(entry.direction) ||
        (entry.direction === "sent"
          ? !["pending", "acknowledged"].includes(entry.delivery)
          : entry.delivery !== "received")
      )
        throw new Error(
          "The saved peer results failed their integrity checks.",
        );
      const envelope = await verifyPeerMessage(
        entry.envelope,
        entry.direction === "sent" ? this.identity!.id : entry.peerId,
      );
      if (
        envelope.payload.type !== "result" ||
        canonicalStringify(envelope.payload.result) !==
          canonicalStringify(entry.result) ||
        (await peerSha256(canonicalStringify(entry.result))) !== entry.hash
      )
        throw new Error(
          "The saved peer results failed their integrity checks.",
        );
      await validatePeerResult(entry.result, job.job);
      resultIds.add(entry.result.id);
      results.push({
        result: entry.result,
        envelope,
        peerId: entry.peerId,
        hash: entry.hash,
        direction: entry.direction,
        delivery: entry.delivery,
        scientificValidation: "not-verified",
      });
    }
    const events = raw.events
      .filter(
        (entry) =>
          EVENT_CODES.has(entry.code) &&
          Number.isSafeInteger(entry.at) &&
          entry.at >= 0 &&
          (entry.jobId === undefined || uuidPattern.test(entry.jobId)),
      )
      .slice(-100)
      .map(({ code, at, jobId }) => ({
        code,
        at,
        ...(jobId ? { jobId } : {}),
      }));
    return { version: 1, jobs, results, events };
  }
  private ready() {
    if (!this.identity || !this.link || this.disposed)
      throw new Error("Peer collaboration is not ready.");
    return { identity: this.identity, link: this.link };
  }
  /** Session's durable checkpoint is proof of local explicit acceptance, never a request to auto-start. */
  private async reconcileCheckpoint() {
    const checkpoint = await getState<Checkpoint>("checkpoint");
    if (checkpoint?.taskSource !== "peer" || !checkpoint.peer) return;
    const entry = this.ledger.jobs.find(
      (candidate) =>
        candidate.direction === "received" &&
        candidate.job.id === checkpoint.peer!.jobId &&
        candidate.peerId === checkpoint.peer!.publisherId &&
        candidate.hash === checkpoint.peer!.jobHash,
    );
    if (
      !entry ||
      entry.status === "complete" ||
      checkpoint.peer.models !== entry.job.models ||
      checkpoint.task.jobId !== entry.job.id ||
      checkpoint.task.inputHash !== entry.job.input.sha256 ||
      !checkpoint.engineManifest?.verified ||
      checkpoint.engineManifest.id !== entry.job.engine.id ||
      checkpoint.engineManifest.sourceSha !== entry.job.engine.sourceSha ||
      Object.entries(entry.job.engine.hashes).some(
        ([name, hash]) => checkpoint.engineManifest?.hashes?.[name] !== hash,
      )
    )
      return;
    const models = checkpoint.batch?.models ?? [];
    if (
      models.length !== entry.job.models ||
      models.some(
        (model) =>
          model.task.jobId !== entry.job.id ||
          model.task.inputHash !== entry.job.input.sha256 ||
          model.task.protocol !== entry.job.protocol ||
          model.task.seed !== entry.job.seed + model.task.modelIndex,
      )
    )
      return;
    // The restored Session decides whether/when to resume; the collaboration layer only adopts provenance.
    entry.status = "accepted";
    this.activePeerJob = entry.job.id;
    entry.progress = {
      state: "paused",
      completed: models.filter((model) => model.result).length,
      total: entry.job.models,
      elapsedMs: Math.max(
        0,
        Math.min(86_400_000, Date.now() - checkpoint.startedAt),
      ),
    };
  }
  private remote() {
    const { link } = this.ready();
    if (!link.connected || !link.remoteId)
      throw new Error("Connect to a peer first.");
    return link.remoteId;
  }
  private async transport(
    work: (link: PeerConnection) => Promise<string | void>,
  ): Promise<string | void> {
    await this.initialize();
    try {
      return await work(this.ready().link);
    } catch {
      this.current.error =
        "Connection setup failed. Check the invitation/reply and create fresh codes if needed.";
      this.emit();
      throw new Error(this.current.error);
    }
  }
  async createInvitation(ice: PeerIceSettings): Promise<string> {
    return (await this.transport((link) =>
      link.createInvitation(ice),
    )) as string;
  }
  async joinInvitation(code: string, ice: PeerIceSettings): Promise<string> {
    return (await this.transport((link) =>
      link.joinInvitation(code, ice),
    )) as string;
  }
  async connectReply(code: string): Promise<void> {
    await this.transport((link) => link.connectReply(code));
  }
  disconnect() {
    this.link?.disconnect();
  }
  dispose() {
    this.disposed = true;
    this.link?.disconnect();
  }
  private roomForJob() {
    if (this.ledger.jobs.length < 20) return;
    const removable = this.ledger.jobs.findLastIndex(
      (entry) =>
        entry.status === "complete" &&
        !this.ledger.results.some(
          (result) =>
            result.result.jobId === entry.job.id &&
            result.delivery === "pending",
        ),
    );
    if (removable < 0)
      throw new Error(
        "Finish an outstanding peer job before adding more than 20 jobs.",
      );
    const [removed] = this.ledger.jobs.splice(removable, 1);
    this.ledger.results = this.ledger.results.filter(
      (entry) => entry.result.jobId !== removed.job.id,
    );
  }
  private roomForResult() {
    if (this.ledger.results.length < 20) return;
    const removable = this.ledger.results.findLastIndex(
      (entry) => entry.delivery !== "pending",
    );
    if (removable < 0)
      throw new Error(
        "Reconnect to deliver pending results before saving more than 20 results.",
      );
    this.ledger.results.splice(removable, 1);
  }
  private async send(
    envelope: SignedPeerMessage,
    peerId: string,
  ): Promise<boolean> {
    if (!this.link?.connected || this.link.remoteId !== peerId) return false;
    try {
      await this.link.send(envelope);
      return true;
    } catch {
      this.current.error =
        "Delivery is pending. Reconnect to the same peer and retry saved jobs/results.";
      this.event("delivery-pending");
      this.emit();
      return false;
    }
  }
  async publish(input: {
    title: string;
    description: string;
    protocol: Protocol;
    seed: number;
    models: number;
    useImported: boolean;
    inputPdb?: string;
    originalInput?: PeerJob["input"]["original"];
  }): Promise<void> {
    await this.initialize();
    return this.serial(async () => {
      const peerId = this.remote();
      const source =
        input.useImported && input.inputPdb !== undefined
          ? { pdb: input.inputPdb }
          : input.useImported
            ? (await getState<{ task: { pdb: string } }>("benchmark-input"))
                ?.task
            : await bundledTask(input.protocol);
      if (!source)
        throw new Error(
          "Import a coordinate target before choosing the imported target.",
        );
      const createdAt = Date.now();
      const job = await validatePeerJob(
        {
          id: crypto.randomUUID(),
          title: input.title,
          description: campaignDescriptionSchema.parse(input.description),
          createdAt,
          expiresAt: createdAt + 86_400_000,
          publisherId: this.identity!.id,
          engine: {
            id: ENGINE_ID,
            sourceSha: SOURCE_SHA,
            hashes: {
              "rosetta.mjs": this.manifest.hashes?.["rosetta.mjs"],
              "rosetta.wasm": this.manifest.hashes?.["rosetta.wasm"],
              "rosetta.data": this.manifest.hashes?.["rosetta.data"],
            },
          },
          protocol: input.protocol,
          seed: input.seed,
          models: input.models,
          input: {
            pdb: source.pdb,
            sha256: await peerSha256(source.pdb),
            ...(input.originalInput ? { original: input.originalInput } : {}),
          },
        },
        this.manifest,
      );
      const envelope = await signPeerMessage(this.identity!, {
        type: "job",
        job,
      });
      this.roomForJob();
      this.ledger.jobs.unshift({
        job,
        envelope,
        peerId,
        hash: await hashPeerJob(job),
        direction: "sent",
        status: "offered",
      });
      this.event("job-published", job.id);
      await this.persist();
      await this.send(envelope, peerId);
    });
  }
  async acceptJob(id: string): Promise<void> {
    await this.initialize();
    return this.serial(async () => {
      const entry = this.ledger.jobs.find(
        (candidate) =>
          candidate.job.id === id && candidate.direction === "received",
      );
      if (!entry || entry.status !== "offered")
        throw new Error("This peer job is not awaiting acceptance.");
      if (this.accepting || this.activePeerJob)
        throw new Error(
          "Finish or stop the accepted peer calculation before accepting another.",
        );
      await validatePeerJob(entry.job, this.manifest);
      this.accepting = true;
      try {
        await this.callbacks.accept(structuredClone(entry.job), entry.hash);
        this.activePeerJob = id;
        entry.status = "accepted";
        this.event("job-accepted", id);
        await this.persist();
        if (this.link?.remoteId === entry.peerId)
          await this.send(
            await signPeerMessage(this.identity!, {
              type: "progress",
              jobId: id,
              state: "accepted",
              completed: 0,
              total: entry.job.models,
              elapsedMs: 0,
            }),
            entry.peerId,
          );
      } finally {
        this.accepting = false;
      }
    });
  }
  async observe(snapshot: Snapshot): Promise<void> {
    await this.initialize();
    if (this.disposed) return;
    return this.serial(async () => {
      if (
        (!snapshot.peerJobId &&
          ["idle", "complete", "error"].includes(snapshot.state)) ||
        (snapshot.peerJobId === this.activePeerJob &&
          ["complete", "error"].includes(snapshot.state))
      )
        this.activePeerJob = undefined;
      if (!snapshot.peerJobId) return;
      const entry = this.ledger.jobs.find(
        (candidate) =>
          candidate.job.id === snapshot.peerJobId &&
          candidate.direction === "received",
      );
      if (!entry || entry.status === "offered") return;
      if (!["idle", "complete", "error"].includes(snapshot.state))
        this.activePeerJob = entry.job.id;
      if (snapshot.state === "complete") await this.recoverCompletions();
      const now = Date.now();
      if (
        snapshot.state !== "complete" &&
        now - (this.lastProgress.get(entry.job.id) ?? 0) < 1_000
      )
        return;
      this.lastProgress.set(entry.job.id, now);
      const progress = {
        state: snapshot.state,
        completed:
          snapshot.state === "complete"
            ? entry.job.models
            : Math.max(
                0,
                Math.min(entry.job.models, snapshot.completedModels ?? 0),
              ),
        total: entry.job.models,
        elapsedMs: Math.max(0, Math.min(86_400_000, snapshot.elapsedMs)),
      };
      entry.progress = progress;
      if (entry.status !== "complete") entry.status = "running";
      await this.persist();
      if (this.link?.remoteId === entry.peerId)
        await this.send(
          await signPeerMessage(this.identity!, {
            type: "progress",
            jobId: entry.job.id,
            ...progress,
          }),
          entry.peerId,
        );
    });
  }
  private async recoverCompletions() {
    const records = (await getState<Checkpoint[]>("browser-results")) ?? [];
    for (const checkpoint of records) {
      const entry = this.ledger.jobs.find(
        (candidate) =>
          candidate.direction === "received" &&
          candidate.job.id === checkpoint.peer?.jobId &&
          candidate.peerId === checkpoint.peer?.publisherId &&
          candidate.hash === checkpoint.peer?.jobHash,
      );
      if (
        !entry ||
        this.ledger.results.some(
          (result) =>
            result.direction === "sent" && result.result.jobId === entry.job.id,
        )
      )
        continue;
      const models = checkpoint.batch?.models ?? [
        {
          task: checkpoint.task,
          result: checkpoint.result,
          history: checkpoint.history,
        },
      ];
      if (
        models.length !== entry.job.models ||
        models.some((model) => !model.result)
      )
        continue;
      if (
        !checkpoint.engineManifest?.verified ||
        checkpoint.engineManifest.id !== entry.job.engine.id ||
        checkpoint.engineManifest.sourceSha !== entry.job.engine.sourceSha ||
        Object.entries(entry.job.engine.hashes).some(
          ([name, hash]) => checkpoint.engineManifest?.hashes?.[name] !== hash,
        )
      )
        throw new Error(
          "The completed peer result used a different scientific engine.",
        );
      const result: PeerResult = {
        id: crypto.randomUUID(),
        jobId: entry.job.id,
        inputSha256: checkpoint.task.inputHash,
        engine: structuredClone(entry.job.engine),
        completedAt: Date.now(),
        models: await Promise.all(
          models.map(async (model) => ({
            modelIndex: model.task.modelIndex,
            seed: model.task.seed,
            protocol: model.task.protocol,
            pdb: model.result!.pdb,
            sha256: await peerSha256(model.result!.pdb),
            energy: model.result!.energy,
            elapsedMs: model.result!.elapsedMs,
            history: (model.history ?? []).slice(-2_000),
          })),
        ),
      };
      await validatePeerResult(result, entry.job);
      const envelope = await signPeerMessage(this.identity!, {
        type: "result",
        result,
      });
      this.roomForResult();
      this.ledger.results.unshift({
        result,
        envelope,
        peerId: entry.peerId,
        hash: await peerSha256(canonicalStringify(result)),
        direction: "sent",
        delivery: "pending",
        scientificValidation: "not-verified",
      });
      entry.status = "complete";
      this.event("result-created", entry.job.id);
      await this.persist();
      if (this.link?.remoteId === entry.peerId)
        await this.send(envelope, entry.peerId);
    }
  }
  private async receive(raw: unknown) {
    const peerId = this.remote();
    const envelope = await verifyPeerMessage(raw, peerId);
    const payload = envelope.payload;
    if (payload.type === "pairing" || payload.type === "network")
      throw new Error("Pairing is not a channel command.");
    if (payload.type === "hello") return;
    if (payload.type === "job") {
      const job = await validatePeerJob(payload.job, this.manifest);
      const hash = await hashPeerJob(job);
      const prior = this.ledger.jobs.find((entry) => entry.job.id === job.id);
      if (prior) {
        if (
          prior.hash !== hash ||
          prior.peerId !== peerId ||
          prior.direction !== "received"
        )
          throw new Error("Conflicting peer job.");
        return;
      }
      this.roomForJob();
      this.ledger.jobs.unshift({
        job,
        envelope,
        peerId,
        hash,
        direction: "received",
        status: "offered",
      });
      this.event("job-received", job.id);
      await this.persist();
      return;
    }
    if (payload.type === "progress") {
      const entry = this.ledger.jobs.find(
        (candidate) =>
          candidate.job.id === payload.jobId &&
          candidate.direction === "sent" &&
          candidate.peerId === peerId,
      );
      if (
        !entry ||
        !progressStates.has(payload.state) ||
        payload.total !== entry.job.models ||
        !Number.isInteger(payload.completed)
      )
        throw new Error("Unknown peer progress.");
      entry.progress = {
        state: payload.state,
        completed: payload.completed,
        total: payload.total,
        elapsedMs: payload.elapsedMs,
      };
      if (entry.status !== "complete")
        entry.status = payload.state === "accepted" ? "accepted" : "running";
      await this.persist();
      return;
    }
    if (payload.type === "receipt") {
      const entry = this.ledger.results.find(
        (candidate) =>
          candidate.direction === "sent" &&
          candidate.result.id === payload.resultId &&
          candidate.result.jobId === payload.jobId &&
          candidate.peerId === peerId,
      );
      if (!entry) throw new Error("Unknown peer receipt.");
      if (entry.delivery !== "acknowledged") {
        entry.delivery = "acknowledged";
        this.event("result-acknowledged", payload.jobId);
        await this.persist();
      }
      return;
    }
    const entry = this.ledger.jobs.find(
      (candidate) =>
        candidate.direction === "sent" &&
        candidate.job.id === payload.result.jobId &&
        candidate.peerId === peerId,
    );
    if (!entry) throw new Error("Unknown peer result.");
    const result = await validatePeerResult(payload.result, entry.job);
    const hash = await peerSha256(canonicalStringify(result));
    const prior = this.ledger.results.find(
      (candidate) => candidate.result.id === result.id,
    );
    if (prior) {
      if (
        prior.hash !== hash ||
        prior.peerId !== peerId ||
        prior.direction !== "received"
      )
        throw new Error("Conflicting peer result.");
    } else {
      if (
        this.ledger.results.some(
          (candidate) =>
            candidate.result.jobId === result.jobId &&
            candidate.direction === "received",
        )
      )
        throw new Error("A result already exists for this job.");
      this.roomForResult();
      this.ledger.results.unshift({
        result,
        envelope,
        peerId,
        hash,
        direction: "received",
        delivery: "received",
        scientificValidation: "not-verified",
      });
      entry.status = "complete";
      this.event("result-received", result.jobId);
      await this.persist();
    }
    await this.send(
      await signPeerMessage(this.identity!, {
        type: "receipt",
        jobId: result.jobId,
        resultId: result.id,
      }),
      peerId,
    );
  }
  private async retryWithin() {
    if (!this.link?.connected || !this.link.remoteId) return;
    const peerId = this.link.remoteId;
    for (const entry of this.ledger.jobs)
      if (
        entry.direction === "sent" &&
        entry.peerId === peerId &&
        entry.status === "offered" &&
        entry.job.expiresAt > Date.now()
      )
        await this.send(entry.envelope, peerId);
    for (const entry of this.ledger.results)
      if (
        entry.direction === "sent" &&
        entry.peerId === peerId &&
        entry.delivery === "pending"
      )
        await this.send(entry.envelope, peerId);
  }
  async retry(): Promise<void> {
    await this.initialize();
    return this.serial(async () => {
      this.remote();
      await this.recoverCompletions();
      await this.retryWithin();
    });
  }
  async exportRecords(): Promise<unknown> {
    await this.initialize();
    return this.serial(async () => ({
      schema: "rosettatab-peer-record-v1",
      exportedAt: Date.now(),
      identityId: this.identity!.id,
      engine: {
        id: this.manifest.id,
        sourceSha: this.manifest.sourceSha,
        hashes: this.manifest.hashes,
      },
      jobs: structuredClone(this.ledger.jobs),
      results: structuredClone(this.ledger.results),
      events: structuredClone(this.ledger.events),
      scientificValidation: "not-verified",
    }));
  }
}
