import { z } from "zod";
import {
  protocolSchema,
  type EngineManifest,
  type Protocol,
} from "@rosettatab/shared";
import {
  canonicalStringify,
  campaignDescriptionSchema,
  peerEngineSchema,
  peerJobSchema,
  peerResultSchema,
  peerSha256,
  validatePeerJob,
  validatePeerResult,
  verifyPeerMessage,
  networkProgressSchema,
  type NetworkProgress,
  type PeerEngine,
  type PeerJob,
  type PeerResult,
  type SignedPeerMessage,
} from "./peer-protocol";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const seed = z.number().int().min(1).max(2_000_000_000);
export const CAMPAIGN_LEASE_MS = 120_000;
export const VOLUNTEER_PRESENCE_MS = 30_000;
const leaseSchema = z
  .object({
    token: uuid,
    workerId: hash,
    job: peerJobSchema,
    expiresAt: time,
    renewedAt: time,
    progress: networkProgressSchema.extend({ receivedAt: time }).optional(),
  })
  .strict();
const outcomeSchema = z
  .object({
    token: uuid,
    workerId: hash,
    job: peerJobSchema,
    result: peerResultSchema,
    hash,
    receivedAt: time,
    scientificValidation: z.literal("not-verified"),
    signedResult: z.unknown().optional(),
  })
  .strict();
const attemptSchema = z
  .object({
    id: uuid,
    index: z.number().int().min(0).max(999),
    seed,
    lease: leaseSchema.optional(),
    outcome: outcomeSchema.optional(),
  })
  .strict();
const campaignSchema = z
  .object({
    id: uuid,
    title: z.string().trim().min(1).max(120),
    description: campaignDescriptionSchema.optional(),
    publisherId: hash,
    createdAt: time,
    engine: peerEngineSchema,
    protocol: protocolSchema,
    input: peerJobSchema.shape.input,
    seed,
    models: z.number().int().min(1).max(1_000),
    participateLocal: z.boolean().optional(),
    state: z.enum(["active", "paused", "complete", "cancelled"]),
    attempts: z.array(attemptSchema).min(1).max(1_000),
  })
  .strict();
const ledgerSchema = z
  .object({
    version: z.literal(1),
    publisherId: hash,
    campaigns: z.array(campaignSchema).max(20),
    // Keep only connection identities after deletion. Without this, the lower
    // ID publisher cannot initiate a reconnect for a volunteer's late outbox.
    retiredWorkers: z.array(hash).max(128).optional(),
  })
  .strict();
type Ledger = z.infer<typeof ledgerSchema>;
export type Campaign = z.infer<typeof campaignSchema>;
export type CampaignLease = z.infer<typeof leaseSchema>;
export interface VolunteerPresence {
  id: string;
  /** Receipt time on this coordinator; do not trust a remote wall clock. */
  seenAt: number;
  automatic: boolean;
  available: boolean;
  engine: PeerEngine;
  protocols: Protocol[];
}
export interface Assignment {
  campaignId: string;
  attemptId: string;
  index: number;
  lease: CampaignLease;
}
export interface CampaignStore {
  read(): Promise<unknown>;
  write(ledger: Ledger): Promise<void>;
}
export interface ResultReceipt {
  campaignId: string;
  attemptId: string;
  token: string;
  resultId: string;
  status: "received" | "obsolete";
}

export function campaignCounts(campaign: Campaign, now = Date.now()) {
  const completed = campaign.attempts.filter((a) => a.outcome).length;
  const assigned = campaign.attempts.filter(
    (a) => !a.outcome && a.lease && a.lease.expiresAt > now,
  ).length;
  return {
    total: campaign.models,
    completed,
    assigned,
    waiting: campaign.models - completed - assigned,
  };
}

/**
 * A publisher-tab-owned queue. Transport supplies authenticated peer identities;
 * this class never discovers peers, opens sockets, or executes scientific work.
 * Only the Web Lock owner may create an instance for this browser's store.
 */
export class CampaignQueue {
  private ledger: Ledger;
  private action: Promise<unknown> = Promise.resolve();
  private ready?: Promise<void>;
  constructor(
    readonly publisherId: string,
    readonly manifest: EngineManifest,
    private readonly store: CampaignStore,
    private readonly clock = () => Date.now(),
  ) {
    hash.parse(publisherId);
    this.ledger = { version: 1, publisherId, campaigns: [] };
  }
  get campaigns(): Campaign[] {
    return structuredClone(this.ledger.campaigns);
  }
  get retiredWorkerIds(): string[] {
    return [...(this.ledger.retiredWorkers ?? [])];
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.action.catch(() => {}).then(operation);
    this.action = next.catch(() => {});
    return next;
  }
  initialize(): Promise<void> {
    return (this.ready ??= this.serial(async () => {
      const saved = await this.store.read();
      if (saved === undefined || saved === null) return;
      const ledger = ledgerSchema.parse(saved);
      if (ledger.publisherId !== this.publisherId)
        throw new Error(
          "Campaign records belong to a different browser identity.",
        );
      const campaignIds = new Set<string>(),
        attemptIds = new Set<string>(),
        jobIds = new Set<string>();
      for (const campaign of ledger.campaigns) {
        if (
          campaign.publisherId !== this.publisherId ||
          campaignIds.has(campaign.id) ||
          campaign.attempts.length !== campaign.models
        )
          throw new Error(
            "Saved campaign identity or model count is inconsistent.",
          );
        campaignIds.add(campaign.id);
        // Historical records must remain exportable after a build upgrade. New
        // assignments still pass current-engine admission below.
        await validatePeerJob(
          this.referenceJob(campaign),
          this.historicalManifest(campaign),
          { now: campaign.createdAt },
        );
        for (const [index, attempt] of campaign.attempts.entries()) {
          if (
            attemptIds.has(attempt.id) ||
            attempt.index !== index ||
            attempt.seed !== campaign.seed + index ||
            (attempt.lease && attempt.outcome)
          )
            throw new Error("Saved model attempts are inconsistent.");
          attemptIds.add(attempt.id);
          const record = attempt.lease ?? attempt.outcome;
          if (!record) continue;
          this.checkJob(campaign, attempt.index, record.job);
          if (jobIds.has(record.job.id))
            throw new Error("Saved assignment IDs are duplicated.");
          jobIds.add(record.job.id);
          if (
            attempt.lease &&
            (attempt.lease.renewedAt < record.job.createdAt ||
              attempt.lease.expiresAt <= attempt.lease.renewedAt)
          )
            throw new Error("Saved lease times are inconsistent.");
          if (attempt.outcome) {
            await validatePeerResult(attempt.outcome.result, record.job);
            if (attempt.outcome.signedResult)
              await this.checkSignedResult(
                attempt.outcome.signedResult,
                attempt.outcome.workerId,
                campaign.id,
                attempt.id,
                attempt.outcome.token,
                attempt.outcome.result,
              );
            if (
              (await this.resultHash(attempt.outcome.result)) !==
              attempt.outcome.hash
            )
              throw new Error("Saved result hash differs from its contents.");
          }
        }
        const finished = campaign.attempts.every((a) => a.outcome);
        if ((campaign.state === "complete") !== finished)
          throw new Error("Saved campaign completion is inconsistent.");
      }
      this.ledger = ledger;
    }));
  }
  private historicalManifest(campaign: Campaign): EngineManifest {
    return {
      ...this.manifest,
      ...campaign.engine,
      verified: true,
      supportedProtocols: [campaign.protocol],
    };
  }
  private referenceJob(campaign: Campaign): PeerJob {
    return {
      id: campaign.id,
      title: campaign.title,
      ...(campaign.description ? { description: campaign.description } : {}),
      publisherId: campaign.publisherId,
      createdAt: campaign.createdAt,
      expiresAt: campaign.createdAt + 86_400_000,
      engine: campaign.engine,
      protocol: campaign.protocol,
      seed: campaign.seed,
      models: 1,
      input: campaign.input,
    };
  }
  private checkJob(campaign: Campaign, index: number, job: PeerJob) {
    if (
      job.models !== 1 ||
      job.seed !== campaign.seed + index ||
      job.publisherId !== campaign.publisherId ||
      job.protocol !== campaign.protocol ||
      job.title !== campaign.title ||
      job.description !== campaign.description ||
      canonicalStringify(job.engine) !== canonicalStringify(campaign.engine) ||
      canonicalStringify(job.input) !== canonicalStringify(campaign.input)
    )
      throw new Error("Assignment differs from its campaign model/input.");
  }
  private resultHash(result: PeerResult) {
    return peerSha256(canonicalStringify(result));
  }
  private async checkSignedResult(
    raw: unknown,
    workerId: string,
    campaignId: string,
    attemptId: string,
    token: string,
    result: PeerResult,
  ) {
    const signed = await verifyPeerMessage(raw, workerId);
    if (
      signed.payload.type !== "network" ||
      signed.payload.message.kind !== "result"
    )
      throw new Error("Expected a signed network result.");
    const message = signed.payload.message;
    if (
      message.campaignId !== campaignId ||
      message.attemptId !== attemptId ||
      message.leaseToken !== token ||
      (await this.resultHash(message.result)) !==
        (await this.resultHash(result))
    )
      throw new Error("Signed result differs from its assignment/output.");
    return signed;
  }
  private async commit(next: Ledger) {
    // Persist before exposing or sending an assignment/receipt. A failed write
    // cannot leave an in-memory lease/result that disappears on reload.
    await this.store.write(structuredClone(next));
    this.ledger = next;
  }
  private async update<T>(operation: (next: Ledger) => Promise<T>): Promise<T> {
    await this.initialize();
    return this.serial(async () => {
      const next = structuredClone(this.ledger);
      const result = await operation(next);
      await this.commit(next);
      return result;
    });
  }
  async submit(input: {
    title: string;
    description: string;
    protocol: Protocol;
    seed: number;
    models: number;
    participateLocal?: boolean;
    input: PeerJob["input"];
  }): Promise<Campaign> {
    return this.update(async (next) => {
      if (next.campaigns.length >= 20)
        throw new Error(
          "Export and remove a finished campaign before adding another.",
        );
      const now = this.clock();
      const models = z.number().int().min(1).max(1_000).parse(input.models);
      const firstSeed = seed.parse(input.seed);
      seed.parse(firstSeed + models - 1);
      const campaign = campaignSchema.parse({
        id: crypto.randomUUID(),
        title: input.title,
        description: campaignDescriptionSchema.parse(input.description),
        publisherId: this.publisherId,
        createdAt: now,
        engine: {
          id: this.manifest.id,
          sourceSha: this.manifest.sourceSha,
          hashes: Object.fromEntries(
            ["rosetta.mjs", "rosetta.wasm", "rosetta.data"].map((name) => [
              name,
              this.manifest.hashes?.[name],
            ]),
          ),
        },
        protocol: input.protocol,
        input: input.input,
        seed: firstSeed,
        models,
        participateLocal: input.participateLocal ?? false,
        state: "active",
        attempts: Array.from({ length: models }, (_, index) => ({
          id: crypto.randomUUID(),
          index,
          seed: firstSeed + index,
        })),
      });
      await validatePeerJob(this.referenceJob(campaign), this.manifest, {
        now,
      });
      next.campaigns.unshift(campaign);
      return structuredClone(campaign);
    });
  }
  async assign(
    volunteers: VolunteerPresence[],
    campaignId?: string,
  ): Promise<Assignment[]> {
    return this.update(async (next) => {
      const now = this.clock(),
        assigned: Assignment[] = [];
      // One browser gets at most one assignment, even across campaigns. Local
      // Session separately refuses acceptance while another calculation exists.
      const occupied = new Set(
        next.campaigns.flatMap((c) =>
          c.attempts
            .filter((a) => a.lease && a.lease.expiresAt > now)
            .map((a) => a.lease!.workerId),
        ),
      );
      const seen = new Set<string>();
      for (const volunteer of volunteers) {
        if (
          !/^[a-f0-9]{64}$/.test(volunteer.id) ||
          seen.has(volunteer.id) ||
          occupied.has(volunteer.id) ||
          !volunteer.automatic ||
          !volunteer.available ||
          !Number.isSafeInteger(volunteer.seenAt) ||
          volunteer.seenAt > now ||
          now - volunteer.seenAt >= VOLUNTEER_PRESENCE_MS
        )
          continue;
        seen.add(volunteer.id);
        for (const campaign of next.campaigns) {
          if (campaignId && campaign.id !== campaignId) continue;
          if (
            (volunteer.id === this.publisherId && !campaign.participateLocal) ||
            campaign.state !== "active" ||
            !campaign.description ||
            !this.manifest.verified ||
            campaign.engine.id !== this.manifest.id ||
            campaign.engine.sourceSha !== this.manifest.sourceSha ||
            !this.manifest.supportedProtocols?.includes(campaign.protocol) ||
            Object.entries(campaign.engine.hashes).some(
              ([name, value]) => this.manifest.hashes?.[name] !== value,
            ) ||
            !volunteer.protocols.includes(campaign.protocol) ||
            canonicalStringify(volunteer.engine) !==
              canonicalStringify(campaign.engine)
          )
            continue;
          const attempt = campaign.attempts.find(
            (a) => !a.outcome && (!a.lease || a.lease.expiresAt <= now),
          );
          if (!attempt) continue;
          const job = await validatePeerJob(
            {
              ...this.referenceJob(campaign),
              id: crypto.randomUUID(),
              seed: attempt.seed,
              createdAt: now,
              expiresAt: now + 86_400_000,
            },
            this.manifest,
            { now },
          );
          attempt.lease = {
            token: crypto.randomUUID(),
            workerId: volunteer.id,
            job,
            renewedAt: now,
            expiresAt: now + CAMPAIGN_LEASE_MS,
          };
          assigned.push({
            campaignId: campaign.id,
            attemptId: attempt.id,
            index: attempt.index,
            lease: structuredClone(attempt.lease),
          });
          occupied.add(volunteer.id);
          break;
        }
      }
      return assigned;
    });
  }
  async renew(
    workerId: string,
    campaignId: string,
    attemptId: string,
    token: string,
    progress?: NetworkProgress,
  ): Promise<boolean> {
    return this.update(async (next) => {
      const campaign = next.campaigns.find((c) => c.id === campaignId);
      const lease = campaign?.attempts.find((a) => a.id === attemptId)?.lease;
      const now = this.clock();
      if (
        !campaign ||
        !["active", "paused"].includes(campaign.state) ||
        !lease ||
        lease.workerId !== workerId ||
        lease.token !== token
      )
        return false;
      lease.renewedAt = now;
      lease.expiresAt = now + CAMPAIGN_LEASE_MS;
      if (
        progress &&
        (!lease.progress || progress.elapsedMs >= lease.progress.elapsedMs)
      )
        lease.progress = {
          ...networkProgressSchema.parse(progress),
          receivedAt: now,
        };
      return true;
    });
  }
  async release(
    workerId: string,
    campaignId: string,
    attemptId: string,
    token: string,
  ): Promise<boolean> {
    return this.update(async (next) => {
      const attempt = next.campaigns
        .find((c) => c.id === campaignId)
        ?.attempts.find((a) => a.id === attemptId);
      if (
        !attempt?.lease ||
        attempt.lease.workerId !== workerId ||
        attempt.lease.token !== token
      )
        return false;
      delete attempt.lease;
      return true;
    });
  }
  async complete(
    workerId: string,
    campaignId: string,
    attemptId: string,
    token: string,
    raw: PeerResult,
    signedResult?: SignedPeerMessage,
  ): Promise<ResultReceipt> {
    return this.update(async (next) => {
      hash.parse(workerId);
      uuid.parse(token);
      uuid.parse(campaignId);
      uuid.parse(attemptId);
      const campaign = next.campaigns.find((c) => c.id === campaignId);
      const attempt = campaign?.attempts.find((a) => a.id === attemptId);
      const resultId = uuid.parse(raw.id);
      const receipt: ResultReceipt = {
        campaignId,
        attemptId,
        token,
        resultId,
        status: "obsolete",
      };
      // Removed campaigns have no retained coordinates or result ledger. Ack a
      // delayed signed return as obsolete so its worker can clear the outbox.
      if (!campaign) return receipt;
      if (!attempt) throw new Error("Result refers to an unknown model.");
      const prior = attempt.outcome;
      if (prior) {
        if (prior.token !== token || prior.workerId !== workerId)
          return receipt;
        await validatePeerResult(raw, prior.job);
        if ((await this.resultHash(raw)) !== prior.hash)
          throw new Error(
            "A different result was already recorded for this assignment.",
          );
        return { ...receipt, status: "received" };
      }
      const lease = attempt.lease;
      if (
        campaign.state === "cancelled" ||
        !lease ||
        lease.workerId !== workerId ||
        lease.token !== token
      )
        return receipt;
      // Expiry makes work eligible for reassignment. The current token remains
      // authoritative until replaced, so a delayed valid result is not lost.
      const result = await validatePeerResult(raw, lease.job);
      const proof = signedResult
        ? await this.checkSignedResult(
            signedResult,
            workerId,
            campaignId,
            attemptId,
            token,
            result,
          )
        : undefined;
      attempt.outcome = {
        token,
        workerId,
        job: lease.job,
        result,
        hash: await this.resultHash(result),
        receivedAt: this.clock(),
        scientificValidation: "not-verified",
        ...(proof ? { signedResult: proof } : {}),
      };
      delete attempt.lease;
      if (campaign.attempts.every((a) => a.outcome))
        campaign.state = "complete";
      return { ...receipt, status: "received" };
    });
  }
  async setState(
    id: string,
    state: "active" | "paused" | "cancelled",
  ): Promise<void> {
    return this.update(async (next) => {
      const campaign = next.campaigns.find((c) => c.id === id);
      if (!campaign) throw new Error("Unknown campaign.");
      if (campaign.state === "complete" || campaign.state === "cancelled")
        throw new Error("A finished campaign cannot be restarted.");
      campaign.state = state;
      if (state === "cancelled") {
        this.rememberWorkers(next, campaign);
        for (const attempt of campaign.attempts) delete attempt.lease;
      }
    });
  }
  private rememberWorkers(next: Ledger, campaign: Campaign) {
    next.retiredWorkers = [
      ...new Set([
        ...campaign.attempts.flatMap((attempt) => {
          const record = attempt.outcome ?? attempt.lease;
          return record ? [record.workerId] : [];
        }),
        ...(next.retiredWorkers ?? []),
      ]),
    ].slice(0, 128);
  }
  async remove(
    id: string,
    { cancelActive = false }: { cancelActive?: boolean } = {},
  ): Promise<void> {
    return this.update(async (next) => {
      const campaign = next.campaigns.find((c) => c.id === id);
      if (!campaign) throw new Error("Unknown campaign.");
      if (!cancelActive && !["complete", "cancelled"].includes(campaign.state))
        throw new Error("Only finished or cancelled campaigns can be removed.");
      // Explicit removal fences all leases and withdraws future work in the
      // same durable update, rather than exposing a half-completed cancellation.
      this.rememberWorkers(next, campaign);
      next.campaigns = next.campaigns.filter((c) => c.id !== id);
    });
  }
  async exportRecords(): Promise<unknown> {
    await this.initialize();
    return this.serial(async () => ({
      schema: "rotab-campaign-record-v1",
      exportedAt: this.clock(),
      ...structuredClone(this.ledger),
      scientificValidation: "not-verified",
    }));
  }
}
