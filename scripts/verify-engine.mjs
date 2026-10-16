import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const sha = "369e400415dd5c585f80dcf7b647147ee520e8ba";
const scoreOnly = process.argv.includes("--score-only"),
  folder = resolve("engine/artifacts/wasm");
const database = resolve(
  process.env.ROSETTATAB_DATABASE ?? "engine/artifacts/database",
);
const nativePath = resolve("engine/artifacts/native/rosettatab-native");
const pdb = await readFile("apps/extension/public/fixtures/1l2y.pdb", "utf8");
const report = {
  sourceSha: sha,
  verified: false,
  sciencePassed: false,
  hashes: {},
  scope: scoreOnly
    ? "1L2Y fixed-coordinate scoring proof"
    : "1L2Y scoring and short FastRelax",
  packageBytes: 0,
  peakHeapBytes: 0,
  startupMs: 0,
  measurements: [],
  failures: [],
};
const native = (path, protocol) => {
  const start = performance.now();
  const stdout = execFileSync(
    nativePath,
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
    { encoding: "utf8", maxBuffer: 5_000_000, timeout: 180_000 },
  );
  const line = stdout
    .split("\n")
    .findLast((l) => l.startsWith("ROSETTATAB_RESULT "));
  if (!line) throw new Error("Native scorer did not return a result.");
  const data = JSON.parse(line.slice(18));
  if (data.error) throw new Error(data.error);
  return { ...data, elapsedMs: performance.now() - start };
};
const tolerance = (a, b) =>
  Math.abs(a - b) <= Math.max(0.001, 0.00001 * Math.abs(b));
try {
  for (const file of ["rosetta.mjs", "rosetta.wasm", "rosetta.data"]) {
    report.packageBytes += (await stat(folder + "/" + file)).size;
    report.hashes[file] = createHash("sha256")
      .update(await readFile(folder + "/" + file))
      .digest("hex");
  }
  if (report.packageBytes > 250_000_000)
    throw new Error("Packaged engine/database exceed 250 MB.");
  const factory = (await import(pathToFileURL(folder + "/rosetta.mjs").href))
    .default;
  const startup = performance.now();
  const module = await factory({
    locateFile: (name) => folder + "/" + name,
    print: () => {},
    printErr: () => {},
  });
  report.startupMs = performance.now() - startup;
  console.log(
    `Engine initialized in ${(report.startupMs / 1000).toFixed(2)} seconds.`,
  );
  globalThis.rosettatabSnapshot = () => {
    report.peakHeapBytes = Math.max(
      report.peakHeapBytes,
      module.HEAPU8?.byteLength ?? 0,
    );
  };
  for (const protocol of scoreOnly ? ["score"] : ["score", "relax"]) {
    const frames = [];
    globalThis.rosettatabSnapshot = (
      pdb,
      energy,
      progress,
      source,
      sequence,
      iteration,
    ) => {
      report.peakHeapBytes = Math.max(
        report.peakHeapBytes,
        module.HEAPU8?.byteLength ?? 0,
      );
      frames.push({
        pdb,
        energy,
        progress,
        source,
        sequence,
        iteration,
        elapsedMs: performance.now(),
      });
    };
    console.log(`Measuring real native/WASM ${protocol} and native rescoring…`);
    const reference = native(
        resolve("apps/extension/public/fixtures/1l2y.pdb"),
        protocol,
      ),
      start = performance.now();
    const wasm = JSON.parse(
      await module.ccall(
        "rosettatab_run",
        "string",
        ["string", "number", "number", "number"],
        [pdb, protocol === "relax" ? 1 : 0, 17, 25],
        { async: true },
      ),
    );
    const wasmMs = performance.now() - start;
    if (wasm.error) throw new Error(wasm.error);
    if (!Number.isFinite(wasm.energy))
      throw new Error("WASM energy is not finite.");
    if (protocol === "score" && !tolerance(wasm.energy, reference.energy))
      throw new Error("Native/WASM scoring mismatch.");
    const returned = resolve("engine/artifacts/returned.pdb");
    await writeFile(returned, wasm.pdb);
    const rescore = native(returned, "score");
    if (!tolerance(wasm.energy, rescore.energy))
      throw new Error("Returned structure failed native rescoring.");
    report.peakHeapBytes = Math.max(
      report.peakHeapBytes,
      module.HEAPU8?.byteLength ?? 0,
    );
    report.measurements.push({
      protocol,
      nativeEnergy: reference.energy,
      wasmEnergy: wasm.energy,
      nativeRescore: rescore.energy,
      nativeMs: reference.elapsedMs,
      wasmMs,
      activeMs: wasm.activeMs,
      sleepingMs: wasm.sleepingMs,
      yields: wasm.yields,
    });
    if (protocol === "relax") {
      const minimizing = frames.filter((f) => f.source === "minimizing");
      const packing = frames.filter((f) => f.source === "packing");
      const atomHash = (frame) =>
        createHash("sha256")
          .update(
            frame.pdb
              .split("\n")
              .filter((l) => l.startsWith("ATOM  "))
              .join("\n"),
          )
          .digest("hex");
      if (minimizing.length < 3 || packing.length < 1)
        throw new Error(
          "Internal minimizer and accepted-packing graphics hooks did not produce live frames.",
        );
      if (
        !frames.some(
          (f, i) =>
            i > 0 &&
            f.progress === frames[i - 1].progress &&
            atomHash(f) !== atomHash(frames[i - 1]),
        )
      )
        throw new Error("No coordinate movement within a FastRelax command.");
      if (
        frames.some(
          (f, i) =>
            !Number.isFinite(f.energy) ||
            (i > 0 && f.sequence <= frames[i - 1].sequence),
        )
      )
        throw new Error("Live snapshots are nonfinite or out of order.");
      // With the protocol and RNG untouched, telemetry must preserve this exact
      // pinned benchmark's final result, measured before the graphics changes.
      if (Math.abs(wasm.energy - -48.17565422427388) > 1e-9)
        throw new Error("Live reporting changed the seeded scientific result.");
      const samples = [
        packing[0],
        minimizing[0],
        minimizing[Math.floor(minimizing.length / 2)],
      ];
      const sampledRescores = [];
      for (const frame of samples) {
        const file = resolve(".local/live-snapshot.pdb");
        await writeFile(file, frame.pdb);
        const rescored = native(file, "score");
        sampledRescores.push({
          source: frame.source,
          energy: frame.energy,
          nativeRescore: rescored.energy,
          pdbRoundingDifference: Math.abs(rescored.energy - frame.energy),
        });
      }
      report.liveView = {
        snapshots: frames.length,
        minimizingSnapshots: minimizing.length,
        packingSnapshots: packing.length,
        minimizerEvaluations: wasm.minimizerEvaluations,
        packingMoves: wasm.packingMoves,
        seededResultUnchanged: true,
        sampledRescores,
      };
      await writeFile(
        ".local/live-relaxation-frames.json",
        JSON.stringify(frames) + "\n",
      );
    }
    console.log(
      `${protocol} passed: ${wasm.energy} REU; WASM call ${(wasmMs / 1000).toFixed(2)} seconds.`,
    );
  }
  if (!report.peakHeapBytes)
    throw new Error("WASM heap measurement unavailable.");
  if (report.peakHeapBytes > 512 * 1024 ** 2)
    throw new Error("WASM heap exceeds 512 MiB.");
  report.sciencePassed = !scoreOnly;
  // Transport/UI test doubles cannot certify a scientific worker's recovery.
  report.failures.push(
    scoreOnly
      ? "FastRelax and real browser recovery/responsiveness are not certified by the scoring proof."
      : "Real browser pause, duty-cycle, checkpoint, ten-tab and crash/restart gates must be measured with this exact engine build.",
  );
} catch (error) {
  report.failures.push(error.message);
}
await mkdir("engine/artifacts", { recursive: true });
await writeFile(
  process.env.ROSETTATAB_BENCHMARK_REPORT ?? "engine/artifacts/benchmark.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
if (!report.sciencePassed) process.exitCode = 1;
