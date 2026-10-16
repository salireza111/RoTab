type Point3 = readonly [number, number, number];
export type StrandPoint = { x: number; y: number; depth: number };

// C-alpha coordinates from the first model in our bundled 1L2Y fixture.
// Interpolation from an extended strand is a timer illustration, not a
// molecular dynamics trajectory or a Rosetta calculation.
const TRP_CAGE: readonly Point3[] = [
  [-8.608, 3.135, -1.618],
  [-4.923, 4.002, -2.452],
  [-3.69, 2.738, 0.981],
  [-5.857, -0.449, 0.613],
  [-4.122, -1.167, -2.743],
  [-0.716, -0.631, -0.993],
  [-1.641, -2.932, 1.963],
  [-3.024, -5.791, -0.269],
  [0.466, -6.016, -1.905],
  [2.06, -6.618, 1.593],
  [2.626, -2.967, 2.723],
  [6.333, -2.533, 3.806],
  [7.049, -6.179, 2.704],
  [6.389, -5.315, -1.015],
  [9.451, -3.116, -1.87],
  [7.289, 0.084, -2.054],
  [6.782, 3.088, 0.345],
  [3.287, 4.031, 1.686],
  [1.185, 6.543, -0.353],
  [0.852, 10.027, 1.285],
];
const center = [0, 1, 2].map(
  (axis) =>
    TRP_CAGE.reduce((sum, point) => sum + point[axis], 0) / TRP_CAGE.length,
);

export function focusStrand(progress: number): StrandPoint[] {
  const t = Math.max(0, Math.min(1, progress));
  const fold = t * t * (3 - 2 * t);
  const angle = -0.25 + fold * 0.65;
  return TRP_CAGE.map((point, i) => {
    const x = (point[0] - center[0]) * 7.3;
    const y = -(point[1] - center[1]) * 7.3;
    const z = (point[2] - center[2]) * 7.3;
    const targetX = x * Math.cos(angle) + z * Math.sin(angle);
    const targetY = y * 0.9 + z * 0.4;
    const extendedX = (i / (TRP_CAGE.length - 1) - 0.5) * 264;
    // A small bend during the middle of the session makes the collapse legible.
    const bend =
      Math.sin((i / (TRP_CAGE.length - 1)) * Math.PI * 2) *
      Math.sin(t * Math.PI) *
      18;
    return {
      x: 160 + extendedX * (1 - fold) + targetX * fold,
      y: 90 + targetY * fold + bend,
      depth: z * fold,
    };
  });
}

export function strandPath(points: StrandPoint[]): string {
  const n = (value: number) => value.toFixed(2);
  return points
    .map((p, i) => {
      if (i === 0) return `M ${n(p.x)} ${n(p.y)}`;
      const before = points[Math.max(0, i - 2)];
      const previous = points[i - 1];
      const after = points[Math.min(points.length - 1, i + 1)];
      return `C ${n(previous.x + (p.x - before.x) / 6)} ${n(previous.y + (p.y - before.y) / 6)}, ${n(p.x - (after.x - previous.x) / 6)} ${n(p.y - (after.y - previous.y) / 6)}, ${n(p.x)} ${n(p.y)}`;
    })
    .join(" ");
}
