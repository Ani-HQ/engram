# Agent product marks

The monochrome SVG subset is from `@lobehub/icons-static-svg` **1.98.0**,
Git commit `86b3f06ad9a4cc57011a56e5a7d3a5d4f1e8d835`:
https://github.com/lobehub/lobe-icons

Included unchanged: codex, grok, openai, gemini, cline, windsurf, goose, amp,
opencode and githubcopilot. The package is MIT licensed; see LOBE-LICENSE.
Trademark ownership remains with the respective products.

Devin uses `icons/devin.svg` from the same pinned package. Root sizing is
normalized to 24px and layout-only inline styling is removed; paths are unchanged.
Its npm SHA-512 integrity and original/vendored SHA-256 hashes are recorded in
`catalog-sources.json`. Product: https://devin.ai/ . MCP configuration reference:
https://docs.devin.ai/work-with-devin/mcp . The logo identifies the product;
compatibility through a custom MCP connection is distinct from an Engram-tested
Devin session or an endorsement.

OpenClaw and **Hermes Agent** are from the same pinned Lobe package. Their
catalog pages identify the products: https://icons.lobehub.com/components/open-claw
and https://icons.lobehub.com/components/hermes-agent . The Hermes Agent mark is
distinct from other unrelated products named Hermes. Root sizing is normalized
to 24px and layout-only inline styling is removed; paths are unchanged.

The additional tool marks use these pinned official `simple-icons` packages:

- **16.35.0**, commit `955f17f35634cd58de1748204059bce380d379af`:
  notion, linear, googledrive, googledocs, googlesheets, googlechrome, dropbox,
  postgresql, supabase, vercel and safari.
- **11.15.0**, commit `1b5de1079691ffd4b0f59376f8d02d30a96203b9`:
  slack, playwright, puppeteer, microsoftedge and microsoftoutlook.

Source: https://github.com/simple-icons/simple-icons . The packages use CC0-1.0;
see SIMPLE-ICONS-LICENSE. Root sizing is normalized to 24px and fill to
`currentColor`; paths are unchanged. The package archives were checked against
their npm SHA-512 integrity values before extraction. Exact upstream files,
package versions, integrity values, individual source/guideline links, and
original/vendored SHA-256 hashes are recorded in catalog-sources.json.

Simple Icons' disclaimer applies: https://github.com/simple-icons/simple-icons/blob/develop/DISCLAIMER.md .
Package licenses do not grant trademark rights or endorsement. These small
monochrome marks identify explicitly named tool namespaces. Slack's source and
brand guidance is https://slack.com/media-kit . No resource host, arbitrary
substring, user-provided asset URL, or remote avatar service selects a mark.

`grok-bot.png` is the original grayscale app icon supplied with Grok Bot
0.75.0 (`Contents/Resources/icon.icns`), converted to PNG without redrawing or
recoloring. Product and brand references:
https://x.ai/bot and https://x.ai/legal/brand-guidelines .
Grok Bot uses its own product mark, distinct from the general Grok mark.

Claude and Cursor continue to use the pinned local Simple Icons subset described
in ../simple-icons/SOURCE.md. No product image is loaded from an external host
at runtime. Marks identify a connection's configured or reported source and do
not indicate endorsement or a verified model.


## Muse and Instinct: official product assets

Retrieved on 25 October 2026 for named product identification in an illustrative
shared-memory diagram. These are original public product assets, not generated
or redrawn marks. They do not claim an Engram-tested MCP integration, partnership,
or endorsement. No open-source license grant is claimed for either asset;
copyright and trademark ownership stay with the respective product owners.

- **Muse** (`muse.svg`): the unchanged 100×100 app mark at
  https://muse.ai/images/favicon/app-squiggle.svg , linked as an SVG favicon by
  https://muse.ai/ . Product identity is corroborated by Meta's official page
  https://ai.meta.com/muse/ and announcement
  https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ , which
  links to muse.ai. The original gradient, geometry, dimensions and viewBox are
  preserved. SHA-256:
  `6373d89d274258a38432f3c3729cd716498b8ded849b174a7998683dcf4aaba5`.
- **Instinct** (`instinct.png`): the unchanged 64×64 icon at
  https://instinct.com/redesign/favicon.ico , linked by https://instinct.com/ .
  That upstream URL returns PNG bytes; only the local filename extension matches
  its actual format. The stick-figure artwork and white background are preserved.
  The product's terms identify Spear Street Technology, Inc. d/b/a Instinct:
  https://instinct.com/terms . Brand and content rights remain reserved there.
  SHA-256:
  `0b666ba5c89408ca2b9c790ce7bf65da063645ca60a5e06426461924b0c1fd08`.

Neither asset is covered by the LobeHub MIT or Simple Icons CC0 notices above.
Both load from local files at runtime; no visitor request goes to their source
websites.

## Additional ecosystem marks

Retrieved unchanged on 25 October 2026 for the public agent ecosystem list.
These examples are separate from the authenticated agent-source allowlist and
do not claim a tested MCP integration or endorsement.

- **Visual Studio Code** (`vscode.png`): official stable blue icon from
  https://code.visualstudio.com/assets/branding/code-stable.png . Brand guidance:
  https://code.visualstudio.com/brand . Original proportions and colors are
  preserved; Microsoft retains its trademark rights. SHA-256:
  `7ac29e00cd66e549acc2ea6a99a813f92cb23a6d165293be6959845670f0c5a4`.
- **Aider** (`aider.png`): original 180×180 app icon linked by the official
  website at https://aider.chat/assets/icons/apple-touch-icon.png . Project:
  https://github.com/Aider-AI/aider . The project is Apache-2.0 licensed;
  no separate trademark grant is claimed. SHA-256:
  `6efbd1fc700f455630b59d233aa37bfc764cffb0bcb255a42e73837f12497a2b`.

`web/public-agent-catalog.js` is the fixed public catalog. The homepage includes
every named console source, guided setup client and additional named diagram
example. Its "MCP support and setup vary by client" caption preserves the
distinction between an ecosystem product and verified Engram compatibility.
