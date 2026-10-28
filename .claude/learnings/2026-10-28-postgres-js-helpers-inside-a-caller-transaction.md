# Use a savepoint when a db helper that calls `begin` must run inside a caller's transaction

**Problem shape:** you want several writes (for example issuing a set of
access keys with `issueToken(..., db)`) to commit or roll back together with
a row you hold `FOR UPDATE`, and the helper accepts a `db` argument but calls
`db.begin(...)` internally. Passing the `tx` from `sql.begin(tx => ...)`
fails with `db.begin is not a function`.

**The procedure:**
1. In postgres.js, a `TransactionSql` has `savepoint` but no `begin`. In the
   helper, detect it: `typeof db.savepoint === "function"` → run the body in
   `db.savepoint(fn)`, otherwise `db.begin(fn)` (see `issueToken` in
   `gateway/src/auth.ts`).
2. In the caller, wrap the whole batch in one `tx.savepoint(async sp => ...)`
   and pass `sp` to each helper call. If any call throws, that savepoint rolls
   back every write in the batch while the outer transaction stays usable.
3. Catch the error outside the savepoint and record the outcome on the locked
   row (for example mark it denied) before the outer transaction commits.
4. Verify with a real-Postgres test that a mid-batch failure leaves zero rows
   from the batch (count by name) and that concurrent callers deliver once.

**Why this works / the trap it avoids:** calling the helper with the global
pool instead would commit each key in its own transaction, so a failure or a
concurrent poll can leave partial or duplicate credentials. Errors inside a
postgres.js scope also poison that scope, so the batch needs its own savepoint.

**Evidence:** `pollDeviceAuthorization` in `gateway/src/device-auth.ts`;
`test/integration-device-auth.ts` (concurrent polls, former-member approval), 28 Oct 2026.
