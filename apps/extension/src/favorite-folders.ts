import type { Favorite, FavoriteFolder, Preferences } from "./storage";
import { safeSites } from "./personalization";

export const GOOGLE_FOLDER: FavoriteFolder = { id: "google", name: "Google" };
export const GOOGLE_FAVORITES: Favorite[] = [
  ["search", "Search", "https://www.google.com/"],
  ["gmail", "Gmail", "https://mail.google.com/"],
  ["drive", "Drive", "https://drive.google.com/"],
  ["calendar", "Calendar", "https://calendar.google.com/"],
  ["docs", "Docs", "https://docs.google.com/document/"],
  ["sheets", "Sheets", "https://docs.google.com/spreadsheets/"],
  ["maps", "Maps", "https://www.google.com/maps"],
  ["photos", "Photos", "https://photos.google.com/"],
  ["youtube", "YouTube", "https://www.youtube.com/"],
].map(([id, name, url]) => ({
  id: `google-${id}`,
  name,
  url,
  folder: "Google",
  folderId: "google",
}));

export type FavoriteTile =
  | { kind: "folder"; folder: FavoriteFolder }
  | { kind: "link"; favorite: Favorite };

export function mainFavoriteTiles(
  prefs: Pick<Preferences, "favorites" | "favoriteFolders">,
): FavoriteTile[] {
  const ids = new Set(prefs.favoriteFolders.map((folder) => folder.id));
  return [
    ...prefs.favoriteFolders.map((folder): FavoriteTile => ({
      kind: "folder",
      folder,
    })),
    ...prefs.favorites
      .filter((favorite) => !favorite.folderId || !ids.has(favorite.folderId))
      .filter((favorite) => safeSites([favorite]).length > 0)
      .map((favorite): FavoriteTile => ({ kind: "link", favorite })),
  ];
}

// Reserve the first cell on every folder page for returning to the main rows.
export function folderPage(favorites: Favorite[], page: number) {
  const links = favorites.filter(
    (favorite) => safeSites([favorite]).length > 0,
  );
  const last = Math.max(0, Math.ceil(links.length / 9) - 1);
  const current = Math.max(0, Math.min(page, last));
  return {
    current,
    last,
    items: links.slice(current * 9, current * 9 + 9),
  };
}

export function removeFavoriteFolder(
  prefs: Preferences,
  id: string,
): Partial<Preferences> {
  const folder = prefs.favoriteFolders.find((entry) => entry.id === id);
  return {
    favoriteFolders: prefs.favoriteFolders.filter((entry) => entry.id !== id),
    favorites: prefs.favorites.map((favorite) =>
      favorite.folderId === id
        ? { ...favorite, folderId: undefined, folder: "Favorites" }
        : favorite,
    ),
    shortcutRows: prefs.shortcutRows.map((row) =>
      row.source === "folder" && row.folder === folder?.name
        ? { source: "favorites", folder: "", page: 0 }
        : row,
    ) as Preferences["shortcutRows"],
  };
}
