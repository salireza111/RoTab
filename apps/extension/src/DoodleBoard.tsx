import { memo, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import {
  Eraser,
  Expand,
  Pencil,
  StickyNote,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { Modal } from "./Modal";
import {
  BOARD_WIDTH,
  BOARD_HEIGHT,
  NOTE_WIDTH,
  NOTE_HEIGHT,
  MAX_STROKES,
  MAX_POINTS,
  MAX_NOTES,
  PEN_COLORS,
  normalizeDoodle,
  type BoardStroke,
  type BoardNote,
} from "./personal-widgets";
import { usePersonalWidget } from "./usePersonalWidget";

const strokePath = (stroke: BoardStroke) =>
  stroke.points.map(([x, y], i) => `${i ? "L" : "M"}${x},${y}`).join(" ") +
  (stroke.points.length === 1 ? " l0.1,0.1" : "");
const SavedStroke = memo(function SavedStroke({
  stroke,
}: {
  stroke: BoardStroke;
}) {
  const path = strokePath(stroke);
  return (
    <g>
      <path
        d={path}
        fill="none"
        stroke={stroke.color === "ink" ? "var(--text)" : stroke.color}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
        pointerEvents="none"
      />
      <path
        data-stroke={stroke.id}
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth="18"
        pointerEvents="stroke"
      />
    </g>
  );
});
export const DoodleBoard = memo(function DoodleBoard({
  roomy = false,
}: {
  roomy?: boolean;
}) {
  const { data, ready, saving, error, mutate } = usePersonalWidget(
    "personal-doodle-v1",
    normalizeDoodle,
  );
  const [expanded, setExpanded] = useState(false),
    [tool, setTool] = useState<"pen" | "eraser">("pen"),
    [color, setColor] = useState<string>("ink");
  const [live, setLive] = useState<BoardStroke>(),
    [clearing, setClearing] = useState(false);
  const drawing = useRef<BoardStroke | undefined>(undefined),
    erasing = useRef(false),
    erased = useRef(new Set<string>()),
    surface = useRef<HTMLDivElement>(null),
    sheet = useRef<HTMLDivElement>(null);
  const [dragged, setDragged] = useState<{
    id: string;
    x: number;
    y: number;
  }>();
  const drag = useRef<{ note: BoardNote; start: [number, number] } | undefined>(
    undefined,
  );
  const point = (event: {
    clientX: number;
    clientY: number;
  }): [number, number] => {
    const box = sheet.current!.getBoundingClientRect();
    return [
      Math.round(
        Math.max(
          0,
          Math.min(
            BOARD_WIDTH,
            ((event.clientX - box.left) / box.width) * BOARD_WIDTH,
          ),
        ) * 10,
      ) / 10,
      Math.round(
        Math.max(
          0,
          Math.min(
            BOARD_HEIGHT,
            ((event.clientY - box.top) / box.height) * BOARD_HEIGHT,
          ),
        ) * 10,
      ) / 10,
    ];
  };
  const erase = (event: { clientX: number; clientY: number }) => {
    const id = document
      .elementFromPoint(event.clientX, event.clientY)
      ?.closest("[data-stroke]")
      ?.getAttribute("data-stroke");
    if (id && !erased.current.has(id)) {
      erased.current.add(id);
      void mutate((previous) => ({
        ...previous,
        strokes: previous.strokes.filter((stroke) => stroke.id !== id),
      }));
    }
  };
  const finish = () => {
    const stroke = drawing.current;
    drawing.current = undefined;
    erasing.current = false;
    if (stroke)
      void mutate((previous) => ({
        ...previous,
        strokes:
          previous.strokes.length < MAX_STROKES
            ? [...previous.strokes, stroke]
            : previous.strokes,
      })).then(() => setLive(undefined));
  };
  const editor = (large: boolean) => (
    <div className="doodle-editor">
      <div className="doodle-toolbar" role="toolbar" aria-label="Drawing tools">
        <button
          title="Pen"
          aria-label="Pen"
          aria-pressed={tool === "pen"}
          onClick={() => setTool("pen")}
        >
          <Pencil size={15} />
        </button>
        <button
          title="Erase a stroke"
          aria-label="Eraser"
          aria-pressed={tool === "eraser"}
          onClick={() => setTool("eraser")}
        >
          <Eraser size={15} />
        </button>
        <button
          title="Add a note"
          aria-label="Add board note"
          disabled={!ready || data.notes.length >= MAX_NOTES}
          onClick={() => {
            if (!large && !roomy) setExpanded(true);
            const note = {
              id: crypto.randomUUID(),
              text: "",
              x: 40 + (data.notes.length % 3) * 140,
              y: Math.min(
                BOARD_HEIGHT - NOTE_HEIGHT,
                40 +
                  (data.notes.length % 3) * 100 +
                  (large || roomy
                    ? (surface.current!.scrollTop /
                        surface.current!.clientWidth) *
                      BOARD_WIDTH
                    : 0),
              ),
            };
            void mutate((previous) => ({
              ...previous,
              notes:
                previous.notes.length < MAX_NOTES
                  ? [...previous.notes, note]
                  : previous.notes,
            }));
          }}
        >
          <StickyNote size={15} />
        </button>
        <button
          title="Undo last stroke"
          aria-label="Undo last stroke"
          disabled={!data.strokes.length}
          onClick={() =>
            void mutate((previous) => ({
              ...previous,
              strokes: previous.strokes.slice(0, -1),
            }))
          }
        >
          <Undo2 size={15} />
        </button>
        <button
          title="Clear board"
          aria-label="Clear board"
          disabled={!data.strokes.length && !data.notes.length}
          onClick={() => setClearing(true)}
        >
          <Trash2 size={15} />
        </button>
        {!large && (
          <button
            title="Expand board"
            aria-label="Expand doodle board"
            onClick={() => setExpanded(true)}
          >
            <Expand size={15} />
          </button>
        )}
      </div>
      <div className="doodle-colors" role="group" aria-label="Pen color">
        {PEN_COLORS.map((value, index) => (
          <button
            key={value}
            aria-label={`${["Ink", "Red", "Blue", "Green", "Purple"][index]} pen`}
            aria-pressed={color === value}
            style={
              {
                "--pen-color": value === "ink" ? "var(--text)" : value,
              } as React.CSSProperties
            }
            onClick={() => {
              setColor(value);
              setTool("pen");
            }}
          />
        ))}
      </div>
      <div
        className="doodle-surface"
        ref={surface}
        data-tool={tool}
        role="region"
        aria-label="Scrollable doodle workspace"
        tabIndex={0}
      >
        <div className="doodle-sheet" ref={sheet}>
          <svg
            viewBox={`0 0 ${BOARD_WIDTH} ${BOARD_HEIGHT}`}
            preserveAspectRatio="xMinYMin meet"
            role="img"
            aria-label="Doodle drawing canvas"
            onPointerDown={(event) => {
              if (!ready || event.button !== 0 || !event.isPrimary) return;
              event.preventDefault();
              event.currentTarget.setPointerCapture(event.pointerId);
              if (tool === "eraser") {
                erased.current.clear();
                erasing.current = true;
                erase(event);
                return;
              }
              if (data.strokes.length >= MAX_STROKES) return;
              const stroke = {
                id: crypto.randomUUID(),
                color,
                points: [point(event)],
              };
              drawing.current = stroke;
              setLive(stroke);
            }}
            onPointerMove={(event) => {
              if (erasing.current) {
                erase(event);
                return;
              }
              const stroke = drawing.current;
              if (!stroke) return;
              const next = point(event),
                last = stroke.points.at(-1)!;
              if (Math.hypot(next[0] - last[0], next[1] - last[1]) < 2) return;
              const points =
                stroke.points.length >= MAX_POINTS
                  ? stroke.points.filter((_, i) => i % 2 === 0)
                  : stroke.points;
              drawing.current = { ...stroke, points: [...points, next] };
              setLive(drawing.current);
            }}
            onPointerUp={finish}
            onPointerCancel={finish}
          >
            {data.strokes.map((stroke) => (
              <SavedStroke key={stroke.id} stroke={stroke} />
            ))}
            {live && (
              <path
                d={strokePath(live)}
                fill="none"
                stroke={live.color === "ink" ? "var(--text)" : live.color}
                strokeWidth="5"
                strokeLinecap="round"
                strokeLinejoin="round"
                pointerEvents="none"
              />
            )}
          </svg>
          {data.notes.map((note, index) => {
            const position = dragged?.id === note.id ? dragged : note;
            const moveNote = (event: PointerEvent) => {
              if (!drag.current || drag.current.note.id !== note.id) return;
              const current = point(event),
                { start } = drag.current;
              setDragged({
                id: note.id,
                x: Math.max(
                  0,
                  Math.min(
                    BOARD_WIDTH - NOTE_WIDTH,
                    note.x + current[0] - start[0],
                  ),
                ),
                y: Math.max(
                  0,
                  Math.min(
                    BOARD_HEIGHT - NOTE_HEIGHT,
                    note.y + current[1] - start[1],
                  ),
                ),
              });
            };
            const finishNote = () => {
              if (dragged?.id === note.id) {
                const position = dragged;
                void mutate((previous) => ({
                  ...previous,
                  notes: previous.notes.map((entry) =>
                    entry.id === note.id
                      ? { ...entry, x: position.x, y: position.y }
                      : entry,
                  ),
                })).then(() => setDragged(undefined));
              }
              drag.current = undefined;
            };
            return (
              <div
                key={note.id}
                className="board-note"
                style={{
                  left: `${(position.x / BOARD_WIDTH) * 100}%`,
                  top: `${(position.y / BOARD_HEIGHT) * 100}%`,
                }}
              >
                <div
                  className="board-note-handle"
                  aria-label="Drag note"
                  onPointerDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { note, start: point(event) };
                  }}
                  onPointerMove={moveNote}
                  onPointerUp={finishNote}
                  onPointerCancel={finishNote}
                >
                  <span aria-hidden="true">···</span>
                  <button
                    title="Remove note"
                    aria-label={`Remove board note ${index + 1}`}
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={() =>
                      void mutate((previous) => ({
                        ...previous,
                        notes: previous.notes.filter(
                          (entry) => entry.id !== note.id,
                        ),
                      }))
                    }
                  >
                    <X size={12} />
                  </button>
                </div>
                <NoteText
                  text={note.text}
                  label={`Board note ${index + 1}`}
                  save={(text) =>
                    void mutate((previous) => ({
                      ...previous,
                      notes: previous.notes.map((entry) =>
                        entry.id === note.id ? { ...entry, text } : entry,
                      ),
                    }))
                  }
                />
              </div>
            );
          })}
        </div>
        {!data.strokes.length && !data.notes.length && !live && (
          <span className="doodle-empty">Make room for an idea.</span>
        )}
      </div>
      {data.strokes.length >= MAX_STROKES && (
        <p role="status" className="personal-empty">
          Board full. Erase a stroke or clear the board to keep drawing.
        </p>
      )}
      {clearing && (
        <div
          className="board-clear-confirm"
          role="group"
          aria-label="Confirm clearing board"
        >
          <span>Clear drawing and notes?</span>
          <button
            onClick={() => {
              void mutate(() => ({ strokes: [], notes: [] }));
              setClearing(false);
            }}
          >
            Clear
          </button>
          <button onClick={() => setClearing(false)}>Cancel</button>
        </div>
      )}
      {error && <p role="alert">{error}</p>}
      <p className="personal-save-status" role="status">
        {saving ? "Saving…" : ready ? "Saved locally" : "Loading…"}
      </p>
    </div>
  );
  return (
    <>
      {expanded ? (
        <p className="personal-empty">
          Board is open.{" "}
          <button onClick={() => setExpanded(false)}>Return here</button>
        </p>
      ) : (
        editor(false)
      )}
      {expanded &&
        createPortal(
          <Modal
            label="Doodle board"
            close={() => setExpanded(false)}
            confirm={() => setExpanded(false)}
          >
            <section className="small-modal doodle-modal">
              <button
                className="modal-close"
                aria-label="Close doodle board"
                onClick={() => setExpanded(false)}
              >
                <X size={18} />
              </button>
              <h2>Doodle board</h2>
              {editor(true)}
            </section>
          </Modal>,
          document.body,
        )}
    </>
  );
});
function NoteText({
  text,
  label,
  save,
}: {
  text: string;
  label: string;
  save: (text: string) => void;
}) {
  const [draft, setDraft] = useState(text),
    focused = useRef(false);
  // Keep active typing stable while local writes and updates from other tabs finish.
  if (!focused.current && draft !== text) setDraft(text);
  return (
    <textarea
      aria-label={label}
      placeholder="An idea…"
      maxLength={300}
      value={draft}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
      }}
      onChange={(event) => {
        setDraft(event.target.value);
        save(event.target.value);
      }}
    />
  );
}
