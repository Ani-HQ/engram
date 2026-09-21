#!/usr/bin/env bash
# Cloud Scheduler -> Cloud Run Job for the nightly dream cycle.
set -euo pipefail

PROJECT="${ENGRAM_PROJECT:-ani-hq}"
REGION="${ENGRAM_REGION:-us-central1}"
SA="engram-scheduler@${PROJECT}.iam.gserviceaccount.com"
RUNTIME="engram-runtime@${PROJECT}.iam.gserviceaccount.com"
JOB="engram-dream"
SCHEDULER="engram-dream-nightly"

log() { echo "[setup-scheduler] $*"; }

gcloud services enable cloudscheduler.googleapis.com run.googleapis.com --project "$PROJECT"

if ! gcloud iam service-accounts describe "$SA" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud iam service-accounts create engram-scheduler \
    --project "$PROJECT" --display-name "engram dream scheduler"
fi

gcloud run jobs add-iam-policy-binding "$JOB" \
  --project "$PROJECT" --region "$REGION" \
  --member="serviceAccount:$SA" \
  --role="roles/run.invoker" >/dev/null || true

URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT}/jobs/${JOB}:run"

if gcloud scheduler jobs describe "$SCHEDULER" --location "$REGION" --project "$PROJECT" >/dev/null 2>&1; then
  gcloud scheduler jobs update http "$SCHEDULER" \
    --project "$PROJECT" --location "$REGION" \
    --schedule="0 3 * * *" \
    --time-zone="Asia/Kolkata" \
    --uri="$URI" \
    --http-method=POST \
    --oauth-service-account-email="$SA"
  log "updated $SCHEDULER"
else
  gcloud scheduler jobs create http "$SCHEDULER" \
    --project "$PROJECT" --location "$REGION" \
    --schedule="0 3 * * *" \
    --time-zone="Asia/Kolkata" \
    --uri="$URI" \
    --http-method=POST \
    --oauth-service-account-email="$SA"
  log "created $SCHEDULER"
fi

log "runtime account remains $RUNTIME; scheduler invokes the job, it does not hold the TypeSafe key."
