import { chromium } from "@playwright/test";
import { readFile, readdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { nativeValidator } from "./native-validator";


// Isolate genuine VM execution from tab ownership and queue control.
const extension = resolve(
  process.env.ROSETTATAB_CANDIDATE_DIR ?? ".local/browser-proof/extension",
);
const profile = resolve(".local/browser-measure-" + randomUUID());
const experiment = process.argv.includes("--liftoff");
const singleCompiler = process.argv.includes("--single-compiler");
const traceCompiler = process.argv.includes("--trace-compiler");
const browserTarget = process.argv.includes("--brave")
  ? "brave"
  : process.argv.includes("--chrome")
    ? "chrome"
    : "chromium";
const executablePath =
  browserTarget === "brave"
    ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
    : browserTarget === "chrome"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : undefined;
const events: any[] = [];
const hashes: Record<string, string> = {};
for (const file of ["rosetta.mjs", "rosetta.wasm", "rosetta.data"])
  hashes[file] = createHash("sha256")
    .update(await readFile(resolve(extension, "engine", file)))
    .digest("hex");
const start = performance.now();
const context = await chromium.launchPersistentContext(profile, {
  ...(executablePath ? { executablePath } : { channel: "chromium" }),
  headless: true,
  ...(browserTarget === "chrome"
    ? { ignoreDefaultArgs: ["--disable-extensions"] }
    : {}),
  args: [
    ...(browserTarget === "chrome"
      ? []
      : [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ]),
    "--enable-logging=stderr",
    ...(browserTarget === "chrome"
      ? ["--enable-unsafe-extension-debugging"]
      : []),
    ...(experiment || singleCompiler || traceCompiler
      ? [
          "--js-flags=" +
            [
              experiment ? "--liftoff --no-wasm-tier-up" : "",
              singleCompiler ? "--wasm-num-compilation-tasks=1" : "",
              traceCompiler ? "--trace-wasm-compilation-times" : "",
            ]
              .filter(Boolean)
              .join(" "),
        ]
      : []),
  ],
});
const report: any = {
  browserTarget,
  chromiumVersion: context.browser()?.version(),
  nondefaultVmFlags: experiment || singleCompiler || traceCompiler,
  singleCompiler,
  traceCompiler,
  hashes,
  passed: false,
  events,
};
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  let extensionId = "gcffoelibgligbamdhimhhdboinmocfa";
  if (browserTarget === "chrome") {
    const debuggerSession = await context.browser()!.newBrowserCDPSession();
    const loaded = await debuggerSession.send("Extensions.loadUnpacked", {
      path: extension,
    });
    extensionId = loaded.id;
    report.extensionId = extensionId;
    report.loadedExtensions = await debuggerSession.send(
      "Extensions.getExtensions",
    );
    await debuggerSession.detach();
  }
  await context.route("https://**open-meteo.com/**", (r) => r.abort());
  await context.addInitScript({
    content: `
    globalThis.__name = (fn) => fn;
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (['webgl','webgl2','experimental-webgl'].includes(type)) return null;
      return get.call(this, type, ...args);
    };
  `,
  });
  let accept!: (value: any) => void, fail!: (reason: Error) => void;
  const done = new Promise<any>((res, rej) => {
    accept = res;
    fail = rej;
  });
  await context.exposeBinding("recordEngine", (_source, event) => {
    events.push({ ...event, elapsedMs: performance.now() - start });
    if (event.type === "result") accept(event);
    if (event.type === "error") fail(new Error(event.message));
    console.log(
      event.type,
      event.phase ?? "",
      event.progress ?? "",
      event.energy ?? "",
      event.message ?? "",
    );
  });
  const page = await context.newPage();
  page.on("crash", () =>
    fail(
      new Error("Chromium renderer crashed during genuine engine execution."),
    ),
  );
  page.on("pageerror", (e) => console.log("Page error: " + e.message));
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  const workers = (await readdir(resolve(extension, "assets"))).filter(
    (f) => f.startsWith("science.worker-") && f.endsWith(".js"),
  );
  if (workers.length !== 1)
    throw new Error(
      "Expected one packaged scientific worker; rebuild the candidate to remove stale bundles.",
    );
  const worker = workers[0];
  if (!worker) throw new Error("Packaged scientific worker missing.");
  const pdb = await readFile("apps/extension/public/fixtures/1l2y.pdb", "utf8");
  await page.evaluate(
    ({ worker, pdb }) => {
      const actual = new Worker("./assets/" + worker, { type: "module" });
      actual.onmessage = (event) => (window as any).recordEngine(event.data);
      actual.onerror = (event) =>
        (window as any).recordEngine({ type: "error", message: event.message });
      actual.postMessage({
        type: "run",
        dutyCycle: 25,
        diagnostics: true,
        task: { pdb, protocol: "relax", seed: 17, engineId: "rosetta-protocols-v2", sourceSha: "369e400415dd5c585f80dcf7b647147ee520e8ba" },
      });
    },
    { worker, pdb },
  );
  timer = setTimeout(
    () =>
      fail(
        new Error("Browser engine exceeded the 10-minute experiment budget."),
      ),
    600_000,
  );
  const result = await done;
  process.env.ROSETTA_VALIDATOR = resolve(
    "engine/artifacts/native/rosettatab-native",
  );
  process.env.ROSETTA_DATABASE = resolve("engine/artifacts/database");
  delete process.env.ROSETTA_VALIDATION_URL;
  const scorer = await nativeValidator();
  if (!scorer) throw new Error("Real native scorer unavailable.");
  const energy = await scorer(result.pdb);
  if (
    Math.abs(energy - result.energy) >
    Math.max(0.001, Math.abs(energy) * 0.00001)
  )
    throw new Error("Native rescore disagrees.");
  const snapshots = events.filter((e) => e.type === "snapshot");
  const minimizing = snapshots.filter((e) => e.source === "minimizing");
  const packing = snapshots.filter((e) => e.source === "packing");
  if (minimizing.length < 3 || packing.length < 1)
    throw new Error(
      "Real browser did not stream internal minimizer and packing states.",
    );
  if (Math.abs(result.energy - -48.17565422427388) > 1e-9)
    throw new Error("Graphics reporting changed the pinned seeded result.");
  report.liveView = {
    snapshots: snapshots.length,
    minimizingSnapshots: minimizing.length,
    packingSnapshots: packing.length,
    seededResultUnchanged: true,
  };
  report.passed = true;
  report.nativeRescore = energy;
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  console.log(report.error);
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  await context.close();
  await rm(profile, { recursive: true, force: true });
  // PDB coordinates are inputs/results, not necessary for the small diagnostic report.
  for (const event of events) delete event.pdb;
  await writeFile(
    `reports/browser-vm-${browserTarget}-${traceCompiler ? "trace" : singleCompiler ? "single-compiler" : experiment ? "liftoff" : "default"}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
}
