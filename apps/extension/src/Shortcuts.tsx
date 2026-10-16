import { useEffect, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Plus,
  SlidersHorizontal,
  X,
  ArrowLeft,
  Folder,
  FolderPlus,
  Pencil,
  Trash2,
  ArrowUp,
  ArrowDown,
  History,
} from "lucide-react";
import { Modal } from "./Modal";
import { SiteIcon } from "./SiteIcon";
import type { Preferences } from "./storage";
import {
  DEFAULT_ROWS,
  rowPage,
  safeSites,
  type Shortcut,
} from "./personalization";
import {
  folderPage,
  mainFavoriteTiles,
  removeFavoriteFolder,
} from "./favorite-folders";

export function Shortcuts({
  prefs,
  change,
  add,
  edit,
}: {
  prefs: Preferences;
  change(p: Partial<Preferences>): void;
  add(folder?: string): void;
  edit(id: string): void;
}) {
  const [editing, setEditing] = useState(false),
    [sites, setSites] = useState<Shortcut[]>([]),
    [needsSiteAccess, setNeedsSiteAccess] = useState(false),
    [error, setError] = useState("");
  const [openFolderId, setOpenFolderId] = useState<string>(),
    [folderOffset, setFolderOffset] = useState(0),
    [folderDialog, setFolderDialog] = useState<"create" | "edit">(),
    [folderName, setFolderName] = useState(""),
    [folderError, setFolderError] = useState(""),
    [existingLink, setExistingLink] = useState("");
  const openFolder = prefs.favoriteFolders.find(
    (folder) => folder.id === openFolderId,
  );
  const members = prefs.favorites.filter(
    (favorite) => favorite.folderId === openFolder?.id && openFolder,
  );
  const folderView = folderPage(members, folderOffset);
  const roots = mainFavoriteTiles(prefs);
  const groupNames = [
    ...new Set([
      ...prefs.favoriteFolders.map((folder) => folder.name),
      ...prefs.favorites.map((favorite) => favorite.folder),
    ]),
  ];
  const openFolderEditor = (mode: "create" | "edit") => {
    setFolderName(mode === "edit" ? (openFolder?.name ?? "") : "");
    setFolderError("");
    setExistingLink("");
    setFolderDialog(mode);
  };
  const saveFolder = (event: React.FormEvent) => {
    event.preventDefault();
    const name = folderName.trim();
    if (!name) {
      setFolderError("Enter a folder name.");
      return;
    }
    if (name.toLowerCase() === "favorites") {
      setFolderError("Favorites is the main list. Choose another folder name.");
      return;
    }
    if (
      prefs.favoriteFolders.some(
        (folder) =>
          folder.name.toLowerCase() === name.toLowerCase() &&
          (folderDialog === "create" || folder.id !== openFolder?.id),
      )
    ) {
      setFolderError("A folder with this name already exists.");
      return;
    }
    if (folderDialog === "edit" && openFolder) {
      if (
        groupNames.some(
          (group) =>
            group.toLowerCase() === name.toLowerCase() &&
            group !== openFolder.name,
        )
      ) {
        setFolderError("This name is already used by a favorite group.");
        return;
      }
      change({
        favoriteFolders: prefs.favoriteFolders.map((folder) =>
          folder.id === openFolder.id ? { ...folder, name } : folder,
        ),
        favorites: prefs.favorites.map((favorite) =>
          favorite.folderId === openFolder.id
            ? { ...favorite, folder: name }
            : favorite,
        ),
        shortcutRows: prefs.shortcutRows.map((row) =>
          row.source === "folder" && row.folder === openFolder.name
            ? { ...row, folder: name }
            : row,
        ) as Preferences["shortcutRows"],
      });
    } else {
      const id = crypto.randomUUID();
      change({
        favoriteFolders: [...prefs.favoriteFolders, { id, name }],
        favorites: prefs.favorites.map((favorite) =>
          !favorite.folderId &&
          favorite.folder.toLowerCase() === name.toLowerCase()
            ? { ...favorite, folderId: id, folder: name }
            : favorite,
        ),
      });
      setOpenFolderId(id);
      setFolderOffset(0);
    }
    setFolderDialog(undefined);
  };
  const reorderMember = (id: string, direction: number) => {
    const i = members.findIndex((favorite) => favorite.id === id),
      other = members[i + direction];
    if (!other) return;
    const favorites = [...prefs.favorites],
      a = favorites.findIndex((favorite) => favorite.id === id),
      b = favorites.findIndex((favorite) => favorite.id === other.id);
    [favorites[a], favorites[b]] = [favorites[b], favorites[a]];
    change({ favorites });
  };
  const needsSites = prefs.shortcutRows.some((r) => r.source === "frequent");
  useEffect(() => {
    let active = true;
    const load = async () => {
      if (!needsSites) return;
      if (typeof chrome === "undefined" || !chrome.permissions) {
        if (active) {
          setSites([]);
          setNeedsSiteAccess(false);
          setError("");
        }
        return;
      }
      if (!(await chrome.permissions.contains({ permissions: ["topSites"] }))) {
        if (active) {
          setSites([]);
          setNeedsSiteAccess(true);
          setError("");
        }
        return;
      }
      if (!chrome.topSites) {
        if (active) {
          setSites([]);
          setNeedsSiteAccess(false);
          setError("Most-visited sites are unavailable.");
        }
        return;
      }
      const result = await chrome.topSites.get();
      if (active) {
        setSites(safeSites(result));
        setNeedsSiteAccess(false);
        setError("");
      }
    };
    void load().catch(() => {
      if (active) setError("Most-visited sites are unavailable.");
    });
    const permissionChanged = () => void load().catch(() => {});
    const focus = () => permissionChanged();
    if (typeof chrome !== "undefined") {
      chrome.permissions?.onRemoved?.addListener(permissionChanged);
      chrome.permissions?.onAdded?.addListener(permissionChanged);
    }
    window.addEventListener("focus", focus);
    return () => {
      active = false;
      if (typeof chrome !== "undefined") {
        chrome.permissions?.onRemoved?.removeListener(permissionChanged);
        chrome.permissions?.onAdded?.removeListener(permissionChanged);
      }
      window.removeEventListener("focus", focus);
    };
  }, [needsSites, prefs.shortcutRows]);
  const update = (
    i: number,
    patch: Partial<Preferences["shortcutRows"][number]>,
  ) => {
    const rows = prefs.shortcutRows.map((r, n) =>
      n === i ? { ...r, ...patch } : r,
    ) as Preferences["shortcutRows"];
    change({ shortcutRows: rows });
  };
  const allow = async (i: number) => {
    if (typeof chrome === "undefined" || !chrome.permissions) {
      setError("Most-visited sites are available in the installed extension.");
      return;
    }
    try {
      const granted = await chrome.permissions.request({
        permissions: ["topSites"],
      });
      if (!granted) {
        setError("Most-visited access was not granted.");
        return;
      }
      update(i, { source: "frequent" });
      setSites(safeSites(await chrome.topSites.get()));
      setNeedsSiteAccess(false);
      setError("");
    } catch {
      setError("Could not access most-visited sites.");
    }
  };
  return (
    <nav
      className="shortcut-rows"
      aria-label="Favorite shortcuts"
      data-editing={editing}
    >
      <div className="shortcut-actions">
        {openFolder && (
          <button
            aria-label={`Remove ${openFolder.name} folder`}
            title="Remove folder, keep links"
            onClick={() => {
              change(removeFavoriteFolder(prefs, openFolder.id));
              setOpenFolderId(undefined);
            }}
          >
            <Trash2 size={15} />
          </button>
        )}
        {openFolder && (
          <span className="shortcut-folder-name">{openFolder.name}</span>
        )}
        <button
          aria-label="Add shortcut"
          title="Add shortcut"
          onClick={() => add(openFolder?.name)}
        >
          <Plus size={15} />
        </button>
        <button
          aria-label="Create favorite folder"
          title="Create folder"
          onClick={() => openFolderEditor("create")}
        >
          <FolderPlus size={15} />
        </button>
        {openFolder && (
          <button
            aria-label={`Edit ${openFolder.name} folder`}
            title="Edit folder"
            onClick={() => openFolderEditor("edit")}
          >
            <Pencil size={15} />
          </button>
        )}
        {!openFolder && (
          <button
            aria-label="Configure shortcut rows"
            title="Configure shortcut rows"
            aria-expanded={editing}
            onClick={() => setEditing(!editing)}
          >
            {editing ? <X size={15} /> : <SlidersHorizontal size={15} />}
          </button>
        )}
      </div>
      {editing && !openFolder && (
        <div className="shortcut-row-count">
          <label htmlFor="shortcut-row-count">Shortcut rows</label>
          <select
            id="shortcut-row-count"
            value={prefs.shortcutRows.length}
            onChange={(event) => {
              const count = Number(event.target.value);
              change({
                shortcutRows: Array.from(
                  { length: count },
                  (_, i) =>
                    prefs.shortcutRows[i] ??
                    DEFAULT_ROWS[i] ?? {
                      source: "favorites",
                      folder: "",
                      page: i,
                    },
                ),
              });
            }}
          >
            {[0, 1, 2, 3].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      )}
      {openFolder ? (
        <>
          {[0, 1].map((i) => {
            const cells = [undefined, ...folderView.items].slice(
              i * 5,
              i * 5 + 5,
            );
            return (
              <div
                className="shortcut-row"
                aria-label={`Shortcut row ${i + 1}`}
                key={i}
              >
                <span className="shortcut-page" aria-hidden="true" />
                <div className="shortcut-cells">
                  {cells.map((favorite, n) =>
                    favorite ? (
                      <a
                        key={favorite.id}
                        href={favorite.url}
                        title={favorite.url}
                      >
                        <SiteIcon url={favorite.url} name={favorite.name} />
                        <b>{favorite.name}</b>
                      </a>
                    ) : (
                      <button
                        key={`back-${n}`}
                        className="shortcut-tile shortcut-back"
                        aria-label="Back to main favorites"
                        onClick={() => setOpenFolderId(undefined)}
                      >
                        <span aria-hidden="true">
                          <ArrowLeft size={22} />
                        </span>
                        <b>Back</b>
                      </button>
                    ),
                  )}
                </div>
                <span className="shortcut-page" aria-hidden="true" />
              </div>
            );
          })}
          {folderView.last > 0 && (
            <div className="shortcut-folder-pages">
              <button
                aria-label="Previous folder page"
                disabled={folderView.current === 0}
                onClick={() => setFolderOffset(folderView.current - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {folderView.current + 1} / {folderView.last + 1}
              </span>
              <button
                aria-label="Next folder page"
                disabled={folderView.current === folderView.last}
                onClick={() => setFolderOffset(folderView.current + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          )}
        </>
      ) : (
        prefs.shortcutRows.map((row, i) => {
          const source =
            row.source === "frequent"
              ? sites
              : safeSites(
                  prefs.favorites.filter(
                    (f) => row.source !== "folder" || f.folder === row.folder,
                  ),
                );
          const page = rowPage(
            row.source === "favorites"
              ? roots
              : source.map((favorite) => ({
                  kind: "link" as const,
                  favorite:
                    row.source === "folder"
                      ? prefs.favorites.find(
                          (entry) =>
                            entry.folder === row.folder &&
                            safeSites([entry])[0]?.url === favorite.url,
                        )!
                      : { ...favorite, id: favorite.url, folder: "" },
                })),
            row.page,
            row.source === "favorites" ? 1 : 0,
          );
          return (
            <div className="shortcut-row-group" key={i}>
              {editing && (
                <div className="shortcut-row-settings">
                  <label>
                    Row {i + 1}
                    <select
                      aria-label={`Row ${i + 1} source`}
                      value={
                        row.source === "folder"
                          ? `folder:${row.folder}`
                          : row.source
                      }
                      onChange={(e) => {
                        const value = e.target.value;
                        if (value === "frequent") {
                          void allow(i);
                          return;
                        }
                        update(i, {
                          source:
                            value === "favorites" ? "favorites" : "folder",
                          folder: value.startsWith("folder:")
                            ? value.slice(7)
                            : "",
                          page: 0,
                        });
                      }}
                    >
                      <option value="favorites">Favorites</option>
                      <option value="frequent">Most visited</option>
                      {[
                        ...new Set([
                          ...groupNames,
                          ...(row.folder ? [row.folder] : []),
                        ]),
                      ].map((folder) => (
                        <option key={folder} value={`folder:${folder}`}>
                          {folder}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Positions
                    <select
                      aria-label={`Row ${i + 1} positions`}
                      value={page.current}
                      onChange={(e) =>
                        update(i, { page: Number(e.target.value) })
                      }
                    >
                      {Array.from({ length: page.last + 1 }, (_, n) => (
                        <option key={n} value={n}>
                          {n * 5 + 1}–{n * 5 + 5}
                        </option>
                      ))}
                    </select>
                  </label>
                  {row.source === "frequent" && (
                    <button className="secondary" onClick={() => void allow(i)}>
                      Allow access
                    </button>
                  )}
                </div>
              )}
              <div
                className="shortcut-row"
                aria-label={`Shortcut row ${i + 1}`}
              >
                <button
                  className="shortcut-page"
                  aria-label={`Previous shortcuts in row ${i + 1}`}
                  disabled={page.current === 0}
                  onClick={() => update(i, { page: page.current - 1 })}
                >
                  <ChevronLeft size={14} />
                </button>
                <div className="shortcut-cells">
                  {page.items.map((tile) => (
                    <div
                      className="shortcut-cell"
                      key={
                        tile.kind === "folder"
                          ? tile.folder.id
                          : tile.favorite.id
                      }
                    >
                      {tile.kind === "folder" ? (
                        <button
                          key={tile.folder.id}
                          className="shortcut-tile"
                          aria-label={`Open ${tile.folder.name} folder`}
                          onClick={() => {
                            setOpenFolderId(tile.folder.id);
                            setFolderOffset(0);
                          }}
                        >
                          <span aria-hidden="true">
                            <Folder size={22} />
                          </span>
                          <b>{tile.folder.name}</b>
                        </button>
                      ) : (
                        <a
                          key={tile.favorite.id}
                          href={tile.favorite.url}
                          title={tile.favorite.url}
                        >
                          <SiteIcon
                            url={tile.favorite.url}
                            name={tile.favorite.name}
                          />
                          <b>{tile.favorite.name}</b>
                        </a>
                      )}
                      {editing && row.source !== "frequent" && (
                        <div className="shortcut-cell-actions">
                          {tile.kind === "link" && (
                            <button
                              aria-label={`Edit ${tile.favorite.name}`}
                              title="Edit favorite"
                              onClick={() => edit(tile.favorite.id)}
                            >
                              <Pencil size={12} />
                            </button>
                          )}
                          <button
                            aria-label={
                              tile.kind === "folder"
                                ? `Remove ${tile.folder.name} folder`
                                : `Remove ${tile.favorite.name}`
                            }
                            title={
                              tile.kind === "folder"
                                ? "Remove folder, keep links"
                                : "Remove favorite"
                            }
                            onClick={() =>
                              change(
                                tile.kind === "folder"
                                  ? removeFavoriteFolder(prefs, tile.folder.id)
                                  : {
                                      favorites: prefs.favorites.filter(
                                        (f) => f.id !== tile.favorite.id,
                                      ),
                                    },
                              )
                            }
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                  {!page.items.length &&
                    row.source !== "favorites" &&
                    (row.source === "frequent" && needsSiteAccess ? (
                      <button
                        className="shortcut-empty shortcut-enable"
                        onClick={() => void allow(i)}
                      >
                        <History size={15} /> Show most visited
                      </button>
                    ) : (
                      <span className="shortcut-empty">
                        {row.source === "frequent"
                          ? "No most-visited sites"
                          : "No shortcuts"}
                      </span>
                    ))}
                </div>
                <button
                  className="shortcut-page"
                  aria-label={`Next shortcuts in row ${i + 1}`}
                  disabled={page.current === page.last}
                  onClick={() => update(i, { page: page.current + 1 })}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          );
        })
      )}
      {error && !openFolder && (
        <p className="form-message" role="status">
          {error}
        </p>
      )}
      {folderDialog && (
        <Modal
          close={() => setFolderDialog(undefined)}
          label={
            folderDialog === "create"
              ? "Create favorite folder"
              : "Edit favorite folder"
          }
        >
          <form
            className="small-modal shortcut-folder-editor"
            onSubmit={saveFolder}
          >
            <button
              type="button"
              className="modal-close"
              aria-label="Close folder editor"
              onClick={() => setFolderDialog(undefined)}
            >
              <X size={18} />
            </button>
            <h2>{folderDialog === "create" ? "New folder" : "Edit folder"}</h2>
            <label>
              Folder name
              <input
                autoFocus
                required
                maxLength={40}
                value={folderName}
                onChange={(event) => setFolderName(event.target.value)}
              />
            </label>
            {folderError && (
              <p className="form-message" role="alert">
                {folderError}
              </p>
            )}
            <button className="primary" type="submit">
              {folderDialog === "create" ? "Create folder" : "Save folder"}
            </button>
            {folderDialog === "edit" && openFolder && (
              <>
                <div className="shortcut-folder-links">
                  {members.map((favorite, i) => (
                    <div key={favorite.id}>
                      <span>{favorite.name}</span>
                      <button
                        type="button"
                        aria-label={`Edit ${favorite.name}`}
                        onClick={() => {
                          setFolderDialog(undefined);
                          edit(favorite.id);
                        }}
                      >
                        <Pencil size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${favorite.name} up`}
                        disabled={i === 0}
                        onClick={() => reorderMember(favorite.id, -1)}
                      >
                        <ArrowUp size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Move ${favorite.name} down`}
                        disabled={i === members.length - 1}
                        onClick={() => reorderMember(favorite.id, 1)}
                      >
                        <ArrowDown size={14} />
                      </button>
                      <button
                        type="button"
                        title="Move to main favorites"
                        aria-label={`Move ${favorite.name} to main favorites`}
                        onClick={() =>
                          change({
                            favorites: prefs.favorites.map((entry) =>
                              entry.id === favorite.id
                                ? {
                                    ...entry,
                                    folderId: undefined,
                                    folder: "Favorites",
                                  }
                                : entry,
                            ),
                          })
                        }
                      >
                        <ArrowLeft size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Remove ${favorite.name}`}
                        title="Remove favorite"
                        onClick={() =>
                          change({
                            favorites: prefs.favorites.filter(
                              (entry) => entry.id !== favorite.id,
                            ),
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                </div>
                <label>
                  Add an existing favorite
                  <select
                    aria-label="Add an existing favorite"
                    value={existingLink}
                    onChange={(event) => setExistingLink(event.target.value)}
                  >
                    <option value="">Choose a favorite</option>
                    {prefs.favorites
                      .filter((favorite) => favorite.folderId !== openFolder.id)
                      .map((favorite) => (
                        <option key={favorite.id} value={favorite.id}>
                          {favorite.name}
                        </option>
                      ))}
                  </select>
                </label>
                <button
                  type="button"
                  className="secondary"
                  disabled={!existingLink}
                  onClick={() => {
                    const favorite = prefs.favorites.find(
                      (entry) => entry.id === existingLink,
                    );
                    if (!favorite) return;
                    change({
                      favorites: [
                        ...prefs.favorites.filter(
                          (entry) => entry.id !== existingLink,
                        ),
                        {
                          ...favorite,
                          folderId: openFolder.id,
                          folder: openFolder.name,
                        },
                      ],
                    });
                    setExistingLink("");
                  }}
                >
                  <Plus size={15} /> Add to folder
                </button>
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    change(removeFavoriteFolder(prefs, openFolder.id));
                    setOpenFolderId(undefined);
                    setFolderDialog(undefined);
                  }}
                >
                  <Trash2 size={15} /> Remove folder, keep links
                </button>
              </>
            )}
          </form>
        </Modal>
      )}
    </nav>
  );
}
