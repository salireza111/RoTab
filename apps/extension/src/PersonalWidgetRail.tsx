import {
  ArrowLeft,
  ArrowRight,
  CheckSquare,
  EyeOff,
  PanelTop,
  Pencil,
} from "lucide-react";
import type { ReactNode } from "react";
import type { Preferences } from "./storage";
import {
  PERSONAL_WIDGET_IDS,
  type PersonalWidgetId,
  type WidgetSide,
} from "./personal-widgets";
import { TodoWidget } from "./TodoWidget";
import { DoodleBoard } from "./DoodleBoard";

type WidgetProps = {
  prefs: Preferences;
  change: (patch: Partial<Preferences>) => void;
};
export function PersonalWidgetCard({
  id,
  prefs,
  change,
  gridActions,
}: WidgetProps & {
  id: PersonalWidgetId;
  gridActions?: ReactNode;
}) {
  const side = prefs.personalWidgets[id].side;
  const title = id === "todo" ? "To-do list" : "Doodle board";
  const update = (
    patch: Partial<Preferences["personalWidgets"][PersonalWidgetId]>,
  ) =>
    change({
      personalWidgets: {
        ...prefs.personalWidgets,
        [id]: { ...prefs.personalWidgets[id], ...patch },
      },
    });
  const positions = (["left", "middle", "right"] as const).filter(
    (position) => position !== side,
  );
  const placement = (
    <>
      {positions.map((position) => (
        <button
          key={position}
          title={`Move to ${position}${position === "middle" ? "" : " side"}`}
          aria-label={`Move ${title.toLowerCase()} to ${position}`}
          onClick={() => update({ side: position })}
        >
          {position === "left" ? (
            <ArrowLeft size={14} />
          ) : position === "right" ? (
            <ArrowRight size={14} />
          ) : (
            <PanelTop size={14} />
          )}
        </button>
      ))}
      <button
        title="Hide widget"
        aria-label={`Hide ${title.toLowerCase()}`}
        onClick={() => update({ enabled: false })}
      >
        <EyeOff size={14} />
      </button>
    </>
  );
  return (
    <section
      className={`personal-widget${side === "middle" ? ` widget${prefs.wideWidgets.includes(id) ? " widget-wide" : ""}` : ""}`}
      data-personal-widget={id}
      data-widget={side === "middle" ? id : undefined}
      data-placement={side}
      aria-label={title}
    >
      {side === "middle" && (
        <div className="widget-actions">
          {gridActions}
          {placement}
        </div>
      )}
      <header className="personal-widget-heading">
        <h2>
          {id === "todo" ? <CheckSquare size={16} /> : <Pencil size={16} />}
          {title}
        </h2>
        {side !== "middle" && <div>{placement}</div>}
      </header>
      {id === "todo" ? (
        <TodoWidget />
      ) : (
        <DoodleBoard roomy={side !== "middle"} />
      )}
    </section>
  );
}
export function PersonalWidgetRail({
  side,
  prefs,
  change,
}: WidgetProps & { side: Exclude<WidgetSide, "middle"> }) {
  const ids = PERSONAL_WIDGET_IDS.filter(
    (id) =>
      prefs.personalWidgets[id].enabled &&
      prefs.personalWidgets[id].side === side,
  );
  if (!ids.length) return null;
  return (
    <aside
      className="personal-widget-rail"
      data-side={side}
      style={{ "--personal-count": ids.length } as React.CSSProperties}
      aria-label={`${side === "left" ? "Left" : "Right"} personal widgets`}
    >
      {ids.map((id) => (
        <PersonalWidgetCard key={id} id={id} prefs={prefs} change={change} />
      ))}
    </aside>
  );
}
