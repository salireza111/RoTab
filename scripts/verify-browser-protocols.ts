import { chromium } from "@playwright/test";
import { readFile, readdir, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { nativeValidator } from "./native-validator";
import {
  PROTOCOLS,
  ENGINE_ID,
  SOURCE_SHA,
  withinTolerance,
  validateResultIdentity,
} from "../packages/shared/src/index";

const target = process.argv.includes("--brave") ? "brave" : "chrome";
const extension = resolve(".local/browser-proof/extension");
const profile = resolve(".local/protocol-browser-" + randomUUID());
const report: any = {
  browserTarget: target,
  sourceSha: SOURCE_SHA,
  engineId: ENGINE_ID,
  passed: false,
  nondefaultVmFlags: false,
  hashes: {},
  measurements: [],
  failures: [],
};
for (const name of ["rosetta.mjs", "rosetta.wasm", "rosetta.data"])
  report.hashes[name] = createHash("sha256")
    .update(await readFile(resolve(extension, "engine", name)))
    .digest("hex");
const proof = JSON.parse(
  await readFile("reports/wasm-protocol-proof.json", "utf8"),
);
if (
  !proof.passed ||
  Object.keys(report.hashes).some(
    (name) => report.hashes[name] !== proof.hashes[name],
  )
)
  throw new Error("The exact Node/native scientific proof must pass first.");
const context = await chromium.launchPersistentContext(profile, {
  executablePath:
    target === "chrome"
      ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
      : "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  headless: true,
  ...(target === "chrome"
    ? { ignoreDefaultArgs: ["--disable-extensions"] }
    : {}),
  args:
    target === "chrome"
      ? ["--enable-unsafe-extension-debugging"]
      : [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
});
report.chromiumVersion = context.browser()?.version();
let timer: ReturnType<typeof setTimeout> | undefined;
try {
  let extensionId = "gcffoelibgligbamdhimhhdboinmocfa";
  if (target === "chrome") {
    const cdp = await context.browser()!.newBrowserCDPSession();
    extensionId = (
      await cdp.send("Extensions.loadUnpacked", { path: extension })
    ).id;
    await cdp.detach();
  }
  await context.route("https://**open-meteo.com/**", (r) => r.abort());
  await context.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
  let accept: (data: any) => void = () => {},
    fail: (error: Error) => void = () => {};
  let frames: any[] = [];
  await context.exposeBinding("recordProtocol", (_source, event) => {
    if (event.type === "snapshot") frames.push(event);
    if (event.type === "result") accept(event);
    if (event.type === "error") fail(new Error(event.message));
  });
  const page = await context.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  page.on("crash", () => fail(new Error("Browser renderer crashed.")));
  await page.goto(`chrome-extension://${extensionId}/index.html`);
  const workers = (await readdir(resolve(extension, "assets"))).filter((name) =>
    /^science\.worker-.*\.js$/.test(name),
  );
  if (workers.length !== 1)
    throw new Error("Expected one bundled scientific worker.");
  await page.evaluate((worker) => {
    const science = new Worker("./assets/" + worker, { type: "module" });
    (window as any).__protocolWorker = science;
    science.onmessage = (event) => (window as any).recordProtocol(event.data);
    science.onerror = (event) =>
      (window as any).recordProtocol({ type: "error", message: event.message });
  }, workers[0]);
  process.env.ROSETTA_VALIDATOR = resolve(
    "engine/artifacts/native/rosettatab-native",
  );
  process.env.ROSETTA_DATABASE = resolve("engine/artifacts/database");
  delete process.env.ROSETTA_VALIDATION_URL;
  const scorer = await nativeValidator();
  if (!scorer) throw new Error("Native scorer unavailable.");
  const pdb = await readFile("apps/extension/public/fixtures/1l2y.pdb", "utf8");
  // Keep one worker to test sequential protocols and global-state isolation. The
  // separate recovery proof covers fresh-worker restarts and exclusive ownership.
  for (const definition of PROTOCOLS) {
    // FastDesign uses the documented eight-residue browser fixture. The Node
    // proof records whether it used this fixture or the full 20-residue case.
    // Retain the scientific algorithm and strict returned-coordinate rescore.
    const casePdb =
      definition.id === "fastdesign"
        ? pdb
            .split(/\r?\n/)
            .filter(
              (line) =>
                line.startsWith("ATOM  ") && Number(line.slice(22, 26)) <= 8,
            )
            .join("\n") + "\nEND\n"
        : pdb;
    frames = [];
    const started = performance.now();
    const done = new Promise<any>((res, rej) => {
      accept = res;
      fail = rej;
    });
    timer = setTimeout(
      () => fail(new Error(definition.id + " exceeded 30 minutes.")),
      1_800_000,
    );
    await page.evaluate(
      (task) =>
        (window as any).__protocolWorker.postMessage({
          type: "run",
          task,
          dutyCycle: 75,
        }),
      {
        pdb: casePdb,
        protocol: definition.id,
        seed: 17,
        engineId: ENGINE_ID,
        sourceSha: SOURCE_SHA,
      },
    );
    const result = await done;
    clearTimeout(timer);
    timer = undefined;
    validateResultIdentity(casePdb, result.pdb, definition.id);
    const nativeEnergy = await scorer(result.pdb);
    if (!withinTolerance(result.energy, nativeEnergy))
      throw new Error(definition.id + ": native rescore disagrees.");
    if (
      definition.id === "score" &&
      !withinTolerance(
        result.energy,
        proof.measurements.find((m: any) => m.protocol === "score")
          .nativeEnergy,
      )
    )
      throw new Error("Fixed-coordinate score mismatch.");
    const minimizing = frames.filter((f) => f.source === "minimizing").length,
      packing = frames.filter((f) => f.source === "packing").length;
    if (definition.id === "relax") {
      if (
        minimizing < 3 ||
        packing < 1 ||
        Math.abs(result.energy - -48.17565422427388) > 1e-9
      )
        throw new Error("Seeded FastRelax/live graphics regression.");
      report.liveView = {
        seededResultUnchanged: true,
        minimizingSnapshots: minimizing,
        packingSnapshots: packing,
      };
    }
    if (result.heapBytes > 512 * 1024 ** 2)
      throw new Error("Heap exceeds 512 MiB.");
    const measurement = {
      protocol: definition.id,
      input:
        definition.id === "fastdesign"
          ? "1L2Y residues 1–8"
          : "1L2Y first model",
      inputSha256: createHash("sha256").update(casePdb).digest("hex"),
      energy: result.energy,
      nativeEnergy,
      sequence: result.sequence,
      elapsedMs: performance.now() - started,
      heapBytes: result.heapBytes,
      snapshots: frames.length,
      minimizingSnapshots: minimizing,
      packingSnapshots: packing,
      passed: true,
    };
    report.measurements.push(measurement);
    console.log(target, JSON.stringify(measurement));
    await writeFile(
      `reports/browser-protocols-${target}.json`,
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  // An unsupported request must not be silently routed to the scoring adapter.
  const rejected = new Promise<string>((res, rej) => {
    fail = (error) => res(error.message);
    accept = () => rej(new Error("Unknown protocol executed."));
  });
  await page.evaluate(
    (task) =>
      (window as any).__protocolWorker.postMessage({
        type: "run",
        task,
        dutyCycle: 25,
      }),
    {
      pdb,
      protocol: "ligand_dock",
      seed: 17,
      engineId: ENGINE_ID,
      sourceSha: SOURCE_SHA,
    },
  );
  report.unknownProtocolRejected = !!(await rejected);
  report.passed = true;
} catch (error) {
  report.failures.push(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
  console.error(report.failures.at(-1));
} finally {
  if (timer) clearTimeout(timer);
  await context.close();
  await rm(profile, { recursive: true, force: true });
  await writeFile(
    `reports/browser-protocols-${target}.json`,
    JSON.stringify(report, null, 2) + "\n",
  );
}
