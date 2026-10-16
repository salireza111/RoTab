import { useState } from "react";
import {
  ImagePlus,
  Monitor,
  Moon,
  Sun,
  Trash2,
  Home,
  Orbit,
} from "lucide-react";
import type { Preferences } from "./storage";
import { putState } from "./storage";
import { saveBackground } from "./appearance";
import { FONTS } from "./personalization";
import type { PersonalWidgetId, WidgetSide } from "./personal-widgets";

export function AppearanceSettings({
  prefs,
  change,
}: {
  prefs: Preferences;
  change(patch: Partial<Preferences>): void;
}) {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const light =
    prefs.theme === "light" ||
    (prefs.theme === "system" &&
      matchMedia("(prefers-color-scheme: light)").matches);
  const defaultAccent =
    prefs.visualStyle === "doodle"
      ? light
        ? "#111111"
        : "#f8f8f8"
      : light
        ? "#316b51"
        : "#a7d9bd";
  return (
    <div className="appearance-settings">
      <div className="style-options" role="group" aria-label="Visual style">
        {(["observatory", "doodle"] as const).map((id) => (
          <button
            key={id}
            className={`style-swatch style-${id}`}
            aria-label={id === "doodle" ? "Doodle" : "Observatory"}
            title={id === "doodle" ? "Doodle" : "Observatory"}
            aria-pressed={prefs.visualStyle === id}
            onClick={() => change({ visualStyle: id })}
          >
            <svg viewBox="0 0 48 24" aria-hidden="true">
              {id === "doodle" ? (
                <path d="M3 17 C10 1 17 24 24 8 S37 23 45 5" />
              ) : (
                <path d="m8 16 12-10 8 12 12-12" />
              )}
            </svg>
          </button>
        ))}
      </div>
      {prefs.visualStyle === "doodle" && (
        <label className="check-label doodle-protein-option">
          <input
            type="checkbox"
            checked={prefs.doodleProtein}
            onChange={(e) => change({ doodleProtein: e.target.checked })}
          />
          <span>Doodle protein</span>
        </label>
      )}
      <div className="theme-options" role="group" aria-label="Color theme">
        {(
          [
            ["light", Sun, "Light"],
            ["dark", Moon, "Dark"],
            ["system", Monitor, "System"],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            aria-label={label}
            title={label}
            aria-pressed={prefs.theme === id}
            onClick={() => change({ theme: id })}
          >
            <Icon size={16} />
          </button>
        ))}
      </div>
      <div className="view-options" role="group" aria-label="Opening view">
        <button
          aria-label="Simple view"
          title="Open new tabs in simple view"
          aria-pressed={prefs.view === "home"}
          onClick={() => change({ view: "home" })}
        >
          <Home size={20} />
        </button>
        <button
          aria-label="Protein view"
          title="Open new tabs in protein view"
          aria-pressed={prefs.view === "dashboard"}
          onClick={() => change({ view: "dashboard" })}
        >
          <Orbit size={20} />
        </button>
      </div>
      <fieldset className="personal-widget-settings">
        <legend>Simple view · personal widgets</legend>
        <p className="setting-description">
          Optional space for tasks and ideas. Saved on this device.
        </p>
        {(
          [
            ["todo", "To-do list"],
            ["doodle", "Doodle board"],
          ] as const
        ).map(([id, label]) => (
          <div className="personal-widget-option" key={id}>
            <label className="check-label">
              <input
                type="checkbox"
                checked={prefs.personalWidgets[id].enabled}
                onChange={(event) =>
                  change({
                    personalWidgets: {
                      ...prefs.personalWidgets,
                      [id]: {
                        ...prefs.personalWidgets[id],
                        enabled: event.target.checked,
                      },
                    },
                  })
                }
              />
              <span>{label}</span>
            </label>
            <select
              aria-label={`${label} position`}
              disabled={!prefs.personalWidgets[id].enabled}
              value={prefs.personalWidgets[id].side}
              onChange={(event) =>
                change({
                  personalWidgets: {
                    ...prefs.personalWidgets,
                    [id as PersonalWidgetId]: {
                      ...prefs.personalWidgets[id],
                      side: event.target.value as WidgetSide,
                    },
                  },
                })
              }
            >
              <option value="left">Left side</option>
              <option value="middle">Middle</option>
              <option value="right">Right side</option>
            </select>
          </div>
        ))}
      </fieldset>
      <div className="background-options" role="group" aria-label="Background">
        {(["plain", "coast", "dune"] as const).map((id) => (
          <button
            key={id}
            className={`background-swatch swatch-${id}`}
            aria-label={`${id[0].toUpperCase() + id.slice(1)} background`}
            aria-pressed={prefs.background === id}
            onClick={() => change({ background: id })}
          ></button>
        ))}
      </div>
      <div className="custom-colors">
        <label>
          Accent
          <input
            type="color"
            aria-label="Accent color"
            value={prefs.accentColor || defaultAccent}
            onChange={(e) => change({ accentColor: e.target.value })}
          />
        </label>
        <button
          className="secondary"
          onClick={() => change({ accentColor: "" })}
        >
          Reset accent
        </button>
        <label>
          Highlights
          <input
            type="color"
            aria-label="Highlight color"
            value={prefs.highlightColor || prefs.accentColor || defaultAccent}
            onChange={(e) => change({ highlightColor: e.target.value })}
          />
        </label>
        <button
          className="secondary"
          onClick={() => change({ highlightColor: "" })}
        >
          Use accent for highlights
        </button>
        <p className="setting-description color-description">
          Accent colors charts and progress. Highlights color selected dates,
          active controls, sliders and hover states. Text contrast adjusts
          automatically.
        </p>
        <label>
          Background
          <input
            type="color"
            aria-label="Background color"
            value={prefs.backgroundColor}
            onChange={(e) =>
              change({ backgroundColor: e.target.value, background: "custom" })
            }
          />
        </label>
        <label className="check-label gradient-option">
          <input
            type="checkbox"
            checked={prefs.gradient}
            onChange={(e) =>
              change({ gradient: e.target.checked, background: "custom" })
            }
          />
          <span>Gradient</span>
        </label>
        {prefs.gradient && (
          <>
            <label>
              Second color
              <input
                type="color"
                aria-label="Second background color"
                value={prefs.backgroundEnd}
                onChange={(e) =>
                  change({
                    backgroundEnd: e.target.value,
                    background: "custom",
                  })
                }
              />
            </label>
            <label>
              Direction · {prefs.gradientAngle}°
              <input
                type="range"
                aria-label="Gradient direction"
                min="0"
                max="360"
                value={prefs.gradientAngle}
                onChange={(e) =>
                  change({
                    gradientAngle: Number(e.target.value),
                    background: "custom",
                  })
                }
              />
            </label>
          </>
        )}
      </div>
      <label>
        Font
        <select
          aria-label="Interface font"
          value={prefs.font}
          onChange={(e) =>
            change({ font: e.target.value as Preferences["font"] })
          }
        >
          {Object.entries(FONTS).map(([id, font]) => (
            <option key={id} value={id}>
              {font.label}
            </option>
          ))}
        </select>
      </label>
      <label className="background-upload">
        <ImagePlus size={15} /> Upload background
        <input
          type="file"
          accept="image/png,image/jpeg,image/webp"
          aria-label="Upload background"
          disabled={busy}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) return;
            setBusy(true);
            setError("");
            void saveBackground(file)
              .then((id) =>
                change({ background: "uploaded", backgroundId: id }),
              )
              .catch((cause) =>
                setError(
                  cause instanceof Error
                    ? cause.message
                    : "Could not save this image.",
                ),
              )
              .finally(() => setBusy(false));
          }}
        />
      </label>
      {prefs.backgroundId && (
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void putState("appearance-background", undefined)
              .then(() =>
                change({ background: "plain", backgroundId: undefined }),
              )
              .catch(() => setError("Could not remove the saved image."))
              .finally(() => setBusy(false));
          }}
        >
          <Trash2 size={14} /> Remove uploaded image
        </button>
      )}
      {error && (
        <p role="alert" className="form-message">
          {error}
        </p>
      )}
    </div>
  );
}
