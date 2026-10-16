import { cp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
const destination =
  process.env.ROSETTATAB_CANDIDATE_DIR ?? ".local/browser-proof/extension";
const proof = JSON.parse(
  await readFile("reports/wasm-protocol-proof.json", "utf8"),
);
if (!proof.passed || proof.measurements.length !== 8)
  throw new Error("Native/WASM protocol proof must pass first.");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp("dist/extension", destination, { recursive: true });
for (const [name, expected] of Object.entries(proof.hashes)) {
  const path = `engine/artifacts/wasm/${name}`;
  const hash = createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
  if (hash !== expected) throw new Error(`Unmeasured candidate: ${name}`);
  await cp(path, `${destination}/engine/${name}`);
}
await writeFile(
  `${destination}/engine/${existsSync(`${destination}/engine/engine-metadata.json`) ? "engine-metadata.json" : "manifest.json"}`,
  JSON.stringify(
    {
      id: "rosetta-protocols-v2",
      sourceSha: proof.sourceSha,
      verified: true,
      module: "rosetta.mjs",
      database: "rosetta.data",
      reason:
        "Isolated browser acceptance experiment; not admitted to the release.",
      hashes: proof.hashes,
      supportedProtocols: proof.measurements.map((m) => m.protocol),
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Prepared isolated extension candidate; no service or Docker required.",
);
