# Google Maps Setup For WindowCalc

WindowCalc uses the Google Maps key from the Flask backend, not directly from browser-side Google SDK scripts.
That means browser referrer restrictions are not the right fit for this build.

## 1. Enable The APIs

```bash
export PROJECT_ID="YOUR_PROJECT_ID"

gcloud services enable places-backend.googleapis.com geocoding-backend.googleapis.com --project "$PROJECT_ID"
```

## 2. Create A Server-Side Key

```bash
gcloud alpha services api-keys create   --display-name="WindowCalc Maps Key"   --api-target=service=places-backend.googleapis.com   --api-target=service=geocoding-backend.googleapis.com   --project "$PROJECT_ID"
```

Copy the `keyString` from the command output.

## 3. Restrict It Correctly

Recommended restrictions for the current backend-proxy implementation:
- Application restrictions: `None`
- API restrictions:
  - `Places API (New)` / `places-backend.googleapis.com`
  - `Geocoding API` / `geocoding-backend.googleapis.com`

If you later move Cloud Run behind a fixed static egress IP, you can tighten this further with IP restrictions.

## 4. Store It In Secret Manager

```bash
echo -n "YOUR_GOOGLE_MAPS_KEY" | gcloud secrets create windowcalc-maps-key   --data-file=-   --project "$PROJECT_ID"
```

If the secret already exists:

```bash
echo -n "YOUR_GOOGLE_MAPS_KEY" | gcloud secrets versions add windowcalc-maps-key   --data-file=-   --project "$PROJECT_ID"
```

Grant the Cloud Run runtime service account access:

```bash
export RUN_SERVICE_ACCOUNT="windowcalc-run@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud secrets add-iam-policy-binding windowcalc-maps-key   --member="serviceAccount:$RUN_SERVICE_ACCOUNT"   --role="roles/secretmanager.secretAccessor"   --project "$PROJECT_ID"
```

## 5. Deploy With The Secret

```bash
export REGION="us-east1"
export SERVICE_NAME="windowcalc-app"
export INSTANCE_CONNECTION_NAME="${PROJECT_ID}:us-east1:windowcalc-db"
export DB_NAME="windowcalc"
export DB_USER="windowcalc_app"
export DB_PASSWORD_SECRET="windowcalc-db-password"
export SEED_DEMO_DATA="1"
export GOOGLE_MAPS_API_KEY_SECRET="windowcalc-maps-key"

chmod +x deploy.sh
./deploy.sh "$PROJECT_ID" "$REGION" "$SERVICE_NAME"
```

For a quick test-only deployment, you can set `GOOGLE_MAPS_API_KEY` directly before running `deploy.sh`, but Secret Manager is the recommended production path.

## 6. What Still Works Without The Key

Property appraiser lookup still works without the Maps key because Broward, Miami-Dade, and Palm Beach records are pulled from county/public appraiser endpoints.
Without the key:
- address autocomplete is disabled
- geocode verification falls back to manual entry
- property lookup can still run if the user enters a valid address manually

## 7. Verified County Sources In This Build

This package was updated against live official/public endpoints on March 11, 2026:
- Broward: BCPA web methods on `gisweb-adapters.bcpa.net`
- Miami-Dade: PA public proxy on `apps.miamidadepa.gov`
- Palm Beach: parcel lookup from `gis.pbcgov.org` plus summary parsing from `pbcpao.gov`
