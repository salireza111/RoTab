// Bundle the existing preparation/admission policy; no extension code is imported.
import {
  prepareProteinPdb,
  validatePdb as validate,
} from "../../shared/src/index";
import type { PreparedPdb, PdbSummary } from "./types.js";

/** Explicit opt-in preparation. Retain the original alongside the returned report. */
export function preparePdb(original: string): PreparedPdb {
  if (typeof original !== "string")
    throw new TypeError("PDB input must be text.");
  const prepared = prepareProteinPdb(original);
  validate(prepared.pdb);
  return prepared;
}
/** Strict admission only. Does not remove chains, select conformers or cap residue count. */
export function validatePdb(pdb: string): PdbSummary {
  if (typeof pdb !== "string") throw new TypeError("PDB input must be text.");
  return validate(pdb);
}
