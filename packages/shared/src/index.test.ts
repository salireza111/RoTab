import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  validatePdb,
  withinTolerance,
  jobInputSchema,
  claimSchema,
  SOURCE_SHA,
  ENGINE_ID,
} from "./index";
const pdb = readFileSync(
  new URL("../../../apps/extension/public/fixtures/1l2y.pdb", import.meta.url),
  "utf8",
);
describe("bounded scientific input", () => {
  it("admits the 20-residue reference model", () =>
    expect(validatePdb(pdb).residues).toBe(20));
  it("rejects ensembles, ligands, incomplete backbones, bad coordinates and duplicates", () => {
    expect(() =>
      validatePdb("MODEL        1\n" + pdb + "\nMODEL        2\n"),
    ).toThrow(/model/i);
    expect(() => validatePdb(pdb + "\nHETATM")).toThrow(/Ligands/);
    expect(() =>
      validatePdb(
        pdb
          .split("\n")
          .filter((l) => l.slice(12, 16).trim() !== "O")
          .join("\n"),
      ),
    ).toThrow(/backbone/);
    expect(() =>
      validatePdb(pdb.replace(/(ATOM.{26}).{8}/, "$1     NaN")),
    ).toThrow(/coordinates/);
    expect(() =>
      validatePdb(
        pdb + "\n" + pdb.split("\n").find((l) => l.startsWith("ATOM  ")),
      ),
    ).toThrow(/Duplicate/);
  });
  it("admits only the pinned engine and bounded independent seeds", () => {
    expect(
      claimSchema.safeParse({
        clientId: crypto.randomUUID(),
        sourceSha: SOURCE_SHA,
        engineId: ENGINE_ID,
      }).success,
    ).toBe(true);
    expect(
      claimSchema.safeParse({
        clientId: crypto.randomUUID(),
        sourceSha: "newest",
        engineId: ENGINE_ID,
      }).success,
    ).toBe(false);
    expect(
      jobInputSchema.safeParse({
        title: "test",
        pdb,
        protocol: "relax",
        models: 20,
        seed: 2_000_000_000,
      }).success,
    ).toBe(false);
  });
  it("uses the agreed absolute/relative REU tolerance", () => {
    expect(withinTolerance(-100.0009, -100)).toBe(true);
    expect(withinTolerance(-100.002, -100)).toBe(false);
    expect(withinTolerance(-100000.9, -100000)).toBe(true);
    expect(withinTolerance(-100001.1, -100000)).toBe(false);
    expect(withinTolerance(NaN, 0)).toBe(false);
  });
});
