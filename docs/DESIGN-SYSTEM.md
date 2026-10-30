# Engram design system

This is the authority for frontend visual and interaction decisions. Read this document and inspect the local `/design-system` gallery before changing an app view, public page, graphic, interaction, or loading state. The repository [frontend contract](../AGENTS.md) requires every future frontend change to consume or extend this system. The canonical pulse logo is unchanged.

The app direction is clear, alive and honest: one sans typeface (local Inter) at normal letter-spacing, generous whitespace and a small palette, with real product logos, one scalable icon pack and functional motion. Agents appear as their actual marks (`identityMark()`), status reads as an icon plus words, and motion marks arrival, live state or pending work. Nothing visual may look like evidence that an agent connected, saved memory, or completed work.

Public pages use the **Marketing kit** below: a developer-platform language modeled on Supabase's site, with Engram's own mint accent, pulse mark and copy. Both surfaces share the **Identity, icons and motion** primitives.

## Rules (app and public)

1. **Real marks only.** An agent or tool appears as its vendored logo from `brand-catalog.js` (or an inline mark in `tooling.js`), inside `identityMark()`. Unknown agents get the local Beam avatar. A custom agent may show its own self-described logo, always labeled with its source. Never hotlink, recolor or redraw a brand mark; a mark is a display hint, never proof of setup.
2. **One icon pack.** Icons are Lucide, vendored from one pinned release by `scripts/vendor-lucide.ts`: `icon()` in JS, `.ds-icon[data-icon]` in CSS. Add an icon by adding its name to the script's list and running it. No other icon sets, emoji or hand-drawn glyphs.
3. **Truthful state.** Presence describes connection state: a solid dot for seen recently, quiet or reconnect, and a pulse only while a task report is running. Observed (eye) and Reported (speech) evidence keep distinct icons. Status always pairs an icon with words; color alone never carries meaning.
4. **Functional motion.** Entrance stagger on a fresh list, a flash on rows that arrived since the last refresh, spinners only while a request or report is pending, chevrons that turn with their disclosure. No motion on repeat renders, no ornamental loops in the app (the empty-state orbit is the one quiet exception), and everything stops for reduced motion.
5. **Italics, serif and tracking.** No italics or serif type; `letter-spacing` is never negative.
6. **Section numbering.** No "01 /" decorations; a genuinely ordered list of steps may be a plain `<ol>`.
7. **Containers.** App rows are separated by space and a hover surface (`ds-row-hover`); hairline tiles are for marks, icons and code. Public pages may use the marketing kit's hairline cards.
8. **No faux evidence.** Mockups, demos and gallery examples are labeled as examples and describe real behavior.

## Interaction states

Hover, press and selection follow one grammar (tokens in `:root`, rules in the button section of `web/design-system.css`):

| State | Treatment |
| --- | --- |
| Hover, outline button | `--ds-hover-bg` tint and `--ds-hover-border` edge. Never a white (`--ds-ink`) border. |
| Hover, text button, tab, chip | `--ds-hover-bg` tint and the label moves to `--ds-ink`. No border appears. |
| Hover, row | The whole row takes `--ds-hover-bg` (`.ds-row-hover`). When a row has one open button, that button's `::after` covers the row and inner controls sit above it. |
| Hover, primary / danger | `--ds-accent-hover`; danger takes `--ds-danger-hover-bg`. |
| Press | `scale(.985)` plus `--ds-press-bg` (`--ds-accent-press` for primary). No opacity flash. |
| Selected | `--ds-selected-bg`, or the mint tab underline. Never an underlined label. |
| Inline link in prose | A faint underline (38% of the text color) that firms up on hover. |

Buttons and button-styled links never underline, at rest or on hover. Color, background and border changes use `--ds-duration-fast`. `test/hover-states.test.ts` fails if a stylesheet underlines on `:hover` again.

## Identity, icons and motion

Defined in `web/design-system.css` ("Identity and motion") and `web/design-system.js`, shown in the gallery under `#identity`.

| Primitive | Use |
| --- | --- |
| `identityMark(node, { size, presence, label })` | A logo or avatar in a rounded hairline tile. Sizes `xs/sm/md/lg/xl` (18/22/28/40/56px). `presence`: `recent`, `working` (pulses), `quiet`, `reconnect`. |
| `markStack(marks, { max, label })` | Overlapping contributor marks with a `+n` overflow. |
| `.ds-status-icon[data-state]` | Status icon plus words: `running` spins, `completed`, `failed`, `stale`, `unknown`. |
| `emptyState({ glyph, title, description, action })` | Empty state with a glowing icon tile and slow orbit dots. |
| `staggerIn(container, selector)` / `.ds-stagger` | Entrance stagger for a fresh list (first 24 children). |
| `flashNew(elements)` / `.ds-flash` | Highlight rows that arrived since the last refresh. |
| `.ds-row-hover` | Row hover surface. |
| `.ds-tab-underline` | Mint underline that grows under the pressed or selected tab. |
| `.ds-spin` | Rotation for a pending-state icon. |

Custom agents: an agent with no vendored mark can describe itself with the `set_identity` MCP tool (a name and a square PNG logo, re-encoded server side at 64 px). `setAgentIdentities()` in `tooling.js` loads the workspace's identities from `/api/connections`; `agentVisual()` then returns `{ logo, label, custom }` and `visualIcon()` renders the logo as `img.agent-logo`, which fills the `identityMark()` tile. Always pair a custom name or logo with a `pill()` that says where it came from ("Self-described" or "Set by owner"); it is a display hint, never verification. Owners edit it in the connection detail panel (`web/agent-identity-editor.js`). Public pages never show custom identities (`publicSafe`). Gallery: `#identity`, "Custom agents".

Brand marks: `web/vendor/brands/manifest.json` records each mark's file, tone (`color` or `mono`), source and license. `bun scripts/brand-catalog.ts` regenerates `web/brand-catalog.js` and the hashed provenance in `catalog-sources.json`; tests verify hashes and SVG safety. Mono files use `fill="currentColor"` and render lightened via `data-tone="mono"`.

## App shell (dashboard grammar)

Modeled on developer dashboards (Supabase's, via Mobbin), with Engram's palette. Defined in the "App shell" sections of `web/design-system.css` / `web/design-system.js`, laid out in `web/app-theme.css`, shown in the gallery under `#shell`.

| Primitive | Use |
| --- | --- |
| `.ds-topbar`, `.ds-crumbs`, `.ds-crumb`, `.ds-crumb-sep`, `.ds-search-trigger`, `.ds-topbar-button` | Top bar: logo / workspace switcher + kind pill / page, then Feedback, ⌘K search, help, account menu. |
| `.ds-rail` | 56px icon rail; labels slide in on hover or focus; off-canvas sheet under 900px. |
| `commandPalette(groups)` | ⌘K / Ctrl K menu: grouped pages, actions, workspaces and help; arrow keys, Enter, Esc. Every item runs an existing app action. |
| `pill(text, { tone })` | Small mono uppercase pill for a fixed category ("Team", "Read only"). Never a status claim. |
| `showToast(message, { tone, glyph, action })` | Top-right stacked toast with a countdown hairline; pauses on hover; max three. App `toast()` wraps it and marks failures red. |
| `routeProgress.start()/done()` | 2px mint bar while a view's data loads (not on background polling). |
| `banner({ glyph, title, description, action, onDismiss })` | Dismissible notice with an icon tile. |
| `.ds-panel-list`, `.ds-panel-head`, `.ds-panel-foot` | Bordered list with a mono uppercase header row, hairline rows and a footer bar (counts, load more, key hints). |
| `.ds-skeleton-row` | Shimmering placeholder row; app `skeletonRows()` renders a loading panel of them. |
| `.ds-empty[data-variant='dashed']` | Dashed empty box (`emptyState()`), used by every app list. |
| `input.ds-switch` | Mint toggle for booleans. |
| `kbd` | Key hints (⌘K, Esc, ↑ ↓). |
| `.ds-settings`, `.ds-settings-card` (`-head`, `-row`, `-row-full`, `-label`, `-help`, `-control`, `-value`, `-switch`, `-foot`, `-note`) | Settings card: header, two-column rows (label and help left, control right), footer with Cancel / Save changes disabled until dirty. `data-tone="danger"` for a danger zone. |
| `.ds-plan-grid`, `.ds-plan-card[data-current]` | Catalog-driven plan cards; the current plan gets a mint ring and a "Current plan" pill. Prices come from the API catalog only. |
| `.ds-usage`, `.ds-usage-line` | Usage meter, shown only when a real limit exists. |
| `.ds-preview-panel`, `.ds-preview-body` | Bordered live preview with a mono header, sticky beside an editor. |
| `.ds-steps > li[data-state]` | Ordered stepper on a hairline rail: `current`, `complete`, `upcoming`. A real sequence only, never decoration. |
| `.ds-action-bar`, `.ds-action-bar-actions` | Sticky footer bar for a pending decision ("Approve 3 excerpts"). |
| `.ds-auth` | Split sign-in: form column left; a quiet dot-grid panel right with real agent logos and true statements only (no quotes or metrics). |
| `.ds-result` | Result state with an icon tile (approved, denied, expired, not found, error); a small check pop. |
| `.ds-decision`, `.ds-code-compare` | Centered approval card with a large monospace code to compare. |
| `.ds-checklist`, `.ds-check`, `li[data-fresh]` | Getting-started checklist; a step ticks with an animation only when a real event flips it between renders. |
| `.ds-client-tab`, `.ds-window-panel` | Connect dialog tabs with client logos inside a terminal window. |

Micro copy: sentence case, short; buttons are verbs ("Connect agent", "Save changes"); empty states are "No X yet" plus one actionable line; toasts are past tense ("Settings saved"). Truthful labels (observed, agent-reported, read-only, unverified) are never shortened away.

## Marketing kit (public pages)

Defined in the "Marketing kit" section of `web/design-system.css`, arranged by `web/marketing.css`, and made interactive by `web/marketing-site.js`. Shown in the gallery under `#marketing-kit`.

| Primitive | Use |
| --- | --- |
| `.ds-icon[data-icon="name"]` | A local Lucide icon tinted with `currentColor`. Every icon in `web/vendor/lucide` has a rule. No inline `style`, so it works under the gallery's strict `style-src 'self'`. |
| `.ds-icon-tile` (`data-tone="accent"`) | A 32px hairline tile around an icon, for cards, menus and pairs. |
| `.ds-kicker` | Accent icon plus a short muted label above a section heading. |
| `.ds-announce` + `.ds-announce-label` | One announcement pill in a hero, linking to a real release. The label is a short word such as "New". |
| `.ds-spotlight` | Hairline card on the raised surface. `marketing-site.js` sets `--mx/--my` so a mint glow follows the pointer. |
| `.ds-window`, `-bar`, `-dots`, `-title`, `-tabs`, `-body`, `.ds-copy` | Terminal or code window. Tabs use `role="tab"`/`tabpanel` with arrow-key navigation; `.ds-copy[data-copy-from]` copies the visible panel's `data-command`. |
| `.ds-term-prompt`, `-muted`, `-ok`, `.ds-caret` | Terminal text colors and a blinking caret for the example handoff. |
| `.ds-stat` | Value with an accent rule above it. Values must be true facts, never invented metrics. |
| `.ds-accordion` | Hairline question list built on native `<details>`. |
| `.ds-marquee` | Two lists: the real list, then an `aria-hidden` copy. Scrolls, pauses on hover or focus, and becomes a static wrapping list for reduced motion. |
| `.ds-dotgrid` | Dot grid and soft mint glow behind a hero or closing call to action. |
| `.ds-menu` | Header dropdown panel. Opens on hover with a fine pointer, on click, and closes on Escape or outside click. Inline on narrow screens. |
| `[data-reveal]`, `data-reveal-delay` | Fade-up on scroll. Content is hidden only after the script adds `html.ds-js`, and never for reduced motion. |

Tokens: `--ds-hairline`, `--ds-hairline-strong`, `--ds-surface-raised`, `--ds-glow`, `--ds-glow-soft`, `--ds-dot`, `--ds-reveal-distance`, `--ds-duration-reveal`. Example content in mockups (pages, terminals, share lists) is labeled as an example and describes real behavior.

## Public profile (`/u/<slug>`)

Composed in `web/profile.js` and `web/showcase.css` from the marketing kit: a `.ds-dotgrid` hero (avatar, `@slug`, a presence pill that pulses only while an agent has a fresh running report, share actions), then hairline cards. "Recently building with" shows `markStack` product marks taken only from the public event stream, so it is empty when the owner keeps activity private. Totals use `.ds-stat`. The 12-week chart uses one accent at four strengths, square-root scaled to the profile's busiest day, and streak facts (current, longest, best day) derived from the same public UTC daily counts. On phones the chart fits the width (24px+ day targets) instead of scrolling. The social card (`renderShowcaseCard`) follows the same chart and streak rules.

## Files and adoption

- `web/design-system.css`: semantic tokens, native primitives, reusable components, motion, accessibility, and the isolated gallery layout.
- `web/design-system.js`: safe DOM helpers `statusBadge`, `statusText`, `evidenceList`, `taskRecord`, `profileAvatar`, `resourceChip`, `progressBar`, `setProgress`, `loadingState` and `observeLoadingMotion`. They parse no HTML or stylesheet and make no API calls. Labeled loading helpers move only while their owning operation is pending. Deprecated helpers kept only for current app callers: `memoryOrbit` (signup), `sticker` (signup), `highlightArt` (public profile) and `profileLayoutPreview` (profile editor). The retired `memoryStream`, `observeContextFlow`, `contextFlowArt` and `observeLogoTicker` have been removed.
- `web/select-control.js`: progressive single-select enhancement, re-exported as `enhanceSelect` and `observeSelects` from `design-system.js`. Native values, validation, form submission and existing change handlers remain authoritative.
- `web/design-system.html` and `web/design-system-gallery.js`: interactive review examples. `/design-system.html` works as a static path; the local server also maps `/design-system`.
- `web/marketing-site.js`: public-page interactions (header menus, mobile navigation, spotlight, tabs, copy, scroll reveal and the example handoff). Pages read fully without it; the CSP allows only same-origin scripts, so nothing is inline.
- Surface styles own composition: `app-theme.css` for the app and `marketing.css` for public pages. They may arrange and size components; they must not create parallel button, badge, field, or motion systems.

Use `<html data-design-system="signal">`. Load `/design-system.css` first, then legacy styles if needed, then the owning surface stylesheet. The document marker enables a higher-priority visual bridge over legacy generic body/control/type rules. The bridge deliberately leaves record rows, card grids, and control layout to the owning surface. Do not copy the shared primitive declarations into a surface stylesheet.

Legacy aliases `--muted`, `--line`, `--soft`, `--radius-control`, `--radius-card`, `--radius-panel`, `--ease-out`, and `--font-mono` resolve to DS tokens. No new frontend code should introduce an unprefixed token.

## Tokens

The interface is dark only (`color-scheme: dark`); there is no separate light theme, so a light color-scheme preference renders the same palette.

| Role | Token | Value / use |
| --- | --- | --- |
| Canvas | `--ds-paper` | `#111313`; the page background |
| Surface | `--ds-surface` | `#181b1a`; the one flat fill, used only when grouping is essential |
| Text | `--ds-ink` | `#ededed`; headings and body text |
| Muted text | `--ds-muted` | `#a1aaa6`; supporting copy, captions, metadata |
| Accent | `--ds-accent`, `--ds-accent-ink` | `#77d9ad`, `#10261b`; the primary action fill and its text, text links, focus ring |
| Control boundary | `--ds-input-border` | `#65716b`; inputs, selects, secondary buttons and choice controls |
| Functional states | `--ds-success`, `--ds-warning`, `--ds-danger` | Text color for a state, always beside words that name it |
| Deprecated compatibility | `--ds-surface-soft`, `--ds-accent-hover`, `--ds-info`, `--ds-*-bg` | Aliases of the core palette. Do not use in new work |
| Deprecated legacy values | `--ds-line`, `--ds-line-strong`, `--ds-accent-muted`, `--ds-lime`, `--ds-lilac`, `--ds-apricot`, `--ds-inverse`, `--ds-inverse-ink` | Kept for the email renderer and remaining app callers. No shared primitive or public page uses them. Do not use in new work |
| Data and identity | `--ds-chart-0/1/2/3/4`, `--ds-avatar-1/2/3/4/5`, `--ds-avatar-face` | App-only: the contribution-chart ramp and local fallback avatar colors |
| Type | `--ds-font-sans`, `--ds-font-mono` | Local Inter for everything; system monospace only for code and commands |
| Legacy expressive type | `--ds-font-editorial` | Alias to Inter. `.ds-editorial` renders as inherited plain text |
| Text sizes | `--ds-text-xs/sm/base/lg/xl/2xl/display` | `.75/.8125/.875/1.0625/1.375/2rem`, then `clamp(2.75rem,6vw,5rem)` |
| Mobile control text | `--ds-text-input` | `1rem`; minimum for text inputs, selects, and textareas at widths ≤600px |
| Spacing | `--ds-space-1/2/3/4/5/6/8/10/12/16/20/24` | `4/8/12/16/20/24/32/40/48/64/80/96px` |
| Heading rhythm | `--ds-gap-label-title`, `--ds-gap-title-body`, `--ds-gap-heading-actions` | `12px`, `12px`, `20px` |
| Corners | `--ds-radius-control/card/panel/pill` | `6/8/12/999px` |
| Action sizing | `--ds-button-height`, `--ds-button-padding-block/inline`, `--ds-button-font-weight` | 32px desktop height with 5px/10px padding and 450 weight; height becomes 44px on narrow screens or coarse pointers |
| Shadows | `--ds-shadow-press/card/sticker`, `--ds-shadow-dialog` | The first three are `none`. One shadow for overlays only: dialogs, select menus and toasts |
| Motion | `--ds-duration-fast/base/slow` | `120/180/220ms`; control feedback and overlays |
| Illustration entrance | `--ds-duration-illustration` | `220ms`; deprecated, used only by the app's remaining `memoryOrbit` |
| Easing | `--ds-ease-out`, `--ds-ease-in-out` | Responsive feedback |
| Pending motion | `--ds-shimmer-duration`, `--ds-progress-duration`, `--ds-progress-height` | `1400ms`, `1200ms`, `4px`; only while a real request is pending (or a labeled local preview) |
| Fresh activity text | `--ds-status-shimmer-duration`, `--ds-status-shine-ink` | `3200ms`; an accent sweep on fresh running activity only |
| Profile image sizes | `--ds-profile-avatar-sm/md/lg` | `56/80/112px` |
| Visual layout preview | `--ds-choice-preview-min-height` | `132px` |
| Highlight art | `--ds-highlight-art-ratio` | `24 / 11` |
| Week pulse bar | `--ds-week-bar-height` | `72px` |
| Busy indicator | `--ds-spinner-size/stroke/duration` | `16px/1.6px/720ms`; actual loading feedback only |

Text on the canvas has approximately 15.92:1 contrast; muted text has 7.83:1 on the canvas and about 7.2:1 on the surface. The control boundary has approximately 3.7:1 against the canvas and 3.4:1 against the surface. Accent-ink on the accent fill has approximately 9.36:1. The dialog backdrop keeps a dark translucent scrim as a functional modal overlay.

At widths of 600px and below, native text inputs, selects, and textareas use `--ds-text-input` (1rem, normally 16px). This avoids iOS focus zoom caused by smaller control text while respecting the user's root font preference. The shared marked-root selectors preserve a minimum 44px height for native text inputs and selects and outrank legacy compact form styles without `!important`; textareas retain their larger 110px minimum. Surface styles may stack or resize controls but must not shrink their targets or text below these minimums. Checkbox and radio controls are excluded.

## Deprecated primitives

Kept working (restyled plainly) only while app callers remain. Do not use them in new work; delete each once nothing references it.

| Primitive | Now renders as |
| --- | --- |
| `.ds-badge`, `statusBadge`, `.ds-sticker`, `sticker` | Plain inline text in muted color; success, warning and danger keep their text color. No border, fill or padding |
| `.ds-eyebrow` | Plain muted sans text, normal case and tracking |
| `.ds-editorial`, `--ds-font-editorial` | Inherited text; no accent color |
| `.ds-divider` | Empty vertical space only |
| `.ds-card[data-tone]` | Every tone is the one surface; `ink` sits on the canvas |
| `.ds-product-logo-frame`, `.ds-logo-backplate` | Borderless light plate. Prefer the bare mark with `data-tone="mono"` |
| `.ds-resource-chip`, `resourceChip` | Unbordered, unfilled inline label with its mark |
| `memoryOrbit`, `.ds-orbit`, `.ds-motif-*` | The app's signup diagram, with normal letter-spacing |
| `highlightArt`, `profileLayoutPreview` | Unchanged decorative art for current public-profile callers |
| Tokens in the two deprecated token rows above | See Tokens |

## Shared primitives

Labeled buttons and link actions use their text without decorative directional
arrows, including external-link arrows. Direction-only actions need visible
words such as Up and Down. Keep semantic action icons (copy, download, delete)
and state indicators for disclosures and native selects; explanatory arrows in
diagrams and body content are not button decoration. The gallery demonstrates
these same label-first actions without reserving a trailing icon slot.

| Pattern | API | Requirements |
| --- | --- | --- |
| Button / link action | Native `button`, `.button`, `.button-link`, or `.ds-button` | 32px desktop target, 44px at mobile widths or coarse pointers; visible action label; use a button for a mutation and an anchor for navigation |
| Primary button | `.primary` or `.ds-button[data-variant="primary"]` | Mint fill with accent-ink text; one main action per moment |
| Accent action | `.ds-button[data-variant="accent"]` (`lime` is a legacy alias) | Accent text and boundary on no fill; use sparingly |
| Secondary / quiet / destructive | Default ghost with the control boundary; `[data-variant="text"]` or `.text`; `[data-variant="danger"]` | Destructive labels must name the action; no color-only confirmation |
| Size | `.small`, `.large` | One compact action density: default, small and legacy large actions use the shared 32px desktop treatment. Controls increase to 44px for coarse pointers and at widths ≤600px; long labels grow naturally |
| Standalone touch link | `.ds-touch-target` on an anchor | Shared unstyled inline-flex target. At mobile widths/coarse pointers, it is at least 44×44px. Keep inline prose links in normal text flow |
| Icon action | `.ds-icon-button` or `.icon-button` | 32×32px desktop, 44×44px on narrow/coarse-pointer screens; accessible name required |
| Fallback agent avatar | `.ds-agent-avatar` through `agentVisual` / `visualIcon` | Local deterministic Beam face only for unknown agents; visible name/provenance stay separate. Public callers use the constant public-safe seed. Known products keep their actual logo |
| Human profile image | `profileAvatar({src,label,size})`; `.ds-profile-avatar` | Sizes `sm/md/lg` are 56/80/112px. One accessible image label; static local memory-bloom fallback while missing, loading or unavailable. Only the versioned local public PNG endpoint or bounded PNG data drafts are accepted |
| Task record | `taskRecord(record,{headingLevel})`; `.ds-task-record`, `.ds-task-plan`, `.ds-task-record-list` | Text-only continuation record: next step (accent rule), objective, plan steps with To do/In progress/Done/Dropped badges, decisions with reasons, blockers, constraints, open questions and portable references. Empty sections are omitted. It is agent-reported; the owning view shows author, save time and the recheck rule. Plan rows stack below 600px. Gallery: `/design-system#task-record` |
| Release log | `ol.ds-release-log` of `li.ds-release-entry` with `time.ds-release-time[datetime]`, `.ds-release-content`, `p.ds-release-kind`, `.ds-release-title`, `.ds-release-summary`, `.ds-release-refs` | Static, newest-first changelog entries separated by space, no rules. The time element carries a UTC ISO timestamp and shows date plus UTC time in Inter with tabular numbers; the kind (New, Improved, Fixed, Security, Under the hood) is plain muted text, never a tag; references link to the PR and to the commit as plain text ("Commit abc1234"). Two columns stack below 600px, where reference links get 44px targets. The public `/changelog` is rendered from `docs/changelog.json` by `bun scripts/changelog.ts render`. Gallery: `/design-system#release-log` |
| Recorded evidence | `evidenceList(rows,{label})`; `.ds-evidence-list` | A labeled native definition list of text-only `{label,value,note}` records. Unknown values stay explicit. Two flexible columns wrap within narrow containers; values use tabular numbers. Keep access, individual memory receipts, explicit workflow checks and automatic-use claims separate. Client declarations never prove behavior. Gallery: `/design-system#memory-evidence` |
| Product logo | `img.ds-product-logo`, optional `data-size="28"`, optional `data-tone="mono"` | 24px default or 28px; `object-fit: contain`, local source, no distortion. One-color marks drawn in black (`currentColor` SVGs) take `data-tone="mono"` so they show light on the dark canvas; colored marks render unchanged. No frame or tile |
| Attribution | `.ds-attribution`, `.ds-attribution-label`, `.ds-attribution-links`, `.ds-attribution-link.ds-touch-target`, optional `.ds-attribution-avatar` | Compact source credits with visible names, original local product marks and 24px circular author photos. Native links keep shared focus and mobile targets; groups wrap without shrinking images. Participates in heading rhythm; static with or without JS. Gallery: `/design-system#attribution` |
| Logo list | `ul.ds-logo-list` of `li` with an `img.ds-product-logo` and the visible name | Static wrapping grid of every mark beside its name. No frames, tiles, ticker or motion. The homepage authors all 21 catalog items in HTML. Gallery: `/design-system#logo-list` |
| Logo backplate (deprecated) | `.ds-product-logo-frame`, `.ds-logo-backplate` | Borderless light plate kept for app callers; new work uses the bare mark |
| Fields | `.ds-field` or `.field` wrapping native controls | Visible label, associated hint/error, correct autocomplete, retain drafts after failure |
| Select | `enhanceSelect(native)` or `observeSelects(root)`; `.ds-select`, `.ds-select-trigger`, `.ds-select-popup` | Accessible select-only combobox, explicit selected check, wrapped labels, viewport-bounded list. Native form/validation/value retained. Multiple and unsupported controls stay native; see contract below |
| Invalid field | `aria-invalid="true"` + `.ds-field-error` | Link error text with `aria-describedby`; explain the correction |
| Card | `.ds-card` | One flat surface, no border or shadow, used only when grouping is essential. Tones are deprecated and all render as the surface. A card is not automatically clickable |
| Visual radio choice | `.ds-choice-group` fieldset, `.ds-choice-options`, `.ds-choice-card` label, native radio, `.ds-choice-visual`, `.ds-choice-copy/title/description` | Native grouping, checked/disabled and arrow-key behavior. Keep a visible legend and text beside the decorative thumbnail. Never publish merely by choosing a layout |
| Highlight card | `.ds-card.ds-highlight-card`, `.ds-highlight-visual/content/title/description/meta/actions` | Only deliberately public text and approved references. Static art is decorative. Keep optional links separate from native disclosure summaries |
| Highlight disclosure | Native `details.ds-highlight-disclosure` with `summary` | Keyboard immediate, readable in document flow; optional `.ds-disclosure-indicator` follows open state |
| Focus row | `.ds-focus-row`, `.ds-focus-mark/content/label/title/description/meta` | Neutral summary row. A logo may replace the repeated product name when its canonical name remains accessible. Preserve observed/reported provenance in accessible text and a title when omitting repeated visible copy; the row does not imply verified work |
| Seven-day pulse | `.ds-week-pulse` list, `.ds-week-day`, native `.ds-week-button`, `.ds-week-bar` and `.ds-week-bar-fill`, `.ds-week-label/count` | Supply real UTC dates and counts. Static ratio only, no invented activity. `aria-pressed` shows selected day; roving focus and arrow/Home/End handling belong to the owner |
| Badge (deprecated) | `.ds-badge[data-tone]` or `statusBadge(text,{tone,className})` | Renders as plain inline text: muted, or the success/warning/danger text color. Do not add new badges; write the state as words |
| Activity text | `statusText(label,{active=false,className})`; `.ds-status-text[data-active]` | Solid readable copy with a decorative sheen only for fresh running work. Use `observeLoadingMotion(root)`. Offscreen, background, keyboard, reduced-motion and forced-color states stay static; the owner stops active state when freshness expires |
| Legacy sticker (deprecated) | `.ds-sticker` or `sticker(text,{tone,tilt})` | Same plain-text treatment as a badge |
| Eyebrow / editorial accent (deprecated) | `.ds-eyebrow`, `.ds-editorial` | Both render as plain text. Do not add kickers or highlighted words |
| Heading group | `.ds-heading-group` | Title, then description, then actions; shared semantic gaps preserve breathing room |
| Heading label row | `.ds-heading-label` inside a heading group | An optional secondary action above the title, such as Back; the row gets the same gap before the title |
| Busy | `loadingState({label,description,compact,lines})`; `.ds-spinner`; `.ds-skeleton` inside `[aria-busy="true"]` | Labeled pending operation. Skeleton shimmer starts only for busy content; its geometry remains stable. Use `observeLoadingMotion(root)` and dispose it when the surface unmounts |
| Progress | `progressBar({label,value,max,valueText,className})`, `setProgress(element, options)` | Omit value for unknown-duration work. Pass an actual measured count plus max for determinate work. Never invent a percentage or advance on a timer |
| Action result | `data-feedback="success/error"` on the actual button; optional `.ds-feedback-icon` | Set only after the operation result. Preserve the accessible label and visible result. The icon has one 180ms response; no loop |
| Disclosure | `.ds-disclosure-toggle`, optional `.ds-disclosure-indicator` | Native button with accurate `aria-expanded` and `aria-controls`; Enter/Space toggle, Escape closes and returns focus. Indicators turn over 120ms; keyboard/reduced motion is immediate |
| Dialog | `.ds-dialog` on native `dialog` | Title via `aria-labelledby`, native focus management, Escape support, return focus to opener |
| Panel | `.ds-panel` with `.ds-panel-header`, `.ds-panel-body`, `.ds-panel-footer` | One flat surface with a 20px inset (16px mobile); no border and no header/footer rules. The surface arranges content |
| Toolbar | `.ds-toolbar` | Flexible wrapping action row. Keep action meaning and accessible names visible |
| Tabs | `.ds-tabs` containing `.ds-tab` | Use native links with `aria-current="page"` for navigation; buttons with tab roles and `aria-selected` require complete arrow/Home/End keyboard handling and associated panels. Selected state uses a mint underline |
| Metric | `.ds-metric` with `.ds-metric-label`, `.ds-metric-value`, `.ds-metric-note` | Tabular value with visible meaning and provenance. No invented activity or hidden unit |
| Divider (deprecated) | `.ds-divider` | Renders as empty space. Separate content with spacing and headings |
| Status dot | `.ds-status-dot` beside visible state text | Inherits text color. Never conveys state alone |
| Feedback | `.ds-notice[data-tone]` (neutral, success, warning, danger), `.ds-toast` | A flat surface; the state is carried by its text color and words, never a tinted fill or border. Errors should remain until a user can act; avoid disappearing essential instructions |
| Command with copy | `.ds-command` containing a `code.ds-code-scroll` and the owner's Copy button | One-line value beside its action; the value scrolls, the action never does. At ≤420px the action moves below at full width. The scroll region keeps `tabindex="0"`, `role="region"` and a label naming the value. Gallery: `/design-system#device-approval` |
| Confirmation code | `.ds-confirm-code` with `.ds-confirm-code-label` and `.ds-confirm-code-value` | A short, non-secret code a person compares with another screen before acting. Mono, tabular and large; steps down at ≤360px. Place it directly above the action it guards. Gallery: `/design-system#device-approval` |

### Content fit and keyboard navigation

Buttons, badges, and stickers stay within the available width and wrap long labels and unbroken identifiers. Badge icons do not shrink. Surfaces must also provide shrinkable text columns (`minmax(0, 1fr)` or `min-width: 0`) and reserve the actual width of a status instead of a fixed estimate. At narrow widths, move supporting status/time metadata into normal document flow and keep the visible status label. Do not hide overflow to conceal a clipped control or place status over a title.

`.ds-icon-button` and the legacy `.icon-button` alias share a 32×32px desktop target, including close controls and toolbars. Default, small and legacy large actions use the same height, padding and text scale. Surfaces arrange actions without adding a larger button size. Content-bearing controls such as charts and rich selection rows retain room for their contents. The shared height becomes 44px on narrow or coarse-pointer screens. At widths ≤600px or with coarse pointers, a marked-root body rule also enforces a 44×44px minimum for native buttons, tabs, summary controls, button links, and `.ds-touch-target` anchors above compact surface styles; no `!important` is needed. Use an accessible name. `.ds-skip-link` on a normal link exposes a keyboard skip action when focused; point it at a main region with `tabindex="-1"`. Hash-routed apps must handle that local focus action without changing the selected view. Focus uses a mint outline with sufficient offset on dark surfaces. Dialogs contain overscroll so reaching a drawer's end does not scroll the page behind it. The gallery's content-fit examples exercise constrained badges, long actions, enabled/disabled icon actions, an unstyled standalone touch link, and the skip link. Shared toasts use `max(space-6, env(safe-area-inset-bottom))` for bottom clearance, including the legacy `.toast` alias.

Search/filter results use the shared `.ds-results` region for every state, with no extra bottom margin on immediately preceding filter controls. An empty filtered search should say there are no matches and offer a clear/reset action; it must not imply the whole workspace has no content. Pending checks show their current busy state without a simultaneous invitation to start the same check.

Use `.ds-code-scroll` for URLs or code values that must remain on one line. It
keeps the complete selectable text in a horizontal scroll region with a 44px
minimum height and the shared focus outline. Add `tabindex="0"`, `role="region"`
and an accessible label naming the value and horizontal scrolling. The owning
surface keeps adjacent labels and Copy actions outside that scroll region and
lets the value column shrink with `min-width: 0`. The content-fit gallery includes
a long sample URL; ordinary prose and form labels still wrap.

Use the exact pulse asset `/brand/engram-mark.svg` and its existing variants. Do not redraw, recolor, or replace the canonical mark. The technical diagram is supporting illustration, not a second logo.

### Product identification

`resourceChip(label, { visual, trailing, onClick, title, actionLabel, disabled })` renders the shared `.ds-resource-chip`. `visual` and optional `trailing` are already-created local DOM nodes (for example `visualIcon(providerVisual('github'))`); label text is never parsed as markup. A callback creates a native button; without one it is a static span. It has a pill boundary, a nonshrinking 16px mark, and an ellipsized label with a full title. Action chips use a 32px desktop target and 44px at widths ≤600px or for coarse pointers. Image marks receive a small neutral inverse backplate; inline monochrome marks inherit the readable foreground. Keep the resource's existing open/copy semantics and supply a descriptive action label. The gallery includes real local marks, redacted labels, a long name, and a disabled action.

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

### Select controls

Author a normal labeled native `select` with `option` and optional `optgroup` children. `enhanceSelect(native, { observe = true })` progressively wraps a supported single-select and returns `{ native, wrapper, trigger, popup, update, dispose }` (plus `close(restoreFocus?)`). It returns `null` when enhancement is unavailable. `observeSelects(root = document)` returns `{ update, dispose }` and uses one subtree observer to enhance newly mounted selects, synchronize option/attribute changes, and clean up removed or reparented controls. Use one owner per mounted surface; dispose it on page hide/unmount and recreate it on a persisted page show. Do not also install individual observers for the same surface.

The original select keeps its name, values, required constraint, form association, default selection and native validation. It becomes visually clipped and leaves the accessibility/tab sequence only after enhancement succeeds. The visible button uses `role="combobox"`, `aria-expanded`, `aria-controls` and `aria-activedescendant`; the popup uses `role="listbox"` with named optgroups and selected/disabled options. Visible labels, `aria-label`/`aria-labelledby`, description and error references, required/invalid state, and focus-restoration metadata are mirrored. Label extraction excludes the native options and generated trigger, so an “Agent source” field retains that name. Programmatic native focus and invalid submission focus the visible trigger; validation messages remain linked to it. A previously focused native control retains focus through enhancement.

Opening, hovering, typing or navigating highlights a choice without changing the native value. Arrow keys skip unavailable options; Home/End move to the first/last available choice; typing searches labels with repeated-letter cycling. Enter, Space, a pointer choice, or Tab commits once. Tab preserves natural focus traversal. Escape cancels and returns focus without applying the highlight or closing an enclosing dialog; outside interaction dismisses without committing. Popup options do not enter the Tab sequence. Settle popup and focus before dispatching the native bubbling `input` and `change` events, since their existing handlers may synchronously replace the view. Native programmatic assignments emit no invented change event.

Reversible per-instance accessors forward `value`, `selectedIndex`, `disabled`, `required` and each option's `selected` property to their original native getters/setters, then synchronize the display. They do not change global prototypes. No-op polling assignments preserve the open highlight, scroll position and rendered option identity. Native reset restores the original selection; becoming valid clears locally generated validation feedback. Attribute, optgroup, hidden-option and option-text changes synchronize through the observer. `update()` is available for an unusual external mutation; `dispose()` restores native descriptors/attributes, removes generated nodes and listeners, and respects a caller removing or moving the original select. Controls with `multiple`, a list size above one, `data-select-native`, or unsupported property forwarding retain native behavior.

Shared styles own the thin input boundary, accent selected check, distinct active outline, group labels, 36px desktop/44px mobile and coarse-pointer targets, long-label wrapping, and scroll-bounded menu. The popup flips toward the larger usable viewport space, clamps horizontally, and responds to viewport resize/scroll. It uses the native popover top layer when available and otherwise an in-page portal; a popup always remains inside its owning dialog to respect modal interaction. Keyboard and reduced-motion opening are immediate; pointer opening may use a 120ms opacity entrance. Menus use safe DOM text and fixed SVG marks, with no parsed markup or external assets.

Surface styles arrange `.ds-select` wherever they previously arranged a native select, including filter flex sizing and workspace picker width. Set `data-select-variant="embedded"` on the native select when its containing surface already supplies the control boundary; the shared wrapper mirrors that variant without creating a second border. Preserve the shared focus and target rules. The `#select-controls` gallery demonstrates grouped/disabled/long options, required validation, invalid and empty states, native multiple fallback, native reset and programmatic synchronization. The same component and keyboard behavior apply on narrow screens.

### Human profile images

`profileAvatar({ src, label, size })` represents the profile owner, separately from
agent product marks and unknown-agent faces. Its static SVG memory bloom uses
thin mint orbits, a graphite field, and one fixed geometry. It does not derive
personal details from a name or imply that anyone is online. Keep the owner's
display name in normal text alongside it.

Omit `src` for the default. The only accepted sources are the relative path
`/api/public/activity/<slug>/photo.png?v=<64-character lowercase SHA-256>` and a
PNG data URL of at most 700,000 characters for an unsaved local draft. The server
must validate the image and publication access; this rendering allowlist is not
an upload validator. Remote URLs, SVG, object URLs and arbitrary paths are never
assigned to an image. The fallback remains visible during loading and after a
load failure. A successful image covers it with `object-fit: cover` and one
120ms opacity transition, skipped for keyboard input and reduced motion.

Use a meaningful `label` such as “Alex's profile photo”. The wrapper carries the
single accessible image name; its inner SVG and image are decorative. No load
or error handler changes focus. File controls, explicit remove actions, busy
feedback, validation errors and saved feedback belong to the owning editor;
the avatar is not a button or a status indicator. The `#profile-avatars` gallery
contains all three sizes, an uploaded PNG fixture, loading/error fallbacks, and
a constrained layout with reduced motion.

### Visual choices and public-profile patterns

A visual choice is still a native radio group. Use a `fieldset.ds-choice-group` with a visible legend, a `.ds-choice-options` container, and one `label.ds-choice-card` per option. Each label contains its native radio, an `aria-hidden="true"` `.ds-choice-visual`, and `.ds-choice-copy` with a `.ds-choice-title` and `.ds-choice-description`. Checked state adds a mint boundary without changing geometry. Keyboard focus is immediate and outlines the full label; disabling the fieldset or an individual radio retains the visible selection. Use existing hints/errors and `aria-describedby` to explain unavailable choices or save failures. A layout selection changes presentation only; publication permission and save acceptance remain separate.

`profileLayoutPreview('studio' | 'field-notes')` creates the safe local structural SVG used by the Living studio and Field notes option cards. The thumbnails contain decorative blocks and geometry, with no private profile names, sample counts, activity claims, external assets, or parsed markup. Unknown values use the studio preview. The owner renders the normal DOM choice text; do not bake readable text into a scaled thumbnail. The options grid wraps automatically based on available room.

`highlightArt({ variant: 'orbit' | 'grid' | 'layers', label? })` returns static geometric SVG art using the shared palette. Unknown variants use orbit. It is hidden from accessibility by default; a deliberate label makes it an explanatory image. It has no motion, timestamps, progress, or status. Render it inside `.ds-highlight-visual` on `.ds-card.ds-highlight-card`, then use `.ds-highlight-content` for title, description, visible metadata, native disclosure, and optional public link actions. Neither art nor styling establishes an observed result. Only the owning public projection may provide deliberately approved highlight content or allowlisted resource references. Keep the link separate from the disclosure summary and preserve native expand/collapse behavior.

A `.ds-focus-row` uses a nonshrinking `.ds-focus-mark` and shrinkable `.ds-focus-content`. The label, title, description, and metadata classes share the same type and inset rules as panels. Use actual product marks with the existing inverse backplate where needed. A compact activity row may show only the logo, action, state and timestamp: give a logo-only identity its fixed public product name through an accessible label and title, and retain observed/reported provenance in accessible descriptive text and a title rather than repeating it visibly. Display state from the source; a generic summary row cannot establish that an agent is connected, working, or verified.

`statusText(label, { active, className })` keeps one actual readable label and adds an `aria-hidden` sheen whose duplicate letters come from a safe `data-text` attribute. The narrow clipped band and its counter-translated text animate only transform and opacity; the words never move and their solid base remains readable. It defaults to static until `observeLoadingMotion` sees an active visible label. Set `data-active` to `false` when work completes, fails or becomes overdue, and update `.ds-status-copy` plus `.ds-status-shine[data-text]` together if its label changes. No observer support, hidden/offscreen content, keyboard interaction, reduced motion and forced colors all retain static text. The `#status-text` gallery shows fresh, completed and reduced-motion component examples.

A `.ds-week-pulse` is a native ordered list with explicit `role="list"` (preserving Safari semantics with hidden markers), containing seven `.ds-week-day` items, each containing a `.ds-week-button`. Its `.ds-week-bar` contains a decorative `.ds-week-bar-fill`; set `--ds-pulse-ratio` through CSSOM to a finite clamped 0–1 ratio derived from the supplied counts. The fill uses a static transform with no animation. Show `.ds-week-label` and `.ds-week-count` text, and give each button its full UTC date and exact count in the accessible label. Use one roving tab stop, `aria-pressed` for the selected day, and immediate arrow/Home/End selection. Scroll the selected button into view at narrow widths; keep the 44px targets rather than squeezing or overlapping seven controls. Zero counts stay visibly zero. Loading, empty, and error states use the existing labeled pending, notice, and recovery patterns instead of invented chart data.

The `#profile-patterns` gallery includes both layout choices, a disabled-choice control, an expandable highlight and optional reference, ready/loading/empty/error examples, a focus row, and seven labeled fixed sample counts with keyboard navigation. These samples make no workspace changes and do not represent real activity.

### Heading rhythm

Wrap a heading, optional description and actions in `.ds-heading-group`. The label-to-title and title-to-body gaps are 12px; actions begin 20px after the preceding content. Hero groups may choose 20px or 24px shared spacing steps. Apply these values consistently instead of adding local ad hoc spacing. Cards and dialogs also apply the shared adjacent label/heading/body rhythm when no wrapper is needed. The gallery uses this pattern on every section heading and the dialog so a badge never touches its title.

When a Back action sits above the heading, wrap that row in `.ds-heading-label`. It is a layout container, not an HTML `label`. It participates in the same label-to-title spacing. Keep the heading reset low-specificity with `:where(...)`; a reset must never outrank the adjacent heading/body spacing rules. Verify computed margins as well as appearance, especially on narrow screens.

For source credits above a heading, use `.ds-attribution` with a quiet label and
`.ds-attribution-links` holding named native links. Use `.ds-product-logo` for an
unchanged mark and `.ds-attribution-avatar` for a fixed, bundled public author
photo; these credits do not use the user-upload profile helper or its allowlist.
Keep names visible if images are unavailable, and give each link an accessible
name identifying the credited product and author/provider. The hero credits Jev
by TypeSafe AI and gbrain by Garry Tan; this is source attribution, not customer
proof or a claim of endorsement. The gallery includes the full row and a narrow
text-only fallback. This static pattern has no pending or success state.

```html
<div class="ds-heading-group">
  <div class="ds-heading-label">
    <a href="/app#signin">Back to sign in</a>
  </div>
  <h2>Continue to your workspace.</h2>
  <p>Clear supporting instructions, with room to read them.</p>
</div>
```

### Card captions

Use `.ds-card-caption` for supporting text immediately below a card or card group. It adds 16px above the note and aligns its text with the card content. Its default inset follows the standard card's 24px padding. When a surface changes card padding, set `--ds-card-content-padding` on their shared parent and consume that value in the cards; the caption follows automatically. Marketing examples use 32px on desktop and 24px at widths up to 850px. The gallery includes this pattern. The marked-root selector preserves the gap over surface paragraph resets.

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
- **Focus:** the accent outline is always visible. Native keyboard actions remain immediate. Preserve focus, caret, drafts, and expanded content across polling and progress updates.

### Pending work and measured progress

`loadingState({ label, description, compact = false, lines = 0 })` creates a labeled `role="status"` region with `aria-busy="true"`. The full variant includes an indeterminate progressbar and up to five decorative skeleton lines; the compact variant stays an inline spinner and label. Choose a present-tense label such as “Loading workspace activity…” and an optional concise explanation. The operation owner replaces or settles the state as soon as the real request ends. Do not add a minimum loading delay, fake stages, or a successful result before acceptance.

`progressBar({ label, value, max = 100, valueText, className })` returns a named `role="progressbar"`. An omitted, null, or nonfinite value creates an indeterminate bar with no `aria-valuenow`. A finite value is clamped between zero and a positive max and updates the fill using transform; `setProgress(bar, options)` changes that same node so repeated measured updates preserve focus and identity. Supply `valueText` to expose a count and unit, such as “2 of 3 setup checks observed.” Keep the same count visible nearby. No amount is inferred from elapsed time. The helpers set only safe DOM text, attributes, and a bounded numeric CSSOM transform; they parse no HTML or stylesheet and fetch nothing.

Use one `observeLoadingMotion(root)` per mounted surface. It uses a single intersection observer and a mutation observer, without an animation-frame loop or timer, to pause registered spinner/skeleton/indeterminate motion while its element is offscreen or the document is hidden. Its returned disposer disconnects both observers and the visibility listener. Native hidden elements remain hidden. Reduced-motion preferences and keyboard input stop pending movement while labels, scaffold shapes, and a static indeterminate mark remain visible. The gallery’s local reduced-motion toggle changes only its controlled preview.

The memory drawer stays one pending read: `.memory-loading` is busy, its page-shaped scaffold uses shared skeleton lines, and its labeled delayed hint remains under the drawer’s request/timer lifecycle. It has no numeric progress or inferred content. The setup guide uses only `onboardingProgress(data).completed` against the three successful server-observed agent checks. If results are unavailable it says “Not checked yet”; a pending first check can show an indeterminate bar. Refreshing keeps any last confirmed count visible. The check control remains focusable with `aria-disabled` plus an enforced pending guard, so refreshing cannot move focus into another field or submit twice. Copying configuration or a prompt, creating a key, choosing an agent, and time passing never complete a step.

The `#feedback-states` gallery exposes idle/loading/success/error/disabled samples, visible keyboard focus, a reduced-motion preview, controlled measured counts, and a copied-state response without altering the clipboard or a workspace. Gallery waiting states are explicitly local demonstrations. The disclosure example exercises Enter/Space, accurate expanded state, and Escape focus return.

## Motion

The [Emil design-engineering skill](https://emilkowal.ski/skill) informs this system. Motion has a job: input feedback, a rare overlay transition, or an explanation that someone deliberately requests. Everyday navigation and repeated updates should feel still.

Use 120ms for a restrained pointer press at scale(.985) with opacity feedback, 180ms for an overlay/feedback transition, 220ms for an occasional response. The app's deprecated `memoryOrbit` entrance finishes once within 220ms. Motion transitions transform and opacity only. Hover and selected colors update immediately; keyboard controls remain immediate. Do not animate layout dimensions, use `transition: all`, add uncontrolled ambient loops, or replay card entrances when data refreshes. Controls keep hover positioning still; keyboard input skips action feedback through `data-input="keyboard"` and `:focus-visible`. Keep app code's input-mode tracking.

Decorative motion is not part of the system. The former context-flow illustrations and the moving logo ticker have been removed.

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
notices and buttons. Use one page introduction. Personal workspaces lead with the
creation form and outgoing snapshots; supporting explanations use a native
disclosure. Team workspaces lead with actions to open personal sharing or team
memory, followed by received approved excerpts. Empty and error states retain
those actions. Use the same cards and disclosures for approved text, and ordinary
compact buttons for refresh, pagination and workspace switching. No badge should
stand in for an action. Keep the natural-language instruction, recipient choice and
exact excerpt approval as separate steps with visible explanatory copy. Candidates
start unchecked. Label semantic suggestions and text fallback distinctly; neither
is an access grant. Excerpt edits can shorten source text, with errors beside the
field and a fresh-preview action for changed or expired sources. Pin requests to
the workspace and discard stale completions on navigation. Mask an isolated agent
credential, clear it on navigation, and offer explicit copy/replace actions. Use
status feedback for preview, approval, clipboard, replacement and revocation;
keep all actions keyboard immediate and stack controls at narrow widths.

Email-preference standalone header, action, and footer links use `.ds-touch-target` so the shared 44px mobile minimum applies alongside the native button targets.

## Handoffs composition

Activity's Handoffs section lists saved task records. It composes the existing
card, badge, activity switcher, search field, compact buttons, `evidenceList`,
`taskRecord`, disclosure toggle and notice primitives; `web/activity.css` owns
only its layout. Each card leads with the next step and one primary action,
**Copy continue prompt**, followed by a disclosure that lazily loads the record,
provenance, parallel-lineage warning and history. Delete uses an inline two-step
confirmation and an Undo notice instead of a browser dialog. Requests are pinned
to the workspace and discarded after navigation. Loading, empty, filtered-empty,
error and unavailable-storage states use the shared patterns. Buttons keep 44px
targets at narrow widths, and the view has no horizontal overflow at 320px.

## Computer approval composition

`#device` approves a terminal's sign-in request. `web/device-view.js` composes a
heading group, the confirmation code, an evidence-list of the request (computer,
agents with their local product marks on the shared `.ds-logo-backplate`, workspace and request time) and one
primary **Approve** beside a secondary **Deny**; `web/device.css` owns only its
layout. With no code it shows the setup command (`.ds-command`) and a labeled code
field. Loading, not found, expired, denied, already approved, connected, error,
approved and denied states use the shared notice, badge and loading patterns.
When a person has several workspaces, the native workspace select switches the
session's workspace with the existing switcher; approval is pinned to it. Copy
says that approval creates one key per agent in the approver's name. At ≤600px,
rows and actions stack with 44px targets and no horizontal overflow at 320px.
Connections leads with a "Connect this computer" panel that reuses `.ds-command`.
