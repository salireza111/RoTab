import { extensionEngineMetadataPath } from "./extension-engine-metadata";
import { chromium, expect as baseExpect, type Page } from "@playwright/test";
import { mkdtemp, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { resolve, relative } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import {
  ENGINE_ID,
  SOURCE_SHA,
  withinTolerance,
  type Checkpoint,
} from "../packages/shared/src/index";
import { nativeValidator } from "./native-acceptance-validator";

// Scientific acceptance test only. Native rescoring is independent test evidence;
// the installed extension never calls it or any HTTP service to run/finish a task.
// Candidate mode never enables an unmeasured engine in the user's installation.
const extension = resolve(
  process.env.ROSETTATAB_CANDIDATE_DIR ??
    (process.argv.includes("--candidate")
      ? ".local/browser-proof/extension"
      : "dist/extension"),
);
const manifest = JSON.parse(
  await readFile(extensionEngineMetadataPath(extension), "utf8"),
);
const runtimeHashes: Record<string, string> = {};
for (const name of ["index.html", "manifest.json", "background.js",
  ...(await readdir(resolve(extension, "assets"))).map((name) => `assets/${name}`)])
  runtimeHashes[name] = createHash("sha256")
    .update(await readFile(resolve(extension, name))).digest("hex");
const engineMetadataPath = relative(extension, extensionEngineMetadataPath(extension));
const engineMetadataSha256 = createHash("sha256")
  .update(await readFile(extensionEngineMetadataPath(extension))).digest("hex");
if (
  !manifest.verified ||
  manifest.id !== ENGINE_ID ||
  manifest.sourceSha !== SOURCE_SHA
)
  throw new Error("Build with the verified packaged engine first.");
const hashes: Record<string, string> = {};
for (const file of ["rosetta.mjs", "rosetta.wasm", "rosetta.data"]) {
  hashes[file] = createHash("sha256")
    .update(await readFile(resolve(extension, "engine", file)))
    .digest("hex");
  if (hashes[file] !== manifest.hashes[file])
    throw new Error("Packaged engine hash mismatch.");
}
delete process.env.ROSETTA_VALIDATION_URL;
process.env.ROSETTA_VALIDATOR = resolve(
  "engine/artifacts/native/rosettatab-native",
);
process.env.ROSETTA_DATABASE = resolve("engine/artifacts/database");
const rescore = await nativeValidator();
if (!rescore) throw new Error("Independent test scorer is unavailable.");
const report: any = {
  checkedAt: new Date().toISOString(),
  engineId: ENGINE_ID,
  sourceSha: SOURCE_SHA,
  hashes,
  runtimeHashes,
  engineMetadataPath,
  engineMetadataSha256,
  scope:
    "Standalone packaged extension; all HTTP(S) requests blocked; no task API/database/validator service. Independent native rescoring runs only in this test process.",
  passed: false,
  browsers: [],
  failures: [],
};
const state = (page: Page, key: string) =>
  page.evaluate(
    (key) =>
      new Promise<any>((resolve, reject) => {
        const open = indexedDB.open("rosettatab", 1);
        open.onsuccess = () => {
          const database = open.result;
          const read = database
            .transaction("state")
            .objectStore("state")
            .get(key);
          read.onsuccess = () => {
            database.close();
            resolve(read.result);
          };
          read.onerror = () => {
            database.close();
            reject(read.error);
          };
        };
        open.onerror = () => reject(open.error);
      }),
    key,
  );
const expect = baseExpect.configure({ timeout: 20_000 });
const liveProof = process.argv.includes("--live-proof");
try {
  for (const target of ["chrome", "brave"]) {
    const profile = await mkdtemp(resolve(tmpdir(), "rosettatab-standalone-"));
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
      viewport: { width: 1440, height: 1060 },
    });
    let starts = 0,
      snapshots = 0,
      maxHeapBytes = 0,
      active = 0,
      maxActive = 0;
    const phases: string[] = [],
      requests: string[] = [],
      errors: string[] = [];
    try {
      let id: string;
      if (target === "chrome") {
        const cdp = await context.browser()!.newBrowserCDPSession();
        id = (await cdp.send("Extensions.loadUnpacked", { path: extension }))
          .id;
        await cdp.detach();
      } else {
        const worker = context.serviceWorkers().find((worker) => worker.url().endsWith("/background.js"))
          ?? await context.waitForEvent("serviceworker", { predicate: (worker) => worker.url().endsWith("/background.js") });
        id = new URL(worker.url()).host;
      }
      await context.route(/^https?:/, (route) => {
        requests.push(route.request().url());
        return route.abort("internetdisconnected");
      });
      await context.exposeBinding("standaloneEvent", (_source, e) => {
        if (e.kind === "start") {
          starts++;
          active++;
          maxActive = Math.max(maxActive, active);
        }
        if (e.kind === "stop") active--;
        if (e.type === "snapshot") snapshots++;
        if (e.type === "telemetry" && Number.isFinite(e.heapBytes))
          maxHeapBytes = Math.max(maxHeapBytes, e.heapBytes);
        if (e.type === "phase" && !phases.includes(e.phase)) {
          phases.push(e.phase);
          console.log(target, e.phase);
        }
        if (e.type === "error") errors.push(e.message);
      });
      await context.addInitScript({
        content: "globalThis.__name = (fn) => fn;",
      });
      await context.addInitScript(() => {
        // 75% is a test-only runtime reduction; the shipped default remains 25%.
        if (!localStorage.getItem("rosettatab:preferences"))
          localStorage.setItem(
            "rosettatab:preferences",
            JSON.stringify({
              view: "dashboard",
              apiUrl: "",
              automatic: false,
              dutyCycle: 75,
              workerCount: 1,
              weatherLocationAttempted: true,
              browserProtocol: "relax",
            }),
          );
        const report = (event: any) =>
          (window as any).standaloneEvent(event).catch(() => {});
        const Original = window.Worker;
        window.Worker = class extends Original {
          private scientific = false;
          private stopped = false;
          constructor(url: string | URL, options?: WorkerOptions) {
            super(url, options);
            this.scientific = String(url).includes("science.worker");
            if (this.scientific) {
              report({ kind: "start" });
              this.addEventListener("message", (e) => {
                const { type, phase, message, heapBytes } = e.data;
                report({ type, phase, message, heapBytes });
              });
            }
          }
          terminate() {
            if (this.scientific && !this.stopped) {
              this.stopped = true;
              report({ kind: "stop" });
            }
            super.terminate();
          }
        };
      });
      const url = `chrome-extension://${id}/index.html`;
      const first = await context.newPage();
      await first.emulateMedia({ reducedMotion: "reduce" });
      await first.goto(url);
      const metadataResponse = await first.evaluate(async (path) => {
        const response = await fetch(path);
        return { status: response.status, body: await response.json() };
      }, engineMetadataPath);
      expect(metadataResponse.status).toBe(200);
      expect(metadataResponse.body).toEqual(manifest);
      const extensionManifest = await first.evaluate(() =>
        chrome.runtime.getManifest(),
      );
      if (
        extensionManifest.permissions?.some((permission: string) =>
          ["nativeMessaging", "system.cpu", "system.memory"].includes(
            permission,
          ),
        ) ||
        extensionManifest.host_permissions?.some((p: string) =>
          p.startsWith("http:"),
        )
      )
        throw new Error(
          "The standalone build includes a native or local-server dependency.",
        );
      await first
        .getByRole("button", { name: "Computation settings", exact: true })
        .click();
      await expect(
        first.getByRole("button", {
          name: "Start live demo",
          exact: true,
        }),
      ).toBeEnabled();
      await first
        .getByRole("button", { name: "Start live demo", exact: true })
        .click();
      await expect.poll(() => starts).toBe(1);
      await first
        .getByRole("button", { name: "Pause calculation", exact: true })
        .click();
      await expect(first.locator(".session-message")).toContainText("Paused.");
      await expect(first.locator('[data-metric="engine"]')).toHaveCount(0);
      const checkpoint = (await state(first, "checkpoint")) as Checkpoint;
      expect(checkpoint.taskSource).toBe("bundled");
      const linked = await Promise.all(
        Array.from({ length: 9 }, async () => {
          const page = await context.newPage();
          await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(url);
          return page;
        }),
      );
      await expect
        .poll(
          async () =>
            (
              await Promise.all(
                [first, ...linked].map((p) =>
                  p.locator(".session-badge").textContent(),
                ),
              )
            ).filter((x) => x === "Computing tab").length,
        )
        .toBe(1);
      await first.close();
      let owner: Page | undefined;
      await expect
        .poll(async () => {
          for (const page of linked)
            if (
              (await page.locator(".session-badge").textContent()) ===
              "Computing tab"
            ) {
              owner = page;
              return true;
            }
          return false;
        })
        .toBe(true);
      let computing = owner!;
      const recovered = (await state(computing, "checkpoint")) as Checkpoint;
      expect(recovered.task.id).toBe(checkpoint.task.id);
      expect(recovered.task.seed).toBe(checkpoint.task.seed);
      if (liveProof) {
        console.log(target, "Checking paused-owner renderer crash recovery");
        // Extension pages can share a renderer. Crash acknowledgement, rather
        // than the CDP command response, is the completion signal: Page.crash
        // can leave its response pending after the renderer exits.
        const crashed = computing;
        const cdp = await context.newCDPSession(crashed);
        const crash = crashed.waitForEvent("crash", { timeout: 20_000 });
        void cdp.send("Page.crash").catch(() => {});
        await crash;
        console.log(target, "Renderer crash observed");
        void cdp.detach().catch(() => {});
        await Promise.all(linked.map((page) => page.close().catch(() => {})));
        computing = await context.newPage();
        await computing.emulateMedia({ reducedMotion: "reduce" });
        await computing.goto(url);
        console.log(target, "Restoring the browser checkpoint");
        await expect(computing.locator(".session-badge")).toHaveText(
          "Computing tab",
        );
        expect((await state(computing, "checkpoint")).task.id).toBe(
          checkpoint.task.id,
        );
        expect((await state(computing, "checkpoint")).task.seed).toBe(
          checkpoint.task.seed,
        );
        await computing
          .getByRole("button", { name: "Toggle automatic orbit", exact: true })
          .click();
      }
      await computing
        .getByRole("button", { name: "Resume calculation", exact: true })
        .click();
      await expect(computing.locator('[data-metric="engine"]')).toBeVisible({
        timeout: 300_000,
      });
      await expect
        .poll(() => maxHeapBytes, { timeout: 20_000 })
        .toBeGreaterThan(0);
      await expect(computing.locator('[data-metric="ui-heap"]')).toBeVisible();
      await expect
        .poll(() => snapshots, { timeout: 300_000 })
        .toBeGreaterThan(1);
      if (liveProof) {
        const before = createHash("sha256")
          .update(await computing.locator(".molecular-canvas").screenshot())
          .digest("hex");
        const beforeGraph = await computing
          .locator(".current-energy-trace")
          .getAttribute("d");
        const beforeCount = snapshots;
        await expect
          .poll(() => snapshots, { timeout: 120_000 })
          .toBeGreaterThan(beforeCount + 2);
        await expect
          .poll(() =>
            computing.locator(".current-energy-trace").getAttribute("d"),
          )
          .not.toBe(beforeGraph);
        await expect
          .poll(async () =>
            createHash("sha256")
              .update(await computing.locator(".molecular-canvas").screenshot())
              .digest("hex"),
          )
          .not.toBe(before);
      }
      await computing.setViewportSize({ width: 1440, height: 900 });
      await computing.screenshot({
        path: `reports/observatory-live-${target}.png`,
      });
      await expect(computing.locator(".session-message")).toContainText(
        "Calculation complete.",
        { timeout: 15 * 60_000 },
      );
      await expect(computing.locator('[data-metric="engine"]')).toHaveCount(0);
      await expect(computing.locator('[data-metric="ui-heap"]')).toBeVisible();
      const results = (await state(
        computing,
        "browser-results",
      )) as Checkpoint[];
      expect(results).toHaveLength(1);
      expect(await state(computing, "checkpoint")).toBeUndefined();
      const result = results[0].result!;
      const nativeEnergy = await rescore(result.pdb);
      expect(withinTolerance(result.energy, nativeEnergy)).toBe(true);
      const download = computing.waitForEvent("download");
      await computing
        .getByRole("button", {
          name: "Download calculated protein",
          exact: true,
        })
        .click();
      const savedDownload = await download;
      expect(await readFile((await savedDownload.path())!, "utf8")).toBe(
        result.pdb,
      );
      await computing.reload();
      await expect(computing.locator(".session-message")).toContainText(
        "Calculation complete.",
      );
      expect(await state(computing, "browser-results")).toHaveLength(1);
      expect(starts).toBe(2);
      expect(maxActive).toBe(1);
      expect(errors).toEqual([]);
      expect(requests.filter((r) => !r.includes("open-meteo.com"))).toEqual([]);
      const measurement = {
        target,
        browserVersion: context.browser()?.version(),
        engineMetadataLoaded: true,
        tenTabsOneOwner: true,
        pauseAndOwnerHandover: true,
        restoredSeed: checkpoint.task.seed,
        protocol: results[0].task.protocol,
        taskId: results[0].task.id,
        wasmEnergy: result.energy,
        nativeEnergy,
        elapsedMs: result.elapsedMs,
        snapshots,
        maxHeapBytes,
        measuredUiHeap: true,
        wasmMemoryVisibleWhileRunning: true,
        wasmMemoryClearedOnPauseAndCompletion: true,
        workerStarts: starts,
        maxActiveWorkers: maxActive,
        serverRequests: 0,
        allExternalRequestsBlocked: true,
        savedAndDownloaded: true,
        restoredOnReload: true,
        ...(liveProof
          ? {
              liveView: {
                cameraOrbit: false,
                changedCanvas: true,
                changedEnergyGraph: true,
              },
              pausedOwnerCrashRecovery: true,
            }
          : {}),
        phases,
      };
      report.browsers.push(measurement);
      console.log(JSON.stringify(measurement));
    } finally {
      await context.close();
      await rm(profile, { recursive: true, force: true });
    }
  }
  report.passed = true;
} catch (error) {
  report.failures.push(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
  console.error(error);
}
await writeFile(
  "reports/standalone-browser-proof.json",
  JSON.stringify(report, null, 2) + "\n",
);
