/** Developer-only acceptance. An ephemeral loopback server streams one WASM asset;
 * it runs no calculation/API and is always closed when the test finishes. */
import { chromium } from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, extname } from "node:path";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import type { AddressInfo } from "node:net";
import { nativeValidator } from "./native-validator";
import {
  ENGINE_HASHES,
  ENGINE_ID,
  SOURCE_SHA,
  type Protocol,
} from "../packages/rosetta-wasm/src/types";
import {
  withinTolerance,
  prepareProteinPdb,
  validatePdb,
} from "../packages/shared/src/index";

const root = resolve("dist/rosetta-wasm-standalone");
const largeInput = process.env.ROSETTATAB_SDK_LARGE_INPUT
  ? prepareProteinPdb(
      await readFile(process.env.ROSETTATAB_SDK_LARGE_INPUT, "utf8"),
    ).pdb
  : undefined;
process.env.ROSETTA_VALIDATOR = resolve(
  "engine/artifacts/native/rosettatab-native",
);
process.env.ROSETTA_DATABASE = resolve("engine/artifacts/database");
delete process.env.ROSETTA_VALIDATION_URL;
const scorer = await nativeValidator();
if (!scorer)
  throw new Error(
    "Developer native scorer missing; never a consumer dependency.",
  );
const hash = (data: Buffer | string) =>
  createHash("sha256").update(data).digest("hex");
const sdkHashes: Record<string, string> = {};
const { readdir } = await import("node:fs/promises");
for (const name of await readdir(resolve(root, "sdk"), { recursive: true }))
  if (name.endsWith(".js"))
    sdkHashes[name] = hash(await readFile(resolve(root, "sdk", name)));
for (const [name, expected] of Object.entries(ENGINE_HASHES))
  if (hash(await readFile(resolve(root, "engine", name))) !== expected)
    throw new Error(`Engine asset differs: ${name}`);
const report: any = {
  generatedAt: new Date().toISOString(),
  passed: false,
  engineId: ENGINE_ID,
  sourceSha: SOURCE_SHA,
  hashes: ENGINE_HASHES,
  sdkHashes,
  scope:
    "Standalone SDK browser score, minimize and relax; 1L2Y seed 17. Existing engine eight-protocol gates are separate.",
  noTaskServerStarted: true,
  staticAssetDelivery:
    "Developer-only ephemeral loopback streaming of the exact bundled WASM file; all other SDK/assets delivered by browser fixture routes. No extension, API or task server. Listener closes in finally.",
  browsers: [],
};
const targets = process.argv.includes("--chrome-only")
  ? ["chrome"]
  : ["chrome", "brave"];
const staticAsset = createServer((request, response) => {
  if (request.method !== "GET" || request.url !== "/engine/rosetta.wasm") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/wasm" });
  const stream = createReadStream(resolve(root, "engine/rosetta.wasm"));
  stream.on("error", () => response.destroy());
  response.on("close", () => stream.destroy());
  stream.pipe(response);
});
await new Promise<void>((resolve, reject) => {
  staticAsset.once("error", reject);
  staticAsset.listen(0, "127.0.0.1", resolve);
});
const origin = `http://127.0.0.1:${(staticAsset.address() as AddressInfo).port}`;
try {
  report.browsers = await Promise.all(
    targets.map(async (target) => {
      const browser = await chromium.launch({
        executablePath:
          target === "chrome"
            ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            : "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        headless: true,
      });
      const context = await browser.newContext();
      // tsx preserves callback names in serialized Playwright functions. This is test harness support only.
      await context.addInitScript({
        content: "globalThis.__name = (fn) => fn;",
      });
      const evidence: any = {
        target,
        chromiumVersion: browser.version(),
        passed: false,
        measurements: [],
        unexpectedRequests: [],
      };
      const captured: any[] = [];
      try {
        await context.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== origin) {
            evidence.unexpectedRequests.push(url.origin);
            await route.abort();
            return;
          }
          // CDP fulfillment base64 exceeds its 100 MB pipe limit; stream the exact static file.
          if (url.pathname === "/engine/rosetta.wasm") {
            await route.continue();
            return;
          }
          if (url.pathname === "/probe.html") {
            await route.fulfill({
              contentType: "text/html",
              body: "<!doctype html><title>Standalone SDK verification</title>",
            });
            return;
          }
          if (url.pathname === "/tampered/manifest.json") {
            const manifest = JSON.parse(
              await readFile(resolve(root, "engine/manifest.json"), "utf8"),
            );
            manifest.verified = false;
            await route.fulfill({
              contentType: "application/json",
              body: JSON.stringify(manifest),
            });
            return;
          }
          if (url.pathname.startsWith("/bad-hash/")) {
            const name = url.pathname.slice("/bad-hash/".length);
            if (name === "rosetta.mjs") {
              await route.fulfill({
                contentType: "application/javascript",
                body: "// deliberately wrong bytes",
              });
              return;
            }
            if (name === "manifest.json") {
              await route.fulfill({
                contentType: "application/json",
                body: await readFile(resolve(root, "engine/manifest.json")),
              });
              return;
            }
          }
          const pathname = decodeURIComponent(url.pathname).slice(1);
          const file = resolve(root, pathname);
          if (
            !file.startsWith(root + "/") ||
            !/^(sdk|engine|example)\//.test(pathname)
          ) {
            await route.abort();
            return;
          }
          try {
            await route.fulfill({
              contentType:
                (
                  {
                    ".js": "application/javascript",
                    ".mjs": "application/javascript",
                    ".wasm": "application/wasm",
                    ".json": "application/json",
                    ".html": "text/html",
                  } as Record<string, string>
                )[extname(file)] ?? "application/octet-stream",
              body: await readFile(file),
            });
          } catch {
            await route.fulfill({ status: 404, body: "Missing fixture" });
          }
        });
        await context.exposeBinding("captureSdk", (_source, event) => {
          captured.push(event);
        });
        const page = await context.newPage();
        await page.goto(origin + "/probe.html");
        await page.evaluate(async () => {
          const sdkPath = "/sdk/index.js";
          const sdk = await import(/* @vite-ignore */ sdkPath);
          (window as any).sdk = sdk;
          (window as any).client = sdk.createRosetta({ engineUrl: "/engine/" });
        });
        const pdb = await readFile(resolve(root, "example/input.pdb"), "utf8");
        for (const protocol of ["score", "minimize", "relax"] as Protocol[]) {
          captured.length = 0;
          const result = await Promise.race([
            page.evaluate(
              async ({ protocol, pdb }) => {
                return (window as any).client.run(protocol, pdb, {
                  seed: 17,
                  dutyCycle: 75,
                  onSnapshot: (frame: any) =>
                    (window as any).captureSdk({ type: "snapshot", frame }),
                  onPhase: (phase: any) =>
                    (window as any).captureSdk({ type: "phase", phase }),
                });
              },
              { protocol, pdb },
            ),
            new Promise<never>((_, reject) => {
              const timer = setTimeout(
                () =>
                  reject(
                    new Error(`${target} ${protocol} exceeded ten minutes.`),
                  ),
                600_000,
              );
              timer.unref();
            }),
          ]);
          const nativeEnergy = await scorer(result.pdb);
          if (!withinTolerance(result.energy, nativeEnergy))
            throw new Error(`${target} ${protocol} native rescore disagrees.`);
          if (
            result.provenance.inputSha256 !== hash(pdb) ||
            result.provenance.outputSha256 !== hash(result.pdb) ||
            JSON.stringify(result.provenance.hashes) !==
              JSON.stringify(ENGINE_HASHES)
          )
            throw new Error("SDK provenance differs from actual bytes.");
          const frames = captured
            .filter((e) => e.type === "snapshot")
            .map((e) => e.frame);
          if (
            !frames.some((f) => f.source === "initial") ||
            !frames.some((f) => f.source === "final") ||
            (protocol !== "score" &&
              !frames.some((f) => f.source === "minimizing"))
          )
            throw new Error(
              "Scientific snapshot bridge did not emit required states.",
            );
          if (protocol !== "score" && result.timing.initializationMs !== 0)
            throw new Error("Warm client did not retain its engine.");
          const path = `reports/sdk-standalone/${target}-${protocol}.json`;
          await mkdir(resolve("reports/sdk-standalone"), { recursive: true });
          await writeFile(
            path,
            JSON.stringify(
              { inputPdb: pdb, result, snapshots: frames, nativeEnergy },
              null,
              2,
            ) + "\n",
          );
          evidence.measurements.push({
            protocol,
            energy: result.energy,
            nativeEnergy,
            absoluteDifference: Math.abs(result.energy - nativeEnergy),
            snapshots: frames.length,
            minimizingSnapshots: frames.filter((f) => f.source === "minimizing")
              .length,
            packingSnapshots: frames.filter((f) => f.source === "packing")
              .length,
            heapBytes: result.heapBytes,
            timing: result.timing,
            record: path,
            recordSha256: hash(await readFile(path)),
            passed: true,
          });
          console.log(
            `${target}: standalone ${protocol} passed, ${frames.length} real frames.`,
          );
        }
        if (largeInput) {
          const result = await page.evaluate(
            async (pdb) =>
              (window as any).client.score(pdb, {
                seed: 17,
                dutyCycle: 75,
              }),
            largeInput,
          );
          const nativeEnergy = await scorer(result.pdb);
          if (
            !withinTolerance(result.energy, nativeEnergy) ||
            validatePdb(result.pdb).residues !==
              validatePdb(largeInput).residues ||
            result.provenance.inputSha256 !== hash(largeInput)
          )
            throw new Error(
              `${target}: standalone large-input validation failed.`,
            );
          const directory = resolve(".local/sdk-large-input-proof");
          await mkdir(directory, { recursive: true });
          await writeFile(
            resolve(directory, `${target}.json`),
            JSON.stringify(
              {
                passed: true,
                target,
                hashes: ENGINE_HASHES,
                inputBytes: Buffer.byteLength(largeInput),
                residues: validatePdb(largeInput).residues,
                inputSha256: hash(largeInput),
                result,
                nativeEnergy,
              },
              null,
              2,
            ) + "\n",
            { mode: 0o600 },
          );
          console.log(
            `${target}: standalone large input passed; private record saved locally.`,
          );
        }
        evidence.manifestMismatchRejected = await page.evaluate(async (pdb) => {
          const c = (window as any).sdk.createRosetta({
            engineUrl: "/tampered/",
          });
          try {
            await c.score(pdb);
            return false;
          } catch (e: any) {
            return /manifest/.test(e.message);
          } finally {
            c.close();
          }
        }, pdb);
        evidence.assetMismatchRejected = await page.evaluate(async (pdb) => {
          const c = (window as any).sdk.createRosetta({
            engineUrl: "/bad-hash/",
          });
          try {
            await c.score(pdb);
            return false;
          } catch (e: any) {
            return /SHA-256 mismatch/.test(e.message);
          } finally {
            c.close();
          }
        }, pdb);
        await page.evaluate(() => (window as any).client.close());
        evidence.noExternalRequests = evidence.unexpectedRequests.length === 0;
        evidence.passed =
          evidence.noExternalRequests &&
          evidence.manifestMismatchRejected &&
          evidence.assetMismatchRejected;
        return evidence;
      } finally {
        // A disconnected context must not prevent cleanup of its owned test browser.
        try {
          await context.close();
        } finally {
          await browser.close();
        }
      }
    }),
  );
  report.passed =
    report.browsers.length === targets.length &&
    report.browsers.every((b: any) => b.passed);
  if (!report.passed) throw new Error("Standalone SDK gates failed.");
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  staticAsset.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    staticAsset.close((error) => (error ? reject(error) : resolve())),
  );
  await writeFile(
    "reports/wasm-sdk-browser-proof.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report, null, 2));
}
