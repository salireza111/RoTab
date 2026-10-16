import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { ENGINE_ID, SOURCE_SHA } from "@rosettatab/shared";
import { bundledTask } from "./browser-tasks";
afterEach(() => vi.unstubAllGlobals());

it("prepares independently seeded jobs from the bundled scientific input without an API", async () => {
  const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
  const fetch = vi
    .fn()
    .mockImplementation(() => Promise.resolve(new Response(pdb)));
  vi.stubGlobal("fetch", fetch);
  const first = await bundledTask("relax");
  const second = await bundledTask("score");
  expect(first).toMatchObject({
    protocol: "relax",
    pdb,
    engineId: ENGINE_ID,
    sourceSha: SOURCE_SHA,
    inputHash: createHash("sha256").update(pdb).digest("hex"),
    leaseUntil: null,
  });
  expect(second.id).not.toBe(first.id);
  expect(first.seed).toBeGreaterThanOrEqual(1);
  expect(first.seed).toBeLessThanOrEqual(2_000_000_000);
  expect(fetch.mock.calls).toEqual([
    ["./fixtures/1l2y.pdb"],
    ["./fixtures/1l2y.pdb"],
  ]);
});

it("reports a missing packaged structure before starting a calculation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("missing", { status: 404 })),
  );
  await expect(bundledTask("relax")).rejects.toThrow(
    "packaged 1L2Y structure is unavailable",
  );
});
