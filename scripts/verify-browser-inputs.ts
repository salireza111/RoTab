import { extensionEngineMetadataPath } from "./extension-engine-metadata";
import { chromium, expect as baseExpect } from "@playwright/test";
import { readFile, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import {
  prepareProteinPdb,
  validatePdb,
  withinTolerance,
} from "../packages/shared/src/index";
import { nativeValidator } from "./native-validator";

// Independent scientific acceptance, never a runtime dependency of the extension.
const extension = resolve(
  process.env.ROSETTATAB_CANDIDATE_DIR ?? ".local/browser-proof/extension",
);
const original = await readFile("engine/experiments/1ubq-original.pdb", "utf8");
const prepared = prepareProteinPdb(original);
const stats = validatePdb(prepared.pdb);
if (stats.residues !== 76) throw new Error("Larger input fixture changed.");
const digest = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");
const manifest = JSON.parse(
  await readFile(extensionEngineMetadataPath(extension), "utf8"),
);
for (const [name, hash] of Object.entries(manifest.hashes))
  if (digest(await readFile(resolve(extension, "engine", name))) !== hash)
    throw new Error("Candidate engine changed.");
process.env.ROSETTA_VALIDATOR = resolve(
  "engine/artifacts/native/rosettatab-native",
);
process.env.ROSETTA_DATABASE = resolve("engine/artifacts/database");
delete process.env.ROSETTA_VALIDATION_URL;
const rescore = await nativeValidator();
if (!rescore) throw new Error("Independent reference scorer unavailable.");
const reference = await rescore(prepared.pdb);
const report: any = {
  checkedAt: new Date().toISOString(),
  passed: false,
  scope:
    "Actual browser upload/preparation and WASM score of 76-residue 1UBQ; all HTTP(S) blocked; no API, Docker, BOINC or participant helper.",
  source: "https://files.rcsb.org/download/1UBQ.pdb",
  hashes: manifest.hashes,
  originalSha256: digest(original),
  preparedSha256: digest(prepared.pdb),
  preparation: prepared.report,
  residues: stats.residues,
  atoms: stats.atoms,
  nativeInputEnergy: reference,
  browsers: [],
  failures: [],
};
const expect = baseExpect.configure({ timeout: 20_000 });
try {
  for (const target of ["chrome", "brave"]) {
    const profile = await mkdtemp(resolve(tmpdir(), "rotab-input-"));
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
    try {
      let id = "gcffoelibgligbamdhimhhdboinmocfa";
      if (target === "chrome") {
        const cdp = await context.browser()!.newBrowserCDPSession();
        id = (await cdp.send("Extensions.loadUnpacked", { path: extension }))
          .id;
        await cdp.detach();
      }
      const requests: string[] = [];
      await context.route(/^https?:/, (route) => {
        requests.push(route.request().url());
        return route.abort();
      });
      await context.addInitScript(() => {
        localStorage.setItem(
          "rosettatab:preferences",
          JSON.stringify({
            view: "dashboard",
            apiUrl: "",
            automatic: false,
            workerCount: 1,
            dutyCycle: 75,
            weatherLocationAttempted: true,
          }),
        );
      });
      const page = await context.newPage();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`chrome-extension://${id}/index.html`);
      await page
        .getByRole("button", { name: "Computation settings", exact: true })
        .click();
      await page
        .getByLabel("Import benchmark input", { exact: true })
        .setInputFiles({
          name: "1ubq.pdb",
          mimeType: "chemical/x-pdb",
          buffer: Buffer.from(original),
        });
      await expect(page.locator(".protein-import-summary")).toContainText(
        "76 residues",
      );
      await page
        .getByRole("button", { name: "Close settings", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Start browser calculation", exact: true })
        .click();
      await expect(page.locator(".session-message")).toContainText(
        "Calculation complete.",
        { timeout: 300_000 },
      );
      const result = await page.evaluate(
        () =>
          new Promise<any>((resolve, reject) => {
            const request = indexedDB.open("rosettatab", 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
              const db = request.result;
              const read = db
                .transaction("state")
                .objectStore("state")
                .get("browser-results");
              read.onerror = () => reject(read.error);
              read.onsuccess = () => {
                db.close();
                resolve(read.result?.[0]);
              };
            };
          }),
      );
      expect(result.taskSource).toBe("benchmark");
      expect(result.task.inputHash).toBe(report.preparedSha256);
      expect(result.task.pdb).toBe(prepared.pdb);
      expect(result.benchmark.metadata.pdb).toBe(original);
      expect(result.benchmark.metadata.preparation.originalSha256).toBe(
        report.originalSha256,
      );
      const nativeOutput = await rescore(result.result.pdb);
      expect(withinTolerance(result.result.energy, nativeOutput)).toBe(true);
      expect(withinTolerance(result.result.energy, reference)).toBe(true);
      expect(validatePdb(result.result.pdb).residues).toBe(76);
      expect(requests.filter((url) => !url.includes("open-meteo.com"))).toEqual(
        [],
      );
      await writeFile(`reports/browser-input-${target}.pdb`, result.result.pdb);
      const measurement = {
        target,
        version: context.browser()?.version(),
        passed: true,
        protocol: "score",
        wasmEnergy: result.result.energy,
        nativeOutputEnergy: nativeOutput,
        elapsedMs: result.result.elapsedMs,
        outputSha256: digest(result.result.pdb),
        zeroServerRequests: true,
        allHttpRequestsBlocked: true,
        originalAndPreparedRetained: true,
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
  report.failures.push(String(error));
  process.exitCode = 1;
  console.error(error);
}
await writeFile(
  "reports/browser-input-proof.json",
  JSON.stringify(report, null, 2) + "\n",
);
