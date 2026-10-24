#!/bin/sh
set -eu
# The Cloud Run sandbox helper logs its command arguments. Receive the scoped
# environment from a private file instead, remove it before starting any engine
# process, and leave stdin entirely available for the MCP protocol.
if [ "${1:-}" = "--engram-env-file" ]; then
  [ "$#" -ge 2 ] || exit 64
  env_file=$2
  shift 2
  exec /usr/local/bin/bun --eval '
    import { constants, openSync, fstatSync, readFileSync, closeSync, unlinkSync } from "node:fs";
    import { basename, dirname } from "node:path";
    try {
      const [file, entrypoint, ...args] = process.argv.slice(1);
      if (dirname(file) !== "/gbrain-work" || !/^\.engram-worker-env-[0-9a-f-]{36}\.json$/.test(basename(file))) throw new Error();
      const descriptor = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw;
      try {
        const stat = fstatSync(descriptor);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > 65536) throw new Error();
        raw = readFileSync(descriptor, "utf8");
      } finally { closeSync(descriptor); unlinkSync(file); }
      const env = JSON.parse(raw);
      const allowed = new Set(["HOME", "GBRAIN_HOME", "GBRAIN_DATABASE_URL", "TMPDIR", "PATH", "LANG", "LC_ALL", "NODE_ENV", "DO_NOT_TRACK", "VOYAGE_API_KEY", "ENGRAM_WORKER_CLOUDSQL_INSTANCE", "ENGRAM_WORKER_CLOUDSQL_TOKEN"]);
      if (!env || Array.isArray(env) || typeof env !== "object" || Object.entries(env).some(([key,value]) => !allowed.has(key) || typeof value !== "string" || value.includes("\0")) || env.HOME !== "/gbrain-work" || env.GBRAIN_HOME !== "/gbrain-work" || env.PATH !== "/usr/local/bin:/usr/bin:/bin") throw new Error();
      const child = Bun.spawn(["/bin/sh", entrypoint, ...args], { env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => child.kill(signal));
      process.exit(await child.exited);
    } catch {
      process.stderr.write("Worker environment bootstrap failed\n");
      process.exit(70);
    }
  ' -- "$env_file" "$0" "$@"
fi
cd "$HOME"
if [ -n "${ENGRAM_WORKER_CLOUDSQL_INSTANCE:-}" ]; then
  # This short-lived OAuth token belongs to a SQL-connect-only identity. The
  # sandbox cannot reach the parent metadata service or its stronger identity.
  cloud-sql-proxy --address=127.0.0.1 --port=5432 \
    --token="$ENGRAM_WORKER_CLOUDSQL_TOKEN" "$ENGRAM_WORKER_CLOUDSQL_INSTANCE" >/dev/null 2>&1 &
  proxy_pid=$!
  trap 'kill "$proxy_pid" 2>/dev/null || true' EXIT INT TERM
  ready=0
  for attempt in $(seq 1 30); do
    if /usr/local/bin/bun -e 'const s = await Bun.connect({hostname:"127.0.0.1",port:5432,socket:{data(){},open(s){s.end()},error(){process.exit(1)}}});' >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
  done
  if [ "$ready" != 1 ]; then exit 70; fi
fi
unset ENGRAM_WORKER_CLOUDSQL_TOKEN
/usr/local/bin/gbrain "$@"
