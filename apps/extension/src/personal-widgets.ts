export type PersonalWidgetId = "todo" | "doodle";
export type WidgetSide = "left" | "middle" | "right";
export const PERSONAL_WIDGET_IDS: PersonalWidgetId[] = ["todo", "doodle"];
export interface PersonalWidgetPreferences {
  personalWidgets: Record<
    PersonalWidgetId,
    { enabled: boolean; side: WidgetSide }
  >;
}
export const defaultPersonalWidgets: PersonalWidgetPreferences = {
  personalWidgets: {
    todo: { enabled: false, side: "left" },
    doodle: { enabled: false, side: "right" },
  },
};
export function normalizePersonalWidgets(
  raw: unknown,
): PersonalWidgetPreferences["personalWidgets"] {
  const saved =
    raw && typeof raw === "object" ? (raw as Record<string, any>) : {};
  return Object.fromEntries(
    (
      Object.keys(defaultPersonalWidgets.personalWidgets) as PersonalWidgetId[]
    ).map((id) => [
      id,
      {
        enabled: saved[id]?.enabled === true,
        side: ["left", "middle", "right"].includes(saved[id]?.side)
          ? saved[id].side
          : defaultPersonalWidgets.personalWidgets[id].side,
      },
    ]),
  ) as PersonalWidgetPreferences["personalWidgets"];
}

export interface TodoItem {
  id: string;
  text: string;
  done: boolean;
}
export const MAX_TODOS = 200;
export function normalizeTodos(raw: unknown): TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw
    .filter((item) => {
      if (
        !item ||
        typeof item.id !== "string" ||
        item.id.length > 64 ||
        seen.has(item.id) ||
        typeof item.text !== "string" ||
        !item.text.trim()
      )
        return false;
      seen.add(item.id);
      return true;
    })
    .slice(0, MAX_TODOS)
    .map((item) => ({
      id: item.id,
      text: item.text.trim().slice(0, 300),
      done: item.done === true,
    }));
}
export const BOARD_WIDTH = 800,
  // A scrollable sheet keeps the same drawing scale in short cards and tall rails.
  // Existing 800 × 600 drawings retain their coordinates at the top of the sheet.
  BOARD_HEIGHT = 1800,
  NOTE_WIDTH = 300,
  NOTE_HEIGHT = 180,
  MAX_STROKES = 150,
  MAX_POINTS = 512,
  MAX_NOTES = 30;
export const PEN_COLORS = [
  "ink",
  "#d95050",
  "#3579ca",
  "#2f9868",
  "#a168c7",
] as const;
export interface BoardStroke {
  id: string;
  color: string;
  points: [number, number][];
}
export interface BoardNote {
  id: string;
  text: string;
  x: number;
  y: number;
}
export interface DoodleData {
  strokes: BoardStroke[];
  notes: BoardNote[];
}
export const emptyDoodle: DoodleData = { strokes: [], notes: [] };
export function normalizeDoodle(raw: unknown): DoodleData {
  const value =
    raw && typeof raw === "object" ? (raw as Partial<DoodleData>) : {};
  const seen = new Set<string>();
  const validId = (id: unknown) => {
    if (typeof id !== "string" || !id || id.length > 64 || seen.has(id))
      return false;
    seen.add(id);
    return true;
  };
  return {
    strokes: (Array.isArray(value.strokes) ? value.strokes : [])
      .filter((s) => s && validId(s.id) && Array.isArray(s.points))
      .slice(0, MAX_STROKES)
      .map((s) => ({
        id: s.id,
        color: PEN_COLORS.includes(s.color as any) ? s.color : "ink",
        points: s.points
          .filter(
            (p) =>
              Array.isArray(p) && p.length === 2 && p.every(Number.isFinite),
          )
          .slice(0, MAX_POINTS)
          .map(
            ([x, y]) =>
              [
                Math.max(0, Math.min(BOARD_WIDTH, x)),
                Math.max(0, Math.min(BOARD_HEIGHT, y)),
              ] as [number, number],
          ),
      }))
      .filter((s) => s.points.length > 0),
    notes: (Array.isArray(value.notes) ? value.notes : [])
      .filter(
        (n) =>
          n &&
          validId(n.id) &&
          typeof n.text === "string" &&
          Number.isFinite(n.x) &&
          Number.isFinite(n.y),
      )
      .slice(0, MAX_NOTES)
      .map((n) => ({
        id: n.id,
        text: n.text.slice(0, 300),
        x: Math.max(0, Math.min(BOARD_WIDTH - NOTE_WIDTH, n.x)),
        y: Math.max(0, Math.min(BOARD_HEIGHT - NOTE_HEIGHT, n.y)),
      })),
  };
}
