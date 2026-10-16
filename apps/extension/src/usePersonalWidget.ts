import { useEffect, useMemo, useRef, useState } from "react";
import { getState, updateState } from "./storage";
interface Saved<T> {
  revision: number;
  value: T;
}
const EVENT = "rotab-personal-widget-changed";
export function usePersonalWidget<T>(
  key: string,
  normalize: (raw: unknown) => T,
) {
  const [saved, setSaved] = useState<Saved<T>>({
    revision: -1,
    value: normalize(undefined),
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState<
    Array<{ id: number; action: (current: T) => T }>
  >([]);
  const operation = useRef(0);
  const mounted = useRef(false),
    channel = useRef<BroadcastChannel | undefined>(undefined);
  const accept = (record: Saved<T>) =>
    setSaved((previous) =>
      record.revision >= previous.revision ? record : previous,
    );
  useEffect(() => {
    mounted.current = true;
    const refresh = () =>
      void getState<Saved<unknown>>(key)
        .then((record) => {
          if (mounted.current)
            accept({
              revision: record?.revision ?? 0,
              value: normalize(record?.value),
            });
        })
        .catch(() => {
          if (mounted.current) setError("Saved content could not be loaded.");
        });
    const receive = (event: Event) => {
      if ((event as CustomEvent).detail === key) refresh();
    };
    channel.current = new BroadcastChannel(EVENT);
    channel.current.onmessage = (event) => {
      if (event.data === key) refresh();
    };
    window.addEventListener(EVENT, receive);
    refresh();
    return () => {
      mounted.current = false;
      channel.current?.close();
      channel.current = undefined;
      window.removeEventListener(EVENT, receive);
    };
  }, [key, normalize]);
  const mutate = async (action: (current: T) => T) => {
    const id = ++operation.current;
    // Keep interaction immediate while the cross-tab transaction commits.
    setPending((previous) => [...previous, { id, action }]);
    try {
      const record = await updateState<Saved<T>>(key, (previous) => ({
        revision: (previous?.revision ?? 0) + 1,
        value: normalize(action(normalize(previous?.value))),
      }));
      if (mounted.current) {
        accept(record);
        setPending((previous) => previous.filter((entry) => entry.id !== id));
        setError("");
      }
      channel.current?.postMessage(key);
      window.dispatchEvent(new CustomEvent(EVENT, { detail: key }));
      return true;
    } catch {
      if (mounted.current) {
        setPending((previous) => previous.filter((entry) => entry.id !== id));
        setError("Changes could not be saved. Try again.");
      }
      return false;
    }
  };
  const data = useMemo(
    () =>
      normalize(
        pending.reduce((value, entry) => entry.action(value), saved.value),
      ),
    [saved, pending, normalize],
  );
  return {
    data,
    ready: saved.revision >= 0,
    saving: pending.length > 0,
    error,
    mutate,
  };
}
