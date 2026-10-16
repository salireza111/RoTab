import {
  connectivityUpdateSchema,
  type ConnectivityUpdate,
} from "./connectivity-signaling";
import { z } from "zod";
import {
  finalizeEvent,
  generateSecretKey,
  getPublicKey,
  verifyEvent,
  type Event as NostrEvent,
} from "nostr-tools/pure";
import { v2 as nip44 } from "nostr-tools/nip44";
import {
  peerSha256,
  verifyPeerMessage,
  type NetworkPresence,
  type SignedPeerMessage,
} from "./peer-protocol";
import { getState, putState } from "./storage";

export const NOSTR_PRESENCE_KIND = 23370;
export const NOSTR_SIGNAL_KIND = 23371;
import {
  networkSettingsSchema,
  type NetworkSettings,
} from "./network-settings";
export {
  DEFAULT_RELAYS,
  networkSettingsSchema,
  defaultNetworkSettings,
  type NetworkSettings,
} from "./network-settings";
export interface NostrIdentity {
  secret: Uint8Array;
  publicKey: string;
}
let loadingIdentity: Promise<NostrIdentity> | undefined;
export function loadNostrIdentity(): Promise<NostrIdentity> {
  return (loadingIdentity ??= readNostrIdentity().finally(() => {
    loadingIdentity = undefined;
  }));
}
async function readNostrIdentity(): Promise<NostrIdentity> {
  const saved = await getState<Uint8Array>("nostr-secret");
  if (
    saved !== undefined &&
    (!(saved instanceof Uint8Array) || saved.length !== 32)
  )
    throw new Error(
      "The saved Nostr identity is invalid; network records were preserved.",
    );
  const secret = saved ?? generateSecretKey(),
    publicKey = getPublicKey(secret);
  if (!saved) await putState("nostr-secret", secret);
  return { secret, publicKey };
}
const eventSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    pubkey: z.string().regex(/^[a-f0-9]{64}$/),
    created_at: z.number().int().nonnegative(),
    kind: z.number().int(),
    tags: z.array(z.array(z.string().max(256)).min(1).max(4)).max(10),
    content: z.string().max(120_000),
    sig: z.string().regex(/^[a-f0-9]{128}$/),
  })
  .strict();
const signalBase = {
  room: z.string().regex(/^[a-f0-9]{64}$/),
  recipient: z.string().regex(/^[a-f0-9]{64}$/),
  senderId: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
};
const signalSchema = z.discriminatedUnion("version", [
  z
    .object({
      ...signalBase,
      version: z.literal(1),
      code: z.string().startsWith("RT1.").max(60_000),
    })
    .strict(),
  z
    .object({
      ...signalBase,
      version: z.literal(2),
      update: connectivityUpdateSchema,
    })
    .strict(),
]);
export type ConnectivitySignal = z.infer<typeof signalSchema>;
export interface DiscoveredPeer {
  peerId: string;
  nostrPublicKey: string;
  envelope: SignedPeerMessage;
  presence: NetworkPresence;
  seenAt: number;
}
export interface RelayStatus {
  url: string;
  state: "connecting" | "connected" | "offline" | "rejected";
  acceptedAt?: number;
  error?: string;
}
export const roomTopic = (room: string) =>
  peerSha256("rotab-network-v1:" + room.trim());

/** Strictly bounded NIP-01 events; verify the outer signature before NIP-44 decryption. */
export function checkedNostrEvent(
  raw: unknown,
  room: string,
  now = Date.now(),
): NostrEvent {
  const event = eventSchema.parse(raw);
  if (event.kind !== NOSTR_PRESENCE_KIND && event.kind !== NOSTR_SIGNAL_KIND)
    throw new Error("Unsupported network event.");
  if (
    event.created_at * 1000 < now - 60_000 ||
    event.created_at * 1000 > now + 30_000
  )
    throw new Error("Stale network event.");
  if (
    event.tags.filter((t) => t[0] === "t").length !== 1 ||
    !event.tags.some((t) => t[0] === "t" && t[1] === room)
  )
    throw new Error("Wrong network room.");
  if (!verifyEvent(event)) throw new Error("Invalid Nostr event signature.");
  return event;
}
export async function decodePresence(
  event: NostrEvent,
  now = Date.now(),
): Promise<DiscoveredPeer> {
  if (event.kind !== NOSTR_PRESENCE_KIND || event.content.length > 20_000)
    throw new Error("Invalid presence event.");
  const raw = JSON.parse(event.content);
  const envelope = await verifyPeerMessage(raw, raw?.senderId);
  if (
    envelope.payload.type !== "network" ||
    envelope.payload.message.kind !== "presence"
  )
    throw new Error("Invalid presence command.");
  const presence = envelope.payload.message;
  if (
    presence.nostrPublicKey !== event.pubkey ||
    presence.expiresAt <= now ||
    presence.issuedAt > now + 30_000 ||
    presence.expiresAt - presence.issuedAt !== 45_000 ||
    Math.abs(event.created_at * 1000 - presence.issuedAt) > 1000 ||
    presence.campaigns.some((c) => c.waiting + c.completed > c.total)
  )
    throw new Error("Invalid presence binding or lifetime.");
  return {
    peerId: envelope.senderId,
    nostrPublicKey: event.pubkey,
    envelope,
    presence,
    seenAt: now,
  };
}
export function encryptedSignal(
  identity: NostrIdentity,
  recipient: string,
  room: string,
  senderId: string,
  code: string,
  now = Date.now(),
): NostrEvent {
  const message = signalSchema.parse({
    version: 1,
    room,
    recipient,
    senderId,
    code,
    createdAt: now,
    expiresAt: now + 45_000,
  });
  return sealSignal(identity, message);
}
export function encryptedConnectivitySignal(
  identity: NostrIdentity,
  recipient: string,
  room: string,
  senderId: string,
  update: ConnectivityUpdate,
  now = Date.now(),
): NostrEvent {
  return sealSignal(
    identity,
    signalSchema.parse({
      version: 2,
      room,
      recipient,
      senderId,
      update,
      createdAt: now,
      expiresAt: now + 45_000,
    }),
  );
}
function sealSignal(
  identity: NostrIdentity,
  message: ConnectivitySignal,
): NostrEvent {
  const { recipient, room, createdAt: now } = message;
  const content = nip44.encrypt(
    JSON.stringify(message),
    nip44.utils.getConversationKey(identity.secret, recipient),
  );
  return finalizeEvent(
    {
      kind: NOSTR_SIGNAL_KIND,
      created_at: Math.floor(now / 1000),
      tags: [
        ["t", room],
        ["p", recipient],
      ],
      content,
    },
    identity.secret,
  );
}
export function decryptSignal(
  event: NostrEvent,
  identity: NostrIdentity,
  room: string,
  now = Date.now(),
) {
  if (
    event.kind !== NOSTR_SIGNAL_KIND ||
    event.tags.filter((t) => t[0] === "p").length !== 1 ||
    !event.tags.some((t) => t[0] === "p" && t[1] === identity.publicKey)
  )
    throw new Error("Wrong signal recipient.");
  const message = signalSchema.parse(
    JSON.parse(
      nip44.decrypt(
        event.content,
        nip44.utils.getConversationKey(identity.secret, event.pubkey),
      ),
    ),
  );
  if (
    message.room !== room ||
    message.recipient !== identity.publicKey ||
    message.expiresAt <= now ||
    message.createdAt > now + 30_000 ||
    message.expiresAt - message.createdAt !== 45_000 ||
    Math.abs(event.created_at * 1000 - message.createdAt) > 1000
  )
    throw new Error("Invalid signal binding or lifetime.");
  return message;
}

/** Nostr is rendezvous only: this adapter cannot send a scientific job/result. */
export class NostrDiscovery {
  private sockets = new Map<string, WebSocket>();
  private reconnects = new Map<string, ReturnType<typeof setTimeout>>();
  private attempts = new Map<string, number>();
  private statuses = new Map<string, RelayStatus>();
  private seen = new Map<string, number>();
  private stopped = false;
  private topic = "";
  private subscription = "";
  private windowAt = 0;
  private eventCount = 0;
  private retryTimer?: ReturnType<typeof setInterval>;
  private cooldowns = new Map<string, number>();
  private closedSubscriptions = new Set<string>();
  private outgoing = new Map<
    string,
    {
      event: NostrEvent;
      expiresAt: number;
      sent: Map<string, number>;
      accepted: Set<string>;
    }
  >();
  constructor(
    readonly identity: NostrIdentity,
    readonly settings: NetworkSettings,
    readonly callbacks: {
      presence(peer: DiscoveredPeer): void;
      signal(
        senderNostrKey: string,
        message: ReturnType<typeof decryptSignal>,
      ): void;
      status(status: RelayStatus[]): void;
      opened(): void;
    },
  ) {}
  async start() {
    networkSettingsSchema.parse(this.settings);
    this.topic = await roomTopic(this.settings.room);
    if (this.stopped) return;
    this.subscription = "rotab-" + this.topic.slice(0, 24);
    this.retryTimer = setInterval(() => this.flush(), 2_000);
    for (const url of new Set(this.settings.relays)) this.connect(url);
  }
  private status(
    url: string,
    state: RelayStatus["state"],
    error?: string,
    acceptedAt?: number,
  ) {
    if (state === "connected")
      acceptedAt ??= this.statuses.get(url)?.acceptedAt;
    this.statuses.set(url, {
      url,
      state,
      ...(error ? { error } : {}),
      ...(acceptedAt ? { acceptedAt } : {}),
    });
    this.callbacks.status([...this.statuses.values()]);
  }
  private connect(url: string) {
    if (this.stopped) return;
    this.status(url, "connecting");
    const socket = new WebSocket(url);
    this.sockets.set(url, socket);
    socket.onopen = () => {
      if (this.stopped || this.sockets.get(url) !== socket) return;
      this.attempts.set(url, 0);
      // A socket opening is not evidence that a relay accepts our events.
      this.status(url, "connecting");
      this.cooldowns.delete(url);
      this.closedSubscriptions.delete(url);
      for (const item of this.outgoing.values()) {
        item.sent.delete(url);
        item.accepted.delete(url);
      }
      socket.send(
        JSON.stringify([
          "REQ",
          this.subscription,
          {
            kinds: [NOSTR_PRESENCE_KIND],
            "#t": [this.topic],
            since: Math.floor(Date.now() / 1000) - 45,
            limit: 100,
          },
          {
            kinds: [NOSTR_SIGNAL_KIND],
            "#t": [this.topic],
            "#p": [this.identity.publicKey],
            since: Math.floor(Date.now() / 1000) - 45,
            limit: 20,
          },
        ]),
      );
      this.callbacks.opened();
      this.flush();
    };
    socket.onmessage = ({ data }) => {
      if (
        this.stopped ||
        this.sockets.get(url) !== socket ||
        typeof data !== "string" ||
        data.length > 125_000
      )
        return;
      void this.receive(url, data).catch(() => {}); // Untrusted network input; never render relay-supplied HTML/errors.
    };
    socket.onerror = () => {
      if (!this.stopped && this.sockets.get(url) === socket)
        this.status(url, "offline", "Relay connection failed.");
    };
    socket.onclose = () => {
      if (this.stopped || this.sockets.get(url) !== socket) return;
      this.status(url, "offline");
      const attempt = (this.attempts.get(url) ?? 0) + 1;
      this.attempts.set(url, attempt);
      this.reconnects.set(
        url,
        setTimeout(
          () => this.connect(url),
          Math.min(60_000, 2_000 * 2 ** Math.min(5, attempt - 1)),
        ),
      );
    };
  }
  private async receive(url: string, data: string) {
    const packet: unknown = JSON.parse(data);
    if (!Array.isArray(packet)) return;
    if (packet[0] === "OK") {
      const item = this.outgoing.get(packet[1]);
      if (!item || !item.sent.has(url)) return;
      if (
        packet[2] === true ||
        (packet[2] === false && String(packet[3]).startsWith("duplicate:"))
      ) {
        item.accepted.add(url);
        if ((this.cooldowns.get(url) ?? 0) <= Date.now())
          this.status(url, "connected", undefined, Date.now());
      } else if (packet[2] === false) {
        const reason =
          typeof packet[3] === "string"
            ? packet[3].replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240)
            : "No reason supplied";
        const delay = reason.startsWith("rate-limited:") ? 15_000 : 60_000;
        this.cooldowns.set(url, Date.now() + delay);
        this.status(
          url,
          "rejected",
          `Relay rejected ${item.event.kind === NOSTR_SIGNAL_KIND ? "connection signaling" : "presence"}: ${reason}`,
        );
      }
      return;
    }
    if (packet[0] === "EOSE" && packet[1] === this.subscription) {
      if (this.statuses.get(url)?.state !== "rejected")
        this.status(url, "connected");
      return;
    }
    if (packet[0] === "AUTH") {
      this.cooldowns.set(url, Date.now() + 60_000);
      this.closedSubscriptions.add(url);
      this.status(
        url,
        "rejected",
        "Relay requires authentication. Use another relay that allows public rendezvous.",
      );
      return;
    }
    if (packet[0] === "CLOSED" && packet[1] === this.subscription) {
      const reason =
        typeof packet[2] === "string"
          ? packet[2].replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 240)
          : "No reason supplied";
      this.cooldowns.set(url, Date.now() + 60_000);
      this.closedSubscriptions.add(url);
      this.status(
        url,
        "rejected",
        `Relay refused this subscription: ${reason}`,
      );
      return;
    }
    if (packet[0] !== "EVENT" || packet[1] !== this.subscription) return;
    const now = Date.now();
    if (now - this.windowAt > 1000) {
      this.windowAt = now;
      this.eventCount = 0;
    }
    if (++this.eventCount > 50) return;
    const candidate = eventSchema.parse(packet[2]);
    if (
      candidate.pubkey === this.identity.publicKey ||
      this.seen.has(candidate.id)
    )
      return;
    const event = checkedNostrEvent(candidate, this.topic, now);
    this.seen.set(event.id, now);
    if (this.seen.size > 2000)
      for (const [id, at] of this.seen)
        if (at < now - 60_000) this.seen.delete(id);
    if (this.seen.size > 4000) this.seen.delete(this.seen.keys().next().value!);
    if (event.kind === NOSTR_PRESENCE_KIND)
      this.callbacks.presence(await decodePresence(event, now));
    else
      this.callbacks.signal(
        event.pubkey,
        decryptSignal(event, this.identity, this.topic, now),
      );
  }
  private send(event: NostrEvent) {
    if (this.stopped) return;
    if (event.kind === NOSTR_PRESENCE_KIND)
      for (const [id, item] of this.outgoing)
        if (item.event.kind === NOSTR_PRESENCE_KIND) this.outgoing.delete(id);
    this.outgoing.set(event.id, {
      event,
      expiresAt: event.created_at * 1000 + 45_000,
      sent: new Map(),
      accepted: new Set(),
    });
    while (this.outgoing.size > 65)
      this.outgoing.delete(this.outgoing.keys().next().value!);
    this.flush();
  }
  private flush() {
    if (this.stopped) return;
    const now = Date.now();
    for (const url of this.closedSubscriptions) {
      if ((this.cooldowns.get(url) ?? 0) <= now) {
        this.closedSubscriptions.delete(url);
        // A CLOSED subscription cannot receive new peers; reconnect to resubscribe.
        this.sockets.get(url)?.close();
      }
    }
    for (const [id, item] of this.outgoing) {
      if (item.expiresAt <= now) {
        this.outgoing.delete(id);
        continue;
      }
      for (const [url, socket] of this.sockets) {
        if (
          socket.readyState !== WebSocket.OPEN ||
          socket.bufferedAmount >= 250_000 ||
          (this.cooldowns.get(url) ?? 0) > now ||
          this.closedSubscriptions.has(url) ||
          item.accepted.has(url) ||
          (item.sent.has(url) && now - item.sent.get(url)! < 8_000)
        )
          continue;
        try {
          item.sent.set(url, now);
          socket.send(JSON.stringify(["EVENT", item.event]));
        } catch {
          this.status(
            url,
            "offline",
            "Relay send failed; pending signals will retry.",
          );
        }
      }
    }
  }
  announce(envelope: SignedPeerMessage) {
    if (
      envelope.payload.type !== "network" ||
      envelope.payload.message.kind !== "presence"
    )
      throw new Error("Only presence can be announced to relays.");
    const presence = envelope.payload.message;
    if (presence.nostrPublicKey !== this.identity.publicKey)
      throw new Error("Wrong announcement identity.");
    this.send(
      finalizeEvent(
        {
          kind: NOSTR_PRESENCE_KIND,
          created_at: Math.floor(presence.issuedAt / 1000),
          tags: [["t", this.topic]],
          content: JSON.stringify(envelope),
        },
        this.identity.secret,
      ),
    );
  }
  async signal(recipient: string, senderId: string, code: string) {
    this.send(
      encryptedSignal(this.identity, recipient, this.topic, senderId, code),
    );
  }
  async connectivity(
    recipient: string,
    senderId: string,
    update: ConnectivityUpdate,
  ) {
    this.send(
      encryptedConnectivitySignal(
        this.identity,
        recipient,
        this.topic,
        senderId,
        update,
      ),
    );
  }
  stop() {
    this.stopped = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    for (const timer of this.reconnects.values()) clearTimeout(timer);
    for (const socket of this.sockets.values()) socket.close();
    this.sockets.clear();
    this.reconnects.clear();
    this.outgoing.clear();
  }
}
