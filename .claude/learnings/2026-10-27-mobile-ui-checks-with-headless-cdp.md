# Check narrow layouts with headless Chrome over CDP when the browser window cannot resize

**Problem shape:** a mobile/narrow-width UI check is required, but the
automated browser window is maximized (`innerWidth` stays at screen width after
a resize call), and the app's CSP blocks loading it in an iframe.

**The procedure:**
1. Launch `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --headless=new --remote-debugging-port=9333 --user-data-dir=<scratch dir>`.
   In a worktree-isolated agent the shell may refuse the quoted Chrome path;
   start it from a tiny Bun script with `Bun.spawn([...])` run in the background.
   The `web/dev-server.ts` demo needs `bun --preload ./test/preload.ts`.
2. Fetch `http://127.0.0.1:9333/json`, open the page target's WebSocket.
3. Send `Network.setCookie` with the local dev session cookie
   (`engram_session`, httpOnly, url `http://localhost:<port>/`).
4. Send `Emulation.setDeviceMetricsOverride` `{width: 390 or 320, height, deviceScaleFactor: 1, mobile: true}`.
5. `Page.navigate`, wait, then `Runtime.evaluate` to compare
   `documentElement.scrollWidth` with `clientWidth` and list elements whose
   right edge exceeds `clientWidth`. Also measure button heights (expect 44px).
6. `Page.captureScreenshot` and inspect it.

**Why this works / the trap it avoids:** resizing a maximized window silently
does nothing, so "mobile" screenshots are really desktop. Metric overrides
trigger real media queries, and the measured overflow list replaces eyeballing.

**Evidence:** Handoffs review at 390/320px, PR #51 (caught a flex-basis height bug).
