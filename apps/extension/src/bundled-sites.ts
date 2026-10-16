export const PERSONAL_FAVORITE = {
  id: "alireza",
  name: "Alireza Hashemi",
  url: "https://salireza111.github.io/",
  folder: "Favorites",
};

/** Supplied site artwork stays packaged, including in the offline preview. */
export function packagedSiteIcon(value: string): string | undefined {
  try {
    const page = new URL(value);
    if (
      ["https:", "http:"].includes(page.protocol) &&
      !page.username &&
      !page.password &&
      page.hostname === "salireza111.github.io"
    ) {
      if (/^\/RoTab_Doc(?:\/|$)/.test(page.pathname)) return "./status-32.png";
      if (page.pathname === "/") return "./favorites/alireza.png";
    }
  } catch {
    return;
  }
}
import { documentation } from "./documentation";

export const DOCUMENTATION_FAVORITE = {
  id: "rotab-docs",
  name: "About RoTab",
  url: documentation.home,
};
