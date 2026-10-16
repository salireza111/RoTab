import type { BrowserContext, WebSocketRoute } from "@playwright/test";

/** In-process test transport; no listening server and no public relay traffic. */
export function nostrRelayFixture(
  options: {
    rejectHosts?: string[];
    ephemeral?: boolean;
    dropFirstSignals?: boolean;
  } = {},
) {
  const connections = new Map<
    WebSocketRoute,
    { subscription: string; filters: any[]; rejected: boolean }
  >();
  const published: any[] = [];
  const droppedSignals = new Set<string>();
  const matches = (event: any, filter: any) =>
    (!filter.kinds || filter.kinds.includes(event.kind)) &&
    Object.entries(filter)
      .filter(([key]) => key.startsWith("#"))
      .every(([key, values]) =>
        event.tags.some(
          (tag: string[]) =>
            tag[0] === key.slice(1) && (values as string[]).includes(tag[1]),
        ),
      );
  return {
    published,
    droppedSignals,
    connections,
    attach: (context: BrowserContext) =>
      context.routeWebSocket("wss://**", (socket) => {
        const record = {
          subscription: "",
          filters: [] as any[],
          rejected:
            options.rejectHosts?.includes(new URL(socket.url()).host) ?? false,
        };
        connections.set(socket, record);
        socket.onMessage((data) => {
          const packet = JSON.parse(String(data));
          if (packet[0] === "REQ") {
            record.subscription = packet[1];
            record.filters = packet.slice(2);
            if (record.rejected) {
              socket.send(
                JSON.stringify([
                  "CLOSED",
                  packet[1],
                  "blocked: fixture rejects this room",
                ]),
              );
              return;
            }
            for (const event of published.slice(-100))
              if (
                (!options.ephemeral ||
                  event.kind < 20000 ||
                  event.kind >= 30000) &&
                event.created_at * 1000 > Date.now() - 45_000 &&
                record.filters.some((f) => matches(event, f))
              )
                socket.send(
                  JSON.stringify(["EVENT", record.subscription, event]),
                );
            socket.send(JSON.stringify(["EOSE", packet[1]]));
          } else if (packet[0] === "EVENT") {
            if (record.rejected) {
              socket.send(
                JSON.stringify([
                  "OK",
                  packet[1].id,
                  false,
                  "blocked: fixture rejects this room",
                ]),
              );
              return;
            }
            published.push(packet[1]);
            socket.send(JSON.stringify(["OK", packet[1].id, true, ""]));
            // Simulate a relay accepting an ephemeral signal while its intended
            // recipient misses delivery. Application retries must recover it.
            const direction =
              packet[1].pubkey +
              ":" +
              packet[1].tags.find((t: string[]) => t[0] === "p")?.[1];
            if (
              options.dropFirstSignals &&
              packet[1].kind === 23371 &&
              !droppedSignals.has(direction)
            ) {
              droppedSignals.add(direction);
              return;
            }
            for (const [target, r] of connections)
              if (!r.rejected && r.filters.some((f) => matches(packet[1], f)))
                try {
                  target.send(
                    JSON.stringify(["EVENT", r.subscription, packet[1]]),
                  );
                } catch {}
          }
        });
        socket.onClose(() => connections.delete(socket));
      }),
  };
}
