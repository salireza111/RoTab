import { afterEach, expect, it, vi } from "vitest";
import {
  ENGINE_ID,
  SOURCE_SHA,
  initialSnapshot,
  type Snapshot,
} from "@rosettatab/shared";
import { Session } from "./session";

const settings = vi.hoisted(() => ({ apiUrl: "" }));
vi.mock("./storage", () => ({
  readPreferences: () => settings,
  getState: async () => undefined,
}));
afterEach(() => {
  settings.apiUrl = "";
});

function sessionFor(snapshot: Snapshot) {
  const session = Object.create(Session.prototype) as Session;
  Object.assign(session, {
    id: "owner-tab",
    owner: true,
    initialized: true,
    action: Promise.resolve(),
    snapshot,
    update: vi.fn(),
    channel: { postMessage: vi.fn() },
    manifest: { id: ENGINE_ID, sourceSha: SOURCE_SHA, verified: true },
    start: vi.fn(),
    upload: vi.fn(),
  });
  return session;
}

it("preserves the completed structure, task identity and all result data on refresh", async () => {
  const completed: Snapshot = {
    ...initialSnapshot(),
    state: "complete",
    taskSource: "bundled",
    taskId: "completed-attempt",
    title: "Completed browser FastRelax",
    protocol: "relax",
    pdb: "completed structure",
    startingPdb: "starting structure",
    energy: -48.175654,
    bestEnergy: -48.175654,
    history: [32.334837, 10.2, -48.175654],
    elapsedMs: 123_456,
    completed: 1,
    total: 1,
    checkpointAt: 1000,
    ownerId: "owner-tab",
    message: "Calculation complete. Saved locally.",
  };
  const before = structuredClone(completed),
    session = sessionFor(completed);
  // Even a changed compute source cannot relabel or hide an existing result.
  settings.apiUrl = "https://new-research.example.org";
  for (let change = 0; change < 4; change++) {
    session.command("refresh");
    await session.action;
  }
  expect(session.snapshot).toEqual(before);
  expect(session.snapshot).toBe(completed);
  expect(session.update).not.toHaveBeenCalled();
  expect(session.start).not.toHaveBeenCalled();
  expect(session.upload).not.toHaveBeenCalled();
  expect(session.channel.postMessage).not.toHaveBeenCalled();
});

it.each([
  "running",
  "loading",
  "uploading",
  "waiting",
  "paused",
  "error",
] as const)(
  "does not reset %s scientific work on preference refresh",
  async (state) => {
    const before: Snapshot = {
      ...initialSnapshot(),
      state,
      taskId: "saved-attempt",
      energy: -12,
      history: [15, -12],
      elapsedMs: 20_000,
      ownerId: "owner-tab",
    };
    const session = sessionFor(before);
    session.command("refresh");
    await session.action;
    expect(session.snapshot).toBe(before);
    expect(session.update).not.toHaveBeenCalled();
    expect(session.start).not.toHaveBeenCalled();
    expect(session.upload).not.toHaveBeenCalled();
  },
);

it("protects a checkpoint before the displayed task identity has been restored", async () => {
  const before = initialSnapshot(),
    session = sessionFor(before);
  Object.assign(session, { checkpoint: { status: "paused" } });
  session.command("refresh");
  await session.action;
  expect(session.snapshot).toBe(before);
  expect(session.update).not.toHaveBeenCalled();
});

it("reflects a changed research source only while the view is pristine and idle", async () => {
  const session = sessionFor(initialSnapshot());
  settings.apiUrl = "https://research.example.org";
  session.command("refresh");
  await session.action;
  expect(session.snapshot).toMatchObject({
    state: "idle",
    taskSource: "research",
    ownerId: "owner-tab",
  });
  expect(session.update).toHaveBeenCalledOnce();
  expect(session.start).not.toHaveBeenCalled();
  expect(session.upload).not.toHaveBeenCalled();
});
