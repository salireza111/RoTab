const API = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
export const CALENDAR_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const SESSION_KEY = "rotab:google-calendar-session";
export interface GoogleSession {
  token: string;
  expiresAt: number;
}
export interface GoogleEvent {
  id: string;
  summary?: string;
  etag?: string;
  status?: string;
  start: { date?: string; dateTime?: string };
  end: { date?: string; dateTime?: string };
  attendees?: unknown[];
  htmlLink?: string;
}
export interface EventDraft {
  title: string;
  date: string;
  allDay: boolean;
  start: string;
  end: string;
  endDate?: string;
}
export function oauthResponse(
  result: string,
  redirect: string,
  state: string,
  now = Date.now(),
): GoogleSession {
  const url = new URL(result),
    expected = new URL(redirect),
    values = new URLSearchParams(url.hash.slice(1));
  if (
    url.origin !== expected.origin ||
    url.pathname !== expected.pathname ||
    url.search !== expected.search ||
    values.get("state") !== state
  )
    throw new Error("Google sign-in could not be verified. Try again.");
  if (values.has("error"))
    throw new Error("Google Calendar access was not granted.");
  const token = values.get("access_token"),
    seconds = Number(values.get("expires_in"));
  if (
    !token ||
    values.get("token_type")?.toLowerCase() !== "bearer" ||
    !Number.isFinite(seconds) ||
    seconds < 1 ||
    seconds > 86400 ||
    !values.get("scope")?.split(" ").includes(CALENDAR_SCOPE)
  )
    throw new Error("Google did not grant the requested Calendar access.");
  return { token, expiresAt: now + seconds * 1000 };
}
export async function googleSession(): Promise<GoogleSession | undefined> {
  if (typeof chrome === "undefined" || !chrome.storage?.session) return;
  const value = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] as
    GoogleSession | undefined;
  return value && value.expiresAt > Date.now() + 30_000 ? value : undefined;
}
export async function connectGoogle(clientId: string) {
  if (!/^[\w.-]+\.apps\.googleusercontent\.com$/.test(clientId))
    throw new Error("Set a Google Web OAuth client ID to connect Calendar.");
  if (typeof chrome === "undefined" || !chrome.permissions)
    throw new Error(
      "Connect Google Calendar from the installed RoTab extension.",
    );
  const granted = await chrome.permissions.request({
    permissions: ["identity"],
    origins: ["https://www.googleapis.com/*"],
  });
  if (!granted) throw new Error("Calendar browser access was not granted.");
  if (!chrome.identity?.launchWebAuthFlow)
    throw new Error(
      "This browser does not expose Calendar sign-in. Use an updated Chrome or Brave browser.",
    );
  const redirect = chrome.identity.getRedirectURL("google-calendar"),
    state = crypto.randomUUID() + crypto.randomUUID();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect,
    response_type: "token",
    scope: CALENDAR_SCOPE,
    state,
    prompt: "select_account consent",
  }).toString();
  const result = await chrome.identity.launchWebAuthFlow({
    url: url.href,
    interactive: true,
  });
  if (!result) throw new Error("Google sign-in was cancelled.");
  const session = oauthResponse(result, redirect, state);
  // Session storage is cleared by the browser on exit. Tokens never enter preferences,
  // IndexedDB, result records, telemetry, or peer messages. No remote SDK is loaded.
  await chrome.storage.session.set({ [SESSION_KEY]: session });
  window.dispatchEvent(new Event("google-calendar-session"));
}
export async function disconnectGoogle() {
  if (typeof chrome !== "undefined")
    await chrome.storage?.session?.remove(SESSION_KEY);
  window.dispatchEvent(new Event("google-calendar-session"));
}
async function request<T>(path = "", options: RequestInit = {}): Promise<T> {
  const auth = await googleSession();
  if (!auth) throw new Error("Connect Google Calendar to continue.");
  const response = await fetch(API + path, {
    ...options,
    headers: {
      Authorization: `Bearer ${auth.token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) {
    await disconnectGoogle();
    throw new Error("Google Calendar session expired. Connect again.");
  }
  if (response.status === 412)
    throw new Error(
      "This event changed in Google Calendar. Refresh before editing.",
    );
  if (!response.ok)
    throw new Error(
      response.status === 403
        ? "Google Calendar access is unavailable. Check API access and consent."
        : "Google Calendar could not complete this request. Try again.",
    );
  return response.status === 204 ? (undefined as T) : response.json();
}
export async function listGoogleEvents(
  month: Date,
  end?: Date,
): Promise<GoogleEvent[]> {
  const query = new URLSearchParams({
    timeMin: new Date(
      month.getFullYear(),
      month.getMonth(),
      end ? month.getDate() : 1,
    ).toISOString(),
    timeMax: (end
      ? new Date(end.getFullYear(), end.getMonth(), end.getDate())
      : new Date(month.getFullYear(), month.getMonth() + 1, 1)
    ).toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  let events: GoogleEvent[] = [];
  for (let i = 0; i < 20; i++) {
    const page = await request<{
      items?: GoogleEvent[];
      nextPageToken?: string;
    }>(`?${query}`);
    events = events.concat(
      (page.items || []).filter((e) => e.status !== "cancelled"),
    );
    if (!page.nextPageToken) return events;
    query.set("pageToken", page.nextPageToken);
  }
  throw new Error(
    "This month contains too many events to display. Open Google Calendar for the full list.",
  );
}
export function nextDate(date: string) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
export function eventBody(draft: EventDraft) {
  const summary = draft.title.trim().slice(0, 120);
  if (
    !summary ||
    !/^\d{4}-\d{2}-\d{2}$/.test(draft.date) ||
    Number.isNaN(Date.parse(draft.date))
  )
    throw new Error("Choose a title and date.");
  const endDate = draft.endDate || draft.date;
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(endDate) ||
    Number.isNaN(Date.parse(endDate)) ||
    endDate < draft.date
  )
    throw new Error("End date must be on or after the start date.");
  if (draft.allDay)
    return {
      summary,
      start: { date: draft.date },
      end: { date: nextDate(endDate) },
    };
  if (![draft.start, draft.end].every((s) => /^\d{2}:\d{2}$/.test(s)))
    throw new Error("Choose start and end times.");
  const start = new Date(`${draft.date}T${draft.start}:00`),
    end = new Date(`${endDate}T${draft.end}:00`);
  if (!(end.getTime() > start.getTime()))
    throw new Error("End time must be after start time.");
  return {
    summary,
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
  };
}
export async function saveGoogleEvent(
  draft: EventDraft,
  existing?: GoogleEvent,
) {
  if (existing?.attendees?.length)
    throw new Error("Edit events with guests in Google Calendar.");
  return request<GoogleEvent>(
    (existing ? `/${encodeURIComponent(existing.id)}` : "") +
      "?sendUpdates=none",
    {
      method: existing ? "PATCH" : "POST",
      headers: existing?.etag ? { "If-Match": existing.etag } : {},
      body: JSON.stringify(eventBody(draft)),
    },
  );
}
export async function deleteGoogleEvent(event: GoogleEvent) {
  if (event.attendees?.length)
    throw new Error("Manage events with guests in Google Calendar.");
  await request(`/${encodeURIComponent(event.id)}?sendUpdates=none`, {
    method: "DELETE",
    headers: event.etag ? { "If-Match": event.etag } : {},
  });
}
export function eventOnDate(event: GoogleEvent, date: string) {
  if (event.start.date)
    return (
      date >= event.start.date &&
      date < (event.end.date || nextDate(event.start.date))
    );
  if (!event.start.dateTime || !event.end.dateTime) return false;
  const from = new Date(date + "T00:00:00"),
    to = new Date(from);
  to.setDate(to.getDate() + 1);
  return (
    new Date(event.start.dateTime) < to && new Date(event.end.dateTime) > from
  );
}
