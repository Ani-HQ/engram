#!/usr/bin/env bash
# Activate managed billing after Engram-specific Stripe resources are configured.
# Only Secret Manager resource names appear in arguments, never secret values.
set -euo pipefail
engram_project="${ENGRAM_PROJECT:?Set ENGRAM_PROJECT}"
engram_region="${ENGRAM_REGION:-us-central1}"
engram_service="${ENGRAM_SERVICE:-engram}"
engram_public_url="${ENGRAM_PUBLIC_URL:?Set ENGRAM_PUBLIC_URL to the canonical HTTPS origin}"
python3 - "$engram_public_url" <<'PY'
import sys, urllib.parse
u = urllib.parse.urlsplit(sys.argv[1])
if u.scheme != 'https' or not u.netloc or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment or ',' in sys.argv[1]:
    raise SystemExit('ENGRAM_PUBLIC_URL must be a canonical HTTPS origin')
PY
engram_stripe_key="${ENGRAM_STRIPE_KEY_SECRET:-engram-stripe-secret-key}"
engram_stripe_webhook="${ENGRAM_STRIPE_WEBHOOK_SECRET:-engram-stripe-webhook-secret}"
engram_stripe_price="${ENGRAM_STRIPE_PRICE_SECRET:-engram-stripe-cloud-monthly-price-id}"
engram_stripe_portal="${ENGRAM_STRIPE_PORTAL_SECRET:-engram-stripe-portal-configuration-id}"
for engram_secret in "$engram_stripe_key" "$engram_stripe_webhook" "$engram_stripe_price" "$engram_stripe_portal"; do
  gcloud secrets versions describe latest --secret "$engram_secret" --project "$engram_project" --format='value(state)' | python3 -c 'import sys; s=sys.stdin.read().strip(); sys.exit(0 if s == "ENABLED" else "A billing secret has no enabled latest version")'
done
gcloud run services update "$engram_service" --project "$engram_project" --region "$engram_region" \
  --update-env-vars "ENGRAM_DEPLOYMENT_MODE=hosted,ENGRAM_DEV_LOGIN_LINKS=0,ENGRAM_INSECURE_COOKIE=0,ENGRAM_PUBLIC_URL=$engram_public_url" \
  --update-secrets "STRIPE_SECRET_KEY=$engram_stripe_key:latest,STRIPE_WEBHOOK_SECRET=$engram_stripe_webhook:latest,STRIPE_CLOUD_MONTHLY_PRICE_ID=$engram_stripe_price:latest,STRIPE_PORTAL_CONFIGURATION_ID=$engram_stripe_portal:latest"
# Scheduled jobs enforce the same subscription state as web/MCP writes.
gcloud run jobs update engram-dream --project "$engram_project" --region "$engram_region" \
  --update-env-vars "ENGRAM_DEPLOYMENT_MODE=hosted,ENGRAM_PUBLIC_URL=$engram_public_url" \
  --update-secrets "STRIPE_SECRET_KEY=$engram_stripe_key:latest,STRIPE_WEBHOOK_SECRET=$engram_stripe_webhook:latest,STRIPE_CLOUD_MONTHLY_PRICE_ID=$engram_stripe_price:latest,STRIPE_PORTAL_CONFIGURATION_ID=$engram_stripe_portal:latest"
