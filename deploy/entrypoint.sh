#!/usr/bin/env bash
# Container entrypoint. When ENGRAM_CLOUDSQL_INSTANCE is set (Cloud Run),
# start cloud-sql-proxy on 127.0.0.1:5432 and wait for it before the gateway.
# postgres.js cannot express a unix-socket path in URL form (the authority
# parser rejects it and ?host= is ignored), so TCP-via-proxy it is.
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

exec bun gateway/src/index.ts
