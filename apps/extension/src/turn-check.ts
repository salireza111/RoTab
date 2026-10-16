import { peerIceServers, type PeerIceSettings } from "./peer-connection";

/** Allocate a relay candidate only: no peer, protein, job or scientific worker. */
export async function checkTurn(
  settings: PeerIceSettings,
  signal?: AbortSignal,
): Promise<{ elapsedMs: number }> {
  if (!settings.turn.trim())
    throw new Error(
      "Enter a TURN URL and its generated username/password first.",
    );
  const iceServers = peerIceServers(settings);
  if (signal?.aborted) throw new Error("TURN check cancelled.");
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: "relay" });
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      const codes = new Set<number>();
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else resolve();
      };
      abort = () => finish(new Error("TURN check cancelled."));
      signal?.addEventListener("abort", abort, { once: true });
      const failed = () =>
        finish(
          new Error(
            "TURN returned no relay candidate. Check the provider URL, generated credentials and network access" +
              (codes.size
                ? ` (ICE error codes: ${[...codes].join(", ")}).`
                : "."),
          ),
        );
      timer = setTimeout(failed, 20_000);
      pc.onicecandidateerror = (event) => {
        if (codes.size < 8 && Number.isInteger(event.errorCode))
          codes.add(event.errorCode);
      };
      pc.onicecandidate = (event) => {
        if (
          event.candidate?.type === "relay" ||
          / typ relay(?:\s|$)/.test(event.candidate?.candidate ?? "")
        )
          finish();
      };
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") failed();
      };
      pc.createDataChannel("rotab-turn-check");
      void pc
        .createOffer()
        .then((offer) => {
          if (settled) return;
          return pc.setLocalDescription(offer);
        })
        .catch(() =>
          finish(new Error("TURN check could not start or was cancelled.")),
        );
    });
    return { elapsedMs: Math.round(performance.now() - startedAt) };
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal?.removeEventListener("abort", abort);
    pc.onicecandidate =
      pc.onicecandidateerror =
      pc.onicegatheringstatechange =
        null;
    pc.close();
  }
}
