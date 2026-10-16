export const CALENDAR_SYSTEMS = ["gregorian", "shamsi", "qamari"] as const;
export type CalendarSystem = (typeof CALENDAR_SYSTEMS)[number];
export type QamariCalculation = "islamic-civil" | "islamic-umalqura";
export interface CalendarPreferences {
  calendarSystems: CalendarSystem[];
  calendarLayout: "combined" | "separate";
  calendarPrimary: CalendarSystem;
  qamariCalculation: QamariCalculation;
}
export const CALENDAR_NAMES: Record<CalendarSystem, string> = {
  gregorian: "Gregorian",
  shamsi: "Shamsi",
  qamari: "Qamari",
};
export const defaultCalendars: CalendarPreferences = {
  calendarSystems: ["gregorian"],
  calendarLayout: "combined",
  calendarPrimary: "gregorian",
  qamariCalculation: "islamic-civil",
};
export function normalizeCalendars(
  saved: Partial<Record<keyof CalendarPreferences, unknown>>,
): CalendarPreferences {
  const systems = CALENDAR_SYSTEMS.filter(
    (system) =>
      Array.isArray(saved.calendarSystems) &&
      saved.calendarSystems.includes(system),
  );
  if (!systems.length) systems.push("gregorian");
  return {
    calendarSystems: systems,
    calendarLayout:
      saved.calendarLayout === "separate" ? "separate" : "combined",
    calendarPrimary: systems.includes(saved.calendarPrimary as CalendarSystem)
      ? (saved.calendarPrimary as CalendarSystem)
      : systems[0],
    qamariCalculation:
      saved.qamariCalculation === "islamic-umalqura"
        ? "islamic-umalqura"
        : "islamic-civil",
  };
}
export const CALENDAR_WIDGETS: Record<CalendarSystem, string> = {
  gregorian: "calendar",
  shamsi: "calendar-shamsi",
  qamari: "calendar-qamari",
};
export function activeCalendarWidgets(prefs: CalendarPreferences): string[] {
  return prefs.calendarLayout === "combined"
    ? ["calendar"]
    : prefs.calendarSystems.map((system) => CALENDAR_WIDGETS[system]);
}
export const calendarDateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

// Calendar arithmetic uses local civil days at noon, including across DST.
export function addCalendarDays(date: Date, days: number): Date {
  const next = new Date(
    date.getFullYear(),
    date.getMonth(),
    date.getDate(),
    12,
  );
  next.setDate(next.getDate() + days);
  return next;
}
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(
  system: CalendarSystem,
  calculation: QamariCalculation,
  style: "parts" | "month" | "date",
) {
  const key = `${system}:${calculation}:${style}`;
  let format = formatters.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en", {
      calendar:
        system === "gregorian"
          ? "gregory"
          : system === "shamsi"
            ? "persian"
            : calculation,
      numberingSystem: "latn",
      year: "numeric",
      month: style === "parts" ? "numeric" : "long",
      ...(style !== "month" ? { day: "numeric" as const } : {}),
    });
    formatters.set(key, format);
  }
  return format;
}
export function calendarParts(
  date: Date,
  system: CalendarSystem,
  calculation: QamariCalculation = "islamic-civil",
) {
  const parts = formatter(system, calculation, "parts").formatToParts(date);
  const number = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((part) => part.type === type)?.value);
  return { year: number("year"), month: number("month"), day: number("day") };
}
export function calendarLabel(
  date: Date,
  system: CalendarSystem,
  calculation: QamariCalculation = "islamic-civil",
  style: "month" | "date" = "date",
) {
  // The calendar name is displayed separately, so omit the redundant era suffix.
  return formatter(system, calculation, style)
    .formatToParts(date)
    .filter((part) => part.type !== "era")
    .map((part) => part.value)
    .join("")
    .trim();
}
export function calendarMonth(
  anchor: Date,
  system: CalendarSystem,
  calculation: QamariCalculation = "islamic-civil",
) {
  const first = addCalendarDays(
    anchor,
    1 - calendarParts(anchor, system, calculation).day,
  );
  const following = addCalendarDays(first, 32);
  const end = addCalendarDays(
    following,
    1 - calendarParts(following, system, calculation).day,
  );
  const days: Date[] = [];
  for (let day = first; day < end; day = addCalendarDays(day, 1))
    days.push(day);
  const weekStart = system === "gregorian" ? 1 : 6;
  return {
    first,
    end,
    days,
    offset: (first.getDay() - weekStart + 7) % 7,
    weekStart,
  };
}
export function shiftCalendarMonth(
  anchor: Date,
  direction: -1 | 1,
  system: CalendarSystem,
  calculation: QamariCalculation = "islamic-civil",
) {
  const range = calendarMonth(anchor, system, calculation);
  return direction === 1
    ? range.end
    : calendarMonth(addCalendarDays(range.first, -1), system, calculation)
        .first;
}
