export interface ForecastDay {
  date: string;
  code: number;
  max: number;
  min: number;
}
export interface WeatherData {
  time: number;
  temperature: number;
  code: number;
  max: number;
  min: number;
  city: string;
  days: ForecastDay[];
  wind?: number;
  humidity?: number;
  rainChance?: number;
  sunrise?: string;
  sunset?: string;
}
export function weatherLabel(code: number) {
  if (code === 0) return "Clear skies";
  if (code <= 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return "Snow";
  if (code >= 95) return "Thunderstorms";
  if (code >= 51 && code <= 82) return "Rain";
  return "Changing skies";
}
export function parseWeather(
  data: any,
  city: string,
  count: number,
): WeatherData {
  const daily = data?.daily;
  if (
    !Number.isFinite(data?.current?.temperature_2m) ||
    !Number.isFinite(data?.current?.weather_code) ||
    !Array.isArray(daily?.time)
  )
    throw new Error("Weather unavailable");
  const days = daily.time
    .slice(0, count)
    .map((date: string, i: number) => ({
      date,
      code: daily.weather_code?.[i],
      max: daily.temperature_2m_max?.[i],
      min: daily.temperature_2m_min?.[i],
    }))
    .filter(
      (day: ForecastDay) =>
        /^\d{4}-\d{2}-\d{2}$/.test(day.date) &&
        [day.code, day.max, day.min].every(Number.isFinite),
    );
  if (!days.length) throw new Error("Forecast unavailable");
  return {
    time: Date.now(),
    temperature: data.current.temperature_2m,
    code: data.current.weather_code,
    max: days[0].max,
    min: days[0].min,
    city,
    days,
    wind: finiteRange(data.current.wind_speed_10m, 0, 1000),
    humidity: finiteRange(data.current.relative_humidity_2m, 0, 100),
    rainChance: finiteRange(daily.precipitation_probability_max?.[0], 0, 100),
    sunrise: localSunTime(daily.sunrise?.[0]),
    sunset: localSunTime(daily.sunset?.[0]),
  };
}

const finiteRange = (value: unknown, min: number, max: number) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max
    ? value
    : undefined;
const localSunTime = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)
    ? value
    : undefined;
