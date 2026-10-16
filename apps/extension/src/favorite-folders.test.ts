import { expect, it, vi, afterEach } from "vitest";
import {
  folderPage,
  mainFavoriteTiles,
  removeFavoriteFolder,
} from "./favorite-folders";
import { readPreferences } from "./storage";
import { rowPage } from "./personalization";
afterEach(() => vi.unstubAllGlobals());

it("ships five main tiles with Google first, the personal site last and nine folder links", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  const prefs = readPreferences(),
    tiles = mainFavoriteTiles(prefs);
  expect(
    tiles.map((tile) =>
      tile.kind === "folder" ? tile.folder.name : tile.favorite.name,
    ),
  ).toEqual([
    "Google",
    "Protein Data Bank",
    "Rosetta@home",
    "About RoTab",
    "Alireza Hashemi",
  ]);
  expect(
    prefs.favorites.filter((favorite) => favorite.folderId === "google"),
  ).toHaveLength(9);
  expect(rowPage(tiles, 1, 1).items).toEqual([]);
});

it("pages folder links in nines, including every link while reserving a Back cell", () => {
  const favorites = Array.from({ length: 23 }, (_, i) => ({
    id: String(i),
    name: String(i),
    url: `https://example.org/${i}`,
    folder: "Test",
  }));
  expect(
    [0, 1, 2].flatMap((page) =>
      folderPage(favorites, page).items.map((favorite) => favorite.id),
    ),
  ).toEqual(favorites.map((favorite) => favorite.id));
  expect(folderPage(favorites, 99)).toMatchObject({ current: 2, last: 2 });
  expect(folderPage([], 3)).toEqual({ current: 0, last: 0, items: [] });
});

it("removing a folder keeps its links, preserves other folders and repairs a linked row", () => {
  vi.stubGlobal("localStorage", { getItem: () => null });
  const prefs = readPreferences();
  prefs.favoriteFolders.push({ id: "own", name: "Own" });
  prefs.shortcutRows[1] = { source: "folder", folder: "Google", page: 0 };
  const patch = removeFavoriteFolder(prefs, "google");
  expect(patch.favoriteFolders).toEqual([{ id: "own", name: "Own" }]);
  expect(patch.favorites).toHaveLength(prefs.favorites.length);
  expect(
    patch.favorites?.some((favorite) => favorite.folderId === "google"),
  ).toBe(false);
  expect(patch.shortcutRows?.[1]).toEqual({
    source: "favorites",
    folder: "",
    page: 0,
  });
});

it("keeps unsafe saved links out of both main and folder tiles", () => {
  const favorites = [
    "javascript:alert(1)",
    "https://user:secret@example.org/",
    "https://example.org/",
  ].map((url, i) => ({
    id: String(i),
    name: String(i),
    url,
    folder: "Favorites",
  }));
  expect(mainFavoriteTiles({ favoriteFolders: [], favorites })).toHaveLength(1);
  expect(folderPage(favorites, 0).items).toHaveLength(1);
});
