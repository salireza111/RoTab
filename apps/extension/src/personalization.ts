export const FONTS = {
  system: {
    label: "System",
    stack:
      'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  arial: { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  georgia: { label: "Georgia", stack: 'Georgia, "Times New Roman", serif' },
  verdana: { label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  mono: {
    label: "Monospace",
    stack: 'ui-monospace, "SFMono-Regular", Consolas, monospace',
  },
} as const;
export type Font = keyof typeof FONTS;
export interface ShortcutRow {
  source: "favorites" | "frequent" | "folder";
  folder: string;
  page: number;
}
export const DEFAULT_ROWS: ShortcutRow[] = [
  { source: "favorites", folder: "", page: 0 },
  { source: "frequent", folder: "", page: 0 },
];
export const hexColor = (value: unknown, fallback: string) =>
  typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
export function validRows(value: unknown): ShortcutRow[] {
  const rows = Array.isArray(value) ? value.slice(0, 3) : DEFAULT_ROWS;
  return rows.map((row, i) => {
    const fallback = DEFAULT_ROWS[i] ?? {
      source: "favorites",
      folder: "",
      page: i,
    };
    return row && ["favorites", "frequent", "folder"].includes(row.source)
      ? {
          source: row.source,
          folder: typeof row.folder === "string" ? row.folder.slice(0, 40) : "",
          page: Number.isInteger(row.page)
            ? Math.max(0, Math.min(99, row.page))
            : 0,
        }
      : { ...fallback };
  });
}
const rgb = (color: string) => {
  const expanded = /^#[0-9a-f]{3}$/i.test(color)
    ? "#" +
      color
        .slice(1)
        .split("")
        .map((c) => c + c)
        .join("")
    : color;
  return [1, 3, 5].map((i) => parseInt(expanded.slice(i, i + 2), 16));
};
export function luminance(color: string) {
  return rgb(color)
    .map((v) => {
      const s = v / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
}
export function contrast(a: string, b: string) {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
export function readableInk(color: string) {
  return contrast(color, "#111111") >= contrast(color, "#ffffff")
    ? "#111111"
    : "#ffffff";
}
/** Keep the selected hue, adjusting brightness only when it would hide controls. */
export function accessibleAccent(color: string, surface: string) {
  if (contrast(color, surface) >= 4.5) return color;
  const target = luminance(surface) > 0.3 ? 0 : 255,
    channels = rgb(color);
  for (let amount = 0.05; amount <= 1.01; amount += 0.05) {
    const candidate =
      "#" +
      channels
        .map((c) =>
          Math.round(c + (target - c) * Math.min(1, amount))
            .toString(16)
            .padStart(2, "0"),
        )
        .join("");
    if (contrast(candidate, surface) >= 4.5) return candidate;
  }
  return target === 0 ? "#000000" : "#ffffff";
}
export interface Shortcut {
  name: string;
  url: string;
}
export function safeSites(
  sites: { title?: string; name?: string; url: string }[],
): Shortcut[] {
  const seen = new Set<string>();
  return sites.flatMap((site) => {
    try {
      const url = new URL(site.url);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        seen.has(url.href)
      )
        return [];
      seen.add(url.href);
      return [
        {
          url: url.href,
          name: (site.name || site.title || url.hostname).slice(0, 80),
        },
      ];
    } catch {
      return [];
    }
  });
}
export function rowPage<T>(items: T[], page: number, minimumLast = 0) {
  const last = Math.max(minimumLast, Math.ceil(items.length / 5) - 1);
  const current = Math.min(last, Math.max(0, page));
  return { items: items.slice(current * 5, current * 5 + 5), current, last };
}
