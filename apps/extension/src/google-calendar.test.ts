import { afterEach, expect, it, vi } from "vitest";
import {
  CALENDAR_SCOPE,
  connectGoogle,
  disconnectGoogle,
  eventBody,
  eventOnDate,
  listGoogleEvents,
  oauthResponse,
  saveGoogleEvent,
  type GoogleEvent,
} from "./google-calendar";
afterEach(() => vi.unstubAllGlobals());
const redirect = "https://test.chromiumapp.org/google-calendar";
const response = (patch: Record<string, string> = {}) =>
  redirect +
  "#" +
  new URLSearchParams({
    state: "nonce",
    access_token: "test-only-token",
    expires_in: "3600",
    token_type: "Bearer",
    scope: CALENDAR_SCOPE,
    ...patch,
  });
it("rejects forged redirects, CSRF responses, missing scopes and unbounded tokens", () => {
  expect(oauthResponse(response(), redirect, "nonce", 1000)).toEqual({
    token: "test-only-token",
    expiresAt: 3601000,
  });
  for (const url of [
    response({ state: "forged" }),
    response().replace("test.chromiumapp.org", "evil.invalid"),
    response({ scope: "profile" }),
    response({ expires_in: "NaN" }),
    response({ error: "access_denied" }),
  ])
    expect(() => oauthResponse(url, redirect, "nonce")).toThrow();
});
it("uses exclusive all-day end dates, preserves multi-day spans, and rejects reversed times", () => {
  const draft = {
    title: "  Research  ",
    date: "2026-10-31",
    allDay: true,
    start: "09:00",
    end: "10:00",
    endDate: "2026-11-02",
  };
  expect(eventBody(draft)).toEqual({
    summary: "Research",
    start: { date: "2026-10-31" },
    end: { date: "2026-11-03" },
  });
  expect(() =>
    eventBody({ ...draft, allDay: false, endDate: draft.date, start: "11:00" }),
  ).toThrow("End time");
  expect(
    eventOnDate(
      { id: "a", start: { date: "2026-10-31" }, end: { date: "2026-11-03" } },
      "2026-11-02",
    ),
  ).toBe(true);
  expect(
    eventOnDate(
      { id: "a", start: { date: "2026-10-31" }, end: { date: "2026-11-03" } },
      "2026-11-03",
    ),
  ).toBe(false);
});
function mockSession() {
  const values: Record<string, unknown> = {
    "rotab:google-calendar-session": {
      token: "test-only-token",
      expiresAt: Date.now() + 3600000,
    },
  };
  const session = {
    get: vi.fn(async (key: string) => ({ [key]: values[key] })),
    set: vi.fn(async (v: Record<string, unknown>) => Object.assign(values, v)),
    remove: vi.fn(async (key: string) => {
      delete values[key];
    }),
  };
  vi.stubGlobal("chrome", {
    storage: { session },
    permissions: {
      contains: vi.fn(async () => true),
      request: vi.fn(async () => true),
    },
    identity: {
      getRedirectURL: () => redirect,
      launchWebAuthFlow: vi.fn(async ({ url }: { url: string }) =>
        response({ state: new URL(url).searchParams.get("state")! }),
      ),
    },
  });
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
  return session;
}
it("fetches the complete native month when it crosses Gregorian month boundaries", async () => {
  mockSession();
  const fetch = vi.fn().mockResolvedValue(Response.json({ items: [] }));
  vi.stubGlobal("fetch", fetch);
  await listGoogleEvents(new Date(2026, 8, 23, 12), new Date(2026, 9, 23, 12));
  const query = new URL(fetch.mock.calls[0][0]).searchParams;
  expect(query.get("timeMin")).toBe(new Date(2026, 8, 23).toISOString());
  expect(query.get("timeMax")).toBe(new Date(2026, 9, 23).toISOString());
});
it("pages event lists and sends authenticated conditional writes without guest notifications", async () => {
  mockSession();
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        items: [
          {
            id: "1",
            start: { date: "2026-10-08" },
            end: { date: "2026-10-09" },
          },
        ],
        nextPageToken: "second",
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        items: [{ id: "2" }, { id: "cancelled", status: "cancelled" }],
      }),
    )
    .mockResolvedValueOnce(Response.json({ id: "1" }));
  vi.stubGlobal("fetch", fetch);
  expect(await listGoogleEvents(new Date(2026, 9, 1))).toHaveLength(2);
  expect(fetch.mock.calls[1][0]).toContain("pageToken=second");
  const existing: GoogleEvent = {
    id: "a/b",
    etag: '"version"',
    start: { date: "2026-10-08" },
    end: { date: "2026-10-09" },
  };
  await saveGoogleEvent(
    {
      title: "Changed",
      date: "2026-10-08",
      allDay: true,
      start: "09:00",
      end: "10:00",
    },
    existing,
  );
  expect(fetch.mock.calls[2][0]).toContain("/a%2Fb?sendUpdates=none");
  expect(fetch.mock.calls[2][1]).toMatchObject({
    method: "PATCH",
    headers: {
      Authorization: "Bearer test-only-token",
      "If-Match": '"version"',
    },
  });
  await expect(
    saveGoogleEvent(
      {
        title: "a",
        date: "2026-10-08",
        allDay: true,
        start: "09:00",
        end: "10:00",
      },
      { ...existing, attendees: [{}] },
    ),
  ).rejects.toThrow("guests");
});
it("connects only on request, keeps tokens in browser session storage, and disconnects locally", async () => {
  const session = mockSession();
  await connectGoogle("test.apps.googleusercontent.com");
  expect(chrome.permissions.request).toHaveBeenCalledWith({
    permissions: ["identity"],
    origins: ["https://www.googleapis.com/*"],
  });
  expect(session.set).toHaveBeenCalledOnce();
  await disconnectGoogle();
  expect(session.remove).toHaveBeenCalledWith("rotab:google-calendar-session");
});
it("expires authentication on a 401 instead of retrying writes or showing stale connection", async () => {
  const session = mockSession();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 401 })),
  );
  await expect(listGoogleEvents(new Date(2026, 9, 1))).rejects.toThrow(
    "session expired",
  );
  expect(session.remove).toHaveBeenCalledOnce();
});
