/** Packaged adapters. Availability additionally requires the exact build's proof manifest. */
export const PROTOCOLS = [
  {
    id: "score",
    label: "Fixed-coordinate scoring",
    changesSequence: false,
    description: "Evaluate the supplied coordinates with REF2015.",
  },
  {
    id: "relax",
    label: "Torsion FastRelax",
    changesSequence: false,
    description: "One FastRelax repeat with packing and torsion minimization.",
  },
  {
    id: "minimize",
    label: "Torsion minimization",
    changesSequence: false,
    description:
      "Minimize backbone and side-chain torsions; at most 200 iterations.",
  },
  {
    id: "repack",
    label: "Side-chain repacking",
    changesSequence: false,
    description:
      "Search side-chain rotamers while preserving sequence and backbone.",
  },
  {
    id: "fixed_backbone_design",
    label: "Fixed-backbone sequence design",
    changesSequence: true,
    description:
      "Search canonical amino-acid identities and rotamers on a fixed backbone.",
  },
  {
    id: "fastdesign",
    label: "Flexible-backbone FastDesign",
    changesSequence: true,
    description:
      "One FastDesign repeat with sequence design, packing and minimization.",
  },
  {
    id: "cartesian_minimize",
    label: "Cartesian minimization",
    changesSequence: false,
    description:
      "Optimize atomic coordinates with REF2015 plus cart_bonded; report REF2015.",
  },
  {
    id: "cartesian_relax",
    label: "Cartesian FastRelax",
    changesSequence: false,
    description:
      "One Cartesian FastRelax repeat; report the common REF2015 score.",
  },
] as const;
export type Protocol = (typeof PROTOCOLS)[number]["id"];
export const PROTOCOL_IDS = PROTOCOLS.map((p) => p.id) as [
  Protocol,
  ...Protocol[],
];
export const protocolDefinition = (id: Protocol) =>
  PROTOCOLS.find((p) => p.id === id)!;

/** PDB row identifiers are retained in every currently packaged coordinate adapter. */
export function validateResultIdentity(
  input: string,
  output: string,
  protocol: Protocol,
) {
  const residues = (pdb: string) => {
    const result = new Map<string, string>();
    for (const line of pdb.split(/\r?\n/))
      if (line.startsWith("ATOM  "))
        result.set(line.slice(21, 27), line.slice(17, 20));
    return result;
  };
  const before = residues(input),
    after = residues(output);
  if (
    before.size !== after.size ||
    [...before.keys()].some((key) => !after.has(key))
  )
    throw new Error("Result residue identities differ from the input.");
  if (
    !protocolDefinition(protocol).changesSequence &&
    [...before].some(([key, name]) => after.get(key) !== name)
  )
    throw new Error("Result sequence differs from the input.");
}
