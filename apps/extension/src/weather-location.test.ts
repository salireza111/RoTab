import { afterEach, expect, it, vi } from "vitest";
import {
  deviceWeatherLocation,
  emptyWeatherLocation,
  hasWeatherCoordinates,
  normalizeWeatherLocation,
  lookupWeatherCity,
  weatherLocationLabel,
} from "./weather-location";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("starts without a fabricated city and retires the legacy bundled Zürich location", () => {
  expect(normalizeWeatherLocation({})).toEqual(emptyWeatherLocation);
  expect(
    normalizeWeatherLocation({
      city: "Zürich",
      latitude: 47.3769,
      longitude: 8.5417,
    }),
  ).toEqual(emptyWeatherLocation);
});

it("preserves deliberate city choices, including Zürich, and valid zero coordinates", () => {
  const chosen = {
    city: "Zürich",
    latitude: 47.3769,
    longitude: 8.5417,
    weatherLocationSource: "city" as const,
    weatherLocationAttempted: true,
  };
  expect(normalizeWeatherLocation(chosen)).toEqual(chosen);
  expect(
    normalizeWeatherLocation({
      city: "Berlin",
      latitude: 52.52,
      longitude: 13.41,
    }),
  ).toMatchObject({
    city: "Berlin",
    latitude: 52.52,
    weatherLocationSource: "city",
    weatherLocationAttempted: true,
  });
  expect(hasWeatherCoordinates({ latitude: 0, longitude: 0 })).toBe(true);
  expect(normalizeWeatherLocation({ city: "Geneva" })).toMatchObject({
    city: "Geneva",
    latitude: null,
    longitude: null,
    weatherLocationAttempted: true,
  });
  for (const latitude of [NaN, Infinity, 91, null, "47.3"])
    expect(hasWeatherCoordinates({ latitude, longitude: 0 })).toBe(false);
});

it("uses real device coordinates at weather precision without inventing a city name", async () => {
  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: (success: Function) =>
        success({ coords: { latitude: 52.520008, longitude: 13.404954 } }),
    },
  });
  expect(await deviceWeatherLocation()).toEqual({
    city: "Current location",
    latitude: 52.52,
    longitude: 13.4,
    weatherLocationSource: "device",
    weatherLocationAttempted: true,
  });
});

it("labels detected cities without changing manually selected city labels", async () => {
  const device = {
    ...emptyWeatherLocation,
    city: "Geneva",
    weatherLocationSource: "device" as const,
  };
  expect(weatherLocationLabel(device)).toBe("Current location - Geneva");
  expect(weatherLocationLabel({ ...device, city: "Current location" })).toBe(
    "Current location",
  );
  expect(
    weatherLocationLabel({ ...device, weatherLocationSource: "city" }),
  ).toBe("Geneva");
  const fetchCity = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      features: [{ properties: { type: "city", name: "Geneva" } }],
    }),
  });
  vi.stubGlobal("fetch", fetchCity);
  expect(
    await lookupWeatherCity({ latitude: 46.204391, longitude: 6.143158 }),
  ).toBe("Geneva");
  const url = new URL(fetchCity.mock.calls[0][0]);
  expect(url.searchParams.get("lat")).toBe("46.2");
  expect(url.searchParams.get("lon")).toBe("6.14");
});

it("keeps an unnamed device location usable when city lookup fails or returns no settlement", async () => {
  for (const response of [
    { ok: false },
    { ok: true, json: async () => ({ features: [] }) },
    {
      ok: true,
      json: async () => ({
        features: [{ properties: { name: "Nearby shop", type: "house" } }],
      }),
    },
    {
      ok: true,
      json: async () => ({
        features: [
          {
            properties: {
              name: "Switzerland",
              osm_key: "place",
              osm_value: "country",
            },
          },
        ],
      }),
    },
  ]) {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    expect(
      await lookupWeatherCity({ latitude: 46.2, longitude: 6.14 }),
    ).toBeNull();
  }
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  expect(
    await lookupWeatherCity({ latitude: 46.2, longitude: 6.14 }),
  ).toBeNull();
  expect(
    await lookupWeatherCity({ latitude: NaN, longitude: 6.14 }),
  ).toBeNull();
});

it("falls back to city entry for denied, missing or invalid location services", async () => {
  vi.stubGlobal("navigator", {});
  await expect(deviceWeatherLocation()).rejects.toThrow("Enter your city");
  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: (_success: Function, fail: Function) =>
        fail({ code: 1 }),
    },
  });
  await expect(deviceWeatherLocation()).rejects.toThrow("Enter your city");
  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: (success: Function) =>
        success({ coords: { latitude: NaN, longitude: 0 } }),
    },
  });
  await expect(deviceWeatherLocation()).rejects.toThrow("Enter your city");
});

it("bounds an unanswered location prompt and ignores a late position", async () => {
  vi.useFakeTimers();
  let success!: Function;
  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: (callback: Function) => {
        success = callback;
      },
    },
  });
  const result = deviceWeatherLocation();
  const rejected = expect(result).rejects.toThrow("Enter your city");
  await vi.advanceTimersByTimeAsync(10_000);
  await rejected;
  success({ coords: { latitude: 52, longitude: 13 } });
  await expect(result).rejects.toThrow("Enter your city");
});
