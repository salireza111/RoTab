import { describe, expect, it } from "vitest";
import {
  activeCalendarWidgets,
  addCalendarDays,
  calendarDateKey,
  calendarMonth,
  calendarParts,
  normalizeCalendars,
  shiftCalendarMonth,
  type CalendarSystem,
} from "./calendars";

const date = (iso: string) => new Date(`${iso}T12:00:00`);
describe("native calendar months", () => {
  it("crosses Nowruz with the correct leap Esfand and keeps the civil event day", () => {
    expect(calendarParts(date("2025-03-20"), "shamsi")).toEqual({
      year: 1403,
      month: 12,
      day: 30,
    });
    expect(calendarParts(date("2025-03-21"), "shamsi")).toEqual({
      year: 1404,
      month: 1,
      day: 1,
    });
    const esfand = calendarMonth(date("2025-03-20"), "shamsi");
    expect(esfand.days).toHaveLength(30);
    expect(calendarDateKey(esfand.end)).toBe("2025-03-21");
    expect(calendarDateKey(shiftCalendarMonth(esfand.first, 1, "shamsi"))).toBe(
      "2025-03-21",
    );
    expect(calendarDateKey(shiftCalendarMonth(esfand.end, -1, "shamsi"))).toBe(
      calendarDateKey(esfand.first),
    );
  });
  it("uses the chosen Qamari convention and supports 29- and 30-day months", () => {
    expect(
      calendarParts(date("2026-10-11"), "qamari", "islamic-civil"),
    ).toEqual({ year: 1448, month: 4, day: 28 });
    expect(
      calendarParts(date("2026-10-11"), "qamari", "islamic-umalqura"),
    ).toEqual({ year: 1448, month: 4, day: 30 });
    const range = calendarMonth(date("2026-10-11"), "qamari", "islamic-civil");
    expect(range.days).toHaveLength(29);
    expect(
      calendarMonth(range.end, "qamari", "islamic-civil").days,
    ).toHaveLength(30);
  });
  it("enumerates consecutive local days across DST and leap days without gaps", () => {
    expect(calendarMonth(date("2024-02-15"), "gregorian").days).toHaveLength(
      29,
    );
    expect(calendarDateKey(addCalendarDays(date("2026-03-28"), 1))).toBe(
      "2026-03-29",
    );
    expect(calendarDateKey(addCalendarDays(date("2026-10-25"), 1))).toBe(
      "2026-10-26",
    );
    for (const system of [
      "gregorian",
      "shamsi",
      "qamari",
    ] as CalendarSystem[]) {
      for (let month = 0; month < 12; month++) {
        const range = calendarMonth(new Date(2026, month, 15, 12), system);
        expect(range.days.length).toBeGreaterThanOrEqual(28);
        expect(range.days.length).toBeLessThanOrEqual(31);
        expect(new Set(range.days.map(calendarDateKey)).size).toBe(
          range.days.length,
        );
        expect(range.days.map((day) => calendarParts(day, system).day)).toEqual(
          range.days.map((_, i) => i + 1),
        );
        expect(calendarParts(range.end, system).day).toBe(1);
        expect(calendarDateKey(shiftCalendarMonth(range.end, -1, system))).toBe(
          calendarDateKey(range.first),
        );
      }
    }
  });
});
it("normalizes saved calendars and exposes only the chosen widget layout", () => {
  expect(
    normalizeCalendars({
      calendarSystems: [],
      calendarPrimary: "bad",
      calendarLayout: "bad",
    }),
  ).toEqual({
    calendarSystems: ["gregorian"],
    calendarPrimary: "gregorian",
    calendarLayout: "combined",
    qamariCalculation: "islamic-civil",
  });
  const prefs = normalizeCalendars({
    calendarSystems: ["shamsi", "unknown", "shamsi", "qamari"],
    calendarPrimary: "gregorian",
    calendarLayout: "separate",
  });
  expect(prefs.calendarSystems).toEqual(["shamsi", "qamari"]);
  expect(prefs.calendarPrimary).toBe("shamsi");
  expect(activeCalendarWidgets(prefs)).toEqual([
    "calendar-shamsi",
    "calendar-qamari",
  ]);
  expect(
    activeCalendarWidgets({ ...prefs, calendarLayout: "combined" }),
  ).toEqual(["calendar"]);
});
