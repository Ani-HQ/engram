# Product Marketing Context

Draft for the local redesign review. Updated 30 October 2026.

## Product overview
Engram is a shared drive for agent context: a common place for memory pages, decisions and a readable history of work. Agents connect through MCP, save useful decisions and context, and recall it from another connected agent. The console shows memory pages and distinguishes observed Engram calls from external work reported by agents.

## Audience and jobs
For people who work across multiple AI coding and chat tools: independent builders, developers, and small teams. Keep project decisions across sessions; pick up a task in another agent; inspect what an agent saved and reported. This audience is inferred from the current product and repository, not customer research.

## Offer and conversion
Hosted access is a closed beta with single-use invite links and inbox verification. Operators may create an unbound link without collecting an email; the first verified email claims it, or an operator can explicitly restrict a code to a mailbox. Request an invitation at https://x.com/anirudh_twt; existing members sign in with email. Newly invited personal workspaces receive 60 days of unlimited core knowledge transfers from verified redemption, without a card, with a visible countdown and an extension link to the same X profile. Existing grants retain their original terms; do not use the removed sentence “Free early access until revoked.” as public promotional copy. Standard Cloud is $19 USD per workspace per month; public plan components must use the actual API catalog. Self-hosting is free under MIT.

## Differentiation and limits
Memory, activity and task reports are available together across MCP clients. Personal and team workspaces have scoped access and separate storage. Agent permissions and publishing are explicit. Engram does not silently monitor everything a user does; external work appears when an agent reports it. Saved keys alone do not prove successful agent setup. Do not promise universal automatic sync, perfect recall, compliance certifications, unlimited provider usage, or zero data processing by model providers.

## Voice and design
Playful, curious, confident, concrete. Expressive headlines and small moments of wit; plain action labels, billing explanations and errors. Visual language: the app is clear and alive, with real agent logos, one Lucide icon pack and functional motion (see "Rules" in docs/DESIGN-SYSTEM.md). Public pages follow a developer-platform look modeled on Supabase with Engram's mint accent and pulse mark: centered two-line heroes whose second line is mint, hairline spotlight cards, terminal windows, an example agent handoff, true-fact stats and a dot-grid closing call to action (the "Marketing kit"). One sans typeface (Inter) at normal letter-spacing; no italics or serif. The shared design system is the source for every frontend change.

## Evidence and unknowns
Use capabilities demonstrated by source and documented release checks. No public customer metrics, testimonials, customer logos, uptime SLA or comparative performance claims have been supplied. Do not invent them. Search traffic and Search Console access are unknown; do not claim measured SEO outcomes.

## User positioning refinement
The user describes an army of capable agents that are disconnected: Engram should feel like a shared hard drive or Dropbox for agents. Lead with sharing useful context across agents and selectively sharing it with a team; the shared-drive metaphor must be immediately grounded in memory pages, decisions and context, rather than implying arbitrary file sync or storage features that do not exist.

Personal memory and team memory are separate. The Sharing console accepts a natural-language instruction, proposes bounded excerpts, and requires explicit review and approval of each exact excerpt. Optional separately consented Jev processing can judge relevance; the labeled text-match fallback does not understand intent or exclusions. Approved snapshots go to an authorized team or a separate read-only agent bearer connection at /mcp/shared. New or edited source text is not added automatically. Existing full-workspace connections retain access unless separately disconnected or revoked. Legacy structured standing rules remain API-only and can copy matching entries/trails under their separate semantics. Within a team workspace, everyone authorized there can access its shared memory. The invitation request link text is simply “Ask for an invite” and points to the supplied X profile.
