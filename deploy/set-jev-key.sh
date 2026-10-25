#!/usr/bin/env bash
# Store a provider key without putting it in chat, shell history or argv.
# This changes only Secret Manager; it does not deploy or send an AI request.
set -euo pipefail

engram_jev_clipboard=0
if [[ "${1:-}" == --clipboard ]]; then
  engram_jev_clipboard=1
  shift
fi
engram_jev_project="${1:-ani-hq}"
engram_jev_key=""
trap 'unset engram_jev_key engram_jev_ready' EXIT
if [[ ! "$engram_jev_project" =~ ^[a-z][a-z0-9-]{4,61}[a-z0-9]$ ]]; then
  printf 'Use a valid Google Cloud project ID.\n' >&2
  exit 64
fi
if ! command -v gcloud >/dev/null 2>&1; then
  printf 'gcloud is required. Sign in to the intended Google Cloud account first.\n' >&2
  exit 69
fi
if [[ "$engram_jev_clipboard" == 1 ]]; then
  if ! command -v /usr/bin/pbpaste >/dev/null 2>&1; then
    printf 'Clipboard mode requires macOS pbpaste.\n' >&2
    exit 69
  fi
  # Wait until after the command has been pasted/run: copying that command
  # replaces the clipboard, so reading it immediately would store the wrong text.
  if ! IFS= read -r -s -p 'Copy only your Jev API key now, then press Return here (do not paste it): ' engram_jev_ready </dev/tty; then
    printf '\nCould not read confirmation from your terminal.\n' >&2
    exit 1
  fi
  printf '\n' >/dev/tty
  if [[ -n "$engram_jev_ready" ]]; then
    printf 'Press Return without pasting at the confirmation prompt. Nothing was stored.\n' >&2
    exit 64
  fi
  if ! engram_jev_key="$(/usr/bin/pbpaste 2>/dev/null)"; then
    printf 'Could not read the clipboard. Nothing was stored.\n' >&2
    exit 1
  fi
else
  if ! IFS= read -r -s -p 'Paste your Jev API key, then press Return (input is hidden): ' engram_jev_key </dev/tty; then
    printf '\nCould not read a key from your terminal.\n' >&2
    exit 1
  fi
  printf '\n' >/dev/tty
fi
if [[ -z "$engram_jev_key" || "$engram_jev_key" == unset || "$engram_jev_key" =~ [[:space:]] ]]; then
  printf 'The key must be a single nonempty value without whitespace. Nothing was stored.\n' >&2
  exit 64
fi
engram_jev_flags=(--project "$engram_jev_project" --quiet --verbosity=error --no-log-http --format=none)
if gcloud secrets describe engram-jev-api-key "${engram_jev_flags[@]}" >/dev/null 2>&1; then
  printf '%s' "$engram_jev_key" | gcloud secrets versions add engram-jev-api-key --data-file=- "${engram_jev_flags[@]}"
else
  printf '%s' "$engram_jev_key" | gcloud secrets create engram-jev-api-key --replication-policy=automatic --data-file=- "${engram_jev_flags[@]}"
fi
unset engram_jev_key
printf 'Jev key saved in Secret Manager. No deployment or provider request was made.\n'
