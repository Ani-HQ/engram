# To reproduce an order-dependent failure from CI, copy the tree into the container — a bind mount preserves the host's file order and hides it

**Problem shape:** CI fails, you run the same command in the same image locally, and
it passes. You reach for the image tag, the runtime version, env vars, and network
differences. The failure depends on the order files are discovered in, so none of
those are it, and running it over a mounted working directory will never show it.

**The procedure:**
1. Before chasing versions or env, ask whether the failure could depend on file
   order: test-file discovery, glob expansion, `readdir` without an explicit sort,
   plugin or fixture loading.
2. Do not mount your working directory. A bind mount serves the host filesystem's
   ordering straight through, which is the ordering that already passes.
   `docker run -v "$PWD":/w -w /w` reproduces your disk, not CI.
3. Export a clean tree and let the container own it:
   `git archive HEAD | tar -x -C /tmp/clean`, then
   `docker run -v /tmp/clean:/src:ro <image> bash -c 'cp -r /src /app && cd /app && <cmd>'`.
   The copy creates fresh entries in the container's own filesystem, which is what
   a fresh CI checkout does.
4. Run it several times and record the ratio. An order-dependent bug is usually
   deterministic per filesystem layout, so expect all-pass or all-fail, not a
   scattering. A scattering means you are looking at something else.
5. Verify the fix under the same copied-tree conditions, and state both ratios. A
   fix proven only where the bug never appeared is not proven.

**Why this works / the trap it avoids:** "same image, same command, passes here" feels
like it rules the code out and points at the environment, so the investigation goes
to versions and configuration and stays there. The mount is the uncontrolled
variable, and it is invisible precisely because it is the thing you set up to make
the reproduction faithful.

**Evidence:** engram, 2026-09-17. Six runs over a bind mount passed; six runs over a
tree copied inside the image failed every time; six passed after the fix. The bug is
in [[2026-09-17-spread-the-real-module-in-a-global-mock]].
