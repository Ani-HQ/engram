# Boring Avatars · Beam

The fallback artwork is adapted from [Boring Avatars](https://github.com/boringdesigners/boring-avatars), by boringdesigners, under the included MIT license. It is not an OpenAI product or a product logo. We have no verified source establishing that OpenAI uses this library.

- Pinned commit: `d0ff2582a8921b643a89de4a4912be28938a828b`.
- [Beam source](https://github.com/boringdesigners/boring-avatars/blob/d0ff2582a8921b643a89de4a4912be28938a828b/src/lib/components/avatar-beam.tsx).
- [Shared utilities](https://github.com/boringdesigners/boring-avatars/blob/d0ff2582a8921b643a89de4a4912be28938a828b/src/lib/utilities.ts).
- [MIT license](https://github.com/boringdesigners/boring-avatars/blob/d0ff2582a8921b643a89de4a4912be28938a828b/LICENSE), copyright (c) 2021 boringdesigners.

`upstream/` contains exact source copies for review. `source.json` records their SHA-256 hashes and the license hash. Engram does not execute those TypeScript/React files or install a package at runtime.

`beam.js` is a small geometry-only adaptation. It accepts a bounded numeric seed, retains the upstream facial geometry and shape variation, and returns palette indexes instead of literal colors. `../../agent-avatar.js` renders those shapes with SVG DOM methods and the design system's fixed pastel palette. It replaces React and the mask ID with a clipped square SVG whose corners belong to the shared avatar component. It uses a local FNV-1a hash before the geometry generator rather than upstream's string hash. This is an adaptation of Beam, not a byte-for-byte port of its seed mapping.

No API service, CDN, URL seed, image upload, package runtime, or network request is used. Identifiers and hash values are never written into SVG IDs, labels, metadata, or URLs. Public fallback avatars use one fixed public seed rather than a private name. The MIT copyright and permission notice must remain with this adaptation.
