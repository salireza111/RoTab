import { readFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, relative, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  ENGINE_HASHES,
  ENGINE_ID,
  SOURCE_SHA,
} from "../packages/rosetta-wasm/dist/index.js";

const out = resolve("dist/rosetta-wasm-standalone");
const engine = resolve("engine/artifacts/verified");
const manifest = JSON.parse(
  await readFile(resolve(engine, "manifest.json"), "utf8"),
);
if (
  !manifest.verified ||
  manifest.id !== ENGINE_ID ||
  manifest.sourceSha !== SOURCE_SHA
)
  throw new Error("Verified pinned engine unavailable.");
const proof = JSON.parse(
  await readFile("reports/wasm-protocol-proof.json", "utf8"),
);
const browsers = await Promise.all(
  ["chrome", "brave"].map(async (b) =>
    JSON.parse(await readFile(`reports/browser-protocols-${b}.json`, "utf8")),
  ),
);
for (const [name, expected] of Object.entries(ENGINE_HASHES)) {
  const actual = createHash("sha256")
    .update(await readFile(resolve(engine, name)))
    .digest("hex");
  if (
    actual !== expected ||
    manifest.hashes[name] !== expected ||
    !proof.passed ||
    proof.hashes[name] !== expected ||
    browsers.some((p) => !p.passed || p.hashes[name] !== expected)
  )
    throw new Error(
      `Scientific/browser evidence differs from SDK engine: ${name}`,
    );
}
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp("packages/rosetta-wasm/dist", resolve(out, "sdk"), {
  recursive: true,
});
await cp(engine, resolve(out, "engine"), { recursive: true });
await cp("packages/rosetta-wasm/examples", resolve(out, "example"), {
  recursive: true,
});
await cp(
  "apps/extension/public/fixtures/1l2y.pdb",
  resolve(out, "example/input.pdb"),
);
await cp("packages/rosetta-wasm/README.md", resolve(out, "README.md"));
await cp("packages/rosetta-wasm/NOTICE.md", resolve(out, "NOTICE.md"));
await cp("LICENSE", resolve(out, "ADAPTER_LICENSE"));
await cp(
  "packages/rosetta-wasm/THIRD_PARTY_LICENSES",
  resolve(out, "licenses/adapter"),
  { recursive: true },
);
const exec = promisify(execFile);
for (const [base, label] of [
  [".vendor/rosetta/source/external", "rosetta-external"],
  [".vendor/emsdk/upstream/emscripten/system/lib", "emscripten-runtime"],
]) {
  const { stdout } = await exec("rg", ["--files", "--hidden", "--no-ignore", "-g", "LICENSE*", "-g", "COPYING*", "-g", "COPYRIGHT*", "-g", "NOTICE*", "-g", "license*", base]);
  for (const source of stdout.trim().split("\n").filter(Boolean)) {
    if (source.split("/").includes(".git")) continue;
    const target = resolve(out, "licenses", label, relative(base, source));
    await mkdir(dirname(target), { recursive: true }); await cp(source, target);
  }
}
await cp(".vendor/emsdk/upstream/emscripten/LICENSE", resolve(out, "licenses/EMSCRIPTEN_LICENSE.txt"));
await writeFile(
  resolve(out, "bundle.json"),
  JSON.stringify(
    {
      kind: "private-scientific-bundle",
      publicDistributionApproved: false,
      engineId: ENGINE_ID,
      sourceSha: SOURCE_SHA,
      hashes: ENGINE_HASHES,
      entry: "example/index.html",
      participantDependencies: ["browser"],
      note: "Static assets only. No task API, native client or extension required. Rosetta licensing remains separate.",
    },
    null,
    2,
  ) + "\n",
);
console.log(
  `Prepared private standalone assets in ${out}. Nothing was published or served.`,
);
