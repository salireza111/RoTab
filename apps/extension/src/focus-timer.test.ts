import { expect, it } from "vitest";
import {
  changeFocusTimer,
  focusRemaining,
  formatFocusTime,
  newFocusTimer,
  parseFocusTimer,
} from "./focus-timer";
import { focusStrand, strandPath } from "./focus-strand";

it("counts elapsed wall time, pauses precisely, and resumes from the saved remainder", () => {
  const started = changeFocusTimer(newFocusTimer(1), { type: "start" }, 1000);
  expect(focusRemaining(started, 12_250)).toBe(48_750);
  const paused = changeFocusTimer(started, { type: "pause" }, 12_250);
  expect(focusRemaining(paused, 500_000)).toBe(48_750);
  expect(paused.deadline).toBeNull();
  const resumed = changeFocusTimer(paused, { type: "start" }, 500_000);
  expect(resumed.deadline).toBe(548_750);
  expect(focusRemaining(resumed, 548_750)).toBe(0);
});

it("recovers an expired session after suspension or reopening without replaying missed ticks", () => {
  const started = changeFocusTimer(newFocusTimer(25), { type: "start" }, 1000);
  const restored = parseFocusTimer(
    JSON.parse(JSON.stringify(started)),
    2_000_000,
  );
  expect(restored).toMatchObject({
    status: "complete",
    remainingMs: 0,
    deadline: null,
  });
  const again = changeFocusTimer(restored, { type: "start" }, 2_000_000);
  expect(again.deadline).toBe(3_500_000);
  expect(again.remainingMs).toBe(25 * 60_000);
});

it("resets and changes duration without changing an active session by accident", () => {
  const ready = changeFocusTimer(
    newFocusTimer(),
    { type: "duration", minutes: 50 },
    0,
  );
  const running = changeFocusTimer(ready, { type: "start" }, 0);
  expect(
    changeFocusTimer(running, { type: "duration", minutes: 5 }, 10),
  ).toEqual(running);
  expect(changeFocusTimer(running, { type: "start" }, 10)).toEqual(running);
  expect(changeFocusTimer(running, { type: "reset" }, 10)).toEqual(
    newFocusTimer(50),
  );
  expect(
    changeFocusTimer(ready, { type: "duration", minutes: NaN }, 0),
  ).toEqual(ready);
});

it("rejects malformed saved timers and keeps the last fraction of a second visible", () => {
  for (const value of [
    null,
    {},
    { ...newFocusTimer(), remainingMs: -1 },
    { ...newFocusTimer(), status: "running", deadline: null },
  ]) {
    expect(parseFocusTimer(value, 0)).toEqual(newFocusTimer());
  }
  expect(formatFocusTime(60_001)).toBe("01:01");
  expect(formatFocusTime(1)).toBe("00:01");
  expect(formatFocusTime(0)).toBe("00:00");
});

it("shows a straight strand initially and a bounded compact structure at completion", () => {
  const start = focusStrand(0),
    halfway = focusStrand(0.5),
    end = focusStrand(1);
  expect(start.every((point) => point.y === 90)).toBe(true);
  expect(new Set(end.map((point) => point.y)).size).toBeGreaterThan(10);
  const width = (points: typeof start) =>
    Math.max(...points.map((p) => p.x)) - Math.min(...points.map((p) => p.x));
  expect(width(end)).toBeLessThan(width(start) * 0.6);
  for (const points of [start, halfway, end]) {
    expect(points).toHaveLength(20);
    expect(
      points.every((p) => p.x > 0 && p.x < 320 && p.y > 0 && p.y < 180),
    ).toBe(true);
    expect(strandPath(points)).not.toMatch(/NaN|Infinity/);
  }
  expect(focusStrand(-1)).toEqual(start);
  expect(focusStrand(2)).toEqual(end);
});

it("retains second-precision durations across reset, reload, and resuming, with optional hours", () => {
  const ready = changeFocusTimer(newFocusTimer(), { type: "duration-seconds", seconds: 3665 }, 0);
  expect(formatFocusTime(ready.durationMs)).toBe("1:01:05");
  expect(parseFocusTimer(JSON.parse(JSON.stringify(ready)), 0)).toEqual(ready);
  const start = changeFocusTimer(ready, { type: "start" }, 100);
  const pause = changeFocusTimer(start, { type: "pause" }, 1100);
  const resume = changeFocusTimer(pause, { type: "start" }, 3000);
  expect(resume.sessionId).toBe(start.sessionId);
  expect(changeFocusTimer(resume, { type: "reset" }, 4000)).toEqual(ready);
  const short = changeFocusTimer(ready, { type: "duration-seconds", seconds: 5 }, 0);
  expect(parseFocusTimer(short, 0).durationMs).toBe(5000);
  expect(formatFocusTime(short.durationMs)).toBe("00:05");
});
