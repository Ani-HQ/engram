# Engram mark

The monochrome pulse is the app's shared-memory trace. Use this same mark for
the web app, connector identity, authorization page and browser icons. The
lowercase wordmark remains live text in the app, using the bundled Inter font.

`engram-mark.svg` is the source. Run `bun scripts/build-brand-assets.ts` to export
the 512px MCP PNG, 192px app PNG, Apple touch icon and multi-resolution favicon.
No third-party image service or credential is needed to load these public assets.

MCP clients receive PNG and SVG icon metadata; OAuth discovery includes registered
optional logo hints. Each client controls its own card layout, icon support and
cache. Publishing an icon does not guarantee that an existing connector refreshes
its cached identity immediately.
