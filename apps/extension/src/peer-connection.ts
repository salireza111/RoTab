import {
  iceCandidateSchema,
  type IceCandidate,
} from "./connectivity-signaling";
import {
  signPeerMessage,
  verifyPeerMessage,
  type PeerIdentity,
  type SignedPeerMessage,
  MAX_PEER_MESSAGE_BYTES,
} from "./peer-protocol";

export interface PeerIceSettings {
  stun: string;
  turn: string;
  username: string;
  credential: string;
}
export const defaultPeerIce: PeerIceSettings = {
  stun: "stun:stun.l.google.com:19302",
  turn: "",
  username: "",
  credential: "",
};
export function peerIceServers(settings: PeerIceSettings): RTCIceServer[] {
  const servers: RTCIceServer[] = [];
  const stun = settings.stun.trim(),
    turn = settings.turn.trim();
  if (stun) {
    if (!/^stuns?:[^\s@]+$/.test(stun))
      throw new Error(
        "Use a STUN URL or leave it blank for a local-network test.",
      );
    servers.push({ urls: stun });
  }
  if (turn) {
    if (!/^turns?:[^\s@]+$/.test(turn))
      throw new Error("Use a TURN URL without embedded credentials.");
    if (!settings.username || !settings.credential)
      throw new Error("TURN needs a username and credential.");
    servers.push({
      urls: turn,
      username: settings.username,
      credential: settings.credential,
    });
  }
  return servers;
}

function encodeCode(message: SignedPeerMessage) {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return (
    "RT1." +
    btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")
  );
}
export async function decodePeerCode(code: string) {
  const text = code.trim();
  if (!/^RT1\.[A-Za-z0-9_-]+$/.test(text) || text.length > 200_000)
    throw new Error("Paste a complete RoTab invitation or reply code.");
  let raw: unknown;
  try {
    const base64 = text.slice(4).replaceAll("-", "+").replaceAll("_", "/");
    raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      ),
    );
  } catch {
    throw new Error("The connection code is incomplete or damaged.");
  }
  const message = await verifyPeerMessage(raw);
  if (message.payload.type !== "pairing")
    throw new Error("This is not a connection code.");
  const pairing = message.payload.pairing;
  const now = Date.now();
  if (
    pairing.expiresAt <= now ||
    pairing.createdAt > now + 300_000 ||
    pairing.expiresAt - pairing.createdAt > 1_800_000
  )
    throw new Error(
      "This connection code expired or the computers' clocks disagree. Create a new invitation.",
    );
  if (pairing.kind !== pairing.description.type)
    throw new Error("The connection code has an invalid description.");
  return message;
}

const decodeCode = decodePeerCode;

export type PeerLinkState =
  | "idle"
  | "gathering"
  | "waiting"
  | "connecting"
  | "connected"
  | "disconnected"
  | "failed";
export interface PeerConnectionDiagnostics {
  state: PeerLinkState;
  iceState: string;
  transportState: string;
  gatheringState: string;
  remoteDescription: boolean;
  localCandidateTypes: string[];
  remoteCandidateTypes: string[];
  turnConfigured: boolean;
  iceServerErrors: { service: "stun" | "turn"; code: number }[];
}
function candidateTypes(sdp = ""): string[] {
  return [
    ...new Set(
      [...sdp.matchAll(/ typ (host|srflx|prflx|relay)(?:\s|$)/g)].map(
        (m) => m[1],
      ),
    ),
  ];
}
const MAX_MESSAGE_BYTES = MAX_PEER_MESSAGE_BYTES;
const CHUNK_CHARS = 12_000;

/** One paired, encrypted WebRTC data channel; supports manual and automatic signaling. */
export class PeerConnection {
  private pc?: RTCPeerConnection;
  private channel?: RTCDataChannel;
  private sendQueue = Promise.resolve();
  private pending = new Map<
    string,
    {
      parts: string[];
      total: number;
      bytes: number;
      received: number;
      expires: number;
    }
  >();
  private timer?: ReturnType<typeof setInterval>;
  private offer?: SignedPeerMessage;
  private generation = 0;
  private session?: string;
  private publishedDescription = false;
  private remoteReady = false;
  private remoteCandidates: RTCIceCandidateInit[] = [];
  private candidateKeys = new Set<string>();
  private applyingCandidates = Promise.resolve();
  private localTypes = new Set<string>();
  private remoteTypes = new Set<string>();
  private iceErrors: PeerConnectionDiagnostics["iceServerErrors"] = [];
  private turnConfigured = false;
  private state: PeerLinkState = "idle";
  get sessionId() {
    return this.session;
  }
  diagnostics(): PeerConnectionDiagnostics {
    return {
      state: this.state,
      iceState: this.pc?.iceConnectionState ?? "closed",
      transportState: this.pc?.connectionState ?? "closed",
      gatheringState: this.pc?.iceGatheringState ?? "complete",
      remoteDescription: this.remoteReady,
      localCandidateTypes: [
        ...new Set([
          ...this.localTypes,
          ...candidateTypes(this.pc?.localDescription?.sdp),
        ]),
      ],
      remoteCandidateTypes: [...this.remoteTypes],
      turnConfigured: this.turnConfigured,
      iceServerErrors: [...this.iceErrors],
    };
  }
  private status(state: PeerLinkState, remoteId = this.remoteId) {
    this.state = state;
    if (remoteId) this.callbacks.status(state, remoteId);
    else this.callbacks.status(state);
  }
  connectionFailure() {
    const d = this.diagnostics();
    if (!d.remoteDescription)
      return "No connection reply received. Retrying through Nostr; check relay acceptance on both devices.";
    const failed = d.iceState === "failed" || d.transportState === "failed";
    if (!failed) {
      if (this.connected)
        return "The peer transfer was interrupted. Saved work will retry.";
      if (!d.remoteCandidateTypes.length)
        return "Reply received; waiting for remote connection candidates. Setup is still in progress.";
      return "Reply received; connection checks are still in progress. No usable route has been confirmed yet.";
    }
    if (d.turnConfigured && !d.localCandidateTypes.includes("relay"))
      return "Connection checks failed and TURN provided no relay candidate. Check the TURN address, credentials and reachability. Saved work will retry.";
    if (!d.turnConfigured && !d.localCandidateTypes.includes("srflx"))
      return "Connection checks failed and STUN provided no external candidate. Check network access or configure TURN. Saved work will retry.";
    return d.turnConfigured
      ? "Connection checks failed after a reply was received. Check TURN reachability on both networks. Saved work will retry."
      : "Connection checks failed after a reply was received. A NAT or firewall restriction may require TURN in Relay settings. Saved work will retry.";
  }

  remoteId?: string;
  connected = false;
  constructor(
    readonly identity: PeerIdentity,
    readonly callbacks: {
      status: (state: PeerLinkState, remoteId?: string) => void;
      message: (raw: unknown) => void;
      error: (message: string) => void;
      candidate?: (sessionId: string, candidate: IceCandidate) => void;
    },
  ) {}
  private prepare(settings: PeerIceSettings) {
    const iceServers = peerIceServers(settings);
    this.disconnect();
    const pc = new RTCPeerConnection({ iceServers });
    this.pc = pc;
    this.turnConfigured = !!settings.turn.trim();
    pc.onicecandidate = (event) => {
      if (this.pc !== pc || !event.candidate?.candidate) return;
      for (const type of candidateTypes(event.candidate.candidate))
        this.localTypes.add(type);
      // The initial SDP contains early candidates. Continue exchanging candidates
      // that arrive after the bounded initial gathering wait instead of losing them.
      if (this.publishedDescription && this.session)
        this.callbacks.candidate?.(
          this.session,
          iceCandidateSchema.parse(event.candidate.toJSON()),
        );
    };
    pc.onicecandidateerror = (event) => {
      if (this.pc !== pc) return;
      const service = event.url?.startsWith("turn") ? "turn" : "stun";
      if (
        this.iceErrors.length < 8 &&
        !this.iceErrors.some(
          (e) => e.service === service && e.code === event.errorCode,
        )
      )
        this.iceErrors.push({ service, code: event.errorCode });
    };
    this.status("gathering");
    pc.oniceconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.iceConnectionState === "failed") {
        this.connected = false;
        this.status("failed", this.remoteId);
        this.callbacks.error(this.connectionFailure());
      } else this.status(this.state, this.remoteId);
    };
    pc.onconnectionstatechange = () => {
      if (this.pc !== pc) return;
      if (pc.connectionState === "failed") {
        this.connected = false;
        this.status("failed", this.remoteId);
        this.callbacks.error(this.connectionFailure());
      } else if (
        pc.connectionState === "disconnected" ||
        pc.connectionState === "closed"
      ) {
        this.connected = false;
        this.status("disconnected", this.remoteId);
      } else if (
        pc.connectionState === "connected" &&
        this.channel?.readyState === "open"
      ) {
        this.connected = true;
        this.status("connected", this.remoteId);
      } else if (
        !this.connected &&
        this.remoteId &&
        pc.connectionState === "connecting"
      )
        this.status("connecting", this.remoteId);
    };
    pc.ondatachannel = (event) => {
      if (
        this.pc !== pc ||
        event.channel.label !== "rosettatab-peer-v1" ||
        this.channel
      )
        event.channel.close();
      else this.attach(event.channel, pc);
    };
    this.timer = setInterval(() => {
      for (const [id, transfer] of this.pending)
        if (transfer.expires < Date.now()) this.pending.delete(id);
    }, 10_000);
    return pc;
  }
  private attach(channel: RTCDataChannel, pc: RTCPeerConnection) {
    this.channel = channel;
    channel.bufferedAmountLowThreshold = 65_536;
    channel.onopen = () => {
      if (this.pc !== pc) return;
      this.connected = true;
      this.status("connected", this.remoteId);
    };
    channel.onclose = () => {
      if (this.pc !== pc) return;
      this.connected = false;
      this.status("disconnected", this.remoteId);
    };
    channel.onerror = () => {
      if (this.pc !== pc || this.channel !== channel) return;
      this.callbacks.error(
        "The peer data channel failed. Saved jobs and results remain on this device.",
      );
    };
    channel.onmessage = (event) => {
      if (this.pc !== pc) return;
      try {
        if (
          typeof event.data !== "string" ||
          event.data.length > CHUNK_CHARS * 6 + 300
        )
          throw new Error("Invalid peer packet.");
        const packet = JSON.parse(event.data);
        if (
          packet.v !== 1 ||
          typeof packet.id !== "string" ||
          !/^[a-f0-9-]{36}$/i.test(packet.id) ||
          !Number.isInteger(packet.index) ||
          !Number.isInteger(packet.total) ||
          packet.total < 1 ||
          packet.total > Math.ceil(MAX_MESSAGE_BYTES / CHUNK_CHARS) ||
          packet.index < 0 ||
          packet.index >= packet.total ||
          typeof packet.text !== "string" ||
          packet.text.length > CHUNK_CHARS
        )
          throw new Error("Invalid peer packet.");
        let transfer = this.pending.get(packet.id);
        if (!transfer) {
          if (this.pending.size >= 2)
            throw new Error("Too many incomplete peer messages.");
          transfer = {
            parts: new Array(packet.total),
            total: packet.total,
            bytes: 0,
            received: 0,
            expires: Date.now() + 120_000,
          };
          this.pending.set(packet.id, transfer);
        }
        if (transfer.total !== packet.total)
          throw new Error("Conflicting peer packet.");
        if (transfer.parts[packet.index] !== undefined) {
          if (transfer.parts[packet.index] !== packet.text)
            throw new Error("Conflicting peer packet.");
          return;
        }
        transfer.bytes += new TextEncoder().encode(packet.text).length;
        if (transfer.bytes > MAX_MESSAGE_BYTES) {
          this.pending.delete(packet.id);
          throw new Error(
            "Peer transfer exceeds the connection memory budget.",
          );
        }
        transfer.parts[packet.index] = packet.text;
        transfer.received++;
        transfer.expires = Date.now() + 120_000;
        if (transfer.received === transfer.total) {
          this.pending.delete(packet.id);
          this.callbacks.message(JSON.parse(transfer.parts.join("")));
        }
      } catch {
        this.callbacks.error("Rejected a damaged or oversized peer message.");
      }
    };
  }
  private async gather(pc: RTCPeerConnection) {
    if (pc.iceGatheringState !== "complete")
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timeout);
          pc.removeEventListener("icegatheringstatechange", changed);
          resolve();
        };
        const changed = () => {
          if (pc.iceGatheringState === "complete") finish();
        };
        const timeout = setTimeout(finish, 8_000);
        pc.addEventListener("icegatheringstatechange", changed);
        changed();
      });
    if (this.pc !== pc || !pc.localDescription?.sdp)
      throw new Error("Connection setup was cancelled.");
    this.publishedDescription = true;
    return {
      type: pc.localDescription.type as "offer" | "answer",
      sdp: pc.localDescription.sdp,
    };
  }
  async createInvitation(settings: PeerIceSettings) {
    const pc = this.prepare(settings);
    this.session = crypto.randomUUID();
    this.attach(
      pc.createDataChannel("rosettatab-peer-v1", { ordered: true }),
      pc,
    );
    const localOffer = await pc.createOffer();
    this.assertCurrent(pc);
    await pc.setLocalDescription(localOffer);
    const description = await this.gather(pc);
    const createdAt = Date.now();
    const offer = await signPeerMessage(this.identity, {
      type: "pairing",
      pairing: {
        kind: "offer",
        sessionId: this.session!,
        description,
        createdAt,
        expiresAt: createdAt + 1_800_000,
      },
    });
    this.assertCurrent(pc);
    this.offer = offer;
    this.status("waiting");
    return encodeCode(this.offer);
  }
  async joinInvitation(code: string, settings: PeerIceSettings) {
    const generation = this.generation;
    const offer = await decodeCode(code);
    if (generation !== this.generation)
      throw new Error("Connection setup was cancelled.");
    if (
      offer.payload.type !== "pairing" ||
      offer.payload.pairing.kind !== "offer"
    )
      throw new Error("Join needs an invitation code, not a reply.");
    if (offer.senderId === this.identity.id)
      throw new Error(
        "Use a different browser profile or device for the other peer.",
      );
    const pc = this.prepare(settings);
    this.remoteId = offer.senderId;
    this.session = offer.payload.pairing.sessionId;
    await pc.setRemoteDescription(offer.payload.pairing.description);
    this.assertCurrent(pc);
    this.remoteReady = true;
    for (const type of candidateTypes(offer.payload.pairing.description.sdp))
      this.remoteTypes.add(type);
    await this.flushRemoteCandidates(pc);
    const localAnswer = await pc.createAnswer();
    this.assertCurrent(pc);
    await pc.setLocalDescription(localAnswer);
    const description = await this.gather(pc);
    const createdAt = Date.now();
    const answer = await signPeerMessage(this.identity, {
      type: "pairing",
      pairing: {
        kind: "answer",
        sessionId: offer.payload.pairing.sessionId,
        replyTo: offer.id,
        description,
        createdAt,
        expiresAt: createdAt + 1_800_000,
      },
    });
    this.assertCurrent(pc);
    if (!this.connected) this.status("connecting", this.remoteId);
    return encodeCode(answer);
  }
  async connectReply(code: string) {
    const generation = this.generation;
    const answer = await decodeCode(code);
    if (generation !== this.generation)
      throw new Error("Connection setup was cancelled.");
    if (!this.pc || !this.offer || this.offer.payload.type !== "pairing")
      throw new Error("Create an invitation first.");
    if (this.remoteId || this.connected)
      throw new Error(
        "This invitation already has a reply. Create fresh codes to pair again.",
      );
    if (
      answer.payload.type !== "pairing" ||
      answer.payload.pairing.kind !== "answer" ||
      answer.payload.pairing.sessionId !==
        this.offer.payload.pairing.sessionId ||
      answer.payload.pairing.replyTo !== this.offer.id ||
      this.offer.payload.pairing.expiresAt <= Date.now() ||
      answer.senderId === this.identity.id
    )
      throw new Error("This reply does not belong to your invitation.");
    this.remoteId = answer.senderId;
    const pc = this.pc;
    await pc.setRemoteDescription(answer.payload.pairing.description);
    this.assertCurrent(pc);
    this.remoteReady = true;
    for (const type of candidateTypes(answer.payload.pairing.description.sdp))
      this.remoteTypes.add(type);
    await this.flushRemoteCandidates(pc);
    if (!this.connected) this.status("connecting", this.remoteId);
  }
  async addRemoteCandidates(
    sessionId: string,
    candidates: RTCIceCandidateInit[],
  ) {
    const pc = this.pc;
    if (!pc || sessionId !== this.session) return;
    for (const raw of candidates) {
      const candidate = iceCandidateSchema.parse(raw);
      const key = JSON.stringify(candidate);
      if (this.candidateKeys.has(key) || this.candidateKeys.size >= 128)
        continue;
      this.candidateKeys.add(key);
      this.remoteCandidates.push(candidate);
      for (const type of candidateTypes(candidate.candidate))
        this.remoteTypes.add(type);
    }
    await this.flushRemoteCandidates(pc);
  }
  private flushRemoteCandidates(pc: RTCPeerConnection) {
    // Serialize additions while setRemoteDescription may still be pending.
    const work = this.applyingCandidates
      .catch(() => {})
      .then(async () => {
        while (
          this.pc === pc &&
          this.remoteReady &&
          this.remoteCandidates.length
        ) {
          const candidate = this.remoteCandidates.shift()!;
          try {
            await pc.addIceCandidate(candidate);
          } catch {
            // One unusable candidate must not discard other viable routes.
          }
        }
      });
    this.applyingCandidates = work;
    return work;
  }
  private assertCurrent(pc: RTCPeerConnection) {
    if (this.pc !== pc) throw new Error("Connection setup was cancelled.");
  }
  send(message: SignedPeerMessage) {
    const generation = this.generation;
    const text = JSON.stringify(message);
    if (new TextEncoder().encode(text).length > MAX_MESSAGE_BYTES)
      return Promise.reject(new Error("Peer message exceeds 4 MB."));
    const task = this.sendQueue
      .catch(() => {})
      .then(async () => {
        const channel = this.channel;
        if (
          !this.connected ||
          !channel ||
          channel.readyState !== "open" ||
          generation !== this.generation
        )
          throw new Error(
            "Peer disconnected; the result stays saved for retry.",
          );
        const id = crypto.randomUUID(),
          total = Math.ceil(text.length / CHUNK_CHARS);
        for (let index = 0; index < total; index++) {
          if (channel.bufferedAmount > 262_144)
            await new Promise<void>((resolve, reject) => {
              const done = () => {
                clearTimeout(timer);
                channel.removeEventListener("bufferedamountlow", done);
                resolve();
              };
              const timer = setTimeout(() => {
                channel.removeEventListener("bufferedamountlow", done);
                reject(
                  new Error(
                    "Peer transfer timed out. Retry saved results after reconnecting.",
                  ),
                );
              }, 10_000);
              channel.addEventListener("bufferedamountlow", done, {
                once: true,
              });
            });
          if (
            !this.connected ||
            channel.readyState !== "open" ||
            generation !== this.generation
          )
            throw new Error("Peer disconnected; saved results can be retried.");
          channel.send(
            JSON.stringify({
              v: 1,
              id,
              index,
              total,
              text: text.slice(index * CHUNK_CHARS, (index + 1) * CHUNK_CHARS),
            }),
          );
        }
      });
    this.sendQueue = task;
    return task;
  }
  async connectionKind(): Promise<"direct" | "relayed" | "unknown"> {
    if (!this.pc || !this.connected) return "unknown";
    const stats = await this.pc.getStats();
    let kind: "direct" | "relayed" | "unknown" = "unknown";
    stats.forEach((entry) => {
      if (
        entry.type === "candidate-pair" &&
        entry.state === "succeeded" &&
        entry.nominated
      ) {
        const local = stats.get(entry.localCandidateId),
          remote = stats.get(entry.remoteCandidateId);
        kind =
          local?.candidateType === "relay" || remote?.candidateType === "relay"
            ? "relayed"
            : "direct";
      }
    });
    return kind;
  }
  disconnect() {
    this.generation++;
    this.connected = false;
    const pc = this.pc;
    this.pc = undefined;
    this.channel?.close();
    pc?.close();
    this.channel = undefined;
    this.remoteId = undefined;
    this.offer = undefined;
    this.session = undefined;
    this.publishedDescription = false;
    this.remoteReady = false;
    this.remoteCandidates = [];
    this.candidateKeys.clear();
    this.applyingCandidates = Promise.resolve();
    this.localTypes.clear();
    this.remoteTypes.clear();
    this.iceErrors = [];
    this.turnConfigured = false;
    this.pending.clear();
    if (this.timer) clearInterval(this.timer);
    this.status("disconnected");
  }
}
