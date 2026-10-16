// Independent native validation of the cyclic-peptide research experiment.
import { readFile, writeFile, cp } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
const directory = resolve(process.argv[2] ?? ".local/application-wasm-cyclic");
const proof = JSON.parse(
  await readFile(resolve(directory, "port-proof.json"), "utf8"),
);
if (!proof.passed || proof.protocol !== "simple_cycpep_predict")
  throw new Error("No cyclic-peptide output smoke proof.");
for (const [name, sha] of Object.entries(proof.hashes))
  if (
    createHash("sha256")
      .update(await readFile(resolve("engine/artifacts/wasm", name)))
      .digest("hex") !== sha
  )
    throw new Error("Application build changed: " + name);
const family = proof.modulePrefix === "rosetta-cyclic";
const reportPrefix = family ? "wasm-cyclic-family" : "wasm-cyclic";
const output = proof.outputs.find((file) => file.name === "result.silent");
const silent = resolve(directory, "result.silent");
if (
  !output ||
  createHash("sha256")
    .update(await readFile(silent))
    .digest("hex") !== output.sha256
)
  throw new Error("Returned structure changed.");
const report = {
  ...proof,
  passed: false,
  validationLevel: "native-rescored-output-and-fixture-topology",
  models: [],
  failures: [],
  scope:
    "One eight-residue DPHE/LYS/PRO/DPRO/ASP/PRO/PRO/ASN cyclic-peptide fixture. Operator Node WASM only; browser and general chemistry coverage remain unverified.",
};
try {
  const { stdout } = await promisify(execFile)(
    resolve("engine/artifacts/native/rosettatab-application"),
    ["--rescore-silent", silent, resolve("engine/artifacts/database")],
    { timeout: 120_000, maxBuffer: 1_000_000 },
  );
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("ROSETTATAB_SILENT_SCORE ")) continue;
    const [, tag, stored, rescored, count, bonded, distance, dResidues] =
      line.split(" ");
    const closureDistanceAngstrom = Number(distance),
      dAminoAcidResidues = Number(dResidues),
      nToCCyclized = bonded === "1";
    const nativeEnergy = Number(rescored),
      reportedEnergy = Number(stored);
    const tolerance = Math.max(0.001, Math.abs(nativeEnergy) * 0.00001);
    const passed =
      Number(count) === 8 &&
      Number.isFinite(nativeEnergy) &&
      nToCCyclized &&
      closureDistanceAngstrom >= 1.2 &&
      closureDistanceAngstrom <= 1.5 &&
      dAminoAcidResidues === 2 &&
      Math.abs(nativeEnergy - reportedEnergy) <= tolerance;
    report.models.push({
      tag,
      reportedEnergy,
      nativeEnergy,
      residues: Number(count),
      nToCCyclized,
      closureDistanceAngstrom,
      dAminoAcidResidues,
      tolerance,
      passed,
    });
  }
  if (!report.models.length || report.models.some((model) => !model.passed))
    throw new Error("Cyclic peptide native rescoring failed.");
  report.passed = true;
  await cp(silent, `reports/${reportPrefix}-models.silent`);
} catch (error) {
  report.failures.push(String(error));
  process.exitCode = 1;
}
await writeFile(
  `reports/${reportPrefix}-proof.json`,
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    { passed: report.passed, models: report.models, failures: report.failures },
    null,
    2,
  ),
);
