# Agent identity visuals

Known agent products retain the locally bundled product logo returned by `agentVisual`. An explicit source controls product identity before any display-name hint. Unknown names and unknown sources receive a Boring Avatars Beam fallback, not an inferred provider logo. The name, source label, actual connection state, and reported/observed provenance remain separate UI text.

`agentVisual(name, { harness, sourceLabel, publicSafe })` returns a numeric local avatar seed only for an unknown agent. `visualIcon` renders that descriptor through `agent-avatar.js`. Activity, connections, task reporting, and public activity share this renderer. Tool and resource fallbacks retain their meaningful generic tool icons.

Private names produce a stable local visual variation. This hash is a cosmetic mapping, not anonymization, authentication, or a unique identity. It does not leave the browser or appear as SVG metadata. The renderer never parses markup, reads remote assets, or writes the input name into SVG nodes. Callers may explicitly supply an accessible label using the normal DOM attribute API; the default artwork is decorative.

Public callers must set `publicSafe: true` and pass only an allowlisted product as `harness`. The fallback then uses a constant seed regardless of name or source label, omits private aliases/initials, and preserves a known product's real logo. Public avatars must never distinguish people by a private alias or hash. This does not replace the server's public-data allowlist.

The shared `.ds-agent-avatar` component owns corners and display behavior; `--ds-avatar-1` through `--ds-avatar-5` and `--ds-avatar-face` own its fixed palette. The gallery demonstrates known logos and several private fallback variations. An avatar is decorative and never proves connection, access, activity, or success.

Pinned upstream source, adaptation notes, hashes, and the MIT copyright/license are in [vendor/boring-avatars/SOURCE.md](../web/vendor/boring-avatars/SOURCE.md). There is no verified claim that OpenAI uses this library.
