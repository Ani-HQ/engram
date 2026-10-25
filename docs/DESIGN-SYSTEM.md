# Engram design system

This is the authority for frontend visual and interaction decisions. It supersedes the previous monochrome direction; the canonical pulse logo remains unchanged. Read this document and inspect the local `/design-system` gallery before changing an app view, public page, graphic, interaction, or loading state. The repository [frontend contract](../AGENTS.md) requires every future frontend change to consume or extend this system.

The direction is a playful technical studio: warm paper, dark ink, expressive editorial moments, orbital memory diagrams, and small sticker labels. Reading, forms, billing, consent, and errors stay precise. Decorative examples must never look like evidence that an agent connected, saved memory, or completed work.

## Files and adoption

- `web/design-system.css`: semantic tokens, native primitives, reusable components, motion, accessibility, and the isolated gallery layout.
- `web/design-system.js`: safe DOM helpers `memoryOrbit`, `memoryStream`, `statusBadge`, and `sticker`. They parse no HTML, fetch nothing, and default to static artwork. Motion requires an explicit opt-in.
- `web/design-system.html` and `web/design-system-gallery.js`: interactive review examples. `/design-system.html` works as a static path; the local server also maps `/design-system`.
- Surface styles own composition: `app-theme.css` for the app and `marketing.css` for public pages. They may arrange and size components; they must not create parallel button, badge, field, or motion systems.

Use `<html data-design-system="signal">`. Load `/design-system.css` first, then legacy styles if needed, then the owning surface stylesheet. The document marker enables a higher-priority visual bridge over legacy generic body/control/type rules. The bridge deliberately leaves record rows, card grids, and control layout to the owning surface. Scoped compositions such as `.workspace .activity-card` can override layout and surface-specific presentation with DS tokens. Do not copy the shared primitive declarations into a surface stylesheet.

Legacy aliases `--muted`, `--line`, `--soft`, `--radius-control`, `--radius-card`, `--radius-panel`, `--ease-out`, and `--font-mono` resolve to DS tokens. The marked root restores aliases after older `:root` declarations. No new frontend code should introduce an unprefixed token.

## Tokens

| Role | Token | Value / use |
| --- | --- | --- |
| Canvas | `--ds-paper` | `#f6f4eb` |
| Primary text | `--ds-ink` | `#202119` |
| Raised surface | `--ds-surface` | `#fffdf6` |
| Recessed surface | `--ds-surface-soft` | `#eeeee3` |
| Secondary text | `--ds-muted` | `#64675a` |
| Decorative separators | `--ds-line`, `--ds-line-strong` | `#d4d4c5`, `#a7aa96` |
| Input boundaries | `--ds-input-border` | `#8b8e7c`; use this instead of decorative line tokens for a standalone input boundary |
| Accent fills | `--ds-lime`, `--ds-lilac`, `--ds-apricot` | `#d8ef65`, `#c8b9f4`, `#f4bf92`; ink text on these fills |
| Semantic states | `--ds-success`, `--ds-warning`, `--ds-danger`, `--ds-info` | Paired with the matching `-bg` token and a visible label |
| Type | `--ds-font-sans`, `--ds-font-mono`, `--ds-font-editorial` | Local Inter; system monospace; Georgia |
| Text sizes | `--ds-text-xs/sm/base/lg/xl/2xl/display` | `.6875/.8125/.9375/1.125/1.5/2.25rem`, then `clamp(2.75rem,7vw,6rem)` |
| Mobile control text | `--ds-text-input` | `1rem` (16px with the default root size); minimum for text inputs, selects, and textareas at widths ≤600px |
| Spacing | `--ds-space-1/2/3/4/5/6/8/10/12/16/20/24` | `4/8/12/16/20/24/32/40/48/64/80/96px` |
| Heading rhythm | `--ds-gap-label-title`, `--ds-gap-title-body`, `--ds-gap-heading-actions` | `20px`, `20px`, `24px`; hero groups may choose the next spacing step |
| Corners | `--ds-radius-control/card/panel/pill` | `10/20/28/999px` |
| Shadows | `--ds-shadow-press/card/sticker/dialog` | Small physical lift, gentle card elevation, offset sticker, focused overlay |
| Motion | `--ds-duration-fast/base/slow` | `120/180/220ms` |
| Illustration entrance | `--ds-duration-illustration` | `500ms`; one finite, occasional explanatory SVG entrance |
| Easing | `--ds-ease-out`, `--ds-ease-in-out` | Responsive entry/feedback; on-screen movement |
| Busy indicator | `--ds-spinner-size/stroke/duration` | `16px/1.6px/720ms`; actual loading feedback only |

Ink on paper has approximately 14.7:1 contrast; muted text on paper is approximately 5.25:1. The input-border token is approximately 3.05:1 against paper. Accent fills are backgrounds, not small text colors. Never use lime or lilac text against paper. Borders that merely group content may use decorative line tokens; an interactive boundary needs the stronger control token or another clear visual affordance.

Tinted cards remap their local `--ds-muted` to ink so secondary copy remains readable against lilac/apricot/lime. Ink cards remap it to a light paper tone. Use the semantic muted token inside a component rather than hardcoded gray; it follows the surface.

At widths of 600px and below, native text inputs, selects, and textareas use `--ds-text-input` (1rem, normally 16px). This avoids iOS focus zoom caused by smaller control text while respecting the user's root font preference. The shared selector outranks legacy compact form styles without `!important`; surface styles may stack or resize controls but must not shrink their text below this minimum. Checkbox and radio controls are excluded. The gallery forms demonstrate the same rule automatically.

## Shared primitives

| Pattern | API | Requirements |
| --- | --- | --- |
| Button / link action | Native `button`, `.button`, `.button-link`, or `.ds-button` | 44px default target; visible action label; use a button for a mutation and an anchor for navigation |
| Primary button | `.primary` or `.ds-button[data-variant="primary"]` | Ink fill; one main action per moment |
| Accent action | `.ds-button[data-variant="lime"]` | Ink text on lime; use sparingly |
| Secondary / quiet / destructive | Default outlined; `[data-variant="text"]` or `.text`; `[data-variant="danger"]` | Destructive labels must name the action; no color-only confirmation |
| Size | `.small`, `.large` | 36px and 52px; small increases to 44px for coarse pointers; larger page-specific CTA layout can consume the same component |
| Icon action | `.ds-icon-button` | 44×44px; accessible name required |
| Product logo | `img.ds-product-logo`, optional `data-size="28"` | 24px default or 28px; `object-fit: contain`, local source, no distortion or recoloring |
| Logo backplate | `.ds-product-logo-frame` | Optional 44px neutral surface; keep adjacent visible product name |
| Fields | `.ds-field` or `.field` wrapping native controls | Visible label, associated hint/error, correct autocomplete, retain drafts after failure |
| Invalid field | `aria-invalid="true"` + `.ds-field-error` | Link error text with `aria-describedby`; explain the correction |
| Card | `.ds-card`, optional `data-tone="lime/lilac/apricot/ink"` | Layout inside the card belongs to the surface; a card is not automatically clickable |
| Badge | `.ds-badge[data-tone]` or `statusBadge(text,{tone})` | Tone: neutral, lime, lilac, apricot, success, warning, danger, info; visible text required |
| Sticker | `.ds-sticker`, optional `.ds-sticker--left/right`, or `sticker(text,{tone,tilt})` | `tilt`: left, right, or none; fixed decorative tilt only; never rotate a field or paragraph |
| Eyebrow / editorial accent | `.ds-eyebrow`, `.ds-editorial` | Mono eyebrow; serif italic for a few expressive words, never operational instructions |
| Heading group | `.ds-heading-group` | Badge/eyebrow → title → description → actions; shared semantic gaps preserve breathing room |
| Heading label row | `.ds-heading-label` inside a heading group | A badge/eyebrow plus an optional secondary action, such as Back; the row gets the same gap before the title |
| Busy | `.ds-spinner`; `.ds-skeleton` inside `[aria-busy="true"]` | Spinner is decorative beside a truthful text label; skeleton is static unless an actual request is in progress |
| Dialog | `.ds-dialog` on native `dialog` | Title via `aria-labelledby`, native focus management, Escape support, return focus to opener |
| Feedback | `.ds-notice[data-tone]`, `.ds-toast` | Label state; errors should remain until a user can act; avoid disappearing essential instructions |

### Content fit and keyboard navigation

Buttons, badges, and stickers stay within the available width and wrap long labels and unbroken identifiers. Badge icons do not shrink. Surfaces must also provide shrinkable text columns (`minmax(0, 1fr)` or `min-width: 0`) and reserve the actual width of a status instead of a fixed estimate. At narrow widths, move supporting status/time metadata into normal document flow and keep the visible status label. Do not hide overflow to conceal a clipped control or place status over a title.

`.ds-icon-button` and the legacy `.icon-button` alias share a 44×44px target, including inside compact toolbars. Use an accessible name. `.ds-skip-link` on a normal link exposes a keyboard skip action when focused; point it at a main region with `tabindex="-1"`. Hash-routed apps must handle that local focus action without changing the selected view. Focus on dark navigation uses a paper outline. Dialogs contain overscroll so reaching a drawer's end does not scroll the page behind it. The gallery's content-fit examples exercise constrained badges, long actions, enabled/disabled icon actions, and the skip link.

Search/filter results use the shared `.ds-results` region for every state, with no extra bottom margin on immediately preceding filter controls. An empty filtered search should say there are no matches and offer a clear/reset action; it must not imply the whole workspace has no content. Pending checks show their current busy state without a simultaneous invitation to start the same check.

Use the exact pulse asset `/brand/engram-mark.svg` and its existing variants. Do not redraw, recolor, or replace the canonical mark. The SVG motif is supporting illustration, not a second logo.

### Product identification

`resourceChip(label, { visual, trailing, onClick, title, actionLabel, disabled })` renders the shared `.ds-resource-chip`. `visual` and optional `trailing` are already-created local DOM nodes (for example `visualIcon(providerVisual('github'))`); label text is never parsed as markup. A callback creates a native button; without one it is a static span. It has a pill boundary, a nonshrinking 16px mark, and an ellipsized label with a full title. Action chips use a 36px desktop target and 44px for coarse pointers. Keep the resource's existing open/copy semantics and supply a descriptive action label. The gallery includes real local marks, redacted labels, a long name, and a disabled action.

Resource identity and tool identity are separate display hints. Resolve a provider from a recognized resource host/scheme or an explicit tool namespace; do not label a local path as GitHub just because it is code. Unknown repositories use the Git/repository treatment. Public chips only show an allowlisted provider and resource type. Repository owners/names, document titles, URLs, private source labels, and arbitrary tool names do not belong in a public chip. Product marks never establish resource visibility or prove a successful operation.

Use the actual locally vendored mark, not a generic icon, initial, invented glyph, remote image URL, or lookalike. `.ds-product-logo` presents the source at 24×24px; `data-size="28"` selects 28×28px. `object-fit: contain` preserves the original drawing proportions within that box. Do not add filters, recolor the source, or stretch it. A neutral `.ds-product-logo-frame` is optional; do not color the backplate to manufacture a status.

```html
<span class="ds-product-logo-frame">
  <img class="ds-product-logo" src="/vendor/simple-icons/claude.svg"
       width="24" height="24" alt="">
</span>
<span>Claude</span>
```

Use `alt=""` when the adjacent visible name already identifies the product; a standalone identifying image needs an accurate accessible name. The gallery shows Claude and Cursor from `/vendor/simple-icons/`, plus Windsurf, Codex, OpenAI, and Devin from `/vendor/brands/`. Preserve the source provenance and license notices in those directories when adding a mark. Product names and logos identify their respective owners; showing them does not imply partnership or endorsement. A logo is a display hint, never proof of an authenticated identity, successful connection, observed tool call, or active agent. Real connection state must come from the application's evidence and permission checks.

### Heading rhythm

Wrap a label/badge, heading, and optional description in `.ds-heading-group`. The label-to-title and title-to-body gaps are 20px; actions begin 24px after the preceding content. Hero groups can set `--ds-gap-label-title` and `--ds-gap-title-body` to `--ds-space-6` (24px). Do not close these gaps for a compact look. Cards and dialogs also apply the shared adjacent label/heading/body rhythm when no wrapper is needed. The gallery uses this pattern on every section heading and the dialog so a badge never touches its title.

When the top row contains a badge plus a Back action, wrap that row in `.ds-heading-label`. It is a layout container, not an HTML `label`. It participates in the same label-to-title spacing. Keep the heading reset low-specificity with `:where(...)`; a reset must never outrank the adjacent heading/body spacing rules. Verify computed margins as well as appearance, especially on narrow screens.

```html
<div class="ds-heading-group">
  <div class="ds-heading-label">
    <span class="ds-badge" data-tone="lilac">A moment of focus</span>
    <a href="/app#signin">Back to sign in</a>
  </div>
  <h2>A thought gets some room.</h2>
  <p>Plain supporting copy, with room to read it.</p>
</div>
```

```js
import { memoryOrbit, memoryStream, sticker, statusBadge } from '/design-system.js';

slot.append(memoryOrbit()); // Decorative and static by default.
darkSlot.append(memoryOrbit({ compact: true, className: 'ds-orbit--on-ink' }));
hero.append(memoryOrbit({ motion: 'intro' })); // Initial hero mount only; never polling.
hero.append(memoryOrbit({ agents: true })); // Named agent ecosystem, using bundled marks.
diagram.append(memoryStream({ label: 'Illustration of saving and recalling shared context.' }));
caption.append(sticker('Good context sticks.', { tone: 'lime', tilt: 'right' }));
status.append(statusBadge('Read only', { tone: 'neutral' }));
```

An explicit `label` makes a motif an accessible image; the default is `aria-hidden="true"`. Put essential product explanation in normal HTML as well. Use `.ds-orbit--on-ink` or `.ds-memory-stream--on-ink` for paper orbital lines on an ink backdrop; light node cards keep ink text. `motion: 'intro'` adds `.ds-motif-intro`: rings make a subtle 500ms transform/opacity entrance and node groups enter over 220ms with short stagger delays. It finishes once and stays still. The app may opt in on the first auth-story mount, tracking that mount outside the renderer; every onboarding/polling rerender must remain static. The gallery exposes a deliberate replay. Reduced motion and keyboard input skip the movement. Custom page illustrations may add a composition but must consume DS colors and stroke/type decisions. Reusable variants belong here and in the gallery.

`memoryOrbit({agents:true})` adds Claude, OpenClaw, Grok Bot, Muse and Instinct around the shared-memory core. Each pod uses a fixed local image reference, preserves the original mark's proportions and color, and keeps the product name visible. This option identifies examples of the agent ecosystem; it must not imply a live connection, tested setup, endorsement, or broader integration support. The homepage and gallery consume this same variant. Keep all marks bundled and record their actual source in `web/vendor/brands/SOURCE.md`; never accept an arbitrary image URL or redraw a third-party mark. The generic orbit remains the default for app decoration.

### Card captions

Use `.ds-card-caption` for supporting text immediately below a card or card group. It adds 16px above the note and aligns its text with the card content, including the 1px card border. Its default inset follows the standard card's 24px padding. When a surface changes card padding, set `--ds-card-content-padding` on their shared parent and consume that value in the cards; the caption follows automatically. Marketing examples use 32px on desktop and 24px at widths up to 850px. The gallery includes this pattern. The marked-root selector preserves the gap over surface paragraph resets.

## Semantic states and truthful feedback

### Finite workspace benefits and results spacing

Use `.ds-benefit.ds-card` for a finite access benefit, with a shared badge, `.ds-benefit-count`, `.ds-benefit-description`, and a normal link action. It wraps into one column below 600px. `web/access-view.js` renders the actual component in the gallery and workspace. Show a friend countdown only for server-identified invite grants with a valid finite expiry; never infer a 60-day term from a generic plan name or give legacy no-expiry grants a made-up end date. Keep the exact UTC expiry in a semantic `time` element alongside the remaining whole-day periods. Anchor the display to server time, update at day boundaries or a quiet hourly refresh, and refresh on returning to the page; do not use a ticking timer, progress animation, or repeated live announcement.

Describe unlimited knowledge transfers only when that current server entitlement is active. Keep Jev's permission and usage costs explicitly separate. Expired/revoked states retain a contact-for-extension link, and acknowledge any other current plan without claiming core access has necessarily ended. Failure to refresh preserves the last known expiry and offers a retry; it never grants or extends access. The fixed extension destination is the operator's supplied X profile.

Use `.ds-results` on a results region after search/filter controls. Its space-6 top padding provides the same breathing room before empty, loading, error, and populated content. Keep this on the region, rather than attaching a gap only to an empty-state card.

### Optional processing and usage consent

Use `.ds-option` on a label containing a native checkbox and a span with a `strong` label plus optional `small` explanation. It provides the shared card, spacing, text, control size, and disabled cursor; keep native checked, focus, required, and disabled behavior. The gallery’s Jev example uses the actual `web/jev-settings.js` component with an in-page stub and makes no network requests.

Keep provider configuration, workspace permission, billing eligibility, and current availability distinct. When billing is disabled or rates are absent, describe Jev as unavailable on the installation; do not infer that the operator has not selected a pricing policy. A server key does not grant permission. Jev has separate consent from Voyage embeddings and OpenAI briefs. New opt-ins stay unchecked; a paid enabled save requires a fresh unchecked acknowledgment of the exact customer input/output rates returned by the API, including markup, and the server’s current rate version. Never round tiny rates to cents, multiply markup in the browser, preselect a paid budget, or collect a provider key in a browser field.

Show settled spend separately from pending calls and unknown usage. Explain that a monthly soft budget stops new calls after settled spend reaches it, while calls in flight may take it over. Unknown usage is excluded from customer billing. Operator-funded workspaces explicitly show no customer usage charge. Self-hosted Jev uses server-configured BYO keys and direct provider billing; do not imply an Engram monetary cap or provider-spend meter. Keep off available when configuration, rates, or eligibility become unavailable, preserve failed drafts, disable duplicate submissions, and discard callbacks after a workspace or session changes.

- **Loading:** show a short present-tense label, keep the content area stable, disable duplicate submission, and preserve focus. Do not invent stages, percentages, or minimum wait times. The gallery's delays are explicitly labeled local component demonstrations.
- **Empty:** explain what belongs here and give one next action; do not populate a real view with invented receipts or customer proof.
- **Error:** keep entered values and identify a useful recovery action. Use `role="alert"` for an error that needs immediate attention. Never expose credentials or raw infrastructure/provider failures.
- **Success:** acknowledge the actual accepted result. Use `role="status"`; do not turn a successful key mint or copied prompt into successful agent onboarding.
- **Disabled:** communicate why an action is unavailable when it is not obvious. `aria-disabled` alone does not prevent activation; the owning interaction must enforce it.
- **Reported / observed:** an agent's report, a known connection, and a successful observed tool call remain distinct. Color and motion must not blur those meanings.
- **Focus:** the ink outline is always visible. Native keyboard actions remain immediate. Preserve focus, caret, drafts, and expanded content across polling and progress updates.

## Motion

The [Emil design-engineering skill](https://emilkowal.ski/skill) informs this system. Motion has a job: input feedback, a rare overlay transition, or an explanation that someone deliberately requests. Everyday navigation and repeated updates should feel still.

Use 120ms for a small press, 180ms for an overlay/feedback transition, 220ms for an occasional response. The rare SVG illustration entrance may take 500ms and must finish once. Animate transform and opacity. Do not animate layout dimensions, use `transition: all`, add ambient orbit loops, or replay card entrances when data refreshes. Hover movement is restricted to fine pointers; keyboard input skips motion through `data-input="keyboard"` and `:focus-visible`. Keep app code's input-mode tracking.

Spinners and subtle skeleton opacity are permitted only while actual work is pending. They are not decoration and do not represent numeric progress. Reduced motion stops those animations, removes transform feedback and sticker tilt, and retains labeled states. Native dialogs and controls remain usable without animation support. Forced colors preserve visible boundaries.

## Static social exports

`bun deploy/render-social-card.ts` reads the canonical `--ds-paper/ink/lime/lilac/apricot` values from this stylesheet and regenerates `web/brand/engram-social.svg` and `web/brand/engram-social.png` at 1200×630. When the palette or export composition changes, run the renderer and inspect both files at their final size. Keep the export aligned with the canonical pulse identity and shared typography; a generated image is not a separate source of brand decisions. The PNG is the share-preview artifact and the SVG remains an editable local source. No export command publishes or deploys it.

## Email and email-preference surfaces

`gateway/src/mail-templates.ts` is the shared email renderer. `renderEmail({template,...})` returns `subject`, `preheader`, `text`, and `html` for login, signup verification, team invitations, agent authorization, welcome, first-agent setup, first memory, and a second-agent tip. The renderer resolves the canonical palette and spacing to literal inline values from this stylesheet; email clients do not need CSS variables, scripts, external stylesheets, fonts, or images.

Email tokens are `--ds-email-width` (600px), `--ds-email-padding` (space-6), `--ds-email-heading-size` (text-2xl), `--ds-email-body-size` (text-input), and `--ds-email-font-sans/editorial/mono`. Font stacks use locally installed Inter/Georgia when available and common email-safe fallbacks. Emails use a text wordmark rather than redrawing the pulse or loading an image. Their table layout, 20px label/title/body rhythm, one main CTA, text alternative, and preheader are part of this shared pattern. All dynamic text and links are escaped; action and unsubscribe URLs must be absolute HTTP(S) URLs without credentials. Do not add tracking pixels or make the design depend on downloaded assets.

Transactional links are private and one-use. Copy follows the actual flow: login/open-signup links last 24 hours, signup-invite verification ends at 24 hours or invitation expiry if sooner, team invitations last seven days, and an OAuth sign-in request has its own shorter lifetime (currently 15 minutes). Onboarding tips carry one clear next action and an opt-out link; they must not imply a connection or saved memory already exists. Timings, eligibility, retries, enrollment, and consent belong to the mail-series worker, not the renderer. Mail transport acceptance is not proof of inbox delivery.

The local email gallery renders the actual HTML at desktop and narrow widths and shows the text part. It uses fixed inert sample links, makes no mail-provider request, and is excluded from production delivery. Add or change a template in the renderer and this pattern before introducing separate email markup at a callsite.

Browser opt-out confirmation, completed, and unavailable states use `.ds-mail-preference` on the page, `.ds-mail-preference-shell` around the content, `.ds-mail-preference-header` for the canonical brand link, and `.ds-card.ds-mail-preference-card` for the message. Inside, reuse `.ds-heading-group` and badges; use `.ds-mail-preference-actions` for the form/action row, `.ds-mail-preference-note` for the recessed explanation, `.ds-mail-preference-hint` for small follow-up copy, and `.ds-mail-preference-footer` with a `nav` for support/back-to-app links. Header and footer wrap with space-4 gaps; explanations have space-5 breathing room. Cards use space-8 padding on desktop and space-6 at widths up to 600px. Local review banners use `.ds-mail-preference-preview` inside the shell above the header. These are browser surfaces and may load the local design-system stylesheet and pulse asset; the actual emails remain self-contained. State text must distinguish stopping optional tips from essential account messages and must never claim an invalid/expired request changed preferences.

## Contributing and review

1. Read this document, inspect `/design-system` locally, and check whether the pattern already exists.
2. Reuse a primitive and semantic token. If it is a new reusable visual/state decision, add it to `design-system.css` or the safe DOM module first; do not implement it separately in a feature stylesheet.
3. Add the actual pattern to the gallery, including relevant loading, empty, error, success, disabled, keyboard-focus, and narrow-screen variants. Update this API document in the same change.
4. Keep operational copy plain and product claims tied to source. Public copy follows `.agents/product-marketing-context.md`; never invent proof, guarantees, pricing, or telemetry.
5. Check desktop and a narrow viewport, keyboard navigation, reduced motion, readable contrast, and local-only assets. Keep secrets out of mockups, URLs, screenshots, and sample data.
6. Review surface composition with its owner. All frontend changes must consume or extend this system before user review. Publishing or deployment is a separate user-authorized step; the current redesign is local for review.

Heading groups explicitly preserve the shared h2/h3 type scale above legacy generic heading rules; the supporting-caption gallery demonstrates the card heading.

## Reviewed sharing composition

The Sharing view composes existing cards, heading groups, fields, option rows,
notices and buttons. Keep the natural-language instruction, recipient choice and
exact excerpt approval as separate steps with visible explanatory copy. Candidates
start unchecked. Label semantic suggestions and text fallback distinctly; neither
is an access grant. Excerpt edits can shorten source text, with errors beside the
field and a fresh-preview action for changed or expired sources. Pin requests to
the workspace and discard stale completions on navigation. Mask an isolated agent
credential, clear it on navigation, and offer explicit copy/replace actions. Use
status feedback for preview, approval, clipboard, replacement and revocation;
keep all actions keyboard immediate and stack controls at narrow widths.
