#!/usr/bin/env bash
# Run the same checks as .github/workflows/test.yml on this machine.
# Uses ENGRAM_TEST_DB_URL_TEMPLATE if set; otherwise starts a throwaway
# pgvector container on port 15432 and removes it at the end.
# Keep this file in step with the workflow (test/local-ci.test.ts checks it).
set -euo pipefail
cd "$(dirname "$0")/.."

container=""
cleanup() { [ -n "$container" ] && docker rm -f "$container" >/dev/null 2>&1 || true; }
trap cleanup EXIT

step() { printf '\n== %s\n' "$1"; }

if [ -z "${ENGRAM_TEST_DB_URL_TEMPLATE:-}" ]; then
  step "start PostgreSQL (pgvector/pgvector:pg16 on 15432)"
  container="engram-ci-pg-$$"
  docker run -d --name "$container" \
    -e POSTGRES_USER=engram_test -e POSTGRES_PASSWORD=engram_test \
    -e POSTGRES_INITDB_ARGS=--auth-host=scram-sha-256 \
    -e POSTGRES_HOST_AUTH_METHOD=scram-sha-256 -e POSTGRES_DB=engram_gateway \
    -p 15432:5432 pgvector/pgvector:pg16 >/dev/null
  for _ in $(seq 1 60); do
    docker exec "$container" pg_isready -h 127.0.0.1 -U engram_test -d engram_gateway >/dev/null 2>&1 && break
    sleep 1
  done
  export ENGRAM_TEST_DB_URL_TEMPLATE="postgresql://engram_test:engram_test@127.0.0.1:15432/__DB__"
fi

step "bun install --frozen-lockfile"; bun install --frozen-lockfile
step "bun test"; bun test

step "offline release, billing and edge automation"
python3 test/release-automation.py
python3 test/mail-infrastructure.py
python3 test/jev-billing-infrastructure.py
python3 test/jev-configuration.py
python3 test/stripe-jev-events.py
python3 test/jev-secret-setup.py
python3 test/billing-verification.py
python3 test/edge-configuration.py

step "real PostgreSQL tenant and billing isolation"; bun test/integration-postgres.ts
step "restricted PostgreSQL authority and external provisioning"; bun test/integration-tenant-security.ts
step "managed PostgreSQL provisioner without superuser"; bun test/integration-managed-provisioner.ts
step "no remote runtime assets in the console"; bun test/check-runtime-assets.ts
step "shim connect works without node_modules"; node shim/index.js connect --list

printf '\nAll CI checks passed.\n'
