import { useState } from "react";
import { Settings, X } from "lucide-react";
import { Modal } from "./Modal";
import type { Preferences } from "./storage";
import {
  activeCalendarWidgets,
  CALENDAR_NAMES,
  CALENDAR_SYSTEMS,
  normalizeCalendars,
  type CalendarPreferences,
  type CalendarSystem,
  type QamariCalculation,
} from "./calendars";

export function CalendarSettings({
  prefs,
  change,
  close,
}: {
  prefs: Preferences;
  change(p: Partial<Preferences>): void;
  close(): void;
}) {
  const [draft, setDraft] = useState<CalendarPreferences>(() =>
    normalizeCalendars(prefs),
  );
  const apply = () => {
    const next = normalizeCalendars(draft);
    change({
      ...next,
      hiddenWidgets: prefs.hiddenWidgets.filter(
        (id) => !activeCalendarWidgets(next).includes(id),
      ),
    });
    close();
  };
  return (
    <Modal label="Calendar settings" close={close} confirm={apply}>
      <div className="small-modal calendar-settings">
        <button
          className="modal-close"
          aria-label="Close calendar settings"
          onClick={close}
        >
          <X size={18} />
        </button>
        <Settings size={22} />
        <h2>Calendar</h2>
        <fieldset>
          <legend>Calendars</legend>
          {CALENDAR_SYSTEMS.map((system) => (
            <label key={system} className="check-label">
              <input
                type="checkbox"
                checked={draft.calendarSystems.includes(system)}
                disabled={
                  draft.calendarSystems.length === 1 &&
                  draft.calendarSystems.includes(system)
                }
                onChange={(event) =>
                  setDraft(
                    normalizeCalendars({
                      ...draft,
                      calendarSystems: event.target.checked
                        ? [...draft.calendarSystems, system]
                        : draft.calendarSystems.filter(
                            (item) => item !== system,
                          ),
                    }),
                  )
                }
              />
              {CALENDAR_NAMES[system]}
            </label>
          ))}
        </fieldset>
        <label>
          Display
          <select
            aria-label="Calendar display"
            value={draft.calendarLayout}
            onChange={(event) =>
              setDraft({
                ...draft,
                calendarLayout: event.target
                  .value as CalendarPreferences["calendarLayout"],
              })
            }
          >
            <option value="combined">One calendar</option>
            <option value="separate">Separate widgets</option>
          </select>
        </label>
        {draft.calendarLayout === "combined" &&
          draft.calendarSystems.length > 1 && (
            <label>
              Primary calendar
              <select
                aria-label="Primary calendar"
                value={draft.calendarPrimary}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    calendarPrimary: event.target.value as CalendarSystem,
                  })
                }
              >
                {draft.calendarSystems.map((system) => (
                  <option key={system} value={system}>
                    {CALENDAR_NAMES[system]}
                  </option>
                ))}
              </select>
            </label>
          )}
        {draft.calendarSystems.includes("qamari") && (
          <label>
            Qamari calculation
            <select
              aria-label="Qamari calculation"
              value={draft.qamariCalculation}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  qamariCalculation: event.target.value as QamariCalculation,
                })
              }
            >
              <option value="islamic-civil">Civil (tabular)</option>
              <option value="islamic-umalqura">Umm al-Qura</option>
            </select>
          </label>
        )}
      </div>
    </Modal>
  );
}
