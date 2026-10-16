import { describe, expect, it } from "vitest";
import { SOURCE_SHA, type StructureSnapshot } from "@rosettatab/shared";
import {
  DEFAULT_REPLAY_SPEED,
  prepareReplay,
  readRelaxationRecording,
  replaySpeed,
} from "./relaxation-replay";

const atom =
  "ATOM      1  CA  ALA A   1       0.000   0.000   0.000  1.00  0.00           C";
const frames: StructureSnapshot[] = [
  {
    id: "live:1",
    sequence: 1,
    pdb: atom,
    energy: 4,
    elapsedMs: 0,
    historyIndex: 0,
  },
  {
    id: "live:7",
    sequence: 7,
    pdb: atom,
    energy: -2,
    elapsedMs: 700,
    historyIndex: 6,
  },
];

describe("saved structure replay", () => {
  it("makes every retained coordinate available immediately and preserves exact supplied history", () => {
    const history = [4, 5, 1, -1, 3, 2, -2];
    const replay = prepareReplay(frames, history);
    expect(replay.frames.map((frame) => frame.id)).toEqual([
      "live:1",
      "live:7",
    ]);
    expect(replay.frames[1].historyIndex).toBe(6);
    expect(replay.history).toEqual(history);
    expect(replay.history).not.toBe(history);
  });

  it("uses only known coordinate scores without inventing missing history values", () => {
    const replay = prepareReplay(frames);
    expect(replay.history).toEqual([4, -2]);
    expect(replay.frames.map((frame) => frame.historyIndex)).toEqual([0, 1]);
    expect(frames[1].historyIndex).toBe(6);
  });

  it("rejects empty or ambiguous frames and mismatched history instead of falling back to a different recording", () => {
    expect(() => prepareReplay([])).toThrow("No valid saved");
    expect(() => prepareReplay([frames[0], frames[0]])).toThrow(
      "No valid saved",
    );
    expect(() => prepareReplay(frames, [4, -2])).toThrow("history is invalid");
    expect(() => prepareReplay(frames, [4, 5, 1, -1, 3, 2, 8])).toThrow(
      "history is invalid",
    );
    expect(() => prepareReplay(frames, [4, NaN, 1, 2, 3, 4, -2])).toThrow(
      "history is invalid",
    );
  });

  it("admits only the pinned built-in Rosetta recording with valid coordinates and timestamps", () => {
    const recording = {
      kind: "recorded-rosetta-relaxation",
      sourceSha: SOURCE_SHA,
      nativeRescore: -2,
      frames: frames.map((frame, i) => ({ ...frame, progress: i })),
    };
    expect(
      readRelaxationRecording(recording).map((frame) => frame.sequence),
    ).toEqual([1, 2]);
    expect(() =>
      readRelaxationRecording({ ...recording, sourceSha: "different" }),
    ).toThrow("Invalid");
    expect(() =>
      readRelaxationRecording({
        ...recording,
        frames: [
          recording.frames[0],
          { ...recording.frames[1], elapsedMs: -1 },
        ],
      }),
    ).toThrow("Invalid");
  });

  it("keeps replay speed bounded with a responsive default", () => {
    expect(DEFAULT_REPLAY_SPEED).toBe(650);
    expect(replaySpeed(0)).toBe(100);
    expect(replaySpeed(100_000)).toBe(5000);
    expect(replaySpeed(NaN)).toBe(DEFAULT_REPLAY_SPEED);
  });
});
