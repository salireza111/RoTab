import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as sdk from "./index.js";
import { validateManifest, validateRequest } from "./validation.js";
import {
  PROTOCOL_IDS as sharedIds,
  ENGINE_ID as sharedEngine,
  SOURCE_SHA as sharedSha,
} from "../../shared/src/index";

const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
afterEach(() => vi.unstubAllGlobals());

it("keeps standalone admission identical to the measured engine catalogue", () => {
  expect(sdk.PROTOCOL_IDS).toEqual(sharedIds);
  expect(sdk.ENGINE_ID).toBe(sharedEngine);
  expect(sdk.SOURCE_SHA).toBe(sharedSha);
  expect(sdk.validatePdb(pdb).residues).toBe(20);
  expect(() => sdk.validatePdb(pdb + "\nHETATM ligand")).toThrow();
  expect(() => validateRequest("bogus" as any, 17, 25)).toThrow(/Unsupported/);
  expect(() => validateRequest("score", 0, 25)).toThrow(/Seed/);
  expect(() => validateRequest("score", 17, 100)).toThrow(/dutyCycle/);
});
it("offers explicit protein-only preparation while strict admission still rejects heteroatoms", () => {
  const water =
    "HETATM 9001  O   HOH A 101       1.000   2.000   3.000  1.00 20.00           O";
  const original = pdb + "\n" + water;
  expect(() => sdk.validatePdb(original)).toThrow(/Ligands/);
  const prepared = sdk.preparePdb(original);
  expect(sdk.validatePdb(prepared.pdb).residues).toBe(20);
  expect(prepared.report).toMatchObject({
    policy: "pdb-protein-only-preparation-v2",
    waterAtomsRemoved: 1,
  });
});
it("rejects a forged engine identity or changed asset hash", () => {
  const manifest = {
    verified: true,
    id: sdk.ENGINE_ID,
    sourceSha: sdk.SOURCE_SHA,
    module: "rosetta.mjs",
    database: "rosetta.data",
    hashes: sdk.ENGINE_HASHES,
    supportedProtocols: sdk.PROTOCOL_IDS,
  };
  expect(() => validateManifest(manifest)).not.toThrow();
  expect(() =>
    validateManifest({
      ...manifest,
      hashes: { ...manifest.hashes, "rosetta.wasm": "0".repeat(64) },
    }),
  ).toThrow(/measured/);
  expect(() => validateManifest({ ...manifest, verified: false })).toThrow(
    /measured/,
  );
});
it("gives all eight independent method imports the correct dispatch without claiming scientific execution", async () => {
  const run = vi.fn().mockResolvedValue({});
  const names = [
    "score",
    "relax",
    "minimize",
    "repack",
    "fixedBackboneDesign",
    "fastDesign",
    "cartesianMinimize",
    "cartesianRelax",
  ] as const;
  for (const [i, name] of names.entries()) {
    await sdk[name]({ run }, pdb, { seed: 18 });
    expect(run).toHaveBeenLastCalledWith(sdk.PROTOCOL_IDS[i], pdb, {
      seed: 18,
    });
  }
});

class WorkerFixture {
  static latest: WorkerFixture;
  onmessage?: (event: { data: any }) => void;
  onerror?: (event: { message: string }) => void;
  onmessageerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() {
    WorkerFixture.latest = this;
  }
}
it("prevents concurrent calls, ignores stale replies, reuses one worker and aborts by termination", async () => {
  vi.stubGlobal("Worker", WorkerFixture);
  const client = sdk.createRosetta({
    engineUrl: "https://example.test/engine",
  });
  const controller = new AbortController();
  const first = client.score(pdb, { signal: controller.signal });
  const worker = WorkerFixture.latest;
  const id = worker.postMessage.mock.calls[0][0].id;
  await expect(client.minimize(pdb)).rejects.toThrow(/busy/);
  worker.onmessage!({
    data: { id: id + 1, type: "result", result: { energy: 99 } },
  });
  worker.onmessage!({ data: { id, type: "result", result: { energy: 12 } } });
  expect((await first).energy).toBe(12);
  const second = client.minimize(pdb, { signal: controller.signal });
  const rejected = expect(second).rejects.toMatchObject({ name: "AbortError" });
  expect(WorkerFixture.latest).toBe(worker);
  controller.abort();
  await rejected;
  expect(worker.terminate).toHaveBeenCalledOnce();
  const third = client.score(pdb);
  expect(WorkerFixture.latest).not.toBe(worker);
  const closed = expect(third).rejects.toMatchObject({ name: "AbortError" });
  client.close();
  await closed;
  await expect(client.score(pdb)).rejects.toThrow(/closed/);
});
it("rejects already-aborted requests and observer exceptions do not lose a result", async () => {
  vi.stubGlobal("Worker", WorkerFixture);
  const client = sdk.createRosetta({
    engineUrl: "https://example.test/engine/",
  });
  await expect(
    client.score(pdb, { signal: AbortSignal.abort() }),
  ).rejects.toMatchObject({ name: "AbortError" });
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const run = client.score(pdb, {
    onPhase: () => {
      throw new Error("consumer");
    },
  });
  const worker = WorkerFixture.latest,
    id = worker.postMessage.mock.calls[0][0].id;
  worker.onmessage!({ data: { id, type: "phase", phase: "calculating" } });
  worker.onmessage!({ data: { id, type: "result", result: { energy: 3 } } });
  expect((await run).energy).toBe(3);
  expect(logged).toHaveBeenCalledOnce();
  logged.mockRestore();
  client.close();
});
