import { z } from "zod";
import {
  ENGINE_ID,
  SOURCE_SHA,
  protocolSchema,
  validatePdb,
  prepareProteinPdb,
  type ProteinPreparation,
  type Task,
  type Checkpoint,
  type BrowserModelCheckpoint,
  type EngineManifest,
  type Protocol,
} from "@rosettatab/shared";
import { getState } from "./storage";

export const BENCHMARK_SCHEMA = "rosettatab-coordinate-benchmark-v1";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const seed = z.number().int().min(1).max(2_000_000_000);
const pdb = z.string().min(80);
const benchmarkSchema = z
  .object({
    schema: z.literal(BENCHMARK_SCHEMA),
    title: z.string().trim().min(1).max(120),
    protocol: protocolSchema,
    seed,
    pdb,
    inputSha256: hash.optional(),
    provenance: z
      .object({
        kind: z.enum(["boinc-capture", "reference"]),
        captureManifestSha256: hash.optional(),
        application: z.string().max(120).optional(),
        applicationVersion: z.string().max(120).optional(),
        workunit: z.string().max(300).optional(),
        inputFile: z.string().max(300).optional(),
      })
      .strict(),
    reference: z
      .object({
        pdb,
        energy: z.number().finite(),
        sourceSha: z.string().regex(/^[a-f0-9]{40}$/),
        protocol: protocolSchema,
        seed,
        engineId: z.string().max(120),
      })
      .strict()
      .optional(),
  })
  .strict();
export type CoordinateBenchmark = z.infer<typeof benchmarkSchema> & {
  preparation?: ProteinPreparation & {
    originalSha256: string;
    preparedSha256: string;
  };
};
export interface ImportedBenchmark {
  task: Task;
  metadata: CoordinateBenchmark;
  /** Explicit next-run choice; the imported protocol/reference stays intact. */
  runProtocol?: Protocol;
}
export async function sha256(text: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export async function parseBenchmark(
  text: string,
  filename: string,
): Promise<ImportedBenchmark> {
  const raw =
    !filename.toLowerCase().endsWith(".json") &&
    !text.trimStart().startsWith("{")
      ? {
          schema: BENCHMARK_SCHEMA,
          title: filename.slice(0, 120),
          protocol: "score",
          seed: 17,
          pdb: text,
          provenance: { kind: "reference", inputFile: filename.slice(0, 300) },
        }
      : JSON.parse(text);
  const document: CoordinateBenchmark = benchmarkSchema.parse(raw);
  if (!/^(ATOM  |HETATM)/m.test(document.pdb))
    throw new Error(
      "No PDB atom records were found. Choose PDB/ENT coordinates, a gzipped PDB, or benchmark JSON.",
    );
  if (document.reference) validatePdb(document.reference.pdb);
  const originalHash = await sha256(document.pdb);
  if (document.inputSha256 && document.inputSha256 !== originalHash)
    throw new Error("The benchmark input hash does not match its coordinates.");
  const prepared = prepareProteinPdb(document.pdb);
  validatePdb(prepared.pdb);
  const inputHash = prepared.changed
    ? await sha256(prepared.pdb)
    : originalHash;
  // Metadata retains the exact original input and any exact native reference.
  document.inputSha256 = originalHash;
  if (prepared.changed)
    document.preparation = {
      ...prepared.report,
      originalSha256: originalHash,
      preparedSha256: inputHash,
    };
  return {
    task: {
      id: crypto.randomUUID(),
      jobId: crypto.randomUUID(),
      title: document.title,
      protocol: document.protocol,
      inputHash,
      pdb: prepared.pdb,
      seed: document.seed,
      modelIndex: 0,
      engineId: ENGINE_ID,
      sourceSha: SOURCE_SHA,
      state: "leased",
      attemptToken: crypto.randomUUID(),
      clientId: null,
      leaseUntil: null,
      result: null,
      rejection: null,
    },
    metadata: document,
  };
}

/** Browser-native gzip decompression; no executable or coordinate downloads. */
export async function importProteinFile(file: File) {
  const gzip = file.name.toLowerCase().endsWith(".gz");
  const text = gzip
    ? await new Response(
        file.stream().pipeThrough(new DecompressionStream("gzip")),
      ).text()
    : await file.text();
  return parseBenchmark(text, gzip ? file.name.slice(0, -3) : file.name);
}

// Self-contained publication record: all structures are embedded and hashed.
// Native verification is a separate, explicit operation on the exported file.
export async function exportBenchmark(taskId: string) {
  const saved = await getState<Checkpoint[]>("browser-results");
  const checkpoint = saved?.find((entry) => entry.task.id === taskId);
  if (!checkpoint?.result)
    throw new Error("This completed run is no longer in local history.");
  const models: BrowserModelCheckpoint[] = checkpoint.batch?.models ?? [
    { ...checkpoint, status: "complete" },
  ];
  return {
    schema: "rosettatab-browser-record-v1",
    exportedAt: new Date().toISOString(),
    runId: checkpoint.task.jobId,
    taskSource: checkpoint.taskSource ?? "bundled",
    officialSubmission: "disabled",
    officialWorkunitEquivalence: "not-established",
    benchmark: checkpoint.benchmark,
    peer: checkpoint.peer,
    input: {
      pdb: checkpoint.task.pdb,
      sha256: await sha256(checkpoint.task.pdb),
    },
    engine: checkpoint.engineManifest ?? {
      id: checkpoint.task.engineId,
      sourceSha: checkpoint.task.sourceSha,
      verified: false,
      reason:
        "Legacy result: the executing engine's artifact hashes were not recorded.",
    },
    environment: {
      userAgent: navigator.userAgent,
      reportedLogicalProcessors: navigator.hardwareConcurrency,
      parallelism: checkpoint.batch?.parallelism ?? 1,
      // Recorded at run creation, never inferred from current preferences.
      dutyCycle: checkpoint.batch?.dutyCycle ?? null,
    },
    startedAt: new Date(checkpoint.startedAt).toISOString(),
    elapsedMs: checkpoint.result.elapsedMs,
    timingScope:
      "Run elapsed is wall time including pauses, handovers and replay. Each model elapsed covers its finishing attempt; these are not CPU-time or equal-resource throughput measurements.",
    models: await Promise.all(
      models.map(async (model) => ({
        modelIndex: model.task.modelIndex,
        seed: model.task.seed,
        protocol: model.task.protocol,
        history: model.history ?? [],
        frames: await Promise.all(
          (model.frames ?? []).map(async (frame) => ({
            ...frame,
            sha256: await sha256(frame.pdb),
          })),
        ),
        execution: model.execution,
        startedAt: new Date(model.startedAt).toISOString(),
        energy: model.result!.energy,
        elapsedMs: model.result!.elapsedMs,
        pdb: model.result!.pdb,
        sha256: await sha256(model.result!.pdb),
      })),
    ),
    comparison: {
      status: "awaiting-native-verification",
      originalReferenceComparable:
        !checkpoint.benchmark?.metadata.preparation &&
        (!checkpoint.benchmark?.metadata.protocol ||
          checkpoint.benchmark.metadata.protocol === checkpoint.task.protocol),
      scope:
        "Coordinate protocol replay; not a complete official Rosetta@home workunit.",
    },
  };
}
