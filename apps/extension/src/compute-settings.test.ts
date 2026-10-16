import { afterEach, expect, it, vi } from "vitest";
import {
  availableCores,
  defaultWorkerCount,
  validWorkerCount,
} from "./compute-settings";
import { readPreferences } from "./storage";
afterEach(() => vi.unstubAllGlobals());
it.each([
  [8, 1],
  [3, 1],
  [1, 1],
  [0, 1],
  [undefined, 1],
  [NaN, 1],
])(
  "defaults to one worker on %s reported logical processors",
  (cores, expected) => {
    vi.stubGlobal("navigator", { hardwareConcurrency: cores });
    expect(defaultWorkerCount()).toBe(expected);
  },
);
it("bounds preferences to the current browser and migrates existing settings", () => {
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
  expect(availableCores()).toBe(8);
  expect(validWorkerCount(99)).toBe(8);
  expect(validWorkerCount(-1)).toBe(1);
  expect(validWorkerCount(2.5)).toBe(1);
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ city: "Geneva" }),
  });
  expect(readPreferences()).toMatchObject({
    workerCount: 1,
    dutyCycle: 10,
    city: "Geneva",
  });
  vi.stubGlobal("localStorage", {
    getItem: () => JSON.stringify({ workerCount: 3 }),
  });
  expect(readPreferences().workerCount).toBe(3);
});
it("upgrades the old default once and preserves distinct or versioned user budgets", () => {
  vi.stubGlobal("navigator", { hardwareConcurrency: 12 });
  const saved = (settings: object) =>
    vi.stubGlobal("localStorage", { getItem: () => JSON.stringify(settings) });
  saved({ workerCount: 6, dutyCycle: 25 });
  expect(readPreferences()).toMatchObject({
    workerCount: 1,
    dutyCycle: 10,
    computeBudgetVersion: 1,
  });
  saved({ workerCount: 2, dutyCycle: 50 });
  expect(readPreferences()).toMatchObject({ workerCount: 2, dutyCycle: 50 });
  saved({ workerCount: 6, dutyCycle: 25, computeBudgetVersion: 1 });
  expect(readPreferences()).toMatchObject({ workerCount: 6, dutyCycle: 25 });
});
