// Offline scientific verification. This never contacts BOINC or a project server.
import { readFile, writeFile, mkdir, stat, readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve, dirname } from "node:path";
import { createHash } from "node:crypto";
import { platform, arch, cpus, totalmem, release } from "node:os";
import { z } from "zod";
import {
  ENGINE_ID,
  SOURCE_SHA,
  protocolSchema,
  validatePdb,
  validateResultIdentity,
  withinTolerance,
} from "../packages/shared/src/index";

const argument = (name: string) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--record") || !process.argv.includes("--out"))
  throw new Error(
    "Use --record downloaded-run.json --out NEW-comparison-directory",
  );
if (
  !argument("--record") ||
  !argument("--out") ||
  argument("--record").startsWith("--") ||
  argument("--out").startsWith("--")
)
  throw new Error("Both --record and --out need a file/directory value.");
const recordPath = resolve(argument("--record"));
const out = resolve(argument("--out"));
const executable = resolve("engine/artifacts/native/rosettatab-native");
const database = resolve("engine/artifacts/database");
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const structure = z.string().min(80);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const schema = z
  .object({
    schema: z.literal("rosettatab-browser-record-v1"),
    officialSubmission: z.literal("disabled"),
    input: z.object({ pdb: structure, sha256: sha }),
    engine: z
      .object({
        id: z.literal(ENGINE_ID),
        sourceSha: z.literal(SOURCE_SHA),
        verified: z.literal(true),
        hashes: z.record(z.string(), sha),
      })
      .passthrough(),
    models: z
      .array(
        z
          .object({
            modelIndex: z.number().int().min(0),
            seed: z.number().int().min(1).max(2_000_000_000),
            protocol: protocolSchema,
            pdb: structure,
            sha256: sha,
            energy: z.number().finite(),
            elapsedMs: z.number().finite().nonnegative(),
          })
          .passthrough(),
      )
      .min(1)
      .max(256),
  })
  .passthrough();
if ((await stat(recordPath)).size > 128_000_000)
  throw new Error("Record exceeds 128 MB.");
const bytes = await readFile(recordPath);
const record = schema.parse(JSON.parse(bytes.toString("utf8")));
validatePdb(record.input.pdb);
if (digest(record.input.pdb) !== record.input.sha256)
  throw new Error("Input checksum mismatch.");
for (const model of record.models) {
  if (digest(model.pdb) !== model.sha256)
    throw new Error("Output checksum mismatch.");
  validatePdb(model.pdb);
  validateResultIdentity(record.input.pdb, model.pdb, model.protocol);
}
if (
  new Set(record.models.map((model) => model.modelIndex)).size !==
  record.models.length
)
  throw new Error("Duplicate model identifiers.");
// Verify the native/WASM source provenance against the local scientific gate.
const proof = JSON.parse(
  await readFile("reports/wasm-protocol-proof.json", "utf8"),
);
if (!proof.passed || proof.sourceSha !== SOURCE_SHA)
  throw new Error("The native/WASM protocol verification gate has not passed.");
for (const name of ["rosetta.mjs", "rosetta.wasm", "rosetta.data"])
  if (proof.hashes[name] !== record.engine.hashes[name])
    throw new Error(
      "Engine files differ from the independently verified build.",
    );
await mkdir(dirname(out), { recursive: true });
await mkdir(out, { recursive: false }); // Never overwrite a publication record.
await writeFile(resolve(out, "browser-record.json"), bytes);
await writeFile(resolve(out, "input.pdb"), record.input.pdb);
const native = async (input: string, protocol: string, seed: number) => {
  const start = performance.now();
  const { stdout } = await promisify(execFile)(
    executable,
    [
      "--input",
      input,
      "--database",
      database,
      "--protocol",
      protocol,
      "--seed",
      String(seed),
    ],
    { timeout: 300_000, maxBuffer: 5_000_000 },
  );
  const line = stdout
    .split("\n")
    .findLast((entry) => entry.startsWith("ROSETTATAB_RESULT "));
  if (!line) throw new Error("Native reference produced no scientific result.");
  const result = JSON.parse(line.slice(18));
  if (result.error || !Number.isFinite(result.energy))
    throw new Error(result.error ?? "Invalid native energy.");
  return { ...result, wallMs: performance.now() - start };
};
const report: any = {
  schema: "rosettatab-comparison-v1",
  checkedAt: new Date().toISOString(),
  passed: false,
  comparisonKind: "same-source-coordinate-protocol",
  officialWorkunitEquivalence: "not-established",
  officialSubmission: "disabled",
  sourceSha: SOURCE_SHA,
  engineId: ENGINE_ID,
  recordSha256: digest(bytes),
  nativeExecutableSha256: digest(await readFile(executable)),
  nativeSourceProvenance:
    "Local build assertion. Native binary hash is recorded; a cryptographic source-to-binary attestation is not available.",
  scientificGateSha256: digest(
    await readFile("reports/wasm-protocol-proof.json"),
  ),
  environment: {
    platform: platform(),
    arch: arch(),
    osRelease: release(),
    logicalProcessors: cpus().length,
    totalMemoryBytes: totalmem(),
  },
  timingScope:
    "Browser elapsed includes engine startup and configured cooperative duty cycle. Native wall time includes process startup. These are not equal-resource throughput measurements.",
  tolerance: "max(0.001 REU, 0.00001 * abs(native score))",
  models: [],
  failures: [],
};
try {
  for (const model of record.models) {
    const stem = `model-${model.modelIndex}-seed-${model.seed}`;
    const wasmPath = resolve(out, stem + "-wasm.pdb");
    await writeFile(wasmPath, model.pdb);
    const control = await native(
      resolve(out, "input.pdb"),
      model.protocol,
      model.seed,
    );
    validatePdb(control.pdb);
    validateResultIdentity(record.input.pdb, control.pdb, model.protocol);
    await writeFile(resolve(out, stem + "-native.pdb"), control.pdb);
    const rescore = await native(wasmPath, "score", model.seed);
    const outputScoreAgrees = withinTolerance(model.energy, rescore.energy);
    const fixedCoordinateAgrees =
      model.protocol === "score"
        ? withinTolerance(model.energy, control.energy)
        : null;
    const passed = outputScoreAgrees && fixedCoordinateAgrees !== false;
    report.models.push({
      modelIndex: model.modelIndex,
      seed: model.seed,
      protocol: model.protocol,
      wasmEnergy: model.energy,
      nativeControlEnergy: control.energy,
      returnedCoordinateNativeScore: rescore.energy,
      returnedCoordinateScoreError: Math.abs(model.energy - rescore.energy),
      outputScoreAgrees,
      fixedCoordinateAgrees,
      passed,
      nativeControlPdbSha256: digest(control.pdb),
      wasmPdbSha256: model.sha256,
      browserElapsedMs: model.elapsedMs,
      nativeControlWallMs: control.wallMs,
      interpretation:
        model.protocol === "score"
          ? "Same coordinates, same score function."
          : "Returned structure independently rescored; stochastic trajectory agreement is not required or claimed.",
    });
    if (!passed) report.failures.push(`${stem}: energy verification failed`);
  }
  report.passed = report.failures.length === 0;
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
} finally {
  await writeFile(
    resolve(out, "comparison.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  // Keep partially produced models in failed experiment records as well.
  const files = (await readdir(out)).sort();
  const hashes = await Promise.all(
    files.map(async (name) => ({
      name,
      sha256: digest(await readFile(resolve(out, name))),
    })),
  );
  await writeFile(
    resolve(out, "checksums.json"),
    JSON.stringify(hashes, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      passed: report.passed,
      models: report.models.length,
      comparison: resolve(out, "comparison.json"),
      failures: report.failures,
    }),
  );
  if (!report.passed) process.exitCode = 1;
}
