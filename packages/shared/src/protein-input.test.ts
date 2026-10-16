import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  prepareProteinPdb,
  proteinOnlyCaution,
  validatePdb,
  jobInputSchema,
} from "./index";

const pdb = readFileSync("apps/extension/public/fixtures/1l2y.pdb", "utf8");
const atomLines = pdb.split("\n").filter((l) => l.startsWith("ATOM  "));
const alt = (line: string, label: string, occupancy: number, x?: number) =>
  line.slice(0, 16) +
  label +
  line.slice(17, 30) +
  (x === undefined ? line.slice(30, 38) : x.toFixed(3).padStart(8)) +
  line.slice(38, 54) +
  occupancy.toFixed(2).padStart(6) +
  line.slice(60);

it("preserves a clean input byte for byte", () => {
  expect(prepareProteinPdb(pdb)).toMatchObject({ pdb, changed: false });
});
it("chooses a residue conformer consistently, including atoms with opposing individual occupancies", () => {
  const first = atomLines.filter(
    (l) => l.slice(21, 27) === atomLines[0].slice(21, 27),
  );
  const other = atomLines.filter((l) => !first.includes(l));
  const input = [
    ...first.flatMap((l, i) => [
      alt(l, "A", i === 0 ? 0.9 : 0.2),
      alt(l, "B", i === 0 ? 0.1 : 0.8, Number(l.slice(30, 38)) + 0.01),
    ]),
    ...other,
  ].join("\n");
  const prepared = prepareProteinPdb(input);
  expect(prepared.report.conformers).toHaveLength(1);
  expect(prepared.report.conformers[0].label).toBe("B");
  expect(validatePdb(prepared.pdb).residues).toBe(20);
  const result = prepared.pdb.split("\n").slice(0, first.length);
  expect(result.every((l) => l[16] === " ")).toBe(true);
  expect(Number(result[0].slice(30, 38))).toBeCloseTo(
    Number(first[0].slice(30, 38)) + 0.01,
    3,
  );
});
it("keeps shared blank atoms and selects A deterministically when occupancies tie", () => {
  const line = atomLines.find((l) => l.slice(12, 16).trim() === "CB")!;
  const input = atomLines
    .flatMap((l) => (l === line ? [alt(l, "B", 0.5), alt(l, "A", 0.5)] : [l]))
    .join("\n");
  expect(prepareProteinPdb(input).report.conformers[0].label).toBe("A");
  expect(validatePdb(prepareProteinPdb(input).pdb).atoms).toBe(
    atomLines.length,
  );
});
it("extracts the first complete model from an ensemble without merging chains or models", () => {
  const input = `HEADER    EXAMPLE\nMODEL        4\n${atomLines.join("\n")}\nENDMDL\nMODEL        8\n${atomLines.join("\n")}\nENDMDL\nEND\n`;
  const prepared = prepareProteinPdb(input);
  expect(prepared.report).toMatchObject({ totalModels: 2, selectedModel: "4" });
  expect(validatePdb(prepared.pdb).atoms).toBe(atomLines.length);
  expect(() => prepareProteinPdb(input.replace("ENDMDL", ""))).toThrow(
    /ENDMDL/,
  );
});
it("prepares the real 76-residue ubiquitin entry and removes only its crystallographic waters", () => {
  const original = readFileSync("engine/experiments/1ubq-original.pdb", "utf8");
  const prepared = prepareProteinPdb(original);
  expect(validatePdb(prepared.pdb).residues).toBe(76);
  expect(prepared.report.waterAtomsRemoved).toBe(58);
  expect(prepared.pdb.split("\n").some((l) => l.startsWith("HETATM"))).toBe(
    false,
  );
});
it("does not impose the former residue or 500 kB text cap", () => {
  const input = Array.from({ length: 21 }, (_, block) =>
    atomLines
      .map(
        (l) =>
          l.slice(0, 22) +
          String(Number(l.slice(22, 26)) + block * 20).padStart(4) +
          l.slice(26),
      )
      .join("\n"),
  ).join("\n");
  expect(input.length).toBeGreaterThan(500_000);
  expect(validatePdb(input).residues).toBe(420);
  expect(
    jobInputSchema.safeParse({
      title: "Large",
      pdb: input,
      protocol: "score",
      models: 1,
      seed: 17,
    }).success,
  ).toBe(true);
});
it("repairs exact duplicate records but refuses conflicting coordinates and unsupported chemistry", () => {
  expect(
    prepareProteinPdb(pdb + "\n" + atomLines[0]).report.duplicateAtomsRemoved,
  ).toBe(1);
  expect(() =>
    prepareProteinPdb(pdb + "\n" + alt(atomLines[0], " ", 1, 123)),
  ).toThrow(/Conflicting duplicate/);
  expect(() =>
    validatePdb(prepareProteinPdb(pdb + "\nHETATM ligand").pdb),
  ).toThrow(/Malformed/);
  expect(() =>
    validatePdb(
      prepareProteinPdb(
        pdb + "\n" + atomLines[0].slice(0, 21) + "B" + atomLines[0].slice(22),
      ).pdb,
    ),
  ).toThrow(/chain/);
});

const het = (
  serial: number,
  name: string,
  res: string,
  id: number,
  element: string,
) =>
  "HETATM" +
  String(serial).padStart(5) +
  " " +
  name.padStart(4) +
  " " +
  res.padStart(3) +
  " A" +
  String(id).padStart(4) +
  "    " +
  "   1.000   2.000   3.000  1.00 20.00          " +
  element.padStart(2);
const link = (first: string, second: string) =>
  "LINK        " +
  first.slice(12, 27) +
  "               " +
  second.slice(12, 27);
const conect = (source: number, ...targets: number[]) =>
  "CONECT" + [source, ...targets].map((n) => String(n).padStart(5)).join("");

it("prepares linked water, a coordinated ion and a ligand without changing protein atoms", () => {
  const water = het(9001, "O", "HOH", 101, "O");
  const ion = het(9002, "ZN", "ZN", 102, "ZN");
  const ligand = het(9003, "C1", "LIG", 103, "C");
  const proteinSerial = Number(atomLines[0].slice(6, 11));
  const otherSerial = Number(atomLines[1].slice(6, 11));
  const input = [
    ...atomLines,
    water,
    ion,
    ligand,
    link(atomLines[0], water),
    link(ion, atomLines[1]),
    link(ligand, water),
    conect(proteinSerial, otherSerial, 9001, 9002),
    conect(9002, proteinSerial),
    conect(9003, 9001),
    "MASTER old counts",
    "END",
  ].join("\n");
  const result = prepareProteinPdb(input);
  expect(validatePdb(result.pdb).residues).toBe(20);
  expect(
    result.pdb.split("\n").filter((line) => line.startsWith("ATOM  ")),
  ).toEqual(atomLines);
  expect(result.pdb).not.toMatch(/HETATM|LINK  |9001|9002|9003|MASTER/);
  expect(result.pdb).toContain(conect(proteinSerial, otherSerial));
  expect(result.report).toMatchObject({
    policy: "pdb-protein-only-preparation-v2",
    waterAtomsRemoved: 1,
    linkRecordsRemoved: 3,
    conectReferencesRemoved: 4,
    nonProteinRemoved: [
      { name: "HOH", kind: "water", residues: 1, atoms: 1 },
      { name: "ZN", kind: "ion", residues: 1, atoms: 1 },
      { name: "LIG", kind: "ligand", residues: 1, atoms: 1 },
    ],
  });
  expect(proteinOnlyCaution(result.report)).toMatch(
    /1 water atom, 1 ion, 1 ligand.*interactions.*Original file kept/,
  );
  expect(prepareProteinPdb(result.pdb)).toMatchObject({
    pdb: result.pdb,
    changed: false,
  });
});

it("retains protein connectivity and removes associated records only for excluded components", () => {
  const water = het(9001, "O", "DOD", 101, "O");
  const proteinLink = link(atomLines[0], atomLines[1]);
  const waterAnisou = "ANISOU" + water.slice(6);
  const waterTer = "TER   " + water.slice(6);
  const input = [
    ...atomLines,
    water,
    waterAnisou,
    waterTer,
    proteinLink,
    link(water, atomLines[0]),
    "HET    DOD  A 101",
    "HETNAM     DOD DEUTERATED WATER",
    "FORMUL   2  DOD    D2 O",
  ].join("\n");
  const result = prepareProteinPdb(input);
  expect(result.pdb).toBe([...atomLines, proteinLink].join("\n"));
  expect(result.report.linkRecordsRemoved).toBe(1);
});

it("retains canonical amino-acid HETATM records and refuses modified protein residues", () => {
  const canonical = atomLines
    .map((line) => "HETATM" + line.slice(6))
    .join("\n");
  const result = prepareProteinPdb(canonical);
  expect(result.pdb).toBe(atomLines.join("\n"));
  expect(result.report.canonicalAtomRecordsConverted).toBe(atomLines.length);
  expect(proteinOnlyCaution(result.report)).toBeUndefined();
  for (const name of ["MSE", "UNK", "SEP"]) {
    const modified = atomLines
      .filter((line) => line.slice(21, 27) === atomLines[0].slice(21, 27))
      .map((line) => "HETATM" + line.slice(6, 17) + name + line.slice(20))
      .join("\n");
    expect(() => prepareProteinPdb(modified)).toThrow(
      /protein residue.*not removed/,
    );
  }
});

it("recognizes an incomplete modified amino acid declared by MODRES instead of deleting it", () => {
  const modified = het(9001, "C1", "ABC", 101, "C");
  const modres = "MODRES TEST ABC A  101  ALA  MODIFIED ALANINE";
  expect(() =>
    prepareProteinPdb([...atomLines, modres, modified].join("\n")),
  ).toThrow(/protein residue ABC.*not removed/);
});

it("does not prune protein connectivity when a malformed file reuses an excluded atom identifier", () => {
  const water = het(Number(atomLines[0].slice(6, 11)), "O", "HOH", 101, "O");
  expect(() => prepareProteinPdb([...atomLines, water].join("\n"))).toThrow(
    /share an atom serial/,
  );
});
