# Responsive and interaction review

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
