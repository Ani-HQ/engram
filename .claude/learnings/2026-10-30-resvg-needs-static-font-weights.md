# Give resvg static font cuts; it renders variable fonts at their default weight

**Problem shape:** a server-rendered SVG/PNG (OG card, email image) via
`@resvg/resvg-js` shows `font-weight="600"` text at regular weight, while the
same font looks right in the browser.

**The procedure:**
1. Prove it: render one SVG with the same text at weight 400 and 700 and compare
   the PNG. Identical strokes mean the weight axis is ignored.
2. Cut static instances from the variable font with fontTools:
   `fonttools varLib.instancer InterVariable.ttf wght=600 opsz=32 --update-name-table -o Inter-SemiBold.ttf`
   (install fontTools in a throwaway venv; it is not a project dependency).
3. Read the family name of the new file (name ID 1/16, e.g. "Inter Variable Display")
   and put it first in the SVG `font-family`.
4. Point resvg `fontDirs` at a directory holding only those static files plus the
   font license, and confirm the Docker build copies that directory.
5. Delete any cut the SVG never uses.

**Why this works / the trap it avoids:** resvg-js 2.6 picks fonts by family and
OS/2 weight class and does not apply variation axes, so a variable TTF always
renders at its default instance. Synthetic bold does not kick in either, so the
failure is silent.

**Evidence:** PR #82, `gateway/assets/card-fonts`, `renderShowcasePng`.
