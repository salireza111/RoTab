import { z } from "zod";
import { PROTOCOL_IDS, type Protocol } from "./protocols";
import { STANDARD_AMINO_ACIDS as AMINO } from "./protein-input";
export * from "./protocols";
export * from "./protein-input";

export const SOURCE_SHA = "369e400415dd5c585f80dcf7b647147ee520e8ba";
export const ENGINE_ID = "rosetta-protocols-v2";
export const PROJECT_URL = "https://boinc.bakerlab.org/rosetta/";
export const protocolSchema = z.enum(PROTOCOL_IDS);
export const jobInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    pdb: z.string().min(80),
    protocol: protocolSchema,
    models: z.number().int().min(1).max(20),
    seed: z.number().int().min(1).max(2_000_000_000),
  })
  .strict()
  .refine((input) => input.seed + input.models - 1 <= 2_000_000_000, {
    message: "Model seeds exceed the supported range.",
    path: ["seed"],
  });
export type JobInput = z.infer<typeof jobInputSchema>;
export const claimSchema = z
  .object({
    clientId: z.string().uuid(),
    engineId: z.literal(ENGINE_ID),
    sourceSha: z.literal(SOURCE_SHA),
  })
  .strict();
export const completionSchema = z
  .object({
    attemptToken: z.string().uuid(),
    pdb: z.string().min(80),
    energy: z.number().finite(),
    elapsedMs: z.number().finite().min(0).max(86_400_000),
    engineId: z.literal(ENGINE_ID),
    sourceSha: z.literal(SOURCE_SHA),
  })
  .strict();
export type Completion = z.infer<typeof completionSchema>;
export type TaskState =
  "queued" | "leased" | "validating" | "accepted" | "rejected";
export interface Task {
  id: string;
  jobId: string;
  title: string;
  description?: string;
  protocol: Protocol;
  inputHash: string;
  pdb: string;
  seed: number;
  modelIndex: number;
  engineId: typeof ENGINE_ID;
  sourceSha: typeof SOURCE_SHA;
  state: TaskState;
  attemptToken: string | null;
  clientId: string | null;
  leaseUntil: number | null;
  result: {
    pdb: string;
    energy: number;
    nativeEnergy: number;
    elapsedMs: number;
  } | null;
  rejection: string | null;
  completionHash?: string;
}
export interface Job {
  id: string;
  title: string;
  createdAt: number;
  tasks: Task[];
}
export type Availability = "available" | "unavailable" | "restricted" | "stale";
export interface Metric {
  name: string;
  value: number | null;
  unit: "%" | "bytes" | "°C" | "W" | "RPM";
  scope: string;
  source: string;
  timestamp: number;
  availability: Availability;
}
/** Coordinates emitted by a real scientific callback, aligned to retained energy history. */
export interface StructureSnapshot {
  id: string;
  sequence: number;
  pdb: string;
  energy: number;
  elapsedMs: number;
  source?: "initial" | "stage" | "minimizing" | "packing" | "final";
  step?: number;
  historyIndex: number;
}
export interface Snapshot {
  state:
    | "idle"
    | "loading"
    | "running"
    | "paused"
    | "uploading"
    | "complete"
    | "error"
    | "unavailable"
    | "waiting";
  mode: "browser" | "native";
  taskSource?: "bundled" | "benchmark" | "research" | "peer";
  peerJobId?: string;
  taskId?: string;
  title?: string;
  description?: string;
  publisherId?: string;
  protocol?: string;
  pdb?: string;
  startingPdb?: string;
  energy?: number;
  bestEnergy?: number;
  snapshotSequence?: number;
  snapshotSource?: "initial" | "stage" | "minimizing" | "packing" | "final";
  snapshotStep?: number;
  snapshotAt?: number;
  completed: number;
  total: number;
  elapsedMs: number;
  history: number[];
  frames?: StructureSnapshot[];
  message: string;
  checkpointAt?: number;
  ownerId?: string;
  metrics: Metric[];
  parallelism?: number;
  activeWorkers?: number;
  completedModels?: number;
  totalModels?: number;
  focusedModel?: number;
  modelResults?: Array<{
    modelIndex: number;
    seed: number;
    pdb: string;
    energy: number;
    elapsedMs: number;
  }>;
}
export interface BrowserModelCheckpoint {
  task: Task;
  result?: Completion;
  history?: number[];
  frames?: StructureSnapshot[];
  bestEnergy?: number;
  startedAt: number;
  status: "queued" | "running" | "complete";
  execution?: { parallelism: number; dutyCycle: number };
}
export interface Checkpoint {
  task: Task;
  engineManifest?: EngineManifest;
  taskSource?: "bundled" | "benchmark" | "research" | "peer";
  serverUrl?: string;
  result?: Completion;
  history?: number[];
  frames?: StructureSnapshot[];
  bestEnergy?: number;
  startedAt: number;
  status: "running" | "paused" | "uploading";
  batch?: {
    models: BrowserModelCheckpoint[];
    parallelism: number;
    dutyCycle?: number;
  };
  benchmark?: {
    id: string;
    kind: "coordinate-replay";
    metadata: Record<string, unknown>;
  };
  peer?: {
    jobId: string;
    publisherId: string;
    jobHash: string;
    models: number;
  };
}
export interface EngineManifest {
  id: string;
  sourceSha: string;
  verified: boolean;
  module: string;
  database: string;
  reason: string;
  packageBytes?: number;
  peakHeapBytes?: number;
  supportedProtocols?: Protocol[];
  hashes?: Record<string, string>;
}
export const initialSnapshot = (): Snapshot => ({
  state: "idle",
  mode: "browser",
  completed: 0,
  total: 1,
  elapsedMs: 0,
  history: [],
  frames: [],
  message:
    "Choose how you contribute. Computation starts only with your consent.",
  metrics: [],
});
export const withinTolerance = (a: number, b: number) =>
  Math.abs(a - b) <= Math.max(0.001, 0.00001 * Math.abs(b));

/** Only a single, complete coordinate model with canonical amino acids is admitted. */
export function validatePdb(pdb: string) {
  const chains = new Set<string>();
  const residues = new Map<string, Set<string>>();
  const names = new Map<string, string>();
  const atoms = new Set<string>();
  let count = 0;
  let models = 0;
  for (const line of pdb.split(/\r?\n/)) {
    if (line.startsWith("MODEL ")) {
      models++;
      if (models > 1)
        throw new Error("Upload one coordinate model, not an NMR ensemble.");
    }
    if (line.startsWith("HETATM"))
      throw new Error(
        "Ligands and noncanonical residues are outside this prototype.",
      );
    if (!line.startsWith("ATOM  ")) continue;
    const residue = line.slice(17, 20).trim();
    const chain = line.slice(21, 22);
    const key = chain + ":" + line.slice(22, 27);
    const atom = line.slice(12, 16).trim();
    const alternate = line.slice(16, 17).trim();
    if (!AMINO.has(residue))
      throw new Error("Only standard amino-acid residues are supported.");
    if (names.has(key) && names.get(key) !== residue)
      throw new Error("Conflicting residue names.");
    names.set(key, residue);
    if (alternate)
      throw new Error("Resolve alternate atom locations before uploading.");
    const coordinates = [
      line.slice(30, 38),
      line.slice(38, 46),
      line.slice(46, 54),
    ];
    if (
      coordinates.some(
        (v) =>
          !v.trim() ||
          !Number.isFinite(Number(v)) ||
          Math.abs(Number(v)) > 10_000,
      )
    )
      throw new Error("Invalid atom coordinates.");
    if (atoms.has(key + ":" + atom))
      throw new Error("Duplicate atom in a residue.");
    atoms.add(key + ":" + atom);
    chains.add(chain);
    count++;
    if (!residues.has(key)) residues.set(key, new Set());
    residues.get(key)!.add(atom);
  }
  if (chains.size !== 1 || residues.size < 1)
    throw new Error(
      "This protocol requires one nonempty protein chain. Multiple chains are retained, never silently removed.",
    );
  if (
    [...residues.values()].some(
      (atoms) => !["N", "CA", "C", "O"].every((a) => atoms.has(a)),
    )
  )
    throw new Error("Every residue needs N, CA, C, and O backbone atoms.");
  return { residues: residues.size, atoms: count, chain: [...chains][0] };
}
