import { Pause, Play, Radio } from "lucide-react";
import type { StructureSnapshot } from "@rosettatab/shared";
import "./snapshot-inspector.css";

function time(milliseconds: number) {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function SnapshotInspector({
  selected,
  baseline,
  replay,
  playing,
  inspecting,
  running,
  speed,
  onTogglePlayback,
  onSpeedChange,
  onFollowLatest,
}: {
  selected?: StructureSnapshot;
  baseline?: StructureSnapshot;
  replay: boolean;
  playing: boolean;
  inspecting: boolean;
  running: boolean;
  speed: number;
  onTogglePlayback: () => void;
  onSpeedChange: (milliseconds: number) => void;
  onFollowLatest: () => void;
}) {
  if (!selected) return null;
  const difference = baseline ? selected.energy - baseline.energy : undefined;
  return (
    <section className="snapshot-inspector" aria-label="Snapshot comparison">
      <div className="snapshot-inspector-current">
        <span className="snapshot-inspector-label">
          {baseline ? "STATE 2" : "VIEWING"}
        </span>
        <strong>Snapshot {selected.sequence}</strong>
        <span>
          {time(selected.elapsedMs)} <i>·</i> {selected.energy.toFixed(3)} REU
        </span>
      </div>
      {baseline && (
        <div
          className="snapshot-inspector-baseline"
          data-baseline-id={baseline.id}
        >
          <span className="snapshot-inspector-label">STATE 1 · BASELINE</span>
          <strong>Snapshot {baseline.sequence}</strong>
          <span>
            {baseline.energy.toFixed(3)} REU <i>·</i> ΔE{" "}
            {difference! >= 0 ? "+" : ""}
            {difference!.toFixed(3)} REU
          </span>
        </div>
      )}
      <div className="snapshot-inspector-actions">
        {replay && (
          <div className="snapshot-playback">
            <button
              type="button"
              onClick={onTogglePlayback}
              aria-label={playing ? "Pause replay" : "Play replay"}
            >
              {playing ? <Pause size={14} /> : <Play size={14} />}
              {playing ? "Pause" : "Play"}
            </button>
            <select
              aria-label="Replay speed"
              value={speed}
              onChange={(event) => onSpeedChange(Number(event.target.value))}
            >
              <option value={1300}>0.5×</option>
              <option value={650}>1×</option>
              <option value={325}>2×</option>
            </select>
          </div>
        )}
        {!replay && inspecting && (
          <button type="button" onClick={onFollowLatest}>
            <Radio size={14} /> {running ? "Follow live" : "Latest structure"}
          </button>
        )}
      </div>
    </section>
  );
}
