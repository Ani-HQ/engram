# Verify generated assets shape-by-shape, and force real reloads in headless checks

**Problem shape:** you vendor assets with a script (icons, logos) and check the UI
with headless Chrome screenshots. The screenshots look plausible, but some assets
are subtly broken, or the page is still running the code from before your edit.

**The procedure:**
1. For generated data, write a test that compares the output to its source item by
   item: same number of shapes, same tags, every source attribute present. A gallery
   grid of every generated item is the fastest visual check; broken items stand out.
   (Here `/([a-z-]+)="/` dropped `x1`/`y2`, so `hash` rendered blank and `circle-alert`
   lost its lines; tests that only checked "the icon exists" passed.)
2. In a CDP screenshot script, navigate to `about:blank` before each target URL and
   enable `Network.setCacheDisabled`. Moving from `/app#activity` to `/app#connect`
   is a fragment navigation: the document and its ES modules stay loaded, so new code
   never runs and the screenshot shows the old UI.
3. Bring the page to front and enable focus emulation, or IntersectionObserver and
   timers look stalled.

**Evidence:** feat/app-logos-icons-motion (Lucide vendoring via scripts/vendor-lucide.ts,
brand catalog via scripts/brand-catalog.ts).
