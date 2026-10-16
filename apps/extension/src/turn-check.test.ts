import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { checkTurn } from "./turn-check";

class FakeRTC {
  static all: FakeRTC[] = [];
  iceGatheringState = "gathering";
  onicecandidate?: (event: any) => void;
  onicecandidateerror?: (event: any) => void;
  onicegatheringstatechange?: () => void;
  createDataChannel = vi.fn();
  createOffer = vi.fn(async () => ({ type: "offer" as const, sdp: "test" }));
  setLocalDescription = vi.fn(async () => {});
  close = vi.fn();
  constructor(readonly configuration: RTCConfiguration) {
    FakeRTC.all.push(this);
  }
  candidate(type: string) {
    this.onicecandidate?.({ candidate: { type } });
  }
  complete() {
    this.iceGatheringState = "complete";
    this.onicegatheringstatechange?.();
  }
}
const settings = {
  stun: "stun:example.test:3478",
  turn: "turns:example.test:443?transport=tcp",
  username: "generated-user",
  credential: "generated-password",
};
beforeEach(() => {
  FakeRTC.all = [];
  vi.stubGlobal("RTCPeerConnection", FakeRTC);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("checks relay allocation only and closes the connection on success", async () => {
  const pending = checkTurn(settings);
  const pc = FakeRTC.all[0];
  expect(pc.configuration.iceTransportPolicy).toBe("relay");
  expect(pc.configuration.iceServers).toContainEqual({
    urls: settings.turn,
    username: settings.username,
    credential: settings.credential,
  });
  pc.candidate("relay");
  expect(await pending).toEqual({ elapsedMs: expect.any(Number) });
  expect(pc.close).toHaveBeenCalledOnce();
  expect(pc.onicecandidate).toBeNull();
});

it("rejects a gather with only direct candidates and reports no server secrets", async () => {
  const pending = checkTurn(settings);
  const rejected = expect(pending).rejects.toThrow(
    "network access (ICE error codes: 401).",
  );
  const pc = FakeRTC.all[0];
  pc.candidate("host");
  pc.candidate("srflx");
  pc.onicecandidateerror?.({
    errorCode: 401,
    errorText: "generated-password at 203.0.113.1",
    url: settings.turn,
  });
  pc.complete();
  await rejected;
  expect(pc.close).toHaveBeenCalledOnce();
});

it("cancels an in-flight offer without starting gathering on a closed connection", async () => {
  const abort = new AbortController();
  const pending = checkTurn(settings, abort.signal);
  const rejected = expect(pending).rejects.toThrow("cancelled");
  const pc = FakeRTC.all[0];
  abort.abort();
  await rejected;
  await Promise.resolve();
  expect(pc.setLocalDescription).not.toHaveBeenCalled();
  expect(pc.close).toHaveBeenCalledOnce();
});

it("times out and cleans up a gather with no candidates", async () => {
  vi.useFakeTimers();
  const pending = checkTurn(settings);
  const rejected = expect(pending).rejects.toThrow("no relay candidate");
  await vi.advanceTimersByTimeAsync(20_000);
  await rejected;
  expect(FakeRTC.all[0].close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("validates credentials and pre-cancellation before creating any connection", async () => {
  await expect(checkTurn({ ...settings, credential: "" })).rejects.toThrow(
    "TURN needs",
  );
  const abort = new AbortController();
  abort.abort();
  await expect(checkTurn(settings, abort.signal)).rejects.toThrow("cancelled");
  expect(FakeRTC.all).toHaveLength(0);
});
