import { useCallback, useEffect, useRef, useState } from "react";
import type { Protocol } from "@rosettatab/shared";
import type { PeerView } from "./peer-collaboration";
import type { NetworkView } from "./volunteer-network";
import { campaignCounts } from "./campaign-queue";

export interface QueueEntry {
  id: string;
  title: string;
  protocol: Protocol;
  models: number;
  completed: number;
  direction: "sent" | "received";
  status: string;
  expiresAt: number;
  createdAt: number;
  active?: number;
  local?: boolean;
}
export interface QueueView {
  updatedAt: number;
  connected: boolean;
  jobs: QueueEntry[];
  pendingDeliveries: number;
  network?: {
    enabled: boolean;
    observed: number;
    available: number;
    remaining: number;
    completed: number;
  };
}
export function projectNetworkQueue(
  view: NetworkView,
  now = Date.now(),
): QueueView {
  const counts = view.campaigns.map((c) => ({
    state: c.state,
    ...campaignCounts(c, now),
  }));
  const peers = view.peers.filter((p) => p.presence.expiresAt > now);
  return {
    updatedAt: now,
    connected: peers.some((p) => p.connected),
    jobs: [
      ...view.campaigns.map((c): QueueEntry => {
        const counts = campaignCounts(c, now);
        return {
          id: c.id,
          title: c.title,
          protocol: c.protocol,
          models: c.models,
          completed: counts.completed,
          direction: "sent",
          status: c.state,
          expiresAt: 0,
          createdAt: c.createdAt,
          active: c.attempts.filter(
            (a) =>
              a.lease?.progress &&
              now - a.lease.progress.receivedAt < 25_000 &&
              ["loading", "running"].includes(a.lease.progress.state),
          ).length,
        };
      }),
      ...view.incoming.flatMap((e): QueueEntry[] => {
        if (
          e.envelope.payload.type !== "network" ||
          e.envelope.payload.message.kind !== "assignment" ||
          e.status === "released"
        )
          return [];
        const a = e.envelope.payload.message;
        return [
          {
            id: a.job.id,
            title: a.job.title,
            protocol: a.job.protocol,
            models: 1,
            completed: e.result ? 1 : 0,
            direction: "received",
            status: e.status,
            createdAt: a.job.createdAt,
            expiresAt: a.expiresAt,
            local: !!view.identityId && e.peerId === view.identityId,
          },
        ];
      }),
    ],
    pendingDeliveries: view.incoming.filter((e) => e.result && !e.receipt)
      .length,
    network: {
      enabled: view.settings.enabled,
      observed: peers.length,
      available: peers.filter(
        (p) => p.presence.automatic && p.presence.available,
      ).length,
      remaining: counts
        .filter((c) => ["active", "paused"].includes(c.state))
        .reduce((sum, c) => sum + c.total - c.completed, 0),
      completed: counts.reduce((sum, c) => sum + c.completed, 0),
    },
  };
}
export function projectQueue(view: PeerView, now = Date.now()): QueueView {
  return {
    updatedAt: now,
    connected: view.state === "connected" && !!view.remoteId,
    jobs: view.jobs.map(({ job, direction, status, progress }) => ({
      id: job.id,
      title: job.title,
      protocol: job.protocol,
      models: job.models,
      completed:
        status === "complete"
          ? job.models
          : Math.max(0, Math.min(job.models, progress?.completed ?? 0)),
      direction,
      status: status === "complete" ? "complete" : (progress?.state ?? status),
      expiresAt: job.expiresAt,
      createdAt: job.createdAt,
    })),
    pendingDeliveries: view.results.filter(
      (r) => r.direction === "sent" && r.delivery === "pending",
    ).length,
  };
}
export function queueCounts(view: QueueView | undefined, now = Date.now()) {
  const incoming = view?.jobs.filter((j) => j.direction === "received") ?? [];
  const waiting = incoming.filter(
    (j) => j.status === "offered" && j.expiresAt > now,
  );
  return {
    waiting: waiting.length,
    models: waiting.reduce((sum, job) => sum + job.models, 0),
    complete: incoming.filter((j) => j.status === "complete").length,
    // A connection is not an assertion that the remote volunteer is computing.
    connected:
      view && now - view.updatedAt < 15_000
        ? Number(view.connected)
        : undefined,
  };
}

/** Share only queue metadata. One owner/connection is counted once across tabs. */
export function useWorkQueue(owner: boolean) {
  const [view, setView] = useState<QueueView>();
  const latest = useRef<QueueView | undefined>(undefined);
  const sources = useRef<{ peer?: QueueView; network?: QueueView }>({});
  const isOwner = useRef(owner);
  isOwner.current = owner;
  const channel = useRef<BroadcastChannel | undefined>(undefined);
  const combine = useCallback(() => {
    const { peer, network } = sources.current;
    const next: QueueView = {
      updatedAt: Date.now(),
      connected: !!peer?.connected || !!network?.connected,
      jobs: [...(peer?.jobs ?? []), ...(network?.jobs ?? [])],
      pendingDeliveries:
        (peer?.pendingDeliveries ?? 0) + (network?.pendingDeliveries ?? 0),
      ...(network?.network ? { network: network.network } : {}),
    };
    latest.current = next;
    setView(next);
    channel.current?.postMessage({ type: "view", view: next });
  }, []);
  const publish = useCallback(
    (peer: PeerView) => {
      sources.current.peer = projectQueue(peer);
      combine();
    },
    [combine],
  );
  const publishNetwork = useCallback(
    (view: NetworkView) => {
      sources.current.network = projectNetworkQueue(view);
      combine();
    },
    [combine],
  );
  useEffect(() => {
    sources.current = {};
    const active = new BroadcastChannel("rosettatab-work-queue-v1");
    channel.current = active;
    const send = () => {
      if (isOwner.current && latest.current) {
        const next = { ...latest.current, updatedAt: Date.now() };
        latest.current = next;
        setView(next);
        active.postMessage({ type: "view", view: next });
      }
    };
    active.onmessage = ({ data }) => {
      if (data?.type === "request") send();
      else if (!isOwner.current && data?.type === "view") setView(data.view);
    };
    active.postMessage({ type: "request" });
    const timer = setInterval(send, 5_000);
    return () => {
      clearInterval(timer);
      active.close();
      channel.current = undefined;
    };
  }, []);
  useEffect(() => {
    sources.current = {};
    latest.current = undefined;
    setView(undefined);
    channel.current?.postMessage({ type: "request" });
  }, [owner]);
  return { view, publish, publishNetwork };
}
