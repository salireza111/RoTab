import { useEffect, useState } from "react";
import { Activity, Box, MemoryStick } from "lucide-react";
import type { Metric } from "@rosettatab/shared";
import {
  formatResourceBytes,
  readUiHeapMetric,
  resourceTrend,
  visibleResourceMetrics,
} from "./telemetry";

type History = Record<string, { timestamp: number; values: number[] }>;

export function ResourcePanel({ metrics }: { metrics: Metric[] }) {
  const [reading, setReading] = useState(() => ({
      now: Date.now(),
      metric: readUiHeapMetric(
        performance as Performance & {
          memory?: { usedJSHeapSize?: number };
        },
      ),
    })),
    [history, setHistory] = useState<History>({});

  useEffect(() => {
    const sample = () => {
      const now = Date.now();
      setReading({
        now,
        metric: readUiHeapMetric(
          performance as Performance & {
            memory?: { usedJSHeapSize?: number };
          },
          now,
        ),
      });
    };
    const timer = setInterval(sample, 2_000);
    document.addEventListener("visibilitychange", sample);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sample);
    };
  }, []);

  const measured = visibleResourceMetrics(
    [
      ...metrics.filter((metric) => metric.name === "engine"),
      ...(reading.metric ? [reading.metric] : []),
    ],
    Date.now(),
  );

  useEffect(() => {
    const fresh = visibleResourceMetrics(
      [
        ...metrics.filter((metric) => metric.name === "engine"),
        ...(reading.metric ? [reading.metric] : []),
      ],
      Date.now(),
    );
    setHistory((previous) => {
      let next = previous;
      for (const metric of fresh) {
        const samples = previous[metric.name];
        if (samples?.timestamp === metric.timestamp) continue;
        if (next === previous) next = { ...previous };
        next[metric.name] = {
          timestamp: metric.timestamp,
          values: [...(samples?.values ?? []), metric.value!].slice(-24),
        };
      }
      return next;
    });
  }, [metrics, reading]);

  if (!measured.length) return null;
  return (
    <footer className="resource-panel" aria-label="Tab resources">
      <div className="resource-heading">
        <Activity size={15} aria-hidden="true" />
        <span>Tab resources</span>
      </div>
      <div className="resource-metrics">
        {measured.map((metric) => {
          const memory = formatResourceBytes(metric.value!),
            Icon = metric.name === "engine" ? Box : MemoryStick,
            label = metric.name === "engine" ? "WASM heap" : "UI JS heap",
            points = resourceTrend(history[metric.name]?.values ?? []);
          return (
            <div
              className="resource-metric"
              data-metric={metric.name}
              key={metric.name}
              title={`${metric.scope}. ${metric.source}.`}
            >
              <Icon size={16} aria-hidden="true" />
              <span className="resource-label">{label}</span>
              <b className="resource-value">
                {memory.value} <small>{memory.unit}</small>
              </b>
              {points && (
                <svg
                  className="resource-trend"
                  viewBox="0 0 68 26"
                  aria-hidden="true"
                >
                  <polyline points={points} fill="none" />
                </svg>
              )}
            </div>
          );
        })}
      </div>
    </footer>
  );
}
