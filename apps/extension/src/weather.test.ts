import { expect, it } from "vitest";
import { parseWeather, weatherLabel } from "./weather";
it("preserves daily dates and temperatures without fabricating missing forecast days", () => {
  const data = {
    current: { temperature_2m: 12, weather_code: 71 },
    daily: {
      time: ["2026-10-08", "2026-10-09", "2026-10-10"],
      weather_code: [71, 0, 3],
      temperature_2m_max: [14, 16],
      temperature_2m_min: [4, 6],
    },
  };
  expect(parseWeather(data, "Zurich", 7).days).toEqual([
    { date: "2026-10-08", code: 71, max: 14, min: 4 },
    { date: "2026-10-09", code: 0, max: 16, min: 6 },
  ]);
  expect(weatherLabel(71)).toBe("Snow");
  expect(weatherLabel(95)).toBe("Thunderstorms");
  expect(() => parseWeather({}, "Zurich", 7)).toThrow("Weather unavailable");
});

it("keeps only available, valid daily details and preserves local sunrise times", () => {
  const data = { current: { temperature_2m: 16, weather_code: 2, relative_humidity_2m: 72, wind_speed_10m: 12 }, daily: {
    time: ["2026-10-11"], weather_code: [2], temperature_2m_max: [19], temperature_2m_min: [8],
    precipitation_probability_max: [40], sunrise: ["2026-10-11T07:42"], sunset: ["2026-10-11T18:55"],
  } };
  expect(parseWeather(data, "Geneva", 1)).toMatchObject({ wind: 12, humidity: 72, rainChance: 40, sunrise: "2026-10-11T07:42", sunset: "2026-10-11T18:55" });
  data.current.relative_humidity_2m = 101;
  data.daily.sunset = ["invalid"];
  const parsed = parseWeather(data, "Geneva", 1);
  expect(parsed.humidity).toBeUndefined();
  expect(parsed.sunset).toBeUndefined();
});
