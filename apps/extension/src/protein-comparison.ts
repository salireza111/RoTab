import { MinimizeRmsd } from "molstar/lib/mol-math/linear-algebra/3d/minimize-rmsd";
import { Vec3 } from "molstar/lib/mol-math/linear-algebra/3d/vec3";
import { readProteinFrame } from "./protein-motion";

type Point = [number, number, number];
export type ProteinComparison =
  | {
      status: "aligned";
      rmsd: number;
      matchedResidues: number;
      selectedResidues: number;
      baselineResidues: number;
      alignedPdb: string;
      positions: Float32Array;
    }
  | { status: "unavailable"; reason: string };

function atomPoint(line: string): Point | undefined {
  const fields = [30, 38, 46].map((offset) =>
    line.slice(offset, offset + 8).trim(),
  );
  if (fields.some((field) => !field)) return;
  const point = fields.map(Number) as Point;
  return point.every(Number.isFinite) ? point : undefined;
}

function alphaCarbons(pdb: string): Map<string, Point> | undefined {
  const points = new Map<string, Point>();
  for (const line of pdb.split(/\r?\n/)) {
    if (line.startsWith("ENDMDL")) break;
    if (!line.startsWith("ATOM  ") || line.slice(12, 16).trim() !== "CA")
      continue;
    // A single conformer avoids counting alternate locations as two residues.
    const alternate = line[16];
    if (alternate && alternate !== " " && alternate !== "A") continue;
    const point = atomPoint(line);
    if (!point) return;
    const key = `${line[21]}:${line.slice(22, 26).trim()}:${line[26]}`;
    if (points.has(key)) return;
    points.set(key, point);
  }
  return points;
}

function hasPlane(points: Point[]) {
  const origin = points[0];
  for (let i = 1; i < points.length - 1; i++) {
    const a = points[i].map((value, axis) => value - origin[axis]);
    for (let j = i + 1; j < points.length; j++) {
      const b = points[j].map((value, axis) => value - origin[axis]);
      const cross = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];
      if (Math.hypot(...cross) > 1e-6) return true;
    }
  }
  return false;
}

/** Rigid display alignment only: the original scientific PDBs remain untouched. */
export function compareProteinFrames(
  selectedPdb: string,
  baselinePdb: string,
): ProteinComparison {
  const selected = alphaCarbons(selectedPdb),
    baseline = alphaCarbons(baselinePdb);
  if (!selected || !baseline)
    return {
      status: "unavailable",
      reason: "Invalid or ambiguous C-alpha coordinates.",
    };
  const keys = [...selected.keys()].filter((key) => baseline.has(key));
  if (keys.length < 3)
    return {
      status: "unavailable",
      reason: "At least three matching C-alpha residues are required.",
    };
  const a = keys.map((key) => selected.get(key)!),
    b = keys.map((key) => baseline.get(key)!);
  if (!hasPlane(a) || !hasPlane(b))
    return {
      status: "unavailable",
      reason: "Matching C-alpha coordinates do not define a stable alignment.",
    };
  const positions = (points: Point[]) => ({
    x: points.map((p) => p[0]),
    y: points.map((p) => p[1]),
    z: points.map((p) => p[2]),
  });
  try {
    const result = MinimizeRmsd.compute({ a: positions(a), b: positions(b) });
    if (
      !Number.isFinite(result.rmsd) ||
      result.bTransform.some((value) => !Number.isFinite(value))
    )
      throw new Error("Invalid transform");
    const transformed = Vec3();
    const frame = readProteinFrame(baselinePdb);
    const alignedPositions = new Float32Array(frame.positions.length);
    for (let i = 0; i < frame.positions.length; i += 3) {
      Vec3.transformMat4(
        transformed,
        Vec3.create(
          frame.positions[i],
          frame.positions[i + 1],
          frame.positions[i + 2],
        ),
        result.bTransform,
      );
      alignedPositions.set(transformed, i);
    }
    let firstModelEnded = false;
    const alignedPdb = baselinePdb
      .split(/\r?\n/)
      .map((line) => {
        if (line.startsWith("ENDMDL")) firstModelEnded = true;
        if (
          firstModelEnded ||
          (!line.startsWith("ATOM  ") && !line.startsWith("HETATM"))
        )
          return line;
        const point = atomPoint(line);
        if (!point) throw new Error("Invalid atom coordinates");
        Vec3.transformMat4(
          transformed,
          Vec3.create(point[0], point[1], point[2]),
          result.bTransform,
        );
        const formatted = Array.from(transformed, (value) =>
          value.toFixed(3).padStart(8),
        );
        if (formatted.some((value) => value.length !== 8))
          throw new Error("Coordinates exceed PDB field size");
        return line.slice(0, 30) + formatted.join("") + line.slice(54);
      })
      .join("\n");
    return {
      status: "aligned",
      rmsd: result.rmsd,
      matchedResidues: keys.length,
      selectedResidues: selected.size,
      baselineResidues: baseline.size,
      alignedPdb,
      positions: alignedPositions,
    };
  } catch {
    return {
      status: "unavailable",
      reason: "The structures could not be aligned.",
    };
  }
}
