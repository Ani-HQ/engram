# Review a local redesign against real production data by fulfilling its API calls over CDP

**Problem shape:** a local dev page renders sparse demo data, so the redesign can't
be judged realistically, and full-page CDP screenshots of a page holding an open
EventSource (live stream) hang or come back as the no-JS fallback.

**The procedure:**
1. `curl` the public JSON from production into a scratch file (public data only).
2. In the CDP script, before navigating: `Fetch.enable` with
   `{ patterns: [{ urlPattern: "*/api/public/activity/*" }] }`.
3. On each `Fetch.requestPaused`: if the URL ends in `/stream`, fulfill with
   `Content-Type: text/event-stream` and body `event: snapshot\ndata: <json on one line>\n\n`;
   otherwise fulfill with the JSON. Bodies are base64.
4. Wait at least 4s after `Page.navigate` (2.5s caught the server fallback HTML).
5. Do not use `captureBeyondViewport`. Read `scrollHeight`, re-send
   `Emulation.setDeviceMetricsOverride` with that height, wait 600ms, then call
   `Page.captureScreenshot` raced against a 20s timeout and `process.exit` after writing.
6. Compare `documentElement.scrollWidth` to `clientWidth` at 1440 and 390; any
   difference is horizontal overflow (here: a widened `::before` glow).

**Why this works / the trap it avoids:** the page's own client code runs unchanged
on real numbers, so layout and scaling problems surface (one 151-action day made a
linear heatmap look flat). `captureBeyondViewport` stalled indefinitely while the
stream was open. A fulfilled stream ends, so the page shows "Reconnecting…"; that
is a mock artifact, not a bug.

**Evidence:** PR #80 (feat/slick-public-profiles), scratch `shot.ts` with `MOCK=prod.json`.
