import { expect, it } from "vitest";
import {
  accessibleAccent,
  contrast,
  hexColor,
  readableInk,
  rowPage,
  safeSites,
  validRows,
} from "./personalization";
it("keeps calendar/control ink readable with extreme custom accents in both visual styles", () => {
  for (const surface of ["#fff", "#101010", "#fdfdf7", "#182220"])
    for (const color of [
      "#ffffff",
      "#000000",
      "#ffff00",
      "#ff00ff",
      "#00ff00",
      "#316b51",
      "#a7d9bd",
      "#ff0000",
      "#1b2e42",
    ]) {
      const accent = accessibleAccent(color, surface);
      expect(contrast(accent, surface)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(accent, readableInk(accent))).toBeGreaterThanOrEqual(4.5);
    }
});
it("rejects executable CSS and bounds persisted layout values", () => {
  expect(hexColor("url(https://tracker.invalid)", "#ffffff")).toBe("#ffffff");
  expect(
    validRows([
      { source: "frequent", page: 999, folder: "" },
      { source: "bad" },
      { source: "frequent" },
    ]),
  ).toEqual([
    { source: "frequent", page: 99, folder: "" },
    { source: "frequent", folder: "", page: 0 },
    { source: "frequent", folder: "", page: 0 },
  ]);
});
it("keeps positions 1–5 and 6–10 distinct and filters unsafe shortcut destinations", () => {
  const items = Array.from({ length: 12 }, (_, i) => ({
    title: `Page ${i + 1}`,
    url: `https://example.org/${i + 1}`,
  }));
  const sites = safeSites([
    ...items,
    { url: "javascript:alert(1)" },
    { url: "chrome://extensions" },
    { url: "https://user:secret@example.org/" },
    items[0],
  ]);
  expect(sites).toHaveLength(12);
  expect(rowPage(sites, 0).items.map((x) => x.name)).toEqual([
    "Page 1",
    "Page 2",
    "Page 3",
    "Page 4",
    "Page 5",
  ]);
  expect(rowPage(sites, 1).items.map((x) => x.name)).toEqual([
    "Page 6",
    "Page 7",
    "Page 8",
    "Page 9",
    "Page 10",
  ]);
  expect(rowPage(sites, 99).items.map((x) => x.name)).toEqual([
    "Page 11",
    "Page 12",
  ]);
});

it("preserves an intentionally empty row list and limits rows to three", () => {
  expect(validRows([])).toEqual([]);
  expect(validRows(undefined)).toHaveLength(2);
  expect(validRows([{ source: "favorites" }])).toHaveLength(1);
  expect(validRows(Array(5).fill({ source: "frequent" }))).toHaveLength(3);
});
