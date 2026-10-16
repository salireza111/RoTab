import { useState } from "react";
import { packagedSiteIcon } from "./bundled-sites";

/** Use the browser's favicon service, without a third-party icon proxy. */
export function faviconUrl(value: string): string | undefined {
  try {
    const page = new URL(value);
    if (
      !["https:", "http:"].includes(page.protocol) ||
      page.username ||
      page.password
    )
      return;
    if (typeof chrome === "undefined" || !chrome.runtime?.id) return;
    const icon = new URL(chrome.runtime.getURL("/_favicon/"));
    icon.searchParams.set("pageUrl", page.href);
    icon.searchParams.set("size", "32");
    return icon.href;
  } catch {
    return;
  }
}

export function SiteIcon({
  url,
  name,
  className = "site-icon",
}: {
  url: string;
  name: string;
  className?: string;
}) {
  const [failed, setFailed] = useState("");
  const source = packagedSiteIcon(url) ?? faviconUrl(url);
  return (
    <span className={className} aria-hidden="true">
      {source && failed !== source ? (
        <img
          key={source}
          src={source}
          alt=""
          width="24"
          height="24"
          loading="lazy"
          onError={() => setFailed(source)}
        />
      ) : (
        name.slice(0, 1).toUpperCase()
      )}
    </span>
  );
}
