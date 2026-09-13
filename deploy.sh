#!/usr/bin/env bash
# WindowCalc production Cloud Run deploy script (Cloud SQL PostgreSQL)
# Usage: ./deploy.sh [PROJECT_ID] [REGION] [SERVICE_NAME]

set -euo pipefail

PROJECT_ID="${1:-$(gcloud config get-value project 2>/dev/null)}"
REGION="${2:-us-east1}"
SERVICE_NAME="${3:-windowcalc-app}"
ARTIFACT_REPOSITORY="${ARTIFACT_REPOSITORY:-windowcalc}"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${ARTIFACT_REPOSITORY}/${SERVICE_NAME}"
INSTANCE_CONNECTION_NAME="${INSTANCE_CONNECTION_NAME:-}"
DB_NAME="${DB_NAME:-windowcalc}"
DB_USER="${DB_USER:-windowcalc_app}"
DB_PASSWORD="${DB_PASSWORD:-}"
DB_PASSWORD_SECRET="${DB_PASSWORD_SECRET:-}"
APP_SECRET_KEY="${APP_SECRET_KEY:-}"
APP_SECRET_KEY_SECRET="${APP_SECRET_KEY_SECRET:-}"
AUTH_COOKIE_SECURE="${AUTH_COOKIE_SECURE:-1}"
SEED_DEMO_DATA="${SEED_DEMO_DATA:-0}"
MOBILE_SESSION_HOURS="${MOBILE_SESSION_HOURS:-720}"
RUN_SERVICE_ACCOUNT="${RUN_SERVICE_ACCOUNT:-}"
CHAT_MEDIA_STORAGE="${CHAT_MEDIA_STORAGE:-gcs}"
CHAT_MEDIA_BUCKET="${CHAT_MEDIA_BUCKET:-}"
CHAT_MEDIA_PREFIX="${CHAT_MEDIA_PREFIX:-tenants}"
CHAT_MEDIA_URL_MODE="${CHAT_MEDIA_URL_MODE:-proxy}"
CHAT_MEDIA_SIGNED_URL_TTL_SECONDS="${CHAT_MEDIA_SIGNED_URL_TTL_SECONDS:-900}"
MAX_CHAT_ATTACHMENT_BYTES="${MAX_CHAT_ATTACHMENT_BYTES:-26214400}"
GOOGLE_MAPS_API_KEY="${GOOGLE_MAPS_API_KEY:-}"
GOOGLE_MAPS_API_KEY_SECRET="${GOOGLE_MAPS_API_KEY_SECRET:-}"
PUBLIC_BASE_URL="${PUBLIC_BASE_URL:-}"
SMS_PUBLIC_MEDIA_TTL_SECONDS="${SMS_PUBLIC_MEDIA_TTL_SECONDS:-3600}"
TWILIO_ACCOUNT_SID="${TWILIO_ACCOUNT_SID:-}"
TWILIO_AUTH_TOKEN="${TWILIO_AUTH_TOKEN:-}"
TWILIO_AUTH_TOKEN_SECRET="${TWILIO_AUTH_TOKEN_SECRET:-}"
TWILIO_MESSAGING_FROM="${TWILIO_MESSAGING_FROM:-}"
TWILIO_MESSAGING_SERVICE_SID="${TWILIO_MESSAGING_SERVICE_SID:-}"
TWILIO_WEBHOOK_ENFORCE="${TWILIO_WEBHOOK_ENFORCE:-1}"
ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}"
ANTHROPIC_API_KEY_SECRET="${ANTHROPIC_API_KEY_SECRET:-}"
MAINTENANCE_TOKEN="${MAINTENANCE_TOKEN:-}"

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: No GCP project set. Pass it as first argument or run: gcloud config set project YOUR_PROJECT_ID"
  exit 1
fi

if [[ -z "$INSTANCE_CONNECTION_NAME" ]]; then
  echo "ERROR: INSTANCE_CONNECTION_NAME is required. Example: my-project:us-east1:windowcalc-db"
  exit 1
fi

if [[ -z "$DB_NAME" || -z "$DB_USER" ]]; then
  echo "ERROR: DB_NAME and DB_USER are required."
  exit 1
fi

if [[ -z "$DB_PASSWORD_SECRET" && -z "$DB_PASSWORD" ]]; then
  echo "ERROR: Set DB_PASSWORD_SECRET (recommended) or DB_PASSWORD before deploying."
  exit 1
fi

if [[ -z "$APP_SECRET_KEY_SECRET" && -z "$APP_SECRET_KEY" ]]; then
  echo "ERROR: Set APP_SECRET_KEY_SECRET (recommended) or APP_SECRET_KEY before deploying."
  exit 1
fi

if [[ "$CHAT_MEDIA_STORAGE" == "gcs" && -z "$CHAT_MEDIA_BUCKET" ]]; then
  echo "ERROR: CHAT_MEDIA_BUCKET is required when CHAT_MEDIA_STORAGE=gcs."
  exit 1
fi

echo "=== WindowCalc Cloud Run Deploy ==="
echo "  Project:                $PROJECT_ID"
echo "  Region:                 $REGION"
echo "  Service:                $SERVICE_NAME"
echo "  Image:                  $IMAGE"
echo "  Artifact Repository:    $ARTIFACT_REPOSITORY"
echo "  Cloud SQL Instance:     $INSTANCE_CONNECTION_NAME"
echo "  Database:               $DB_NAME"
echo "  Database User:          $DB_USER"
echo "  Auth Cookie Secure:     $AUTH_COOKIE_SECURE"
echo "  Seed Demo Data:         $SEED_DEMO_DATA"
echo "  Chat Media Storage:     $CHAT_MEDIA_STORAGE"
echo "  Chat Media Bucket:      ${CHAT_MEDIA_BUCKET:-<local only>}"
if [[ -n "$APP_SECRET_KEY_SECRET" ]]; then
  echo "  App Secret:             Secret Manager (${APP_SECRET_KEY_SECRET})"
elif [[ -n "$APP_SECRET_KEY" ]]; then
  echo "  App Secret:             Direct env var"
fi
if [[ -n "$GOOGLE_MAPS_API_KEY_SECRET" ]]; then
  echo "  Google Maps Key:        Secret Manager (${GOOGLE_MAPS_API_KEY_SECRET})"
elif [[ -n "$GOOGLE_MAPS_API_KEY" ]]; then
  echo "  Google Maps Key:        Direct env var"
else
  echo "  Google Maps Key:        Disabled"
fi
if [[ -n "$RUN_SERVICE_ACCOUNT" ]]; then
  echo "  Service Account:        $RUN_SERVICE_ACCOUNT"
fi
if [[ -n "$TWILIO_AUTH_TOKEN_SECRET" ]]; then
  echo "  Twilio Messaging:       Secret Manager (${TWILIO_AUTH_TOKEN_SECRET})"
elif [[ -n "$TWILIO_ACCOUNT_SID" && ( -n "$TWILIO_MESSAGING_FROM" || -n "$TWILIO_MESSAGING_SERVICE_SID" ) ]]; then
  echo "  Twilio Messaging:       Direct env vars"
else
  echo "  Twilio Messaging:       Disabled"
fi
if [[ -n "$ANTHROPIC_API_KEY_SECRET" ]]; then
  echo "  Anthropic AI Key:       Secret Manager (${ANTHROPIC_API_KEY_SECRET})"
elif [[ -n "$ANTHROPIC_API_KEY" ]]; then
  echo "  Anthropic AI Key:       Direct env var"
else
  echo "  Anthropic AI Key:       ⚠ NOT SET — AI assistant will be disabled"
fi
echo ""

gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com storage.googleapis.com places-backend.googleapis.com geocoding-backend.googleapis.com --project "$PROJECT_ID"

if ! gcloud artifacts repositories describe "$ARTIFACT_REPOSITORY" \
  --location "$REGION" \
  --project "$PROJECT_ID" >/dev/null 2>&1; then
  echo "Creating Artifact Registry repository: $ARTIFACT_REPOSITORY"
  gcloud artifacts repositories create "$ARTIFACT_REPOSITORY" \
    --repository-format=docker \
    --location="$REGION" \
    --description="WindowCalc Docker images" \
    --project "$PROJECT_ID"
fi

echo "[1/4] Building and pushing Docker image..."
BUILD_TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
GIT_HASH="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
gcloud builds submit \
  --tag "$IMAGE" \
  --project "$PROJECT_ID" \
  .

ENV_VARS="DB_BACKEND=postgres,DB_NAME=${DB_NAME},DB_USER=${DB_USER},INSTANCE_CONNECTION_NAME=${INSTANCE_CONNECTION_NAME},AUTH_COOKIE_SECURE=${AUTH_COOKIE_SECURE},SEED_DEMO_DATA=${SEED_DEMO_DATA},CHAT_MEDIA_STORAGE=${CHAT_MEDIA_STORAGE},CHAT_MEDIA_BUCKET=${CHAT_MEDIA_BUCKET},CHAT_MEDIA_PREFIX=${CHAT_MEDIA_PREFIX},CHAT_MEDIA_URL_MODE=${CHAT_MEDIA_URL_MODE},CHAT_MEDIA_SIGNED_URL_TTL_SECONDS=${CHAT_MEDIA_SIGNED_URL_TTL_SECONDS},MAX_CHAT_ATTACHMENT_BYTES=${MAX_CHAT_ATTACHMENT_BYTES},PUBLIC_BASE_URL=${PUBLIC_BASE_URL},SMS_PUBLIC_MEDIA_TTL_SECONDS=${SMS_PUBLIC_MEDIA_TTL_SECONDS},TWILIO_ACCOUNT_SID=${TWILIO_ACCOUNT_SID},TWILIO_MESSAGING_FROM=${TWILIO_MESSAGING_FROM},TWILIO_MESSAGING_SERVICE_SID=${TWILIO_MESSAGING_SERVICE_SID},TWILIO_WEBHOOK_ENFORCE=${TWILIO_WEBHOOK_ENFORCE},MOBILE_SESSION_HOURS=${MOBILE_SESSION_HOURS},BUILD_DATE=${BUILD_TIMESTAMP},GIT_COMMIT=${GIT_HASH},MAINTENANCE_TOKEN=${MAINTENANCE_TOKEN}"
SECRET_VARS=()

if [[ -n "$DB_PASSWORD_SECRET" ]]; then
  SECRET_VARS+=("DB_PASSWORD=${DB_PASSWORD_SECRET}:latest")
else
  ENV_VARS="${ENV_VARS},DB_PASSWORD=${DB_PASSWORD}"
fi

if [[ -n "$APP_SECRET_KEY_SECRET" ]]; then
  SECRET_VARS+=("APP_SECRET_KEY=${APP_SECRET_KEY_SECRET}:latest")
else
  ENV_VARS="${ENV_VARS},APP_SECRET_KEY=${APP_SECRET_KEY}"
fi

if [[ -n "$GOOGLE_MAPS_API_KEY_SECRET" ]]; then
  SECRET_VARS+=("GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY_SECRET}:latest")
elif [[ -n "$GOOGLE_MAPS_API_KEY" ]]; then
  ENV_VARS="${ENV_VARS},GOOGLE_MAPS_API_KEY=${GOOGLE_MAPS_API_KEY}"
fi

if [[ -n "$TWILIO_AUTH_TOKEN_SECRET" ]]; then
  SECRET_VARS+=("TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN_SECRET}:latest")
elif [[ -n "$TWILIO_AUTH_TOKEN" ]]; then
  ENV_VARS="${ENV_VARS},TWILIO_AUTH_TOKEN=${TWILIO_AUTH_TOKEN}"
fi

if [[ -n "$ANTHROPIC_API_KEY_SECRET" ]]; then
  SECRET_VARS+=("ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY_SECRET}:latest")
elif [[ -n "$ANTHROPIC_API_KEY" ]]; then
  ENV_VARS="${ENV_VARS},ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}"
fi
DEPLOY_ARGS=(
  --image "$IMAGE"
  --platform managed
  --region "$REGION"
  --allow-unauthenticated
  --memory 512Mi
  --cpu 1
  --min-instances 1
  --max-instances 10
  --timeout 300
  --add-cloudsql-instances "$INSTANCE_CONNECTION_NAME"
  --set-env-vars "$ENV_VARS"
  --project "$PROJECT_ID"
)

if [[ -n "$RUN_SERVICE_ACCOUNT" ]]; then
  DEPLOY_ARGS+=(--service-account "$RUN_SERVICE_ACCOUNT")
fi

if (( ${#SECRET_VARS[@]} > 0 )); then
  DEPLOY_ARGS+=(--set-secrets "$(IFS=,; echo "${SECRET_VARS[*]}")")
fi

echo "[2/4] Deploying to Cloud Run..."
gcloud run deploy "$SERVICE_NAME" "${DEPLOY_ARGS[@]}"

echo "[3/4] Retrieving service URL..."
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region "$REGION" \
  --project "$PROJECT_ID" \
  --format "value(status.url)")

echo "[4/4] Verifying health endpoint..."
HTTP_STATUS="$(curl -s -o /tmp/windowcalc-health.json -w "%{http_code}" "${SERVICE_URL}/api/health" || true)"
if [[ "$HTTP_STATUS" != "200" ]]; then
  echo "ERROR: Health check failed with HTTP ${HTTP_STATUS:-<no response>}"
  cat /tmp/windowcalc-health.json 2>/dev/null || true
  exit 1
fi

echo ""
echo "=== Deploy complete ==="
echo "  Service URL: $SERVICE_URL"
echo "  App:         $SERVICE_URL/"
echo "  API health:  $SERVICE_URL/api/health"
cat /tmp/windowcalc-health.json 2>/dev/null || true
echo ""
echo "Make sure the Cloud Run service account has roles/cloudsql.client, roles/secretmanager.secretAccessor, and roles/storage.objectUser on the chat media bucket."
echo "If you use APP_SECRET_KEY_SECRET, grant the same runtime service account access to ${APP_SECRET_KEY_SECRET:-your app secret}."
echo "If you enable Google Maps via Secret Manager, grant the same runtime service account access to ${GOOGLE_MAPS_API_KEY_SECRET:-your maps secret}."
echo "If you enable Twilio via Secret Manager, grant the same runtime service account access to ${TWILIO_AUTH_TOKEN_SECRET:-your Twilio auth token secret}."
echo "If you enable Anthropic AI via Secret Manager, grant the same runtime service account access to ${ANTHROPIC_API_KEY_SECRET:-your Anthropic API key secret}."
