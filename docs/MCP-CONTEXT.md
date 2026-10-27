# Bounded MCP memory

Engram's MCP boundary limits returned memory independently of the amount stored.
The authenticated REST APIs and web views still return complete pages and action
records. Retrieval snippets are untrusted reference data, not instructions.

## Wire limits

- Default maximum: **4,096 UTF-8 bytes per MCP tool-result envelope**, including
  JSON escaping, content blocks, and numeric usage metadata.
- Explicit request maximum: **16,384 bytes**. The request ceiling is clamped to
  1,024–16,384 bytes. No model/tool argument can remove the hard maximum.
- A configured task/run additionally shares a durable cumulative retrieval budget
  across gateway instances. Requests without a valid run ID have a per-response
  cap only; their metadata says `runScoped: false`.
- Small unchanged reads keep their existing content shape. Oversized results are
  projected into bounded summaries or an explicit error; serialized JSON is never
  cut in the middle. Huge identifiers are refused rather than changed into a
  different slug.
- All MCP write tools return small confirmed receipts. The gateway still runs the
  existing authorization, billing, workspace and atomic-write checks first.

These bytes are measured output, **not actual model tokens or billing**. Numeric
token estimates use UTF-8 bytes divided by four and must be labeled estimates.
Tool definitions, client prompts, and model-generated arguments are outside this
response measurement. Deferred tool loading should remain enabled where available.

Optional extractive recall results include `recall_passage` with only `offset`,
`length`, `total` and a lowercase SHA-256 `source_hash` of the full source chunk.
Coordinates are non-negative bounded integers in UTF-16 code units. The length
must equal the returned exact excerpt and cannot exceed 180 code units. Unknown
fields and malformed citations are omitted. Response compaction preserves the
entire cited excerpt or omits its row; it never shortens a cited span while
claiming its old coordinates. This describes a source span, not an independent
verification of the memory's claims.

## Task continuation

`checkpoint_task`, `find_tasks` and `resume_task` are bounded per response but do
not consume the cumulative per-task retrieval budget: an incoming agent must be
able to load its task even after earlier recall used that budget. Instead, every
save is measured at its actual `resume_task` envelope size, escaping included,
and refused with `record_too_large` if it would not fit the default 4,096-byte
response. A client with a smaller explicit budget receives a short
`context_too_small` control response naming the task and checkpoint, never a
shortened record. `find_tasks` drops whole candidates to fit.

## Request context

The HTTP transport reads request metadata separately from tool arguments:

```json
{
  "method": "tools/call",
  "params": {
    "name": "recall",
    "arguments": { "query": "retry policy" },
    "_meta": {
      "com.engram/context": { "runId": "task-opaque-id", "maxBytes": 4096 }
    }
  }
}
```

Reuse one run ID for the same substantive task. An adapter should not generate a
new run ID for every call. The first run budget is a ceiling; subsequent calls
cannot expand it by changing `maxBytes`. Start an explicit detail workflow with a
larger budget if needed. Output `_meta.engramContext` reports scope, measured
response bytes, estimated tokens, duplicate suppression and budget stops. A
budget-stop response contains a small control receipt with no retrieved memory;
its overhead remains measurable.

## Page reads and atomic updates

`get_page` accepts `offset`, `length`, and `cursor`. These MCP pagination fields
are removed before calling the storage engine. `offset` and `length` count UTF-16
code units, with boundaries kept on complete Unicode characters. Prefer the
returned `next_cursor` rather than calculating offsets.

An unpaged page that fits keeps its existing shape. Explicit pagination and large
pages return a fragment in `compiled_truth` and this metadata:

```json
{
  "content_hash": "full storage-page CAS hash",
  "body_hash": "SHA-256 of the entire compiled body",
  "compiled_truth": "returned fragment",
  "_page": {
    "offset": 0,
    "length": 500,
    "total": 1500,
    "unit": "utf16_code_units",
    "partial": true,
    "next_offset": 500,
    "next_cursor": "opaque versioned cursor",
    "warning": "Partial body. content_hash and body_hash identify the full version; never replace a page with this fragment."
  }
}
```

`length` is the actual returned fragment length. The byte cap may return less than
the requested length. A changed body invalidates its cursor, so a caller cannot
accidentally assemble different page versions. The storage `content_hash` remains
the full-page atomic guard; `body_hash` is independent of frontmatter. Approved
shared-context pages have `body_hash` and pagination but no writable storage hash.

**Never send a fragment back as the whole page.** Fetch and assemble all fragments
of one version before a full-page replacement, or use `remember` for append-only
decisions. Existing create-only/null and stale-hash rejection remain unchanged.

## Action history

MCP `list_actions` defaults to five summary rows, with a maximum of ten. Summaries
include stable ID, agent, operation, task/summary, status, evidence and time. They
omit action `detail`, resource bodies and the web app's potentially large facets.
`more` and `next_offset` reflect the number actually delivered after byte limits.
Reported actions remain labeled `reported`; direct Engram calls remain `observed`.

To read one detailed event, use its exact UUID or `audit:<number>` identifier:

```json
{ "id": "28c680a9-2338-452b-b275-2084c4b69457", "detail": true, "detail_offset": 0, "detail_length": 2000 }
```

Detail mode defaults to one row (maximum five). `_detail` supplies actual
`offset`, `length`, `total`, `next_offset`, `unit` and `partial`. Continue with
the same exact ID and the returned offset. The complete response still obeys the
request/run budget; asking for detail does not silently enlarge it. The exact-ID
filter stays inside the existing organization-filtered action ledger. Full web
and REST action responses are unchanged.
An offset inside a Unicode surrogate pair returns a bounded validation error;
use the previous response's `next_offset` to stay on a complete character boundary.

`record_action` returns only `{ok, id, status, evidence}` after a confirmed write.
`remember` retains its small `{ok, slug, appended, entry_id?, archived?}` receipt.
Remember input is limited to 8,192 UTF-8 bytes and topic names to 512 bytes;
oversized input is rejected before semantic routing or a write, with guidance to
save concise separate notes. Forwarded writes return `{ok, slug?, content_hash?}`.

## Verification

`test/mcp-context.test.ts` exercises adversarial Unicode/escaping, full-envelope
ceilings, huge identifiers/metadata, page reassembly and version changes,
re-projection after usage metadata, compact action history/detail pagination, and
confirmed write receipts. The isolated proxy suite checks limits at the actual
tool boundary, argument stripping, input rejection and the original access/hash
guards. `test/actions.test.ts` covers exact-ID validation alongside tenant filtering.
