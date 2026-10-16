import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  parseBenchmark,
  exportBenchmark,
  sha256,
  BENCHMARK_SCHEMA,
} from "./benchmark";
import {
  ENGINE_ID,
  SOURCE_SHA,
  type Checkpoint,
  type EngineManifest,
  type Task,
  type Completion,
} from "@rosettatab/shared";
const history = vi.hoisted(() => ({
  results: [] as Checkpoint[],
  get: vi.fn(),
}));
vi.mock("./storage", () => ({
  getState: (key: string) => {
    history.get(key);
    return Promise.resolve(history.results);
  },
}));
const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
const input = () => ({
  schema: BENCHMARK_SCHEMA,
  title: "Reference",
  protocol: "relax",
  seed: 17,
  pdb,
  provenance: { kind: "reference" },
});
afterEach(() => {
  vi.unstubAllGlobals();
  history.results = [];
  history.get.mockClear();
});
it("imports byte-exact PDB coordinates for a bounded offline scoring replay", async () => {
  const result = await parseBenchmark(pdb, "1l2y.pdb");
  expect(result.task).toMatchObject({
    pdb,
    protocol: "score",
    seed: 17,
    inputHash: await sha256(pdb),
  });
  expect(result.metadata.provenance.kind).toBe("reference");
});
it("retains declared BOINC provenance without claiming official workunit compatibility", async () => {
  const document = {
    ...input(),
    provenance: {
      kind: "boinc-capture",
      applicationVersion: "6.04",
      workunit: "test",
    },
  };
  const result = await parseBenchmark(
    JSON.stringify(document),
    "benchmark.json",
  );
  expect(result.metadata.provenance.applicationVersion).toBe("6.04");
  expect(result.task.protocol).toBe("relax");
});
it("checks the original benchmark hash before preparation and records both exact inputs", async () => {
  let replaced = false;
  const original = pdb
    .split("\n")
    .map((line) => {
      if (replaced || !line.startsWith("ATOM  ")) return line;
      replaced = true;
      return line.slice(0, 16) + "A" + line.slice(17);
    })
    .join("\n");
  const result = await parseBenchmark(
    JSON.stringify({
      ...input(),
      pdb: original,
      inputSha256: await sha256(original),
    }),
    "alternates.json",
  );
  expect(result.task.pdb).toBe(pdb);
  expect(result.metadata.pdb).toBe(original);
  expect(result.metadata.preparation).toMatchObject({
    originalSha256: await sha256(original),
    preparedSha256: await sha256(pdb),
  });
  await expect(
    parseBenchmark(
      JSON.stringify({
        ...input(),
        pdb: original,
        inputSha256: await sha256(pdb),
      }),
      "bad.json",
    ),
  ).rejects.toThrow(/hash/);
});
it("rejects altered hashes, unknown protocols, remote instructions and unsupported structures", async () => {
  await expect(
    parseBenchmark(
      JSON.stringify({ ...input(), inputSha256: "0".repeat(64) }),
      "a.json",
    ),
  ).rejects.toThrow("hash");
  await expect(
    parseBenchmark(
      JSON.stringify({ ...input(), protocol: "jd2_scripting" }),
      "a.json",
    ),
  ).rejects.toThrow();
  await expect(
    parseBenchmark(
      JSON.stringify({
        ...input(),
        arguments: ["-parser:protocol", "remote.xml"],
      }),
      "a.json",
    ),
  ).rejects.toThrow();
  await expect(
    parseBenchmark(pdb + "\nHETATM ligand", "a.pdb"),
  ).rejects.toThrow("Malformed");
});

const manifest: EngineManifest = {
  id: ENGINE_ID,
  sourceSha: SOURCE_SHA,
  verified: true,
  module: "rosetta.mjs",
  database: "rosetta.data",
  reason: "",
  hashes: {
    "rosetta.mjs": "a".repeat(64),
    "rosetta.wasm": "b".repeat(64),
    "rosetta.data": "c".repeat(64),
  },
};
function completedRun(): Checkpoint {
  const task: Task = {
    id: "run-anchor",
    jobId: "batch-id",
    title: "Export transport fixture",
    protocol: "score" as const,
    pdb,
    inputHash: "fixture",
    seed: 17,
    modelIndex: 0,
    engineId: ENGINE_ID,
    sourceSha: SOURCE_SHA,
    state: "leased" as const,
    attemptToken: "fixture-token",
    clientId: null,
    leaseUntil: null,
    result: null,
    rejection: null,
  };
  const result: Completion = {
    attemptToken: "fixture-token",
    pdb,
    energy: 32.33,
    elapsedMs: 1234,
    engineId: ENGINE_ID,
    sourceSha: SOURCE_SHA,
  };
  return {
    task,
    taskSource: "benchmark",
    result,
    startedAt: 1000,
    status: "uploading",
    engineManifest: structuredClone(manifest),
    benchmark: {
      id: "import-id",
      kind: "coordinate-replay",
      metadata: {
        provenance: {
          kind: "boinc-capture",
          application: "Rosetta Beta",
          applicationVersion: "6.06",
          workunit: "declared-input",
        },
      },
    },
    batch: {
      parallelism: 2,
      dutyCycle: 25,
      models: [
        {
          task,
          result,
          startedAt: 1000,
          status: "complete",
          history: [32.33],
          frames: [
            {
              id: "run-anchor:1",
              sequence: 1,
              historyIndex: 0,
              pdb,
              energy: 32.33,
              elapsedMs: 1234,
              source: "final",
            },
          ],
          execution: { parallelism: 4, dutyCycle: 25 },
        },
        {
          task: { ...task, id: "second-attempt", modelIndex: 1, seed: 18 },
          result: { ...result, elapsedMs: 2000 },
          startedAt: 5000,
          status: "complete",
          history: [32.33],
          execution: { parallelism: 2, dutyCycle: 25 },
        },
      ],
    },
  };
}
it("does not label a different protocol as comparable to the imported scoring reference", async () => {
  vi.stubGlobal("navigator", { hardwareConcurrency: 8, userAgent: "fixture" });
  const completed = completedRun();
  completed.benchmark!.metadata.protocol = "relax";
  history.results = [completed];
  const record = await exportBenchmark("run-anchor");
  expect(record.benchmark!.metadata.protocol).toBe("relax");
  expect(record.models[0].protocol).toBe("score");
  expect(record.comparison.originalReferenceComparable).toBe(false);
});

it("exports byte-exact structures, declared provenance and each model's actual execution settings without contacting a service", async () => {
  vi.stubGlobal("navigator", {
    hardwareConcurrency: 8,
    userAgent: "Export fixture browser",
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  history.results = [completedRun()];
  const record = await exportBenchmark("run-anchor");
  expect(record).toMatchObject({
    schema: "rosettatab-browser-record-v1",
    runId: "batch-id",
    taskSource: "benchmark",
    officialSubmission: "disabled",
    officialWorkunitEquivalence: "not-established",
    benchmark: {
      id: "import-id",
      metadata: {
        provenance: { applicationVersion: "6.06", workunit: "declared-input" },
      },
    },
    environment: {
      parallelism: 2,
      dutyCycle: 25,
      reportedLogicalProcessors: 8,
    },
    comparison: { status: "awaiting-native-verification" },
  });
  expect(record.input).toEqual({ pdb, sha256: await sha256(pdb) });
  expect(record.engine).toEqual(manifest);
  expect(record.models.map((model) => model.execution)).toEqual([
    { parallelism: 4, dutyCycle: 25 },
    { parallelism: 2, dutyCycle: 25 },
  ]);
  expect(record.models.map((model) => [model.modelIndex, model.seed])).toEqual([
    [0, 17],
    [1, 18],
  ]);
  for (const model of record.models)
    expect(model.sha256).toBe(await sha256(model.pdb));
  expect(record.models[0].frames).toHaveLength(1);
  expect(record.models[0].frames[0]).toMatchObject({
    id: "run-anchor:1",
    pdb,
    energy: 32.33,
    historyIndex: 0,
    sha256: await sha256(pdb),
  });
  expect(record.timingScope).toContain(
    "including pauses, handovers and replay",
  );
  expect(record.timingScope).toContain(
    "not CPU-time or equal-resource throughput",
  );
  expect(history.get).toHaveBeenCalledExactlyOnceWith("browser-results");
  expect(fetch).not.toHaveBeenCalled();
});
it("does not invent execution settings for legacy single-model saved results", async () => {
  vi.stubGlobal("navigator", {
    hardwareConcurrency: 8,
    userAgent: "Export fixture browser",
  });
  const saved = completedRun();
  delete saved.batch;
  delete saved.engineManifest;
  history.results = [saved];
  const record = await exportBenchmark("run-anchor");
  expect(record.models).toHaveLength(1);
  expect(record.models[0].frames).toEqual([]);
  expect(record.models[0].execution).toBeUndefined();
  expect(record.environment).toMatchObject({ parallelism: 1, dutyCycle: null });
  expect(record.engine.verified).toBe(false);
  expect(
    "hashes" in record.engine ? record.engine.hashes : undefined,
  ).toBeUndefined();
  expect(record.comparison.status).toBe("awaiting-native-verification");
});
it("retains the executing engine hashes when the installed engine later changes", async () => {
  vi.stubGlobal("navigator", {
    hardwareConcurrency: 8,
    userAgent: "Export fixture browser",
  });
  history.results = [completedRun()];
  const installed = {
    ...manifest,
    hashes: { ...manifest.hashes, "rosetta.wasm": "d".repeat(64) },
  };
  const record = await exportBenchmark("run-anchor");
  expect((record.engine as EngineManifest).hashes?.["rosetta.wasm"]).toBe(
    "b".repeat(64),
  );
  expect((record.engine as EngineManifest).hashes?.["rosetta.wasm"]).not.toBe(
    installed.hashes["rosetta.wasm"],
  );
});
it("accepts a native reference carrying the pinned 40-character Git source commit", async () => {
  const document = {
    ...input(),
    reference: {
      pdb,
      energy: 32.334836,
      sourceSha: SOURCE_SHA,
      protocol: "score",
      seed: 17,
      engineId: ENGINE_ID,
    },
  };
  const imported = await parseBenchmark(
    JSON.stringify(document),
    "with-reference.json",
  );
  expect(imported.metadata.reference?.sourceSha).toBe(SOURCE_SHA);
  expect(imported.metadata.reference?.energy).toBe(32.334836);
});
it("refuses to export a missing or unfinished local run", async () => {
  await expect(exportBenchmark("absent")).rejects.toThrow(
    "no longer in local history",
  );
  const saved = completedRun();
  delete saved.result;
  history.results = [saved];
  await expect(exportBenchmark("run-anchor")).rejects.toThrow(
    "no longer in local history",
  );
});
