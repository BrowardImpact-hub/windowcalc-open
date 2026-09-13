# Twilio SMS/MMS Setup For WindowCalc

WindowCalc supports real customer SMS/MMS inside the existing Job Hub thread.
Internal notes stay in-app. Customer texts flow through Twilio and land in the same quote message timeline.

## 1. What You Need

- a Twilio account
- one SMS-capable Twilio phone number or a Messaging Service
- the Twilio `Account SID`
- the Twilio `Auth Token`
- your deployed WindowCalc base URL, for example:

```bash
https://windowcalc-app-1234567890.us-east1.run.app
```

## 2. Store The Twilio Auth Token In Secret Manager

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export RUN_SERVICE_ACCOUNT="windowcalc-run@${PROJECT_ID}.iam.gserviceaccount.com"

echo -n "YOUR_TWILIO_AUTH_TOKEN" | gcloud secrets create windowcalc-twilio-auth-token \
  --data-file=- \
  --project "$PROJECT_ID"
```

If the secret already exists:

```bash
echo -n "YOUR_TWILIO_AUTH_TOKEN" | gcloud secrets versions add windowcalc-twilio-auth-token \
  --data-file=- \
  --project "$PROJECT_ID"
```

Grant the Cloud Run runtime identity access:

```bash
gcloud secrets add-iam-policy-binding windowcalc-twilio-auth-token \
  --member="serviceAccount:$RUN_SERVICE_ACCOUNT" \
  --role="roles/secretmanager.secretAccessor" \
  --project "$PROJECT_ID"
```

## 3. Set Twilio Environment Variables Before Deploy

Use either a dedicated phone number or a Messaging Service SID.

Phone number example:

```bash
export PUBLIC_BASE_URL="https://windowcalc-app-1234567890.us-east1.run.app"
export SMS_PUBLIC_MEDIA_TTL_SECONDS="3600"
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_AUTH_TOKEN_SECRET="windowcalc-twilio-auth-token"
export TWILIO_MESSAGING_FROM="+19545550100"
export TWILIO_WEBHOOK_ENFORCE="1"
```

Messaging Service example:

```bash
export PUBLIC_BASE_URL="https://windowcalc-app-1234567890.us-east1.run.app"
export SMS_PUBLIC_MEDIA_TTL_SECONDS="3600"
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_AUTH_TOKEN_SECRET="windowcalc-twilio-auth-token"
export TWILIO_MESSAGING_SERVICE_SID="MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_WEBHOOK_ENFORCE="1"
```

Notes:
- `PUBLIC_BASE_URL` is strongly recommended so Twilio can fetch signed MMS media URLs and webhook validation uses the public address.
- If you use a Messaging Service, WindowCalc stores the actual Twilio sender number after each outbound message so replies map back to the correct quote thread.

## 4. Configure The Inbound Webhook In Twilio

Set the incoming message webhook URL to:

```text
https://YOUR_PUBLIC_BASE_URL/api/webhooks/twilio/inbound
```

If you use a Twilio phone number:
- open the phone number in the Twilio Console
- under `Messaging`
- set `A message comes in` to `Webhook`
- paste the inbound URL above
- use `HTTP POST`

If you use a Messaging Service:
- open the Messaging Service
- configure the inbound request URL the same way

## 5. Deploy WindowCalc

```bash
export PROJECT_ID="YOUR_PROJECT_ID"
export REGION="us-east1"
export SERVICE_NAME="windowcalc-app"
export INSTANCE_CONNECTION_NAME="${PROJECT_ID}:us-east1:windowcalc-db"
export DB_NAME="windowcalc"
export DB_USER="windowcalc_app"
export DB_PASSWORD_SECRET="windowcalc-db-password"
export APP_SECRET_KEY_SECRET="windowcalc-app-secret"
export SEED_DEMO_DATA="1"
export RUN_SERVICE_ACCOUNT="windowcalc-run@${PROJECT_ID}.iam.gserviceaccount.com"

export CHAT_MEDIA_STORAGE="gcs"
export CHAT_MEDIA_BUCKET="${PROJECT_ID}-windowcalc-chat-media-prod"
export CHAT_MEDIA_PREFIX="tenants"
export CHAT_MEDIA_URL_MODE="proxy"
export MAX_CHAT_ATTACHMENT_BYTES="26214400"

export GOOGLE_MAPS_API_KEY_SECRET="windowcalc-maps-key"

export PUBLIC_BASE_URL="https://windowcalc-app-1234567890.us-east1.run.app"
export SMS_PUBLIC_MEDIA_TTL_SECONDS="3600"
export TWILIO_ACCOUNT_SID="ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
export TWILIO_AUTH_TOKEN_SECRET="windowcalc-twilio-auth-token"
export TWILIO_MESSAGING_FROM="+19545550100"
export TWILIO_WEBHOOK_ENFORCE="1"

chmod +x deploy.sh
./deploy.sh "$PROJECT_ID" "$REGION" "$SERVICE_NAME"
```

## 6. Supported MMS Types In This Build

For customer texting, WindowCalc currently accepts these MMS-friendly attachment types:
- JPG / JPEG
- PNG
- GIF
- MP4
- MOV

The in-app Job Hub can still hold more image/video formats, but the SMS/MMS send route is intentionally stricter so Twilio does not reject common sends.

## 7. Smoke Test Checklist

1. Log in as an owner, manager, or rep who can edit quotes.
2. Open a quote that has a valid customer phone number.
3. Open `Job Hub`.
4. Switch the composer from `Internal Note` to `Text Customer (SMS/MMS)`.
5. Send a plain SMS.
6. Send an MMS with an image or short video.
7. Reply from the customer phone and confirm the message appears in the same quote thread.
8. Confirm `/api/health` shows `twilio_enabled: true`.
9. Confirm media still loads after a new Cloud Run revision.
