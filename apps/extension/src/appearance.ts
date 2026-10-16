import { useEffect, useState } from "react";
import { getState, putState, type Preferences } from "./storage";
import { accessibleAccent, FONTS, readableInk } from "./personalization";

export const MAX_BACKGROUND_BYTES = 8 * 1024 * 1024;
interface SavedBackground {
  id: string;
  blob: Blob;
}

export async function saveBackground(file: File): Promise<string> {
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type))
    throw new Error("Choose a JPEG, PNG, or WebP image.");
  if (!file.size || file.size > MAX_BACKGROUND_BYTES)
    throw new Error("Choose an image smaller than 8 MB.");
  const decoded = await createImageBitmap(file);
  try {
    if (decoded.width * decoded.height > 32_000_000)
      throw new Error("Choose an image with fewer than 32 million pixels.");
  } finally {
    decoded.close();
  }
  const id = crypto.randomUUID();
  await putState("appearance-background", { id, blob: file });
  return id;
}

/** Image bytes stay in IndexedDB, never in sync storage or peer messages. */
export function useAppearance(prefs: Preferences) {
  const [backgroundUrl, setBackgroundUrl] = useState<string>();
  useEffect(() => {
    document.documentElement.dataset.visualStyle = prefs.visualStyle;
  }, [prefs.visualStyle]);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      const root = document.documentElement;
      root.dataset.theme =
        prefs.theme === "system"
          ? media.matches
            ? "light"
            : "dark"
          : prefs.theme;
      root.style.setProperty("--app-font", FONTS[prefs.font].stack);
      root.style.setProperty(
        "--custom-background",
        prefs.gradient
          ? `linear-gradient(${prefs.gradientAngle}deg, ${prefs.backgroundColor}, ${prefs.backgroundEnd})`
          : prefs.backgroundColor,
      );
      root.style.removeProperty("--mint");
      const surface = getComputedStyle(root).getPropertyValue("--panel").trim();
      if (prefs.accentColor) {
        root.style.setProperty(
          "--mint",
          accessibleAccent(prefs.accentColor, surface),
        );
      }
      const accent = getComputedStyle(root).getPropertyValue("--mint").trim();
      root.style.setProperty("--accent-ink", readableInk(accent));
      const highlight = accessibleAccent(
        prefs.highlightColor || accent,
        surface,
      );
      root.style.setProperty("--highlight", highlight);
      root.style.setProperty("--highlight-ink", readableInk(highlight));
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [
    prefs.theme,
    prefs.visualStyle,
    prefs.font,
    prefs.accentColor,
    prefs.highlightColor,
    prefs.backgroundColor,
    prefs.backgroundEnd,
    prefs.gradient,
    prefs.gradientAngle,
  ]);
  useEffect(() => {
    let cancelled = false;
    let url: string | undefined;
    setBackgroundUrl(undefined);
    if (prefs.background === "uploaded" && prefs.backgroundId) {
      void getState<SavedBackground>("appearance-background")
        .then((saved) => {
          if (
            cancelled ||
            !saved ||
            saved.id !== prefs.backgroundId ||
            !(saved.blob instanceof Blob)
          )
            return;
          url = URL.createObjectURL(saved.blob);
          setBackgroundUrl(url);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [prefs.background, prefs.backgroundId]);
  return backgroundUrl;
}
