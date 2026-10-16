import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import { ResourcePanel } from "./ResourcePanel";
import { readUiHeapMetric, wasmHeapMetric } from "./telemetry";

afterEach(() => vi.unstubAllGlobals());

it("renders no resource container when the browser exposes no measurements", () => {
  vi.stubGlobal("performance", {});
  expect(
    renderToStaticMarkup(createElement(ResourcePanel, { metrics: [] })),
  ).toBe("");
});

it("uses this viewing tab's JS heap instead of another tab's broadcast value", () => {
  vi.stubGlobal("performance", {
    memory: { usedJSHeapSize: 12 * 1024 ** 2 },
  });
  const markup = renderToStaticMarkup(
    createElement(ResourcePanel, {
      metrics: [
        readUiHeapMetric({ memory: { usedJSHeapSize: 99 * 1024 ** 2 } })!,
        wasmHeapMetric(256 * 1024 ** 2)!,
      ],
    }),
  );
  expect(markup).toContain('aria-label="Tab resources"');
  expect(markup).toContain("UI JS heap");
  expect(markup).toContain("12.0");
  expect(markup).not.toContain("99.0");
  expect(markup).toContain("WASM heap");
  expect(markup).toContain("256.0");
  expect(markup).toContain("MiB");
  expect(markup).not.toContain("Unavailable");
  expect(markup).toContain("approximate");
});

it("hides stale worker memory and cannot reuse broadcast UI memory as a fallback", () => {
  vi.stubGlobal("performance", {});
  const markup = renderToStaticMarkup(
    createElement(ResourcePanel, {
      metrics: [
        readUiHeapMetric({ memory: { usedJSHeapSize: 99 * 1024 ** 2 } })!,
        wasmHeapMetric(256 * 1024 ** 2, Date.now() - 6_000)!,
      ],
    }),
  );
  expect(markup).toBe("");
});
