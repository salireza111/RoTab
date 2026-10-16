# RoTab Google Calendar setup

Calendar works inside the extension using browser.identity.launchWebAuthFlow and direct Google Calendar REST requests. There is no participant server, native helper, remote JavaScript SDK, client secret or account password in RoTab.

## Operator setup

1. Create a Google Cloud project and enable the **Google Calendar API**.
2. Configure the OAuth consent screen. For a private test, keep the app in Testing and add each participant's Google account as a test user. Public distribution requires Google's consent/verification process as applicable.
3. Create an OAuth client with application type **Web application**. This implementation uses Google's documented client-side access-token flow; do not create a Desktop or Chrome-extension client for it.
4. Register the redirect URI for the extension being configured. RoTab obtains it through `chrome.identity.getRedirectURL("google-calendar")`; the exact URI can be obtained from that call in the installed extension's developer console. An unpacked source build has its own extension ID and may differ from the Store installation. No client secret belongs in the extension.

5. Request the Calendar event scope:

   https://www.googleapis.com/auth/calendar.events

6. Copy the **public client ID**, ending in .apps.googleusercontent.com. Do not put a client secret in the extension. Set VITE_GOOGLE_OAUTH_CLIENT_ID in the development/build environment to provide the ID in a build, or paste it into Calendar's Connect dialog. No domain purchase is required for the chromiumapp.org redirect.
7. Load/reload the built extension, click Calendar's link icon, grant the optional browser access and complete Google's consent screen. Use Chrome or Brave's installed extension, rather than the local development preview, for real sign-in.

## Behavior

The widget reads the primary calendar for the selected month and supports personal event creation, title/date/time edits and deletion. Local notes remain separate. All-day ranges use Google's exclusive end dates; timed events use your browser's local timezone. Events with guests are shown but cannot be modified here, to avoid sending invitations or updates to others. There is no guest-invitation feature.

Tokens live only in chrome.storage.session, shared by the extension's tabs and cleared when the browser exits. No refresh token is requested. A token expires after Google's granted lifetime; reconnect explicitly when needed. Disconnect clears the local session and displayed Google events; it does not delete events or revoke the Google account's app grant. You can revoke that grant from Google's account permissions page. Revoking RoTab's browser Calendar permissions also discards its stored session.

Calendar event data is kept in memory for display, not in preferences, IndexedDB, peer packets or exported scientific records. Browser permissions identity and www.googleapis.com access are requested only when connecting. Most-visited shortcuts use a separate optional topSites permission. Neither is needed for Rosetta computation.

## Verification limits

Automated tests cover OAuth state/redirect/scope validation, expired access, pagination, conditional event edits, all-day/multi-day dates, personal event CRUD, and local disconnect using synthetic OAuth/API responses. **Live Google consent and account interoperability have not been tested without a configured Google project/client ID.** Live authorization requires an appropriately configured Google OAuth project and authorized redirect URI.

Official references:

- [Chrome identity API](https://developer.chrome.com/docs/extensions/reference/api/identity)
- [Google client-side OAuth flow](https://developers.google.com/identity/protocols/oauth2/javascript-implicit-flow)
- [Calendar events list](https://developers.google.com/workspace/calendar/api/v3/reference/events/list)
- [Calendar events insert](https://developers.google.com/workspace/calendar/api/v3/reference/events/insert)
- [Calendar events patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch)
