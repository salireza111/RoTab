import { afterEach, expect, it, vi } from "vitest";
import { initialSnapshot, type Metric } from "@rosettatab/shared";
import {
  formatResourceBytes,
  readUiHeapMetric,
  resourceTrend,
  visibleResourceMetrics,
  wasmHeapMetric,
} from "./telemetry";
import { Session } from "./session";

afterEach(() => vi.unstubAllGlobals());

it("keeps UI JavaScript context memory distinct from WASM and total tab RAM", () => {
  const ui = readUiHeapMetric(
    { memory: { usedJSHeapSize: 12 * 1024 ** 2 } },
    10,
  );
  const engine = wasmHeapMetric(256 * 1024 ** 2, 10);
  expect(ui).toMatchObject({
    name: "ui-heap",
    value: 12 * 1024 ** 2,
    scope: "This page's JavaScript execution context (approximate)",
  });
  expect(ui?.source).toContain("may include pages sharing a heap");
  expect(engine).toMatchObject({
    name: "engine",
    value: 256 * 1024 ** 2,
    scope: "Shared scientific worker's allocated WASM linear memory",
  });
  expect(visibleResourceMetrics([ui!, engine!], 10)).toHaveLength(2);
});

it("omits unsupported or restricted browser measurements instead of empty cards", () => {
  expect(readUiHeapMetric({})).toBeUndefined();
  expect(
    readUiHeapMetric({
      get memory(): never {
        throw new DOMException("Restricted", "SecurityError");
      },
    }),
  ).toBeUndefined();
  for (const invalid of [undefined, NaN, Infinity, -1, "123"])
    expect(wasmHeapMetric(invalid)).toBeUndefined();
});

it("drops stale, unavailable, malformed, future and whole-device readings", () => {
  const measured = wasmHeapMetric(128 * 1024 ** 2, 10_000)!;
  const invalid: Metric[] = [
    { ...measured, name: "cpu", unit: "%" },
    { ...measured, name: "ram" },
    { ...measured, name: "gpu", unit: "%" },
    { ...measured, name: "temperature", unit: "°C" },
    { ...measured, name: "fan", unit: "RPM" },
    { ...measured, name: "power", unit: "W" },
    { ...measured, timestamp: 4_999 },
    { ...measured, timestamp: 10_001 },
    { ...measured, value: null },
    { ...measured, value: NaN },
    { ...measured, availability: "restricted" },
    { ...measured, availability: "stale" },
    { ...measured, availability: "unavailable" },
  ];
  expect(visibleResourceMetrics(invalid, 10_000)).toEqual([]);
  expect(visibleResourceMetrics([measured], 15_000)).toEqual([measured]);
  expect(visibleResourceMetrics([measured], 15_001)).toEqual([]);
});

it("uses actual binary byte units and measured sparklines, without fake utilization", () => {
  expect(formatResourceBytes(278_396_928)).toEqual({
    value: "265.5",
    unit: "MiB",
  });
  expect(formatResourceBytes(1.5 * 1024 ** 3)).toEqual({
    value: "1.5",
    unit: "GiB",
  });
  expect(resourceTrend([])).toBe("");
  expect(resourceTrend([12])).toBe("");
  expect(resourceTrend([12, 12])).toBe("0.0,13.0 68.0,13.0");
  expect(resourceTrend([10, 20, 10])).toBe("0.0,22.0 34.0,4.0 68.0,22.0");
});

it("samples only shared worker memory and never calls whole-system APIs", () => {
  const cpu = vi.fn(),
    memory = vi.fn();
  vi.stubGlobal("chrome", {
    system: { cpu: { getInfo: cpu }, memory: { getInfo: memory } },
  });
  const engine = wasmHeapMetric(256 * 1024 ** 2)!,
    session = Object.create(Session.prototype) as Session;
  session.snapshot = {
    ...initialSnapshot(),
    metrics: [engine, { ...engine, name: "ram" }],
  };
  session.sampleMetrics();
  expect(session.snapshot.metrics).toEqual([engine]);
  expect(cpu).not.toHaveBeenCalled();
  expect(memory).not.toHaveBeenCalled();
});

it.each(["pause", "stop"] as const)(
  "removes the worker allocation immediately on %s",
  (command) => {
    const terminate = vi.fn(),
      session = Object.create(Session.prototype) as Session;
    Object.assign(session, {
      owner: true,
      action: Promise.resolve(),
      controlEpoch: 0,
      initialized: false,
      update: vi.fn(),
      channel: { postMessage: vi.fn() },
      worker: { terminate },
      snapshot: {
        ...initialSnapshot(),
        metrics: [wasmHeapMetric(256 * 1024 ** 2)!],
      },
    });
    session.command(command);
    expect(terminate).toHaveBeenCalledOnce();
    expect(session.worker).toBeUndefined();
    expect(session.snapshot.metrics).toEqual([]);
  },
);
