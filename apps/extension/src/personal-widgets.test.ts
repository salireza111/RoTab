import { expect, it, vi, afterEach } from "vitest";
import { readPreferences } from "./storage";
import {
  MAX_TODOS,
  MAX_STROKES,
  MAX_POINTS,
  BOARD_HEIGHT,
  normalizeTodos,
  normalizeDoodle,
} from "./personal-widgets";
afterEach(() => vi.unstubAllGlobals());
it("keeps personal tools off for new and upgraded profiles without changing regular widgets", () => {
  for (const saved of [
    {},
    { widgets: ["weather", "calendar"], hiddenWidgets: ["weather"] },
  ]) {
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved) });
    const prefs = readPreferences();
    expect(prefs.personalWidgets).toEqual({
      todo: { enabled: false, side: "left" },
      doodle: { enabled: false, side: "right" },
    });
    expect(prefs.widgets).not.toContain("todo");
    expect(prefs.widgets).not.toContain("doodle");
  }
});
it("preserves left, middle and right placements and rejects unknown positions", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        personalWidgets: {
          todo: { enabled: true, side: "right" },
          doodle: { enabled: true, side: "middle" },
        },
      }),
  });
  expect(readPreferences().personalWidgets).toEqual({
    todo: { enabled: true, side: "right" },
    doodle: { enabled: true, side: "middle" },
  });
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        personalWidgets: {
          todo: { enabled: true, side: "floating" },
        },
      }),
  });
  expect(readPreferences().personalWidgets.todo.side).toBe("left");
});
it("bounds loaded tasks and drawings so corrupt or oversized records cannot grow the UI indefinitely", () => {
  const todos = normalizeTodos([
    null,
    { id: "duplicate", text: "  Prepare figures  ", done: true },
    { id: "duplicate", text: "Other" },
    ...Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      text: "x".repeat(500),
    })),
  ]);
  expect(todos).toHaveLength(MAX_TODOS);
  expect(todos[0]).toEqual({
    id: "duplicate",
    text: "Prepare figures",
    done: true,
  });
  expect(todos[1].text).toHaveLength(300);
  const board = normalizeDoodle({
    strokes: Array.from({ length: 300 }, (_, i) => ({
      id: String(i),
      color: "url(https://invalid)",
      points: [[NaN, 1], ...Array.from({ length: 700 }, () => [-5, 9999])],
    })),
    notes: [{ id: "note", text: "Idea", x: 900, y: -1 }],
  });
  expect(board.strokes).toHaveLength(MAX_STROKES);
  expect(board.strokes[0].points).toHaveLength(MAX_POINTS);
  expect(board.strokes[0]).toMatchObject({
    color: "ink",
    points: expect.arrayContaining([[0, BOARD_HEIGHT]]),
  });
  expect(board.notes[0]).toMatchObject({ x: 500, y: 0 });
});

it("retains a personal card's middle order and size without enabling it", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        widgets: ["weather", "todo", "calendar", "doodle"],
        wideWidgets: ["doodle"],
      }),
  });
  const prefs = readPreferences();
  expect(prefs.widgets.indexOf("todo")).toBeLessThan(
    prefs.widgets.indexOf("calendar"),
  );
  expect(prefs.wideWidgets).toContain("doodle");
  expect(prefs.personalWidgets.todo.enabled).toBe(false);
  expect(prefs.personalWidgets.doodle.enabled).toBe(false);
  // Old drawings use their original coordinates in the expanded, bounded sheet.
  expect(
    normalizeDoodle({
      strokes: [{ id: "old", color: "ink", points: [[120, 450]] }],
      notes: [{ id: "bottom", text: "End", x: 0, y: 99999 }],
    }),
  ).toMatchObject({
    strokes: [{ points: [[120, 450]] }],
    notes: [{ y: BOARD_HEIGHT - 180 }],
  });
});
