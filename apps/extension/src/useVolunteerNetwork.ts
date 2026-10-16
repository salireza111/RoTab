import { useEffect, useRef, useState } from "react";
import type { EngineManifest, Snapshot } from "@rosettatab/shared";
import type { Session } from "./session";
import { VolunteerNetwork, type NetworkView } from "./volunteer-network";
import { summarizeNetwork, type NetworkSummary } from "./network-status";

/** The computing tab owns the network, independently of dialogs and widgets. */
export function useVolunteerNetwork({
  owner,
  manifest,
  session,
  snapshot,
  onView,
}: {
  owner: boolean;
  manifest?: EngineManifest;
  session?: Session;
  snapshot: Snapshot;
  onView(view: NetworkView): void;
}) {
  const latest = useRef({ snapshot, onView });
  latest.current = { snapshot, onView };
  const [controller, setController] = useState<VolunteerNetwork>();
  const [view, setView] = useState<NetworkView>();
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<NetworkSummary>();
  const activeRef = useRef<VolunteerNetwork | undefined>(undefined);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  const summaryRef = useRef<NetworkSummary | undefined>(undefined);
  const channel = useRef<BroadcastChannel | undefined>(undefined);
  useEffect(() => {
    const active = new BroadcastChannel("rotab-network-ui-v1");
    channel.current = active;
    const send = () => {
      if (!ownerRef.current || !summaryRef.current) return;
      const next = { ...summaryRef.current, updatedAt: Date.now() };
      active.postMessage({ type: "summary", summary: next });
    };
    active.onmessage = ({ data }) => {
      if (data?.type === "hello") send();
      else if (data?.type === "summary" && !ownerRef.current)
        setSummary(data.summary);
      else if (
        data?.type === "volunteer" &&
        ownerRef.current &&
        activeRef.current
      ) {
        const controller = activeRef.current;
        void controller
          .configure({
            ...controller.view.settings,
            enabled: true,
            automatic: data.enabled === true,
          })
          .catch((e) =>
            setError(
              e instanceof Error ? e.message : "Could not update volunteering.",
            ),
          );
      }
    };
    active.postMessage({ type: "hello" });
    const timer = setInterval(send, 5_000);
    return () => {
      clearInterval(timer);
      active.close();
      channel.current = undefined;
    };
  }, []);
  useEffect(() => {
    // Store the owner tab in the transient extension session, so linked tabs
    // can locate it without a broad tabs permission or an installed helper.
    if (!globalThis.chrome?.tabs?.getCurrent) return;
    void chrome.tabs
      .getCurrent()
      .then((tab) => {
        if (tab?.id !== undefined)
          return chrome.runtime.sendMessage({
            type: "computing-tab",
            owner,
            tabId: tab.id,
          });
      })
      .catch(() => {});
  }, [owner]);
  useEffect(() => {
    setView(undefined);
    setError("");
    if (!owner || !session || !manifest?.verified) return;
    let alive = true;
    const active = new VolunteerNetwork(manifest, {
      update: (next) => {
        if (alive) {
          setView(next);
          const nextSummary = summarizeNetwork(next);
          summaryRef.current = nextSummary;
          setSummary(nextSummary);
          channel.current?.postMessage({
            type: "summary",
            summary: nextSummary,
          });
          latest.current.onView(next);
        }
      },
      accept: (job, hash) => session.acceptPeerJob(job, hash),
      available: () =>
        ["idle", "complete"].includes(latest.current.snapshot.state),
    });
    setController(active);
    activeRef.current = active;
    void active.initialize().catch((e) => {
      if (alive)
        setError(
          e instanceof Error
            ? e.message
            : "Network storage could not be initialized.",
        );
    });
    return () => {
      alive = false;
      active.dispose();
      activeRef.current = undefined;
      setController(undefined);
    };
  }, [owner, session, manifest]);
  useEffect(() => {
    let alive = true;
    void controller?.observe(snapshot).catch(() => {
      if (alive)
        setError(
          "Network update failed; completed models remain saved locally.",
        );
    });
    return () => {
      alive = false;
    };
  }, [controller, snapshot, view?.identityId]);
  const setVolunteering = async (enabled: boolean) => {
    setError("");
    if (owner && controller)
      await controller.configure({
        ...controller.view.settings,
        enabled: true,
        automatic: enabled,
      });
    else channel.current?.postMessage({ type: "volunteer", enabled });
  };
  const locateOwner = async () => {
    if (!globalThis.chrome?.runtime?.sendMessage) return;
    const result = await chrome.runtime.sendMessage({
      type: "focus-computing-tab",
    });
    if (!result?.ok)
      throw new Error("The main tab is changing. Try again in a moment.");
  };
  return { controller, view, error, summary, setVolunteering, locateOwner };
}
export type VolunteerNetworkState = ReturnType<typeof useVolunteerNetwork>;
