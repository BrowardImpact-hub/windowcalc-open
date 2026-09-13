# WindowCalc - a map for taking it apart

Everything here was measured from the code at release. Use it to find the parts
worth keeping.

## The shape of it

| Piece | Where | What it is |
|---|---|---|
| Backend API + web shell | `server.py` | One Flask module: ~17,700 lines, 190 routes, 45 tables |
| Pricing math | `pricing_engine.py` | Pure functions, no database. `VERSION = "9.4e-1"` |
| Web app | `static/app.js`, `static/index.html`, `static/style.css` | Vanilla JavaScript single-page app (~11,900 + ~2,000 lines). No build step. |
| Field app | `mobile/` | Expo SDK 51 / React Native 0.74, TypeScript, expo-router, zustand, SQLite offline queue |

One process serves both the API and the web app. SQLite locally; PostgreSQL
(pg8000) in production. The same SQL runs on both through a thin adapter.

## Finding your way around `server.py`

It is one file with banner comments. Search for these headings:

| Search for | What is there |
|---|---|
| `# CONFIG` | Environment variables, database backend selection |
| `# DB HELPERS` | SQLite/Postgres adapter, schema and migrations (`SCHEMA_VERSION = 17`) |
| `# SEED DATA` | Demo tenants, users, products, quotes (local runs only) |
| `# TENANT + SESSION HELPERS` | Multi-tenant scoping, sessions, roles and permissions |
| `# BUSINESS LOGIC HELPERS` | Pricing wrappers, margin and governance, DP/NOA checks |
| `# GLASS OPTIONS` through `# LEAD TIME OVERRIDES` | Catalog admin: glass, frame colors, complexity items, consumables, assembly templates, DP ratings, global settings |
| `# GOVERNANCE` | Margin floors, approval thresholds, overrides |
| `# AUDIT LOG`, `# AUTH + SYSTEM + USERS` | Audit trail, login, sysop tools, user admin |
| `# GOOGLE MAPS + PROPERTY APPRAISER` | Address autocomplete; Broward, Miami-Dade and Palm Beach parcel lookups |
| `SECTION 5 — QUOTE FILE UPLOAD` | Attachments (local disk or Google Cloud Storage) |
| `SECTION 7A — AI ASSISTANT` | Optional Anthropic-backed assistant |
| `SECTION 8A`, `SECTION 8B` | Job chat read receipts, message templates |
| `ALPHA 9.4 — PRICING INTELLIGENCE CONSOLE` | Price analytics |
| `PART B: MARKETING / DEMO REQUESTS` | Landing-page lead capture and the lead inbox |
| `ALPHA 9.4 — REPORTS` | Margin trend, rep performance |
| `TIER 6: SHAREABLE PROPOSAL LINK` | Public proposal links (`/p/...`) |
| `TIER 6: PIPELINE KANBAN`, `BRANCHES`, `NOA DOCUMENT LIBRARY` | Pipeline board, multi-location, NOA PDFs |

Busiest API areas by route count: `/api/quotes` (30), `/api/system` (9),
`/api/master-products` (8), `/api/ai-pricing` (7), `/api/users`,
`/api/pricing-intelligence`, `/api/leads` (6 each). The mobile app uses
`/api/mobile/*` (session, offline bundle, sync events) plus a handful of
quote and opening routes - listed in `mobile/SETUP.md`.

## The ideas worth stealing

**Openings, not line items.** A quote is a set of openings: type (single hung,
horizontal roller, casement, fixed, sliding glass door, entry door and more),
width x height, floor level, wall type, product, glass, frame color and
complexity items. Mulled or multi-panel units come from assembly templates.
Each opening carries its own sell price, cost and margin.

**Design pressure (DP) and NOA checks that warn, never block.** Each product
carries DP ratings and a Miami-Dade Notice of Acceptance (NOA) number with an
expiry date. An opening is checked against the pressure its zone and size
require (`/api/validate-dp`, `/api/validate-noa`). A failure flags the opening
red; the quote still saves. Reps in the field must always be able to finish a
quote - an office can correct an opening later. Keep that rule if you keep the
feature.

**Margin governance.** Every tenant sets a margin floor and a warning
threshold. Reps move price inside server-computed bounds (price floor and
ceiling per opening, bulk adjust); going below the floor raises an approval
request to a manager. Once a proposal is delivered, its prices are frozen in a
snapshot, so later catalog changes never rewrite a sold job.

**A real product catalog.** `master_products` is seeded with impact products
from several manufacturers, each with NOA number, expiry, frame types, glass
and colors, and a link to the public Miami-Dade NOA PDF. Many physical specs
are marked `[DATA PENDING]` - treat the catalog as a starting structure, not
verified data.

**Property lookup.** Enter an address and the app pulls owner, folio and
building details from the county property appraiser (Broward, Miami-Dade,
Palm Beach). Useful for pre-filling jobs; those county endpoints change
without notice.

**Multi-tenant from day one.** Tenants, branches, roles (sysop, owner,
manager, rep, viewer), tiers, audit log, impersonation for support.

**Offline field app.** The phone downloads a bundle (quotes, products, colors,
glass) every 15 minutes, queues every change in SQLite while offline, and
replays the queue to `/api/mobile/sync/events` in batches of 50 when the
connection returns.

## Honest caveats

- **No unit tests.** `verify.ps1` and CI prove the app boots and answers; they
  do not prove a price is right. `pricing_engine.py` is the easiest place to
  start adding tests - it has no database dependency.
- **The zone logic deserves a second look.** DP validation follows each quote's
  required zone, but a later change enforced an HVHZ-only policy for field
  products, and a single hung size that is sold every day was once flagged
  wrongly. Read `validate-dp` before trusting a red flag.
- **Catalog data is from March 2026.** NOAs expire and get revised. Nothing
  here is engineering or building-code advice; check current NOAs.
- **Expo SDK 51 is old.** Upgrade before shipping a store build.
- **`static/index.html` includes the old SaaS marketing landing page**, pricing
  tiers and all. Keep it, rework it, or delete it.
- **Python 3.12 prints `datetime.utcnow()` deprecation warnings.** Harmless today.
