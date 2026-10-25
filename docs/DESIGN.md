# Interface direction

The current visual language and contribution rules live in
[the design system](DESIGN-SYSTEM.md), with a working gallery at `/design-system`.
Every frontend change must reuse or contribute to that system. Warm paper, ink,
lime, lilac and orbital graphics connect the public website to the working app.
The interface separates private investigation from a public profile with counts
and an optional redacted activity stream. It uses self-hosted Inter, local SVG assets and system monospace for
identifiers, with no remote runtime scripts, fonts or icons.

For local review, run `bun web/dev-server.ts`. The public homepage is `/`, the
sample-data app is `/app`, and `/__review` shows those actual pages inside a
390×844 frame for responsive review. The frame shell exists only in the local
preview server. Production pages retain their restrictive frame policy.

## Brand identity

The canonical Engram mark is the monochrome pulse in
`web/brand/engram-mark.svg`. Derived local assets provide 512px and 192px PNGs,
SVG/ICO favicons and a 180px Apple touch icon; `site.webmanifest` uses the same
identity. Public anonymous GET/HEAD serves these files with explicit MIME types,
nosniff and no-cache. Logo assets permit cross-origin fetches without credentials;
missing branding paths return 404. No remote logo service is involved.

HTTP and stdio MCP identity share the Engram title, description and icon hints.
OAuth discovery uses canonical absolute logo URLs, and the authorization page
uses the same identity and shared design tokens. These are display
hints: receiving clients control their cards and caches, so published metadata
does not guarantee a refreshed connector logo or verify a caller's identity.

## Mobbin references

The references were searched and visually inspected through Mobbin:

- [Claude history](https://mobbin.com/screens/ad99258d-5421-4a4e-9b4b-432c690feb26):
  compact persistent navigation, quiet list separators, and search close to the
  records it filters. Applied to the workspace shell and activity/memory lists.
- [Perplexity account settings](https://mobbin.com/screens/57434cb1-86e5-42f0-b87c-953ca95cb33f):
  clear field grouping and restrained label/control hierarchy. Applied to
  connections and public-profile settings, without copying its colors or content.
- [ChatGPT group-link sheet](https://mobbin.com/screens/5644dad6-7adc-4a05-924f-550d3cbd770a):
  a concrete link, explicit audience information, and a clear copy action.
  Applied to publication status, public URLs, and portfolio embeds.
- [Browserbase agent execution log](https://mobbin.com/screens/38e3e1bc-2a5c-4f7b-aa64-00ab6f736224):
  a compact chronological rail, named tool calls, and expandable action details.
  Applied to expandable private task steps and their technical receipts.
  Colors and decorative treatments were not copied.

## Details

- Activity, Attention, Memory, Connections, Workspace, and owner-only Public profile and
  Plan & billing views.
- Search has a visible `/` shortcut; native selects retain keyboard behavior.
- Detail panels preserve focus and ignore stale requests after closing or
  switching workspace. Background refresh preserves focused activity controls
  and pauses for hidden pages and long paginated histories.
- Memory details open with a readable status, a bounded memory identifier and
  a page-shaped shimmer skeleton. A single long-wait note appears after eight
  seconds. The request has no fabricated stages, percentages or forced delay;
  closing or replacing the drawer clears its timer. Reduced-motion and forced
  colors keep the feedback static and legible.
- Initial data loads use stable skeleton rows. Asynchronous submissions disable
  their controls and show labeled spinners. Clipboard controls acknowledge copies.
- Empty, failed, signed-out, private-profile, and public-profile states have
  purposeful messages and next actions.
- Icons use one stroke weight and consistent sizing. Color never carries status
  alone: labels accompany result and visibility icons.
- Activity groups authenticated reports by a workspace-scoped shared run. Cards
  show contributors, fresh working reports, and local monochrome tool marks.
  Agent and tool chips filter whole activities while preserving all contributors.
- Activity opens on All activity: a chronological stream of task reports and
  observed memory calls. Tasks and Memory provide explicit filtered views. Filtering occurs on the server before pagination, while
  operations explicitly grouped with a task remain nested in that task.
- The drawer uses one content view: reported outcome/current step, relevant
  resources, optional method, then expandable chronological steps and technical
  receipts. Missing methods are omitted. Legacy memory calls receive factual
  operation descriptions and known targets without inventing intent or results.
- Connections store a separate display source so custom agent names can use their
  harness's mark. Owners can edit this source without changing access or the
  authenticated name. Registered and agent-reported sources remain distinct.
- Login uses the shared responsive auth composition, with a clear form and an
  illustrative memory graphic. Form controls, cards, focus and motion use the
  design system; circular status marks stay circular.
- Attention runs explicit, read-only checks through a workspace-scoped job queue.
  Findings distinguish deterministic rules from model judgments, link to cited
  action snapshots, and open the corresponding work log with the source highlighted.
  Confidence is labeled as model judgment strength, never a verified probability.
- Intent search identifies whether results use text matching or model ranking.
  Handoff briefs distinguish extractive records from generated text, retain source
  links, and show the checked action coverage and optional model provenance.
  Provider processing is off by default; Workspace shows consent and nonsecret
  operator configuration separately. The local demo uses the same deterministic
  analyzer and makes no external model calls.
- Memory separates saved context from a review queue. Proposal details show source
  text, related excerpts, and the exact relationship, tag, status, or cluster-page
  change before applying it. Defer and reject leave memory unchanged. Unsupported
  or incomplete changes cannot be approved, and the interface does not promise an
  undo or reopen operation that the review API does not provide.
- Private requests carry the workspace that created them. Requests from an old
  view are discarded after navigation, sign-out, dialog closure, or workspace
  switching. Attention results and review data never enter public aggregates.
- Live refresh preserves keyboard focus and expanded receipts, pauses on hidden
  pages, and continues for an open completed run so new contributions can appear.
  Long paginated histories explicitly explain when automatic refresh is paused.
- Pointer interactions use brief feedback and restrained drawer transitions.
  Polling never replays card entrance animations or moves running work out of
  chronological order. Status marks stay still; keyboard navigation is immediate,
  and reduced-motion settings remove decorative movement.
- The contribution grid has accessible labels, native tooltips, and arrow-key
  exploration. Counts use tabular numerals and the grid uses UTC dates.
- Mobile navigation stays visible and provides sign-out. Forms and previews stack
  without horizontal overflow. Reduced-motion settings disable decorative motion.

- Connections lists API keys and OAuth sign-ins, including retired credentials.
  Authorization, last recorded contact and actual working reports are distinct.
  The private inventory requires a human console session, follows the selected
  workspace, and never enters public profiles or the public stream. The optional
  public stream uses canonical product labels rather than connection aliases.
- Empty Tasks links to a reporting setup guide. Connection metadata distinguishes
  reconnect, read-only, no received reports and received reports; it never claims
  hooks are installed or an agent is working. The guide checks tool discovery,
  write access and an explicit real-task lifecycle. Copyable agent instructions
  remain a best-effort workflow, not automatic capture. In-dialog navigation
  restores focus, and existing notifiers/agent configurations are preserved.
- Emil Kowalski’s [design engineering skill](https://emilkowal.ski/skill) guides
  the density, purposeful motion, pointer-only hover and immediate keyboard input.
- Memory details use a wider620px reader with one title, quiet path/update
  metadata and Read/Source tabs. Valid dated journal bullets become compact
  disclosures with readable dates, verbatim excerpts, local search and eight-entry
  batches. Timed entries display newest first; journals containing date-only
  entries keep their labeled source order without inventing within-day timing.
  Exact source order always remains in Source and Copy. Intro/outro context keeps its position, date-only notes never acquire
  an invented time, and mixed lists/code remain ordinary documents. Long documents
  disclose actual top-level sections while preserving heading semantics. Parsing
  makes no model calls and generates no summaries or attributed intent.
- Memory's secondary Copy text control lives inside Source. The reader keeps
  its focus on the content; copying preserves the complete stored body.
- The reader uses native disclosures, keyboard tab navigation, visible focus,
  restrained chevrons and local contributor marks. Loading keeps focus inside
  the drawer, and following a linked memory starts at the top. Mobbin references
  informed the restrained document hierarchy and progressive disclosure:
  [Tana document](https://mobbin.com/screens/d1f5b0a9-80b1-49f0-88c6-cceb833fe0a7),
  [Plane guidelines](https://mobbin.com/screens/430341d2-3d7d-4741-83a5-1a7adcfc7369)
  and [Notion history](https://mobbin.com/screens/780626a3-20f5-4795-ac3b-bdbaef325210).

## Assets

[Lucide](https://lucide.dev/license) is ISC-licensed, with MIT attribution for
Feather-derived icons. The local `icon(name, options)` DOM helper lives in
`web/icons.js`; source SVGs and license notices are in `web/vendor/`.

[Inter](https://github.com/rsms/inter) uses the SIL Open Font License. The web app
uses its variable WOFF2; social-card rendering uses the bundled TTF. Both are
served locally, with their license in `web/vendor/LICENSE-inter.txt`.

[Simple Icons](https://github.com/simple-icons/simple-icons) provides a small
vendored CC0 subset for recognizable tooling marks. Source revisions, attribution,
and the license live in `web/vendor/simple-icons/`. Brand marks are display hints,
not verification of an agent's identity or tool execution.

Additional local monochrome product SVGs come from the pinned MIT-licensed
[Lobe Icons](https://github.com/lobehub/lobe-icons) subset. Grok Bot uses its
specific app mark. Sources and license notices are in `web/vendor/brands/`;
the browser never contacts a logo provider to render an agent.
