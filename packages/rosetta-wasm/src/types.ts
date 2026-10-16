/** Identifiers admitted by the measured coordinate engine, not the full dispatcher. */
export const PROTOCOL_IDS = [
  "score",
  "relax",
  "minimize",
  "repack",
  "fixed_backbone_design",
  "fastdesign",
  "cartesian_minimize",
  "cartesian_relax",
] as const;
export type Protocol = (typeof PROTOCOL_IDS)[number];
export const ENGINE_ID = "rosetta-protocols-v2";
export const SOURCE_SHA = "369e400415dd5c585f80dcf7b647147ee520e8ba";
export const ENGINE_HASHES = Object.freeze({
  "rosetta.mjs":
    "b5c9ebbb4c30cd54e1eb62ad08f32b2ef54179ccdd29d3ce077365f3cad5f65c",
  "rosetta.wasm":
    "81b86e799406616dde525a7598342f279a6e7fef0b9153eef4f40c8ca5c237c7",
  "rosetta.data":
    "c3ede09e4c3f652f36d0661e12007fcf1d87cde8ecf9e47f0a02aba1873c9d8a",
});
export type SnapshotSource =
  "initial" | "stage" | "minimizing" | "packing" | "final";
export interface StructureSnapshot {
  pdb: string;
  /** Common full-weight REF2015, in Rosetta Energy Units (REU). */
  energy: number;
  /** Stage estimate, not elapsed-time prediction. Some methods remain at 0 until final. */
  progress: number;
  source: SnapshotSource;
  sequence: number;
  /** A callback counter; not necessarily an accepted minimizer iteration. */
  iteration: number;
  timestamp: number;
  heapBytes: number;
}
export type Phase = "verifying-assets" | "loading-module" | "calculating";
export interface RunOptions {
  /** 1–2,000,000,000. Reset for every run; defaults to 17. */
  seed?: number;
  /** Cooperative per-worker active-time target, 10–75; defaults to 25. */
  dutyCycle?: number;
  /** Abort terminates the worker. It cannot save an unfinished Rosetta call. */
  signal?: AbortSignal;
  onSnapshot?: (snapshot: StructureSnapshot) => void;
  onPhase?: (phase: Phase) => void;
  onLog?: (message: string) => void;
}
export interface ClientOptions {
  /** Directory containing manifest.json, rosetta.mjs, rosetta.wasm and rosetta.data. */
  engineUrl: string | URL;
  /** Optional explicit URL for bundlers that relocate the supplied module worker. */
  workerUrl?: string | URL;
}
export interface Result {
  pdb: string;
  /** REF2015 score of returned PDB-rounded coordinates, not the optimization objective. */
  energy: number;
  protocol: Protocol;
  scoreFunction: "ref2015";
  sequence: string;
  /** Objective evaluated before PDB serialization/rounding. */
  objectiveEnergy: number;
  objectiveScoreFunction: "ref2015" | "ref2015_cart";
  activeMs: number;
  sleepingMs: number;
  yields: number;
  liveSnapshots: number;
  minimizerEvaluations: number;
  packingMoves: number;
  heapBytes: number;
  provenance: {
    engineId: typeof ENGINE_ID;
    sourceSha: typeof SOURCE_SHA;
    hashes: typeof ENGINE_HASHES;
    inputSha256: string;
    outputSha256: string;
    seed: number;
    dutyCycle: number;
  };
  timing: {
    /** Asset download, hash checking and module factory; zero on a reused worker. */
    initializationMs: number;
    /** Includes lazy Rosetta database/score-table initialization on its first call. */
    calculationMs: number;
    totalMs: number;
  };
}
export interface PreparedPdb {
  pdb: string;
  changed: boolean;
  report: {
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
  };
}
export interface PdbSummary {
  residues: number;
  atoms: number;
  chain: string;
}

/** No worker, network or extension permission is needed to implement this interface. */
export interface ProtocolRunner {
  run(protocol: Protocol, pdb: string, options?: RunOptions): Promise<Result>;
}
