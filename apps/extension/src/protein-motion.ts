export interface ProteinFrame {
  keys: string[];
  positions: Float32Array;
}

/** PDB atom identity, never serial number: Rosetta may renumber atoms. */
export function readProteinFrame(pdb: string): ProteinFrame {
  const keys: string[] = [],
    positions: number[] = [];
  for (const line of pdb.split("\n")) {
    if (line.startsWith("ENDMDL")) break;
    if (!line.startsWith("ATOM  ") && !line.startsWith("HETATM")) continue;
    const xyz = [30, 38, 46].map((offset) =>
      Number(line.slice(offset, offset + 8)),
    );
    if (xyz.some((value) => !Number.isFinite(value))) continue;
    keys.push(line.slice(12, 27));
    positions.push(...xyz);
  }
  return { keys, positions: new Float32Array(positions) };
}

export function interpolateCoordinates(
  from: Float32Array,
  to: Float32Array,
  fraction: number,
) {
  if (from.length !== to.length)
    throw new Error("Cannot interpolate different atom topologies.");
  const t = Math.min(1, Math.max(0, fraction));
  const eased = t * t * (3 - 2 * t);
  return Float32Array.from(
    to,
    (value, i) => from[i] + (value - from[i]) * eased,
  );
}

/** Presentation only. Intermediate coordinates are never scored or submitted. */
export class CoordinateTransition {
  from: Float32Array = new Float32Array();
  target: Float32Array = new Float32Array();
  startedAt = 0;
  duration = 0;
  sample(now: number) {
    return this.duration > 0 && now < this.startedAt + this.duration
      ? interpolateCoordinates(
          this.from,
          this.target,
          (now - this.startedAt) / this.duration,
        )
      : this.target;
  }
  set(target: Float32Array, now: number, duration: number) {
    this.from =
      this.target.length === target.length ? this.sample(now) : target;
    this.target = target;
    this.startedAt = now;
    this.duration = duration;
  }
  finish() {
    this.duration = 0;
  }
}
