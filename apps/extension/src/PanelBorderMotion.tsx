import { useLayoutEffect, useState } from "react";

interface Border {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
  stroke: string;
  thickness: number;
}

/** Traces the actual panel edges; no decorative frame inside the protein view. */
export function PanelBorderMotion({
  cycle,
  active,
  finish: finishMotion,
}: {
  cycle: number;
  active: boolean;
  finish(): void;
}) {
  const [borders, setBorders] = useState<Border[]>([]);
  useLayoutEffect(() => {
    if (!cycle || !active) return;
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    if (media.matches) {
      finishMotion();
      return;
    }
    const panels = [
      ...document.querySelectorAll<HTMLElement>(
        ".observatory, .widget, .resource-panel, .work-queue:not(.work-queue-compact), .home-search",
      ),
    ].filter((p) => {
      const box = p.getBoundingClientRect();
      return box.height > 0 && box.width > 0 && !p.closest("[inert]");
    });
    setBorders(
      panels.map((panel) => {
        const box = panel.getBoundingClientRect(),
          style = getComputedStyle(panel);
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          radius: parseFloat(style.borderTopLeftRadius) || 0,
          // Destination borders are concealed before the view capture. Read
          // their theme color rather than the temporary transparent border.
          stroke: style.getPropertyValue("--line").trim(),
          thickness: parseFloat(style.borderTopWidth) || 1,
        };
      }),
    );
    for (const panel of panels) panel.dataset.borderDrawing = "true";
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      for (const panel of panels) delete panel.dataset.borderDrawing;
      setBorders([]);
      finishMotion();
    };
    const timer = setTimeout(finish, 850);
    window.addEventListener("resize", finish, { once: true });
    window.addEventListener("scroll", finish, { once: true, capture: true });
    media.addEventListener("change", finish, { once: true });
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", finish);
      window.removeEventListener("scroll", finish, true);
      media.removeEventListener("change", finish);
      for (const panel of panels) delete panel.dataset.borderDrawing;
    };
  }, [cycle, active, finishMotion]);
  return active && borders.length ? (
    <svg key={cycle} className="panel-border-motion" aria-hidden="true">
      {borders.map((b, i) => (
        <rect
          key={i}
          pathLength="1"
          x={b.x + b.thickness / 2}
          y={b.y + b.thickness / 2}
          width={Math.max(0, b.width - b.thickness)}
          height={Math.max(0, b.height - b.thickness)}
          rx={b.radius}
          fill="none"
          stroke={b.stroke}
          strokeWidth={b.thickness}
        />
      ))}
    </svg>
  ) : null;
}
