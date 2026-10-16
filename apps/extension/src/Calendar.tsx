import { useEffect, useMemo, useRef, useState } from "react";
import {
  CalendarDays,
  Check,
  Link,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from "lucide-react";
import type { Preferences } from "./storage";
import {
  connectGoogle,
  deleteGoogleEvent,
  disconnectGoogle,
  eventOnDate,
  googleSession,
  listGoogleEvents,
  saveGoogleEvent,
  type EventDraft,
  type GoogleEvent,
} from "./google-calendar";
import { Modal } from "./Modal";
import { documentation } from "./documentation";
import {
  addCalendarDays,
  CALENDAR_NAMES,
  calendarDateKey as dateKey,
  calendarLabel,
  calendarMonth,
  calendarParts,
  shiftCalendarMonth,
  type CalendarSystem,
} from "./calendars";
const clock = (iso?: string) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "09:00";
export function Calendar({
  prefs,
  change,
  system,
}: {
  prefs: Preferences;
  change(p: Partial<Preferences>): void;
  system?: CalendarSystem;
}) {
  const today = new Date(),
    [month, setMonth] = useState(today),
    [selected, setSelected] = useState(dateKey(today));
  const primary = system ?? prefs.calendarPrimary,
    systems = system ? [system] : prefs.calendarSystems,
    secondary = systems.filter((item) => item !== primary),
    calculation = prefs.qamariCalculation;
  const range = useMemo(
    () => calendarMonth(month, primary, calculation),
    [month, primary, calculation],
  );
  const previousPrimary = useRef(primary);
  useEffect(() => {
    if (previousPrimary.current !== primary) {
      // Keep the selected civil day in view when switching calendar systems.
      previousPrimary.current = primary;
      setMonth(new Date(selected + "T12:00:00"));
    }
  }, [primary, selected]);
  const [connected, setConnected] = useState(false),
    [googleEvents, setGoogleEvents] = useState<GoogleEvent[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [setup, setSetup] = useState(false),
    [clientId, setClientId] = useState(prefs.googleClientId);
  const [draft, setDraft] = useState<EventDraft>(),
    [source, setSource] = useState<"local" | "google">("local"),
    [existing, setExisting] = useState<GoogleEvent>();
  useEffect(() => {
    let active = true;
    const read = () =>
      void googleSession().then((s) => {
        if (active) {
          setConnected(!!s);
          setRefresh((n) => n + 1);
          if (!s) setGoogleEvents([]);
        }
      });
    read();
    window.addEventListener("google-calendar-session", read);
    window.addEventListener("focus", read);
    const timer = setInterval(read, 60_000);
    const storage = (_: unknown, area: string) => {
      if (area === "session") read();
    };
    if (typeof chrome !== "undefined")
      chrome.storage?.onChanged?.addListener(storage);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener("google-calendar-session", read);
      window.removeEventListener("focus", read);
      if (typeof chrome !== "undefined")
        chrome.storage?.onChanged?.removeListener(storage);
    };
  }, []);
  useEffect(() => {
    let active = true;
    if (!connected) return;
    setGoogleEvents([]);
    setBusy(true);
    void listGoogleEvents(range.first, range.end)
      .then((events) => {
        if (active) {
          setGoogleEvents(events);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [connected, range, refresh]);
  const openDraft = (event?: GoogleEvent) => {
    setExisting(event);
    setSource(event || connected ? "google" : "local");
    setError("");
    setDraft({
      title: event?.summary || "",
      date:
        event?.start.date ||
        (event?.start.dateTime
          ? dateKey(new Date(event.start.dateTime))
          : selected),
      endDate: event?.end.date
        ? dateKey(addCalendarDays(new Date(event.end.date + "T12:00:00"), -1))
        : event?.end.dateTime
          ? dateKey(new Date(event.end.dateTime))
          : selected,
      allDay: event ? !!event.start.date : true,
      start: clock(event?.start.dateTime),
      end: event?.end.dateTime ? clock(event.end.dateTime) : "10:00",
    });
  };
  return (
    <>
      <div className="widget-heading calendar-heading">
        <CalendarDays size={15} />
        <span>
          {system && system !== "gregorian"
            ? CALENDAR_NAMES[system].toUpperCase()
            : "CALENDAR"}
        </span>
        <div className="calendar-connection">
          <button
            aria-label={
              connected
                ? "Disconnect Google Calendar"
                : "Connect Google Calendar"
            }
            title={
              connected
                ? "Disconnect Google Calendar"
                : "Connect Google Calendar"
            }
            onClick={() => {
              if (connected) {
                void disconnectGoogle();
              } else {
                setClientId(prefs.googleClientId);
                setSetup(true);
                setError("");
              }
            }}
          >
            {connected ? <LogOut size={14} /> : <Link size={14} />}
          </button>
          {connected && (
            <>
              <span>Google</span>
              <button
                aria-label="Refresh Google Calendar"
                title="Refresh"
                disabled={busy}
                onClick={() => setRefresh((n) => n + 1)}
              >
                <RefreshCw size={13} />
              </button>
            </>
          )}
        </div>
      </div>
      <div className="calendar-month">
        <b>{calendarLabel(range.first, primary, calculation, "month")}</b>
        <div>
          <button
            aria-label="Previous month"
            onClick={() =>
              setMonth(shiftCalendarMonth(month, -1, primary, calculation))
            }
          >
            ‹
          </button>
          <button
            aria-label="Next month"
            onClick={() =>
              setMonth(shiftCalendarMonth(month, 1, primary, calculation))
            }
          >
            ›
          </button>
        </div>
      </div>
      <div className="calendar-legend" aria-label="Calendar key">
        {[primary, ...secondary].map((item) => (
          <span
            key={item}
            className={item === primary ? "calendar-key-primary" : undefined}
          >
            <b>{CALENDAR_NAMES[item][0]}</b> {CALENDAR_NAMES[item]}
          </span>
        ))}
      </div>
      <div
        className={`calendar-grid${secondary.length ? " calendar-grid-combined" : ""}`}
        data-calendar={primary}
      >
        {Array.from({ length: 7 }, (_, i) => {
          const weekday = new Date(
            2026,
            0,
            4 + ((range.weekStart + i) % 7),
            12,
          );
          return (
            <span
              key={`w${i}`}
              className="weekday"
              title={weekday.toLocaleDateString("en", { weekday: "long" })}
            >
              {weekday.toLocaleDateString("en", { weekday: "narrow" })}
            </span>
          );
        })}
        {Array.from({ length: range.offset }, (_, i) => (
          <span key={`b${i}`} />
        ))}
        {range.days.map((day, i) => {
          const key = dateKey(day);
          const label = systems
            .map(
              (item) =>
                `${CALENDAR_NAMES[item]}: ${calendarLabel(day, item, calculation)}`,
            )
            .join(" · ");
          return (
            <button
              key={key}
              aria-label={key}
              title={label}
              aria-pressed={selected === key}
              className={`${key === dateKey(today) ? "today " : ""}${key === selected ? "chosen " : ""}${prefs.events.some((e) => e.date === key) || googleEvents.some((e) => eventOnDate(e, key)) ? "has-event" : ""}`}
              onClick={() => setSelected(key)}
            >
              <span className="calendar-day-number">{i + 1}</span>
              {secondary.length > 0 && (
                <span className="calendar-secondary-dates">
                  {secondary.map((item) => (
                    <small
                      key={item}
                      className="calendar-secondary-day"
                      aria-label={`${CALENDAR_NAMES[item]} ${calendarLabel(day, item, calculation)}`}
                    >
                      {calendarParts(day, item, calculation).day}
                    </small>
                  ))}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <div className="calendar-events">
        <div>
          <span className="calendar-selected-dates">
            <span>
              {calendarLabel(
                new Date(selected + "T12:00:00"),
                primary,
                calculation,
              )}
            </span>
            {secondary.length > 0 && (
              <span className="calendar-selected-secondary">
                {secondary.map((item) => (
                  <small
                    key={item}
                    title={CALENDAR_NAMES[item]}
                    aria-label={`${CALENDAR_NAMES[item]}: ${calendarLabel(new Date(selected + "T12:00:00"), item, calculation)}`}
                  >
                    <b aria-hidden="true">{CALENDAR_NAMES[item][0]}</b>{" "}
                    {calendarLabel(
                      new Date(selected + "T12:00:00"),
                      item,
                      calculation,
                    )}
                  </small>
                ))}
              </span>
            )}
          </span>
          <button
            aria-label="Add calendar event"
            title="Add event"
            onClick={() => openDraft()}
          >
            <Plus size={14} />
          </button>
        </div>
        {prefs.events
          .filter((e) => e.date === selected)
          .map((e) => (
            <p key={e.id}>
              <span>{e.title}</span>
              <button
                aria-label={`Delete event ${e.title}`}
                onClick={() =>
                  change({ events: prefs.events.filter((x) => x.id !== e.id) })
                }
              >
                <Trash2 size={12} />
              </button>
            </p>
          ))}
        {googleEvents
          .filter((e) => eventOnDate(e, selected))
          .map((e) => (
            <p key={e.id} className="google-event">
              <span>
                <small>
                  {e.start.date ? "All day" : clock(e.start.dateTime)}
                </small>
                {e.summary || "Untitled event"}
              </span>
              {!e.attendees?.length && (
                <>
                  <button
                    aria-label={`Edit Google event ${e.summary}`}
                    onClick={() => openDraft(e)}
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    disabled={busy}
                    aria-label={`Delete Google event ${e.summary}`}
                    onClick={() => {
                      setBusy(true);
                      void deleteGoogleEvent(e)
                        .then(() => setRefresh((n) => n + 1))
                        .catch((e) => setError(e.message))
                        .finally(() => setBusy(false));
                    }}
                  >
                    <Trash2 size={12} />
                  </button>
                </>
              )}
            </p>
          ))}
        {busy && <p role="status">Syncing…</p>}
        {error && !draft && !setup && (
          <p className="form-message" role="alert">
            {error}
          </p>
        )}
      </div>
      {setup && (
        <Modal label="Connect Google Calendar" close={() => setSetup(false)}>
          <form
            className="small-modal"
            onSubmit={(e) => {
              e.preventDefault();
              setBusy(true);
              setError("");
              change({ googleClientId: clientId.trim() });
              void connectGoogle(clientId.trim())
                .then(() => setSetup(false))
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <button
              type="button"
              className="modal-close"
              aria-label="Close Calendar connection"
              onClick={() => setSetup(false)}
            >
              <X size={18} />
            </button>
            <CalendarDays size={22} />
            <h2>Google Calendar</h2>
            <p className="setting-description">
              Read and manage personal events in your primary calendar.
            </p>
            {
              <label>
                Web OAuth client ID
                <input
                  aria-label="Google OAuth client ID"
                  value={clientId}
                  onChange={(e) => setClientId(e.target.value)}
                  placeholder="…apps.googleusercontent.com"
                />
              </label>
            }
            <a
              href={new URL("personalization.html#widgets-and-calendars", documentation.help).href}
              target="_blank"
              rel="noreferrer"
              className="setting-description"
            >
              Connection setup
            </a>
            {error && (
              <p role="alert" className="form-message">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              {busy ? "Connecting…" : "Connect Google Calendar"}
            </button>
          </form>
        </Modal>
      )}
      {draft && (
        <Modal
          label={existing ? "Edit calendar event" : "Add calendar event"}
          close={() => setDraft(undefined)}
        >
          <form
            className="small-modal"
            onSubmit={(e) => {
              e.preventDefault();
              if (!draft.title.trim()) return;
              setBusy(true);
              setError("");
              const save =
                source === "google"
                  ? saveGoogleEvent(draft, existing).then(() =>
                      setRefresh((n) => n + 1),
                    )
                  : Promise.resolve(
                      change({
                        events: [
                          ...prefs.events,
                          {
                            id: crypto.randomUUID(),
                            date: draft.date,
                            title: draft.title.trim().slice(0, 120),
                          },
                        ],
                      }),
                    );
              void save
                .then(() => setDraft(undefined))
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            <button
              type="button"
              className="modal-close"
              aria-label="Close event editor"
              onClick={() => setDraft(undefined)}
            >
              <X size={18} />
            </button>
            <h2>{existing ? "Edit event" : "Add event"}</h2>
            {!existing && (
              <label>
                Calendar
                <select
                  aria-label="Event calendar"
                  value={source}
                  onChange={(e) =>
                    setSource(e.target.value as "local" | "google")
                  }
                >
                  <option value="local">Local notes</option>
                  {connected && <option value="google">Google Calendar</option>}
                </select>
              </label>
            )}
            <label>
              Title
              <input
                aria-label="Event title"
                required
                autoFocus
                value={draft.title}
                maxLength={120}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </label>
            <label>
              Date (Gregorian)
              <input
                aria-label="Event date"
                type="date"
                required
                value={draft.date}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    date: e.target.value,
                    endDate:
                      draft.endDate === draft.date
                        ? e.target.value
                        : draft.endDate,
                  })
                }
              />
            </label>
            {systems.some((item) => item !== "gregorian") && draft.date && (
              <p className="calendar-event-date-preview">
                {systems
                  .filter((item) => item !== "gregorian")
                  .map(
                    (item) =>
                      `${CALENDAR_NAMES[item]}: ${calendarLabel(new Date(draft.date + "T12:00:00"), item, calculation)}`,
                  )
                  .join(" · ")}
              </p>
            )}
            {source === "google" && (
              <label>
                End date (Gregorian)
                <input
                  aria-label="Event end date"
                  type="date"
                  required
                  min={draft.date}
                  value={draft.endDate || draft.date}
                  onChange={(e) =>
                    setDraft({ ...draft, endDate: e.target.value })
                  }
                />
              </label>
            )}
            {source === "google" && (
              <>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={draft.allDay}
                    onChange={(e) =>
                      setDraft({ ...draft, allDay: e.target.checked })
                    }
                  />
                  All day
                </label>
                {!draft.allDay && (
                  <div className="event-times">
                    <label>
                      Start
                      <input
                        aria-label="Event start"
                        type="time"
                        required
                        value={draft.start}
                        onChange={(e) =>
                          setDraft({ ...draft, start: e.target.value })
                        }
                      />
                    </label>
                    <label>
                      End
                      <input
                        aria-label="Event end"
                        type="time"
                        required
                        value={draft.end}
                        onChange={(e) =>
                          setDraft({ ...draft, end: e.target.value })
                        }
                      />
                    </label>
                  </div>
                )}
              </>
            )}
            {error && (
              <p className="form-message" role="alert">
                {error}
              </p>
            )}
            <button className="primary" disabled={busy}>
              <Check size={15} />
              Save event
            </button>
          </form>
        </Modal>
      )}
    </>
  );
}
