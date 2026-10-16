import {
  protocolSchema,
  type Protocol,
  type Checkpoint,
} from "@rosettatab/shared";
import {
  availableCores,
  defaultWorkerCount,
  validWorkerCount,
} from "./compute-settings";
import { DOCUMENTATION_FAVORITE, PERSONAL_FAVORITE } from "./bundled-sites";
import {
  defaultPersonalWidgets,
  normalizePersonalWidgets,
  type PersonalWidgetPreferences,
} from "./personal-widgets";
import { GOOGLE_FAVORITES, GOOGLE_FOLDER } from "./favorite-folders";
import {
  defaultCalendars,
  normalizeCalendars,
  type CalendarPreferences,
} from "./calendars";
import {
  emptyWeatherLocation,
  normalizeWeatherLocation,
  type WeatherLocation,
} from "./weather-location";
import {
  DEFAULT_ROWS,
  FONTS,
  hexColor,
  validRows,
  type Font,
  type ShortcutRow,
} from "./personalization";
export interface Favorite {
  id: string;
  name: string;
  url: string;
  folder: string;
  folderId?: string;
}
export interface FavoriteFolder {
  id: string;
  name: string;
}
export interface CalendarEvent {
  id: string;
  date: string;
  title: string;
}
export interface Preferences
  extends WeatherLocation, CalendarPreferences, PersonalWidgetPreferences {
  favorites: Favorite[];
  favoriteFolders: FavoriteFolder[];
  defaultFavoritesVersion: number;
  events: CalendarEvent[];
  widgets: string[];
  hiddenWidgets: string[];
  wideWidgets: string[];
  automatic: boolean;
  dutyCycle: number;
  workerCount: number;
  computeBudgetVersion: number;
  apiUrl: string;
  browserProtocol: Protocol;
  /** Preferred opening layout; each tab navigates independently. */
  view: "dashboard" | "home";
  dashboardFavoritesCollapsed: boolean;
  dashboardWidgetsCollapsed: boolean;
  theme: "dark" | "light" | "system";
  visualStyle: "observatory" | "doodle";
  doodleProtein: boolean;
  proteinAutoRotate: boolean;
  background: "plain" | "coast" | "dune" | "uploaded" | "custom";
  backgroundId?: string;
  font: Font;
  accentColor: string;
  /** Empty follows the accent; otherwise selections use their own color. */
  highlightColor: string;
  backgroundColor: string;
  backgroundEnd: string;
  gradient: boolean;
  gradientAngle: number;
  shortcutRows: ShortcutRow[];
  forecastDays: number;
  googleClientId: string;
  searchSuggestionsEnabled: boolean;
}
// The operator selects this when packaging; volunteers install only the extension.
const packagedApiUrl = import.meta.env.VITE_ROSETTATAB_API_URL || "";
const defaults: Preferences = {
  favorites: [
    {
      id: "pdb",
      name: "Protein Data Bank",
      url: "https://www.rcsb.org",
      folder: "Science",
    },
    {
      id: "rosetta",
      name: "Rosetta@home",
      url: "https://boinc.bakerlab.org/rosetta/",
      folder: "Science",
    },
    {
      ...DOCUMENTATION_FAVORITE,
      folder: "Reading",
    },
    { ...PERSONAL_FAVORITE },
    ...GOOGLE_FAVORITES,
  ],
  favoriteFolders: [{ ...GOOGLE_FOLDER }],
  defaultFavoritesVersion: 3,
  events: [],
  ...defaultCalendars,
  ...emptyWeatherLocation,
  ...defaultPersonalWidgets,
  widgets: [
    "weather",
    "work-queue",
    "calendar",
    "calendar-shamsi",
    "calendar-qamari",
    "contribution",
    "pomodoro",
  ],
  hiddenWidgets: [],
  wideWidgets: ["pomodoro"],
  automatic: false,
  dutyCycle: 10,
  workerCount: defaultWorkerCount(),
  computeBudgetVersion: 1,
  apiUrl: packagedApiUrl,
  browserProtocol: "relax",
  view: "home",
  dashboardFavoritesCollapsed: false,
  dashboardWidgetsCollapsed: false,
  theme: "light",
  visualStyle: "doodle",
  doodleProtein: false,
  proteinAutoRotate: true,
  background: "plain",
  font: "system",
  accentColor: "",
  highlightColor: "",
  backgroundColor: "#dce9df",
  backgroundEnd: "#c9c2e6",
  gradient: false,
  gradientAngle: 135,
  shortcutRows: DEFAULT_ROWS,
  forecastDays: 7,
  googleClientId: import.meta.env.VITE_GOOGLE_OAUTH_CLIENT_ID || "",
  searchSuggestionsEnabled: false,
};
export function readPreferences(): Preferences {
  try {
    const saved = JSON.parse(
      localStorage.getItem("rosettatab:preferences") ?? "{}",
    );
    // Migrate early two-mode prototypes without reconnecting a native host.
    delete saved.mode;
    // Older pilot builds silently required a server on the volunteer's machine.
    // Preserve an explicitly packaged operator build, but retire that old default.
    if (
      saved.apiUrl === "http://127.0.0.1:8787" &&
      packagedApiUrl !== saved.apiUrl
    )
      saved.apiUrl = packagedApiUrl;
    const protocol = protocolSchema.safeParse(saved.browserProtocol);
    saved.browserProtocol = protocol.success ? protocol.data : "relax";
    // Upgrade the old implicit half-core/25% profile once. Distinct custom
    // budgets remain intact; subsequent changes carry the version marker.
    if (
      saved.computeBudgetVersion !== 1 &&
      (saved.workerCount === undefined ||
        saved.workerCount === Math.max(1, Math.floor(availableCores() / 2))) &&
      (saved.dutyCycle === undefined || saved.dutyCycle === 25)
    ) {
      saved.workerCount = 1;
      saved.dutyCycle = 10;
    }
    saved.computeBudgetVersion = 1;
    saved.workerCount = validWorkerCount(saved.workerCount);
    saved.dutyCycle =
      typeof saved.dutyCycle === "number" && Number.isFinite(saved.dutyCycle)
        ? Math.max(10, Math.min(75, saved.dutyCycle))
        : defaults.dutyCycle;
    saved.view = ["home", "dashboard"].includes(saved.view)
      ? saved.view
      : defaults.view;
    saved.theme = ["dark", "light", "system"].includes(saved.theme)
      ? saved.theme
      : defaults.theme;
    saved.visualStyle = ["doodle", "observatory"].includes(saved.visualStyle)
      ? saved.visualStyle
      : defaults.visualStyle;
    saved.proteinAutoRotate =
      typeof saved.proteinAutoRotate === "boolean"
        ? saved.proteinAutoRotate
        : defaults.proteinAutoRotate;
    // Seed the new favorite once for existing profiles as well as fresh installs.
    // Subsequent removals/edits save this version, so they remain the user's choice.
    if (
      Array.isArray(saved.favorites) &&
      ![1, 2, 3].includes(saved.defaultFavoritesVersion)
    ) {
      const alreadyAdded = saved.favorites.some(
        (favorite: Favorite | null) =>
          typeof favorite?.url === "string" &&
          favorite.url.replace(/\/$/, "") ===
            PERSONAL_FAVORITE.url.replace(/\/$/, ""),
      );
      if (!alreadyAdded)
        saved.favorites = [...saved.favorites, { ...PERSONAL_FAVORITE }];
    }
    const existingFolders: FavoriteFolder[] = Array.isArray(
      saved.favoriteFolders,
    )
      ? saved.favoriteFolders.filter(
          (entry: FavoriteFolder | null) =>
            typeof entry?.id === "string" &&
            typeof entry.name === "string" &&
            entry.name.trim(),
        )
      : [];
    const folderIds = new Set<string>(),
      folderNames = new Set<string>();
    saved.favoriteFolders = existingFolders.flatMap((entry) => {
      const name = entry.name.trim().slice(0, 40),
        key = name.toLowerCase();
      if (folderIds.has(entry.id) || folderNames.has(key)) return [];
      folderIds.add(entry.id);
      folderNames.add(key);
      return [{ id: entry.id, name }];
    });
    if (![2, 3].includes(saved.defaultFavoritesVersion)) {
      const google = saved.favoriteFolders.find(
        (entry: FavoriteFolder) =>
          entry.id === GOOGLE_FOLDER.id ||
          entry.name.toLowerCase() === "google",
      );
      if (!google) saved.favoriteFolders.unshift({ ...GOOGLE_FOLDER });
      const destination = google ?? GOOGLE_FOLDER;
      const previous: Favorite[] = Array.isArray(saved.favorites)
        ? saved.favorites
        : defaults.favorites.filter((f) => !f.folderId);
      // Do not move a user's existing links into the bundled folder.
      const usedIds = new Set(previous.map((favorite) => favorite.id));
      saved.favorites = [
        ...previous,
        ...GOOGLE_FAVORITES.filter((favorite) => !usedIds.has(favorite.id)).map(
          (favorite) => ({
            ...favorite,
            folderId: destination.id,
            folder: destination.name,
          }),
        ),
      ];
    }
    if (saved.defaultFavoritesVersion !== 3 && Array.isArray(saved.favorites)) {
      saved.favorites = saved.favorites.map((favorite: Favorite) =>
        favorite.id === "nature" &&
        favorite.name === "Nature" &&
        /^https:\/\/(?:www\.)?nature\.com\/?$/.test(favorite.url)
          ? { ...favorite, ...DOCUMENTATION_FAVORITE }
          : favorite,
      );
    }
    saved.defaultFavoritesVersion = 3;
    saved.doodleProtein = saved.doodleProtein === true;
    saved.dashboardFavoritesCollapsed =
      saved.dashboardFavoritesCollapsed === true;
    saved.dashboardWidgetsCollapsed = saved.dashboardWidgetsCollapsed === true;
    delete saved.googleSuggestions;
    delete saved.searchProvider;
    saved.searchSuggestionsEnabled = saved.searchSuggestionsEnabled === true;
    saved.background = [
      "plain",
      "coast",
      "dune",
      "uploaded",
      "custom",
    ].includes(saved.background)
      ? saved.background
      : "plain";
    saved.font = Object.hasOwn(FONTS, saved.font) ? saved.font : "system";
    saved.accentColor = hexColor(saved.accentColor, "");
    saved.highlightColor = hexColor(saved.highlightColor, "");
    saved.backgroundColor = hexColor(
      saved.backgroundColor,
      defaults.backgroundColor,
    );
    saved.backgroundEnd = hexColor(saved.backgroundEnd, defaults.backgroundEnd);
    saved.gradient = saved.gradient === true;
    saved.gradientAngle = Number.isFinite(saved.gradientAngle)
      ? Math.max(0, Math.min(360, saved.gradientAngle))
      : 135;
    saved.shortcutRows = validRows(saved.shortcutRows);
    saved.forecastDays = [3, 5, 7, 10, 14].includes(saved.forecastDays)
      ? saved.forecastDays
      : 7;
    saved.googleClientId =
      typeof saved.googleClientId === "string"
        ? saved.googleClientId.slice(0, 200)
        : defaults.googleClientId;
    saved.personalWidgets = normalizePersonalWidgets(saved.personalWidgets);
    // Personal cards join the saved grid order only after the user moves one.
    const widgetIds = new Set([...defaults.widgets, "todo", "doodle"]);
    const previousOrder = Array.isArray(saved.widgets)
      ? [
          ...new Set<string>(
            saved.widgets.filter(
              (id: unknown) => typeof id === "string" && widgetIds.has(id),
            ),
          ),
        ]
      : [...defaults.widgets];
    // Add the new home-only timer without changing a user's existing order,
    // hidden cards or resize choices.
    const addedTimer = !previousOrder.includes("pomodoro");
    const addedQueue = !previousOrder.includes("work-queue");
    saved.widgets = [...previousOrder, ...(addedTimer ? ["pomodoro"] : [])];
    if (addedQueue)
      saved.widgets.splice(Math.min(1, saved.widgets.length), 0, "work-queue");
    for (const id of ["calendar-shamsi", "calendar-qamari"]) {
      if (!saved.widgets.includes(id)) {
        const previous =
          id === "calendar-shamsi" ? "calendar" : "calendar-shamsi";
        const index = saved.widgets.indexOf(previous);
        saved.widgets.splice(
          index < 0 ? saved.widgets.length : index + 1,
          0,
          id,
        );
      }
    }
    saved.hiddenWidgets = Array.isArray(saved.hiddenWidgets)
      ? saved.hiddenWidgets.filter(
          (id: unknown) => typeof id === "string" && widgetIds.has(id),
        )
      : [];
    saved.wideWidgets = Array.isArray(saved.wideWidgets)
      ? [
          ...new Set([
            ...saved.wideWidgets.filter(
              (id: unknown) => typeof id === "string" && widgetIds.has(id),
            ),
            ...(addedTimer ? ["pomodoro"] : []),
          ]),
        ]
      : [...defaults.wideWidgets];
    return {
      ...defaults,
      ...saved,
      ...normalizeCalendars(saved),
      ...normalizeWeatherLocation(saved),
    };
  } catch {
    return { ...structuredClone(defaults), workerCount: defaultWorkerCount() };
  }
}
export function savePreferences(next: Preferences) {
  localStorage.setItem("rosettatab:preferences", JSON.stringify(next));
  window.dispatchEvent(new Event("preferences"));
}
export function clientId() {
  let id = localStorage.getItem("rosettatab:client");
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem("rosettatab:client", id);
  }
  return id;
}
let dbPromise: Promise<IDBDatabase> | undefined;
function db() {
  return (dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("rosettatab", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("state");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
export async function getState<T>(key: string): Promise<T | undefined> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const req = database.transaction("state").objectStore("state").get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export async function putState(key: string, value: unknown) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction("state", "readwrite");
    if (value === undefined) tx.objectStore("state").delete(key);
    else tx.objectStore("state").put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
/** Read and mutate one local record atomically across tabs. */
export async function updateState<T>(
  key: string,
  update: (current: T | undefined) => T,
): Promise<T> {
  const database = await db();
  return new Promise((resolve, reject) => {
    const tx = database.transaction("state", "readwrite"),
      store = tx.objectStore("state"),
      read = store.get(key);
    let result: T, failure: unknown;
    read.onsuccess = () => {
      try {
        result = update(read.result);
        store.put(result, key);
      } catch (error) {
        failure = error;
        tx.abort();
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () =>
      reject(
        failure ?? tx.error ?? new Error("Local changes could not be saved."),
      );
  });
}
// Commit a finished browser calculation and clear its checkpoint atomically.
// Replaying a completion after a crash cannot create a second history entry.
export async function completeBrowserTask(checkpoint: Checkpoint) {
  const database = await db();
  return new Promise<void>((resolve, reject) => {
    const tx = database.transaction("state", "readwrite");
    const state = tx.objectStore("state");
    const request = state.get("browser-results");
    request.onsuccess = () => {
      const previous = (request.result ?? []) as Checkpoint[];
      state.put(
        [
          checkpoint,
          ...previous.filter((c) => c.task.id !== checkpoint.task.id),
        ].slice(0, 20),
        "browser-results",
      );
      state.delete("checkpoint");
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
