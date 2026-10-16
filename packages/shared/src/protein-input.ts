export const STANDARD_AMINO_ACIDS = new Set([
  "ALA",
  "ARG",
  "ASN",
  "ASP",
  "CYS",
  "GLN",
  "GLU",
  "GLY",
  "HIS",
  "ILE",
  "LEU",
  "LYS",
  "MET",
  "PHE",
  "PRO",
  "SER",
  "THR",
  "TRP",
  "TYR",
  "VAL",
]);

export interface ProteinPreparation {
  policy: "pdb-coordinate-preparation-v1" | "pdb-protein-only-preparation-v2";
  totalModels: number;
  selectedModel?: string;
  conformers: Array<{
    residue: string;
    label: string;
    meanOccupancy: number | null;
  }>;
  duplicateAtomsRemoved: number;
  waterAtomsRemoved: number;
  /** Optional so saved v1 preparation records remain readable. */
  nonProteinRemoved?: Array<{
    name: string;
    kind: "water" | "ion" | "ligand";
    residues: number;
    atoms: number;
  }>;
  linkRecordsRemoved?: number;
  conectReferencesRemoved?: number;
  canonicalAtomRecordsConverted?: number;
  normalizedText: boolean;
}

const WATER = new Set(["HOH", "WAT", "DOD"]);
const ION_ELEMENTS = new Set([
  "LI",
  "NA",
  "K",
  "RB",
  "CS",
  "MG",
  "CA",
  "SR",
  "BA",
  "ZN",
  "FE",
  "MN",
  "CU",
  "CO",
  "NI",
  "CD",
  "HG",
  "AL",
  "AG",
  "AU",
  "PB",
  "PT",
  "F",
  "CL",
  "BR",
  "I",
]);
const residueIdentity = (line: string) =>
  line.slice(17, 20).trim() + ":" + line.slice(21, 27);

/** Select a protein-only system; preserve protein coordinates and report excluded chemistry. */
function removeNonProtein(lines: string[], report: ProteinPreparation) {
  const groups = new Map<string, string[]>();
  const modifiedProtein = new Set(
    lines
      .filter(
        (line) =>
          line.startsWith("MODRES") &&
          STANDARD_AMINO_ACIDS.has(line.slice(24, 27).trim()),
      )
      .map(
        (line) =>
          line.slice(12, 15).trim() +
          ":" +
          line.slice(16, 17) +
          line.slice(18, 23),
      ),
  );
  for (const line of lines) {
    if (
      !line.startsWith("HETATM") &&
      !(line.startsWith("ATOM  ") && WATER.has(line.slice(17, 20).trim()))
    )
      continue;
    if (
      line.length < 54 ||
      !line.slice(6, 11).trim() ||
      !line.slice(12, 16).trim() ||
      !line.slice(17, 20).trim()
    )
      throw new Error(
        "Malformed HETATM/water record. Upload a PDB with complete atom and residue identifiers.",
      );
    const key = residueIdentity(line);
    const atoms = groups.get(key) ?? [];
    atoms.push(line);
    groups.set(key, atoms);
  }
  const removed = new Set<string>(),
    serials = new Set<string>(),
    names = new Set<string>();
  const counts = new Map<
    string,
    NonNullable<ProteinPreparation["nonProteinRemoved"]>[number]
  >();
  for (const [key, atoms] of groups) {
    const name = atoms[0].slice(17, 20).trim();
    if (STANDARD_AMINO_ACIDS.has(name)) continue;
    const atomNames = new Set(atoms.map((line) => line.slice(12, 16).trim()));
    // A modified amino acid is still protein. Never remove it as a ligand to pass admission.
    if (
      modifiedProtein.has(key) ||
      ["MSE", "SEC", "PYL"].includes(name) ||
      (atomNames.has("CA") &&
        ["N", "C", "O"].some((atom) => atomNames.has(atom))) ||
      ["N", "C", "O"].every((atom) => atomNames.has(atom))
    )
      throw new Error(
        `Modified or nonstandard protein residue ${name} ${atoms[0].slice(21, 27).trim()} is not supported. It was not removed; supply a standard-amino-acid structure.`,
      );
    const element =
      atoms[0].slice(76, 78).trim().toUpperCase() ||
      name.replace(/[0-9+-]/g, "");
    const kind = WATER.has(name)
      ? "water"
      : atoms.length === 1 && ION_ELEMENTS.has(element)
        ? "ion"
        : "ligand";
    const count = counts.get(name) ?? { name, kind, residues: 0, atoms: 0 };
    count.residues++;
    count.atoms += atoms.length;
    counts.set(name, count);
    removed.add(key);
    names.add(name);
    for (const atom of atoms) serials.add(atom.slice(6, 11).trim());
    if (kind === "water") report.waterAtomsRemoved += atoms.length;
  }
  if (
    lines.some(
      (line) =>
        /^(ATOM  |HETATM)/.test(line) &&
        !removed.has(residueIdentity(line)) &&
        serials.has(line.slice(6, 11).trim()),
    )
  )
    throw new Error(
      "Protein and excluded components share an atom serial number. Resolve duplicate identifiers before uploading.",
    );
  report.nonProteinRemoved = [...counts.values()];
  return lines.flatMap((line) => {
    if (
      /^(ATOM  |HETATM|ANISOU|SIGATM|SIGUIJ|TER   )/.test(line) &&
      removed.has(residueIdentity(line))
    )
      return [];
    if (
      line.startsWith("HETATM") &&
      STANDARD_AMINO_ACIDS.has(line.slice(17, 20).trim())
    ) {
      report.canonicalAtomRecordsConverted!++;
      return ["ATOM  " + line.slice(6)];
    }
    // PDB LINK endpoints use separate fixed-width atom/residue fields (wwPDB v3.3).
    if (
      line.startsWith("LINK  ") &&
      (removed.has(residueIdentity(line)) ||
        removed.has(line.slice(47, 50).trim() + ":" + line.slice(51, 57)))
    ) {
      report.linkRecordsRemoved!++;
      return [];
    }
    if (line.startsWith("CONECT")) {
      const source = line.slice(6, 11).trim();
      const targets =
        line
          .slice(11)
          .match(/.{1,5}/g)
          ?.filter((field) => field.trim()) ?? [];
      const kept = targets.filter((field) => !serials.has(field.trim()));
      if (serials.has(source)) {
        report.conectReferencesRemoved! += targets.length;
        return [];
      }
      report.conectReferencesRemoved! += targets.length - kept.length;
      if (kept.length !== targets.length)
        return kept.length ? [line.slice(0, 11) + kept.join("")] : [];
    }
    // Drop declarations for removed components, rather than leave stale chemical metadata.
    const component = line.startsWith("HET   ")
      ? line.slice(7, 10).trim()
      : /^(HETNAM|HETSYN)/.test(line)
        ? line.slice(11, 14).trim()
        : line.startsWith("FORMUL")
          ? line.slice(12, 15).trim()
          : "";
    return names.has(component) ? [] : [line];
  });
}

/** No coordinate fabrication or protein-chain clipping; excluded components are recorded. */
export function prepareProteinPdb(original: string) {
  const normalized = original.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  let lines = normalized.split("\n");
  const models = lines.filter((l) => l.startsWith("MODEL "));
  const report: ProteinPreparation = {
    policy: "pdb-protein-only-preparation-v2",
    totalModels: Math.max(1, models.length),
    conformers: [],
    duplicateAtomsRemoved: 0,
    waterAtomsRemoved: 0,
    nonProteinRemoved: [],
    linkRecordsRemoved: 0,
    conectReferencesRemoved: 0,
    canonicalAtomRecordsConverted: 0,
    normalizedText: normalized !== original,
  };
  if (models.length > 1) {
    report.selectedModel = models[0].slice(10, 14).trim() || "1";
    let inside = false,
      seen = false,
      ended = false;
    lines = lines.filter((line) => {
      if (line.startsWith("MODEL ")) {
        if (inside) throw new Error("An ensemble model is missing ENDMDL.");
        inside = true;
        const first = !seen;
        seen = true;
        return first;
      }
      if (line.startsWith("ENDMDL")) {
        if (!inside)
          throw new Error("Unexpected ENDMDL in the uploaded structure.");
        inside = false;
        const first = !ended;
        ended = true;
        return first;
      }
      if (/^(ATOM  |HETATM|ANISOU|TER   )/.test(line)) {
        if (!inside)
          throw new Error(
            "Coordinates outside an ensemble model are ambiguous.",
          );
        return !ended;
      }
      return !line.startsWith("NUMMDL") && (!inside || !ended);
    });
    if (inside) throw new Error("An ensemble model is missing ENDMDL.");
  }
  lines = removeNonProtein(lines, report);
  const residues = new Map<string, string[]>();
  for (const line of lines) {
    if (!line.startsWith("ATOM  ")) continue;
    const key = line.slice(21, 27);
    const atoms = residues.get(key) ?? [];
    atoms.push(line);
    residues.set(key, atoms);
  }
  const selected = new Map<string, string>();
  for (const [key, atoms] of residues) {
    const labels = [
      ...new Set(atoms.map((l) => l.slice(16, 17).trim()).filter(Boolean)),
    ];
    if (!labels.length) continue;
    const choices = labels
      .map((label) => {
        const own = atoms.filter((l) => l.slice(16, 17) === label);
        const shared = atoms.filter((l) => !l.slice(16, 17).trim());
        const names = new Set(
          [...own, ...shared].map((l) => l.slice(12, 16).trim()),
        );
        const occupancies = own
          .map((l) => l.slice(54, 60).trim())
          .filter(
            (v) =>
              v &&
              Number.isFinite(Number(v)) &&
              Number(v) >= 0 &&
              Number(v) <= 1,
          )
          .map(Number);
        const occupancy = occupancies.length
          ? occupancies.reduce((a, b) => a + b, 0) / occupancies.length
          : null;
        return {
          label,
          occupancy,
          complete: ["N", "CA", "C", "O"].every((n) => names.has(n)),
        };
      })
      .filter((c) => c.complete);
    if (!choices.length)
      throw new Error(
        `Residue ${key.trim()} has no complete alternate backbone. Missing coordinates cannot be inferred safely.`,
      );
    // One conformer per residue: never build a mixture by choosing each atom independently.
    choices.sort(
      (a, b) =>
        (b.occupancy ?? -1) - (a.occupancy ?? -1) ||
        (a.label === "A"
          ? -1
          : b.label === "A"
            ? 1
            : a.label < b.label
              ? -1
              : a.label > b.label
                ? 1
                : 0),
    );
    const choice = choices[0];
    selected.set(key, choice.label);
    report.conformers.push({
      residue: key.trim(),
      label: choice.label,
      meanOccupancy: choice.occupancy,
    });
  }
  const seen = new Map<string, string>();
  lines = lines.flatMap((line) => {
    if (!line.startsWith("ATOM  ") && !line.startsWith("ANISOU")) return [line];
    const key = line.slice(21, 27),
      alt = line.slice(16, 17).trim();
    if (alt && alt !== selected.get(key)) return [];
    const prepared = alt ? line.slice(0, 16) + " " + line.slice(17) : line;
    if (line.startsWith("ANISOU")) return [prepared];
    const identity = key + ":" + line.slice(12, 16);
    if (seen.has(identity)) {
      if (seen.get(identity) !== prepared.slice(12))
        throw new Error(
          `Conflicting duplicate atom ${line.slice(12, 16).trim()} in residue ${key.trim()}.`,
        );
      report.duplicateAtomsRemoved++;
      return [];
    }
    seen.set(identity, prepared.slice(12));
    return [prepared];
  });
  const changedCoordinates =
    report.totalModels > 1 ||
    report.conformers.length > 0 ||
    report.nonProteinRemoved!.length > 0 ||
    report.canonicalAtomRecordsConverted! > 0 ||
    report.duplicateAtomsRemoved > 0;
  // MASTER contains old atom counts, so it cannot describe a prepared structure.
  const pdb = (
    changedCoordinates ? lines.filter((l) => !l.startsWith("MASTER")) : lines
  ).join("\n");
  return { pdb, report, changed: pdb !== original };
}

export function preparationMessages(report: ProteinPreparation) {
  return [
    ...(report.totalModels > 1
      ? [
          `Selected model ${report.selectedModel} from ${report.totalModels} coordinate models.`,
        ]
      : []),
    ...(report.conformers.length
      ? [
          `Resolved alternate locations in ${report.conformers.length} residues using one complete conformer per residue, ranked by mean occupancy (A wins ties).`,
        ]
      : []),
    ...(report.waterAtomsRemoved
      ? [
          `Removed ${report.waterAtomsRemoved} crystallographic water atoms for the implicit-solvent protocol.`,
        ]
      : []),
    ...(report.nonProteinRemoved ?? [])
      .filter((entry) => entry.kind !== "water")
      .map(
        (entry) =>
          `Removed ${entry.residues} ${entry.name} ${entry.kind}${entry.residues === 1 ? "" : "s"} (${entry.atoms} atom${entry.atoms === 1 ? "" : "s"}).`,
      ),
    ...(report.linkRecordsRemoved || report.conectReferencesRemoved
      ? [
          `Removed ${report.linkRecordsRemoved ?? 0} LINK records and ${report.conectReferencesRemoved ?? 0} CONECT references to excluded components.`,
        ]
      : []),
    ...(report.canonicalAtomRecordsConverted
      ? [
          `Retained ${report.canonicalAtomRecordsConverted} standard amino-acid HETATM records as ATOM records.`,
        ]
      : []),
    ...(report.duplicateAtomsRemoved
      ? [
          `Removed ${report.duplicateAtomsRemoved} identical duplicate atom records.`,
        ]
      : []),
    ...(report.normalizedText
      ? ["Normalized line endings / text encoding marker."]
      : []),
  ];
}

/** Always-visible caution; details and original/prepared downloads can remain collapsed. */
export function proteinOnlyCaution(report: ProteinPreparation) {
  const groups = report.nonProteinRemoved ?? [];
  const ions = groups
    .filter((entry) => entry.kind === "ion")
    .reduce((n, entry) => n + entry.residues, 0);
  const ligands = groups
    .filter((entry) => entry.kind === "ligand")
    .reduce((n, entry) => n + entry.residues, 0);
  const removed = [
    ...(report.waterAtomsRemoved
      ? [
          `${report.waterAtomsRemoved} water atom${report.waterAtomsRemoved === 1 ? "" : "s"}`,
        ]
      : []),
    ...(ions ? [`${ions} ion${ions === 1 ? "" : "s"}`] : []),
    ...(ligands ? [`${ligands} ligand${ligands === 1 ? "" : "s"}`] : []),
  ];
  return removed.length
    ? `Protein-only calculation: removed ${removed.join(", ")}. Results exclude these components and their interactions. Original file kept.`
    : undefined;
}
