# Public live activity

Owners publish a workspace's public activity profile from **Public profile** in the app. A visitor can open the profile link without an account. A website can use the same published data through JSON or a live server-sent event stream. All three require publication; there is no public access token to leak or embed in a website.

| Route | Use |
| --- | --- |
| `GET /u/:slug` | Shareable profile page with automatically updating counts. |
| `GET /api/public/activity/:slug` | One current aggregate snapshot, with CORS. |
| `GET /api/public/activity/:slug/stream` | Live snapshots over SSE, with CORS. |
| `GET /api/public/activity/:slug/card.svg` | Scalable image snapshot for websites. |
| `GET /api/public/activity/:slug/card.png` | Social preview image snapshot. |

The app provides copy buttons for the public link, JSON URL, live API URL, a JavaScript website embed, and an image embed. Images are snapshots; the stream and profile page update automatically. External websites must allow the Engram host in their Content Security Policy `connect-src` to use the live API.

## Stream contract

The response uses `Content-Type: text/event-stream`. Each connection starts with a full `snapshot` event and a five-second retry hint:

```text
retry: 5000

event: snapshot
data: {"profile":{...},"stats":{...},"daily":[...],"tools":[...],"updatedAt":"...","live":{...}}

```

Each snapshot has the same schema as the JSON endpoint. The `live` object contains:

```json
{
  "workingAgents": 2,
  "recentlyActiveAgents": 3,
  "completedAgents": 5,
  "failedAgents": 1,
  "workingActions": 2,
  "staleActions": 1,
  "lastActivityAt": "2026-10-22T10:00:00.000Z",
  "checkedAt": "2026-10-22T10:00:05.000Z",
  "freshnessSeconds": 900
}
```

- Working counts require the latest logical action to be running, with a report received by the server in the last 15 minutes. This is reported activity, not proof that an external process is online.
- Recently active counts identities that reported activity or called an observed Engram tool in that receipt window, regardless of the result.
- Completed/failed agent counts are all-time distinct reporting identities with a terminal action of that result. They can overlap with working/recent identities and with each other.
- Stale actions are still recorded as running but have no recent report. They are excluded from working now. A new running heartbeat with a fresh `eventId` refreshes them; retrying the same report does not.
- `stats` and category/day totals use each logical action's latest state. A keyed running action followed by its completion counts once. Historical reports without an `actionKey` remain individual events.

Snapshots contain no agent names, tool identifiers, task summaries, resources, details, run IDs, action/event keys, or transcripts. The profile's chosen name/bio is public. Counts refer to authenticated reporting identities, which need not correspond one-to-one to a physical agent process.

## Use it on a website

Replace the host and slug with the URLs copied from Engram:

```html
<div id="engram-activity" aria-live="polite">Connecting…</div>
<script>
(() => {
  const target = document.getElementById("engram-activity");
  let feed, retry;
  function stop() {
    clearTimeout(retry);
    feed?.close();
    feed = null;
  }
  function connect() {
    stop();
    const current = feed = new EventSource("https://YOUR_HOST/api/public/activity/YOUR_SLUG/stream");
    current.addEventListener("snapshot", event => {
      if (feed !== current) return;
      const { live, stats } = JSON.parse(event.data);
      const count = live.workingAgents;
      target.textContent = count + (count === 1 ? " agent working · " : " agents working · ")
        + stats.completedActions + " actions completed";
    });
    current.addEventListener("error", () => {
      if (feed !== current) return;
      target.textContent = current.readyState === 2
        ? "Live activity unavailable" : "Reconnecting…";
    });
    current.addEventListener("closed", event => {
      if (feed !== current) return;
      stop();
      target.textContent = "Live activity unavailable";
      if (JSON.parse(event.data).reason === "unavailable") retry = setTimeout(connect, 5000);
    });
  }
  window.addEventListener("pagehide", stop);
  window.addEventListener("pageshow", event => { if (event.persisted) connect(); });
  connect();
})();
</script>
```

`snapshot` is a complete current view, not a raw event log or replay cursor. Reconnecting always starts from current state. A website should close its connection when its widget is removed. The built-in profile pauses hidden pages, reconnects when visible, distinguishes connection states, and updates counts without resetting keyboard focus in the chart. A transient server failure clears its old public view and retries; returning through browser history fetches a fresh public snapshot.

## Publication, retries, and resource limits

New requests to unpublished/missing profiles return 404. Open streams recheck publication while refreshing and send `event: closed` with a generic reason when publication changes or access becomes unavailable, then close. Clients must close their `EventSource` after that event and remove the old view. Existing streams normally observe publication changes on the next five-second check. In-flight or already downloaded public data cannot be recalled. A profile edit can also retire an old stream; retrying reloads the current public profile.

The service shares one five-second aggregate poll per published profile per process, sends comment heartbeats every 15 seconds, and rotates connections after 90 seconds for normal browser reconnection. It bounds active streams and buffers (128 per process, 32 per profile, 32 KiB per subscriber) and releases resources on abort, cancellation, or a slow subscriber. At most four source loads run at once per process; a timed-out load retains its slot until the underlying work settles, preventing retries from stacking abandoned queries. Saturation returns 503 with `Retry-After: 5`. Database failures stop delivery instead of serving cached data as currently public. Public streams use no-store/no-transform responses; reverse proxies must not buffer them.

Standard references: [WHATWG server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) and [MDN EventSource usage](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).
