# Enforce visual "do not use" rules with computed-style scans, not eyeballing

**Problem shape:** a restyle removes whole categories of decoration (negative
tracking, italics, bordered containers, serif fonts) across many pages, and a
shared stylesheet plus legacy rules can quietly reintroduce them.

**The procedure:**
1. Change tokens and shared primitives first; keep deprecated class names
   working (restyled plainly) so other surfaces do not break mid-migration.
2. Add a source-level guard test (forbidden classes/markup in public HTML, no
   `letter-spacing: -` or `font-style: italic` in shared CSS).
3. In headless Chrome over CDP, walk every element and flag computed
   `letterSpacing` starting with `-`, `fontStyle: italic`, non-Inter families,
   and any visible, non-transparent border on elements that are not form
   controls or button-styled links (`.ds-button`, `.button`). Run at 1440, 768,
   390 and 320 with `Emulation.setEmulatedMedia` for both color schemes.
4. Look at the screenshots too: the scan cannot see contrast problems such as a
   surface-filled secondary button disappearing inside a surface-filled card.

**Traps:** a `.marketing-page :is(h1,h2,h3,p) { margin: 0 }` reset outranks a
single-class spacing rule, and `.marketing-page a { color: inherit }` outranks
a single-class link color; scope page rules under the same root class. A regex
like `ds-card\b` also matches `ds-card-caption`; use `(?![\w-])`.
Pick dev-server/CDP ports that are actually free (`lsof -iTCP:<port>`); another
agent may already hold the obvious ones.

**Evidence:** design/plain-marketing (plain marketing restyle).
