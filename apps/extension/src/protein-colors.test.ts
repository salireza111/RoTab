import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  paletteColor,
  ProteinPalette,
  readProteinColors,
  residueColor,
  UnscoredColor,
} from "./protein-colors";

const reference = readFileSync(
  "apps/extension/public/fixtures/1l2y.pdb",
  "utf8",
);
const recording = JSON.parse(
  readFileSync("tests/fixtures/live-packing.json", "utf8"),
) as {
  frames: { pdb: string; energy: number }[];
};

describe("Rosetta protein color meanings", () => {
  it("keeps the five palette stops exact, including the two sequence termini", () => {
    for (let i = 0; i < ProteinPalette.length; i++)
      expect(paletteColor(i / 4)).toBe(ProteinPalette[i].value);
    const { residues, scoredCount } = readProteinColors(reference);
    expect(residues).toHaveLength(20);
    expect(residues[0]).toMatchObject({
      name: "ASN",
      key: "A:1:",
      position: 1,
      chainLength: 20,
    });
    expect(residueColor(residues[0], "sequence")).toBe(ProteinPalette[0].value);
    expect(residueColor(residues.at(-1), "sequence")).toBe(
      ProteinPalette[4].value,
    );
    expect(scoredCount).toBe(0);
    expect(residueColor(residues[0], "energy")).toBe(UnscoredColor);
  });

  it("uses chain order across numbering gaps and insertion codes, restarting at each chain", () => {
    const atom = reference
      .split("\n")
      .find((line) => line.slice(12, 16).trim() === "CA")!;
    const record = (chain: string, number: number, insertion = " ") =>
      atom.slice(0, 21) +
      chain +
      String(number).padStart(4) +
      insertion +
      atom.slice(27);
    const pdb = [
      record("A", 8),
      record("A", 8, "A"),
      record("A", 42),
      record("B", 5),
      record("B", 9),
      "ENDMDL",
      record("C", 1),
    ].join("\n");
    const { residues } = readProteinColors(pdb);
    expect(residues.map((r) => r.key)).toEqual([
      "A:8:",
      "A:8:A",
      "A:42:",
      "B:5:",
      "B:9:",
    ]);
    expect(residues.map((r) => residueColor(r, "sequence"))).toEqual([
      ProteinPalette[0].value,
      ProteinPalette[2].value,
      ProteinPalette[4].value,
      ProteinPalette[0].value,
      ProteinPalette[4].value,
    ]);
  });

  it("reads actual weighted residue totals using pose ordinals, with no double weighting", () => {
    const initial = readProteinColors(recording.frames[0].pdb);
    const peak = readProteinColors(recording.frames[1].pdb);
    const final = readProteinColors(recording.frames[2].pdb);
    expect(initial.scoredCount).toBe(20);
    expect(peak.scoredCount).toBe(20);
    expect(final.scoredCount).toBe(20);
    expect(peak.residues[5]).toMatchObject({ name: "TRP", energy: 800.945 });
    expect(final.residues[5].energy).toBe(-5.50631);
    expect(peak.tableTotal).toBeCloseTo(1695.96, 2);
    expect(initial.residues.reduce((sum, r) => sum + r.energy!, 0)).toBeCloseTo(
      39.77522,
      5,
    );
    // Rosetta's default backbone H bonds are not decomposed into residues.
    // Never renormalize the residue scores to force a sum equal to this total.
    expect(initial.tableTotal).toBe(32.3354);
    expect(peak.signature).not.toBe(final.signature);
    expect(residueColor(peak.residues[5], "energy")).toBe(
      ProteinPalette[4].value,
    );
    expect(residueColor(final.residues[5], "energy")).not.toBe(
      residueColor(peak.residues[5], "energy"),
    );
    // Sequence identity cannot change when only energies or coordinates change.
    expect(residueColor(peak.residues[5], "sequence")).toBe(
      residueColor(final.residues[5], "sequence"),
    );
    const renumbered = recording.frames[1].pdb
      .split("\n")
      .map((line) =>
        line.startsWith("ATOM  ")
          ? line.slice(0, 22) +
            String(Number(line.slice(22, 26)) + 100).padStart(4) +
            line.slice(26)
          : line,
      )
      .join("\n");
    expect(readProteinColors(renumbered).residues[5]).toMatchObject({
      number: 106,
      energy: 800.945,
    });
  });

  it("uses an invariant energy scale and shows missing or invalid scores as unavailable", () => {
    const residue = readProteinColors(reference).residues[0];
    for (const [value, stop] of [
      [-100, 0],
      [-10, 0],
      [-5, 1],
      [0, 2],
      [5, 3],
      [10, 4],
      [800, 4],
    ])
      expect(residueColor({ ...residue, energy: value }, "energy")).toBe(
        ProteinPalette[stop].value,
      );
    expect(residueColor({ ...residue, energy: NaN }, "energy")).toBe(
      UnscoredColor,
    );
    const invalid = recording.frames[0].pdb.replace("LEU_2 ", "TYR_2 ");
    expect(readProteinColors(invalid).scoredCount).toBe(0);
    expect(
      readProteinColors(
        recording.frames[0].pdb.replace("#END_POSE_ENERGIES_TABLE", ""),
      ).scoredCount,
    ).toBe(0);
    const duplicate = recording.frames[0].pdb.replace(
      "#END_POSE_ENERGIES_TABLE",
      recording.frames[0].pdb.match(/^LEU_2 .+$/m)![0] +
        "\n#END_POSE_ENERGIES_TABLE",
    );
    expect(readProteinColors(duplicate).scoredCount).toBe(0);
    const nonFinite = recording.frames[0].pdb.replace(
      /^(LEU_2 .+ )\S+$/m,
      "$1NaN",
    );
    expect(readProteinColors(nonFinite).scoredCount).toBe(0);
  });

  it("matches pinned Rosetta chemical variant names to their standard PDB identities", () => {
    // Real fa_standard types use NAME HIS_D / IO_STRING HIS and NAME CYZ /
    // IO_STRING CYS. Keep pose ordinals and all table-validation checks.
    for (const [type, name] of [
      ["HIS_D", "HIS"],
      ["CYZ", "CYS"],
    ]) {
      const pdb = recording.frames[0].pdb
        .split("\n")
        .map((line) =>
          line.startsWith("ATOM  ") && Number(line.slice(22, 26)) === 1
            ? line.slice(0, 17) + name + line.slice(20)
            : line.replace(
                /^ASN:NtermProteinFull_1 /,
                `${type}:NtermProteinFull_1 `,
              ),
        )
        .join("\n");
      const expected = readProteinColors(recording.frames[0].pdb);
      const data = readProteinColors(pdb);
      expect(data.scoredCount).toBe(20);
      expect(data.tableTotal).toBe(expected.tableTotal);
      expect(data.residues[0]).toMatchObject({
        name,
        energy: expected.residues[0].energy,
      });
      expect(data.residues.map((r) => r.energy)).toEqual(
        expected.residues.map((r) => r.energy),
      );
      // A different or unknown residue cannot invalidate identity checking.
      expect(
        readProteinColors(
          pdb.replace(
            `${type}:NtermProteinFull_1`,
            "HIS_UNKNOWN:NtermProteinFull_1",
          ),
        ).scoredCount,
      ).toBe(0);
      expect(
        readProteinColors(
          pdb.replace(`${type}:NtermProteinFull_1`, "TYR:NtermProteinFull_1"),
        ).scoredCount,
      ).toBe(0);
    }
  });
});
