# Changelog

## 0.5.11

- Search opens with **Browser default** and uses the Chrome Search API. Explicit Google, DuckDuckGo, Brave and Bing selections apply to the current tab; new tabs and reloads return to the browser default.
- Optional search suggestions follow the selected provider, require its origin permission and can be disabled. Failed or rate-limited requests do not contact a substitute provider.
- Help, Privacy and Support links appear at the bottom of Computation settings and Appearance.

The public source build excludes the compiled Rosetta engine, its database and shared TURN authentication. It includes the application, standalone adapter, original scientific integration and build/validation tools. The [Chrome Web Store release](https://chromewebstore.google.com/detail/rotab/nojodengjpkcbpeknlmllfmchkgonpco) provides the packaged installation; the [documentation](https://salireza111.github.io/RoTab_Doc/) describes its capabilities and scientific scope.
