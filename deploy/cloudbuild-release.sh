#!/usr/bin/env bash
# Cloud Build release: service + dream job + nightly schedule.
# TypeSafe/Voyage secrets are mounted when they exist; otherwise the gateway
# gets an explicit "unset" env and fails open. Missing provider keys must not
# block a main deploy.
set -euo pipefail

PROJECT="${PROJECT_ID:?PROJECT_ID is required}"
REGION="${REGION:-us-central1}"
IMAGE="gcr.io/${PROJECT}/engram:${BUILD_ID:?BUILD_ID is required}"
SA="engram-runtime@${PROJECT}.iam.gserviceaccount.com"
INSTANCE="${PROJECT}:${REGION}:engram-pg"

ensure_secret() {
  local name="$1"
  if ! gcloud secrets describe "$name" --project "$PROJECT" >/dev/null 2>&1; then
    if ! printf 'unset' | gcloud secrets create "$name" --project "$PROJECT" --data-file=-; then
      echo "[release] could not create secret ${name}; deploying without it"
      return 1
    fi
  fi
  gcloud secrets add-iam-policy-binding "$name" --project "$PROJECT" \
    --member="serviceAccount:${SA}" --role="roles/secretmanager.secretAccessor" >/dev/null \
    || echo "[release] accessor binding for ${name} already set or not grantable"
}

SECRETS="ENGRAM_DB_URL_TEMPLATE=engram-db-url-template:latest"
ENV_VARS="GBRAIN_HOMES_DIR=/tmp/gbrain-homes,ENGRAM_CLOUDSQL_INSTANCE=${INSTANCE},REFLEX_MODEL=jev-latest,ENGRAM_EMBEDDING_MODEL=voyage:voyage-4-large,ENGRAM_EMBEDDING_DIMENSIONS=1024"

if ensure_secret typesafe-api-key; then
  SECRETS+=",TYPESAFE_API_KEY=typesafe-api-key:latest"
else
  ENV_VARS+=",TYPESAFE_API_KEY=unset"
fi

if ensure_secret voyage-api-key; then
  SECRETS+=",VOYAGE_API_KEY=voyage-api-key:latest"
else
  ENV_VARS+=",VOYAGE_API_KEY=unset"
fi

echo "[release] secrets=${SECRETS}"
echo "[release] env=${ENV_VARS}"

gcloud run deploy engram \
  --project="$PROJECT" \
  --image="$IMAGE" \
  --region="$REGION" \
  --platform=managed \
  --allow-unauthenticated \
  --service-account="$SA" \
  --add-cloudsql-instances="$INSTANCE" \
  --set-secrets="$SECRETS" \
  --set-env-vars="$ENV_VARS" \
  --min-instances=0 \
  --max-instances=1 \
  --memory=2Gi \
  --cpu=1 \
  --timeout=900 \
  --execution-environment=gen2

gcloud run jobs deploy engram-dream \
  --project="$PROJECT" \
  --image="$IMAGE" \
  --region="$REGION" \
  --service-account="$SA" \
  --add-cloudsql-instances="$INSTANCE" \
  --set-secrets="$SECRETS" \
  --set-env-vars="${ENV_VARS},ENGRAM_JOB=dream" \
  --memory=2Gi \
  --cpu=1 \
  --task-timeout=900s \
  --max-retries=1

ENGRAM_PROJECT="$PROJECT" ENGRAM_REGION="$REGION" deploy/setup-scheduler.sh \
  || echo "[release] scheduler setup skipped (re-run deploy/setup-scheduler.sh)"
