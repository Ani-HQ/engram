# Responsive and interaction review

## Portable agent memory — 26 October 2026

Connections now distinguish access, successful recall/save receipts, an explicit
read-and-save workflow check, and unknown automatic use. Client-declared adapter
identity and version remain labeled. A passed check never claims memory is used
on every task. The design-system evidence gallery includes this shared pattern.

The local sample-data Connections drawer and gallery were reviewed at 1280px and
320px. Checks covered measured and unmeasured connections, the workflow evidence
disclosure, and Codex setup guidance. Long setup commands remain single-line and
scroll within their own named region. No page-wide overflow or console errors
were found. Captures are in the task's local visual artifacts under
`quiet-hero-ticker/all-agents/`.

Validation: **829 tests passed, 1 Cloud Run-only skip, 0 failures, and 8873
assertions**. The Python wrapper includes 14 HTTP/framework cases. Actual
JavaScript-to-Python and Python-to-JavaScript HTTP handoffs passed with synthetic
data. Disposable PostgreSQL verification passed **828 integration checks, 78
authority/isolation checks, and 36 managed-provisioner checks**. Browser/server
bundles, the 69-file runtime asset privacy gate, 21 offline release-automation
tests, package dry runs, and `git diff --check` passed.

Native event conformance is fixture-tested, not live certification of every app
or edition. The compatibility guide records injection and task-budget limits;
unknown runtime combinations remain explicit. No global agent configuration,
production data, package publication, or deployment was changed in this pass.

## Memory workflow and context diagnostics — 26 October 2026

The Connections drawer now separates successful recall/save receipts from access
status, measured response bytes, estimated tokens, duplicate skips and budget
stops. Unknown measurements remain explicit. The shared `evidenceList` primitive
and its received, unmeasured and unavailable examples live at
`/design-system#memory-evidence`. The drawer excludes this component from its
older float-based definition-list layout.

Local sample-data review at 1280px and 320px checked the measured and unmeasured
drawers, disclosures, keyboard dismissal/focus, and the horizontally scrollable
setup command. The Copy control remains reachable and the page/dialog have no
horizontal overflow. Setup commands preserve the current workspace endpoint,
including custom instance paths, and reject credential-bearing or invalid URLs.
The new evidence rows are static and use existing shared state/type/spacing tokens.
Captures are kept with the task's visual artifacts outside the repository.

The optional Claude command-hook installer, generic lifecycle bridge and Grok
skill export are built locally. The Grok skill supports an existing MCP
connection without a CLI binding; the optional bridge must be installed on the
actual agent runtime, which can be a cloud computer. These are explicit setup
paths, not claims that installed settings or automatic use were verified in a
live account. No global agent settings or production memories were changed.

Final validation: **783 tests passed, 1 Cloud Run-only test skipped, 0 failures,
8,334 assertions**. Disposable PostgreSQL checks passed 798 integration checks,
78 authority/isolation checks and 36 provisioner checks; the cluster was stopped
and removed. Browser bundles, the 68-file runtime-asset gate, 21 offline release
automation tests and `git diff --check` passed. Jev passage-selection tests used
fake transports and offline fixtures, with no live paid provider calls. See
[Agent memory lifecycle](AGENT-MEMORY.md), [MCP context limits](MCP-CONTEXT.md),
[Private usage accounting](MEMORY-USAGE.md) and [Jev retrieval](REFLEX.md).

These changes remain local for review; they have not been pushed, published or
deployed. Earlier sections below describe their respective historical passes.

Reviewed locally on 25 October 2026 using the in-app browser and the actual app
components with sample data. This supplements the [design system](DESIGN-SYSTEM.md)
and [agent identity rules](AVATARS.md).

## Review evidence

- [Screenshot gallery](http://localhost:8107/__ui-review/gallery?width=390&group=ready):
  179 captures, filterable by width and by app, public, state, or interaction. Each image
  can be scrolled or opened at full size.
- [Repeatable scenarios](http://localhost:8107/__ui-review): loading, empty,
  failed reads, failed writes, read-only access, long content, delayed memory,
  signed-out, and authentication feedback.
- [Shared state controls](http://localhost:8107/design-system#feedback-states):
  idle, loading, success, error, disabled, reduced motion, and measured progress.
- [Actual email templates](http://localhost:8107/__mail-preview): eight
  transactional/onboarding messages, plain text, phone and desktop preview,
  plus browser preference confirmation, success, and unavailable-link states.

The scenario harness is development-only, excluded from the production image,
and scoped to a same-origin review document's referrer. It does not change
another tab's scenario or send provider, payment, or email requests. Screenshot
files live outside the repository. The gallery is available while the local
preview and its temporary capture directory are present.

## Layout and state coverage

| Surface | Browser checks |
| --- | --- |
| Activity, Memory, Connections, Attention, Sharing, Workspace, Plan & billing, Public profile | Populated layouts at 320, 390, 768, and 1280px; no page-level horizontal overflow |
| All eight app views | Pending and failed-read states at 390 and 1280px |
| Activity, Memory, Connections | Empty and long-content fixtures at 390 and 1280px |
| Memory and Attention | Read-only state at 390 and 1280px |
| Home, how it works, pricing, self-hosting, support, privacy, missing page | Full-page captures at all four widths; FAQ keyboard activation and Skip to content |
| Email, auth, and preferences | Phone email previews, plain text, all three preference states; sign-in/invitation validation, pending, rejected, and accepted-request feedback |

Final geometry checks across all 32 populated app layouts found no page
overflow. At 320 and 390px, visible buttons, tabs, and disclosures had minimum
44px targets. Memory drawer controls, linked memories, authentication links,
and the contribution chart were checked separately. The chart intentionally
scrolls horizontally inside its own region, with month and weekday labels
moving together; arrow keys, Home, and End preserve date exploration.

## Interaction findings and changes

| Before | After | Purpose |
| --- | --- | --- |
| A horizontal mobile navigation rail hid destinations; several custom controls stayed below 44px | A named navigation disclosure exposes all destinations, closes on selection/Escape, and returns focus. The shared minimum target rule outranks legacy compact styles | Reachable navigation and reliable touch targets |
| Some asynchronous actions had only a changed label or no visible pending state | Labeled spinners, busy regions, stable skeleton shimmers, and duplicate-submit guards follow actual requests | Make waiting and recovery visible |
| Copy actions and some account callbacks could outlive their owning view | Copy acknowledges an accepted clipboard write; workspace/view/auth guards reject stale callbacks | Keep feedback and downloaded data tied to the current workspace |
| Profile validation could rerender the form and lose focus | Constraints match the server; invalid fields have associated errors and focus. Failed saves keep the draft, successful private saves stay private | Clear correction and predictable keyboard recovery |
| Dense contribution cells were too small for a finger | Mobile date targets are 44×44px within a native scroll region | Usable date selection |
| Unknown agents used generic or initial-based artwork | Recognized products retain local real marks; unknown agents use locally rendered Boring Avatars Beam faces | Recognizable identity without remote asset calls |
| The horizontal memory diagram scaled its labels below readable sizes | The shared component uses stacked text steps when its available space is narrow | Readable explanation at phone and tablet widths |

Browser interactions included search with no matches and clear/reset, task
steps/receipts/options, memory Read/Source keyboard tabs, delayed-read closure,
capture validation and failed/successful saves, proposal save-failure feedback,
connection source errors and disconnect confirmation, masked-key copy and
cleanup, task reporting instructions, attention checks and results, setup
counts, personal sharing preview/selection/approval, masked share-token copy
and clearing, revoke confirmation, workspace save and invitation feedback,
export pending counts, budget validation, and private profile saving.

Sharing candidates start unchecked. Approved content remains an exact snapshot.
Creating a key or copying instructions never counts as a connected agent or a
successful setup check. Observed memory calls and agent-reported work remain
distinct. Public avatars use a constant fallback seed and never derive from a
private alias.

## Motion and verification

Pointer feedback uses the shared 120–220ms transform/opacity timings. Keyboard
actions remain immediate. Shimmer, spinner, and indeterminate progress motion
only run while work is pending; loading motion pauses offscreen or when the
document is hidden. The gallery's reduced-motion preview was checked in the
browser: pending labels remain visible and computed animation names become
`none`. Numeric setup progress comes from successful server-observed checks;
export feedback reports collected counts instead of a fabricated percentage.

The full repository suite passed **619 tests, with 1 Linux-only skip and 0
failures** on this Mac. Final feature changes also passed focused tests and
the browser build. `git diff --check` passed.

This is browser viewport testing, not physical iOS/Android certification or an
assistive-technology audit. Provider authentication, email delivery, checkout,
and real agent connectivity need their own configured integration environments.
Member-removal callback/focus cases and obsolete-request behavior are covered
by automated tests; the browser's team fixture contains only its owner and
pending invitations. No production data, account, subscription, or public
profile was changed by this review.

The subsequent [two-layout public profile pass](PROFILE-LAYOUTS.md) adds owner
layout choices and highlights, with fresh desktop/320/390 screenshots and
pending/error/keyboard checks. Its full-suite result is 637 passed, 1 skipped,
and 0 failed. Public-page samples used only the local fixture server.

## Connection archive and delete — 26 October 2026

The local Connections view now uses one Manage action per owner-visible row,
including sign-ins and retired access keys. Current and Archived are separate
filter choices. Archive revokes access; restore returns only the listing;
delete removes the inventory entry while retaining memories and recorded work.
The native detail drawer places these actions before supporting metadata.
Members retain inspection access without lifecycle controls.

Review uses the sample-data server on port 8119. The browser pass exercises a
retired key and an OAuth sign-in through archive, restore and delete, confirms
restored rows require reconnecting, and checks a failed deletion leaves the row
and confirmation intact with a retryable error. The loading scenario shows a
disabled submit and spinner during the actual pending fixture request; closing
the drawer remains immediate and restores focus. Desktop and narrow-screen
screenshots are kept outside the repository with the task's visual artifacts.

Automated validation: 685 tests passed, one Cloud Run-only test skipped, zero
failures, and 6556 assertions. Browser bundles and the runtime-asset privacy gate
passed. Real disposable PostgreSQL verification passed 739 integration checks,
78 authority/isolation checks and 36 managed-provisioner checks, including signed
OAuth revocation/reconnection and an archive-versus-refresh concurrency case.
The temporary database cluster was stopped and removed. These results cover the
local implementation; no production connection was archived or deleted.

See [Connection lifecycle](CONNECTION-LIFECYCLE.md) for the additive schema and
the requirements for a future production rollout and rollback.

## Minimal public activity — 26 October 2026

Public desk cards and recent receipts now show the local agent logo, broad
activity label, source status and timestamp without repeating the agent name
or a visible provenance line. Canonical product names remain on the logo's
accessible label and title; observed/reported provenance remains in each row's
accessible description and title and in the public page's source explanation.
Private activity and the public projection fields are unchanged.

The shared `statusText` primitive adds a quiet 3.2-second text sheen to fresh
running labels. Completed, failed and overdue labels stay static. Visibility
observation pauses offscreen/background motion; keyboard use, reduced motion
and forced colors keep the readable base text. A timestamp refresh expires the
sheen even without a new stream snapshot. Repeated snapshots retain the original
freshness clock, including when client and server clocks differ.

Browser review used only the port-8119 sample-data server. Living studio was
checked at 1280, 390 and 320px; Field notes was checked at desktop and 390px.
The owner preview and standalone public page both retain the minimal card,
with aligned status badges and wrapping labels at 320px. The shared gallery
includes fresh, completed and reduced-motion examples. The public page has no
horizontal overflow or console errors in this pass. Captures are stored with
the task's visual artifacts outside the repository.

Validation: 690 tests passed, one Cloud Run-only test skipped, zero failures,
and 6612 assertions. The browser entry bundles and `git diff --check` passed.
These changes remain local; no production profile or deployment was changed.

## Visible activity overview — 26 October 2026

The public profile's former weekly pulse is replaced by an always-visible card
containing all-time Actions, Agents and Active days plus the existing twelve-week
contribution chart. Both layouts place the overview where the weekly pulse was.
Recent receipts and the full per-tool breakdown retain their own disclosures;
the latter is now labeled Across the tools. Weekday labels no longer wrap.

The local sample-data public page was reviewed at 1280, 390 and 320px. Field notes
was also checked at 320px, and the owner preview was checked with both layout
choices. The chart scrolls within its own region on phones with 44px cells;
keyboard date navigation updates the caption and brings the selected date into
view. Neither totals nor the chart depend on opening a disclosure. No page-wide
horizontal overflow was found. Source tests cover live count updates, stable
chart cells/focus/scroll, layout switching, aggregate-only and empty profiles.

Focused profile, editor, design-system, stream and public-projection validation:
68 tests passed, zero failures, 693 assertions. Browser entry bundles and
`git diff --check` passed. Captures remain in the task's local visual artifacts.

## Single-line share URLs — 26 October 2026

Profile, JSON and Live API URLs now use the shared `.ds-code-scroll` primitive.
Only the complete selectable URL scrolls horizontally; the adjacent label and
Copy button stay fixed. Each URL has a named keyboard-focusable region and each
Copy button has a distinct accessible label. The design-system content-fit
gallery includes a long URL example.

Local browser checks at 1280, 390 and 320px confirm single-line values, contained
horizontal scrolling, visible focus outlines and reachable 44px mobile Copy
buttons without page-wide overflow. Arrow keys scroll the focused URL and the
existing Copy action reports success. Browser bundles and `git diff --check`
pass. These are local sample-data changes only.

## Profile photos — 26 October 2026

The owner editor now stages JPG, PNG or WebP uploads up to 5 MB, with a local
square preview, Change photo and Remove photo actions. Saving persists the
prepared 256 × 256 PNG with the profile form. Both public layouts and the owner
preview use the shared memory-bloom avatar when no image is present or an image
cannot load. The design-system gallery includes fallback, uploaded, loading and
error examples.

The local sample-data browser pass covered the editor and public page at 1280px
and 320px. Checks included a valid native-picker upload, preview, save, reload,
publication-gated image delivery, removal, pending controls, and failed-save
draft retention. Removal persisted and refreshing the public page restored the
fallback avatar. Field notes was also checked at desktop width. Private saves
stayed private. No console errors or page-wide overflow were found at either
width. Captures remain with the task's local visual artifacts outside the
repository.

The server validates chunk names and CRCs, bounds PNG dimensions and inflated
scanlines, discards source metadata, and rebuilds the image before encoding its
stored PNG. Regression tests cover high-bit chunk names and duplicate
transparency chunks. Public JSON/SSE expose a versioned image URL rather than
photo bytes. Public image reads check the current publication before and after
loading bytes; replacement, removal, unpublishing and address changes retire
the prior URL. Automated client tests cover malformed and oversized selections
preserving the current photo, stale conversion cancellation, workspace changes,
and pending/error draft preservation. Invalid native-picker selections were
not exercised manually in the browser.
An unchanged photo is omitted from profile saves, preserving concurrent
photo changes made in another tab.

Validation: **713 tests passed, 1 platform-specific skip, 0 failures, and 6923
assertions**. The final unchanged-photo omission guard was subsequently checked
in the focused profile/photo-editor/design-system suite: **37 tests passed,
465 assertions**. The 40-module browser bundle and `git diff --check` passed.
Disposable PostgreSQL verification passed **757 integration checks, 78
authority/isolation checks, and 36 managed-provisioner checks**. These results
cover local changes only; no production profile or deployment was changed.

## Managed onboarding and connection repair — 26 October 2026

New and existing users share a guided runtime setup command in onboarding,
connection details, and the new-key dialog. Supported installers manage their
own Engram files. Custom-client configuration remains an advanced disclosure.
Grok Bot uses its provider's private-skill creation, review, and selection controls,
with no claimed cloud hook installation. Existing agent-managed Codex sign-in
is preserved; its managed-skill fallback is model-chosen and does not provide a
hard cumulative task budget. Access, local setup, received calls, and automatic
use remain separate claims.

The root browser pass checked the local sample app at 1280px and 320px: completed
workspace setup still exposes the agent selector; keyboard selection, command
copy feedback, Grok skill prompt copying and review disclosure work. The empty
personal workspace starts at zero of three checks and shows the Codex guide.
The simulated connection-read failure retains its error, retry action, and usable
setup guide. At 320px, the 305px content region fits without page-wide overflow.
Captures are in the task's `managed-onboarding` visual artifacts:
`desktop-claude.png`, `mobile-claude.png`, `mobile-grok.png`,
`desktop-new-user.png`, `mobile-new-codex.png`, and `mobile-error.png`.

Focused onboarding, memory-use, connection, workspace-name, and runtime-contract
checks passed: **33 tests, 284 assertions, zero failures**. The browser entry
bundle and `git diff --check` passed. Browser checks used local fixture data;
they do not certify installation or automatic use in every external runtime.

The root also created and reviewed the private Engram skill in the current
macOS Grok Bot app. Its account-library path is Connect apps → Your plugins →
Private skills, with name, description, and instructions fields; no Bot-specific
enable control was present. The current client did not expose a private-skill
picker with `/`; `@Engram` offered the existing connected plugin rather than the
private skill. Private-skill picker selection remains unverified. The guide
therefore asks the user to request the skill by name, with an optional picker
only where available. The Bot reported successful identity and focused-recall
calls; no dummy memory writes were used. Skill availability and those calls do
not verify automatic use across sessions.
