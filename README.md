# WindowCalc - free and open source

A complete quoting platform for impact windows and doors: a Flask backend, a
vanilla JavaScript web app, and an Expo / React Native field app.

**It is released into the public domain. Take it, rip it apart, and use it
however you like** - commercially or not, whole or in pieces. No permission
needed, no strings attached.

**Credit:** WindowCalc was originally built by John Stephens. If it helps you, a
mention is appreciated - it is never required.

Built for Florida impact window and door dealers: design-pressure (DP) and
Miami-Dade NOA checks, margin governance with manager approvals, a product
catalog, county property lookups, job chat and customer texting, and an
offline-first field app. **Start with [GUIDE.md](GUIDE.md)** for a map of the
code and the ideas worth keeping.

---

## Run it

Needs Python 3.12.

```bash
python -m venv .venv
```

```bash
# Windows:  .venv\Scripts\activate      macOS / Linux:  source .venv/bin/activate
pip install -r requirements.txt
```

```bash
python run_local.py
```

Open http://127.0.0.1:8080. `run_local.py` keeps a SQLite database in `.local/`,
stores chat media on disk, and seeds demo data.

### Demo logins

Every demo account uses the password `Temp123!` and asks for a new one on first
sign-in.

| Role | Email |
|---|---|
| Sysop (platform admin) | `sysop@demo-dealer.example` |
| Owner | `mike@demo-dealer.example` |
| Manager | `sarah@demo-dealer.example` |
| Sales rep | `jordan@demo-dealer.example` |
| Viewer | `ashley@demo-dealer.example` |

A second demo company, *Seaside Impact Windows (Demo)*, is seeded as well, so
multi-tenant features have something to show. Its owner is
`leo@seaside-demo.example`. The sysop account belongs to both companies, so
signing in with it asks which company to open.

### Check it works

On Windows, `.\verify.ps1` compiles the Python, parses the web JavaScript, boots
the server on a throwaway database and checks the key routes. CI
(`.github/workflows/ci.yml`) runs the same on Linux for every push, plus a
Docker build, a mobile type-check and a scan for committed secrets.

## Mobile app

```bash
cd mobile
npm ci
cp .env.example .env
npm start
```

Set `EXPO_PUBLIC_API_BASE_URL` in `mobile/.env` to your backend. A phone cannot
reach `127.0.0.1` on your computer - use the computer's LAN address. More in
[mobile/SETUP.md](mobile/SETUP.md).

## Deploying

It runs anywhere a Python container runs. The included path is Google Cloud Run
with Cloud SQL (PostgreSQL):

- `Dockerfile` - `python:3.12-slim`, gunicorn
- `deploy.sh` - builds with Cloud Build and deploys to Cloud Run; all settings
  come from environment variables (run it with no arguments to see what it needs)
- [MAPS_SETUP.md](MAPS_SETUP.md) and [SMS_SETUP.md](SMS_SETUP.md) - Google Maps
  and Twilio setup

In production (`DB_BACKEND=postgres`, or running on Cloud Run):

- `APP_SECRET_KEY` is required - the app refuses to start without it.
- Demo data stays off unless `SEED_DEMO_DATA=1`.
- An account created or reset without a password gets a random temporary
  password, shown once to the admin who created it.

## Configuration

| Variable | Default / example | What it does |
|---|---|---|
| `PORT` | `8080` | HTTP port |
| `DB_BACKEND` | `sqlite` locally | `postgres` for production |
| `DB_PATH` | `/tmp/windowcalc.db` (`run_local.py`: `.local/windowcalc.db`) | SQLite file |
| `INSTANCE_CONNECTION_NAME` or `DB_HOST` / `DB_PORT` | `project:region:instance` | Cloud SQL socket, or a plain PostgreSQL host |
| `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `windowcalc`, `windowcalc_app` | PostgreSQL credentials |
| `APP_SECRET_KEY` | required in production | Session signing secret |
| `AUTH_COOKIE_SECURE` | `1` in production | HTTPS-only auth cookies |
| `SEED_DEMO_DATA` | `1` locally, `0` in production | Demo tenants, users, quotes, leads |
| `CHAT_MEDIA_STORAGE` | `local` or `gcs` | Where chat photos and videos go |
| `CHAT_MEDIA_BUCKET`, `CHAT_MEDIA_PREFIX` | `my-bucket`, `tenants` | GCS location when `gcs` |
| `CHAT_MEDIA_URL_MODE` | `proxy` | How media is served |
| `MAX_CHAT_ATTACHMENT_BYTES` | `26214400` | 25 MB upload limit |
| `GOOGLE_MAPS_API_KEY` | optional | Address autocomplete and geocoding |
| `ANTHROPIC_API_KEY` | optional | AI assistant and narrative generation |
| `PUBLIC_BASE_URL` | `https://your-app.example.com` | Public links, Twilio callbacks |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | optional | Customer SMS/MMS |
| `TWILIO_MESSAGING_FROM` or `TWILIO_MESSAGING_SERVICE_SID` | `+15555550100` | Sending number or service |
| `TWILIO_WEBHOOK_ENFORCE` | `1` | Verify Twilio webhook signatures |
| `MOBILE_SESSION_HOURS` | `720` in the old production setup | Field app session length |
| `NOTIFY_EMAIL`, `SMTP_EMAIL`, `SMTP_PASSWORD` | optional | Email alert for new demo requests (Gmail SMTP) |

`deploy.sh` also accepts `*_SECRET` variants (for example `DB_PASSWORD_SECRET`)
that pull values from Google Secret Manager instead of plain environment
variables.

## Layout

```
server.py           Flask API + web shell - all backend logic (see GUIDE.md)
pricing_engine.py   Pricing math, no database
static/             Web app: app.js, index.html, style.css, service worker
mobile/             Expo / React Native field app
run_local.py        Local run on SQLite with demo data
verify.ps1          Local smoke test (Windows)
deploy.sh           Google Cloud Run deploy
GUIDE.md            Map of the code and the domain
```

## License

Public domain, under [The Unlicense](LICENSE). Provided as is, with no warranty.

Manufacturer and product names in the demo catalog belong to their owners.
Catalog entries point at public Miami-Dade NOA records and are not verified
engineering or building-code data.
