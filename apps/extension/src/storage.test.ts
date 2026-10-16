import { afterEach, expect, it, vi } from "vitest";
import { readPreferences } from "./storage";
afterEach(() => vi.unstubAllGlobals());

it("replaces the untouched Nature shortcut in place while preserving user folders and removals", () => {
  let saved: Record<string, unknown> = {
    defaultFavoritesVersion: 2,
    favoriteFolders: [],
    favorites: [
      {
        id: "before",
        name: "Before",
        url: "https://example.org",
        folder: "Reading",
      },
      {
        id: "nature",
        name: "Nature",
        url: "https://www.nature.com",
        folder: "Research",
        folderId: "research",
      },
      {
        id: "after",
        name: "After",
        url: "https://example.net",
        folder: "Reading",
      },
    ],
  };
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved) });
  const migrated = readPreferences();
  expect(migrated.favorites.map((f) => f.id)).toEqual([
    "before",
    "rotab-docs",
    "after",
  ]);
  expect(migrated.favorites[1]).toEqual({
    id: "rotab-docs",
    name: "About RoTab",
    url: "https://salireza111.github.io/RoTab_Doc/",
    folder: "Research",
    folderId: "research",
  });
  expect(migrated.favoriteFolders).toEqual([]);
  expect(migrated.favorites.some((f) => f.id === "alireza")).toBe(false);
  saved = {
    ...migrated,
    favorites: migrated.favorites.filter((f) => f.id !== "rotab-docs"),
  };
  expect(readPreferences().favorites.map((f) => f.id)).toEqual([
    "before",
    "after",
  ]);
});

it("keeps edited or removed Nature shortcuts and supplies documentation on fresh installs", () => {
  let saved: Record<string, unknown> | null = null;
  vi.stubGlobal("localStorage", {
    getItem: () => (saved === null ? null : JSON.stringify(saved)),
  });
  expect(
    readPreferences().favorites.find((f) => f.id === "rotab-docs")?.name,
  ).toBe("About RoTab");
  const edited = {
    id: "nature",
    name: "My journal",
    url: "https://www.nature.com",
    folder: "Journals",
  };
  saved = {
    defaultFavoritesVersion: 2,
    favorites: [edited],
    favoriteFolders: [],
  };
  expect(readPreferences().favorites).toEqual([edited]);
  saved = { defaultFavoritesVersion: 2, favorites: [], favoriteFolders: [] };
  expect(readPreferences().favorites).toEqual([]);
});

it("preserves independent highlight preferences and safely migrates older accent choices", () => {
  let saved: Record<string, unknown> = { accentColor: "#ff0000" };
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved) });
  expect(readPreferences()).toMatchObject({
    accentColor: "#ff0000",
    highlightColor: "",
  });
  saved = { ...saved, highlightColor: "#3366cc" };
  expect(readPreferences()).toMatchObject({
    accentColor: "#ff0000",
    highlightColor: "#3366cc",
  });
  saved = { ...saved, highlightColor: "url(https://tracker.invalid)" };
  expect(readPreferences()).toMatchObject({
    accentColor: "#ff0000",
    highlightColor: "",
  });
});

it("migrates separate calendar widgets without changing existing order or hidden choices", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        widgets: [
          "pomodoro",
          "calendar",
          "weather",
          "work-queue",
          "contribution",
        ],
        hiddenWidgets: ["weather"],
        wideWidgets: ["calendar"],
        calendarSystems: ["shamsi", "qamari"],
        calendarLayout: "separate",
        calendarPrimary: "shamsi",
      }),
  });
  const prefs = readPreferences();
  expect(prefs.widgets).toEqual([
    "pomodoro",
    "calendar",
    "calendar-shamsi",
    "calendar-qamari",
    "weather",
    "work-queue",
    "contribution",
  ]);
  expect(prefs.hiddenWidgets).toEqual(["weather"]);
  expect(prefs.wideWidgets).toEqual(["calendar"]);
  expect(prefs.calendarSystems).toEqual(["shamsi", "qamari"]);
  expect(prefs.calendarLayout).toBe("separate");
});

it("migrates the old implicit local-server dependency while retaining personal settings", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        apiUrl: "http://127.0.0.1:8787",
        city: "Geneva",
        automatic: false,
      }),
  });
  expect(readPreferences()).toMatchObject({
    apiUrl: "",
    city: "Geneva",
    automatic: false,
    browserProtocol: "relax",
  });
});
it("preserves an explicitly selected hosted research service", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        apiUrl: "https://research.example.org",
        browserProtocol: "cartesian_relax",
      }),
  });
  expect(readPreferences()).toMatchObject({
    apiUrl: "https://research.example.org",
    browserProtocol: "cartesian_relax",
  });
});
it("retains a chosen home view and appearance while normalizing invalid values", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        view: "home",
        theme: "light",
        background: "uploaded",
        backgroundId: "local-image",
      }),
  });
  expect(readPreferences()).toMatchObject({
    view: "home",
    theme: "light",
    background: "uploaded",
    backgroundId: "local-image",
  });
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        view: "unknown",
        theme: "bright",
        background: "https://tracking.example",
      }),
  });
  expect(readPreferences()).toMatchObject({
    view: "home",
    theme: "light",
    visualStyle: "doodle",
    proteinAutoRotate: true,
    background: "plain",
  });
});

it("uses white Doodle for fresh installs and preserves saved appearance choices", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  expect(readPreferences()).toMatchObject({
    view: "home",
    theme: "light",
    visualStyle: "doodle",
    proteinAutoRotate: true,
  });
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        view: "dashboard",
        theme: "dark",
        visualStyle: "observatory",
        proteinAutoRotate: false,
      }),
  });
  expect(readPreferences()).toMatchObject({
    view: "dashboard",
    theme: "dark",
    visualStyle: "observatory",
    proteinAutoRotate: false,
  });
});

it("adds the personal website once without duplicating it or restoring a deleted favorite", () => {
  let saved = {
    favorites: [
      {
        id: "custom",
        name: "Custom",
        url: "https://example.org",
        folder: "Favorites",
      },
    ],
  };
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved) });
  const migrated = readPreferences();
  expect(
    migrated.favorites
      .filter((favorite) => !favorite.folderId)
      .map((favorite) => favorite.url),
  ).toEqual(["https://example.org", "https://salireza111.github.io/"]);
  saved = {
    ...migrated,
    favorites: migrated.favorites.filter(
      (favorite) => favorite.id !== "alireza",
    ),
  };
  expect(
    readPreferences()
      .favorites.filter((favorite) => !favorite.folderId)
      .map((favorite) => favorite.url),
  ).toEqual(["https://example.org"]);
  saved = {
    favorites: [
      {
        id: "own",
        name: "My site",
        url: "https://salireza111.github.io",
        folder: "Personal",
      },
    ],
  };
  expect(
    readPreferences().favorites.filter((favorite) => !favorite.folderId),
  ).toEqual(saved.favorites);
});

it("seeds Google once, preserves a v1 website removal, and respects folder deletions", () => {
  let saved: Record<string, unknown> = {
    defaultFavoritesVersion: 1,
    favorites: [
      { id: "own", name: "Own", url: "https://example.org", folder: "Reading" },
    ],
    shortcutRows: [
      { source: "frequent", folder: "", page: 0 },
      { source: "frequent", folder: "", page: 1 },
    ],
  };
  vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(saved) });
  const migrated = readPreferences();
  expect(migrated.favoriteFolders).toEqual([{ id: "google", name: "Google" }]);
  expect(
    migrated.favorites.filter((favorite) => favorite.folderId === "google"),
  ).toHaveLength(9);
  expect(migrated.favorites.some((favorite) => favorite.id === "alireza")).toBe(
    false,
  );
  expect(migrated.shortcutRows).toEqual(saved.shortcutRows);
  saved = { ...migrated };
  expect(readPreferences().favorites).toHaveLength(10);
  saved = {
    ...migrated,
    favoriteFolders: [],
    favorites: migrated.favorites.filter((favorite) => !favorite.folderId),
  };
  expect(readPreferences().favoriteFolders).toEqual([]);
  expect(readPreferences().favorites).toHaveLength(1);
});

it("adds the home timer to saved widget orders once and retains user layout choices", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        widgets: ["calendar", "weather", "contribution"],
        hiddenWidgets: ["calendar"],
        wideWidgets: ["weather"],
      }),
  });
  expect(readPreferences()).toMatchObject({
    widgets: [
      "calendar",
      "calendar-shamsi",
      "calendar-qamari",
      "work-queue",
      "weather",
      "contribution",
      "pomodoro",
    ],
    hiddenWidgets: ["calendar"],
    wideWidgets: ["weather", "pomodoro"],
  });
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        widgets: ["pomodoro", "calendar", "weather", "contribution"],
        hiddenWidgets: ["pomodoro"],
        wideWidgets: [],
      }),
  });
  expect(readPreferences()).toMatchObject({
    widgets: [
      "pomodoro",
      "work-queue",
      "calendar",
      "calendar-shamsi",
      "calendar-qamari",
      "weather",
      "contribution",
    ],
    hiddenWidgets: ["pomodoro"],
    wideWidgets: [],
  });
});
