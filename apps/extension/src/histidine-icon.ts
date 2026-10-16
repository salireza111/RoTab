/** Histidine's imidazole ring and side-chain stem, simplified for small favicons. */
export const HISTIDINE_OUTLINE =
  "M23 18 16 23 22 41 32 41 M41 18 48 23 46 30 M22 41 15 50 24 57";
export const HISTIDINE_BONDS = "M24 28 26 34 M36 21 41 25";
export const HISTIDINE_NITROGENS = "M28.5 15V6L35.5 15V6 M38.5 45V36L45.5 45V36";
export const HISTIDINE_STROKES = { outline: 4, bonds: 3, nitrogens: 2.5 };
export const NEUTRAL_ICON_COLOR = "#8b9097";

export function histidineIconSvg(color = NEUTRAL_ICON_COLOR) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><g fill="none" stroke="${color}" stroke-width="${HISTIDINE_STROKES.outline}" stroke-linecap="round" stroke-linejoin="round"><path d="${HISTIDINE_OUTLINE}"/><path d="${HISTIDINE_BONDS}" stroke-width="${HISTIDINE_STROKES.bonds}"/><path d="${HISTIDINE_NITROGENS}" stroke-width="${HISTIDINE_STROKES.nitrogens}"/></g></svg>`;
}

export function drawHistidineIcon(
  context: CanvasRenderingContext2D,
  color: string,
) {
  context.strokeStyle = color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = HISTIDINE_STROKES.outline;
  context.stroke(new Path2D(HISTIDINE_OUTLINE));
  context.lineWidth = HISTIDINE_STROKES.bonds;
  context.stroke(new Path2D(HISTIDINE_BONDS));
  context.lineWidth = HISTIDINE_STROKES.nitrogens;
  context.stroke(new Path2D(HISTIDINE_NITROGENS));
}
