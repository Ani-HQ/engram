#!/bin/sh
# Root is needed only by Cloud Run's host-side egress launcher. This wrapper
# also handles normal command overrides, so self-hosted CLI commands drop first.
set -eu

if [ "$#" -eq 0 ]; then set -- /usr/local/bin/engram-runtime; fi

engram_mode="${ENGRAM_DEPLOYMENT_MODE-self-hosted}"
case "$engram_mode" in
  hosted) engram_default_isolation=cloudrun ;;
  self-hosted) engram_default_isolation=process ;;
  *) echo "[entrypoint] invalid deployment mode" >&2; exit 64 ;;
esac
engram_isolation="${ENGRAM_WORKER_ISOLATION-$engram_default_isolation}"
case "$engram_isolation" in
  process|docker|cloudrun) ;;
  *) echo "[entrypoint] invalid worker isolation mode" >&2; exit 64 ;;
esac
case "${ENGRAM_JOB-}" in
  ''|dream|provision) ;;
  *) echo "[entrypoint] invalid job mode" >&2; exit 64 ;;
esac

if [ "$engram_isolation" = cloudrun ] && [ "${ENGRAM_JOB-}" != provision ]; then
  if [ "$(id -u)" != 0 ]; then
    echo "[entrypoint] Cloud Run sandbox networking requires a root launcher" >&2
    exit 78
  fi
  exec "$@"
fi

if [ "$(id -u)" = 0 ]; then
  exec /usr/bin/setpriv --reuid=1000 --regid=1000 --clear-groups --no-new-privs -- "$@"
fi
exec "$@"
