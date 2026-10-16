import { getState, putState } from "./storage";
import {
  generatePeerIdentity,
  identityId,
  signPeerMessage,
  verifyPeerMessage,
  type PeerIdentity,
} from "./peer-protocol";

let loading: Promise<PeerIdentity> | undefined;
/** Coalesce the network and legacy controllers' first identity creation. */
export function loadPeerIdentity(): Promise<PeerIdentity> {
  return (loading ??= (async () => {
    const saved = await getState<PeerIdentity>("peer-identity");
    if (!saved) {
      const legacy = await getState<{ jobs?: unknown[] }>("peer-ledger");
      const campaigns = await getState<{ campaigns?: unknown[] }>(
        "campaign-ledger",
      );
      const received = await getState<{ incoming?: unknown[] }>(
        "network-ledger",
      );
      if (
        legacy?.jobs?.length ||
        campaigns?.campaigns?.length ||
        received?.incoming?.length
      )
        throw new Error(
          "The saved participant identity is missing; experiment records were preserved.",
        );
    }
    const identity = saved ?? (await generatePeerIdentity());
    if (
      !identity.privateKey ||
      identity.privateKey.extractable ||
      identity.id !== (await identityId(identity.publicKey))
    )
      throw new Error("The saved peer identity failed its integrity check.");
    await verifyPeerMessage(
      await signPeerMessage(identity, { type: "hello", peerId: identity.id }),
      identity.id,
    );
    if (!saved) await putState("peer-identity", identity);
    return identity;
  })().finally(() => {
    loading = undefined;
  }));
}
