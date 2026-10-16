import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { protocolSchema, validateResultIdentity } from "./index";
const pdb = readFileSync(
  new URL("../../../apps/extension/public/fixtures/1l2y.pdb", import.meta.url),
  "utf8",
);
describe("scientific protocol routing", () => {
  it("rejects unknown protocols instead of falling back to scoring", () => {
    expect(protocolSchema.safeParse("ligand_dock").success).toBe(false);
    expect(protocolSchema.safeParse("run_script").success).toBe(false);
    expect(protocolSchema.safeParse("fastdesign").success).toBe(true);
  });
  it("allows sequence changes only for design while preserving residue identities", () => {
    const changed = pdb.replaceAll(" ASN ", " ALA ");
    expect(() => validateResultIdentity(pdb, changed, "repack")).toThrow(
      /sequence/,
    );
    expect(() =>
      validateResultIdentity(pdb, changed, "fixed_backbone_design"),
    ).not.toThrow();
    expect(() =>
      validateResultIdentity(pdb, changed, "fastdesign"),
    ).not.toThrow();
    expect(() =>
      validateResultIdentity(
        pdb,
        changed
          .split("\n")
          .filter((l) => l.slice(22, 26).trim() !== "1")
          .join("\n"),
        "fastdesign",
      ),
    ).toThrow(/identities/);
  });
});
