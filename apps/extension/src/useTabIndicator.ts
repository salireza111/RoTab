import { useEffect } from "react";
import { focusRemaining } from "./focus-timer";
import type { useFocusTimer } from "./useFocusTimer";
import { INDICATOR_COLORS, type TabIndicator } from "./network-status";
import { drawHistidineIcon, NEUTRAL_ICON_COLOR } from "./histidine-icon";

/** One favicon writer combines scientific/network status and the focus ring. */
export function useTabIndicator(
  status: TabIndicator,
  focus: ReturnType<typeof useFocusTimer>,
  owner: boolean,
) {
  const seconds = Math.ceil(focusRemaining(focus.timer, focus.now) / 1000);
  const progress = Math.max(
    0,
    Math.min(1, 1 - (seconds * 1000) / focus.timer.durationMs),
  );
  useEffect(() => {
    document.title = "RoTab";
  }, []);
  useEffect(() => {
    const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!icon) return;
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 64;
    const context = canvas.getContext("2d");
    if (!context) return;
    const color = owner ? INDICATOR_COLORS[status.state] : NEUTRAL_ICON_COLOR;
    const working = owner && status.state === "working";
    let tick = false;
    const draw = () => {
      context.clearRect(0, 0, 64, 64);
      context.globalAlpha = working && tick ? 0.5 : 1;
      context.save();
      // Leave room for the existing Pomodoro progress ring when it is visible.
      if (focus.timer.status !== "ready") {
        context.translate(9.6, 9.6);
        context.scale(0.7, 0.7);
      }
      drawHistidineIcon(context, color);
      context.restore();
      context.globalAlpha = 1;
      if (focus.timer.status !== "ready") {
        context.lineWidth = 4;
        context.strokeStyle = "#8b909766";
        context.beginPath();
        context.arc(32, 32, 28, 0, Math.PI * 2);
        context.stroke();
        context.strokeStyle = color;
        context.lineCap = "round";
        context.beginPath();
        context.arc(
          32,
          32,
          28,
          -Math.PI / 2,
          -Math.PI / 2 + 2 * Math.PI * progress,
        );
        context.stroke();
        icon.dataset.focusProgress = progress.toFixed(4);
      } else delete icon.dataset.focusProgress;
      icon.dataset.networkStatus = status.state;
      icon.dataset.indicatorRole = owner ? "computing" : "linked";
      icon.dataset.faviconColor = color;
      icon.href = canvas.toDataURL("image/png");
      tick = !tick;
    };
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let interval: ReturnType<typeof setInterval> | undefined;
    const refreshMotion = () => {
      clearInterval(interval);
      tick = false;
      draw();
      if (working && !motion.matches) interval = setInterval(draw, 750);
    };
    refreshMotion();
    motion.addEventListener("change", refreshMotion);
    return () => {
      clearInterval(interval);
      motion.removeEventListener("change", refreshMotion);
    };
  }, [
    owner,
    status.state,
    focus.timer.status,
    focus.timer.durationMs,
    seconds,
  ]);
}
