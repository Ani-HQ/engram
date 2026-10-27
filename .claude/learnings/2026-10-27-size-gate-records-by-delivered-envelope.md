# Size-gate a stored record by the exact response it will be read back in, not by its raw bytes

**Problem shape:** you store something (a record, note, payload) that must later
be returned through a bounded channel (MCP response cap, API budget). The spec
proposes "record ≤ N bytes" and the read cap is also about N bytes, or the read
path wraps the record in metadata and re-encodes it.

**The procedure:**
1. Write a function that builds the exact read response for a record (same
   wrapper, same metadata fields, same serialization the transport measures).
2. At save time, build that response with worst-case values for anything not
   yet known (fixed-width IDs and timestamps, the longer variant of any boilerplate).
3. Reject the save if `bytes(response) > readCap - transportReserve`; return the
   overshoot in bytes so the writer can shorten it.
4. On the read path, if a caller's budget is smaller than the default, return a
   short control response naming the record ID. Never truncate the record.
5. Test with quotes/backslashes (they double when JSON is embedded in a text
   field) and multibyte Unicode, and assert a maximal accepted record fits.

**Why this works / the trap it avoids:** raw JSON bytes undercount delivery.
MCP text content is JSON inside JSON, so every `"` and `\` costs twice, and
metadata adds hundreds of bytes. A record at the "raw" cap can be confirmed
saved yet never readable in one response.

**Evidence:** `gateway/src/continuation.ts` `assertResumable`, `test/continuation.test.ts`, PR #51.
