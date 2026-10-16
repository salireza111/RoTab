import { readFile, writeFile, mkdir, cp, rm, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
const sha = "369e400415dd5c585f80dcf7b647147ee520e8ba";
const source = resolve("engine/artifacts/wasm");
const destination = resolve("engine/artifacts/verified");
const science = JSON.parse(
  await readFile("reports/wasm-protocol-proof.json", "utf8"),
);
const browser = JSON.parse(
  await readFile("reports/standalone-browser-proof.json", "utf8"),
);
const inputs = JSON.parse(
  await readFile("reports/browser-input-proof.json", "utf8"),
);
if (
  !inputs.passed ||
  inputs.residues <= 60 ||
  inputs.browsers?.length !== 2 ||
  new Set(inputs.browsers.map((b) => b.target)).size !== 2 ||
  inputs.browsers.some(
    (b) =>
      !["chrome", "brave"].includes(b.target) ||
      !b.passed ||
      !b.zeroServerRequests ||
      !b.allHttpRequestsBlocked ||
      !b.originalAndPreparedRetained,
  )
)
  throw new Error("The larger browser-upload scientific proof has not passed.");
if (
  !science.passed ||
  science.sourceSha !== sha ||
  science.measurements?.length !== 8 ||
  science.measurements.some((m) => !m.passed)
)
  throw new Error("The eight pinned protocol proofs have not passed.");
if (
  !science.liveView?.seededResultUnchanged ||
  science.liveView.minimizingSnapshots < 3 ||
  science.liveView.packingSnapshots < 1
)
  throw new Error(
    "Internal live graphics have not passed the scientific proof.",
  );
if (
  !browser.passed ||
  browser.sourceSha !== sha ||
  browser.browsers?.length !== 2 ||
  new Set(browser.browsers.map((b) => b.target)).size !== 2 ||
  browser.browsers.some(
    (b) =>
      !["chrome", "brave"].includes(b.target) ||
      !b.tenTabsOneOwner ||
      !b.pauseAndOwnerHandover ||
      !b.pausedOwnerCrashRecovery ||
      !b.savedAndDownloaded ||
      !b.restoredOnReload ||
      !b.allExternalRequestsBlocked ||
      b.serverRequests !== 0 ||
      b.maxActiveWorkers !== 1 ||
      !Number.isFinite(b.maxHeapBytes) ||
      b.maxHeapBytes <= 0 ||
      b.maxHeapBytes > 512 * 1024 ** 2,
  )
)
  throw new Error(
    "The browser-only recovery pilot has not passed. No service is required for this gate.",
  );
if (
  browser.browsers.some(
    (b) =>
      !b.liveView?.changedCanvas ||
      !b.liveView.changedEnergyGraph ||
      b.liveView.cameraOrbit !== false,
  )
)
  throw new Error(
    "The actual live WebGL view has not passed its deformation check.",
  );
const protocols = [
  "score",
  "relax",
  "minimize",
  "repack",
  "fixed_backbone_design",
  "fastdesign",
  "cartesian_minimize",
  "cartesian_relax",
];
const hasEveryProtocol = (proof) =>
  protocols.every(
    (id) =>
      proof.measurements?.filter((m) => m.protocol === id && m.passed)
        .length === 1,
  );
if (!hasEveryProtocol(science))
  throw new Error("Scientific proof is missing a packaged protocol.");
const files = ["rosetta.mjs", "rosetta.wasm", "rosetta.data"];
const browserProofs = await Promise.all(
  ["chrome", "brave"].map(async (target) => {
    const proof = JSON.parse(
      await readFile(`reports/browser-protocols-${target}.json`, "utf8"),
    );
    if (
      !proof.passed ||
      !hasEveryProtocol(proof) ||
      proof.nondefaultVmFlags ||
      proof.browserTarget !== target ||
      proof.sourceSha !== sha ||
      proof.measurements?.length !== 8 ||
      proof.measurements.some(
        (m) =>
          !m.passed ||
          !Number.isFinite(m.heapBytes) ||
          m.heapBytes <= 0 ||
          m.heapBytes > 512 * 1024 ** 2,
      ) ||
      !proof.unknownProtocolRejected
    )
      throw new Error(
        `The real ${target} VM proof with normal compiler settings has not passed.`,
      );
    if (
      !proof.liveView?.seededResultUnchanged ||
      proof.liveView.minimizingSnapshots < 3 ||
      proof.liveView.packingSnapshots < 1
    )
      throw new Error(`Internal live updates have not passed in ${target}.`);
    return proof;
  }),
);
let bytes = 0;
for (const file of files) {
  const hash = createHash("sha256")
    .update(await readFile(resolve(source, file)))
    .digest("hex");
  if (
    hash !== science.hashes?.[file] ||
    hash !== browser.hashes?.[file] ||
    hash !== inputs.hashes?.[file] ||
    browserProofs.some((proof) => hash !== proof.hashes?.[file])
  )
    throw new Error(
      `The measured build changed: ${file}. Rerun its scientific and browser proofs.`,
    );
  bytes += (await stat(resolve(source, file))).size;
}
if (
  bytes > 250_000_000 ||
  !Number.isFinite(science.peakHeapBytes) ||
  science.peakHeapBytes <= 0 ||
  science.peakHeapBytes > 512 * 1024 ** 2 ||
  browser.browsers.some((b) => b.maxHeapBytes > 512 * 1024 ** 2)
)
  throw new Error("The packaged engine exceeds the prototype resource limits.");
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const file of files)
  await cp(resolve(source, file), resolve(destination, file));
await cp(
  ".vendor/rosetta/LICENSE.md",
  resolve(destination, "ROSETTA_LICENSE.md"),
);
await cp(
  ".vendor/rosetta/CITING_ROSETTA.md",
  resolve(destination, "CITING_ROSETTA.md"),
);
await writeFile(
  resolve(destination, "manifest.json"),
  JSON.stringify(
    {
      id: "rosetta-protocols-v2",
      sourceSha: sha,
      verified: true,
      module: "rosetta.mjs",
      database: "rosetta.data",
      reason:
        "Private 1L2Y eight-protocol coordinate pilot and 76-residue 1UBQ scoring verified. Coverage is benchmark-specific; no residue-count admission cap.",
      packageBytes: bytes,
      peakHeapBytes: science.peakHeapBytes,
      maximumHeapBytes: 512 * 1024 ** 2,
      inputPolicy: {
        format: "PDB",
        chemistry: "standard amino acids",
        chains: 1,
        residueCountLimit: null,
      },
      largerInputBenchmark: {
        structure: "1UBQ",
        residues: inputs.residues,
        protocol: "score",
        preparedSha256: inputs.preparedSha256,
      },
      hashes: science.hashes,
      benchmarkInput: "1L2Y / first coordinate model / seed 17",
      browserBenchmarkInputs: {
        default: "1L2Y first coordinate model / 20 residues / seed 17",
        fastdesign: "1L2Y residues 1–8 / seed 17",
      },
      supportedProtocols: science.measurements.map((m) => m.protocol),
      verifiedBrowsers: browserProofs.map((proof) => ({
        name: proof.browserTarget,
        chromiumVersion: proof.chromiumVersion,
      })),
      liveGraphics: {
        sources: ["minimizing", "packing"],
        maxInternalSnapshotsPerSecond: 5,
        scoring: "ref2015",
        displayOnly: true,
      },
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Privately packaged measured engine. Run npm run build to include it in the extension.",
);
