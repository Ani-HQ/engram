# Public profile layouts

Owners choose a layout in **Public profile**, above the identity fields. Native
radio cards update the local preview immediately. Saving persists the choice;
publication remains a separate action for a private profile. Saving changes to
an already published profile updates its public page.

| Layout | Reading order |
| --- | --- |
| Living studio (`studio`, the default) | Fresh running actions, seven-day pulse, optional owner highlights, broad categories |
| Field notes (`field-notes`) | Owner highlights, seven-day pulse, fresh running actions, broad categories |

Both keep the full recent activity stream and twelve-week history inside native
disclosures. Working cards show at most two fresh, safely projected running
actions. They retain the observed/agent-reported distinction and do not describe
an external process as online. The seven-day pulse uses supplied UTC daily
counts, native scrolling, and left/right/Home/End keyboard exploration.

## Owner highlights

An owner can add, reorder, or remove up to three highlights. Each has a title,
an optional note, and an optional public HTTP/HTTPS link. No private memory or
task text is filled in automatically. Decorative art comes from local shared
design-system SVG helpers; it is not a screenshot or evidence of a result.

Highlights remain independent of the activity-stream toggle. The editor states
that they become public when the profile is published. Turning off the stream
still permits broad counts, categories, and explicit owner highlights. A private
save stays private. Unpublishing uses the saved profile and preserves unsaved
edits in the form.

Title and link errors are associated with their fields and focus the first
correction. Pending saves disable the whole editor and show a labeled spinner.
Failed saves retain text, layout, and order. Obsolete callbacks cannot update a
different workspace. Layout changes and live updates retain disclosure nodes,
chart dates, keyboard focus, and scroll position.

## Shared components and storage

The gallery at `/design-system#profile-patterns` demonstrates the radio choices,
highlight cards, loading/empty/error states, focus rows, and weekly pulse. Their
visual rules live in `web/design-system.css`; page composition lives in
`web/showcase.css` and `web/app-theme.css`.

The owner endpoint, public JSON, and SSE snapshots include normalized `layout`
and `highlights`. Old profiles default to Studio and an empty highlight list.
Older clients that omit the new fields preserve their stored values. See
[the public activity contract](PUBLIC_ACTIVITY.md) for exact limits and the
additive schema migration. The existing `showcase_version` stays exactly
`2026102501`; the new `profile_presentation_version` is exactly `2026102502`.
The separate provisioner applies the new columns and presentation marker before
new runtime instances start. All predecessor readiness markers remain unchanged
so old runtime cold starts and traffic rollback remain compatible. New runtime
readiness requires both exact markers; it does not accept arbitrary later
versions. Rolling traffic back leaves saved presentation content in the database.

## Local verification, 25 October 2026

- Both public compositions were reviewed at 1280, 390, and 320 pixels. The editor
  and shared gallery were also checked at desktop and phone widths.
- Browser checks covered native radio arrows, persistent private saves and
  reloads, switching without losing content, highlight ordering, blank/unsafe
  link validation, pending control lockout, failed-save draft preservation,
  long-note disclosures, chart exploration, receipt/history disclosures, and
  accepted clipboard feedback.
- Page width remained bounded at 320 and 390 pixels. Weekly controls retain
  44-pixel minimum width and scroll within their own region. Mobile highlight
  controls retain 44-pixel targets.
- Full repository suite: **637 passed, 1 platform-specific skip, 0 failed**.
  Focused renderer/editor/state tests and browser bundles also passed.
- PostgreSQL upgrade/idempotence assertions were added to the guarded integration
  scenario but were not executed here: no local PostgreSQL or Docker runtime
  was available. Unit and fixture persistence checks passed.

The subsequent [production release](RELEASE.md#interface-system-and-public-profile-layouts--25-october-2026)
executed those assertions against real PostgreSQL in CI before migration and
activation. The database gate passed 705 checks, with all seven Cloud Build
release gates green. Production schema readiness and canonical assets were
verified after deployment.

Screenshots were saved outside the repository under the current chat's
`profile-layouts` artifact directory. Sample publication used only the local
fixture server; no production account or profile was changed.
