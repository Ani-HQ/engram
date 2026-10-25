# Engram design system

This is the authority for frontend visual and interaction decisions. It establishes the graphite-and-mint direction; the canonical pulse logo remains unchanged. Read this document and inspect the local `/design-system` gallery before changing an app view, public page, graphic, interaction, or loading state. The repository [frontend contract](../AGENTS.md) requires every future frontend change to consume or extend this system.

The direction takes inspiration from Supabase’s precise technical interfaces, with Engram’s own graphite palette, softer mint, and canonical pulse identity. Neutral surface layers, thin borders, compact Inter typography, consistent insets, and restrained feedback make complex context easier to scan. Marketing can use a larger type scale and more open composition; the component grammar stays the same. Technical diagrams remain explanatory. They must never look like evidence that an agent connected, saved memory, or completed work.

## Files and adoption

- `web/design-system.css`: semantic tokens, native primitives, reusable components, motion, accessibility, and the isolated gallery layout.
- `web/design-system.js`: safe DOM helpers `memoryOrbit`, `memoryStream`, `statusBadge`, `resourceChip`, `progressBar`, `setProgress`, `loadingState`, `observeLoadingMotion`, `highlightArt`, and `profileLayoutPreview` (plus the legacy `sticker` alias). They parse no HTML or stylesheet and fetch nothing. Decorative artwork defaults to static; its motion requires an explicit opt-in. Labeled loading helpers move only while their owning operation is pending.
- `web/design-system.html` and `web/design-system-gallery.js`: interactive review examples. `/design-system.html` works as a static path; the local server also maps `/design-system`.
- Surface styles own composition: `app-theme.css` for the app and `marketing.css` for public pages. They may arrange and size components; they must not create parallel button, badge, field, or motion systems.

Use `<html data-design-system="signal">`. Load `/design-system.css` first, then legacy styles if needed, then the owning surface stylesheet. The document marker enables a higher-priority visual bridge over legacy generic body/control/type rules. The bridge deliberately leaves record rows, card grids, and control layout to the owning surface. Scoped compositions such as `.workspace .activity-card` can override layout and surface-specific presentation with DS tokens. Do not copy the shared primitive declarations into a surface stylesheet.

Legacy aliases `--muted`, `--line`, `--soft`, `--radius-control`, `--radius-card`, `--radius-panel`, `--ease-out`, and `--font-mono` resolve to DS tokens. The marked root restores aliases after older `:root` declarations. No new frontend code should introduce an unprefixed token.

## Tokens

| Role | Token | Value / use |
| --- | --- | --- |
| Canvas | `--ds-paper` | `#111313`; retained name for compatibility, now graphite |
| Primary text | `--ds-ink` | `#ededed`; never assume “ink” is a dark background |
| Surface | `--ds-surface` | `#181b1a` |
| Raised/recessed layer | `--ds-surface-soft` | `#202423` |
| Secondary text | `--ds-muted` | `#a1aaa6` |
| Decorative separators | `--ds-line`, `--ds-line-strong` | `#2c3230`, `#424b47` |
| Input boundaries | `--ds-input-border` | `#65716b`; standalone controls need this stronger boundary |
| Accent | `--ds-accent`, `--ds-accent-ink`, `--ds-accent-muted` | `#77d9ad`, `#10261b`, `#1b3529`; mint action fill, its dark text, and quiet tint |
| Accent hover | `--ds-accent-hover` | `#8ae4bd`; a subtle primary-control hover shift |
| Inverse | `--ds-inverse`, `--ds-inverse-ink` | `#ededed`, `#111313`; intentional light plate or export, never infer it from text tokens |
| Compatibility tones | `--ds-lime`, `--ds-lilac`, `--ds-apricot` | `#1b3529`, `#252d35`, `#332c24`; subdued legacy fills, not new accent names |
| Semantic states | `--ds-success`, `--ds-warning`, `--ds-danger`, `--ds-info` | Light state text paired with matching dark `-bg` tokens and a visible label |
| Contribution chart | `--ds-chart-0/1/2/3/4` | `#202423`, `#254333`, `#34694d`, `#4e9b73`, `#77d9ad`; zero and four activity levels, always accompanied by values/labels |
| Type | `--ds-font-sans`, `--ds-font-mono` | Local Inter; system monospace |
| Legacy expressive type | `--ds-font-editorial` | Alias to Inter. `.ds-editorial` is a mint Inter emphasis; no serif or italic treatment |
| Text sizes | `--ds-text-xs/sm/base/lg/xl/2xl/display` | `.75/.8125/.875/1.0625/1.375/2rem`, then `clamp(2.75rem,6vw,5rem)` |
| Mobile control text | `--ds-text-input` | `1rem`; minimum for text inputs, selects, and textareas at widths ≤600px |
| Spacing | `--ds-space-1/2/3/4/5/6/8/10/12/16/20/24` | `4/8/12/16/20/24/32/40/48/64/80/96px` |
| Heading rhythm | `--ds-gap-label-title`, `--ds-gap-title-body`, `--ds-gap-heading-actions` | `12px`, `12px`, `20px`; hero groups can use larger steps |
| Corners | `--ds-radius-control/card/panel/pill` | `6/8/12/999px`; pill reserved for resource chips |
| Shadows | `--ds-shadow-press/card/sticker/dialog` | Subtle inset control highlight, almost-flat card highlight, no sticker shadow, focused overlay |
| Motion | `--ds-duration-fast/base/slow` | `120/180/220ms` |
| Illustration entrance | `--ds-duration-illustration` | `220ms`; one finite, occasional explanatory SVG entrance |
| Easing | `--ds-ease-out`, `--ds-ease-in-out` | Responsive feedback; occasional on-screen movement |
| Pending motion | `--ds-shimmer-duration`, `--ds-progress-duration`, `--ds-progress-height` | `1400ms`, `1200ms`, `4px`; only while a real request is pending (or a labeled local preview) |
| Fallback avatars | `--ds-avatar-1/2/3/4/5`, `--ds-avatar-face` | Mint `#77d9ad`, sky `#9fc7e8`, sand `#dec39e`, lilac `#c3b4df`, pink `#e3b5c9`; dark features `#10261b`. Local deterministic fallback illustrations; recognized products retain their original marks |
| Visual layout preview | `--ds-choice-preview-min-height` | `132px`; a stable decorative thumbnail region inside a native radio choice |
| Highlight art | `--ds-highlight-art-ratio` | `24 / 11`; shared decorative art-slot ratio, sized by the owning composition |
| Week pulse bar | `--ds-week-bar-height` | `72px`; static comparison height, paired with exact supplied counts |
| Busy indicator | `--ds-spinner-size/stroke/duration` | `16px/1.6px/720ms`; actual loading feedback only |

Primary text on the canvas has approximately 15.92:1 contrast; muted text has 7.83:1 on canvas and 6.59:1 on the soft surface. The input boundary has approximately 3.41:1 against the control surface. Accent-ink on the mint action has approximately 9.36:1. Decorative separators can be quieter because they only group content; an interactive boundary needs the control token or another clear affordance.

The default is dark. Keep text and surface roles separate: `--ds-ink` is now light text. Use `--ds-accent` with `--ds-accent-ink` for a primary action, or the explicit inverse pair for an intentional light region. Do not place paper text on an ink background by habit. Legacy tone cards keep light text and the shared muted text token. `data-tone="ink"` now means the deep canvas layer; it is retained as an API compatibility name.

At widths of 600px and below, native text inputs, selects, and textareas use `--ds-text-input` (1rem, normally 16px). This avoids iOS focus zoom caused by smaller control text while respecting the user's root font preference. The shared marked-root selectors preserve a minimum 44px height for native text inputs and selects and outrank legacy compact form styles without `!important`; textareas retain their larger 110px minimum. Surface styles may stack or resize controls but must not shrink their targets or text below these minimums. Checkbox and radio controls are excluded. The gallery forms demonstrate the same rule automatically.

## Shared primitives

| Pattern | API | Requirements |
| --- | --- | --- |
| Button / link action | Native `button`, `.button`, `.button-link`, or `.ds-button` | 36px desktop target, 44px at mobile widths or coarse pointers; visible action label; use a button for a mutation and an anchor for navigation |
| Primary button | `.primary` or `.ds-button[data-variant="primary"]` | Mint fill with accent-ink text; one main action per moment |
| Accent action | `.ds-button[data-variant="accent"]` (`lime` is a legacy alias) | Mint text on quiet accent tint; use sparingly |
| Secondary / quiet / destructive | Default outlined; `[data-variant="text"]` or `.text`; `[data-variant="danger"]` | Destructive labels must name the action; no color-only confirmation |
| Size | `.small`, `.large` | 32px and 44px; all controls increase to 44px for coarse pointers and at widths ≤600px; larger page-specific CTA layout can consume the same component |
| Standalone touch link | `.ds-touch-target` on an anchor | Shared unstyled inline-flex target. At mobile widths/coarse pointers, it is at least 44×44px. Keep inline prose links in normal text flow |
| Icon action | `.ds-icon-button` | 44×44px; accessible name required |
| Fallback agent avatar | `.ds-agent-avatar` through `agentVisual` / `visualIcon` | Local deterministic Beam face only for unknown agents; visible name/provenance stay separate. Public callers use the constant public-safe seed. Known products keep their actual logo |
| Product logo | `img.ds-product-logo`, optional `data-size="28"` | 24px default or 28px; `object-fit: contain`, local source, no distortion or recoloring |
| Logo backplate | `.ds-product-logo-frame`, optional `data-tone="inverse"`; `.ds-logo-backplate` for an existing local-mark frame | Optional 44px light neutral backplate for unchanged source marks; keep adjacent visible product name |
| Fields | `.ds-field` or `.field` wrapping native controls | Visible label, associated hint/error, correct autocomplete, retain drafts after failure |
| Invalid field | `aria-invalid="true"` + `.ds-field-error` | Link error text with `aria-describedby`; explain the correction |
| Card | `.ds-card`, optional `data-tone="accent/lime/lilac/apricot/ink"` | Layout inside the card belongs to the surface; a card is not automatically clickable |
| Visual radio choice | `.ds-choice-group` fieldset, `.ds-choice-options`, `.ds-choice-card` label, native radio, `.ds-choice-visual`, `.ds-choice-copy/title/description` | Native grouping, checked/disabled and arrow-key behavior. Keep a visible legend and text beside the decorative thumbnail. Never publish merely by choosing a layout |
| Highlight card | `.ds-card.ds-highlight-card`, `.ds-highlight-visual/content/title/description/meta/actions` | Only deliberately public text and approved references. Static art is decorative. Keep optional links separate from native disclosure summaries |
| Highlight disclosure | Native `details.ds-highlight-disclosure` with `summary` | Keyboard immediate, readable in document flow; optional `.ds-disclosure-indicator` follows open state |
| Focus row | `.ds-focus-row`, `.ds-focus-mark/content/label/title/description/meta` | Neutral summary row. Source and reported/observed provenance stay visible; the row does not imply running or verified work |
| Seven-day pulse | `.ds-week-pulse` list, `.ds-week-day`, native `.ds-week-button`, `.ds-week-bar` and `.ds-week-bar-fill`, `.ds-week-label/count` | Supply real UTC dates and counts. Static ratio only, no invented activity. `aria-pressed` shows selected day; roving focus and arrow/Home/End handling belong to the owner |
| Badge | `.ds-badge[data-tone]` or `statusBadge(text,{tone,className})` | Tone: neutral, accent, lime, lilac, apricot, success, warning, danger, info; visible text required |
| Legacy sticker | `.ds-sticker` or `sticker(text,{tone,tilt})` | Compatibility alias with the same restrained badge treatment; tilt is no longer rendered. Use badges in new UI |
| Eyebrow / editorial accent | `.ds-eyebrow`, `.ds-editorial` | Compact mono eyebrow; mint Inter emphasis for a short phrase. Operational instructions keep neutral text |
| Heading group | `.ds-heading-group` | Badge/eyebrow → title → description → actions; shared semantic gaps preserve breathing room |
| Heading label row | `.ds-heading-label` inside a heading group | A badge/eyebrow plus an optional secondary action, such as Back; the row gets the same gap before the title |
| Busy | `loadingState({label,description,compact,lines})`; `.ds-spinner`; `.ds-skeleton` inside `[aria-busy="true"]` | Labeled pending operation. Skeleton shimmer starts only for busy content; its geometry remains stable. Use `observeLoadingMotion(root)` and dispose it when the surface unmounts |
| Progress | `progressBar({label,value,max,valueText,className})`, `setProgress(element, options)` | Omit value for unknown-duration work. Pass an actual measured count plus max for determinate work. Never invent a percentage or advance on a timer |
| Action result | `data-feedback="success/error"` on the actual button; optional `.ds-feedback-icon` | Set only after the operation result. Preserve the accessible label and visible result. The icon has one 180ms response; no loop |
| Disclosure | `.ds-disclosure-toggle`, optional `.ds-disclosure-indicator` | Native button with accurate `aria-expanded` and `aria-controls`; Enter/Space toggle, Escape closes and returns focus. Indicators turn over 120ms; keyboard/reduced motion is immediate |
| Dialog | `.ds-dialog` on native `dialog` | Title via `aria-labelledby`, native focus management, Escape support, return focus to opener |
| Panel | `.ds-panel` with `.ds-panel-header`, `.ds-panel-body`, `.ds-panel-footer` | Shared boundary, 20px inset (16px mobile), optional header/footer rules. The surface arranges content |
| Toolbar | `.ds-toolbar` | Flexible wrapping action row. Keep action meaning and accessible names visible |
| Tabs | `.ds-tabs` containing `.ds-tab` | Use native links with `aria-current="page"` for navigation; buttons with tab roles and `aria-selected` require complete arrow/Home/End keyboard handling and associated panels. Selected state uses a mint underline |
| Metric | `.ds-metric` with `.ds-metric-label`, `.ds-metric-value`, `.ds-metric-note` | Tabular value with visible meaning and provenance. No invented activity or hidden unit |
| Divider | `.ds-divider` | Decorative 1px horizontal separator; use semantic headings to establish content hierarchy |
| Status dot | `.ds-status-dot` beside visible state text | Inherits text color. Never conveys state alone |
| Feedback | `.ds-notice[data-tone]`, `.ds-toast` | Label state; errors should remain until a user can act; avoid disappearing essential instructions |

### Content fit and keyboard navigation

Buttons, badges, and stickers stay within the available width and wrap long labels and unbroken identifiers. Badge icons do not shrink. Surfaces must also provide shrinkable text columns (`minmax(0, 1fr)` or `min-width: 0`) and reserve the actual width of a status instead of a fixed estimate. At narrow widths, move supporting status/time metadata into normal document flow and keep the visible status label. Do not hide overflow to conceal a clipped control or place status over a title.

`.ds-icon-button` and the legacy `.icon-button` alias share a 44×44px target, including inside compact toolbars. At widths ≤600px or with coarse pointers, a marked-root body rule also enforces a 44×44px minimum for native buttons, tabs, summary controls, button links, and `.ds-touch-target` anchors above compact surface styles; no `!important` is needed. Use an accessible name. `.ds-skip-link` on a normal link exposes a keyboard skip action when focused; point it at a main region with `tabindex="-1"`. Hash-routed apps must handle that local focus action without changing the selected view. Focus uses a mint outline with sufficient offset on dark surfaces. Dialogs contain overscroll so reaching a drawer's end does not scroll the page behind it. The gallery's content-fit examples exercise constrained badges, long actions, enabled/disabled icon actions, an unstyled standalone touch link, and the skip link. Shared toasts use `max(space-6, env(safe-area-inset-bottom))` for bottom clearance, including the legacy `.toast` alias.

Search/filter results use the shared `.ds-results` region for every state, with no extra bottom margin on immediately preceding filter controls. An empty filtered search should say there are no matches and offer a clear/reset action; it must not imply the whole workspace has no content. Pending checks show their current busy state without a simultaneous invitation to start the same check.

Use the exact pulse asset `/brand/engram-mark.svg` and its existing variants. Do not redraw, recolor, or replace the canonical mark. The technical diagram is supporting illustration, not a second logo.

### Product identification

`resourceChip(label, { visual, trailing, onClick, title, actionLabel, disabled })` renders the shared `.ds-resource-chip`. `visual` and optional `trailing` are already-created local DOM nodes (for example `visualIcon(providerVisual('github'))`); label text is never parsed as markup. A callback creates a native button; without one it is a static span. It has a pill boundary, a nonshrinking 16px mark, and an ellipsized label with a full title. Action chips use a 36px desktop target and 44px at widths ≤600px or for coarse pointers. Image marks receive a small neutral inverse backplate; inline monochrome marks inherit the readable foreground. Keep the resource's existing open/copy semantics and supply a descriptive action label. The gallery includes real local marks, redacted labels, a long name, and a disabled action.

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

Unknown agents use the shared local Beam fallback from `web/agent-avatar.js`, rendered by the same `agentVisual`/`visualIcon` path as product marks. `.ds-agent-avatar` owns its circular display and the avatar palette above owns its colors. A private cosmetic seed is not anonymization or proof of identity. Public callers must request `publicSafe: true` and pass only an allowlisted product hint so unknown fallbacks use one constant seed and cannot encode private names. The gallery shows three illustrative private variations and the public fallback. Read [Agent identity visuals](AVATARS.md) for provenance, source licensing, and callsite rules.

### Visual choices and public-profile patterns

A visual choice is still a native radio group. Use a `fieldset.ds-choice-group` with a visible legend, a `.ds-choice-options` container, and one `label.ds-choice-card` per option. Each label contains its native radio, an `aria-hidden="true"` `.ds-choice-visual`, and `.ds-choice-copy` with a `.ds-choice-title` and `.ds-choice-description`. Checked state adds a mint boundary without changing geometry. Keyboard focus is immediate and outlines the full label; disabling the fieldset or an individual radio retains the visible selection. Use existing hints/errors and `aria-describedby` to explain unavailable choices or save failures. A layout selection changes presentation only; publication permission and save acceptance remain separate.

`profileLayoutPreview('studio' | 'field-notes')` creates the safe local structural SVG used by the Living studio and Field notes option cards. The thumbnails contain decorative blocks and geometry, with no private profile names, sample counts, activity claims, external assets, or parsed markup. Unknown values use the studio preview. The owner renders the normal DOM choice text; do not bake readable text into a scaled thumbnail. The options grid wraps automatically based on available room.

`highlightArt({ variant: 'orbit' | 'grid' | 'layers', label? })` returns static geometric SVG art using the shared palette. Unknown variants use orbit. It is hidden from accessibility by default; a deliberate label makes it an explanatory image. It has no motion, timestamps, progress, or status. Render it inside `.ds-highlight-visual` on `.ds-card.ds-highlight-card`, then use `.ds-highlight-content` for title, description, visible metadata, native disclosure, and optional public link actions. Neither art nor styling establishes an observed result. Only the owning public projection may provide deliberately approved highlight content or allowlisted resource references. Keep the link separate from the disclosure summary and preserve native expand/collapse behavior.

A `.ds-focus-row` uses a nonshrinking `.ds-focus-mark` and shrinkable `.ds-focus-content`. The label, title, description, and metadata classes share the same type and inset rules as panels. Use actual product marks with the existing inverse backplate where needed. Display evidence and state from the source; a generic summary row cannot establish that an agent is connected, working, or verified.

A `.ds-week-pulse` is a native ordered list with explicit `role="list"` (preserving Safari semantics with hidden markers), containing seven `.ds-week-day` items, each containing a `.ds-week-button`. Its `.ds-week-bar` contains a decorative `.ds-week-bar-fill`; set `--ds-pulse-ratio` through CSSOM to a finite clamped 0–1 ratio derived from the supplied counts. The fill uses a static transform with no animation. Show `.ds-week-label` and `.ds-week-count` text, and give each button its full UTC date and exact count in the accessible label. Use one roving tab stop, `aria-pressed` for the selected day, and immediate arrow/Home/End selection. Scroll the selected button into view at narrow widths; keep the 44px targets rather than squeezing or overlapping seven controls. Zero counts stay visibly zero. Loading, empty, and error states use the existing labeled pending, notice, and recovery patterns instead of invented chart data.

The `#profile-patterns` gallery includes both layout choices, a disabled-choice control, an expandable highlight and optional reference, ready/loading/empty/error examples, a focus row, and seven labeled fixed sample counts with keyboard navigation. These samples make no workspace changes and do not represent real activity.

### Heading rhythm

Wrap a label/badge, heading, and optional description in `.ds-heading-group`. The label-to-title and title-to-body gaps are 12px; actions begin 20px after the preceding content. Hero groups may choose 20px or 24px shared spacing steps. Apply these values consistently instead of adding local ad hoc spacing. Cards and dialogs also apply the shared adjacent label/heading/body rhythm when no wrapper is needed. The gallery uses this pattern on every section heading and the dialog so a badge never touches its title.

When the top row contains a badge plus a Back action, wrap that row in `.ds-heading-label`. It is a layout container, not an HTML `label`. It participates in the same label-to-title spacing. Keep the heading reset low-specificity with `:where(...)`; a reset must never outrank the adjacent heading/body spacing rules. Verify computed margins as well as appearance, especially on narrow screens.

```html
<div class="ds-heading-group">
  <div class="ds-heading-label">
    <span class="ds-badge" data-tone="accent">Account access</span>
    <a href="/app#signin">Back to sign in</a>
  </div>
  <h2>Continue to your workspace.</h2>
  <p>Clear supporting instructions, with room to read them.</p>
</div>
```

```js
import { memoryOrbit, memoryStream, statusBadge } from '/design-system.js';

slot.append(memoryOrbit()); // Decorative and static by default.
darkSlot.append(memoryOrbit({ compact: true, className: 'ds-orbit--on-ink' }));
hero.append(memoryOrbit({ motion: 'intro' })); // Initial hero mount only; never polling.
hero.append(memoryOrbit({ agents: true })); // Named agent ecosystem, using bundled marks.
diagram.append(memoryStream({ label: 'Illustration of saving and recalling shared context.' }));
caption.append(statusBadge('Illustration', { tone: 'accent' }));
status.append(statusBadge('Read only', { tone: 'neutral' }));
```

An explicit `label` makes a motif an accessible image; the default is `aria-hidden="true"`. Put essential product explanation in normal HTML as well. The connection diagram, still named `memoryOrbit` for compatibility, uses precise rectilinear paths, neutral node panels, and an accent core. `.ds-orbit--on-ink` and `.ds-memory-stream--on-ink` remain compatibility classes for the deep canvas layer; all variants use the same semantic line and text tokens. `motion: 'intro'` adds `.ds-motif-intro`: connector groups make a subtle 220ms transform/opacity entrance, the core enters over 180ms, and nodes enter over 120ms with 30/60ms stagger delays. It finishes once and stays still. The app may opt in on the first auth-story mount, tracking that mount outside the renderer; every onboarding/polling rerender must remain static. The gallery exposes a deliberate replay. Reduced motion and keyboard input skip the movement. Custom page illustrations may add a composition but must consume DS colors and stroke/type decisions. Reusable variants belong here and in the gallery.

`memoryStream(options)` returns a responsive wrapper, not a bare SVG. Its wide SVG and narrow HTML ordered steps share one fixed set of three labels, titles, and supporting lines. At viewport widths ≤600px, or when the component’s container is ≤700px, only the HTML cards display; the wide SVG is removed from layout and accessibility exposure. This keeps labels at shared 12px/14px text sizes instead of shrinking a 900px diagram into a phone. A provided illustration label names whichever representation is visible; without a label both remain decorative. The mobile sequence is static, including when the wide illustration opts into its finite intro. The gallery demonstrates the same helper consumed by public pages.

`memoryOrbit({agents:true})` adds Claude, OpenClaw, Grok Bot, Muse and Instinct around the shared-memory core. Each pod uses a fixed local image reference, preserves the original mark's proportions and color, and keeps the product name visible. This option identifies examples of the agent ecosystem; it must not imply a live connection, tested setup, endorsement, or broader integration support. Any surface that needs this agent diagram and the gallery consume the same variant. Keep all marks bundled and record their actual source in `web/vendor/brands/SOURCE.md`; never accept an arbitrary image URL or redraw a third-party mark. The generic orbit remains the default for app decoration.

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
- **Focus:** the mint outline is always visible. Native keyboard actions remain immediate. Preserve focus, caret, drafts, and expanded content across polling and progress updates.

### Pending work and measured progress

`loadingState({ label, description, compact = false, lines = 0 })` creates a labeled `role="status"` region with `aria-busy="true"`. The full variant includes an indeterminate progressbar and up to five decorative skeleton lines; the compact variant stays an inline spinner and label. Choose a present-tense label such as “Loading workspace activity…” and an optional concise explanation. The operation owner replaces or settles the state as soon as the real request ends. Do not add a minimum loading delay, fake stages, or a successful result before acceptance.

`progressBar({ label, value, max = 100, valueText, className })` returns a named `role="progressbar"`. An omitted, null, or nonfinite value creates an indeterminate bar with no `aria-valuenow`. A finite value is clamped between zero and a positive max and updates the fill using transform; `setProgress(bar, options)` changes that same node so repeated measured updates preserve focus and identity. Supply `valueText` to expose a count and unit, such as “2 of 3 setup checks observed.” Keep the same count visible nearby. No amount is inferred from elapsed time. The helpers set only safe DOM text, attributes, and a bounded numeric CSSOM transform; they parse no HTML or stylesheet and fetch nothing.

Use one `observeLoadingMotion(root)` per mounted surface. It uses a single intersection observer and a mutation observer, without an animation-frame loop or timer, to pause registered spinner/skeleton/indeterminate motion while its element is offscreen or the document is hidden. Its returned disposer disconnects both observers and the visibility listener. Native hidden elements remain hidden. Reduced-motion preferences and keyboard input stop pending movement while labels, scaffold shapes, and a static indeterminate mark remain visible. The gallery’s local reduced-motion toggle changes only its controlled preview.

The memory drawer stays one pending read: `.memory-loading` is busy, its page-shaped scaffold uses shared skeleton lines, and its labeled delayed hint remains under the drawer’s request/timer lifecycle. It has no numeric progress or inferred content. The setup guide uses only `onboardingProgress(data).completed` against the three successful server-observed agent checks. If results are unavailable it says “Not checked yet”; a pending first check can show an indeterminate bar. Refreshing keeps any last confirmed count visible. The check control remains focusable with `aria-disabled` plus an enforced pending guard, so refreshing cannot move focus into another field or submit twice. Copying configuration or a prompt, creating a key, choosing an agent, and time passing never complete a step.

The `#feedback-states` gallery exposes idle/loading/success/error/disabled samples, visible keyboard focus, a reduced-motion preview, controlled measured counts, and a copied-state response without altering the clipboard or a workspace. Gallery waiting states are explicitly local demonstrations. The disclosure example exercises Enter/Space, accurate expanded state, and Escape focus return.

## Motion

The [Emil design-engineering skill](https://emilkowal.ski/skill) informs this system. Motion has a job: input feedback, a rare overlay transition, or an explanation that someone deliberately requests. Everyday navigation and repeated updates should feel still.

Use 120ms for a restrained pointer press at scale(.985) with opacity feedback, 180ms for an overlay/feedback transition, 220ms for an occasional response. The SVG illustration entrance finishes once within 220ms. Motion transitions transform and opacity only. Hover and selected colors update immediately; keyboard controls remain immediate. Do not animate layout dimensions, use `transition: all`, add ambient orbit loops, or replay card entrances when data refreshes. Controls keep hover positioning still; keyboard input skips motion through `data-input="keyboard"` and `:focus-visible`. Keep app code's input-mode tracking.

Spinners, skeleton shimmers, and indeterminate travel are permitted only while actual work is pending or an explicitly labeled local preview is selected. They are not decoration and do not represent numeric progress. Reduced motion stops those animations, removes transform feedback, and retains labeled states. Native dialogs and controls remain usable without animation support. Forced colors preserve visible boundaries.

## Static social exports

`bun deploy/render-social-card.ts` reads the canonical surface, text, accent, and chart tokens from this stylesheet and regenerates `web/brand/engram-social.svg` and `web/brand/engram-social.png` at 1200×630. When the palette or export composition changes, run the renderer and inspect both files at their final size. Keep the export aligned with the canonical pulse identity and shared typography; a generated image is not a separate source of brand decisions. The PNG is the share-preview artifact and the SVG remains an editable local source. No export command publishes or deploys it.

## Email and email-preference surfaces

`gateway/src/design-tokens.ts` is the shared server-side token reader for the email renderer and SVG/PNG exports. Keep their resolved values tied to `web/design-system.css`; do not fork a server palette. `gateway/src/mail-templates.ts` is the shared email renderer. `renderEmail({template,...})` returns `subject`, `preheader`, `text`, and `html` for login, signup verification, team invitations, agent authorization, welcome, first-agent setup, first memory, and a second-agent tip. The dark email layout uses the graphite canvas, neutral panels, Inter/sans headings, and mint primary action with accent-ink text. The renderer resolves the canonical palette and spacing to literal inline values from this stylesheet; email clients do not need CSS variables, scripts, external stylesheets, fonts, or images.

Email tokens are `--ds-email-width` (600px), `--ds-email-padding` (space-6), `--ds-email-heading-size` (text-2xl), `--ds-email-body-size` (text-input), and `--ds-email-font-sans/editorial/mono`. Font stacks use locally installed Inter when available and common email-safe fallbacks. Emails use a text wordmark rather than redrawing the pulse or loading an image. Their table layout, shared label/title/body rhythm, one main CTA, text alternative, and preheader are part of this shared pattern. All dynamic text and links are escaped; action and unsubscribe URLs must be absolute HTTP(S) URLs without credentials. Do not add tracking pixels or make the design depend on downloaded assets.

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

Email-preference standalone header, action, and footer links use `.ds-touch-target` so the shared 44px mobile minimum applies alongside the native button targets.
