#!/usr/bin/env bash
# Idempotent GCP provisioning for engram in project ani-hq.
# Creates: Cloud SQL instance, scope + gateway databases, runtime SA,
# the DB-URL-template secret, and IAM bindings. Run once; re-runs are safe.
set -euo pipefail

PROJECT="${ENGRAM_PROJECT:-ani-hq}"
REGION="${ENGRAM_REGION:-us-central1}"
INSTANCE="engram-pg"
SA="engram-runtime@${PROJECT}.iam.gserviceaccount.com"

log() { echo "[setup-gcp] $*"; }

gcloud services enable sqladmin.googleapis.com run.googleapis.com \
  secretmanager.googleapis.com cloudbuild.googleapis.com --project "$PROJECT"

if ! gcloud sql instances describe "$INSTANCE" --project "$PROJECT" >/dev/null 2>&1; then
  log "creating Cloud SQL instance $INSTANCE (smallest tier, pg16)..."
  gcloud sql instances create "$INSTANCE" \
    --project "$PROJECT" --region "$REGION" \
    --database-version=POSTGRES_16 --tier=db-g1-small \
    --storage-size=10GB --storage-auto-increase
else
  log "instance $INSTANCE exists"
fi

if [ -z "${ENGRAM_DB_PASSWORD:-}" ]; then
  ENGRAM_DB_PASSWORD="$(openssl rand -base64 24 | tr -d '/+=')"
  log "generated new postgres password"
  gcloud sql users set-password postgres --instance="$INSTANCE" \
    --project "$PROJECT" --password="$ENGRAM_DB_PASSWORD"
fi

for db in brain_shared engram_gateway; do
  gcloud sql databases create "$db" --instance="$INSTANCE" --project "$PROJECT" 2>/dev/null \
    && log "created db $db" || log "db $db exists"
done

if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create engram-runtime \
    --project "$PROJECT" --display-name "engram Cloud Run runtime"
fi

gcloud projects add-iam-policy-binding "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/cloudsql.client" --condition=None >/dev/null
log "granted cloudsql.client to $SA"

TEMPLATE="postgresql://postgres:${ENGRAM_DB_PASSWORD}@/__DB__?host=/cloudsql/${PROJECT}:${REGION}:${INSTANCE}"
if ! gcloud secrets describe engram-db-url-template --project "$PROJECT" >/dev/null 2>&1; then
  printf '%s' "$TEMPLATE" | gcloud secrets create engram-db-url-template \
    --project "$PROJECT" --data-file=-
else
  printf '%s' "$TEMPLATE" | gcloud secrets versions add engram-db-url-template \
    --project "$PROJECT" --data-file=-
fi
gcloud secrets add-iam-policy-binding engram-db-url-template --project "$PROJECT" \
  --member="serviceAccount:$SA" --role="roles/secretmanager.secretAccessor" >/dev/null
log "secret engram-db-url-template ready and readable by $SA"

log "done. next: gcloud builds submit --config cloudbuild.yaml --project $PROJECT"
