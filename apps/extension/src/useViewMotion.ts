import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { Preferences } from "./storage";

type View = Preferences["view"];
type Phase = "idle" | "moving" | "drawing";

/** Capture a concealed destination, move the existing canvas, then reveal it. */
export function useViewMotion(view: View, changeView: (view: View) => void) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [cycle, setCycle] = useState(0);
  const previous = useRef(view);
  const localTarget = useRef<View | undefined>(undefined);
  const generation = useRef(0);
  const active = useRef<ViewTransition | undefined>(undefined);
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const finish = useCallback(() => setPhase("idle"), []);

  useLayoutEffect(() => {
    if (previous.current === view) return;
    previous.current = view;
    if (localTarget.current === view) {
      localTarget.current = undefined;
      return;
    }
    // The appearance selector also hides final borders before the destination's
    // first paint, even without a canvas transition.
    generation.current++;
    active.current?.skipTransition();
    active.current = undefined;
    if (reduced()) finish();
    else {
      setPhase("drawing");
      setCycle((value) => value + 1);
    }
  }, [view, finish]);

  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const changed = () => {
      if (media.matches) {
        active.current?.skipTransition();
        finish();
      }
    };
    media.addEventListener("change", changed);
    return () => {
      generation.current++;
      active.current?.skipTransition();
      media.removeEventListener("change", changed);
    };
  }, [finish]);

  const switchView = (next: View) => {
    if (next === view) return;
    const id = ++generation.current;
    active.current?.skipTransition();
    active.current = undefined;
    const update = (moving: boolean) => {
      if (id !== generation.current) return;
      flushSync(() => {
        localTarget.current = next;
        setPhase(reduced() ? "idle" : moving ? "moving" : "drawing");
        if (!moving && !reduced()) setCycle((value) => value + 1);
        changeView(next);
      });
    };
    if (reduced()) {
      update(false);
      return;
    }
    if (!document.startViewTransition) {
      update(false);
      return;
    }
    const transition = document.startViewTransition(() => update(true));
    active.current = transition;
    void transition.updateCallbackDone
      .then(() => transition.finished.catch(() => {}))
      .then(() => {
        if (id !== generation.current) return;
        active.current = undefined;
        if (reduced()) finish();
        else {
          setPhase("drawing");
          setCycle((value) => value + 1);
        }
      })
      .catch(() => {
        if (id === generation.current) finish();
      });
  };
  return { phase, cycle, switchView, finish };
}
