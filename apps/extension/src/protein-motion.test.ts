import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CoordinateTransition,
  interpolateCoordinates,
  readProteinFrame,
} from "./protein-motion";
import { energySeries } from "./EnergyChart";

describe("scientific snapshot presentation", () => {
  it("uses atom identity rather than serials and reads the first PDB model only", () => {
    const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
    const frame = readProteinFrame(pdb + "ENDMDL\n" + pdb);
    expect(frame.keys.length).toBe(304);
    expect(new Set(frame.keys).size).toBe(frame.keys.length);
    expect(frame.positions.length).toBe(frame.keys.length * 3);
    expect(
      readProteinFrame(pdb.replace(/ATOM {6}1 /, "ATOM    999 ")).keys,
    ).toEqual(readProteinFrame(pdb).keys);
    expect(frame.positions[0]).toBeCloseTo(-8.901, 3);
  });
  it("preserves endpoints without overshoot and rejects mismatched atom counts", () => {
    const a = new Float32Array([-2, 3, 5]),
      b = new Float32Array([2, -1, 5]);
    expect([...interpolateCoordinates(a, b, -1)]).toEqual([...a]);
    expect([...interpolateCoordinates(a, b, 2)]).toEqual([...b]);
    expect([...interpolateCoordinates(a, b, 0.5)]).toEqual([0, 1, 5]);
    expect(() => interpolateCoordinates(a, new Float32Array(6), 0.5)).toThrow(
      "topologies",
    );
  });
  it("retargets from the currently displayed frame and stops at the exact snapshot", () => {
    const transition = new CoordinateTransition();
    transition.set(new Float32Array([0, 0, 0]), 0, 0);
    transition.set(new Float32Array([10, 10, 10]), 0, 1000);
    const halfway = [...transition.sample(500)];
    transition.set(new Float32Array([20, 20, 20]), 500, 1000);
    expect([...transition.sample(500)]).toEqual(halfway);
    transition.finish();
    expect([...transition.sample(500)]).toEqual([20, 20, 20]);
  });
  it("keeps uphill observations while best-so-far only decreases", () => {
    expect(energySeries([32, 12, 18, -4, -2, -10])).toEqual({
      current: [32, 12, 18, -4, -2, -10],
      best: [32, 12, 12, -4, -4, -10],
    });
    expect(energySeries([])).toEqual({ current: [], best: [] });
  });
});
