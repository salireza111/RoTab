import type { StructureSnapshot } from "@rosettatab/shared";

export const HISTORY_LIMIT = 2000;
export const FRAME_LIMIT = 240;
export const FRAME_BYTES_LIMIT = 8 * 1024 ** 2;

export const frameBytes = (frame: StructureSnapshot) =>
  // Account for the UTF-16 string plus a conservative metadata allowance.
  frame.pdb.length * 2 + 256;

/** Keep endpoints and approximately uniform sequence coverage, never synthetic coordinates. */
function thinFrames(frames: StructureSnapshot[], count: number) {
  if (count >= frames.length) return frames;
  if (count < 2) return frames.slice(-count);
  const selected = [frames[0]];
  const first = frames[0].sequence;
  const range = frames.at(-1)!.sequence - first;
  let cursor = 1;
  for (let target = 1; target < count - 1; target++) {
    const wanted = first + (range * target) / (count - 1);
    // Leave enough unselected frames for every remaining target and endpoint.
    const last = frames.length - (count - target);
    while (
      cursor < last &&
      Math.abs(frames[cursor + 1].sequence - wanted) <=
        Math.abs(frames[cursor].sequence - wanted)
    )
      cursor++;
    selected.push(frames[cursor++]);
  }
  selected.push(frames.at(-1)!);
  return selected;
}

export function retainFrames(
  frames: StructureSnapshot[],
  maxCount = FRAME_LIMIT,
  maxBytes = FRAME_BYTES_LIMIT,
) {
  let retained = thinFrames(frames, Math.max(1, maxCount));
  let bytes = retained.reduce((sum, frame) => sum + frameBytes(frame), 0);
  while (bytes > maxBytes && retained.length > 2) {
    // Estimate a new count rather than repeatedly scanning large coordinate strings.
    const count = Math.max(
      2,
      Math.min(
        retained.length - 1,
        Math.floor((retained.length * maxBytes) / bytes),
      ),
    );
    retained = thinFrames(retained, count);
    bytes = retained.reduce((sum, frame) => sum + frameBytes(frame), 0);
  }
  // Supported PDBs fit both endpoints. An unexpectedly large payload must still
  // respect the memory budget; keep the latest only if it itself fits.
  while (bytes > maxBytes && retained.length) {
    bytes -= frameBytes(retained.shift()!);
  }
  return retained;
}

interface FrameState {
  history?: number[];
  frames?: StructureSnapshot[];
}
type FrameInput = Omit<
  StructureSnapshot,
  "id" | "historyIndex" | "sequence"
> & {
  sequence?: number;
};

/** Mutates only the state container; histories and frame arrays remain immutable. */
export function appendFrame(
  state: FrameState,
  attemptId: string,
  input: FrameInput,
  appendEnergy = true,
) {
  const previous = state.history ?? [];
  const overflow = appendEnergy
    ? Math.max(0, previous.length + 1 - HISTORY_LIMIT)
    : 0;
  state.history = appendEnergy
    ? [...previous, input.energy].slice(-HISTORY_LIMIT)
    : previous;
  let frames = (state.frames ?? []).flatMap((frame) => {
    const historyIndex = frame.historyIndex - overflow;
    return historyIndex >= 0
      ? [overflow ? { ...frame, historyIndex } : frame]
      : [];
  });
  const last = frames.at(-1);
  const historyIndex = state.history.length - 1;
  if (
    !appendEnergy &&
    last?.pdb === input.pdb &&
    last.energy === input.energy &&
    last.historyIndex === historyIndex
  ) {
    // A result often repeats the final callback. Mark that same real frame final.
    frames = [
      ...frames.slice(0, -1),
      { ...last, source: input.source ?? last.source },
    ];
  } else {
    const sequence = Math.max(
      (last?.sequence ?? 0) + 1,
      Number.isSafeInteger(input.sequence) ? input.sequence! : 1,
    );
    frames.push({
      ...input,
      sequence,
      elapsedMs: Math.max(0, input.elapsedMs),
      id: `${attemptId}:${sequence}`,
      historyIndex,
    });
  }
  state.frames = retainFrames(frames);
  return { history: state.history, frames: state.frames };
}

export interface FrameDelta {
  reset: boolean;
  additions: StructureSnapshot[];
  order: Array<{ id: string; historyIndex: number }>;
}

/** Timer and telemetry broadcasts do not repeatedly clone all coordinate strings. */
export function makeFrameDelta(
  previous: StructureSnapshot[],
  current: StructureSnapshot[],
  reset: boolean,
): FrameDelta | undefined {
  if (!reset && previous === current) return undefined;
  const known = new Map(previous.map((frame) => [frame.id, frame]));
  return {
    reset,
    additions: current.filter((frame) => {
      const old = known.get(frame.id);
      return (
        reset ||
        !old ||
        old.pdb !== frame.pdb ||
        old.energy !== frame.energy ||
        old.sequence !== frame.sequence ||
        old.elapsedMs !== frame.elapsedMs ||
        old.source !== frame.source ||
        old.step !== frame.step
      );
    }),
    order: current.map(({ id, historyIndex }) => ({ id, historyIndex })),
  };
}

export function applyFrameDelta(
  previous: StructureSnapshot[],
  delta?: FrameDelta,
) {
  if (!delta) return previous;
  const known = new Map(
    (delta.reset ? [] : previous).map((frame) => [frame.id, frame]),
  );
  for (const frame of delta.additions) known.set(frame.id, frame);
  return delta.order.flatMap(({ id, historyIndex }) => {
    const frame = known.get(id);
    return frame
      ? [
          frame.historyIndex === historyIndex
            ? frame
            : { ...frame, historyIndex },
        ]
      : [];
  });
}
