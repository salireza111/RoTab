import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Pause, Play, RotateCcw, Timer, X } from "lucide-react";
import {
  focusRemaining,
  formatFocusTime,
  MAX_FOCUS_MINUTES,
  type FocusAction,
  type FocusTimer,
} from "./focus-timer";
import { focusStrand, strandPath } from "./focus-strand";
import "./pomodoro.css";

function FoldingStrand({ timer, now }: { timer: FocusTimer; now: number }) {
  const ref = useRef<SVGSVGElement>(null);
  const id = useId().replace(/:/g, "");
  const [frame, setFrame] = useState(now);
  const running = timer.status === "running" && focusRemaining(timer, now) > 0;
  useEffect(() => {
    if (!running || !ref.current) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let handle = 0,
      intersecting = false,
      previous = 0;
    const draw = (stamp: number) => {
      if (stamp - previous >= 1000 / 24) {
        setFrame(Date.now());
        previous = stamp;
      }
      handle = requestAnimationFrame(draw);
    };
    const refresh = () => {
      cancelAnimationFrame(handle);
      handle = 0;
      if (intersecting && !document.hidden && !motion.matches)
        handle = requestAnimationFrame(draw);
    };
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = entry.isIntersecting;
      refresh();
    });
    observer.observe(ref.current);
    document.addEventListener("visibilitychange", refresh);
    motion.addEventListener("change", refresh);
    return () => {
      cancelAnimationFrame(handle);
      observer.disconnect();
      document.removeEventListener("visibilitychange", refresh);
      motion.removeEventListener("change", refresh);
    };
  }, [running]);
  const progress =
    1 - focusRemaining(timer, Math.max(frame, now)) / timer.durationMs;
  const points = focusStrand(progress);
  const path = strandPath(points);
  return (
    <svg
      ref={ref}
      className="focus-strand"
      viewBox="0 0 320 180"
      role="img"
      aria-labelledby={`${id}-title`}
      data-fold-progress={progress.toFixed(4)}
    >
      <title id={`${id}-title`}>
        Focus timer illustration: a strand folding into Trp-cage
      </title>
      <defs>
        <linearGradient id={`${id}-color`} x1="0" x2="1" y1="0" y2="1">
          <stop className="focus-strand-start" offset="0%" />
          <stop className="focus-strand-end" offset="100%" />
        </linearGradient>
      </defs>
      <path className="focus-strand-outline" d={path} />
      <path
        className="focus-strand-backbone"
        d={path}
        stroke={`url(#${id}-color)`}
      />
      {points.map((point, i) => (
        <circle
          key={i}
          className="focus-residue"
          cx={point.x}
          cy={point.y}
          r={
            i === 0 || i === points.length - 1
              ? 4.3
              : 2.3 + (point.depth + 30) / 60
          }
        />
      ))}
    </svg>
  );
}

export function Pomodoro({
  timer,
  now,
  act,
}: {
  timer: FocusTimer;
  now: number;
  act(action: FocusAction): void;
}) {
  const [editing, setEditing] = useState(false);
  const [parts, setParts] = useState(["0", "25", "0"]);
  const [error, setError] = useState("");
  const firstInput = useRef<HTMLInputElement>(null);
  const editUnit = useRef(1);
  useLayoutEffect(() => {
    if (!editing) return;
    const input =
      firstInput.current?.parentElement?.parentElement?.querySelectorAll(
        "input",
      )[editUnit.current];
    input?.focus();
    input?.select();
  }, [editing]);
  const remaining = focusRemaining(timer, now);
  const complete = remaining === 0;
  const running = timer.status === "running" && !complete;
  const status = complete
    ? "Session complete"
    : running
      ? "Folding"
      : timer.status === "paused"
        ? "Paused"
        : "Ready to focus";
  const openEditor = (index: number) => {
    const seconds = timer.durationMs / 1000;
    setParts([
      String(Math.floor(seconds / 3600)),
      String(Math.floor(seconds / 60) % 60),
      String(seconds % 60),
    ]);
    setError("");
    editUnit.current = index;
    setEditing(true);
  };
  useEffect(() => {
    if (running) setEditing(false);
  }, [running]);
  const commitDuration = () => {
    const [h, m, s] = parts.map(Number),
      seconds = h * 3600 + m * 60 + s;
    if (
      !parts.every((part) => /^\d+$/.test(part)) ||
      m > 59 ||
      s > 59 ||
      seconds < 1 ||
      seconds > MAX_FOCUS_MINUTES * 60
    ) {
      setError("Choose 00:00:01 to 03:00:00.");
      return false;
    }
    act({ type: "duration-seconds", seconds });
    setEditing(false);
    return true;
  };
  const digits = formatFocusTime(remaining).split(":");
  return (
    <div className="pomodoro" data-state={complete ? "complete" : timer.status}>
      <div className="widget-heading">
        <Timer size={15} />
        <span>POMODORO</span>
      </div>
      <div className="pomodoro-body">
        <FoldingStrand timer={timer} now={now} />
        <div className="focus-reading">
          {editing ? (
            <form
              className="focus-time-editor"
              onSubmit={(event) => {
                event.preventDefault();
                commitDuration();
              }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
              }}
            >
              <div className="focus-time-fields">
                {["Hours", "Minutes", "Seconds"].map((label, i) => (
                  <label key={label}>
                    <input
                      ref={i === 0 ? firstInput : undefined}
                      aria-label={`Focus ${label.toLowerCase()}`}
                      type="number"
                      min="0"
                      max={i === 0 ? 3 : 59}
                      step="1"
                      value={parts[i]}
                      onChange={(e) =>
                        setParts((previous) =>
                          previous.map((part, n) =>
                            n === i ? e.target.value : part,
                          ),
                        )
                      }
                    />
                    <span>{label.slice(0, 1).toLowerCase()}</span>
                  </label>
                ))}
              </div>
              <div className="focus-edit-actions">
                <button aria-label="Save focus duration" type="submit">
                  <Check size={16} />
                </button>
                <button
                  aria-label="Cancel duration edit"
                  type="button"
                  onClick={() => setEditing(false)}
                >
                  <X size={16} />
                </button>
              </div>
              {error && (
                <span className="focus-duration-error" role="alert">
                  {error}
                </span>
              )}
            </form>
          ) : (
            <div
              className="focus-time"
              role="timer"
              aria-label="Focus time remaining"
              aria-live="off"
            >
              {digits.map((digit, i) => (
                <span key={i}>
                  {i > 0 && ":"}
                  <button
                    aria-label={`Edit focus ${["hours", "minutes", "seconds"][i + (digits.length === 2 ? 1 : 0)]}`}
                    title="Edit duration"
                    disabled={running}
                    onClick={() =>
                      openEditor(i + (digits.length === 2 ? 1 : 0))
                    }
                  >
                    {digit}
                  </button>
                </span>
              ))}
            </div>
          )}
          <span className="focus-status" role="status">
            {complete && <Check size={13} />}
            {status}
          </span>
        </div>
      </div>
      <div className="focus-controls">
        <div className="focus-buttons">
          <button
            className="focus-toggle"
            aria-label={
              running
                ? "Pause focus timer"
                : complete
                  ? "Start another focus session"
                  : timer.status === "paused"
                    ? "Resume focus timer"
                    : "Start focus timer"
            }
            onClick={() => {
              if (editing && !commitDuration()) return;
              setEditing(false);
              act({ type: running ? "pause" : "start" });
            }}
          >
            {running ? <Pause size={14} /> : <Play size={14} />}
            <span>
              {running
                ? "Pause"
                : complete
                  ? "Again"
                  : timer.status === "paused"
                    ? "Resume"
                    : "Start"}
            </span>
          </button>
          <button
            className="focus-reset"
            aria-label="Reset focus timer"
            title="Reset focus timer"
            disabled={timer.status === "ready"}
            onClick={() => {
              setEditing(false);
              act({ type: "reset" });
            }}
          >
            <RotateCcw size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}
