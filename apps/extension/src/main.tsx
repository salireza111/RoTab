import { Modal } from "./Modal";
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowDown,
  ArrowUp,
  ArrowUpRight,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FlaskConical,
  HelpCircle,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  Pencil,
  Settings2,
  Square,
  Trash2,
  X,
  Orbit,
  Download,
  Network,
  Minimize2,
  Maximize2,
  Search,
  Palette,
  ArrowLeft,
  Send,
  Upload,
} from "lucide-react";
import {
  initialSnapshot,
  type Snapshot,
  ENGINE_ID,
  SOURCE_SHA,
  type EngineManifest,
  PROTOCOLS,
  protocolDefinition,
  type Protocol,
  type StructureSnapshot,
} from "@rosettatab/shared";
import { Session } from "./session";
import { Protein } from "./Protein";
import { EnergyChart } from "./EnergyChart";
import { SnapshotInspector } from "./SnapshotInspector";
import { ResourcePanel } from "./ResourcePanel";
import { useRelaxationReplay } from "./relaxation-replay";
import { Widgets } from "./widgets";
import { PersonalWidgetRail } from "./PersonalWidgetRail";
import { getLocalGreeting } from "./greeting";
import { documentation } from "./documentation";
import {
  readPreferences,
  savePreferences,
  getState,
  putState,
  type Preferences,
} from "./storage";
import { availableCores, defaultWorkerCount } from "./compute-settings";
import {
  importProteinFile,
  exportBenchmark,
  type ImportedBenchmark,
} from "./benchmark";
import { Admin } from "./Admin";
import { ProteinImportSummary } from "./ProteinImportSummary";
import { PanelBorderMotion } from "./PanelBorderMotion";
import { useViewMotion } from "./useViewMotion";
import { PeerPanel } from "./PeerPanel";
import { NetworkPanel } from "./NetworkPanel";
import { VolunteerDashboard } from "./VolunteerDashboard";
import { useVolunteerNetwork } from "./useVolunteerNetwork";
import { AppearanceSettings } from "./AppearanceSettings";
import { SiteIcon } from "./SiteIcon";
import { Shortcuts } from "./Shortcuts";
import { useAppearance } from "./appearance";
import { useWorkQueue, queueCounts } from "./work-queue";
import { WorkQueue } from "./WorkQueue";
import { useFocusTimer } from "./useFocusTimer";
import { SearchBox } from "./SearchBox";
import type { SearchProvider } from "./search-suggestions";
import { tabIndicator } from "./network-status";
import { useTabIndicator } from "./useTabIndicator";
import { HistidineMark } from "./HistidineMark";
import "./style.css";
import "./newtab.css";
import "./dashboard.css";
import "./personal-widgets.css";

function App() {
  const [prefs, setPrefs] = useState(readPreferences),
    [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot),
    [owner, setOwner] = useState(false),
    [reference, setReference] = useState(""),
    [manifest, setManifest] = useState<EngineManifest>(),
    [now, setNow] = useState(new Date()),
    [admin, setAdmin] = useState(false),
    [settings, setSettings] = useState(false),
    [appearanceOpen, setAppearanceOpen] = useState(false),
    [peerOpen, setPeerOpen] = useState(false),
    [networkOpen, setNetworkOpen] = useState(false),
    [demoActive, setDemoActive] = useState(false),
    [favorite, setFavorite] = useState(false),
    [favoriteId, setFavoriteId] = useState<string>(),
    [favoriteName, setFavoriteName] = useState(""),
    [favoriteUrl, setFavoriteUrl] = useState(""),
    [folder, setFolder] = useState("Favorites"),
    [error, setError] = useState(""),
    [editing, setEditing] = useState(false);
  // The saved view selects a new tab's initial layout. Navigation belongs to
  // this mounted tab and must not rewrite that preference or move other tabs.
  const [view, setView] = useState(prefs.view);
  const [searchProvider, setSearchProvider] =
    useState<SearchProvider>("default");
  const [narrowDashboard, setNarrowDashboard] = useState(
    () => matchMedia("(max-width: 700px)").matches,
  );
  const [mobileFavoritesOpen, setMobileFavoritesOpen] = useState(false);
  useEffect(() => {
    const media = matchMedia("(max-width: 700px)");
    const update = () => setNarrowDashboard(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const favoritesCollapsed = narrowDashboard
    ? !mobileFavoritesOpen
    : prefs.dashboardFavoritesCollapsed;
  const session = useRef<Session | undefined>(undefined);
  const backgroundUrl = useAppearance(prefs);
  const queue = useWorkQueue(owner);
  const network = useVolunteerNetwork({
    owner,
    manifest,
    session: session.current,
    snapshot,
    onView: queue.publishNetwork,
  });
  useEffect(() => {
    if (snapshot.taskSource === "peer") setDemoActive(false);
  }, [snapshot.taskSource, snapshot.taskId]);
  const simple = view === "home";
  const focus = useFocusTimer();
  const indicator = tabIndicator(snapshot, network.summary, network.error);
  useTabIndicator(indicator, focus, owner);
  const warnOnClose =
    owner &&
    !!snapshot.taskId &&
    ["loading", "running"].includes(snapshot.state);
  useEffect(() => {
    if (!warnOnClose) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      // Check the live session as well: a Stop/completion may have happened
      // before React removes this listener, and linked tabs never own workers.
      const current = session.current;
      if (
        !current?.owner ||
        current.disposed ||
        !current.snapshot.taskId ||
        !["loading", "running"].includes(current.snapshot.state)
      )
        return;
      event.preventDefault();
      // Browsers display their own wording; retain the legacy signal too.
      event.returnValue =
        "Closing this tab will terminate the active calculation.";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [warnOnClose]);
  const [serverDraft, setServerDraft] = useState(prefs.apiUrl),
    [serverError, setServerError] = useState("");
  const [benchmarkTitle, setBenchmarkTitle] = useState(""),
    [benchmarkMessage, setBenchmarkMessage] = useState("");
  const [benchmarkInput, setBenchmarkInput] = useState<ImportedBenchmark>();
  const benchmarkFileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void getState<ImportedBenchmark>("benchmark-input").then((input) => {
      setBenchmarkTitle(input?.task.title ?? "");
      setBenchmarkInput(input);
      setDemoActive(false);
    });
  }, [settings]);
  const importBenchmark = async (file: File | undefined) => {
    if (!file) return;
    try {
      const input = await importProteinFile(file);
      await putState("benchmark-input", input);
      change({ apiUrl: "" });
      setServerDraft("");
      setBenchmarkTitle(input.task.title);
      setBenchmarkInput(input);
      setBenchmarkMessage(
        "Imported. Start the next calculation to run this input locally.",
      );
      session.current?.command("refresh");
    } catch (error) {
      setBenchmarkMessage(
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  const selectImportedProtocol = async (protocol: Protocol) => {
    if (!benchmarkInput) return;
    const next = { ...benchmarkInput, runProtocol: protocol };
    await putState("benchmark-input", next);
    setBenchmarkInput(next);
    session.current?.command("refresh");
  };
  const relaxImportedProtein = async () => {
    await selectImportedProtocol("relax");
    setDemoActive(false);
    session.current?.command("start");
  };
  const downloadRecord = async () => {
    try {
      if (!snapshot.taskId || !manifest) return;
      const record = await exportBenchmark(snapshot.taskId);
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(record, null, 2) + "\n"], {
          type: "application/json",
        }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `rotab-record-${record.runId}.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      setBenchmarkMessage(
        error instanceof Error ? error.message : String(error),
      );
      setSettings(true);
    }
  };
  const saveServer = async () => {
    try {
      if (!serverDraft.trim()) {
        change({ apiUrl: "" });
        setServerError("Standalone browser calculations selected.");
        return true;
      }
      const url = new URL(serverDraft.trim());
      if (
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash ||
        url.protocol !== "https:"
      )
        throw new Error(
          "Use a plain HTTPS research service address, or leave this blank to calculate without a server.",
        );
      if (
        url.protocol === "https:" &&
        typeof chrome !== "undefined" &&
        chrome.permissions
      ) {
        const granted = await chrome.permissions.request({
          origins: [url.origin + "/*"],
        });
        if (!granted)
          throw new Error("The browser did not grant access to this server.");
      }
      change({ apiUrl: url.origin });
      setServerError("Server address saved.");
      return true;
    } catch (e) {
      setServerError((e as Error).message);
      return false;
    }
  };
  useEffect(() => {
    const active = new Session((data, isOwner) => {
      setSnapshot(data);
      setOwner(isOwner);
    });
    session.current = active;
    void fetch("./fixtures/1l2y.pdb")
      .then((r) => r.text())
      .then(setReference);
    void fetch("./engine/engine-metadata.json")
      .then((r) => r.json())
      .then(setManifest);
    const timer = setInterval(() => setNow(new Date()), 1000),
      refresh = () => setPrefs(readPreferences());
    window.addEventListener("preferences", refresh);
    window.addEventListener("storage", refresh);
    const cleanup = () => active.dispose();
    window.addEventListener("pagehide", cleanup);
    return () => {
      clearInterval(timer);
      active.dispose();
      window.removeEventListener("preferences", refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener("pagehide", cleanup);
    };
  }, []);
  const change = (patch: Partial<Preferences>) => {
    const previous = readPreferences(),
      next = { ...previous, ...patch };
    savePreferences(next);
    setPrefs(next);
    // An explicit opening-view choice also previews that layout in this tab.
    // Other tabs receive the preference but keep their own current view.
    if (patch.view) setView(patch.view);
    // Layout and personal widgets do not control the scientific session. New
    // calculations read the latest protocol and duty cycle when Start is used.
    if (previous.apiUrl !== next.apiUrl) session.current?.command("refresh");
  };
  const {
    phase: viewMotion,
    cycle: proteinEntrance,
    switchView,
    finish: finishViewMotion,
  } = useViewMotion(view, setView);
  const addFavorite = (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const url = new URL(
        favoriteUrl.includes("://") ? favoriteUrl : "https://" + favoriteUrl,
      );
      if (
        !["https:", "http:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new Error("Use an HTTP or HTTPS link.");
      const requestedFolder = folder.trim() || "Favorites";
      const existingFolder = prefs.favoriteFolders.find(
        (entry) => entry.name.toLowerCase() === requestedFolder.toLowerCase(),
      );
      const newFolder =
        !existingFolder &&
        requestedFolder.toLowerCase() !== "favorites" &&
        !prefs.favorites.some(
          (entry) =>
            entry.folder.toLowerCase() === requestedFolder.toLowerCase(),
        )
          ? { id: crypto.randomUUID(), name: requestedFolder }
          : undefined;
      const destination = existingFolder ?? newFolder;
      const folderName =
        destination?.name ??
        (requestedFolder.toLowerCase() === "favorites"
          ? "Favorites"
          : requestedFolder);
      change({
        ...(newFolder
          ? { favoriteFolders: [...prefs.favoriteFolders, newFolder] }
          : {}),
        favorites: favoriteId
          ? prefs.favorites.map((f) =>
              f.id === favoriteId
                ? {
                    ...f,
                    name: favoriteName.trim() || url.hostname,
                    url: url.href,
                    folder: folderName,
                    folderId: destination?.id,
                  }
                : f,
            )
          : [
              ...prefs.favorites,
              {
                id: crypto.randomUUID(),
                name: favoriteName.trim() || url.hostname,
                url: url.href,
                folder: folderName,
                folderId: destination?.id,
              },
            ],
      });
      setFavorite(false);
      setFavoriteName("");
      setFavoriteUrl("");
      setFavoriteId(undefined);
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const shiftFavorite = (id: string, direction: number) => {
    const favorites = [...prefs.favorites],
      i = favorites.findIndex((f) => f.id === id),
      j = i + direction;
    if (j < 0 || j >= favorites.length) return;
    [favorites[i], favorites[j]] = [favorites[j], favorites[i]];
    change({ favorites });
  };
  const working = ["loading", "running", "uploading", "waiting"].includes(
      snapshot.state,
    ),
    unavailable = !(
      manifest?.verified &&
      manifest.id === ENGINE_ID &&
      manifest.sourceSha === SOURCE_SHA
    );
  const replay = useRelaxationReplay(working);
  const [inspectedFrame, setInspectedFrame] = useState<StructureSnapshot>(),
    [baselineFrame, setBaselineFrame] = useState<StructureSnapshot>();
  useEffect(() => {
    setInspectedFrame(undefined);
    setBaselineFrame(undefined);
  }, [
    snapshot.taskId,
    snapshot.focusedModel,
    replay.active,
    snapshot.frames?.length === 0,
  ]);
  const availableFrames = replay.active
    ? replay.frames
    : (snapshot.frames ?? []);
  const selectedFrame = replay.active
    ? replay.frame
    : (inspectedFrame ?? availableFrames.at(-1));
  const displayedFrame = replay.active ? replay.frame : inspectedFrame;
  const selectFrame = (frame: StructureSnapshot) => {
    if (replay.active) replay.selectFrame(frame.id);
    else setInspectedFrame(frame);
  };
  const research =
    (snapshot.taskSource ?? (prefs.apiUrl ? "research" : "bundled")) ===
    "research";
  const localControls =
    demoActive ||
    research ||
    snapshot.taskSource === "benchmark" ||
    !!benchmarkInput;
  const downloadResult = () => {
    if (snapshot.state !== "complete" || research || !snapshot.pdb) return;
    const url = URL.createObjectURL(
      new Blob([snapshot.pdb], { type: "chemical/x-pdb" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `rotab-${snapshot.protocol}-${snapshot.taskId}.pdb`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const visual = displayedFrame
    ? {
        ...snapshot,
        ...displayedFrame,
        history: replay.active ? replay.history : snapshot.history,
        bestEnergy: replay.active ? replay.bestEnergy : snapshot.bestEnergy,
        startingPdb: replay.active ? replay.startingPdb : snapshot.startingPdb,
      }
    : snapshot;
  const progress = Math.max(
    0,
    Math.min(100, (snapshot.completed / snapshot.total) * 100),
  );
  const nextProtocol =
    benchmarkInput?.runProtocol ??
    benchmarkInput?.task.protocol ??
    prefs.browserProtocol;
  const protocol = snapshot.protocol ?? nextProtocol;
  const protocolLabels: Record<string, string> = {
    score: "Fixed-coordinate score",
    relax: "FastRelax",
    minimize: "Minimize",
    repack: "Repack",
    fixed_backbone_design: "Sequence design",
    fastdesign: "FastDesign",
    cartesian_minimize: "Cartesian minimize",
    cartesian_relax: "Cartesian relax",
  };
  const statusMessage = (() => {
    if (snapshot.state === "error") return snapshot.message;
    if (snapshot.state === "unavailable") return "Rosetta engine unavailable.";
    if (snapshot.state === "complete")
      return research
        ? "Result accepted."
        : "Calculation complete. Saved locally.";
    if (snapshot.state === "waiting") return "No tasks available.";
    if (snapshot.state === "loading")
      return snapshot.message.includes("Looking for")
        ? "Fetching task…"
        : snapshot.message.includes("Preparing and scoring")
          ? "Initializing Rosetta…"
          : "Loading Rosetta…";
    if (snapshot.state === "running")
      return snapshot.snapshotSource === "packing"
        ? "Repacking side chains…"
        : snapshot.snapshotSource === "minimizing"
          ? "Minimizing coordinates…"
          : "Calculating…";
    if (snapshot.state === "uploading") return "Submitting result…";
    if (snapshot.state === "paused")
      return snapshot.message.startsWith("Checkpoint recovered")
        ? "Checkpoint recovered. Paused."
        : snapshot.message.startsWith("Paused.")
          ? "Paused."
          : snapshot.message;
    return snapshot.message.startsWith("Stopped.") ? "Stopped." : undefined;
  })();
  const greeting = getLocalGreeting(now);
  return (
    <div
      className={`app-shell ${simple ? "simple-home" : "dashboard-view"}`}
      data-background={prefs.background}
      data-view-motion={viewMotion}
      data-favorites-collapsed={favoritesCollapsed}
      data-widgets-collapsed={prefs.dashboardWidgetsCollapsed}
      data-personal-tools={
        simple &&
        Object.values(prefs.personalWidgets).some(
          (widget) => widget.enabled && widget.side !== "middle",
        )
      }
    >
      <div
        className="page-backdrop"
        aria-hidden="true"
        style={
          backgroundUrl
            ? { backgroundImage: `url("${backgroundUrl}")` }
            : undefined
        }
      />
      <aside
        className="sidebar"
        id="dashboard-favorites"
        aria-label="Favorites and navigation"
        inert={!simple && favoritesCollapsed}
        aria-hidden={!simple && favoritesCollapsed ? true : undefined}
      >
        <div className="sidebar-content">
          <button
            type="button"
            className="brand brand-home"
            aria-label="RoTab: return to preferred view"
            title="Return to preferred opening view"
            onClick={() => switchView(prefs.view)}
          >
            <span>RoTab</span>
            {!simple && <HistidineMark status={indicator} />}
          </button>
          <div className="sidebar-section">
            <div className="section-heading">
              <span>FAVORITES</span>
              <button
                onClick={() => setEditing(!editing)}
                aria-label="Edit favorites"
              >
                <MoreHorizontal size={18} />
              </button>
            </div>
            {[...new Set(prefs.favorites.map((f) => f.folder))].map((group) => (
              <div className="favorite-folder" key={group}>
                <h3>
                  <ChevronDown size={12} />
                  {group}
                </h3>
                {prefs.favorites
                  .filter((f) => f.folder === group)
                  .map((f) => (
                    <div className="favorite-row" key={f.id}>
                      <a href={f.url} title={f.url}>
                        <SiteIcon
                          className="favorite-avatar"
                          url={f.url}
                          name={f.name}
                        />
                        <span>{f.name}</span>
                        <ArrowUpRight size={13} />
                      </a>
                      {editing && (
                        <div className="favorite-edit">
                          <button
                            onClick={() => {
                              setFavoriteId(f.id);
                              setFavoriteName(f.name);
                              setFavoriteUrl(f.url);
                              setFolder(f.folder);
                              setError("");
                              setFavorite(true);
                            }}
                            aria-label={`Edit ${f.name}`}
                          >
                            <Pencil size={12} />
                          </button>
                          <button
                            onClick={() => shiftFavorite(f.id, -1)}
                            aria-label={`Move ${f.name} up`}
                          >
                            <ArrowUp size={12} />
                          </button>
                          <button
                            onClick={() => shiftFavorite(f.id, 1)}
                            aria-label={`Move ${f.name} down`}
                          >
                            <ArrowDown size={12} />
                          </button>
                          <button
                            onClick={() =>
                              change({
                                favorites: prefs.favorites.filter(
                                  (x) => x.id !== f.id,
                                ),
                              })
                            }
                            aria-label={`Delete ${f.name}`}
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
              </div>
            ))}
            <button
              className="add-favorite"
              onClick={() => {
                setFavoriteId(undefined);
                setFavoriteName("");
                setFavoriteUrl("");
                setFolder("Favorites");
                setError("");
                setFavorite(true);
              }}
            >
              <Plus size={15} /> Add a favorite
            </button>
          </div>
          <div className="sidebar-bottom">
            <button
              onClick={() => setNetworkOpen(true)}
              aria-label="Volunteer network"
            >
              <Network size={16} /> Volunteer network
            </button>
            <button
              onClick={() => setPeerOpen(true)}
              aria-label="Peer collaboration"
            >
              <Network size={16} /> Peer collaboration
            </button>
            {prefs.apiUrl && (
              <button onClick={() => setAdmin(true)}>
                <FlaskConical size={16} /> Research console
              </button>
            )}
            <button
              onClick={() => {
                setServerDraft(prefs.apiUrl);
                setServerError("");
                setSettings(true);
              }}
            >
              <Settings2 size={16} /> Settings
            </button>
            <a
              href={documentation.home}
              target="_blank"
              rel="noopener noreferrer"
            >
              <HelpCircle size={16} /> About RoTab <ArrowUpRight size={12} />
            </a>
          </div>
        </div>
      </aside>
      {!simple && (
        <button
          type="button"
          className="dashboard-panel-toggle dashboard-panel-toggle-left"
          aria-label={
            favoritesCollapsed
              ? "Show favorites sidebar"
              : "Hide favorites sidebar"
          }
          title={favoritesCollapsed ? "Show favorites" : "Hide favorites"}
          aria-controls="dashboard-favorites"
          aria-expanded={!favoritesCollapsed}
          onClick={() =>
            narrowDashboard
              ? setMobileFavoritesOpen(!mobileFavoritesOpen)
              : change({ dashboardFavoritesCollapsed: !favoritesCollapsed })
          }
        >
          {favoritesCollapsed ? (
            <ChevronRight size={16} />
          ) : (
            <ChevronLeft size={16} />
          )}
        </button>
      )}
      {simple && (
        <PersonalWidgetRail side="left" prefs={prefs} change={change} />
      )}
      <main className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">
              {now
                .toLocaleDateString([], {
                  weekday: "long",
                  month: "long",
                  day: "numeric",
                })
                .toUpperCase()}
            </p>
            <h1>
              {greeting}
              <span className="greeting-dot">.</span>
            </h1>
          </div>
          <div className="header-tools">
            {simple && (
              <div className="header-brand-group">
                <button
                  type="button"
                  className="home-brand brand-home"
                  aria-label="RoTab: return to preferred view"
                  title="Return to preferred opening view"
                  onClick={() => switchView(prefs.view)}
                >
                  RoTab <HistidineMark status={indicator} />
                </button>
              </div>
            )}
            <button
              className="view-toggle secondary"
              aria-label={simple ? "Open dashboard" : "Simple new tab"}
              title={simple ? "Open protein dashboard" : "Back to new tab"}
              onClick={() => switchView(simple ? "dashboard" : "home")}
            >
              {simple ? <Maximize2 size={18} /> : <ArrowLeft size={18} />}
            </button>
            <button
              className="appearance-toggle"
              aria-label="Customize new tab"
              title="Appearance"
              onClick={() => setAppearanceOpen(true)}
            >
              <Palette size={18} />
            </button>
            <button
              className="publish-target"
              aria-label="Publish a target"
              title="Publish a target"
              onClick={() => setNetworkOpen(true)}
            >
              <Send size={18} />
            </button>
            <button
              className="functional-settings"
              aria-label="Computation settings"
              title="Computation settings"
              onClick={() => setSettings(true)}
            >
              <Settings2 size={18} />
            </button>
            <div className="header-clock">
              <span>
                {now.toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: false,
                })}
              </span>
              <small>
                {Intl.DateTimeFormat()
                  .resolvedOptions()
                  .timeZone.replace("_", " ")}
              </small>
            </div>
          </div>
        </header>
        <div className="home-launcher">
          <SearchBox
            provider={searchProvider}
            suggestionsEnabled={prefs.searchSuggestionsEnabled}
            change={(patch) => {
              if (patch.searchProvider) setSearchProvider(patch.searchProvider);
              if (patch.searchSuggestionsEnabled !== undefined)
                change({
                  searchSuggestionsEnabled: patch.searchSuggestionsEnabled,
                });
            }}
          />
          <Shortcuts
            prefs={prefs}
            change={change}
            add={(destination) => {
              setFavoriteId(undefined);
              setFavoriteName("");
              setFavoriteUrl("");
              setFolder(destination ?? "Favorites");
              setError("");
              setFavorite(true);
            }}
            edit={(id) => {
              const entry = prefs.favorites.find(
                (favorite) => favorite.id === id,
              );
              if (!entry) return;
              setFavoriteId(id);
              setFavoriteName(entry.name);
              setFavoriteUrl(entry.url);
              setFolder(entry.folder);
              setError("");
              setFavorite(true);
            }}
          />
        </div>
        <div className="workspace-grid">
          <div className="science-column">
            <section className="observatory">
              <div className="observatory-heading">
                <span>
                  <span className="mini-logo">
                    <Activity size={14} />
                  </span>{" "}
                  Protein observatory
                </span>
                <span className="engine-chip">
                  <span
                    className={
                      "status-dot " + (working ? "active" : "reference")
                    }
                  />
                  {snapshot.taskSource === "peer"
                    ? "Peer"
                    : research
                      ? "Research"
                      : "Standalone"}
                </span>
              </div>
              <button
                className="compact-protein-open"
                aria-label="Open protein dashboard"
                onClick={() => switchView("dashboard")}
              />
              <Protein
                expanded={!simple}
                doodle={prefs.visualStyle === "doodle" && prefs.doodleProtein}
                autoRotate={prefs.proteinAutoRotate}
                onAutoRotateChange={(enabled) =>
                  change({ proteinAutoRotate: enabled })
                }
                pdb={
                  simple
                    ? (snapshot.pdb ?? reference)
                    : (visual.pdb ?? reference)
                }
                startingPdb={visual.startingPdb}
                comparisonPdb={
                  !simple &&
                  baselineFrame &&
                  selectedFrame &&
                  baselineFrame.id !== selectedFrame.id
                    ? baselineFrame.pdb
                    : undefined
                }
                comparisonLabel={
                  baselineFrame
                    ? `Baseline · Snapshot ${baselineFrame.sequence}`
                    : undefined
                }
                structureLabel={
                  !replay.active && inspectedFrame
                    ? `SNAPSHOT ${inspectedFrame.sequence}`
                    : undefined
                }
                running={
                  simple
                    ? snapshot.state === "running"
                    : replay.active
                      ? replay.playing
                      : !inspectedFrame && snapshot.state === "running"
                }
                snapshotCount={
                  simple
                    ? (snapshot.snapshotSequence ?? snapshot.history.length)
                    : displayedFrame
                      ? displayedFrame.sequence
                      : (snapshot.snapshotSequence ?? visual.history.length)
                }
                snapshotSource={
                  displayedFrame
                    ? displayedFrame.source
                    : snapshot.snapshotSource
                }
                snapshotStep={
                  displayedFrame ? displayedFrame.step : snapshot.snapshotStep
                }
                replay={replay.active}
                replayLabel={
                  snapshot.frames?.length
                    ? "Replay this calculation"
                    : undefined
                }
                onReplay={
                  !working && !replay.active
                    ? () =>
                        void replay.start(
                          snapshot.frames?.length ? snapshot.frames : undefined,
                          snapshot.frames?.length
                            ? snapshot.history
                            : undefined,
                        )
                    : undefined
                }
                onStopReplay={replay.active ? replay.stop : undefined}
                live={
                  replay.active ||
                  (!!snapshot.pdb &&
                    snapshot.state !== "idle" &&
                    snapshot.state !== "unavailable")
                }
              />
              <div className="compact-protein-summary">
                {simple && (
                  <VolunteerDashboard
                    network={network}
                    owner={owner}
                    snapshot={snapshot}
                    unavailable={unavailable}
                    compact
                    advanced={() => setNetworkOpen(true)}
                  />
                )}
                <div className="compact-protein-state">
                  <span
                    className={
                      "status-dot " +
                      (snapshot.state === "running" ? "active" : "reference")
                    }
                  />
                  <b>
                    {snapshot.state === "running"
                      ? "Calculating"
                      : snapshot.state === "complete"
                        ? "Complete"
                        : snapshot.state === "paused"
                          ? "Paused"
                          : snapshot.state === "loading"
                            ? "Loading Rosetta"
                            : "Protein observatory"}
                  </b>
                  <span>
                    {snapshot.energy === undefined
                      ? "Trp-cage · 1L2Y"
                      : `${snapshot.energy.toFixed(3)} REU`}
                  </span>
                </div>
                <div className="compact-progress">
                  <i style={{ width: `${progress}%` }} />
                </div>
                {simple && warnOnClose && (
                  <p className="calculation-close-notice">
                    Closing this tab will terminate the active calculation.
                  </p>
                )}
                <div className="compact-protein-foot">
                  <span>
                    {queueCounts(queue.view, now.getTime()).waiting} tasks
                    awaiting approval
                  </span>
                  <span>
                    Open dashboard <ArrowUpRight size={13} />
                  </span>
                </div>
              </div>
              {replay.error && <p role="alert">{replay.error}</p>}
              <EnergyChart
                protocol={protocol}
                history={visual.history}
                frames={availableFrames}
                selectedFrameId={selectedFrame?.id}
                baselineFrameId={baselineFrame?.id}
                onSelectFrame={selectFrame}
                canSetBaseline={
                  replay.active ? !replay.playing : !!inspectedFrame
                }
                onToggleBaseline={(frame) =>
                  setBaselineFrame((previous) =>
                    previous?.id === frame.id ? undefined : frame,
                  )
                }
                running={
                  replay.active ? replay.playing : snapshot.state === "running"
                }
                replay={replay.active}
                loading={snapshot.state === "loading"}
              />
              <SnapshotInspector
                selected={selectedFrame}
                baseline={baselineFrame}
                replay={replay.active}
                playing={replay.playing}
                inspecting={!!inspectedFrame}
                running={snapshot.state === "running"}
                speed={replay.speed}
                onTogglePlayback={() =>
                  replay.playing ? replay.pause() : replay.play()
                }
                onSpeedChange={replay.setSpeed}
                onFollowLatest={() => setInspectedFrame(undefined)}
              />
              <section
                className="calculation"
                aria-label="Calculation controls"
                data-task-id={snapshot.taskId}
              >
                <div className="calculation-heading">
                  <h2
                    className="task-protocol"
                    data-protocol={protocol}
                    title={snapshot.title}
                  >
                    {snapshot.taskSource === "peer"
                      ? "Your contribution"
                      : localControls || working || snapshot.state === "paused"
                        ? (protocolLabels[protocol] ?? protocol)
                        : "Volunteer research"}
                  </h2>
                  <div className="calculation-meta">
                    <span
                      className={"session-badge " + (working ? "running" : "")}
                    >
                      {owner ? "Computing tab" : "Linked tab"}
                    </span>
                    <details className="calculation-details">
                      <summary
                        aria-label="Calculation details"
                        title="Calculation details"
                      >
                        <HelpCircle size={15} />
                      </summary>
                      <div>
                        <p>
                          {snapshot.taskSource === "peer"
                            ? "Peer Rosetta task · packaged WebAssembly"
                            : snapshot.taskSource === "benchmark"
                              ? "Offline coordinate benchmark · Rosetta WASM"
                              : research
                                ? "Hosted research task · Rosetta WASM"
                                : "Standalone · Trp-cage (1L2Y) · Rosetta WASM"}
                        </p>
                        <p>
                          Tabs share one calculation. Closing the computing tab
                          terminates its active workers. A remaining tab can
                          recover saved work; unfinished models restart from
                          their recorded seeds. Completed models are saved.
                        </p>
                        {!research && (
                          <p>
                            Results stay on this device. Standalone runs earn no
                            volunteer credit.
                          </p>
                        )}
                      </div>
                    </details>
                  </div>
                </div>
                <VolunteerDashboard
                  network={network}
                  owner={owner}
                  snapshot={snapshot}
                  unavailable={unavailable}
                  advanced={() => setNetworkOpen(true)}
                />
                {statusMessage && (
                  <p
                    className={
                      "session-message " +
                      (snapshot.state === "error" ||
                      snapshot.state === "unavailable"
                        ? "is-error"
                        : "")
                    }
                    role="status"
                    title={
                      snapshot.state === "unavailable"
                        ? snapshot.message
                        : undefined
                    }
                  >
                    {statusMessage}
                  </p>
                )}
                {warnOnClose && (
                  <p className="calculation-close-notice">
                    Closing this tab will terminate the active calculation.
                  </p>
                )}
                <div className="progress-row">
                  <span>
                    {snapshot.state === "waiting"
                      ? "Waiting"
                      : snapshot.state === "complete"
                        ? "Complete"
                        : snapshot.state === "paused"
                          ? "Paused"
                          : working
                            ? "Progress"
                            : "Ready"}
                  </span>
                  <b>
                    {(working && snapshot.state !== "waiting") ||
                    ["complete", "paused"].includes(snapshot.state)
                      ? `${Math.round(progress)}%`
                      : "—"}
                  </b>
                </div>
                <div
                  className="progress-track"
                  role="progressbar"
                  aria-label="Calculation progress"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(progress)}
                >
                  <div style={{ width: progress + "%" }} />
                </div>
                <div className="energy-row">
                  <div>
                    <span>
                      {replay.active
                        ? "REPLAY ENERGY"
                        : inspectedFrame
                          ? "SNAPSHOT ENERGY"
                          : "CURRENT ENERGY"}
                    </span>
                    <b>
                      {visual.energy === undefined
                        ? "—"
                        : visual.energy.toFixed(3)}
                      <small> REU</small>
                    </b>
                  </div>
                  <div>
                    <span>BEST ENERGY</span>
                    <b>
                      {visual.bestEnergy === undefined
                        ? "—"
                        : visual.bestEnergy.toFixed(3)}
                      <small> REU</small>
                    </b>
                  </div>
                  <div>
                    <span>
                      {replay.active
                        ? "RECORDED ELAPSED"
                        : inspectedFrame
                          ? "SNAPSHOT ELAPSED"
                          : "ELAPSED"}
                    </span>
                    <b>
                      {visual.elapsedMs
                        ? `${Math.floor(visual.elapsedMs / 60000)}m ${Math.floor(visual.elapsedMs / 1000) % 60}s`
                        : "—"}
                    </b>
                  </div>
                </div>
                <div className="calculation-actions">
                  {!!snapshot.totalModels && snapshot.totalModels > 1 && (
                    <div
                      className="parallel-status"
                      aria-label="Parallel calculation status"
                    >
                      <span>
                        {snapshot.completedModels ?? 0}/{snapshot.totalModels}{" "}
                        models complete
                      </span>
                      <span>
                        {snapshot.activeWorkers ?? 0} active ·{" "}
                        {snapshot.parallelism} workers
                      </span>
                      {snapshot.state !== "complete" && (
                        <span>
                          Viewing model {(snapshot.focusedModel ?? 0) + 1}
                        </span>
                      )}
                    </div>
                  )}
                  {(localControls ||
                    working ||
                    ["paused", "error"].includes(snapshot.state)) && (
                    <div className="control-row">
                      <div className="run-controls">
                        {((localControls && snapshot.taskSource !== "peer") ||
                          snapshot.state === "paused") && (
                          <button
                            className="primary"
                            disabled={unavailable || working}
                            onClick={() =>
                              session.current?.command(
                                demoActive && snapshot.state !== "paused"
                                  ? "demo"
                                  : "start",
                              )
                            }
                          >
                            <Play size={14} fill="currentColor" />
                            {snapshot.state === "paused"
                              ? "Resume calculation"
                              : snapshot.state === "complete"
                                ? demoActive
                                  ? "Run demo again"
                                  : "Start next task"
                                : research
                                  ? "Start contributing"
                                  : "Start browser calculation"}
                          </button>
                        )}
                        <button
                          className="icon-control"
                          disabled={!working}
                          onClick={() => session.current?.command("pause")}
                          aria-label="Pause calculation"
                        >
                          <Pause size={15} />
                        </button>
                        <button
                          className="icon-control"
                          disabled={
                            !working &&
                            !["paused", "error"].includes(snapshot.state)
                          }
                          onClick={() => session.current?.command("stop")}
                          aria-label="Stop calculation"
                        >
                          <Square size={13} />
                        </button>
                      </div>
                      {(research ||
                        snapshot.taskSource === "benchmark" ||
                        !!benchmarkInput) &&
                        !demoActive &&
                        snapshot.taskSource !== "peer" && (
                          <label className="auto-toggle">
                            <input
                              type="checkbox"
                              checked={prefs.automatic}
                              onChange={(e) =>
                                change({ automatic: e.target.checked })
                              }
                            />
                            <span className="switch" />
                            <span>
                              {prefs.automatic
                                ? "Continue automatically"
                                : "Ask after each task"}
                            </span>
                          </label>
                        )}
                    </div>
                  )}
                  {snapshot.state === "complete" &&
                    !research &&
                    snapshot.pdb && (
                      <div className="result-actions">
                        {snapshot.protocol === "score" &&
                          snapshot.taskSource === "benchmark" &&
                          benchmarkInput &&
                          manifest?.supportedProtocols?.includes("relax") && (
                            <button
                              className="secondary"
                              onClick={() => void relaxImportedProtein()}
                              title="Start a new FastRelax run on the imported protein"
                            >
                              <FlaskConical size={14} /> Run FastRelax
                            </button>
                          )}
                        <button
                          className="secondary result-download"
                          onClick={downloadResult}
                        >
                          <Download size={14} /> Download calculated protein
                        </button>
                        <button
                          className="secondary"
                          onClick={() => void downloadRecord()}
                        >
                          <Download size={14} /> Export run records
                        </button>
                      </div>
                    )}
                </div>
              </section>
            </section>
            <ResourcePanel metrics={snapshot.metrics} />
            {!simple && (
              <WorkQueue
                view={queue.view}
                snapshot={snapshot}
                now={now.getTime()}
                openPeers={() =>
                  queue.view?.network?.enabled ||
                  queue.view?.network?.remaining ||
                  !queue.view?.jobs.some((job) => job.direction === "received")
                    ? setNetworkOpen(true)
                    : setPeerOpen(true)
                }
              />
            )}
          </div>
          {!simple && (
            <button
              type="button"
              className="dashboard-panel-toggle dashboard-panel-toggle-right"
              aria-label={
                prefs.dashboardWidgetsCollapsed
                  ? "Show dashboard widgets"
                  : "Hide dashboard widgets"
              }
              title={
                prefs.dashboardWidgetsCollapsed
                  ? "Show widgets"
                  : "Hide widgets"
              }
              aria-controls="dashboard-widgets"
              aria-expanded={!prefs.dashboardWidgetsCollapsed}
              onClick={() =>
                change({
                  dashboardWidgetsCollapsed: !prefs.dashboardWidgetsCollapsed,
                })
              }
            >
              {prefs.dashboardWidgetsCollapsed ? (
                <ChevronLeft size={16} />
              ) : (
                <ChevronRight size={16} />
              )}
            </button>
          )}
          <div
            id="dashboard-widgets"
            className={simple ? "home-widgets" : "dashboard-widget-panel"}
            inert={!simple && prefs.dashboardWidgetsCollapsed}
            aria-hidden={
              !simple && prefs.dashboardWidgetsCollapsed ? true : undefined
            }
          >
            <Widgets
              focus={focus}
              workQueue={
                <WorkQueue
                  compact
                  view={queue.view}
                  snapshot={snapshot}
                  now={now.getTime()}
                  openPeers={() => setNetworkOpen(true)}
                />
              }
              compact={simple}
              prefs={prefs}
              change={change}
              acceptedTaskId={
                snapshot.state === "complete" ? snapshot.taskId : undefined
              }
            />
          </div>
        </div>
      </main>
      {simple && (
        <PersonalWidgetRail side="right" prefs={prefs} change={change} />
      )}
      <PanelBorderMotion
        cycle={proteinEntrance}
        active={viewMotion === "drawing"}
        finish={finishViewMotion}
      />
      {admin && <Admin close={() => setAdmin(false)} />}
      {favorite && (
        <Modal
          close={() => setFavorite(false)}
          label={favoriteId ? "Edit a favorite" : "Add a favorite"}
        >
          <form className="small-modal" onSubmit={addFavorite}>
            <button
              type="button"
              className="modal-close"
              aria-label="Close favorite editor"
              onClick={() => setFavorite(false)}
            >
              <X size={18} />
            </button>
            <Bookmark size={22} className="accent" />
            <h2>{favoriteId ? "Edit favorite" : "Add favorite"}</h2>
            <label>
              Name
              <input
                autoFocus
                value={favoriteName}
                onChange={(e) => setFavoriteName(e.target.value)}
                maxLength={80}
              />
            </label>
            <label>
              Website
              <input
                required
                value={favoriteUrl}
                onChange={(e) => setFavoriteUrl(e.target.value)}
                placeholder="https://example.com"
                maxLength={2000}
              />
            </label>
            <label>
              Folder
              <input
                value={folder}
                list="favorite-folder-options"
                onChange={(e) => setFolder(e.target.value)}
                maxLength={40}
              />
              <datalist id="favorite-folder-options">
                {[
                  ...new Set([
                    "Favorites",
                    ...prefs.favoriteFolders.map((entry) => entry.name),
                    ...prefs.favorites.map((entry) => entry.folder),
                  ]),
                ].map((name) => (
                  <option key={name} value={name} />
                ))}
              </datalist>
            </label>
            {error && <p className="form-message">{error}</p>}
            <button className="primary">
              {favoriteId ? <Check size={15} /> : <Plus size={15} />}{" "}
              {favoriteId ? "Save favorite" : "Add favorite"}
            </button>
            {favoriteId && (
              <button
                type="button"
                className="secondary"
                onClick={() => {
                  change({
                    favorites: prefs.favorites.filter(
                      (entry) => entry.id !== favoriteId,
                    ),
                  });
                  setFavorite(false);
                  setFavoriteId(undefined);
                }}
              >
                <Trash2 size={15} /> Delete favorite
              </button>
            )}
          </form>
        </Modal>
      )}
      {appearanceOpen && (
        <Modal
          close={() => setAppearanceOpen(false)}
          confirm={() => setAppearanceOpen(false)}
          label="RoTab appearance"
        >
          <section className="small-modal appearance-modal">
            <button
              className="modal-close"
              onClick={() => setAppearanceOpen(false)}
              aria-label="Close appearance"
            >
              <X size={18} />
            </button>
            <Palette size={22} className="accent" />
            <h2>Appearance</h2>
            <AppearanceSettings prefs={prefs} change={change} />
            <DocumentationLinks />
          </section>
        </Modal>
      )}
      {settings && (
        <Modal
          close={() => setSettings(false)}
          confirm={async () => {
            if (serverDraft.trim() !== prefs.apiUrl && !(await saveServer()))
              return;
            setSettings(false);
          }}
          label="RoTab settings"
        >
          <section className="small-modal settings-modal">
            <button
              className="modal-close"
              onClick={() => setSettings(false)}
              aria-label="Close settings"
            >
              <X size={18} />
            </button>
            <Settings2 size={22} className="accent" />
            <h2>Settings</h2>
            {!owner && (
              <button
                className="secondary"
                onClick={() =>
                  void network
                    .locateOwner()
                    .catch((e) => setServerError(String(e)))
                }
              >
                Go to main tab <ArrowUpRight size={14} />
              </button>
            )}
            <label className="check-label">
              <input
                type="checkbox"
                checked={prefs.proteinAutoRotate}
                onChange={(e) =>
                  change({ proteinAutoRotate: e.target.checked })
                }
              />
              <span>Rotate protein automatically</span>
            </label>
            <label>
              CPU workers · {prefs.workerCount} of {availableCores()}
              <input
                type="range"
                aria-label="CPU workers"
                min="1"
                max={availableCores()}
                step="1"
                value={prefs.workerCount}
                onChange={(e) =>
                  change({ workerCount: Number(e.target.value) })
                }
                disabled={working}
              />
            </label>
            <button
              className="secondary"
              disabled={working}
              onClick={() =>
                change({ workerCount: defaultWorkerCount(), dutyCycle: 10 })
              }
            >
              Use low-power defaults
            </button>
            <p className="setting-description">
              One worker at 10% intensity is the default. More workers and
              higher intensity increase power use. Engine startup can use more
              CPU than this cooperative limit.
            </p>
            <label>
              Intensity per worker · {prefs.dutyCycle}%
              <input
                type="range"
                min="10"
                max="75"
                step="5"
                value={prefs.dutyCycle}
                onChange={(e) => change({ dutyCycle: Number(e.target.value) })}
                disabled={working}
              />
            </label>
            <label>
              Calculation protocol
              <select
                aria-label="Calculation protocol"
                value={nextProtocol}
                disabled={working || snapshot.state === "paused"}
                onChange={(e) => {
                  const protocol = e.target.value as Protocol;
                  if (benchmarkInput) void selectImportedProtocol(protocol);
                  else change({ browserProtocol: protocol });
                }}
              >
                {PROTOCOLS.filter((p) =>
                  manifest?.supportedProtocols?.includes(p.id),
                ).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <p className="setting-description">
              {nextProtocol === "score"
                ? "Score keeps coordinates fixed and saves initial and final snapshots. Choose FastRelax for live packing and minimization."
                : protocolDefinition(nextProtocol).description}
            </p>
            <label>
              Hosted research service (optional)
              <input
                value={serverDraft}
                placeholder="https://research.example.org"
                onChange={(e) => setServerDraft(e.target.value)}
                disabled={working}
              />
            </label>
            <button
              className="secondary"
              disabled={working}
              onClick={() => void saveServer()}
            >
              Save task source
            </button>
            {serverError && (
              <p className="form-message" role="status">
                {serverError}
              </p>
            )}
            <div className="benchmark-settings">
              <section
                className="benchmark-settings-group"
                aria-labelledby="live-demo-heading"
              >
                <h3 id="live-demo-heading">Live demonstration</h3>
                <button
                  className="secondary"
                  aria-label="Start live demo"
                  disabled={
                    unavailable ||
                    working ||
                    snapshot.state === "paused" ||
                    (snapshot.state === "error" && !!snapshot.taskId)
                  }
                  onClick={() => {
                    change({ browserProtocol: "relax", automatic: false });
                    setDemoActive(true);
                    setSettings(false);
                    if (simple) switchView("dashboard");
                    session.current?.command("demo");
                  }}
                >
                  <Play size={14} /> Try FastRelax · sample protein
                </button>
              </section>
              <section
                className="benchmark-settings-group"
                aria-labelledby="offline-benchmark-heading"
              >
                <h3 id="offline-benchmark-heading">Offline benchmark</h3>
                <p className="setting-description">
                  Run a PDB or coordinate benchmark JSON on this device.
                </p>
                <div className="benchmark-upload">
                  <input
                    ref={benchmarkFileInput}
                    hidden
                    type="file"
                    accept=".json,.pdb,.ent,.pdb.gz,.ent.gz"
                    aria-label="Import benchmark input"
                    disabled={working || snapshot.state === "paused"}
                    onChange={(event) => {
                      void importBenchmark(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    className="secondary"
                    disabled={working || snapshot.state === "paused"}
                    onClick={() => benchmarkFileInput.current?.click()}
                  >
                    <Upload size={14} />{" "}
                    {benchmarkTitle
                      ? "Replace input"
                      : "Import benchmark input"}
                  </button>
                </div>
                {benchmarkTitle && (
                  <div className="benchmark-selection">
                    <div className="benchmark-selection-heading">
                      <span>{benchmarkTitle}</span>
                      <button
                        className="secondary"
                        disabled={working || snapshot.state === "paused"}
                        onClick={() =>
                          void putState("benchmark-input", undefined).then(
                            () => {
                              setBenchmarkTitle("");
                              setBenchmarkInput(undefined);
                              setBenchmarkMessage("");
                              session.current?.command("refresh");
                            },
                          )
                        }
                      >
                        Use bundled protein
                      </button>
                    </div>
                    {benchmarkInput && (
                      <ProteinImportSummary input={benchmarkInput} />
                    )}
                  </div>
                )}
                {benchmarkMessage && (
                  <p className="form-message" role="status">
                    {benchmarkMessage}
                  </p>
                )}
              </section>
            </div>
            {unavailable && (
              <p className="form-message" role="status">
                {manifest?.reason}
              </p>
            )}
            <button
              className="secondary"
              onClick={() => {
                change({ hiddenWidgets: [] });
                setSettings(false);
              }}
            >
              Restore widgets
            </button>
            <DocumentationLinks />
          </section>
        </Modal>
      )}
      <PeerPanel
        open={peerOpen}
        close={() => setPeerOpen(false)}
        owner={owner}
        manifest={manifest}
        session={session.current}
        snapshot={snapshot}
        preferences={prefs}
        onView={queue.publish}
      />
      <NetworkPanel
        open={networkOpen}
        close={() => setNetworkOpen(false)}
        owner={owner}
        manifest={manifest}
        network={network}
        snapshot={snapshot}
        preferences={prefs}
        openDirect={() => setPeerOpen(true)}
      />
    </div>
  );
}
function DocumentationLinks() {
  return (
    <nav
      className="documentation-links"
      aria-label="Documentation and policies"
    >
      <a href={documentation.help} target="_blank" rel="noopener noreferrer">
        Help <ArrowUpRight size={12} />
      </a>
      <a href={documentation.privacy} target="_blank" rel="noopener noreferrer">
        Privacy
      </a>
      <a href={documentation.support} target="_blank" rel="noopener noreferrer">
        Support
      </a>
    </nav>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
