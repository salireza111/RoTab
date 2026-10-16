import type { Metric } from "@rosettatab/shared";

export const RESOURCE_FRESHNESS_MS = 5_000;

type HeapPerformance = {
  readonly memory?: { readonly usedJSHeapSize?: number };
};

// Chromium's legacy heap reading describes its JavaScript execution context,
// not the tab's total RAM. Keep this distinct from the worker's WASM allocation.
export function readUiHeapMetric(
  performance: HeapPerformance,
  timestamp = Date.now(),
): Metric | undefined {
  try {
    const bytes = performance.memory?.usedJSHeapSize;
    if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0)
      return undefined;
    return {
      name: "ui-heap",
      value: bytes,
      unit: "bytes",
      scope: "This page's JavaScript execution context (approximate)",
      source:
        "Browser performance.memory; may include pages sharing a heap, excludes separate worker heaps and GPU memory",
      timestamp,
      availability: "available",
    };
  } catch {
    return undefined;
  }
}

export function wasmHeapMetric(
  bytes: unknown,
  timestamp = Date.now(),
): Metric | undefined {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0)
    return undefined;
  return {
    name: "engine",
    value: bytes,
    unit: "bytes",
    scope: "Shared scientific worker's allocated WASM linear memory",
    source:
      "WebAssembly HEAPU8.byteLength; excludes compiled code, JavaScript, viewer and browser process memory",
    timestamp,
    availability: "available",
  };
}

export function visibleResourceMetrics(
  metrics: readonly Metric[],
  timestamp = Date.now(),
): Metric[] {
  // Deliberately allow only measurements we can attribute to this interface or
  // its shared worker. Older snapshots cannot reintroduce whole-system totals.
  return ["ui-heap", "engine"].flatMap((name) => {
    const metric = metrics.findLast(
      (candidate) =>
        candidate.name === name &&
        candidate.unit === "bytes" &&
        candidate.availability === "available" &&
        typeof candidate.value === "number" &&
        Number.isFinite(candidate.value) &&
        candidate.value >= 0 &&
        Number.isFinite(candidate.timestamp) &&
        timestamp >= candidate.timestamp &&
        timestamp - candidate.timestamp <= RESOURCE_FRESHNESS_MS,
    );
    return metric ? [metric] : [];
  });
}

export function formatResourceBytes(bytes: number): {
  value: string;
  unit: string;
} {
  const [scale, unit] =
    bytes >= 1024 ** 3
      ? [1024 ** 3, "GiB"]
      : bytes >= 1024 ** 2
        ? [1024 ** 2, "MiB"]
        : [1024, "KiB"];
  return { value: (bytes / Number(scale)).toFixed(1), unit: String(unit) };
}

export function resourceTrend(values: readonly number[]): string {
  if (values.length < 2) return "";
  const low = Math.min(...values),
    high = Math.max(...values),
    span = high - low;
  return values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * 68;
      const y = span > 0 ? 22 - ((value - low) / span) * 18 : 13;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}
