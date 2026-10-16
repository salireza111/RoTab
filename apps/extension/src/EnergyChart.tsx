import { useEffect, useId, useRef, useState } from "react";
import type { StructureSnapshot } from "@rosettatab/shared";
import "./snapshot-graph.css";

export interface SnapshotPoint {
  frame: StructureSnapshot;
  x: number;
  y: number;
}

/** Choose an actual saved coordinate frame, including in densely sampled traces. */
export function nearestSnapshot(points: SnapshotPoint[], x: number, y: number) {
  let nearest: SnapshotPoint | undefined;
  let distance = Infinity;
  for (const point of points) {
    const next = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (next < distance) {
      distance = next;
      nearest = point;
    }
  }
  return nearest?.frame;
}

export function energySeries(history: number[]) {
  const current = history.filter(Number.isFinite);
  let minimum = Infinity;
  const best = current.map((energy) => (minimum = Math.min(minimum, energy)));
  return { current, best };
}

export function EnergyChart({
  history,
  running,
  replay,
  loading,
  frames = [],
  selectedFrameId,
  baselineFrameId,
  onSelectFrame,
  onToggleBaseline,
  canSetBaseline = false,
  protocol,
}: {
  history: number[];
  running: boolean;
  replay: boolean;
  loading: boolean;
  protocol?: string;
  frames?: StructureSnapshot[];
  selectedFrameId?: string;
  baselineFrameId?: string;
  onSelectFrame?: (frame: StructureSnapshot) => void;
  onToggleBaseline?: (frame: StructureSnapshot) => void;
  canSetBaseline?: boolean;
}) {
  const id = useId().replaceAll(":", "");
  const [scale, setScale] = useState<"auto" | "linear" | "compressed">("auto");
  const chart = useRef<SVGSVGElement>(null);
  const [size, setSize] = useState({ width: 660, height: 110 });
  const { current, best } = energySeries(history);
  const hasSamples = current.length > 0;
  useEffect(() => {
    if (!chart.current) return;
    const element = chart.current;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      if (!width || !height) return;
      setSize((previous) =>
        previous.width === width && previous.height === height
          ? previous
          : { width, height },
      );
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [hasSamples]);
  const low = current.length ? Math.min(...current) : -1;
  const high = current.length ? Math.max(...current) : 1;
  const compressed =
    scale === "compressed" || (scale === "auto" && high - low > 200);
  // A signed log-like axis preserves zero, negative energies and large packing
  // peaks. All values/labels remain actual REU; no samples are clipped or lost.
  const project = (energy: number) =>
    compressed ? Math.asinh(energy / 10) : energy;
  const unproject = (value: number) =>
    compressed ? Math.sinh(value) * 10 : value;
  const padding = Math.max(
    compressed ? 0.1 : 1,
    (project(high) - project(low)) * 0.12,
  );
  const min = project(low) - padding,
    max = project(high) + padding;
  const left = 58,
    right = Math.max(left + 1, size.width - 12),
    top = 14,
    bottom = Math.max(top + 1, size.height - 22);
  const x = (i: number) =>
    left + (i / Math.max(1, current.length - 1)) * (right - left);
  const y = (e: number) =>
    top + ((max - project(e)) / (max - min)) * (bottom - top);
  const path = (values: number[]) =>
    values
      .map((e, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(e).toFixed(2)}`)
      .join(" ");
  const last = current.at(-1),
    change = last === undefined ? 0 : best.at(-1)! - current[0];
  const points = frames
    .filter((frame) => Number.isFinite(frame.energy))
    .map((frame) => ({
      frame,
      x: x(Math.max(0, Math.min(current.length - 1, frame.historyIndex))),
      y: y(frame.energy),
    }));
  const selectedIndex = Math.max(
    0,
    points.findIndex(({ frame }) => frame.id === selectedFrameId),
  );
  const selectedFrame = points[selectedIndex]?.frame;
  const baselineFrame = points.find(
    ({ frame }) => frame.id === baselineFrameId,
  )?.frame;
  const selectedPoint = points.find(
    ({ frame }) => frame.id === selectedFrameId,
  );
  const detachedSelection = selectedFrameId !== undefined && !selectedPoint;
  const baselinePoint = points.find(
    ({ frame }) => frame.id === baselineFrameId,
  );
  const activatePoint = (frame: StructureSnapshot) => {
    if (canSetBaseline && frame.id === selectedFrameId && onToggleBaseline)
      onToggleBaseline(frame);
    else onSelectFrame?.(frame);
  };
  const pointAction = (frame: StructureSnapshot) =>
    canSetBaseline && frame.id === selectedFrameId && onToggleBaseline
      ? frame.id === baselineFrameId
        ? "clear baseline"
        : "set as baseline"
      : "select";
  const pointAtPointer = (clientX: number, clientY: number) => {
    const bounds = chart.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds.height) return undefined;
    return nearestSnapshot(
      points,
      ((clientX - bounds.left) / bounds.width) * size.width,
      ((clientY - bounds.top) / bounds.height) * size.height,
    );
  };
  return (
    <div
      className={"energy-chart" + (running ? " is-live" : "")}
      data-scale={compressed ? "compressed" : "linear"}
    >
      <div className="energy-chart-heading">
        <span>
          <i className="status-dot" />{" "}
          {replay ? "RECORDED ENERGY" : running ? "LIVE ENERGY" : "ENERGY"}
        </span>
        <div>
          <span className="legend-current">
            {replay ? "Final" : "Current"}
            {last !== undefined && <b> {last.toFixed(3)}</b>}
          </span>
          <span className="legend-best">
            Best{best.length > 0 && <b> {best.at(-1)!.toFixed(3)}</b>}
          </span>
        </div>
      </div>
      {current.length ? (
        <svg
          ref={chart}
          viewBox={`0 0 ${size.width} ${size.height}`}
          preserveAspectRatio="none"
          role={onSelectFrame && points.length ? "group" : "img"}
          aria-label={`Rosetta energy history: ${current.length} snapshots, current ${last!.toFixed(3)}, best ${best.at(-1)!.toFixed(3)} REU`}
          className={
            onSelectFrame && points.length
              ? "has-selectable-snapshots"
              : undefined
          }
          onPointerDown={
            onSelectFrame && points.length
              ? (event) => {
                  const frame = pointAtPointer(event.clientX, event.clientY);
                  if (frame) onSelectFrame(frame);
                }
              : undefined
          }
        >
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop stopColor="#80dfc5" stopOpacity="0.14" />
              <stop offset="1" stopColor="#80dfc5" stopOpacity="0" />
            </linearGradient>
          </defs>
          <text x="0" y="10" className="energy-axis">
            REU
          </text>
          {[high, unproject((project(high) + project(low)) / 2), low]
            .filter((e, i, all) => all.indexOf(e) === i)
            .map((energy) => (
              <g key={energy} className="energy-grid">
                <line x1={left} x2={right} y1={y(energy)} y2={y(energy)} />
                <text x={left - 8} y={y(energy) + 3} textAnchor="end">
                  {energy.toFixed(1)}
                </text>
              </g>
            ))}
          <path
            d={`${path(best)} L${x(best.length - 1)},${bottom} L${left},${bottom} Z`}
            fill={`url(#${id})`}
          />
          <path className="current-energy-trace" d={path(current)} />
          <path className="best-energy-trace" d={path(best)} />
          <circle
            className="energy-head"
            cx={x(current.length - 1)}
            cy={y(last!)}
            r="3.5"
          />
          {points.map(({ frame, x, y }) => (
            <g
              key={frame.id}
              className="energy-snapshot-target"
              role={onSelectFrame ? "button" : undefined}
              tabIndex={onSelectFrame && frame.id === selectedFrameId ? 0 : -1}
              aria-label={`Snapshot ${frame.sequence}, ${frame.energy.toFixed(3)} REU, ${pointAction(frame)}`}
              aria-pressed={frame.id === baselineFrameId}
              onPointerDown={(event) => {
                if (!onSelectFrame) return;
                event.stopPropagation();
                // Neighboring hit areas overlap on dense traces. Resolve the
                // nearest visible dot instead of whichever SVG group is on top.
                const nearest = pointAtPointer(event.clientX, event.clientY);
                if (nearest) activatePoint(nearest);
              }}
              onClick={(event) => {
                if (event.detail === 0) activatePoint(frame);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                if (!event.repeat) activatePoint(frame);
              }}
            >
              <title>{`Snapshot ${frame.sequence} · ${frame.energy.toFixed(3)} REU · ${pointAction(frame)}`}</title>
              <circle className="energy-snapshot-hit" cx={x} cy={y} r="8" />
              <circle
                className="energy-snapshot-point"
                data-frame-id={frame.id}
                cx={x}
                cy={y}
                r="2.6"
              />
            </g>
          ))}
          {baselinePoint && (
            <path
              className="energy-baseline-point"
              data-frame-id={baselinePoint.frame.id}
              d={`M${baselinePoint.x},${baselinePoint.y - 8} l6,8 l-6,8 l-6,-8 Z`}
            />
          )}
          {selectedPoint && (
            <circle
              className="energy-selected-point"
              cx={selectedPoint.x}
              cy={selectedPoint.y}
              r="4.5"
            />
          )}
          <text x={left} y={size.height - 3} className="energy-axis">
            1
          </text>
          <text
            x={(left + right) / 2}
            y={size.height - 3}
            textAnchor="middle"
            className="energy-axis"
          >
            Snapshots
          </text>
          {current.length > 1 && (
            <text
              x={right}
              y={size.height - 3}
              textAnchor="end"
              className="energy-axis"
            >
              {current.length}
            </text>
          )}
        </svg>
      ) : (
        <div className="energy-empty">
          <span className="empty-energy-line" />
          <span role="status">
            {loading ? "Initializing…" : "No energy data"}
          </span>
        </div>
      )}
      {!!points.length && onSelectFrame && (
        <div className="snapshot-seek">
          <label>
            <span>Snapshot</span>
            <input
              type="range"
              aria-label="Select protein snapshot"
              aria-valuetext={
                detachedSelection
                  ? "Selected snapshot outside retained graph"
                  : `Snapshot ${selectedFrame.sequence}, ${selectedFrame.energy.toFixed(3)} Rosetta Energy Units`
              }
              min="0"
              max={points.length - 1}
              step="1"
              value={selectedIndex}
              onChange={(event) => {
                const frame = points[Number(event.currentTarget.value)]?.frame;
                if (frame) onSelectFrame(frame);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                if (!selectedPoint || !onToggleBaseline) return;
                event.preventDefault();
                if (!event.repeat) activatePoint(selectedPoint.frame);
              }}
            />
          </label>
          <output className="snapshot-seek-reading" aria-live="off">
            <span className="snapshot-selected-reading">
              {detachedSelection
                ? "Selected snapshot outside retained graph"
                : `${selectedIndex + 1}/${points.length} · ${selectedFrame.energy.toFixed(3)} REU`}
            </span>
            {baselineFrame && (
              <span className="snapshot-baseline-reading">
                {!detachedSelection &&
                  `ΔE ${(selectedFrame.energy - baselineFrame.energy).toFixed(3)} REU`}
              </span>
            )}
          </output>
        </div>
      )}
      {current.length > 0 && (
        <div className="energy-chart-foot">
          <span>
            {points.length > 0 && points.length !== current.length
              ? `${current.length} energy samples · ${points.length} saved structures`
              : `${current.length} ${current.length === 1 ? "snapshot" : "snapshots"}`}
            {compressed && " · compressed scale"}
          </span>
          <span>
            {current.length > 1 && (
              <span title="Change in best Rosetta energy from the starting snapshot">
                {change.toFixed(2)} REU
              </span>
            )}
            {current.length > 1 && (
              <button
                type="button"
                className="energy-scale-button"
                title="Compress large packing-energy spikes to see lower-energy changes. All samples and exact scores are retained."
                onClick={() => setScale(compressed ? "linear" : "compressed")}
              >
                {compressed ? "Linear scale" : "Compress peaks"}
              </button>
            )}
          </span>
        </div>
      )}
      {protocol === "score" && current.length > 0 && (
        <p className="energy-protocol-note">
          Fixed-coordinate Score evaluates the same structure at the start and
          end; it does not fold or minimize it. Choose FastRelax or Minimize for
          an optimization trajectory.
        </p>
      )}
    </div>
  );
}
