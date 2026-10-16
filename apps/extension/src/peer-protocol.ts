import { z } from "zod";
import {
  ENGINE_ID,
  SOURCE_SHA,
  protocolSchema,
  validatePdb,
  prepareProteinPdb,
  validateResultIdentity,
  type EngineManifest,
} from "@rosettatab/shared";

/** Origin/integrity checks only. A valid signature is not scientific validation. */
export const PEER_WIRE_VERSION = 1;
// Transport memory budget, not a protein residue limit. Packets stay small.
export const MAX_PEER_MESSAGE_BYTES = 64 * 1024 * 1024;
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const time = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const elapsed = z.number().finite().min(0).max(86_400_000);
const seed = z.number().int().min(1).max(2_000_000_000);
const pdb = z.string().min(80);
export const MAX_CAMPAIGN_DESCRIPTION = 240;
export const campaignDescriptionSchema = z
  .string()
  .trim()
  .min(1, "Add a short research description.")
  .max(MAX_CAMPAIGN_DESCRIPTION);
export const NETWORK_VERSION = 3;
const engineSchema = z
  .object({
    id: z.literal(ENGINE_ID),
    sourceSha: z.literal(SOURCE_SHA),
    hashes: z
      .object({
        "rosetta.mjs": hash,
        "rosetta.wasm": hash,
        "rosetta.data": hash,
      })
      .strict(),
  })
  .strict();
const jobSchema = z
  .object({
    id: uuid,
    title: z
      .string()
      .min(1)
      .max(120)
      .refine((value) => value.trim().length > 0),
    // Optional only to keep pre-description signed experiment records readable.
    description: campaignDescriptionSchema.optional(),
    createdAt: time,
    expiresAt: time,
    publisherId: hash,
    engine: engineSchema,
    protocol: protocolSchema,
    seed,
    models: z.number().int().min(1).max(4),
    input: z
      .object({
        pdb,
        sha256: hash,
        original: z
          .object({
            pdb,
            sha256: hash,
            preparationPolicy: z.enum([
              "pdb-coordinate-preparation-v1",
              "pdb-protein-only-preparation-v2",
            ]),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict()
  .refine((job) => job.seed + job.models - 1 <= 2_000_000_000, {
    message: "Model seeds exceed the supported range.",
  })
  .refine((job) => job.expiresAt > job.createdAt, {
    message: "Job expiry must follow its creation.",
  });
const resultSchema = z
  .object({
    id: uuid,
    jobId: uuid,
    inputSha256: hash,
    engine: engineSchema,
    completedAt: time,
    models: z
      .array(
        z
          .object({
            modelIndex: z.number().int().min(0).max(3),
            seed,
            protocol: protocolSchema,
            pdb,
            sha256: hash,
            energy: z.number().finite(),
            elapsedMs: elapsed,
            history: z.array(z.number().finite()).max(2_000),
          })
          .strict(),
      )
      .min(1)
      .max(4),
  })
  .strict();
export type PeerEngine = z.infer<typeof engineSchema>;
export type PeerJob = z.infer<typeof jobSchema>;
export type PeerResult = z.infer<typeof resultSchema>;
export {
  engineSchema as peerEngineSchema,
  jobSchema as peerJobSchema,
  resultSchema as peerResultSchema,
};

const binding = { campaignId: uuid, attemptId: uuid, leaseToken: uuid };
export const networkProgressSchema = z
  .object({
    state: z.enum([
      "loading",
      "running",
      "paused",
      "uploading",
      "complete",
      "error",
    ]),
    fraction: z.number().min(0).max(1),
    snapshots: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    elapsedMs: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
    energy: z.number().finite().optional(),
  })
  .strict();
export type NetworkProgress = z.infer<typeof networkProgressSchema>;
const campaignInfoSchema = z
  .object({
    id: uuid,
    title: z.string().trim().min(1).max(120),
    description: campaignDescriptionSchema,
    protocol: protocolSchema,
    waiting: z.number().int().min(0).max(1000),
    completed: z.number().int().min(0).max(1000),
    total: z.number().int().min(1).max(1000),
  })
  .strict();
export type NetworkCampaignInfo = z.infer<typeof campaignInfoSchema>;
export const networkMessageSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("catalog"),
      campaigns: z.array(campaignInfoSchema).max(20),
    })
    .strict(),
  z.object({ kind: z.literal("request"), campaignId: uuid }).strict(),
  z
    .object({
      kind: z.literal("presence"),
      networkVersion: z.literal(NETWORK_VERSION),
      nostrPublicKey: hash,
      issuedAt: time,
      expiresAt: time,
      engine: engineSchema,
      protocols: z.array(protocolSchema).max(32),
      automatic: z.boolean(),
      available: z.boolean(),
      campaigns: z
        .array(
          z
            .object({
              id: uuid,
              protocol: protocolSchema,
              waiting: z.number().int().min(0).max(1000),
              completed: z.number().int().min(0).max(1000),
              total: z.number().int().min(1).max(1000),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
  z
    .object({
      kind: z.literal("assignment"),
      ...binding,
      index: z.number().int().min(0).max(999),
      expiresAt: time,
      job: jobSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("renew"),
      ...binding,
      progress: networkProgressSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal("release"), ...binding }).strict(),
  z
    .object({ kind: z.literal("result"), ...binding, result: resultSchema })
    .strict(),
  z
    .object({
      kind: z.literal("receipt"),
      ...binding,
      resultId: uuid,
      status: z.enum(["received", "obsolete"]),
    })
    .strict(),
]);
export type NetworkMessage = z.infer<typeof networkMessageSchema>;
export type NetworkPresence = Extract<NetworkMessage, { kind: "presence" }>;

const payloadSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("network"), message: networkMessageSchema })
    .strict(),
  z
    .object({
      type: z.literal("pairing"),
      pairing: z
        .object({
          kind: z.enum(["offer", "answer"]),
          sessionId: uuid,
          replyTo: uuid.optional(),
          description: z
            .object({
              type: z.enum(["offer", "answer"]),
              sdp: z.string().min(1).max(100_000),
            })
            .strict(),
          createdAt: time,
          expiresAt: time,
        })
        .strict()
        .refine(
          (pairing) =>
            pairing.kind === pairing.description.type &&
            pairing.expiresAt > pairing.createdAt &&
            pairing.expiresAt - pairing.createdAt <= 30 * 60_000 &&
            (pairing.kind === "answer"
              ? !!pairing.replyTo
              : pairing.replyTo === undefined),
          {
            message: "Pairing description, reply binding or expiry is invalid.",
          },
        ),
    })
    .strict(),
  z.object({ type: z.literal("job"), job: jobSchema }).strict(),
  z.object({ type: z.literal("result"), result: resultSchema }).strict(),
  z
    .object({ type: z.literal("receipt"), jobId: uuid, resultId: uuid })
    .strict(),
  z
    .object({
      type: z.literal("progress"),
      jobId: uuid,
      state: z.string().min(1).max(40),
      completed: z.number().finite().min(0).max(1_000_000_000),
      total: z.number().finite().min(0).max(1_000_000_000),
      elapsedMs: elapsed,
    })
    .strict()
    .refine((value) => value.completed <= value.total),
  z.object({ type: z.literal("hello"), peerId: hash }).strict(),
]);
export type PeerPayload = z.infer<typeof payloadSchema>;

// Only public P-256 material is admitted; in particular a JWK private `d` is rejected.
const publicKeySchema = z
  .object({
    kty: z.literal("EC"),
    crv: z.literal("P-256"),
    x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    ext: z.literal(true).optional(),
    key_ops: z.tuple([z.literal("verify")]).optional(),
    alg: z.literal("ES256").optional(),
  })
  .strict();
const unsignedSchema = z
  .object({
    version: z.literal(PEER_WIRE_VERSION),
    id: uuid,
    senderId: hash,
    publicKey: publicKeySchema,
    payload: payloadSchema,
  })
  .strict();
const signedSchema = unsignedSchema
  .extend({
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();
export type SignedPeerMessage = z.infer<typeof signedSchema>;
export interface PeerIdentity {
  id: string;
  publicKey: JsonWebKey;
  privateKey: CryptoKey;
}

/** Canonical JSON for signatures: sorted object keys, original array order, finite numbers. */
export function canonicalStringify(value: unknown): string {
  const seen = new Set<object>();
  const encode = (item: unknown, depth: number): string => {
    if (depth > 64) throw new Error("Peer document is nested too deeply.");
    if (item === null || typeof item === "string" || typeof item === "boolean")
      return JSON.stringify(item);
    if (typeof item === "number" && Number.isFinite(item))
      return JSON.stringify(item);
    if (typeof item !== "object" || item === null)
      throw new Error("Peer documents must contain JSON values only.");
    if (seen.has(item)) throw new Error("Peer document contains a cycle.");
    seen.add(item);
    let encoded: string;
    if (Array.isArray(item))
      encoded =
        "[" + item.map((entry) => encode(entry, depth + 1)).join(",") + "]";
    else {
      if (
        Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null
      )
        throw new Error("Peer documents must contain plain JSON objects only.");
      encoded =
        "{" +
        Object.keys(item)
          .sort()
          .map(
            (key) =>
              JSON.stringify(key) +
              ":" +
              encode((item as Record<string, unknown>)[key], depth + 1),
          )
          .join(",") +
        "}";
    }
    seen.delete(item);
    return encoded;
  };
  return encode(value, 0);
}
const bytes = (text: string) => new TextEncoder().encode(text);
function checkSize(text: string) {
  if (bytes(text).byteLength > MAX_PEER_MESSAGE_BYTES)
    throw new Error(
      "Peer transfer exceeds the 64 MiB connection memory budget. The local input is retained; send fewer models per job.",
    );
}
export async function peerSha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function normalizedPublicKey(value: unknown): JsonWebKey {
  const key = publicKeySchema.parse(value);
  return { kty: key.kty, crv: key.crv, x: key.x, y: key.y };
}
export async function identityId(publicKey: JsonWebKey): Promise<string> {
  const normalized = normalizedPublicKey(publicKey);
  // Import also checks that x/y form a real point on the P-256 curve.
  await crypto.subtle.importKey(
    "jwk",
    normalized,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  return peerSha256(canonicalStringify(normalized));
}
export async function generatePeerIdentity(): Promise<PeerIdentity> {
  const pair = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const publicKey = normalizedPublicKey(
    await crypto.subtle.exportKey("jwk", pair.publicKey),
  );
  return {
    id: await identityId(publicKey),
    publicKey,
    privateKey: pair.privateKey,
  };
}
export function publicIdentity(identity: PeerIdentity): {
  id: string;
  publicKey: JsonWebKey;
} {
  return {
    id: identity.id,
    publicKey: normalizedPublicKey(identity.publicKey),
  };
}
function base64url(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function signatureBytes(value: string): Uint8Array<ArrayBuffer> {
  const decoded = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "==");
  const result = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  if (result.byteLength !== 64 || base64url(result.buffer) !== value)
    throw new Error("Invalid peer signature encoding.");
  return result;
}
function checkSender(message: { senderId: string; payload: PeerPayload }) {
  if (
    message.payload.type === "network" &&
    message.payload.message.kind === "assignment" &&
    message.payload.message.job.publisherId !== message.senderId
  )
    throw new Error("Assignment publisher differs from its sender.");
  if (
    message.payload.type === "hello" &&
    message.payload.peerId !== message.senderId
  )
    throw new Error("Hello identity differs from its sender.");
  if (
    message.payload.type === "job" &&
    message.payload.job.publisherId !== message.senderId
  )
    throw new Error("Job publisher differs from its sender.");
}
export async function signPeerMessage(
  identity: PeerIdentity,
  payload: PeerPayload,
): Promise<SignedPeerMessage> {
  if (
    identity.privateKey.extractable ||
    identity.privateKey.type !== "private" ||
    identity.privateKey.algorithm.name !== "ECDSA" ||
    (identity.privateKey.algorithm as EcKeyAlgorithm).namedCurve !== "P-256"
  )
    throw new Error(
      "Peer signing requires a nonextractable P-256 private key.",
    );
  if ((await identityId(identity.publicKey)) !== identity.id)
    throw new Error(
      "Local peer identity fingerprint does not match its public key.",
    );
  const unsigned = unsignedSchema.parse({
    version: PEER_WIRE_VERSION,
    id: crypto.randomUUID(),
    senderId: identity.id,
    publicKey: normalizedPublicKey(identity.publicKey),
    payload,
  });
  checkSender(unsigned);
  const document = canonicalStringify(unsigned);
  checkSize(document);
  const signature = base64url(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      bytes(document),
    ),
  );
  const message = { ...unsigned, signature };
  checkSize(canonicalStringify(message));
  return message;
}
export async function verifyPeerMessage(
  raw: unknown,
  expectedPeerId?: string,
): Promise<SignedPeerMessage> {
  if (expectedPeerId !== undefined) hash.parse(expectedPeerId);
  const text = typeof raw === "string" ? raw : canonicalStringify(raw);
  checkSize(text);
  const message = signedSchema.parse(
    typeof raw === "string" ? JSON.parse(raw) : raw,
  );
  if (expectedPeerId === undefined && message.payload.type !== "pairing")
    throw new Error(
      "A pinned peer identity is required for non-pairing messages.",
    );
  const peerId = expectedPeerId ?? message.senderId;
  if (
    message.senderId !== peerId ||
    (await identityId(message.publicKey)) !== peerId
  )
    throw new Error("Peer message does not match the pinned peer identity.");
  const { signature, ...unsigned } = message;
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    normalizedPublicKey(message.publicKey),
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    signatureBytes(signature),
    bytes(canonicalStringify(unsigned)),
  );
  if (!valid) throw new Error("Peer signature verification failed.");
  checkSender(message);
  return message;
}

/** Admit only the same measured local scientific build and bounded coordinate adapters. */
export async function validatePeerJob(
  raw: unknown,
  manifest: EngineManifest,
  options: { now?: number } = {},
): Promise<PeerJob> {
  checkSize(canonicalStringify(raw));
  const job = jobSchema.parse(raw);
  const now = options.now ?? Date.now();
  if (job.expiresAt <= now) throw new Error("Peer job has expired.");
  if (job.createdAt > now + 5 * 60_000)
    throw new Error("Peer job creation time is in the future.");
  if (
    !manifest.verified ||
    manifest.id !== job.engine.id ||
    manifest.sourceSha !== job.engine.sourceSha
  )
    throw new Error(
      "Peer job requires a different or unverified scientific engine.",
    );
  if (!manifest.supportedProtocols?.includes(job.protocol))
    throw new Error(
      "Peer job protocol is unavailable in the verified local engine.",
    );
  for (const name of Object.keys(job.engine.hashes) as Array<
    keyof PeerEngine["hashes"]
  >)
    if (manifest.hashes?.[name] !== job.engine.hashes[name])
      throw new Error(
        "Peer job engine/database hash differs from the local build.",
      );
  validatePdb(job.input.pdb);
  if ((await peerSha256(job.input.pdb)) !== job.input.sha256)
    throw new Error(
      "Peer job input hash does not match its exact coordinate bytes.",
    );
  if (job.input.original) {
    if (
      (await peerSha256(job.input.original.pdb)) !== job.input.original.sha256
    )
      throw new Error("Original upload hash does not match its bytes.");
    if (prepareProteinPdb(job.input.original.pdb).pdb !== job.input.pdb)
      throw new Error(
        "Prepared target does not match the declared preparation policy.",
      );
  }
  return job;
}

export const hashPeerJob = (job: PeerJob) =>
  peerSha256(canonicalStringify(jobSchema.parse(job)));

/** Integrity/admission checks; reported energy and work performed remain unverified. */
export async function validatePeerResult(
  raw: unknown,
  inputJob: PeerJob,
): Promise<PeerResult> {
  checkSize(canonicalStringify(raw));
  const job = jobSchema.parse(inputJob);
  const result = resultSchema.parse(raw);
  if (result.jobId !== job.id || result.inputSha256 !== job.input.sha256)
    throw new Error("Peer result does not belong to the expected job/input.");
  if (canonicalStringify(result.engine) !== canonicalStringify(job.engine))
    throw new Error("Peer result scientific engine differs from the job.");
  if (result.models.length !== job.models)
    throw new Error(
      "Peer result must contain every requested model exactly once.",
    );
  const indices = new Set<number>();
  for (const model of result.models) {
    if (
      model.modelIndex >= job.models ||
      indices.has(model.modelIndex) ||
      model.seed !== job.seed + model.modelIndex ||
      model.protocol !== job.protocol
    )
      throw new Error(
        "Peer result model index, seed or protocol differs from the job.",
      );
    indices.add(model.modelIndex);
    validatePdb(model.pdb);
    validateResultIdentity(job.input.pdb, model.pdb, job.protocol);
    if ((await peerSha256(model.pdb)) !== model.sha256)
      throw new Error(
        "Peer result output hash does not match its exact coordinate bytes.",
      );
  }
  return result;
}
