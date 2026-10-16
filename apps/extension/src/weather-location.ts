export interface WeatherLocation {
  city: string;
  latitude: number | null;
  longitude: number | null;
  weatherLocationSource: "unset" | "city" | "device";
  weatherLocationAttempted: boolean;
}

export const emptyWeatherLocation: WeatherLocation = {
  city: "",
  latitude: null,
  longitude: null,
  weatherLocationSource: "unset",
  weatherLocationAttempted: false,
};

export function weatherLocationLabel(location: WeatherLocation) {
  return location.weatherLocationSource === "device" &&
    location.city !== "Current location"
    ? `Current location - ${location.city}`
    : location.city;
}

/** Resolve only a city/town name; never display a nearby street or business. */
export async function lookupWeatherCity(location: {
  latitude: number;
  longitude: number;
}): Promise<string | null> {
  if (!hasWeatherCoordinates(location)) return null;
  const query = new URLSearchParams({
    lat: String(Math.round(location.latitude * 100) / 100),
    lon: String(Math.round(location.longitude * 100) / 100),
    lang: "en",
    layer: "city",
    limit: "1",
    radius: "30",
  });
  try {
    const response = await fetch(`https://photon.komoot.io/reverse?${query}`, {
      signal: AbortSignal.timeout(8000),
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
    if (!response.ok) return null;
    const data = await response.json();
    const properties = data?.features?.[0]?.properties;
    const name = properties?.city ?? properties?.name;
    if (
      typeof name !== "string" ||
      !(
        properties?.type === "city" ||
        (properties?.osm_key === "place" &&
          ["city", "town", "village", "hamlet", "isolated_dwelling"].includes(
            properties?.osm_value,
          ))
      )
    )
      return null;
    return name.trim().slice(0, 100) || null;
  } catch {
    return null;
  }
}

export function hasWeatherCoordinates(location: {
  latitude?: unknown;
  longitude?: unknown;
}) {
  return (
    typeof location.latitude === "number" &&
    Number.isFinite(location.latitude) &&
    Math.abs(location.latitude) <= 90 &&
    typeof location.longitude === "number" &&
    Number.isFinite(location.longitude) &&
    Math.abs(location.longitude) <= 180
  );
}

/** Unmarked legacy Zürich entries are indistinguishable from the bundled default. */
export function normalizeWeatherLocation(
  saved: Partial<WeatherLocation>,
): WeatherLocation {
  const city =
    typeof saved.city === "string" ? saved.city.trim().slice(0, 100) : "";
  if (
    !saved.weatherLocationSource &&
    ["Zürich", "Zurich"].includes(city) &&
    saved.latitude === 47.3769 &&
    saved.longitude === 8.5417
  )
    return { ...emptyWeatherLocation };
  if (!city || !hasWeatherCoordinates(saved))
    return {
      ...emptyWeatherLocation,
      city,
      weatherLocationAttempted:
        saved.weatherLocationAttempted === true || !!city,
    };
  return {
    city,
    latitude: saved.latitude!,
    longitude: saved.longitude!,
    weatherLocationSource:
      saved.weatherLocationSource === "device" ? "device" : "city",
    weatherLocationAttempted: true,
  };
}

export function deviceWeatherLocation(): Promise<WeatherLocation> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is unavailable. Enter your city."));
      return;
    }
    // Also bound permission/OS dialogs, whose waiting time can exceed the API timeout.
    const timer = setTimeout(
      () => reject(new Error("Location timed out. Enter your city.")),
      10_000,
    );
    try {
      navigator.geolocation.getCurrentPosition(
        ({ coords }) => {
          clearTimeout(timer);
          if (!hasWeatherCoordinates(coords)) {
            reject(new Error("Location is unavailable. Enter your city."));
            return;
          }
          // Weather needs a neighborhood, not an exact device position.
          resolve({
            city: "Current location",
            latitude: Math.round(coords.latitude * 100) / 100,
            longitude: Math.round(coords.longitude * 100) / 100,
            weatherLocationSource: "device",
            weatherLocationAttempted: true,
          });
        },
        () => {
          clearTimeout(timer);
          reject(new Error("Location is unavailable. Enter your city."));
        },
        { enableHighAccuracy: false, timeout: 8000, maximumAge: 15 * 60_000 },
      );
    } catch {
      clearTimeout(timer);
      reject(new Error("Location is unavailable. Enter your city."));
    }
  });
}
