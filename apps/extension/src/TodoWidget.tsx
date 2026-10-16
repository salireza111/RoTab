import { memo, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { MAX_TODOS, normalizeTodos } from "./personal-widgets";
import { usePersonalWidget } from "./usePersonalWidget";
export const TodoWidget = memo(function TodoWidget() {
  const {
    data: items,
    ready,
    saving,
    error,
    mutate,
  } = usePersonalWidget("personal-todos-v1", normalizeTodos);
  const [text, setText] = useState(""),
    [adding, setAdding] = useState(false);
  const remaining = items.filter((item) => !item.done).length;
  return (
    <div className="todo-widget">
      <form
        className="todo-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (!text.trim() || adding || !ready) return;
          const item = {
            id: crypto.randomUUID(),
            text: text.trim(),
            done: false,
          };
          setAdding(true);
          void mutate((previous) =>
            previous.length < MAX_TODOS ? [...previous, item] : previous,
          ).then((ok) => {
            if (ok) setText("");
            setAdding(false);
          });
        }}
      >
        <input
          aria-label="New to-do"
          placeholder="Add a task…"
          maxLength={300}
          value={text}
          disabled={!ready || adding || items.length >= MAX_TODOS}
          onChange={(event) => setText(event.target.value)}
        />
        <button
          aria-label="Add to-do"
          title="Add task"
          disabled={
            !ready || adding || !text.trim() || items.length >= MAX_TODOS
          }
        >
          <Plus size={17} />
        </button>
      </form>
      <ul className="todo-items">
        {items.map((item) => (
          <li key={item.id} data-complete={item.done}>
            <label>
              <input
                type="checkbox"
                checked={item.done}
                onChange={(event) => {
                  const done = event.target.checked;
                  void mutate((previous) =>
                    previous.map((entry) =>
                      entry.id === item.id ? { ...entry, done } : entry,
                    ),
                  );
                }}
              />
              <span>{item.text}</span>
            </label>
            <button
              aria-label={`Delete task ${item.text}`}
              title="Delete task"
              onClick={() =>
                void mutate((previous) =>
                  previous.filter((entry) => entry.id !== item.id),
                )
              }
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
      {ready && !items.length && (
        <p className="personal-empty">A little space for what’s next.</p>
      )}
      <footer className="personal-widget-foot">
        <span>{remaining} remaining</span>
        {items.some((item) => item.done) && (
          <button
            onClick={() =>
              void mutate((previous) => previous.filter((item) => !item.done))
            }
          >
            Clear completed
          </button>
        )}
      </footer>
      <p className="personal-save-status" role="status">
        {saving ? "Saving…" : ready ? "Saved locally" : "Loading…"}
      </p>
      {items.length >= MAX_TODOS && (
        <p role="status">List full. Remove a task to add another.</p>
      )}
      {error && <p role="alert">{error}</p>}
    </div>
  );
});
