# Shared primitives must not depend on inline style attributes

**Problem shape:** a component looks right on public pages but renders as a
solid square or loses its delay on another page, with no console error and no
conflicting CSS rule.

**The cause:** the gateway sends `style-src 'self' 'unsafe-inline'`, but
`web/design-system.html` also has its own `<meta http-equiv>` CSP with
`style-src 'self'`. Inline `style="--icon:url(...)"` attributes are silently
dropped there, so the custom property is empty and the mask never applies.

**The procedure:**
1. When a shared primitive misbehaves on one page only, read
   `getComputedStyle(el).getPropertyValue('--var')` in the page (CDP
   `Runtime.evaluate`). An empty value next to a present `style` attribute means
   CSP blocked it.
2. `grep -o '<meta http-equiv[^>]*>' web/*.html` to find per-page policies.
3. Move the value into the stylesheet keyed by a data attribute
   (`.ds-icon[data-icon='brain'] { --icon: url(...) }`), or set it from a
   same-origin script through the CSSOM (`el.style.setProperty`), which CSP
   allows.
4. Guard it with a test: public pages contain no `style="`.

**Evidence:** Supabase-style marketing rebuild (feat/supabase-style-marketing).
Headless CDP screenshots also need `Page.bringToFront` and
`Emulation.setFocusEmulationEnabled`, or IntersectionObserver and timers look
stalled in a background tab.
