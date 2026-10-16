import { readFile, writeFile, stat, mkdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  PROTOCOLS,
  SOURCE_SHA,
  withinTolerance,
  validatePdb,
  validateResultIdentity,
} from "../packages/shared/src/index";

const folder = resolve(process.env.ROSETTATAB_ENGINE_DIR ?? "engine/artifacts/wasm");
const database = resolve("engine/artifacts/database");
const executable = resolve("engine/artifacts/native/rosettatab-native");
const inputPath = resolve("apps/extension/public/fixtures/1l2y.pdb");
const pdb = await readFile(inputPath, "utf8");
// Match the already documented browser regression fixture for FastDesign.
// Default remains the full 20-residue publication/reference experiment.
const browserFixtures = process.argv.includes("--browser-fixtures");
const native = async (path: string, protocol: string) => {
  const { stdout } = await promisify(execFile)(
    executable,
    [
      "--input",
      path,
      "--database",
      database,
      "--protocol",
      protocol,
      "--seed",
      "17",
    ],
    { timeout: 300_000, maxBuffer: 5_000_000 },
  );
  const line = stdout
    .split("\n")
    .findLast((l) => l.startsWith("ROSETTATAB_RESULT "));
  if (!line) throw new Error("Native application returned no result.");
  const result = JSON.parse(line.slice(18));
  if (result.error) throw new Error(result.error);
  return result;
};
const report: any = {
  sourceSha: SOURCE_SHA,
  passed: false,
  hashes: {},
  measurements: [],
  failures: [],
  scope: browserFixtures
    ? "1L2Y seed 17; 20 residues except FastDesign's documented eight-residue browser fixture; native/WASM regression"
    : "1L2Y, one chain, seed 17; bounded canonical coordinate protocols",
  peakHeapBytes: 0,
  packageBytes: 0,
};
await mkdir("reports", { recursive: true });
try {
  for (const name of ["rosetta.mjs", "rosetta.wasm", "rosetta.data"]) {
    const path = resolve(folder, name);
    report.packageBytes += (await stat(path)).size;
    report.hashes[name] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  }
  if (report.packageBytes > 250_000_000)
    throw new Error("Candidate exceeds 250 MB package gate.");
  const factory = (
    await import(pathToFileURL(resolve(folder, "rosetta.mjs")).href)
  ).default;
  const started = performance.now();
  const module = await factory({
    locateFile: (name: string) => resolve(folder, name),
    print: () => {},
    printErr: () => {},
  });
  report.startupMs = performance.now() - started;
  for (const definition of PROTOCOLS) {
    console.log("Measuring " + definition.id);
    const shortDesign = browserFixtures && definition.id === "fastdesign";
    const casePdb = shortDesign
      ? pdb
          .split(/\r?\n/)
          .filter(
            (line) =>
              line.startsWith("ATOM  ") && Number(line.slice(22, 26)) <= 8,
          )
          .join("\n") + "\nEND\n"
      : pdb;
    const casePath = shortDesign
      ? resolve(".local/protocol-fastdesign-input.pdb")
      : inputPath;
    if (shortDesign) await writeFile(casePath, casePdb);
    const frames: any[] = [];
    (globalThis as any).rosettatabSnapshot = (
      pdb: string,
      energy: number,
      progress: number,
      source: string,
      sequence: number,
      iteration: number,
    ) => {
      frames.push({ pdb, energy, progress, source, sequence, iteration });
      report.peakHeapBytes = Math.max(
        report.peakHeapBytes,
        module.HEAPU8.byteLength,
      );
    };
    const referencePromise = native(casePath, definition.id);
    const start = performance.now();
    const result = JSON.parse(
      await module.ccall(
        "rosettatab_run_protocol",
        "string",
        ["string", "string", "number", "number"],
        [casePdb, definition.id, 17, 75],
        { async: true },
      ),
    );
    const elapsedMs = performance.now() - start;
    const reference = await referencePromise;
    if (result.error) throw new Error(definition.id + ": " + result.error);
    validatePdb(result.pdb);
    validateResultIdentity(casePdb, result.pdb, definition.id);
    const output = resolve("engine/artifacts", `wasm-${definition.id}.pdb`);
    await writeFile(output, result.pdb);
    const rescored = await native(output, "score");
    if (
      !Number.isFinite(result.energy) ||
      !withinTolerance(result.energy, rescored.energy)
    )
      throw new Error(
        definition.id + ": native returned-coordinate rescoring mismatch.",
      );
    if (
      definition.id === "score" &&
      !withinTolerance(result.energy, reference.energy)
    )
      throw new Error("Fixed-coordinate native/WASM scores disagree.");
    const backbone = (text: string) =>
      text
        .split(/\r?\n/)
        .filter(
          (l) =>
            l.startsWith("ATOM  ") &&
            ["N", "CA", "C", "O"].includes(l.slice(12, 16).trim()),
        )
        .map((l) => l.slice(12, 17) + l.slice(20, 54))
        .join("\n");
    if (
      ["repack", "fixed_backbone_design"].includes(definition.id) &&
      backbone(result.pdb) !== backbone(casePdb)
    )
      throw new Error(definition.id + ": fixed backbone changed.");
    if (
      definition.changesSequence &&
      result.sequence === (shortDesign ? "NLYIQWLK" : "NLYIQWLKDGGPSSGRPPPS")
    )
      throw new Error(
        definition.id + ": the design benchmark did not change its sequence.",
      );
    if (frames.some((f) => !Number.isFinite(f.energy)))
      throw new Error("Nonfinite live energy.");
    const minimizing = frames.filter((f) => f.source === "minimizing").length;
    const packing = frames.filter((f) => f.source === "packing").length;
    if (definition.id === "relax") {
      if (minimizing < 3 || packing < 1)
        throw new Error("FastRelax internal live frames missing.");
      if (Math.abs(result.energy - -48.17565422427388) > 1e-9)
        throw new Error("Original seeded FastRelax changed.");
      report.liveView = {
        seededResultUnchanged: true,
        minimizingSnapshots: minimizing,
        packingSnapshots: packing,
      };
    }
    const measurement = {
      protocol: definition.id,
      input: shortDesign ? "1L2Y residues 1–8" : "1L2Y first model",
      inputSha256: createHash("sha256").update(casePdb).digest("hex"),
      nativeEnergy: reference.energy,
      wasmEnergy: result.energy,
      nativeRescore: rescored.energy,
      sequence: result.sequence,
      objectiveScoreFunction: result.objectiveScoreFunction,
      wasmMs: elapsedMs,
      heapBytes: module.HEAPU8.byteLength,
      snapshots: frames.length,
      minimizingSnapshots: minimizing,
      packingSnapshots: packing,
      passed: true,
    };
    report.measurements.push(measurement);
    console.log(JSON.stringify(measurement));
    if (report.peakHeapBytes > 512 * 1024 ** 2)
      throw new Error("Candidate exceeds 512 MiB heap gate.");
    await writeFile(
      "reports/wasm-protocol-proof.json",
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  report.passed = true;
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  console.error(report.failures.at(-1));
} finally {
  await writeFile(
    "reports/wasm-protocol-proof.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
