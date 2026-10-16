export type ProteinColorMode = "sequence" | "energy";

// One palette throughout the viewport and its key. Endpoints and the neutral
// energy midpoint are exact; intermediate values interpolate in RGB space.
export const ProteinPalette = [
  { name: "Mint", hex: "#65d9d0", value: 0x65d9d0 },
  { name: "Blue", hex: "#7db8ef", value: 0x7db8ef },
  { name: "Lavender", hex: "#b5a1f1", value: 0xb5a1f1 },
  { name: "Pink", hex: "#e9aecc", value: 0xe9aecc },
  { name: "Gold", hex: "#f2ca91", value: 0xf2ca91 },
] as const;
export const UnscoredColor = 0x738296;
export const ResidueEnergyDomain = [-10, 10] as const;

// Internal residue-type NAME -> PDB IO_STRING in the pinned fa_standard
// l-caa database. These are chemical variants of the same standard residue,
// not permission to ignore a sequence mismatch in the energy table.
const pdbResidueNames: Readonly<Record<string, string>> = {
  HIS_D: "HIS",
  CYZ: "CYS",
};

export interface ProteinResidue {
  key: string;
  name: string;
  chain: string;
  number: number;
  insertion: string;
  /** Observed position within this chain, independent of PDB numbering. */
  position: number;
  chainLength: number;
  energy?: number;
  ca?: [number, number, number];
}
export interface ProteinColorData {
  residues: ProteinResidue[];
  scoredCount: number;
  /** Rounded total reported by the same PDB energy table, when present. */
  tableTotal?: number;
  signature: number;
}

export function residueKey(chain: string, number: number, insertion = "") {
  return `${chain.trim()}:${number}:${insertion.trim()}`;
}

/** Read only the first coordinate model; never substitute B factors for energy. */
export function readProteinColors(pdb: string): ProteinColorData {
  const residues: ProteinResidue[] = [];
  const byKey = new Map<string, ProteinResidue>();
  const chains = new Map<string, ProteinResidue[]>();
  for (const line of pdb.split("\n")) {
    if (line.startsWith("ENDMDL")) break;
    if (!line.startsWith("ATOM  ")) continue;
    const chain = line.slice(21, 22).trim();
    const number = Number(line.slice(22, 26));
    if (!line.slice(22, 26).trim() || !Number.isInteger(number)) continue;
    const insertion = line.slice(26, 27).trim();
    const key = residueKey(chain, number, insertion);
    let residue = byKey.get(key);
    if (!residue) {
      const chainResidues = chains.get(chain) ?? [];
      residue = {
        key,
        name: line.slice(17, 20).trim(),
        chain,
        number,
        insertion,
        position: chainResidues.length + 1,
        chainLength: 0,
      };
      chainResidues.push(residue);
      chains.set(chain, chainResidues);
      byKey.set(key, residue);
      residues.push(residue);
    }
    if (line.slice(12, 16).trim() === "CA" && !residue.ca) {
      const xyz = [30, 38, 46].map((offset) =>
        Number(line.slice(offset, offset + 8)),
      );
      if (xyz.every(Number.isFinite))
        residue.ca = xyz as [number, number, number];
    }
  }
  for (const chain of chains.values())
    for (const residue of chain) residue.chainLength = chain.length;

  // Rosetta's table labels use POSE ordinals, not PDB residue numbers. The
  // `total` column is already weighted; applying the weights again is wrong.
  const block = pdb.match(
    /#BEGIN_POSE_ENERGIES_TABLE[^\n]*\n([\s\S]*?)#END_POSE_ENERGIES_TABLE/,
  );
  let tableTotal: number | undefined;
  if (block) {
    const rows = block[1]
      .trim()
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/));
    const header = rows.find((row) => row[0] === "label");
    const totalIndex = header?.indexOf("total") ?? -1;
    const energies = new Map<number, number>();
    let valid = totalIndex > 0;
    for (const row of rows) {
      if (["label", "weights"].includes(row[0])) continue;
      const value = Number(row[totalIndex]);
      if (row.length !== header?.length || !Number.isFinite(value)) {
        valid = false;
        break;
      }
      if (row[0] === "pose") {
        tableTotal = value;
        continue;
      }
      const label = row[0].match(/^(.+)_([1-9]\d*)$/);
      const index = label ? Number(label[2]) - 1 : -1;
      const typeName = label?.[1].split(":")[0];
      const pdbName = typeName && (pdbResidueNames[typeName] ?? typeName);
      if (
        !label ||
        !residues[index] ||
        pdbName !== residues[index].name ||
        energies.has(index)
      ) {
        valid = false;
        break;
      }
      energies.set(index, value);
    }
    if (valid && tableTotal !== undefined)
      for (const [index, energy] of energies) residues[index].energy = energy;
    else tableTotal = undefined;
  }
  // Mol* uses this to invalidate color buffers when scores change, including
  // an update whose atom coordinates happen to stay identical.
  const description = residues
    .map((r) => `${r.key}/${r.position}/${r.chainLength}/${r.energy ?? "NA"}`)
    .join("|");
  let signature = 2166136261;
  for (const character of description)
    signature = Math.imul(signature ^ character.charCodeAt(0), 16777619);
  return {
    residues,
    tableTotal,
    scoredCount: residues.filter((r) => r.energy !== undefined).length,
    signature: signature >>> 0,
  };
}

export function paletteColor(fraction: number) {
  const position =
    Math.min(1, Math.max(0, fraction)) * (ProteinPalette.length - 1);
  const index = Math.min(ProteinPalette.length - 2, Math.floor(position));
  const from = ProteinPalette[index].value,
    to = ProteinPalette[index + 1].value;
  const t = position - index;
  return [16, 8, 0].reduce(
    (rgb, shift) =>
      rgb |
      (Math.round(
        ((from >> shift) & 255) * (1 - t) + ((to >> shift) & 255) * t,
      ) <<
        shift),
    0,
  );
}

export function residueColor(
  residue: ProteinResidue | undefined,
  mode: ProteinColorMode,
) {
  if (!residue) return UnscoredColor;
  if (mode === "sequence")
    return paletteColor(
      (residue.position - 1) / Math.max(1, residue.chainLength - 1),
    );
  if (residue.energy === undefined || !Number.isFinite(residue.energy))
    return UnscoredColor;
  const [low, high] = ResidueEnergyDomain;
  return paletteColor((residue.energy - low) / (high - low));
}

export function colorHex(value: number) {
  return `#${value.toString(16).padStart(6, "0")}`;
}
