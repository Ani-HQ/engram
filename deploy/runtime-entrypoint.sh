#!/usr/bin/env bash
# Run only after the privilege-selecting entrypoint, including for job startup.
set -euo pipefail

if [ -n "${ENGRAM_CLOUDSQL_INSTANCE:-}" ]; then
  /usr/local/bin/cloud-sql-proxy "$ENGRAM_CLOUDSQL_INSTANCE" --port 5432 &
  for i in $(seq 1 60); do
    if (exec 3<>/dev/tcp/127.0.0.1/5432) 2>/dev/null; then exec 3>&-; break; fi
    [ "$i" = 60 ] && { echo "[entrypoint] cloud-sql-proxy never came up" >&2; exit 1; }
    sleep 0.5
  done
  echo "[entrypoint] cloud-sql-proxy ready" >&2
fi

if [ "${ENGRAM_JOB:-}" = dream ]; then
  exec bun gateway/src/jobs/dream.ts
fi
if [ "${ENGRAM_JOB:-}" = provision ]; then
  exec bun gateway/src/jobs/provision.ts
fi
exec bun gateway/src/index.ts
