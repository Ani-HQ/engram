# When gbrain search misses a page that provably exists, check the slug prefix against DEFAULT_HARD_EXCLUDES before debugging anything else

**Problem shape:** a page written to gbrain is readable by `get_page` and its
row/tsvector is visibly correct in Postgres, but `search`/`query` return empty
with `degraded: keyword_zero` — while near-identical pages in another brain or
another slug are found fine.

**The procedure:**
1. Read the missing page's slug. If it starts with `test/`, `attachments/`, or
   `.raw/`, that is the whole bug: `DEFAULT_HARD_EXCLUDES` in gbrain's
   `src/core/search/source-boost.ts` silently drops those prefixes from every
   search (union'd with `GBRAIN_SEARCH_EXCLUDE` env). Rename the page.
2. Only if step 1 clears: run the keyword SQL by hand
   (`SELECT slug FROM content_chunks cc JOIN pages p ON p.id=cc.page_id WHERE
   cc.search_vector @@ websearch_to_tsquery('english','<term>')`). A row here
   plus an empty search result means a post-SQL filter, not an index problem —
   grep the search pipeline for the degraded-reason string it printed.
3. Never name smoke-test pages `test/...`. Use `notes/...` or any
   non-excluded prefix, and put a unique marker token in the body to search for.

**Why this works / the trap it avoids:** the naive path diffs configs, homes,
env, tsvectors, and per-database state — all of which are identical — because
the exclusion happens as a WHERE clause built from a hardcoded constant, not
from any inspectable state. The degraded reason `keyword_zero` misleadingly
suggests an indexing failure. Checking the constant list first is free.

**Evidence:** engram v0 spike, 2026-08-15 — `test/engram-live` unfindable,
identical page as `notes/engram-launch` found instantly. See docs/SPIKE.md.
