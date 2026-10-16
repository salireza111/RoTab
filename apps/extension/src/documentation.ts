import publication from "../../../docs/publication.json";

export const documentation = {
  home: publication.siteUrl,
  help: new URL("help/index.html", publication.siteUrl).href,
  privacy: new URL("policies/privacy.html", publication.siteUrl).href,
  support: new URL("policies/support.html", publication.siteUrl).href,
};
