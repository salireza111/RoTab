import { build } from "esbuild";
import ts from "typescript";
import { cp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { resolve, relative } from "node:path";

const root = resolve("packages/rosetta-wasm"),
  source = resolve(root, "src"),
  dist = resolve(root, "dist");
const declarations = resolve(".local/sdk-declarations");
await rm(dist, { recursive: true, force: true });
await rm(declarations, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
const methods = (await readdir(resolve(source, "methods"))).filter((x) =>
  x.endsWith(".ts"),
);
const entryPoints = {
  index: resolve(source, "index.ts"),
  worker: resolve(source, "worker.ts"),
};
for (const file of methods)
  entryPoints["methods/" + file.slice(0, -3)] = resolve(
    source,
    "methods",
    file,
  );
await build({
  entryPoints,
  outdir: dist,
  bundle: true,
  splitting: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  minify: false,
  legalComments: "eof",
});
const roots = [
  "index.ts",
  "client.ts",
  "input.ts",
  "types.ts",
  "validation.ts",
  "worker.ts",
  ...methods.map((m) => "methods/" + m),
].map((p) => resolve(source, p));
const program = ts.createProgram(roots, {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.ESNext,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  declaration: true,
  emitDeclarationOnly: true,
  strict: true,
  skipLibCheck: true,
  esModuleInterop: true,
  rootDir: resolve("."),
  outDir: declarations,
});
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length)
  throw new Error(
    ts.formatDiagnosticsWithColorAndContext(diagnostics, {
      getCanonicalFileName: (f) => f,
      getCurrentDirectory: () => process.cwd(),
      getNewLine: () => "\n",
    }),
  );
program.emit();
await cp(resolve(declarations, relative(resolve("."), source)), dist, {
  recursive: true,
});
await cp("LICENSE", resolve(root, "LICENSE"));
await mkdir(resolve(root, "THIRD_PARTY_LICENSES"), { recursive: true });
await cp(
  "node_modules/zod/LICENSE",
  resolve(root, "THIRD_PARTY_LICENSES/Zod.txt"),
);
// No declaration may depend on private monorepo files after extraction.
for (const name of await readdir(dist, { recursive: true }))
  if (name.endsWith(".d.ts")) {
    if ((await readFile(resolve(dist, name), "utf8")).includes("shared/src"))
      throw new Error(`Private declaration dependency in ${name}`);
  }
console.log(
  "Built standalone browser SDK and declarations. Rosetta scientific assets are separate.",
);
