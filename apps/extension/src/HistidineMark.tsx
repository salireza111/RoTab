import {
  HISTIDINE_OUTLINE,
  HISTIDINE_BONDS,
  HISTIDINE_NITROGENS,
  HISTIDINE_STROKES,
} from "./histidine-icon";
import { INDICATOR_COLORS, type TabIndicator } from "./network-status";

export function HistidineMark({ status }: { status: TabIndicator }) {
  return (
    <span
      className="histidine-status"
      role="status"
      aria-label={status.label}
      title={status.label}
    >
      <svg
        className="brand-histidine"
        data-state={status.state}
        style={{ color: INDICATOR_COLORS[status.state] }}
        viewBox="8 0 48 64"
        aria-hidden="true"
        fill="none"
        stroke="currentColor"
        strokeWidth={HISTIDINE_STROKES.outline}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={HISTIDINE_OUTLINE} />
        <path d={HISTIDINE_BONDS} strokeWidth={HISTIDINE_STROKES.bonds} />
        <path
          d={HISTIDINE_NITROGENS}
          strokeWidth={HISTIDINE_STROKES.nitrogens}
        />
      </svg>
    </span>
  );
}
