import { describe, expect, it } from "vitest";
import { compareProteinFrames } from "./protein-comparison";
import { readProteinFrame } from "./protein-motion";

type Point = [number, number, number];
const points: Point[] = [
  [0, 0, 0],
  [4, 0, 0],
  [0, 3, 0],
  [1, 1, 3],
];
function pdb(points: Point[], chain = "A", ids = points.map((_, i) => i + 1)) {
  return points
    .map(
      (point, i) =>
        `ATOM  ${String(i + 1).padStart(5)}  CA  ALA ${chain}${String(ids[i]).padStart(4)}    ${point.map((v) => v.toFixed(3).padStart(8)).join("")}  1.00  0.00           C`,
    )
    .join("\n");
}

describe("protein snapshot comparison", () => {
  it("removes translation and rotation, and transforms all baseline coordinates for display", () => {
    const selected = pdb(points);
    const baseline = pdb(points.map(([x, y, z]) => [-y + 12, x - 7, z + 5]));
    const comparison = compareProteinFrames(selected, baseline);
    expect(comparison.status).toBe("aligned");
    if (comparison.status !== "aligned") return;
    expect(comparison.rmsd).toBeLessThan(1e-6);
    expect(comparison.matchedResidues).toBe(4);
    for (let i = 0; i < comparison.positions.length; i++)
      expect(comparison.positions[i]).toBeCloseTo(points.flat()[i], 5);
    const actual = readProteinFrame(comparison.alignedPdb).positions;
    const expected = readProteinFrame(selected).positions;
    for (let i = 0; i < expected.length; i++)
      expect(actual[i]).toBeCloseTo(expected[i], 3);
    expect(baseline).toContain("  12.000  -7.000   5.000");
  });
  it("matches residue identities rather than atom or residue order", () => {
    const comparison = compareProteinFrames(
      pdb(points),
      pdb([...points].reverse(), "A", [4, 3, 2, 1]),
    );
    expect(comparison.status).toBe("aligned");
    if (comparison.status === "aligned")
      expect(comparison.rmsd).toBeLessThan(1e-6);
  });
  it("reports structural changes after alignment and explicit partial coverage", () => {
    const distorted: Point[] = [
      [0, 0, 0],
      [4, 0, 0],
      [0, 3, 0],
      [1, 1, 5],
    ];
    const comparison = compareProteinFrames(
      pdb([...points, [5, 5, 5]]),
      pdb(distorted),
    );
    expect(comparison.status).toBe("aligned");
    if (comparison.status !== "aligned") return;
    expect(comparison.rmsd).toBeGreaterThan(0.5);
    expect(comparison.rmsd).toBeLessThan(1);
    expect(comparison.matchedResidues).toBe(4);
    expect(comparison.selectedResidues).toBe(5);
    expect(comparison.baselineResidues).toBe(4);
  });
  it("refuses incompatible, ambiguous or degenerate alignment rather than inventing RMSD", () => {
    expect(compareProteinFrames(pdb(points), pdb(points, "B"))).toMatchObject({
      status: "unavailable",
    });
    expect(
      compareProteinFrames(pdb(points.slice(0, 2)), pdb(points.slice(0, 2))),
    ).toMatchObject({ status: "unavailable" });
    const collinear = pdb([
      [0, 0, 0],
      [1, 0, 0],
      [2, 0, 0],
    ]);
    expect(compareProteinFrames(collinear, collinear)).toMatchObject({
      status: "unavailable",
    });
    expect(
      compareProteinFrames(pdb(points, "A", [1, 1, 2, 3]), pdb(points)),
    ).toMatchObject({ status: "unavailable" });
  });
  it("reads only the first model and ignores alternate B locations", () => {
    const original = pdb(points);
    const alternate =
      original.split("\n")[0].slice(0, 16) +
      "B" +
      original.split("\n")[0].slice(17);
    const comparison = compareProteinFrames(
      original + "\n" + alternate + "\nENDMDL\n" + pdb(points, "B"),
      original,
    );
    expect(comparison.status).toBe("aligned");
    if (comparison.status === "aligned")
      expect(comparison.matchedResidues).toBe(4);
  });
});
