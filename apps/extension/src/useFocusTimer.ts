import { useEffect, useRef, useState } from "react";
import {
  changeFocusTimer,
  FOCUS_TIMER_KEY,
  focusRemaining,
  parseFocusTimer,
  type FocusAction,
  type FocusTimer,
} from "./focus-timer";

function readTimer(now = Date.now()): FocusTimer {
  try {
    return parseFocusTimer(
      JSON.parse(localStorage.getItem(FOCUS_TIMER_KEY) ?? "null"),
      now,
    );
  } catch {
    return parseFocusTimer(null, now);
  }
}
const CHIME_KEY = "rotab:focus-chimed:v1";

/** One shared deadline, with browser-only sound and a per-tab favicon. */
export function useFocusTimer() {
  const [timer, setTimer] = useState(readTimer);
  const [now, setNow] = useState(Date.now);
  const audio = useRef<AudioContext | undefined>(undefined);
  const observedSession = useRef<string | undefined>(undefined);
  const remaining = focusRemaining(timer, now);
  useEffect(() => {
    const refresh = () => {
      const time = Date.now();
      setTimer(readTimer(time));
      setNow(time);
    };
    const storage = (e: StorageEvent) => {
      if (e.key === FOCUS_TIMER_KEY || e.key === null) refresh();
    };
    window.addEventListener("storage", storage);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("storage", storage);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  useEffect(() => {
    if (timer.status !== "running") return;
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, [timer.status]);
  useEffect(() => {
    if (timer.status === "running")
      observedSession.current =
        timer.sessionId ?? `${timer.deadline}:${timer.durationMs}`;
    if (timer.status === "ready") observedSession.current = undefined;
    if (remaining > 0 || !observedSession.current) return;
    const id = observedSession.current;
    observedSession.current = undefined;
    void navigator.locks.request("rotab-focus-completion", async () => {
      const current = readTimer();
      // A reset or a different session in another tab supersedes this tick.
      if (
        (current.sessionId ?? `${timer.deadline}:${current.durationMs}`) !==
          id ||
        current.status !== "complete"
      )
        return;
      if (timer.status !== "complete") {
        localStorage.setItem(FOCUS_TIMER_KEY, JSON.stringify(current));
        setTimer(current);
      }
      if (
        audio.current?.state !== "running" ||
        localStorage.getItem(CHIME_KEY) === id
      )
        return;
      localStorage.setItem(CHIME_KEY, id);
      const context = audio.current;
      const start = context.currentTime;
      // A quiet two-note bell with a short attack and a decaying tail.
      for (const [offset, frequency] of [
        [0, 880],
        [0.18, 1174.66],
      ]) {
        const oscillator = context.createOscillator(),
          gain = context.createGain();
        oscillator.type = "sine";
        oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(0, start + offset);
        gain.gain.linearRampToValueAtTime(0.16, start + offset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.001, start + offset + 1.2);
        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start + offset);
        oscillator.stop(start + offset + 1.25);
        oscillator.onended = () => {
          oscillator.disconnect();
          gain.disconnect();
        };
      }
    });
  }, [timer, remaining]);
  useEffect(
    () => () => {
      void audio.current?.close();
    },
    [],
  );

  const act = (action: FocusAction) => {
    if (action.type === "start") {
      try {
        audio.current ??= new AudioContext();
        void audio.current.resume().catch(() => {});
      } catch {
        /* A device without audio still has a working timer. */
      }
    }
    const time = Date.now(),
      next = changeFocusTimer(readTimer(time), action, time);
    localStorage.setItem(FOCUS_TIMER_KEY, JSON.stringify(next));
    setTimer(next);
    setNow(time);
  };
  return { timer, now, act };
}
