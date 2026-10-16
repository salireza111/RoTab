import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  CloudSun,
  CloudRain,
  CloudSnow,
  CloudFog,
  CloudLightning,
  Cloud,
  Expand,
  EyeOff,
  MapPin,
  LocateFixed,
  Plus,
  Sun,
  Wind,
  Droplets,
  Sunrise,
  Sunset,
  Settings,
} from "lucide-react";
import type { Preferences } from "./storage";
import { getState, putState, readPreferences } from "./storage";
import { api } from "./api";
import { parseWeather, weatherLabel, type WeatherData } from "./weather";
import { Calendar } from "./Calendar";
import { CalendarSettings } from "./CalendarSettings";
import {
  activeCalendarWidgets,
  CALENDAR_WIDGETS,
  type CalendarSystem,
} from "./calendars";
import { Pomodoro } from "./Pomodoro";
import { PersonalWidgetCard } from "./PersonalWidgetRail";
import { PERSONAL_WIDGET_IDS, type PersonalWidgetId } from "./personal-widgets";
import type { useFocusTimer } from "./useFocusTimer";
import {
  deviceWeatherLocation,
  hasWeatherCoordinates,
  lookupWeatherCity,
  weatherLocationLabel,
} from "./weather-location";
export const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
function WeatherSymbol({ code, size = 21 }: { code: number; size?: number }) {
  const label = weatherLabel(code);
  const Icon =
    label === "Clear skies"
      ? Sun
      : label === "Snow"
        ? CloudSnow
        : label === "Rain"
          ? CloudRain
          : label === "Fog"
            ? CloudFog
            : label === "Thunderstorms"
              ? CloudLightning
              : label === "Overcast"
                ? Cloud
                : CloudSun;
  return <Icon size={size} aria-label={label} />;
}
export function Widgets({
  prefs,
  change,
  acceptedTaskId,
  compact = false,
  workQueue,
  focus,
}: {
  prefs: Preferences;
  change: (p: Partial<Preferences>) => void;
  acceptedTaskId?: string;
  compact?: boolean;
  workQueue?: ReactNode;
  focus: ReturnType<typeof useFocusTimer>;
}) {
  const [calendarSettings, setCalendarSettings] = useState(false);
  const calendarWidgets = activeCalendarWidgets(prefs);
  const order = [...new Set([...prefs.widgets, ...PERSONAL_WIDGET_IDS])];
  const isPersonal = (id: string): id is PersonalWidgetId =>
    PERSONAL_WIDGET_IDS.includes(id as PersonalWidgetId);
  const available = order.filter(
    (id) =>
      (!isPersonal(id) ||
        (compact &&
          prefs.personalWidgets[id].enabled &&
          prefs.personalWidgets[id].side === "middle")) &&
      (compact
        ? id !== "contribution"
        : id !== "pomodoro" && id !== "work-queue") &&
      (!Object.values(CALENDAR_WIDGETS).includes(id) ||
        calendarWidgets.includes(id)),
  );
  const move = (id: string, direction: number) => {
    const nextOrder = [...order],
      index = order.indexOf(id),
      neighbor = available.filter(
        (item) => !prefs.hiddenWidgets.includes(item),
      )[
        available
          .filter((item) => !prefs.hiddenWidgets.includes(item))
          .indexOf(id) + direction
      ],
      target = order.indexOf(neighbor);
    if (index < 0 || target < 0) return;
    [nextOrder[index], nextOrder[target]] = [
      nextOrder[target],
      nextOrder[index],
    ];
    change({ widgets: nextOrder });
  };
  const visible = available.filter((id) => !prefs.hiddenWidgets.includes(id));
  const hidden = available.filter((id) => prefs.hiddenWidgets.includes(id));
  return (
    <div className="widgets">
      {visible.map((id) =>
        isPersonal(id) ? (
          <PersonalWidgetCard
            key={id}
            id={id}
            prefs={prefs}
            change={change}
            gridActions={
              <>
                <button
                  aria-label={`Move ${id} up`}
                  onClick={() => move(id, -1)}
                >
                  <ArrowUp size={12} />
                </button>
                <button
                  aria-label={`Move ${id} down`}
                  onClick={() => move(id, 1)}
                >
                  <ArrowDown size={12} />
                </button>
                <button
                  aria-label={`Resize ${id}`}
                  onClick={() =>
                    change({
                      wideWidgets: prefs.wideWidgets.includes(id)
                        ? prefs.wideWidgets.filter((x) => x !== id)
                        : [...prefs.wideWidgets, id],
                    })
                  }
                >
                  <Expand size={12} />
                </button>
              </>
            }
          />
        ) : (
          <section
            key={id}
            data-widget={id}
            className={
              "widget " + (prefs.wideWidgets.includes(id) ? "widget-wide" : "")
            }
          >
            <div className="widget-actions">
              <button aria-label={`Move ${id} up`} onClick={() => move(id, -1)}>
                <ArrowUp size={12} />
              </button>
              <button
                aria-label={`Move ${id} down`}
                onClick={() => move(id, 1)}
              >
                <ArrowDown size={12} />
              </button>
              <button
                aria-label={`Resize ${id}`}
                onClick={() =>
                  change({
                    wideWidgets: prefs.wideWidgets.includes(id)
                      ? prefs.wideWidgets.filter((x) => x !== id)
                      : [...prefs.wideWidgets, id],
                  })
                }
              >
                <Expand size={12} />
              </button>
              {Object.values(CALENDAR_WIDGETS).includes(id) && (
                <button
                  aria-label="Calendar settings"
                  title="Calendar settings"
                  onClick={() => setCalendarSettings(true)}
                >
                  <Settings size={12} />
                </button>
              )}
              <button
                aria-label={`Hide ${id}`}
                onClick={() =>
                  change({ hiddenWidgets: [...prefs.hiddenWidgets, id] })
                }
              >
                <EyeOff size={12} />
              </button>
            </div>
            {id === "work-queue" ? (
              workQueue
            ) : id === "weather" ? (
              <Weather
                prefs={prefs}
                change={change}
                expanded={prefs.wideWidgets.includes(id)}
              />
            ) : Object.values(CALENDAR_WIDGETS).includes(id) ? (
              <Calendar
                prefs={prefs}
                change={change}
                system={
                  prefs.calendarLayout === "separate"
                    ? (Object.keys(CALENDAR_WIDGETS) as CalendarSystem[]).find(
                        (system) => CALENDAR_WIDGETS[system] === id,
                      )
                    : undefined
                }
              />
            ) : id === "pomodoro" ? (
              <Pomodoro {...focus} />
            ) : (
              <Contribution
                acceptedTaskId={acceptedTaskId}
                serverUrl={prefs.apiUrl}
              />
            )}
          </section>
        ),
      )}
      {hidden.length > 0 && (
        <button
          className="restore-widgets"
          onClick={() =>
            change({
              hiddenWidgets: prefs.hiddenWidgets.filter(
                (id) => !hidden.includes(id),
              ),
            })
          }
        >
          <Plus size={14} /> Restore hidden widgets
        </button>
      )}
      {calendarSettings && (
        <CalendarSettings
          prefs={prefs}
          change={change}
          close={() => setCalendarSettings(false)}
        />
      )}
    </div>
  );
}
function Weather({
  prefs,
  change,
  expanded,
}: {
  expanded: boolean;
  prefs: Preferences;
  change: (p: Partial<Preferences>) => void;
}) {
  const configured = !!prefs.city && hasWeatherCoordinates(prefs);
  const [weather, setWeather] = useState<WeatherData>(),
    [error, setError] = useState(""),
    [locationError, setLocationError] = useState(""),
    [locating, setLocating] = useState(false),
    [editing, setEditing] = useState(false),
    [city, setCity] = useState(
      prefs.weatherLocationSource === "device" ? "" : prefs.city,
    ),
    [busy, setBusy] = useState(false);
  const latest = useRef({ prefs, change });
  latest.current = { prefs, change };
  const mounted = useRef(true),
    locationRequest = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      locationRequest.current++;
    };
  }, []);
  useEffect(() => {
    locationRequest.current++;
    setLocating(false);
    setBusy(false);
    setCity(prefs.weatherLocationSource === "device" ? "" : prefs.city);
    if (configured) {
      setEditing(false);
      setLocationError("");
    }
  }, [
    prefs.city,
    prefs.latitude,
    prefs.longitude,
    prefs.weatherLocationSource,
  ]);
  const locate = useCallback(async () => {
    const request = ++locationRequest.current;
    setLocating(true);
    setLocationError("");
    try {
      const location = await deviceWeatherLocation();
      if (!mounted.current || request !== locationRequest.current) return;
      latest.current.change(location);
      setEditing(false);
    } catch (e) {
      if (!mounted.current || request !== locationRequest.current) return;
      latest.current.change({ weatherLocationAttempted: true });
      setLocationError((e as Error).message);
      setEditing(true);
    } finally {
      if (mounted.current && request === locationRequest.current)
        setLocating(false);
    }
  }, []);
  useEffect(() => {
    if (configured || prefs.weatherLocationAttempted) return;
    let active = true;
    const attempt = async () => {
      const saved = readPreferences();
      if (
        !active ||
        saved.weatherLocationAttempted ||
        hasWeatherCoordinates(saved)
      )
        return;
      await locate();
    };
    // A burst of new tabs shares one initial lookup and its saved result.
    if (navigator.locks)
      void navigator.locks
        .request("rosettatab:weather-location-v1", attempt)
        .catch(() => {
          if (active) void locate();
        });
    else void attempt();
    return () => {
      active = false;
    };
  }, [configured, prefs.weatherLocationAttempted, locate]);
  useEffect(() => {
    if (
      !configured ||
      prefs.weatherLocationSource !== "device" ||
      prefs.city !== "Current location"
    )
      return;
    let active = true;
    const request = locationRequest.current;
    const latitude = prefs.latitude!,
      longitude = prefs.longitude!;
    const key = `weather-city:v1:${latitude}:${longitude}`;
    const resolveCity = async () => {
      const stillCurrent = () => {
        const saved = readPreferences();
        return (
          active &&
          mounted.current &&
          request === locationRequest.current &&
          saved.weatherLocationSource === "device" &&
          saved.latitude === latitude &&
          saved.longitude === longitude &&
          saved.city === "Current location"
        );
      };
      if (!stillCurrent()) return;
      const cached = await getState<{ city: string | null; time: number }>(key);
      // Cache failed lookups too, so opening tabs offline does not flood the service.
      const fresh =
        cached &&
        Date.now() - cached.time <
          (cached.city ? 30 * 24 * 60 * 60_000 : 60 * 60_000);
      const city = fresh
        ? cached.city
        : await lookupWeatherCity({ latitude, longitude });
      if (!fresh) await putState(key, { city, time: Date.now() });
      if (city && stillCurrent()) latest.current.change({ city });
    };
    // Existing unnamed device locations use this path too, without another GPS prompt.
    const work = navigator.locks
      ? navigator.locks.request("rosettatab:weather-city-v1", resolveCity)
      : resolveCity();
    void work.catch(() => {});
    return () => {
      active = false;
    };
  }, [
    configured,
    prefs.city,
    prefs.latitude,
    prefs.longitude,
    prefs.weatherLocationSource,
  ]);
  useEffect(() => {
    let cancelled = false;
    setWeather(undefined);
    setError("");
    if (!configured) return;
    const count = expanded ? prefs.forecastDays : 1;
    const key = `weather:v3:${prefs.latitude}:${prefs.longitude}:${count}`;
    void (async () => {
      const cached = await getState<WeatherData>(key);
      if (cached && !cancelled) setWeather(cached);
      if (cached && Date.now() - cached.time < 30 * 60_000) return;
      try {
        const data = await fetch(
          `https://api.open-meteo.com/v1/forecast?latitude=${prefs.latitude}&longitude=${prefs.longitude}&current=temperature_2m,weather_code,relative_humidity_2m,wind_speed_10m&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset&forecast_days=${count}&timezone=auto`,
          { signal: AbortSignal.timeout(8000) },
        ).then((r) => {
          if (!r.ok) throw new Error("Weather unavailable");
          return r.json();
        });
        const next = parseWeather(data, prefs.city, count);
        if (!cancelled) {
          setWeather(next);
          setError("");
        }
        await putState(key, next);
      } catch {
        if (!cancelled)
          setError(
            cached ? "Cached forecast · offline" : "Weather unavailable",
          );
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    configured,
    prefs.latitude,
    prefs.longitude,
    prefs.city,
    expanded,
    prefs.forecastDays,
  ]);
  const choose = async (e: React.FormEvent) => {
    e.preventDefault();
    const query = city.trim();
    if (query.length < 2) {
      setLocationError("Enter a city or town.");
      return;
    }
    const request = ++locationRequest.current;
    setLocating(false);
    setBusy(true);
    setLocationError("");
    try {
      const data = await fetch(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=1&language=en`,
        { signal: AbortSignal.timeout(8000) },
      ).then((r) => {
        if (!r.ok) throw new Error("City search unavailable. Try again.");
        return r.json();
      });
      const result = data.results?.[0];
      if (
        !result ||
        typeof result.name !== "string" ||
        !result.name.trim() ||
        !hasWeatherCoordinates(result)
      )
        throw new Error("City not found. Try a nearby city or town.");
      if (!mounted.current || request !== locationRequest.current) return;
      latest.current.change({
        city: result.name,
        latitude: result.latitude,
        longitude: result.longitude,
        weatherLocationSource: "city",
        weatherLocationAttempted: true,
      });
      setEditing(false);
    } catch (e) {
      if (mounted.current && request === locationRequest.current)
        setLocationError(
          e instanceof Error
            ? e.message
            : "City search unavailable. Try again.",
        );
    } finally {
      if (mounted.current && request === locationRequest.current)
        setBusy(false);
    }
  };
  return (
    <>
      <div className="widget-heading">
        <CloudSun size={15} />
        <span>WEATHER</span>
      </div>
      {configured && (
        <button className="city-label" onClick={() => setEditing(!editing)}>
          <MapPin size={12} />
          <span>{weatherLocationLabel(prefs)}</span>
        </button>
      )}
      {(!configured || editing) && (
        <div className="weather-location-setup">
          <p>{configured ? "Change city" : "Enter your city"}</p>
          <form className="inline-form" onSubmit={choose}>
            <input
              aria-label="Weather city"
              placeholder="City or town"
              autoComplete="address-level2"
              minLength={2}
              maxLength={100}
              required
              value={city}
              onChange={(e) => setCity(e.target.value)}
            />
            <button disabled={busy} aria-label="Save weather city">
              <Check size={14} />
            </button>
          </form>
          <button
            className="weather-use-location"
            type="button"
            disabled={locating || busy}
            onClick={() => void locate()}
          >
            <LocateFixed size={14} />{" "}
            {locating ? "Finding location…" : "Use current location"}
          </button>
          {locationError && (
            <p className="weather-location-message" role="status">
              {locationError}
            </p>
          )}
        </div>
      )}
      {configured && (
        <>
          <div className="weather-now">
            <span>
              {weather ? Math.round(weather.temperature) + "°" : "—"}
              <small>C</small>
            </span>
            <span className="weather-symbol">
              <WeatherSymbol code={weather?.code ?? 2} size={46} />
            </span>
          </div>
          <div className="weather-caption">
            {weather
              ? weatherLabel(weather.code)
              : error
                ? "Forecast unavailable"
                : "Fetching forecast…"}
            <span>
              {weather
                ? `H ${Math.round(weather.max)}° / L ${Math.round(weather.min)}°`
                : ""}
            </span>
          </div>
          {!expanded && weather && (
            <dl
              className="weather-details"
              aria-label="Today's weather details"
            >
              {weather.wind !== undefined && (
                <div>
                  <dt>
                    <Wind size={14} /> Wind
                  </dt>
                  <dd>
                    {Math.round(weather.wind)} <small>km/h</small>
                  </dd>
                </div>
              )}
              {weather.humidity !== undefined && (
                <div>
                  <dt>
                    <Droplets size={14} /> Humidity
                  </dt>
                  <dd>
                    {Math.round(weather.humidity)}
                    <small>%</small>
                  </dd>
                </div>
              )}
              {weather.rainChance !== undefined && (
                <div>
                  <dt>
                    <CloudRain size={14} /> Rain chance
                  </dt>
                  <dd>
                    {Math.round(weather.rainChance)}
                    <small>%</small>
                  </dd>
                </div>
              )}
              {weather.sunrise && (
                <div>
                  <dt>
                    <Sunrise size={14} /> Sunrise
                  </dt>
                  <dd>{weather.sunrise.slice(11, 16)}</dd>
                </div>
              )}
              {weather.sunset && (
                <div>
                  <dt>
                    <Sunset size={14} /> Sunset
                  </dt>
                  <dd>{weather.sunset.slice(11, 16)}</dd>
                </div>
              )}
            </dl>
          )}
          {expanded && (
            <div className="weather-forecast">
              <label className="forecast-range">
                <select
                  aria-label="Forecast days"
                  value={prefs.forecastDays}
                  onChange={(e) =>
                    change({ forecastDays: Number(e.target.value) })
                  }
                >
                  {[3, 5, 7, 10, 14].map((n) => (
                    <option key={n} value={n}>
                      {n} days
                    </option>
                  ))}
                </select>
              </label>
              <div className="forecast-days">
                {weather?.days.map((day) => (
                  <div
                    className="forecast-day"
                    key={day.date}
                    title={weatherLabel(day.code)}
                  >
                    <span>
                      {new Date(day.date + "T12:00:00").toLocaleDateString([], {
                        weekday: "short",
                      })}
                    </span>
                    <small>
                      {new Date(day.date + "T12:00:00").toLocaleDateString([], {
                        month: "short",
                        day: "numeric",
                      })}
                    </small>
                    <WeatherSymbol code={day.code} />
                    <b>{Math.round(day.max)}°</b>
                    <span>{Math.round(day.min)}°</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
      <div className="widget-foot">
        <span className="weather-attribution">
          <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
            Open-Meteo
          </a>
          {prefs.weatherLocationSource === "device" && (
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
              title="City names from OpenStreetMap via Photon"
            >
              © OSM
            </a>
          )}
        </span>
        <span>
          {error ||
            (weather
              ? new Date(weather.time).toLocaleTimeString([], {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "")}
        </span>
      </div>
    </>
  );
}
function Contribution({
  acceptedTaskId,
  serverUrl,
}: {
  acceptedTaskId?: string;
  serverUrl: string;
}) {
  const [stats, setStats] = useState<{ accepted: number; queued: number }>();
  const [browserRuns, setBrowserRuns] = useState(0);
  useEffect(() => {
    let active = true;
    setStats(undefined);
    if (!serverUrl) {
      void getState<unknown[]>("browser-results").then((results) => {
        if (active) setBrowserRuns(results?.length ?? 0);
      });
      return () => {
        active = false;
      };
    }
    const refresh = () =>
      void api<any>("/v1/stats")
        .then((data) => {
          if (active) setStats(data);
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [acceptedTaskId, serverUrl]);
  return (
    <>
      <div className="widget-heading">
        <span className="contribution-star">✧</span>
        <span>YOUR ACTIVITY</span>
      </div>
      <div className="contribution-count">
        {serverUrl ? (stats?.accepted ?? "—") : browserRuns}
        <span>{serverUrl ? "validated models" : "saved browser runs"}</span>
      </div>
      <div className="widget-foot">
        <span>
          {!serverUrl
            ? "Saved on this device"
            : stats
              ? `${stats.queued} queued`
              : "Research service unavailable"}
        </span>
      </div>
    </>
  );
}
