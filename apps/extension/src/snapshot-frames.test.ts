import { expect, it } from "vitest";
import type { StructureSnapshot } from "@rosettatab/shared";
import {
  appendFrame,
  retainFrames,
  frameBytes,
  makeFrameDelta,
  applyFrameDelta,
  FRAME_LIMIT,
  FRAME_BYTES_LIMIT,
  HISTORY_LIMIT,
} from "./snapshot-frames";

function frame(
  sequence: number,
  pdb = `real frame ${sequence}`,
): StructureSnapshot {
  return {
    id: `attempt:${sequence}`,
    sequence,
    pdb,
    energy: sequence,
    elapsedMs: sequence * 200,
    historyIndex: sequence - 1,
    source: sequence === 1 ? "initial" : "minimizing",
  };
}

it("keeps exact coordinates and energy correspondence while history and frame budgets roll forward", () => {
  const state: { history?: number[]; frames?: StructureSnapshot[] } = {};
  for (let sequence = 1; sequence <= 2700; sequence++)
    appendFrame(state, "attempt", frame(sequence));
  expect(state.history).toHaveLength(HISTORY_LIMIT);
  expect(state.frames!.length).toBeLessThanOrEqual(FRAME_LIMIT);
  expect(
    state.frames!.reduce((sum, value) => sum + frameBytes(value), 0),
  ).toBeLessThanOrEqual(FRAME_BYTES_LIMIT);
  expect(state.frames!.at(-1)).toMatchObject({
    sequence: 2700,
    id: "attempt:2700",
    pdb: "real frame 2700",
    historyIndex: HISTORY_LIMIT - 1,
  });
  for (const retained of state.frames!) {
    expect(retained.energy).toBe(state.history![retained.historyIndex]);
    expect(retained.pdb).toBe(`real frame ${retained.sequence}`);
    expect(retained.historyIndex).toBeGreaterThanOrEqual(0);
  }
});

it("preserves endpoints and spreads retained coordinates across the trajectory under count and memory limits", () => {
  const all = Array.from({ length: 1000 }, (_, index) =>
    frame(index + 1, "x".repeat(1000)),
  );
  const retained = retainFrames(all, 10, 10 * frameBytes(all[0]));
  expect(retained).toHaveLength(10);
  expect(retained[0]).toBe(all[0]);
  expect(retained.at(-1)).toBe(all.at(-1));
  const gaps = retained
    .slice(1)
    .map((value, index) => value.sequence - retained[index].sequence);
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1);
  const bounded = retainFrames(all, 240, 3 * frameBytes(all[0]));
  expect(bounded).toHaveLength(3);
  expect(bounded[0]).toBe(all[0]);
  expect(bounded.at(-1)).toBe(all.at(-1));
});

it("reuses the real final callback instead of fabricating another energy sample", () => {
  const state: { history?: number[]; frames?: StructureSnapshot[] } = {};
  appendFrame(state, "attempt", { ...frame(1), source: "initial" });
  appendFrame(state, "attempt", { ...frame(2), source: "final" });
  appendFrame(state, "attempt", { ...frame(2), source: "final" }, false);
  expect(state.history).toEqual([1, 2]);
  expect(state.frames).toHaveLength(2);
  expect(state.frames!.at(-1)?.id).toBe("attempt:2");
  expect(state.frames!.at(-1)?.source).toBe("final");
});

it("sends coordinate strings only for new or changed frames while preserving index shifts and removals", () => {
  const before = [frame(1), frame(2), frame(3)];
  expect(makeFrameDelta(before, before, false)).toBeUndefined();
  const full = makeFrameDelta([], before, true)!;
  let follower = applyFrameDelta([], full);
  expect(follower).toEqual(before);
  const after = [
    { ...before[1], historyIndex: 0 },
    { ...before[2], historyIndex: 1 },
    { ...frame(4), historyIndex: 2 },
  ];
  const delta = makeFrameDelta(before, after, false)!;
  expect(delta.additions).toEqual([after[2]]);
  follower = applyFrameDelta(follower, delta);
  expect(follower).toEqual(after);
  expect(applyFrameDelta(follower, makeFrameDelta(after, [], true))).toEqual(
    [],
  );
});
