// Operator-only porting experiment. Never used to execute server-supplied scripts.
import { readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const specPath = process.argv[2];
if (!specPath) throw new Error("Pass a local research job JSON file.");
const spec = JSON.parse(await readFile(specPath, "utf8"));
const modulePrefix = spec.modulePrefix ?? "rosetta-application";
if (!["rosetta-application", "rosetta-cyclic"].includes(modulePrefix))
  throw new Error("Unknown local scientific module.");
const source = await readFile(
  ".vendor/rosetta/source/src/apps/public/boinc/minirosetta.cc",
  "utf8",
);
const modes = [
  ...source.matchAll(/option\[\s*run::protocol\s*\]\s*\(\)\s*==\s*"([^"]+)"/g),
].map((m) => m[1]);
const compiledModes =
  modulePrefix === "rosetta-cyclic" ? ["simple_cycpep_predict"] : modes;
if (!compiledModes.includes(spec.protocol))
  throw new Error("Unknown upstream dispatch mode.");
if (
  !Array.isArray(spec.arguments) ||
  spec.arguments.some((v) => typeof v !== "string" || /[\r\n\0]/.test(v))
)
  throw new Error("Arguments must be strings without framing characters.");
if (
  spec.arguments.some((v) =>
    ["-database", "-in:path:database", "-run:protocol"].includes(v),
  )
)
  throw new Error("The host owns database and dispatch options.");
const folder = resolve("engine/artifacts/wasm");
const out = resolve(spec.outputDirectory ?? ".local/application-wasm-output");
await mkdir(out, { recursive: true });
const report = {
  sourceSha: "369e400415dd5c585f80dcf7b647147ee520e8ba",
  protocol: spec.protocol,
  passed: false,
  validationLevel: "output-smoke",
  compiledModes,
  modulePrefix,
  hashes: {},
  packageBytes: 0,
  peakHeapBytes: 0,
  inputs: [],
  outputs: [],
};
const started = performance.now();
try {
  for (const name of [
    modulePrefix + ".mjs",
    modulePrefix + ".wasm",
    modulePrefix + ".data",
  ]) {
    const bytes = await readFile(resolve(folder, name));
    report.packageBytes += bytes.length;
    report.hashes[name] = createHash("sha256").update(bytes).digest("hex");
  }
  const factory = (
    await import(pathToFileURL(resolve(folder, modulePrefix + ".mjs")).href)
  ).default;
  const module = await factory({
    locateFile: (name) => resolve(folder, name),
    print: () => {},
    printErr: (message) => console.error(message),
  });
  report.startupMs = performance.now() - started;
  module.FS.mkdir("/work");
  module.FS.chdir("/work");
  for (const file of spec.files ?? []) {
    if (
      typeof file.name !== "string" ||
      file.name !== basename(file.name) ||
      !/^[-a-zA-Z0-9_.]+$/.test(file.name) ||
      [".", ".."].includes(file.name)
    )
      throw new Error("Input filenames must be simple relative names.");
    if ((await stat(file.path)).size > 10_000_000)
      throw new Error("Research input exceeds 10 MB.");
    const bytes = await readFile(file.path);
    module.FS.writeFile(file.name, bytes);
    report.inputs.push({
      name: file.name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  const args = [
    "-database",
    "/database",
    "-run:protocol",
    spec.protocol,
    ...spec.arguments,
  ];
  const code = await module.ccall(
    "rosettatab_run_application",
    "number",
    ["string"],
    [args.join("\n")],
    { async: true },
  );
  report.exitCode = code;
  report.peakHeapBytes = module.HEAPU8.byteLength;
  for (const name of module.FS.readdir("/work")) {
    if (
      [".", ".."].includes(name) ||
      (spec.files ?? []).some((f) => f.name === name)
    )
      continue;
    const path = "/work/" + name;
    if (module.FS.isDir(module.FS.stat(path).mode)) continue;
    const bytes = module.FS.readFile(path);
    await writeFile(resolve(out, name), bytes);
    report.outputs.push({
      name,
      bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  if (
    code !== 0 ||
    !report.outputs.some(
      (f) => /\.(pdb|silent|out)$/.test(f.name) && f.bytes > 100,
    )
  )
    throw new Error(
      "The application did not produce a nonempty scientific structure output.",
    );
  report.passed = true;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
  console.error(report.error);
} finally {
  report.elapsedMs = performance.now() - started;
  await writeFile(
    resolve(out, "port-proof.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
