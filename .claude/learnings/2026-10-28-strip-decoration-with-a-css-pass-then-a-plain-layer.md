# Strip app decoration with a mechanical CSS pass, then one plain layer

**Problem shape:** a "make it plain" redesign across many layered app
stylesheets (style.css, per-surface CSS, then app-theme.css overriding all of
it), while another branch restyles the shared design-system primitives at the
same time, so the app must look right with either version of those primitives.

**The procedure:**
1. Run a small CSS rewriter over the app stylesheets that drops
   `letter-spacing`, `text-transform: uppercase`, `font-style: italic`,
   non-focus `box-shadow`, and every `border*` declaration whose selector is not
   a form control, button, focus state or select wrapper. Print every dropped
   declaration and read the list: wrappers that visually *are* a control's
   boundary (an embedded `<select>` inside `.workspace-picker`, a search wrapper
   using `:focus-within`) must be allow-listed.
2. Hand-rewrite the owning surface stylesheet (`app-theme.css`, the main list
   view) rather than layering more overrides on the mechanically edited rules.
3. Append one scoped "plain layer" (`html[data-design-system] ...`) that
   neutralizes shared containers (`.ds-card`, `.ds-panel`, `.ds-notice`,
   `.ds-badge`, `.ds-tabs`) inside the app, and stop *calling* decorative
   helpers (`statusBadge`, `memoryOrbit`, `sticker`, eyebrows) in markup. A tiny
   `statusLabel()` gives status as words, colored only for failure.
4. Verify with a CDP scan of computed styles (negative letter-spacing, italic,
   uppercase, non-form borders, overflow) at 1440/390/320 plus screenshots.

**Why this works / the trap it avoids:** editing primitives you do not own
collides with the parallel branch; relying on their current look breaks when
that branch lands. Scoped neutralization plus not calling decorative helpers is
correct under both. Selectors scoped to `.workspace` miss the detail `<dialog>`,
which lives outside it; scope shared row rules to `:is(.workspace, .detail)`.

**Evidence:** design/plain-app branch (PR "Plain app views").
