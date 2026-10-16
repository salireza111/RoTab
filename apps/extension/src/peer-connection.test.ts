import { readFileSync } from "node:fs";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ENGINE_ID, SOURCE_SHA, type EngineManifest } from "@rosettatab/shared";
import { PeerConnection, type PeerIceSettings } from "./peer-connection";
import {
  generatePeerIdentity,
  peerSha256,
  signPeerMessage,
  validatePeerJob,
  verifyPeerMessage,
  type PeerIdentity,
  type PeerJob,
} from "./peer-protocol";

// This isolates signaling, packet framing and lifecycle; it does not claim an
// actual network route or scientific execution. Signatures and PDB bytes are real.
class FakeDataChannel extends EventTarget {
  label = "rosettatab-peer-v1";
  readyState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen?: () => void;
  onclose?: () => void;
  onerror?: () => void;
  onmessage?: (event: { data: unknown }) => void;
  target?: FakeDataChannel;
  sent: string[] = [];
  send = vi.fn((text: string) => {
    this.sent.push(text);
    this.target?.receive(text);
  });
  close = vi.fn(() => {
    this.readyState = "closed";
    this.onclose?.();
  });
  open() {
    this.readyState = "open";
    this.onopen?.();
  }
  receive(data: unknown) {
    this.onmessage?.({ data });
  }
}

class FakeRTC extends EventTarget {
  static all: FakeRTC[] = [];
  connectionState = "new";
  iceGatheringState = "complete";
  iceConnectionState = "new";
  oniceconnectionstatechange?: () => void;
  localDescription?: RTCSessionDescriptionInit;
  remoteDescription?: RTCSessionDescriptionInit;
  localChannel?: FakeDataChannel;
  onconnectionstatechange?: () => void;
  ondatachannel?: (event: { channel: FakeDataChannel }) => void;
  remoteGate?: Promise<void>;
  onicecandidate?: (event: {
    candidate: { candidate: string; toJSON(): RTCIceCandidateInit } | null;
  }) => void;
  onicecandidateerror?: (event: { url: string; errorCode: number }) => void;
  addIceCandidate = vi.fn(async (_candidate: RTCIceCandidateInit) => {});
  constructor(readonly configuration: RTCConfiguration) {
    super();
    FakeRTC.all.push(this);
  }
  createDataChannel() {
    return (this.localChannel = new FakeDataChannel());
  }
  createOffer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
    type: "offer",
    sdp: "v=0\r\nfake transport offer\r\n",
  }));
  createAnswer = vi.fn(async (): Promise<RTCSessionDescriptionInit> => ({
    type: "answer",
    sdp: "v=0\r\nfake transport answer\r\n",
  }));
  setLocalDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      this.localDescription = description;
    },
  );
  setRemoteDescription = vi.fn(
    async (description: RTCSessionDescriptionInit) => {
      await this.remoteGate;
      this.remoteDescription = description;
    },
  );
  close = vi.fn(() => {
    this.connectionState = "closed";
    this.onconnectionstatechange?.();
  });
  getStats = vi.fn(async () => new Map());
  state(value: string) {
    this.connectionState = value;
    this.onconnectionstatechange?.();
  }
  incoming(channel: FakeDataChannel) {
    this.ondatachannel?.({ channel });
  }
}

const settings: PeerIceSettings = {
  stun: "",
  turn: "",
  username: "",
  credential: "",
};
const links: PeerConnection[] = [];
function link(identity: PeerIdentity) {
  const callbacks = {
    status: vi.fn(),
    message: vi.fn(),
    error: vi.fn(),
    candidate: vi.fn(),
  };
  const connection = new PeerConnection(identity, callbacks);
  links.push(connection);
  return { connection, callbacks };
}
async function pair() {
  const firstIdentity = await generatePeerIdentity(),
    secondIdentity = await generatePeerIdentity();
  const first = link(firstIdentity),
    second = link(secondIdentity);
  const offer = await first.connection.createInvitation(settings);
  const firstPc = FakeRTC.all.at(-1)!;
  const reply = await second.connection.joinInvitation(offer, settings);
  const secondPc = FakeRTC.all.at(-1)!;
  await first.connection.connectReply(reply);
  const firstChannel = firstPc.localChannel!,
    secondChannel = new FakeDataChannel();
  secondPc.incoming(secondChannel);
  firstChannel.target = secondChannel;
  secondChannel.target = firstChannel;
  firstChannel.open();
  secondChannel.open();
  firstPc.state("connected");
  secondPc.state("connected");
  return {
    first,
    second,
    firstIdentity,
    secondIdentity,
    firstPc,
    secondPc,
    firstChannel,
    secondChannel,
    offer,
    reply,
  };
}
const pdb = readFileSync(
  new URL("../public/fixtures/1l2y.pdb", import.meta.url),
  "utf8",
);
const manifest: EngineManifest = {
  id: ENGINE_ID,
  sourceSha: SOURCE_SHA,
  verified: true,
  module: "rosetta.mjs",
  database: "rosetta.data",
  reason: "Transport fixture",
  supportedProtocols: ["score"],
  hashes: {
    "rosetta.mjs": "a".repeat(64),
    "rosetta.wasm": "b".repeat(64),
    "rosetta.data": "c".repeat(64),
  },
};
async function job(identity: PeerIdentity): Promise<PeerJob> {
  return {
    id: crypto.randomUUID(),
    title: "Trp-cage peer experiment",
    createdAt: Date.now(),
    expiresAt: Date.now() + 86_400_000,
    publisherId: identity.id,
    engine: {
      id: ENGINE_ID,
      sourceSha: SOURCE_SHA,
      hashes: manifest.hashes as PeerJob["engine"]["hashes"],
    },
    protocol: "score",
    seed: 17,
    models: 1,
    input: { pdb, sha256: await peerSha256(pdb) },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  FakeRTC.all = [];
  vi.stubGlobal("RTCPeerConnection", FakeRTC);
});
it("transfers signed coordinate data above the old 4 MiB message cap using bounded packets", async () => {
  const { first, second, firstIdentity, firstChannel } = await pair();
  const input = await job(firstIdentity);
  input.input.pdb = "REMARK    large input text\n".repeat(200_000) + pdb;
  input.input.sha256 = await peerSha256(input.input.pdb);
  const envelope = await signPeerMessage(firstIdentity, {
    type: "job",
    job: input,
  });
  await first.connection.send(envelope);
  expect(firstChannel.sent.length).toBeGreaterThan(350);
  expect(second.callbacks.error).not.toHaveBeenCalled();
  expect(second.callbacks.message).toHaveBeenCalledExactlyOnceWith(envelope);
  const received = await verifyPeerMessage(
    second.callbacks.message.mock.calls[0][0],
    firstIdentity.id,
  );
  expect(received.payload).toEqual(envelope.payload);
});
afterEach(() => {
  for (const connection of links.splice(0)) connection.disconnect();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("roundtrips the actual bundled signed job despite double JSON escaping and verifies its exact PDB bytes", async () => {
  const { first, second, firstIdentity, firstChannel, secondIdentity } =
    await pair();
  const input = await job(firstIdentity);
  const envelope = await signPeerMessage(firstIdentity, {
    type: "job",
    job: input,
  });
  await first.connection.send(envelope);
  expect(
    Math.max(...firstChannel.sent.map((packet) => packet.length)),
  ).toBeGreaterThan(12_300);
  expect(firstChannel.sent.length).toBeGreaterThan(1);
  expect(second.callbacks.error).not.toHaveBeenCalled();
  expect(second.callbacks.message).toHaveBeenCalledOnce();
  const received = await verifyPeerMessage(
    second.callbacks.message.mock.calls[0][0],
    firstIdentity.id,
  );
  expect(received).toEqual(envelope);
  if (received.payload.type !== "job")
    throw new Error("Expected a real job envelope");
  expect(
    (await validatePeerJob(received.payload.job, manifest)).input.pdb,
  ).toBe(pdb);
  const receipt = await signPeerMessage(secondIdentity, {
    type: "receipt",
    jobId: input.id,
    resultId: crypto.randomUUID(),
  });
  await second.connection.send(receipt);
  expect(
    await verifyPeerMessage(
      first.callbacks.message.mock.calls[0][0],
      secondIdentity.id,
    ),
  ).toEqual(receipt);
});

it("recovers an existing open data channel after temporary connection disconnection", async () => {
  const { first, second, firstPc, firstChannel, firstIdentity } = await pair();
  firstPc.state("disconnected");
  expect(first.connection.connected).toBe(false);
  expect(firstChannel.readyState).toBe("open");
  firstPc.state("connected");
  expect(first.connection.connected).toBe(true);
  expect(first.callbacks.status).toHaveBeenLastCalledWith(
    "connected",
    first.connection.remoteId,
  );
  await first.connection.send(
    await signPeerMessage(firstIdentity, {
      type: "hello",
      peerId: firstIdentity.id,
    }),
  );
  expect(second.callbacks.message).toHaveBeenCalledOnce();
});

it("keeps a local invitation ready when ICE probes start before its reply is applied", async () => {
  const requester = link(await generatePeerIdentity()),
    recipient = link(await generatePeerIdentity());
  const offer = await requester.connection.createInvitation(settings);
  const pc = FakeRTC.all.at(-1)!;
  const reply = await recipient.connection.joinInvitation(offer, settings);
  // A real answerer's connectivity probes can move the offerer to connecting
  // while its signaling state still awaits the manually exchanged answer.
  pc.state("connecting");
  expect(requester.callbacks.status).toHaveBeenLastCalledWith("waiting");
  expect(requester.connection.remoteId).toBeUndefined();
  expect(pc.setRemoteDescription).not.toHaveBeenCalled();
  await requester.connection.connectReply(reply);
  expect(requester.callbacks.status).toHaveBeenLastCalledWith(
    "connecting",
    recipient.connection.identity.id,
  );
  expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
});

it("consumes an invitation once and preserves the first peer pin against another valid signed reply", async () => {
  const requester = link(await generatePeerIdentity()),
    recipient = link(await generatePeerIdentity()),
    otherRecipient = link(await generatePeerIdentity());
  const offer = await requester.connection.createInvitation(settings);
  const pc = FakeRTC.all.at(-1)!;
  const reply = await recipient.connection.joinInvitation(offer, settings);
  const otherReply = await otherRecipient.connection.joinInvitation(
    offer,
    settings,
  );
  await requester.connection.connectReply(reply);
  const acceptedDescription = pc.remoteDescription;
  // The binding must already hold before a data channel opens, including when
  // the replacement reply is genuinely signed for this same offer.
  expect(requester.connection.connected).toBe(false);
  await expect(requester.connection.connectReply(otherReply)).rejects.toThrow(
    "already has a reply",
  );
  await expect(requester.connection.connectReply(reply)).rejects.toThrow(
    "already has a reply",
  );
  expect(requester.connection.remoteId).toBe(recipient.connection.identity.id);
  expect(pc.remoteDescription).toEqual(acceptedDescription);
  expect(pc.setRemoteDescription).toHaveBeenCalledOnce();
});

it("rejects stale data-channel events and errors after a replacement receiver connection", async () => {
  const first = link(await generatePeerIdentity()),
    remote = link(await generatePeerIdentity());
  await first.connection.createInvitation(settings);
  const oldPc = FakeRTC.all.at(-1)!,
    oldChannel = oldPc.localChannel!;
  const staleData = oldPc.ondatachannel!,
    staleError = oldChannel.onerror!;
  const offer = await remote.connection.createInvitation(settings);
  await first.connection.joinInvitation(offer, settings);
  const currentPc = FakeRTC.all.at(-1)!;
  const obsolete = new FakeDataChannel();
  staleData({ channel: obsolete });
  expect(obsolete.close).toHaveBeenCalledOnce();
  const actual = new FakeDataChannel();
  currentPc.incoming(actual);
  actual.open();
  expect(first.connection.connected).toBe(true);
  expect(actual.close).not.toHaveBeenCalled();
  staleError();
  expect(first.callbacks.error).not.toHaveBeenCalled();
});

it("cannot recreate a connection when invitation verification finishes after cancellation", async () => {
  const requester = link(await generatePeerIdentity()),
    recipient = link(await generatePeerIdentity());
  const offer = await requester.connection.createInvitation(settings);
  const count = FakeRTC.all.length,
    gate = deferred();
  const originalVerify = crypto.subtle.verify.bind(crypto.subtle);
  const verify = vi
    .spyOn(crypto.subtle, "verify")
    .mockImplementationOnce(async (...args) => {
      await gate.promise;
      return originalVerify(...args);
    });
  const joining = recipient.connection.joinInvitation(offer, settings);
  const rejected = expect(joining).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(verify).toHaveBeenCalled());
  recipient.connection.disconnect();
  gate.resolve();
  await rejected;
  expect(FakeRTC.all).toHaveLength(count);
  expect(recipient.connection.remoteId).toBeUndefined();
  expect(recipient.callbacks.status).toHaveBeenLastCalledWith("disconnected");
});

it("does not publish an obsolete signed offer after disconnect during signing", async () => {
  const first = link(await generatePeerIdentity()),
    gate = deferred();
  const originalSign = crypto.subtle.sign.bind(crypto.subtle);
  const sign = vi
    .spyOn(crypto.subtle, "sign")
    .mockImplementationOnce(async (...args) => {
      await gate.promise;
      return originalSign(...args);
    });
  const creating = first.connection.createInvitation(settings);
  const rejected = expect(creating).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(sign).toHaveBeenCalled());
  first.connection.disconnect();
  gate.resolve();
  await rejected;
  expect(first.callbacks.status).toHaveBeenLastCalledWith("disconnected");
  expect(FakeRTC.all[0].close).toHaveBeenCalledOnce();
});

it("does not publish a stale reply connection state after remote-description cancellation", async () => {
  const requester = link(await generatePeerIdentity()),
    recipient = link(await generatePeerIdentity());
  const offer = await requester.connection.createInvitation(settings);
  const pc = FakeRTC.all.at(-1)!;
  const reply = await recipient.connection.joinInvitation(offer, settings);
  const gate = deferred();
  pc.remoteGate = gate.promise;
  const connecting = requester.connection.connectReply(reply);
  const rejected = expect(connecting).rejects.toThrow("cancelled");
  await vi.waitFor(() => expect(pc.setRemoteDescription).toHaveBeenCalled());
  requester.connection.disconnect();
  gate.resolve();
  await rejected;
  expect(requester.callbacks.status).toHaveBeenLastCalledWith("disconnected");
  expect(requester.connection.connected).toBe(false);
});

it("keeps progressing chunks beyond two minutes while still expiring idle incomplete transfers", async () => {
  vi.useFakeTimers();
  const { first, second, firstChannel, secondChannel, firstIdentity } =
    await pair();
  const envelope = await signPeerMessage(firstIdentity, {
    type: "job",
    job: await job(firstIdentity),
  });
  firstChannel.target = undefined;
  await first.connection.send(envelope);
  expect(firstChannel.sent).toHaveLength(3);
  for (const packet of firstChannel.sent) {
    secondChannel.receive(packet);
    await vi.advanceTimersByTimeAsync(60_000);
  }
  expect(second.callbacks.message).toHaveBeenCalledExactlyOnceWith(envelope);
  expect(second.callbacks.error).not.toHaveBeenCalled();
  for (let index = 0; index < 2; index++)
    secondChannel.receive(
      JSON.stringify({
        v: 1,
        id: crypto.randomUUID(),
        index: 0,
        total: 2,
        text: "{",
      }),
    );
  await vi.advanceTimersByTimeAsync(140_000);
  // Expiry releases the bounded transfer slot, allowing a fresh full message.
  for (const packet of firstChannel.sent) secondChannel.receive(packet);
  expect(second.callbacks.message).toHaveBeenCalledTimes(2);
});

it("waits for buffered data to drain before sending and rejects a send queued for an obsolete connection", async () => {
  const { first, second, firstChannel, firstIdentity } = await pair();
  const envelope = await signPeerMessage(firstIdentity, {
    type: "hello",
    peerId: firstIdentity.id,
  });
  firstChannel.bufferedAmount = 300_000;
  const listen = vi.spyOn(firstChannel, "addEventListener");
  const sending = first.connection.send(envelope);
  await vi.waitFor(() =>
    expect(listen).toHaveBeenCalledWith(
      "bufferedamountlow",
      expect.any(Function),
      { once: true },
    ),
  );
  expect(firstChannel.send).not.toHaveBeenCalled();
  firstChannel.bufferedAmount = 0;
  firstChannel.dispatchEvent(new Event("bufferedamountlow"));
  await sending;
  expect(second.callbacks.message).toHaveBeenCalledExactlyOnceWith(envelope);
  const obsolete = first.connection.send(envelope);
  const rejected = expect(obsolete).rejects.toThrow("disconnected");
  first.connection.disconnect();
  await rejected;
  expect(firstChannel.send).toHaveBeenCalledTimes(1);
});

it("binds a reply to its exact invitation and rejects the original invitation after its expiry", async () => {
  const requester = link(await generatePeerIdentity()),
    recipient = link(await generatePeerIdentity());
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  const offer = await requester.connection.createInvitation(settings);
  vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
  const reply = await recipient.connection.joinInvitation(offer, settings);
  const unrelated = link(await generatePeerIdentity());
  await unrelated.connection.createInvitation(settings);
  await expect(unrelated.connection.connectReply(reply)).rejects.toThrow(
    "does not belong",
  );
  vi.spyOn(Date, "now").mockReturnValue(now + 1_800_001);
  await expect(requester.connection.connectReply(reply)).rejects.toThrow(
    "does not belong",
  );
});

it("exchanges candidates arriving after the eight-second gathering snapshot and ignores obsolete sessions", async () => {
  const first = link(await generatePeerIdentity()),
    second = link(await generatePeerIdentity());
  vi.useFakeTimers();
  const creating = first.connection.createInvitation(settings);
  const pc = FakeRTC.all.at(-1)!;
  pc.iceGatheringState = "gathering";
  await vi.advanceTimersByTimeAsync(8_000);
  vi.useRealTimers();
  const offer = await creating;
  const candidate = {
    candidate: "candidate:1 1 udp 123 203.0.113.1 4567 typ srflx",
    sdpMid: "0",
    sdpMLineIndex: 0,
  };
  pc.onicecandidate?.({ candidate: { ...candidate, toJSON: () => candidate } });
  expect(first.callbacks.candidate).toHaveBeenCalledExactlyOnceWith(
    first.connection.sessionId,
    candidate,
  );
  const reply = await second.connection.joinInvitation(offer, settings);
  const otherPc = FakeRTC.all.at(-1)!;
  await second.connection.addRemoteCandidates(first.connection.sessionId!, [
    candidate,
    candidate,
  ]);
  expect(otherPc.addIceCandidate).toHaveBeenCalledExactlyOnceWith(candidate);
  await second.connection.addRemoteCandidates(crypto.randomUUID(), [
    { ...candidate, candidate: candidate.candidate + " stale" },
  ]);
  expect(otherPc.addIceCandidate).toHaveBeenCalledOnce();
  await first.connection.connectReply(reply);
  first.connection.disconnect();
  pc.onicecandidate?.({ candidate: { ...candidate, toJSON: () => candidate } });
  expect(first.callbacks.candidate).toHaveBeenCalledOnce();
});

it("queues ICE until the answer is applied and continues after an unusable candidate", async () => {
  const first = link(await generatePeerIdentity()),
    second = link(await generatePeerIdentity());
  const offer = await first.connection.createInvitation(settings);
  const pc = FakeRTC.all.at(-1)!;
  const candidate = {
    candidate: "candidate:1 1 udp 123 203.0.113.1 4567 typ relay",
    sdpMid: "0",
  };
  const next = {
    ...candidate,
    candidate: candidate.candidate.replace("4567", "4568"),
  };
  pc.addIceCandidate.mockRejectedValueOnce(new Error("unusable"));
  await first.connection.addRemoteCandidates(first.connection.sessionId!, [
    candidate,
    next,
  ]);
  expect(pc.addIceCandidate).not.toHaveBeenCalled();
  const reply = await second.connection.joinInvitation(offer, settings);
  await first.connection.connectReply(reply);
  expect(pc.addIceCandidate.mock.calls).toEqual([[candidate], [next]]);
  expect(first.callbacks.error).not.toHaveBeenCalled();
  expect(first.connection.diagnostics()).toMatchObject({
    remoteDescription: true,
    remoteCandidateTypes: ["relay"],
  });
});

it("reports setup and TURN failures without exposing candidate addresses or credentials", async () => {
  const first = link(await generatePeerIdentity()),
    second = link(await generatePeerIdentity());
  const offer = await first.connection.createInvitation({
    ...settings,
    turn: "turns:relay.example:443",
    username: "private-user",
    credential: "private-password",
  });
  const pc = FakeRTC.all.at(-1)!;
  expect(first.connection.connectionFailure()).toContain("No connection reply");
  pc.onicecandidateerror?.({ url: "turns:relay.example:443", errorCode: 401 });
  await first.connection.connectReply(
    await second.connection.joinInvitation(offer, settings),
  );
  pc.state("failed");
  expect(first.connection.connectionFailure()).toContain(
    "TURN provided no relay candidate",
  );
  const candidate = {
    candidate: "candidate:1 1 udp 123 203.0.113.1 4567 typ relay",
  };
  pc.onicecandidate?.({ candidate: { ...candidate, toJSON: () => candidate } });
  const diagnostics = JSON.stringify(first.connection.diagnostics());
  expect(diagnostics).toContain('"code":401');
  expect(diagnostics).not.toMatch(
    /203\.0\.113|private-user|private-password|relay\.example|sdp|fingerprint/,
  );
});

it("distinguishes pending route checks from a confirmed ICE failure", async () => {
  const first = link(await generatePeerIdentity()),
    second = link(await generatePeerIdentity());
  const offer = await first.connection.createInvitation(settings);
  const pc = FakeRTC.all.at(-1)!;
  pc.localDescription!.sdp +=
    "a=candidate:1 1 udp 123 203.0.113.1 4567 typ srflx\r\n";
  await first.connection.connectReply(
    await second.connection.joinInvitation(offer, settings),
  );
  expect(first.connection.connectionFailure()).toContain(
    "waiting for remote connection candidates",
  );
  await first.connection.addRemoteCandidates(first.connection.sessionId!, [
    { candidate: "candidate:1 1 udp 123 203.0.113.2 4567 typ host" },
  ]);
  pc.iceConnectionState = "checking";
  expect(first.connection.connectionFailure()).toContain(
    "connection checks are still in progress",
  );
  expect(first.connection.connectionFailure()).not.toMatch(/blocked|failed/);
  pc.iceConnectionState = "failed";
  pc.oniceconnectionstatechange?.();
  expect(first.callbacks.error).toHaveBeenCalledWith(
    expect.stringContaining("A NAT or firewall restriction may require TURN"),
  );
  expect(first.connection.diagnostics().iceState).toBe("failed");
});
