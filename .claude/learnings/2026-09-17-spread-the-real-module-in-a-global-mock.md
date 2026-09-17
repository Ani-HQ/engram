# When a test framework's module mock is process-global, spread the real module so a mock can only override exports, never drop them

**Problem shape:** a test fails with `X is not a function` / `X is undefined` where X
is a real export of a real module, the test passes when run alone, passes on your
machine, and fails somewhere else. Nothing about X is environment-dependent. Some
other test file mocks the module that exports X.

**The procedure:**
1. Grep every `mock.module` / `jest.mock` / `vi.mock` in the suite for the module
   named in the error. A factory that returns an object literal is the suspect.
2. Compare that literal's keys against the real module's exports. Any export the
   literal omits is deleted for every file evaluated after the mocking file, because
   these registries are process-global and are not unwound at file boundaries.
3. Fix by spreading, never by adding the one missing key:
   `const real = await import("../src/mod");`
   `mock.module("../src/mod", () => ({ ...real, thing: fake }))`.
   Adding the missing key fixes today's failure and leaves the trap armed for the
   next export anyone adds.
4. Apply it to every multi-export module the suite mocks, not just the one that
   failed. The others are the same bug waiting on a different file order.
5. Verify by running the suite in an environment that orders files differently from
   yours, not by re-running it where it already passed.

**Why this works / the trap it avoids:** the naive reading is "flaky test" or "CI
environment problem", so the fix attempted is a retry, a pin, or an env var. But the
mock is a global mutation with file-order-dependent blast radius, and file order is
decided by filesystem enumeration, which differs between your disk and a fresh
checkout. Spreading makes the mock incapable of subtraction, which removes the
order dependence rather than hiding it.

**Evidence:** engram, 2026-09-17. `web.test.ts` mocked the auth module with only
`authenticate`; `auth.test.ts` then imported the stub and `sha256` was undefined.
Passed locally for weeks and failed on the first Cloud Build run. See
[[2026-09-17-copy-the-tree-into-the-container-to-reproduce-ci]] for how it was
finally reproduced.
