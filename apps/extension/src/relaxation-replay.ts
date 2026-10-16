import { useCallback, useEffect, useRef, useState } from "react";
import { SOURCE_SHA, type StructureSnapshot } from "@rosettatab/shared";

interface RecordedFrame {
  pdb: string;
  energy: number;
  progress: number;
  elapsedMs: number;
}
interface Recording {
  kind: string;
  sourceSha: string;
  nativeRescore: number;
  frames: RecordedFrame[];
}
interface ReplayRecording {
  frames: StructureSnapshot[];
  history: number[];
}

export const DEFAULT_REPLAY_SPEED = 650;

export function replaySpeed(value: number) {
  return Number.isFinite(value)
    ? Math.max(100, Math.min(5000, Math.round(value)))
    : DEFAULT_REPLAY_SPEED;
}

export function readRelaxationRecording(data: Recording): StructureSnapshot[] {
  if (
    data?.kind !== "recorded-rosetta-relaxation" ||
    data.sourceSha !== SOURCE_SHA ||
    !Array.isArray(data.frames) ||
    data.frames.length < 2 ||
    data.frames.some(
      (frame) =>
        !Number.isFinite(frame?.energy) ||
        typeof frame.pdb !== "string" ||
        !/^ATOM  /m.test(frame.pdb) ||
        !Number.isFinite(frame.elapsedMs) ||
        frame.elapsedMs < 0,
    )
  )
    throw new Error("Invalid relaxation recording.");
  return data.frames.map((frame, index) => ({
    id: `recording:${index + 1}`,
    sequence: index + 1,
    pdb: frame.pdb,
    energy: frame.energy,
    elapsedMs: frame.elapsedMs,
    historyIndex: index,
  }));
}

/** Exact energy history can be supplied when retained coordinates are sparse. */
export function prepareReplay(
  frames: StructureSnapshot[],
  history?: number[],
): ReplayRecording {
  if (
    !frames.length ||
    new Set(frames.map((frame) => frame.id)).size !== frames.length ||
    frames.some(
      (frame) =>
        !frame.id ||
        !Number.isFinite(frame.energy) ||
        !Number.isFinite(frame.elapsedMs) ||
        frame.elapsedMs < 0 ||
        !Number.isInteger(frame.sequence) ||
        typeof frame.pdb !== "string" ||
        !/^ATOM  /m.test(frame.pdb),
    )
  )
    throw new Error("No valid saved protein snapshots are available.");
  if (history !== undefined) {
    if (
      !history.length ||
      history.some((energy) => !Number.isFinite(energy)) ||
      frames.some(
        (frame) =>
          !Number.isInteger(frame.historyIndex) ||
          frame.historyIndex < 0 ||
          frame.historyIndex >= history.length ||
          Math.abs(history[frame.historyIndex] - frame.energy) >
            1e-9 * Math.max(1, Math.abs(frame.energy)),
      )
    )
      throw new Error("The saved snapshot energy history is invalid.");
    return { frames: [...frames], history: [...history] };
  }
  // No unseen energies are fabricated: this replay's history contains only the
  // supplied coordinate frames and uses their own scores in retained order.
  return {
    frames: frames.map((frame, index) => ({ ...frame, historyIndex: index })),
    history: frames.map((frame) => frame.energy),
  };
}

export function useRelaxationReplay(computing: boolean) {
  const [recording, setRecording] = useState<ReplayRecording>();
  const [index, setIndex] = useState(0);
  const [error, setError] = useState("");
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeedState] = useState(DEFAULT_REPLAY_SPEED);
  const generation = useRef(0);
  const computingNow = useRef(computing);
  const pending = useRef<AbortController | undefined>(undefined);
  computingNow.current = computing;
  const stop = useCallback(() => {
    generation.current++;
    pending.current?.abort();
    pending.current = undefined;
    setPlaying(false);
    setRecording(undefined);
    setIndex(0);
    setError("");
  }, []);
  useEffect(() => {
    if (computing) stop();
  }, [computing, stop]);
  useEffect(
    () => () => {
      generation.current++;
      pending.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (!recording || !playing) return;
    if (index >= recording.frames.length - 1) {
      setPlaying(false);
      return;
    }
    const request = generation.current;
    const timer = setInterval(() => {
      if (request !== generation.current || computingNow.current) return;
      if (!document.hidden) {
        setIndex((previous) =>
          Math.min(previous + 1, recording.frames.length - 1),
        );
      }
    }, speed);
    return () => {
      clearInterval(timer);
    };
  }, [recording, index, playing, speed]);
  const start = useCallback(
    async (frames?: StructureSnapshot[], history?: number[]) => {
      const request = ++generation.current;
      pending.current?.abort();
      pending.current = undefined;
      setPlaying(false);
      setRecording(undefined);
      setIndex(0);
      setError("");
      if (computingNow.current) return;
      try {
        let next: ReplayRecording;
        if (frames !== undefined) {
          next = prepareReplay(frames, history);
        } else {
          const controller = new AbortController();
          pending.current = controller;
          const response = await fetch("./fixtures/relaxation-replay.json", {
            signal: controller.signal,
          });
          if (!response.ok)
            throw new Error("The recorded relaxation is unavailable.");
          next = prepareReplay(readRelaxationRecording(await response.json()));
        }
        if (request !== generation.current || computingNow.current) return;
        pending.current = undefined;
        setRecording(next);
        setPlaying(next.frames.length > 1);
      } catch (failure) {
        if (request !== generation.current || computingNow.current) return;
        pending.current = undefined;
        if ((failure as Error).name !== "AbortError")
          setError((failure as Error).message);
      }
    },
    [],
  );
  const selectFrame = useCallback(
    (id: string) => {
      const next =
        recording?.frames.findIndex((frame) => frame.id === id) ?? -1;
      if (next < 0) return;
      generation.current++;
      setPlaying(false);
      setIndex(next);
    },
    [recording],
  );
  const play = useCallback(() => {
    if (!recording || computingNow.current || recording.frames.length < 2)
      return;
    if (index >= recording.frames.length - 1) setIndex(0);
    setPlaying(true);
  }, [recording, index]);
  const pause = useCallback(() => {
    generation.current++;
    setPlaying(false);
  }, []);
  const setSpeed = useCallback(
    (value: number) => setSpeedState(replaySpeed(value)),
    [],
  );
  const frame = recording?.frames[index];
  const history = recording?.history ?? [];
  return {
    start,
    stop,
    play,
    pause,
    selectFrame,
    index,
    frames: recording?.frames ?? [],
    speed,
    setSpeed,
    error,
    active: !!recording,
    playing: !!recording && playing,
    frame: frame
      ? {
          ...frame,
          progress: index / Math.max(1, recording!.frames.length - 1),
        }
      : undefined,
    startingPdb: recording?.frames[0].pdb,
    history,
    bestEnergy: history.length ? Math.min(...history) : undefined,
  };
}
