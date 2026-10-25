#!/usr/bin/env bash
# No IAM mutations, secret generation, automatic traffic activation or provider
# opt-in. Invoke with an approved image/backup and prepared least-privilege IAM.
set -euo pipefail
engram_project="${PROJECT_ID:?PROJECT_ID is required}"
engram_region="${REGION:-us-central1}"
engram_image="${ENGRAM_RELEASE_IMAGE:-gcr.io/${engram_project}/engram:${BUILD_ID:?BUILD_ID is required}}"
engram_command="${ENGRAM_RELEASE_COMMAND:-plan}"
engram_state="${ENGRAM_RELEASE_STATE:-release-state.json}"
engram_args=("$engram_command" --project "$engram_project" --region "$engram_region" --image "$engram_image" --state-file "$engram_state" --public-url "${ENGRAM_PUBLIC_URL:-https://engram.ani.computer}")
if [ -n "${ENGRAM_BACKUP_ID:-}" ]; then engram_args+=(--backup-id "$ENGRAM_BACKUP_ID"); fi
if [ -n "${ENGRAM_SMOKE_TOKEN_SECRET:-}" ]; then engram_args+=(--smoke-token-secret "$ENGRAM_SMOKE_TOKEN_SECRET"); fi
if [ "${ENGRAM_SMOKE_TOKEN_STDIN:-0}" = 1 ]; then engram_args+=(--smoke-token-stdin); fi
if [ "${ENGRAM_JEV_BILLING_ENABLED:-0}" = 1 ]; then engram_args+=(--jev-enable-customer-billing); fi
if [ -n "${ENGRAM_JEV_MARKUP_BPS:-}" ]; then engram_args+=(--jev-markup-bps "$ENGRAM_JEV_MARKUP_BPS"); fi
if [ -n "${ENGRAM_JEV_OPERATOR_MONTHLY_BUDGET_USD:-}" ]; then engram_args+=(--jev-operator-budget-usd "$ENGRAM_JEV_OPERATOR_MONTHLY_BUDGET_USD"); fi
exec python3 deploy/release.py "${engram_args[@]}"
