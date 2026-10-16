import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { StructureSnapshot } from "@rosettatab/shared";
import { EnergyChart, nearestSnapshot } from "./EnergyChart";

const frames: StructureSnapshot[] = [0, 1, 2].map((index) => ({
  id: `frame:${index}`,
  sequence: index + 1,
  pdb: "ATOM  ...",
  energy: [20, 1000, -48][index],
  elapsedMs: index * 100,
  historyIndex: [0, 3, 6][index],
}));

describe("coordinate snapshot graph", () => {
  it("renders every available coordinate point at its energy index with one keyboard seek control", () => {
    const markup = renderToStaticMarkup(
      createElement(EnergyChart, {
        history: [20, 15, 6, 1000, 0, -40, -48],
        running: false,
        replay: true,
        loading: false,
        frames,
        selectedFrameId: "frame:2",
        baselineFrameId: "frame:0",
        onSelectFrame: () => {},
      }),
    );
    expect(markup.match(/class="energy-snapshot-point"/g)).toHaveLength(3);
    expect(markup).toContain('data-frame-id="frame:1" cx="353"');
    expect(markup.match(/type="range"/g)).toHaveLength(1);
    expect(markup).toContain("Select protein snapshot");
    expect(markup).toContain("energy-selected-point");
    expect(markup).toContain("energy-baseline-point");
    expect(markup).toContain("ΔE -68.000 REU");
    expect(markup).toContain(
      'class="energy-baseline-point" data-frame-id="frame:0" d="M',
    );
    expect(markup).toContain("7 snapshots, current -48.000");
  });

  it("selects the nearest actual coordinate in both axes rather than a nonexistent energy-only sample", () => {
    const points = [
      { frame: frames[0], x: 20, y: 50 },
      { frame: frames[1], x: 21, y: 3 },
      { frame: frames[2], x: 25, y: 51 },
    ];
    expect(nearestSnapshot(points, 21, 49)?.id).toBe("frame:0");
    expect(nearestSnapshot(points, 20, 1)?.id).toBe("frame:1");
    expect(nearestSnapshot(points, 25, 50)?.id).toBe("frame:2");
    expect(nearestSnapshot([], 5, 5)).toBeUndefined();
  });

  it("does not present the first retained point as a detached selected snapshot", () => {
    const markup = renderToStaticMarkup(
      createElement(EnergyChart, {
        history: [20, 15, 6, 1000, 0, -40, -48],
        running: true,
        replay: false,
        loading: false,
        frames,
        selectedFrameId: "frame:thinned-out",
        baselineFrameId: "frame:0",
        onSelectFrame: () => {},
      }),
    );
    expect(markup).toContain(
      'aria-valuetext="Selected snapshot outside retained graph"',
    );
    expect(markup).toContain(
      'class="snapshot-selected-reading">Selected snapshot outside retained graph',
    );
    expect(markup).not.toContain('class="energy-selected-point"');
    expect(markup).not.toContain("1/3 · 20.000 REU");
    expect(markup).not.toContain("ΔE");
    expect(markup).toContain('type="range"');
  });
});
