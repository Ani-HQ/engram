# Public live activity

Owners publish a workspace's public activity profile from **Public profile** in the app. A visitor can open the profile link without an account. A website can use the same published data through JSON or a live server-sent event stream. All three require publication; there is no public access token to leak or embed in a website.

| Route | Use |
| --- | --- |
| `GET /u/:slug` | Shareable profile page with live counts and an optional redacted activity stream. |
| `GET /api/public/activity/:slug` | One current public snapshot, with CORS. |
| `GET /api/public/activity/:slug/stream` | Live snapshots over SSE, with CORS. |
| `GET /api/public/activity/:slug/card.svg` | Scalable image snapshot for websites. |
| `GET /api/public/activity/:slug/card.png` | Social preview image snapshot. |
| `GET /api/public/activity/:slug/photo.png?v=:digest` | Current published profile photo as a normalized PNG. |

The app provides copy buttons for the public link, JSON URL, live API URL, a JavaScript website embed, and an image embed. Images are snapshots; the stream and profile page update automatically. External websites must allow the Engram host in their Content Security Policy `connect-src` to use the live API.

## Stream contract

The response uses `Content-Type: text/event-stream`. Each connection starts with a full `snapshot` event and a five-second retry hint:

```text
retry: 5000

event: snapshot
data: {"profile":{...},"stats":{...},"daily":[...],"tools":[...],"updatedAt":"...","live":{...},"activity":{"enabled":false,"events":[]}}

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

The profile's chosen name/bio is public. Counts refer to authenticated reporting identities, which need not correspond one-to-one to a physical agent process. Raw tool identifiers, private agent aliases, task summaries, resources, details, run IDs, action/event keys, and transcripts are excluded.

### Owner-written layout and highlights

The profile projection includes `layout` (`"studio"` or `"field-notes"`) and `highlights`, an array of up to three records. An owner writes and approves these public records in Public profile; they are not generated from private memory or task activity. Each record contains a trimmed `title` (1–80 characters), `body` (0–600 characters), and an optional `url` (empty or up to 2,048 characters, absolute HTTP/HTTPS without credentials or control characters). Unknown nested keys are rejected. Render titles and bodies as text, and use the validated URL only as a link destination.

Older records default to `layout: "studio"` and `highlights: []`. Legacy clients that omit these new fields on update preserve the saved values; an explicit empty array clears highlights. The owner settings response, public JSON and public SSE snapshots use the same normalized fields. Invalid stored highlight records are excluded rather than projected. Changing these fields changes the publication revision; unpublishing still removes all public endpoints.

### Owner-uploaded profile photo

Owner settings accept optional `photo`: a prepared `data:image/png;base64,...`
string or `null`. Omission preserves the saved image; `null` removes it. The
console omits unchanged photos when saving other fields so an old form does
not overwrite a photo changed in another tab. The authenticated settings
response includes the saved normalized photo for editing. The browser accepts
JPG, PNG or WebP input up to 5 MB and prepares a 256 × 256 PNG; the server
validates that square PNG, bounds it to 512 KiB, and re-encodes its pixels
without source metadata before storage.

Public JSON and SSE instead expose `profile.photoUrl`, either `null` or the
relative URL `/api/public/activity/:slug/photo.png?v=:digest`, where the digest
is the normalized image's 64-character SHA-256 hex value. They contain no image
bytes. The image endpoint supports GET and HEAD, uses `Cache-Control: no-store`
and `X-Content-Type-Options: nosniff`, and checks the current published profile
and digest before and after reading bytes. Missing, private, removed, replaced,
or renamed image URLs return 404. Already downloaded public images cannot be
recalled.

The additive migration adds nullable `photo_png` and `photo_digest` columns to
`action_profiles`, constrained to a complete bounded image/digest pair, and an
exact `profile_photo_version` readiness marker of `2026102602`. Existing rows
retain no photo and use the shared local avatar. Apply the separate provisioner
before starting photo-enabled runtime instances; all existing readiness markers
remain unchanged. Repeated migration preserves saved images and publication.

### Optional redacted activity

An owner can enable **Share a redacted activity stream** in Public profile. `showActivity` defaults to `false`, including for existing published profiles. The owner can inspect the private preview before saving. JSON and SSE follow the same saved setting; turning it off retires the old publication binding and subsequent snapshots return `activity: { enabled: false, events: [] }`.

When enabled, `activity.events` contains at most 20 latest logical actions, newest receipt first:

```json
{
  "id": "opaque-public-id",
  "agent": { "product": "codex", "label": "Codex" },
  "service": "github",
  "action": "Reviewing a pull request",
  "status": "running",
  "evidence": "reported",
  "updatedAt": "2026-10-25T10:00:00.000Z"
}
```

Agent products and services come from fixed allowlists; unknown products are labeled Agent. Action descriptions are fixed templates derived from operation types. They never reuse or redact a private task's free text. Repository owners/names, document titles, URL paths/query strings, memory queries, personal aliases, and custom source labels are omitted. Public identifiers are keyed projections scoped to the profile, not private action IDs. A running action without a receipt in the last 15 minutes becomes `stale`; it does not claim the agent is still working. `observed` identifies Engram operations, while external work remains `reported`.

The private owner-settings response can include these same safe events for a prospective preview before opt-in. That authenticated preview is never evidence that the events are already public. Social image cards retain aggregate counts.

Upgrades retain `action_profiles.show_activity` with its `false` default and add `layout` (non-null text, default `studio`) plus `highlights` (non-null JSONB, default `[]`). Database constraints bound the supported layouts and array size. The existing `showcase_version` readiness marker remains exactly `2026102501`; a separate `profile_presentation_version` marker records `2026102502`. All predecessor readiness markers remain unchanged, so existing runtime revisions can cold-start after migration and serve a traffic rollback. The new runtime requires both exact marker values and rejects absent or mismatched presentation readiness. Apply the normal provisioner migration before rolling out new runtime instances. The additive migration preserves existing publication choices and sharing scope and can run repeatedly; a traffic rollback does not remove the new columns or stored owner content.

Use the existing provisioner delivery path (`bun gateway/src/jobs/provision.ts`, with the restricted runtime/provisioner identities described in [ORGS.md](ORGS.md)), or the release staging workflow that runs that job. Do not give the public runtime migration credentials. The guarded `test/integration-postgres.ts` scenario verifies an old published row across the additive upgrade, repeats the migration, checks unchanged predecessor markers plus separate presentation readiness, preserves owner text/publication choice, and exercises storage constraints and legacy updates. It requires the documented disposable local PostgreSQL cluster; the in-memory demo does not need that migration and mirrors validation and field-preservation behavior.

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

`snapshot` is a complete current view, not a raw event log or replay cursor. Reconnecting always starts from current state. A website should close its connection when its widget is removed. The built-in profile pauses hidden pages, reconnects when visible, distinguishes connection states, and updates the stream and counts without resetting keyboard focus in the chart. A transient server failure clears its old public view and retries; returning through browser history fetches a fresh public snapshot.

## Publication, retries, and resource limits

New requests to unpublished/missing profiles return 404. Open streams recheck publication while refreshing and send `event: closed` with a generic reason when publication changes or access becomes unavailable, then close. Clients must close their `EventSource` after that event and remove the old view. Existing streams normally observe publication changes on the next five-second check. In-flight or already downloaded public data cannot be recalled. A profile edit can also retire an old stream; retrying reloads the current public profile.

The service shares one five-second aggregate poll per published profile per process, sends comment heartbeats every 15 seconds, and rotates connections after 90 seconds for normal browser reconnection. It bounds active streams and buffers (128 per process, 32 per profile, 32 KiB per subscriber) and releases resources on abort, cancellation, or a slow subscriber. At most four source loads run at once per process; a timed-out load retains its slot until the underlying work settles, preventing retries from stacking abandoned queries. Saturation returns 503 with `Retry-After: 5`. Database failures stop delivery instead of serving cached data as currently public. Public streams use no-store/no-transform responses; reverse proxies must not buffer them.

Standard references: [WHATWG server-sent events](https://html.spec.whatwg.org/multipage/server-sent-events.html) and [MDN EventSource usage](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events).
