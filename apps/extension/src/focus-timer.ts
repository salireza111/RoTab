export const FOCUS_TIMER_KEY = "rotab:focus-timer:v1";
const MINUTE = 60_000;
export const MAX_FOCUS_MINUTES = 180;

export interface FocusTimer {
  version: 1;
  durationMs: number;
  remainingMs: number;
  deadline: number | null;
  status: "ready" | "running" | "paused" | "complete";
  sessionId?: string;
}
export type FocusAction =
  | { type: "start" | "pause" | "reset" }
  | { type: "duration"; minutes: number }
  | { type: "duration-seconds"; seconds: number };

export function newFocusTimer(minutes = 25): FocusTimer {
  return timerWithSeconds(
    Math.round(Math.max(1, Math.min(MAX_FOCUS_MINUTES, minutes))) * 60,
  );
}

function timerWithSeconds(seconds: number): FocusTimer {
  const durationMs =
    Math.round(Math.max(1, Math.min(MAX_FOCUS_MINUTES * 60, seconds))) * 1000;
  return {
    version: 1,
    durationMs,
    remainingMs: durationMs,
    deadline: null,
    status: "ready",
  };
}

export function focusRemaining(timer: FocusTimer, now: number): number {
  return Math.max(
    0,
    Math.min(
      timer.durationMs,
      timer.status === "running"
        ? (timer.deadline ?? now) - now
        : timer.remainingMs,
    ),
  );
}

function settle(timer: FocusTimer, now: number): FocusTimer {
  return timer.status === "running" && focusRemaining(timer, now) === 0
    ? { ...timer, remainingMs: 0, deadline: null, status: "complete" }
    : timer;
}

// Store a deadline rather than subtracting interval ticks: suspended tabs,
// reloads and other RoTab tabs all observe the same session.
export function parseFocusTimer(value: unknown, now: number): FocusTimer {
  if (!value || typeof value !== "object") return newFocusTimer();
  const timer = value as FocusTimer;
  if (
    timer.version !== 1 ||
    !Number.isInteger(timer.durationMs) ||
    timer.durationMs < 1000 ||
    timer.durationMs > MAX_FOCUS_MINUTES * MINUTE ||
    !Number.isFinite(timer.remainingMs) ||
    timer.remainingMs < 0 ||
    timer.remainingMs > timer.durationMs ||
    !["ready", "running", "paused", "complete"].includes(timer.status) ||
    (timer.status === "running" &&
      (typeof timer.deadline !== "number" || !Number.isFinite(timer.deadline)))
  )
    return newFocusTimer();
  if (timer.status === "ready")
    return timerWithSeconds(timer.durationMs / 1000);
  if (timer.status === "complete")
    return { ...timer, deadline: null, remainingMs: 0 };
  return settle(
    { ...timer, deadline: timer.status === "running" ? timer.deadline : null },
    now,
  );
}

export function changeFocusTimer(
  current: FocusTimer,
  action: FocusAction,
  now: number,
): FocusTimer {
  const timer = settle(current, now);
  switch (action.type) {
    case "duration":
      return timer.status === "running" || !Number.isFinite(action.minutes)
        ? timer
        : newFocusTimer(action.minutes);
    case "duration-seconds":
      return timer.status === "running" || !Number.isFinite(action.seconds)
        ? timer
        : timerWithSeconds(action.seconds);
    case "reset":
      return timerWithSeconds(timer.durationMs / 1000);
    case "pause":
      return timer.status !== "running"
        ? timer
        : {
            ...timer,
            remainingMs: focusRemaining(timer, now),
            deadline: null,
            status: "paused",
          };
    case "start": {
      if (timer.status === "running") return timer;
      const remainingMs =
        timer.status === "complete" ? timer.durationMs : timer.remainingMs;
      return {
        ...timer,
        remainingMs,
        deadline: now + remainingMs,
        status: "running",
        sessionId:
          timer.status === "paused" && timer.sessionId
            ? timer.sessionId
            : crypto.randomUUID(),
      };
    }
  }
}

export function formatFocusTime(remainingMs: number): string {
  const seconds = Math.ceil(Math.max(0, remainingMs) / 1000);
  const hours = Math.floor(seconds / 3600);
  const clock = `${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  return hours ? `${hours}:${clock}` : clock;
}
