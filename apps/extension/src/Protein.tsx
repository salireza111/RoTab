import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { RotateCcw, Maximize2, Layers, Move3D, Activity } from "lucide-react";
import { PluginContext } from "molstar/lib/mol-plugin/context";
import { DefaultPluginSpec } from "molstar/lib/mol-plugin/spec";
import { Color } from "molstar/lib/mol-util/color";
import { Loci } from "molstar/lib/mol-model/loci";
import { residueLoci } from "./molecular-selection";
import { StructureElement } from "molstar/lib/mol-model/structure";
import { StructureRepresentation3D } from "molstar/lib/mol-plugin-state/transforms/representation";
import { DisplayCoordinates } from "./molecular-model";
import { CoordinateTransition, readProteinFrame } from "./protein-motion";
import {
  colorHex,
  ProteinColorData,
  ProteinColorMode,
  ProteinPalette,
  readProteinColors,
  residueColor,
} from "./protein-colors";
import {
  locationResidueKey,
  RosettaColorThemeProvider,
} from "./molecular-colors";
import { ProteinColorKey } from "./ProteinColorKey";
import { compareProteinFrames } from "./protein-comparison";
import "./protein-comparison.css";

export function Protein({
  pdb,
  startingPdb,
  live,
  running,
  snapshotCount = 0,
  replay = false,
  snapshotSource,
  snapshotStep,
  onReplay,
  onStopReplay,
  comparisonPdb,
  comparisonLabel,
  structureLabel,
  replayLabel,
  doodle = false,
  expanded = true,
  autoRotate = true,
  onAutoRotateChange,
}: {
  pdb: string;
  startingPdb?: string;
  live: boolean;
  running: boolean;
  snapshotCount?: number;
  replay?: boolean;
  snapshotSource?: string;
  snapshotStep?: number;
  onReplay?: () => void;
  onStopReplay?: () => void;
  comparisonPdb?: string;
  comparisonLabel?: string;
  structureLabel?: string;
  replayLabel?: string;
  doodle?: boolean;
  expanded?: boolean;
  autoRotate?: boolean;
  onAutoRotateChange?: (enabled: boolean) => void;
}) {
  const host = useRef<HTMLDivElement>(null),
    canvas = useRef<HTMLCanvasElement>(null),
    plugin = useRef<PluginContext | undefined>(undefined);
  const [ready, setReady] = useState(false),
    [fallback, setFallback] = useState(false),
    [atoms, setAtoms] = useState(false),
    [compare, setCompare] = useState(false),
    [spin, setSpin] = useState(autoRotate),
    [motion, setMotion] = useState(true),
    [reduced, setReduced] = useState(false),
    [colorMode, setColorMode] = useState<ProteinColorMode>("energy"),
    [hoveredKey, setHoveredKey] = useState<string | undefined>(),
    [selectedKey, setSelectedKey] = useState<string | undefined>();
  const selected = useRef<string | undefined>(undefined);
  selected.current = selectedKey;
  const componentRef = useRef<string | undefined>(undefined);
  const pinnedStructure = useRef<unknown>(undefined);
  const pinnedKey = useRef<string | undefined>(undefined);
  const applySelection = () => {
    const context = plugin.current;
    const structure = componentRef.current
      ? context?.state.data.cells.get(componentRef.current)?.obj?.data
      : undefined;
    if (
      !context ||
      !structure ||
      (pinnedStructure.current === structure &&
        pinnedKey.current === selected.current)
    )
      return;
    pinnedStructure.current = structure;
    pinnedKey.current = selected.current;
    context.managers.interactivity.lociSelects.deselectAll();
    if (selected.current)
      context.managers.interactivity.lociSelects.selectOnly(
        { loci: residueLoci(structure, selected.current) },
        false,
      );
    if (host.current)
      host.current.dataset.selectedResidue = selected.current ?? "";
  };
  const applySelectionRef = useRef(applySelection);
  applySelectionRef.current = applySelection;
  const coordinates = useMemo(() => readProteinFrame(pdb), [pdb]);
  const coloring = useMemo(() => readProteinColors(pdb), [pdb]);
  const baselinePdb = comparisonPdb || (compare ? startingPdb : undefined);
  const comparison = useMemo(
    () => (baselinePdb ? compareProteinFrames(pdb, baselinePdb) : undefined),
    [pdb, baselinePdb],
  );
  const baselineColoring = useMemo(
    () => (baselinePdb ? readProteinColors(baselinePdb) : undefined),
    [baselinePdb],
  );
  const topology = coordinates.keys.join("|");
  const latest = useRef({
    pdb,
    coordinates,
    coloring,
    colorMode,
    comparison,
    baselinePdb,
    baselineColoring,
  });
  latest.current = {
    pdb,
    coordinates,
    coloring,
    colorMode,
    comparison,
    baselinePdb,
    baselineColoring,
  };
  const transition = useRef(new CoordinateTransition());
  const coordinateRef = useRef<string | undefined>(undefined);
  const comparisonCoordinateRef = useRef<string | undefined>(undefined);
  const representationRef = useRef<string | undefined>(undefined);
  const applied = useRef<Float32Array | undefined>(undefined);
  const appliedColors = useRef<ProteinColorData | undefined>(undefined);
  const appliedMode = useRef<ProteinColorMode>("energy");
  const appliedComparison = useRef<Float32Array | undefined>(undefined);
  const updating = useRef(false);
  const pendingUpdate = useRef(Promise.resolve());
  const previousTopology = useRef("");
  const lastCoordinateAt = useRef(0);
  const scene = useRef(Promise.resolve());
  const revision = useRef(0),
    hasStructure = useRef(false);
  useEffect(() => setSpin(autoRotate), [autoRotate]);
  useEffect(() => {
    let disposed = false,
      frame = 0,
      last = 0;
    let viewportObserver: ResizeObserver | undefined;
    let visibilityObserver: IntersectionObserver | undefined;
    let visible = true;
    const reduced = matchMedia("(prefers-reduced-motion: reduce)");
    const preference = () => {
      setReduced(reduced.matches);
    };
    preference();
    reduced.addEventListener("change", preference);
    const probe = document.createElement("canvas");
    const gl = probe.getContext("webgl2") ?? probe.getContext("webgl");
    if (!gl) {
      setFallback(true);
      return () => reduced.removeEventListener("change", preference);
    }
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    const context = new PluginContext(DefaultPluginSpec());
    context.representation.structure.themes.colorThemeRegistry.add(
      RosettaColorThemeProvider,
    );
    plugin.current = context;
    const hover = context.behaviors.interaction.hover.subscribe(
      ({ current }) => {
        const loci = Loci.normalize(current.loci, "residue", true);
        const location = StructureElement.Loci.is(loci)
          ? StructureElement.Loci.getFirstLocation(loci)
          : undefined;
        setHoveredKey(location ? locationResidueKey(location) : undefined);
      },
    );
    const click = context.behaviors.interaction.click.subscribe(
      ({ current, button }) => {
        if (button !== 1) return;
        const loci = Loci.normalize(current.loci, "residue", true);
        const location = StructureElement.Loci.is(loci)
          ? StructureElement.Loci.getFirstLocation(loci)
          : undefined;
        if (!location) return;
        const key = locationResidueKey(location);
        if (!latest.current.coloring.residues.some((r) => r.key === key))
          return;
        selected.current = key;
        setSelectedKey(key);
        setSpin(false);
        applySelectionRef.current();
        context.managers.camera.focusLoci(loci, {
          durationMs: 300,
          minRadius: 5,
          extraRadius: 3,
        });
      },
    );
    void context
      .init()
      .then(async () => {
        if (disposed) return;
        const ok = await context.initViewerAsync(
          canvas.current!,
          host.current!,
        );
        if (!ok) throw new Error("WebGL is unavailable.");
        context.canvas3d?.setProps({
          renderer: { backgroundColor: Color(0x0c1421) },
          transparentBackground: true,
          camera: { helper: { axes: { name: "off", params: {} } } },
        });
        context.animationLoop.stop();
        context.canvas3d?.resume();
        const resizeViewport = () => {
          if (disposed) return;
          context.handleResize();
          // The custom 30 FPS loop must also synchronize Mol*'s viewport after
          // its canvas buffer changes; resizing only the buffer clips the pose.
          context.canvas3d?.handleResize();
        };
        viewportObserver = new ResizeObserver(resizeViewport);
        viewportObserver.observe(host.current!);
        visibilityObserver = new IntersectionObserver(([entry]) => {
          visible = entry.isIntersecting;
        });
        visibilityObserver.observe(host.current!);
        resizeViewport();
        const render = (time: number) => {
          if (disposed) return;
          if (!document.hidden && visible && time - last >= 1000 / 30) {
            const positions = transition.current.sample(time);
            if (host.current)
              host.current.dataset.motion =
                positions === transition.current.target
                  ? "settled"
                  : "interpolating";
            const ref = coordinateRef.current;
            const { coloring, colorMode, comparison, baselineColoring } =
              latest.current;
            const ghostPositions =
              comparison?.status === "aligned"
                ? comparison.positions
                : undefined;
            const ghostChanged = ghostPositions !== appliedComparison.current;
            if (
              ref &&
              positions.length &&
              (positions !== applied.current ||
                coloring !== appliedColors.current ||
                colorMode !== appliedMode.current ||
                ghostChanged) &&
              !updating.current
            ) {
              updating.current = true;
              applied.current = positions;
              appliedColors.current = coloring;
              appliedComparison.current = ghostPositions;
              const update = context.state.data.build();
              update
                .to(ref)
                .update(DisplayCoordinates, () => ({ positions, coloring }));
              if (
                comparisonCoordinateRef.current &&
                ghostPositions &&
                baselineColoring &&
                ghostChanged
              )
                update
                  .to(comparisonCoordinateRef.current)
                  .update(DisplayCoordinates, () => ({
                    positions: ghostPositions,
                    coloring: baselineColoring,
                  }));
              if (
                representationRef.current &&
                colorMode !== appliedMode.current
              )
                update
                  .to(representationRef.current)
                  .update(StructureRepresentation3D, (params) => ({
                    ...params,
                    colorTheme: {
                      name: RosettaColorThemeProvider.name,
                      params: { mode: colorMode },
                    },
                  }));
              appliedMode.current = colorMode;
              pendingUpdate.current = update
                .commit({ doNotUpdateCurrent: true })
                .then(() => {
                  if (!disposed && host.current) {
                    applySelectionRef.current();
                    host.current.dataset.colorMode = colorMode;
                    host.current.dataset.colors = String(coloring.signature);
                  }
                })
                .catch(() => {
                  if (!disposed) setFallback(true);
                })
                .finally(() => {
                  updating.current = false;
                });
            }
            context.canvas3d?.tick(time as any, { updateControls: true });
            last = time;
          }
          frame = requestAnimationFrame(render);
        };
        frame = requestAnimationFrame(render);
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setFallback(true);
      });
    const loss = (e: Event) => {
      e.preventDefault();
      setFallback(true);
    };
    canvas.current?.addEventListener("webglcontextlost", loss);
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      viewportObserver?.disconnect();
      visibilityObserver?.disconnect();
      reduced.removeEventListener("change", preference);
      hover.unsubscribe();
      click.unsubscribe();
      context.dispose();
      plugin.current = undefined;
    };
  }, []);
  useEffect(() => {
    const now = performance.now();
    // Follow the measured delivery cadence without adding motion after the
    // latest coordinates. Long packing/initialization gaps remain bounded.
    const liveDuration = lastCoordinateAt.current
      ? Math.min(800, Math.max(180, now - lastCoordinateAt.current))
      : 220;
    lastCoordinateAt.current = now;
    transition.current.set(
      coordinates.positions,
      now,
      running && motion && !reduced && previousTopology.current === topology
        ? replay
          ? Math.min(400, liveDuration)
          : liveDuration
        : 0,
    );
    previousTopology.current = topology;
  }, [coordinates, running, motion, reduced, topology, replay]);
  useEffect(() => {
    const context = plugin.current;
    if (!ready || !context || !pdb) return;
    const requested = ++revision.current;
    scene.current = scene.current
      .then(async () => {
        if (requested !== revision.current || plugin.current !== context)
          return;
        const view = hasStructure.current
          ? context.canvas3d?.camera.getSnapshot()
          : undefined;
        coordinateRef.current = undefined;
        comparisonCoordinateRef.current = undefined;
        representationRef.current = undefined;
        componentRef.current = undefined;
        transition.current.finish();
        await pendingUpdate.current;
        await context.clear();
        const renderedMode = latest.current.colorMode;
        const add = async (
          data: string,
          alpha: number,
          primary: boolean,
          ghostPositions?: Float32Array,
        ) => {
          const raw = await context.builders.data.rawData({
            data,
            label: "Protein coordinates",
          });
          const trajectory = await context.builders.structure.parseTrajectory(
            raw,
            "pdb",
          );
          const model =
            await context.builders.structure.createModel(trajectory);
          const displayed =
            primary || ghostPositions
              ? await context.state.data
                  .build()
                  .to(model)
                  .apply(DisplayCoordinates, {
                    positions:
                      ghostPositions ?? readProteinFrame(data).positions,
                    coloring: readProteinColors(data),
                  })
                  .commit()
              : model;
          const structure =
            await context.builders.structure.createStructure(displayed);
          const component =
            await context.builders.structure.tryCreateComponentStatic(
              structure,
              "protein",
            );
          if (component) {
            if (primary) componentRef.current = component.ref;
            const representation =
              await context.builders.structure.representation.addRepresentation(
                component,
                {
                  type: context.representation.structure.registry.get(
                    atoms ? "ball-and-stick" : "cartoon",
                  ),
                  color: primary
                    ? RosettaColorThemeProvider
                    : context.representation.structure.themes.colorThemeRegistry.get(
                        "uniform",
                      ),
                  colorParams: primary
                    ? { mode: renderedMode }
                    : { value: Color(comparisonPdb ? 0xaaa2df : 0x91a7ba) },
                  typeParams: {
                    alpha,
                    quality: "high",
                    sizeFactor: atoms ? 0.18 : 0.2,
                    ...(atoms
                      ? { ignoreHydrogens: true, aspectRatio: 0.65 }
                      : {
                          aspectRatio: 4,
                          arrowFactor: 1.2,
                          tubularHelices: false,
                        }),
                    ignoreLight: doodle,
                    roughness: 0.38,
                    metalness: 0,
                  },
                },
              );
            if (primary) representationRef.current = representation.ref;
            else representation.obj?.data.repr.setState({ pickable: false });
          }
          return displayed.ref;
        };
        const ref = await add(latest.current.pdb, 1, true);
        const { comparison, baselinePdb } = latest.current;
        const ghostRef =
          baselinePdb && comparison?.status === "aligned"
            ? await add(
                baselinePdb,
                comparisonPdb ? 0.23 : 0.16,
                false,
                comparison.positions,
              )
            : undefined;
        if (requested !== revision.current) return;
        coordinateRef.current = ref;
        comparisonCoordinateRef.current = ghostRef;
        appliedComparison.current = undefined;
        applied.current = undefined;
        appliedColors.current = undefined;
        appliedMode.current = renderedMode;
        if (view) context.canvas3d?.camera.setState(view, 0);
        else context.canvas3d?.requestCameraReset({ durationMs: 200 });
        hasStructure.current = true;
        applySelectionRef.current();
      })
      .catch(() => setFallback(true));
  }, [
    ready,
    topology,
    baselinePdb,
    atoms,
    doodle,
    comparison?.status,
    !!comparisonPdb,
  ]);
  useLayoutEffect(() => {
    // Synchronize the existing canvas before Chromium captures a view transition.
    const context = plugin.current;
    context?.handleResize();
    context?.canvas3d?.handleResize();
  }, [expanded, ready]);
  useEffect(() => {
    plugin.current?.canvas3d?.setProps({
      trackball: {
        animate:
          spin && !reduced
            ? { name: "spin", params: { speed: 0.08, axis: [0, 1, 0] } }
            : { name: "off", params: {} },
      },
    } as any);
  }, [spin, ready, reduced]);
  useEffect(() => {
    if (selectedKey && !coloring.residues.some((r) => r.key === selectedKey))
      setSelectedKey(undefined);
  }, [selectedKey, coloring]);
  useEffect(() => {
    applySelectionRef.current();
  }, [selectedKey]);
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedKey(undefined);
    };
    host.current?.parentElement?.addEventListener("keydown", escape);
    const element = host.current?.parentElement;
    return () => element?.removeEventListener("keydown", escape);
  }, []);
  useEffect(() => {
    const style = () => {
      const light = document.documentElement.dataset.theme === "light";
      plugin.current?.canvas3d?.setProps({
        postprocessing: {
          outline: doodle
            ? {
                name: "on",
                params: {
                  scale: 1,
                  threshold: 0.33,
                  color: Color(light ? 0x161616 : 0xf8f8f8),
                  includeTransparent: false,
                },
              }
            : { name: "off", params: {} },
          occlusion: { name: "off", params: {} },
          shadow: { name: "off", params: {} },
        },
      });
      if (host.current)
        host.current.dataset.renderStyle = doodle ? "doodle" : "shaded";
    };
    style();
    const observer = new MutationObserver(style);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [doodle, ready]);
  const ca = coloring.residues.filter((r) => r.ca);
  const ghostCa = useMemo(
    () =>
      comparison?.status === "aligned"
        ? readProteinColors(comparison.alignedPdb).residues.filter((r) => r.ca)
        : [],
    [comparison],
  );
  const xs = [...ca, ...ghostCa].map((r) => r.ca![0]),
    ys = [...ca, ...ghostCa].map((r) => r.ca![1]);
  const minx = Math.min(...xs),
    miny = Math.min(...ys),
    range = Math.max(Math.max(...xs) - minx, Math.max(...ys) - miny, 1);
  const projected = ca.map((r) => [
    100 + ((r.ca![0] - minx) / range) * 400,
    100 + ((r.ca![1] - miny) / range) * 400,
  ]);
  const projectedGhost = ghostCa.map((r) => [
    100 + ((r.ca![0] - minx) / range) * 400,
    100 + ((r.ca![1] - miny) / range) * 400,
  ]);
  return (
    <>
      <div
        className="protein-stage"
        data-snapshot={snapshotCount}
        data-source={snapshotSource}
        data-color-mode={colorMode}
        data-selected-residue={selectedKey ?? ""}
        data-render-style={doodle ? "doodle" : "shaded"}
        tabIndex={-1}
      >
        <div className="stage-grid" />
        <div className="orbital orbital-one" />
        <div className="orbital orbital-two" />
        <div
          ref={host}
          className={"molecular-canvas" + (fallback ? " is-unavailable" : "")}
        >
          <canvas ref={canvas} />
        </div>
        {fallback && (
          <svg
            className="protein-fallback"
            viewBox="0 0 600 600"
            aria-label="Two dimensional alpha-carbon coordinates"
          >
            <g
              opacity={comparisonPdb ? 0.45 : 0.3}
              stroke={comparisonPdb ? "#aaa2df" : "#91a7ba"}
              strokeWidth="7"
              strokeLinecap="round"
            >
              {ghostCa
                .slice(1)
                .map((r, i) =>
                  r.chain === ghostCa[i].chain &&
                  Math.hypot(
                    ...r.ca!.map((value, axis) => value - ghostCa[i].ca![axis]),
                  ) < 5 ? (
                    <line
                      key={`ghost-${r.key}`}
                      x1={projectedGhost[i][0]}
                      y1={projectedGhost[i][1]}
                      x2={projectedGhost[i + 1][0]}
                      y2={projectedGhost[i + 1][1]}
                    />
                  ) : null,
                )}
            </g>
            {ca.slice(1).map((r, i) =>
              r.chain === ca[i].chain &&
              Math.hypot(
                ...r.ca!.map((value, axis) => value - ca[i].ca![axis]),
              ) < 5 ? (
                <g key={`bond-${r.key}`} strokeWidth="8" strokeLinecap="round">
                  <line
                    x1={projected[i][0]}
                    y1={projected[i][1]}
                    x2={(projected[i][0] + projected[i + 1][0]) / 2}
                    y2={(projected[i][1] + projected[i + 1][1]) / 2}
                    stroke={colorHex(residueColor(ca[i], colorMode))}
                  />
                  <line
                    x1={(projected[i][0] + projected[i + 1][0]) / 2}
                    y1={(projected[i][1] + projected[i + 1][1]) / 2}
                    x2={projected[i + 1][0]}
                    y2={projected[i + 1][1]}
                    stroke={colorHex(residueColor(r, colorMode))}
                  />
                </g>
              ) : null,
            )}
            {ca.map((r, i) => (
              <circle
                key={r.key}
                data-residue={r.key}
                cx={projected[i][0]}
                cy={projected[i][1]}
                r="5"
                fill={colorHex(residueColor(r, colorMode))}
                onMouseEnter={() => setHoveredKey(r.key)}
                onMouseLeave={() => setHoveredKey(undefined)}
                onClick={() => setSelectedKey(r.key)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    setSelectedKey(r.key);
                  }
                }}
                tabIndex={0}
                role="button"
                aria-label={`Select residue ${r.name} ${r.chain}:${r.number}`}
                stroke={selectedKey === r.key ? "var(--text)" : undefined}
                strokeWidth={selectedKey === r.key ? 4 : undefined}
              >
                <title>
                  {r.name} {r.chain}:{r.number}
                  {r.insertion} ·{" "}
                  {r.energy === undefined
                    ? "energy unavailable"
                    : `${r.energy.toFixed(3)} REU`}
                </title>
              </circle>
            ))}
          </svg>
        )}
        <div className="stage-corner">
          PROTEIN{" "}
          <span className="stage-version">{atoms ? "ATOMS" : "RIBBON"}</span>
        </div>
        <div
          className="structure-label"
          title={
            replay
              ? "Recorded Rosetta calculation; no contribution credit."
              : live
                ? "Coordinates from the current Rosetta calculation."
                : undefined
          }
        >
          <span className={"status-dot " + (live ? "active" : "reference")} />
          {structureLabel ||
            (replay
              ? "RECORDED REPLAY"
              : live
                ? running
                  ? "LIVE STRUCTURE"
                  : "SAVED STRUCTURE"
                : "REFERENCE STRUCTURE")}
          <small>
            {live
              ? `Snapshot ${snapshotCount || 1}${replay ? " · recorded" : running ? (snapshotSource === "packing" ? " · packing" : snapshotSource === "minimizing" ? " · minimizing" : "") : " · saved"}`
              : "Trp-cage · 1L2Y · 20 residues"}
            {running &&
              !replay &&
              !!snapshotStep &&
              ` · ${snapshotSource === "packing" ? "move" : "evaluation"} ${snapshotStep}`}
          </small>
        </div>
        <div className="fullscreen-color-summary">
          <b>
            {colorMode === "sequence" ? "SEQUENCE POSITION" : "RESIDUE ENERGY"}
          </b>
          <i
            style={{
              background: `linear-gradient(90deg, ${ProteinPalette.map((color) => color.hex).join(", ")})`,
            }}
          />
          <span>
            {colorMode === "sequence"
              ? "N / start → C / end"
              : coloring.scoredCount
                ? "≤ −10 · −5 · 0 · +5 · ≥ +10 REU"
                : "Gray · residue scores unavailable"}
          </span>
        </div>
        <div className="stage-toolbar">
          <div className="stage-tools">
            <button
              title="Smooth coordinate motion"
              aria-label="Toggle smooth protein motion"
              aria-pressed={motion && !reduced}
              disabled={fallback || reduced}
              className={motion && !reduced ? "selected" : ""}
              onClick={() => setMotion(!motion)}
            >
              <Activity size={17} />
            </button>
            <button
              title="Reset view"
              aria-label="Reset protein view"
              disabled={fallback}
              onClick={() =>
                plugin.current?.canvas3d?.requestCameraReset({
                  durationMs: 200,
                })
              }
            >
              <RotateCcw size={16} />
            </button>
            <button
              title="Toggle automatic orbit"
              aria-label="Toggle automatic orbit"
              aria-pressed={spin && !reduced}
              disabled={fallback || reduced}
              className={spin && !reduced ? "selected" : ""}
              onClick={() => {
                setSpin(!spin);
                onAutoRotateChange?.(!spin);
              }}
            >
              <Move3D size={17} />
            </button>
            <button
              title="Toggle atoms / ribbon"
              aria-label="Toggle atoms or ribbon"
              aria-pressed={atoms}
              disabled={fallback}
              className={atoms ? "selected" : ""}
              onClick={() => setAtoms(!atoms)}
            >
              <Layers size={16} />
            </button>
            <button
              title="Fullscreen protein"
              aria-label="Fullscreen protein"
              onClick={() => host.current?.parentElement?.requestFullscreen()}
            >
              <Maximize2 size={16} />
            </button>
            {startingPdb && (
              <button
                className={
                  "compare-button " +
                  (compare && !comparisonPdb ? "selected" : "")
                }
                aria-pressed={compare && !comparisonPdb}
                disabled={!!comparisonPdb}
                title={
                  comparisonPdb
                    ? "A timeline base model is selected."
                    : "Align and compare the starting structure"
                }
                onClick={() => setCompare(!compare)}
              >
                Compare start
              </button>
            )}
          </div>
          {onReplay && (
            <button
              className="replay-button"
              aria-label={replayLabel || "Preview a real relaxation"}
              title="Replay a recorded Rosetta calculation"
              onClick={onReplay}
            >
              {replayLabel || "Replay relaxation"} <span>↗</span>
            </button>
          )}
          {onStopReplay && (
            <button className="replay-button" onClick={onStopReplay}>
              Exit replay <span>×</span>
            </button>
          )}
        </div>
        {fallback && (
          <span className="stage-fallback-status">
            2D view · WebGL unavailable
          </span>
        )}
      </div>
      {comparison && (
        <div
          className={
            "protein-comparison-reading" +
            (comparison.status === "unavailable" ? " is-unavailable" : "")
          }
          data-comparison-status={comparison.status}
        >
          <span>
            <i style={{ background: comparisonPdb ? "#aaa2df" : "#91a7ba" }} />
            {comparisonLabel || "Starting structure"}
          </span>
          {comparison.status === "aligned" ? (
            <small>
              Aligned Cα RMSD <b>{comparison.rmsd.toFixed(3)} Å</b> ·{" "}
              {comparison.matchedResidues}
              {comparison.matchedResidues <
              Math.max(comparison.selectedResidues, comparison.baselineResidues)
                ? `/${Math.max(comparison.selectedResidues, comparison.baselineResidues)}`
                : ""}{" "}
              residues
            </small>
          ) : (
            <small>Comparison unavailable · {comparison.reason}</small>
          )}
        </div>
      )}
      <ProteinColorKey
        data={coloring}
        mode={colorMode}
        onModeChange={setColorMode}
        hoveredKey={hoveredKey}
        selectedKey={selectedKey}
        onSelectResidue={setSelectedKey}
      />
    </>
  );
}
