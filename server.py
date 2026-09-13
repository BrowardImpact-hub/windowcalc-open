#!/usr/bin/env python3
"""
WindowCalc Backend API — Alpha 9.4e
Schema version 16 — Bug fix overhaul: DB-backed rate limiting, AI key wired,
PWA cache fix, min-instances warm, build metadata, maintenance endpoint,
field/sunlight mode CSS, self-hosted fonts, Gunicorn 2 workers.
Mobile-first architecture groundwork sprint in progress.
"""

import base64
import csv
import io
import json
import html
import mimetypes
import os
import re
import sqlite3
import threading
import time
import uuid
import math
import urllib.request
import urllib.parse
import urllib.error
import hashlib
import hmac
import secrets
from decimal import Decimal
from datetime import datetime, timedelta
from functools import wraps

from flask import Flask, request, jsonify, send_from_directory, abort, g, make_response, Response, render_template_string, stream_with_context
from itsdangerous import URLSafeTimedSerializer, BadSignature, SignatureExpired

# Pricing engine — pure math module (no DB dependency, portable to React Native)
try:
    import pricing_engine as _pe
    _PRICING_ENGINE_VERSION = _pe.VERSION
except ImportError:
    _pe = None  # type: ignore
    _PRICING_ENGINE_VERSION = "unavailable"
from werkzeug.datastructures import FileStorage
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge
from werkzeug.utils import secure_filename

_gcs_storage = None
try:
    from google.cloud import storage as _gcs_storage
except Exception:
    _gcs_storage = None

_TwilioClient = None
_TwilioRequestValidator = None
try:
    from twilio.rest import Client as _TwilioClient
    from twilio.request_validator import RequestValidator as _TwilioRequestValidator
except Exception:
    _TwilioClient = None
    _TwilioRequestValidator = None

_AnthropicClient = None
try:
    import anthropic as _anthropic_module
    _AnthropicClient = _anthropic_module.Anthropic
except Exception:
    _AnthropicClient = None

# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

_db_backend_env = os.environ.get("DB_BACKEND", "").strip().lower()
if _db_backend_env:
    DB_BACKEND = _db_backend_env
elif os.environ.get("INSTANCE_CONNECTION_NAME") or os.environ.get("DB_HOST"):
    DB_BACKEND = "postgres"
else:
    DB_BACKEND = "sqlite"

IS_PRODUCTION_RUNTIME = bool(
    os.environ.get("K_SERVICE")
    or os.environ.get("GAE_ENV")
    or DB_BACKEND == "postgres"
)

DB_PATH = os.environ.get("DB_PATH", "/tmp/windowcalc.db")
DB_HOST = os.environ.get("DB_HOST", "").strip()
DB_PORT = int(os.environ.get("DB_PORT", "5432"))
DB_NAME = os.environ.get("DB_NAME", "windowcalc").strip()
DB_USER = os.environ.get("DB_USER", "").strip()
DB_PASSWORD = os.environ.get("DB_PASSWORD", "")
INSTANCE_CONNECTION_NAME = os.environ.get("INSTANCE_CONNECTION_NAME", "").strip()
# Demo tenants, users and quotes: on for local runs, off in production unless
# SEED_DEMO_DATA=1 is set explicitly.
SEED_DEMO_DATA = os.environ.get("SEED_DEMO_DATA", "0" if IS_PRODUCTION_RUNTIME else "1").strip().lower() in ("1", "true", "yes", "on")
# Known password for the seeded demo logins only (they must change it at first login).
DEMO_PASSWORD = "Temp123!"


def _generate_temp_password():
    """Random temporary password for accounts created or reset without one."""
    return "Wc-" + secrets.token_urlsafe(12)

SCHEMA_VERSION = 17
APP_VERSION = "Alpha 9.4e"
BUILD_DATE = os.environ.get("BUILD_DATE", "").strip()       # Set by CI/CD at build time
GIT_COMMIT = os.environ.get("GIT_COMMIT", "").strip()       # Set by CI/CD at build time
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
LOCAL_CHAT_MEDIA_ROOT = os.path.join(STATIC_DIR, "uploads", "job-messages")
MAX_APPROVAL_NOTE_LENGTH = int(os.environ.get("MAX_APPROVAL_NOTE_LENGTH", "1200"))
MAX_OWNER_NOTE_LENGTH = int(os.environ.get("MAX_OWNER_NOTE_LENGTH", "1200"))
MAX_JOB_MESSAGE_LENGTH = int(os.environ.get("MAX_JOB_MESSAGE_LENGTH", "1600"))
MAX_CHAT_ATTACHMENT_BYTES = int(
    os.environ.get(
        "MAX_CHAT_ATTACHMENT_BYTES",
        os.environ.get("CHAT_MEDIA_MAX_BYTES", str(25 * 1024 * 1024)),
    )
)
CHAT_MEDIA_BUCKET = os.environ.get("CHAT_MEDIA_BUCKET", "").strip()
CHAT_MEDIA_PREFIX = os.environ.get("CHAT_MEDIA_PREFIX", "tenants").strip().strip("/") or "tenants"
CHAT_MEDIA_STORAGE = os.environ.get("CHAT_MEDIA_STORAGE", "gcs" if CHAT_MEDIA_BUCKET else "local").strip().lower()
CHAT_MEDIA_URL_MODE = os.environ.get("CHAT_MEDIA_URL_MODE", "proxy").strip().lower()
CHAT_MEDIA_SIGNED_URL_TTL_SECONDS = int(os.environ.get("CHAT_MEDIA_SIGNED_URL_TTL_SECONDS", "900"))
GOOGLE_MAPS_API_KEY = os.environ.get("GOOGLE_MAPS_API_KEY", "").strip()
PUBLIC_BASE_URL = os.environ.get("PUBLIC_BASE_URL", "").strip().rstrip("/")
SMS_PUBLIC_MEDIA_TTL_SECONDS = int(os.environ.get("SMS_PUBLIC_MEDIA_TTL_SECONDS", "3600"))
TWILIO_ACCOUNT_SID = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
TWILIO_AUTH_TOKEN = os.environ.get("TWILIO_AUTH_TOKEN", "")
TWILIO_MESSAGING_FROM = os.environ.get("TWILIO_MESSAGING_FROM", "").strip()
TWILIO_MESSAGING_SERVICE_SID = os.environ.get("TWILIO_MESSAGING_SERVICE_SID", "").strip()
TWILIO_WEBHOOK_ENFORCE = os.environ.get("TWILIO_WEBHOOK_ENFORCE", "1").strip().lower() in ("1", "true", "yes", "on")
ANTHROPIC_API_KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MAX_FILE_UPLOAD_MB = int(os.environ.get("MAX_FILE_UPLOAD_MB", "25"))
AI_RATE_LIMIT_PER_HOUR = int(os.environ.get("AI_RATE_LIMIT_PER_HOUR", "20"))

# ---------------------------------------------------------------------------
# DB-BACKED RATE LIMITING (Alpha 9.4e — replaces in-memory threading.Lock dicts)
# Survives cold starts and works across multiple Cloud Run instances.
# ---------------------------------------------------------------------------

_LOGIN_MAX_ATTEMPTS = 10      # attempts before lockout
_LOGIN_WINDOW_SECONDS = 300   # 5-minute window

def _db_check_rate_limit(db, key: str, max_attempts: int, window_seconds: int) -> bool:
    """Return True if key is within limit, False if blocked.
    Purges expired entries before checking so the table stays lean."""
    cutoff = (datetime.utcnow() - timedelta(seconds=window_seconds)).isoformat()
    try:
        db.execute("DELETE FROM rate_limit_attempts WHERE key=? AND attempt_at < ?", (key, cutoff))
        db.commit()
    except Exception:
        pass
    try:
        row = db.execute(
            "SELECT COUNT(*) FROM rate_limit_attempts WHERE key=?", (key,)
        ).fetchone()
        count = row[0] if row else 0
        return count < max_attempts
    except Exception:
        return True  # Fail open — never lock users out due to a DB error

def _db_record_attempt(db, key: str):
    """Record one failed attempt for key."""
    try:
        db.execute(
            "INSERT INTO rate_limit_attempts (id, key, attempt_at) VALUES (?, ?, ?)",
            (f"rla-{uuid.uuid4().hex[:8]}", key, datetime.utcnow().isoformat()),
        )
        db.commit()
    except Exception:
        pass  # Non-fatal

def _db_clear_attempts(db, key: str):
    """Clear all recorded attempts for key on successful auth."""
    try:
        db.execute("DELETE FROM rate_limit_attempts WHERE key=?", (key,))
        db.commit()
    except Exception:
        pass  # Non-fatal

def _db_check_ai_rate_limit(db, uid: str) -> bool:
    """Return True if user is within the AI request limit, False if exceeded."""
    return _db_check_rate_limit(db, f"ai:{uid}", AI_RATE_LIMIT_PER_HOUR, 3600)

def _db_record_ai_attempt(db, uid: str):
    """Record one AI request for user."""
    _db_record_attempt(db, f"ai:{uid}")

CHAT_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".heic", ".heif"}
CHAT_VIDEO_EXTENSIONS = {".mp4", ".mov", ".webm", ".m4v", ".avi"}
CHAT_IMAGE_MIME_PREFIXES = ("image/",)
CHAT_VIDEO_MIME_PREFIXES = ("video/",)
TWILIO_MMS_ALLOWED_MIME_TYPES = {
    "image/gif",
    "image/jpeg",
    "image/jpg",
    "image/png",
    "video/3gpp",
    "video/mp4",
    "video/quicktime",
}

_pg_dbapi = None
try:
    import pg8000.dbapi as _pg_dbapi
except Exception:
    _pg_dbapi = None

_chat_storage_client = None
_twilio_client = None

DB_INTEGRITY_ERROR = (sqlite3.IntegrityError,)
if _pg_dbapi is not None:
    DB_INTEGRITY_ERROR = (sqlite3.IntegrityError, _pg_dbapi.IntegrityError)

APP_SECRET_KEY = os.environ.get("APP_SECRET_KEY", "").strip()
if not APP_SECRET_KEY:
    if IS_PRODUCTION_RUNTIME:
        raise RuntimeError("APP_SECRET_KEY must be set for production deployments.")
    APP_SECRET_KEY = "windowcalc-dev-secret-change-me"

app = Flask(__name__, static_folder=None)
app.config["SECRET_KEY"] = APP_SECRET_KEY
app.config["MAX_CONTENT_LENGTH"] = MAX_CHAT_ATTACHMENT_BYTES + (1024 * 1024)

PROPOSAL_HTML_TEMPLATE = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{ tenant.name or "WindowCalc Proposal" }}</title>
  <style>
    :root {
      --ink: #12202b;
      --muted: #5d6c78;
      --line: #d8e0e7;
      --brand: #0f766e;
      --paper: #ffffff;
      --bg: #f4f7fa;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: Arial, Helvetica, sans-serif;
      line-height: 1.45;
    }
    .page {
      max-width: 920px;
      margin: 24px auto;
      background: var(--paper);
      border: 1px solid var(--line);
      box-shadow: 0 12px 36px rgba(18, 32, 43, 0.08);
    }
    .action-bar {
      display: flex;
      gap: 12px;
      justify-content: flex-end;
      padding: 18px 22px 0;
    }
    .btn {
      border: 0;
      border-radius: 999px;
      background: var(--brand);
      color: #fff;
      padding: 10px 16px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn.secondary {
      background: #dce9e7;
      color: var(--ink);
    }
    .proposal-shell {
      padding: 24px;
    }
    .proposal-header {
      display: flex;
      justify-content: space-between;
      gap: 20px;
      border-bottom: 2px solid var(--ink);
      padding-bottom: 18px;
      margin-bottom: 22px;
    }
    .brand-mark {
      width: 56px;
      height: 56px;
      border-radius: 16px;
      background: rgba(15, 118, 110, 0.12);
      color: var(--brand);
      font-size: 28px;
      font-weight: 800;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .brand-wrap {
      display: flex;
      gap: 14px;
      align-items: flex-start;
    }
    .eyebrow {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.12em;
      color: var(--muted);
      font-weight: 700;
    }
    .company-name {
      font-size: 28px;
      font-weight: 800;
      letter-spacing: 0.02em;
      margin: 4px 0 6px;
    }
    .company-meta, .proposal-meta-sub {
      color: var(--muted);
      font-size: 13px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
      margin-bottom: 22px;
    }
    .meta-card {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 16px;
      background: #fcfdfd;
    }
    .meta-card h2 {
      margin: 0 0 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .meta-value {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 8px;
    }
    thead th {
      text-align: left;
      padding: 12px 10px;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      border-bottom: 1px solid var(--line);
      background: #f6faf9;
    }
    tbody td {
      padding: 12px 10px;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      font-size: 14px;
    }
    .dims, .opening-sub {
      color: var(--muted);
      font-size: 12px;
    }
    .price {
      text-align: right;
      white-space: nowrap;
      font-weight: 700;
    }
    .total-band {
      margin-top: 20px;
      border: 2px solid var(--ink);
      border-radius: 14px;
      padding: 16px 18px;
      display: flex;
      justify-content: space-between;
      gap: 20px;
      align-items: flex-end;
    }
    .total-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .total-value {
      font-size: 28px;
      font-weight: 800;
    }
    .footer-note {
      margin-top: 20px;
      color: var(--muted);
      font-size: 13px;
    }
    .signature-row {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 18px;
      margin-top: 34px;
    }
    .signature-line {
      border-top: 1px solid var(--ink);
      padding-top: 8px;
      font-size: 12px;
      color: var(--muted);
    }
    @media print {
      nav, .ribbon, .action-bar { display: none !important; }
      body { background: #fff; }
      .page {
        max-width: none;
        margin: 0;
        border: 0;
        box-shadow: none;
      }
      .proposal-shell { padding: 0; }
      table { page-break-inside: auto; }
      tr, td, th { page-break-inside: avoid; page-break-after: auto; }
      .meta-card, .total-band { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="page">
    <div class="action-bar">
      {% if share_url %}
      <a class="btn secondary" href="{{ share_url }}" target="_blank" rel="noopener">Open Shared Estimate</a>
      {% endif %}
      <button class="btn" type="button" onclick="window.print()">Print / Save PDF</button>
    </div>
    <div class="proposal-shell">
      <div class="proposal-header">
        <div class="brand-wrap">
          <div class="brand-mark">{{ brand_initial }}</div>
          <div>
            <div class="eyebrow">Proposal Snapshot</div>
            <div class="company-name">{{ tenant.name or "WindowCalc" }}</div>
            <div class="company-meta">
              {% if tenant.phone %}<div>Phone: {{ tenant.phone }}</div>{% endif %}
              {% if tenant.email %}<div>Email: {{ tenant.email }}</div>{% endif %}
              {% if tenant.address %}<div>{{ tenant.address }}</div>{% endif %}
              {% if tenant.license_number %}<div>License #: {{ tenant.license_number }}</div>{% endif %}
            </div>
          </div>
        </div>
        <div>
          <div class="eyebrow">Generated</div>
          <div class="meta-value">{{ generated_at_display }}</div>
          <div class="proposal-meta-sub">Snapshot ID: {{ snapshot_id }}</div>
        </div>
      </div>

      <div class="meta-grid">
        <div class="meta-card">
          <h2>Prepared For</h2>
          <div class="meta-value">{{ quote.customer_name or "-" }}</div>
          {% if quote.customer_phone %}<div class="proposal-meta-sub">{{ quote.customer_phone }}</div>{% endif %}
          {% if quote.customer_email %}<div class="proposal-meta-sub">{{ quote.customer_email }}</div>{% endif %}
        </div>
        <div class="meta-card">
          <h2>Job Site</h2>
          <div class="meta-value">{{ quote.job_address or "-" }}</div>
          <div class="proposal-meta-sub">Rep: {{ quote.rep_name or "-" }}</div>
          <div class="proposal-meta-sub">Valid Until: {{ valid_until_display }}</div>
        </div>
      </div>

      <table>
        <thead>
          <tr>
            <th>Opening</th>
            <th>Details</th>
            <th class="price">Sell Price</th>
          </tr>
        </thead>
        <tbody>
          {% for opening in openings %}
          <tr>
            <td>
              <strong>#{{ opening.number }}</strong><br>
              <span class="dims">{{ opening.type_label }}</span>
            </td>
            <td>
              <div><strong>{{ opening.product_name }}</strong></div>
              <div class="dims">{{ opening.dimensions }}</div>
              <div class="opening-sub">{{ opening.floor_label }}</div>
              {% if opening.noa_number %}<div class="opening-sub">NOA Ref: {{ opening.noa_number }}</div>{% endif %}
            </td>
            <td class="price">{{ opening.sell_price_display }}</td>
          </tr>
          {% endfor %}
        </tbody>
      </table>

      <div class="total-band">
        <div>
          <div class="total-label">Total Project Investment</div>
          <div class="proposal-meta-sub">This estimate is valid for 30 days.</div>
        </div>
        <div class="total-value">{{ total_price_display }}</div>
      </div>

      <div class="footer-note">
        This proposal snapshot is a frozen record of the quote at the time it was generated.
      </div>

      <div class="signature-row">
        <div class="signature-line">Customer Acceptance: __________________________</div>
        <div class="signature-line">Date: __________________________</div>
      </div>
    </div>
  </div>
</body>
</html>
"""

ESTIMATE_PORTAL_HTML_TEMPLATE = """
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{{ tenant.name or "Estimate" }}</title>
  <style>
    :root {
      --ink: #12202b;
      --muted: #61717d;
      --line: #d7e0e7;
      --brand: #0f766e;
      --accent: #174ea6;
      --bg: #f5f8fb;
      --paper: #ffffff;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: radial-gradient(circle at top, #eef7f5 0%, var(--bg) 46%, #edf2f6 100%);
      color: var(--ink);
      font-family: Arial, Helvetica, sans-serif;
    }
    .shell {
      max-width: 980px;
      margin: 28px auto;
      padding: 0 16px;
    }
    .card {
      background: var(--paper);
      border: 1px solid var(--line);
      border-radius: 20px;
      overflow: hidden;
      box-shadow: 0 18px 50px rgba(18, 32, 43, 0.08);
    }
    .hero {
      padding: 28px 28px 22px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(135deg, rgba(15, 118, 110, 0.08), rgba(23, 78, 166, 0.06));
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--muted);
      font-weight: 700;
    }
    .title {
      margin: 8px 0 6px;
      font-size: 32px;
      font-weight: 800;
    }
    .subtitle {
      color: var(--muted);
      font-size: 14px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 16px;
      padding: 22px 28px 0;
    }
    .meta-card {
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 16px;
      background: #fcfdfd;
    }
    .meta-card h2 {
      margin: 0 0 8px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .meta-value {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 4px;
    }
    .meta-sub {
      color: var(--muted);
      font-size: 13px;
    }
    .content {
      padding: 22px 28px 28px;
    }
    .section-title {
      margin: 0 0 12px;
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
    }
    .opening-list {
      display: grid;
      gap: 12px;
    }
    .opening-row {
      border: 1px solid var(--line);
      border-radius: 14px;
      padding: 14px 16px;
      display: grid;
      grid-template-columns: 1.2fr 2fr auto;
      gap: 12px;
      align-items: start;
      background: #fff;
    }
    .opening-row strong {
      display: block;
      margin-bottom: 3px;
    }
    .opening-sub {
      color: var(--muted);
      font-size: 12px;
    }
    .price {
      text-align: right;
      font-size: 18px;
      font-weight: 800;
      white-space: nowrap;
    }
    .total-band {
      margin-top: 18px;
      border: 2px solid var(--ink);
      border-radius: 16px;
      padding: 18px;
      display: flex;
      justify-content: space-between;
      gap: 16px;
      align-items: flex-end;
    }
    .total-label {
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--muted);
      margin-bottom: 6px;
    }
    .total-price {
      font-size: 32px;
      font-weight: 800;
    }
    .action-panel {
      margin-top: 20px;
      border: 1px solid var(--line);
      border-radius: 16px;
      padding: 18px;
      background: #fbfcfd;
    }
    .call-button, .portal-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      border: 0;
      padding: 11px 18px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      text-decoration: none;
      margin-right: 10px;
      margin-top: 10px;
    }
    .call-button, .portal-btn.primary {
      background: var(--brand);
      color: #fff;
    }
    .portal-btn.secondary {
      background: #dce6f7;
      color: var(--ink);
    }
    textarea {
      width: 100%;
      min-height: 96px;
      margin-top: 12px;
      border-radius: 12px;
      border: 1px solid var(--line);
      padding: 12px;
      font: inherit;
      resize: vertical;
    }
    .status {
      margin-top: 12px;
      color: var(--muted);
      font-size: 13px;
      min-height: 20px;
    }
    @media (max-width: 720px) {
      .meta-grid { grid-template-columns: 1fr; }
      .opening-row { grid-template-columns: 1fr; }
      .price { text-align: left; }
      .total-band { flex-direction: column; align-items: flex-start; }
    }
  </style>
</head>
<body>
  <div class="shell">
    <div class="card">
      <div class="hero">
        <div class="eyebrow">Customer Estimate</div>
        <div class="title">{{ tenant.name or "WindowCalc Estimate" }}</div>
        <div class="subtitle">Prepared by {{ quote.rep_name or "Your WindowCalc team" }} for {{ quote.customer_name or "your project" }}</div>
      </div>

      <div class="meta-grid">
        <div class="meta-card">
          <h2>Prepared For</h2>
          <div class="meta-value">{{ quote.customer_name or "-" }}</div>
          <div class="meta-sub">{{ quote.job_address or "-" }}</div>
        </div>
        <div class="meta-card">
          <h2>Estimate Details</h2>
          <div class="meta-value">Valid Until {{ valid_until_display }}</div>
          <div class="meta-sub">Generated {{ generated_at_display }}</div>
        </div>
      </div>

      <div class="content">
        <div class="section-title">Openings Included</div>
        <div class="opening-list">
          {% for opening in openings %}
          <div class="opening-row">
            <div>
              <strong>#{{ opening.number }} - {{ opening.type_label }}</strong>
              <div class="opening-sub">{{ opening.floor_label }}</div>
            </div>
            <div>
              <strong>{{ opening.product_name }}</strong>
              <div class="opening-sub">{{ opening.dimensions }}</div>
            </div>
            <div class="price">{{ opening.sell_price_display }}</div>
          </div>
          {% endfor %}
        </div>

        <div class="total-band">
          <div>
            <div class="total-label">Total Project Investment</div>
            <div class="meta-sub">This estimate is based on a frozen proposal snapshot.</div>
          </div>
          <div class="total-price">{{ total_price_display }}</div>
        </div>

        <div class="action-panel">
          <div class="section-title">Questions Or Next Steps</div>
          {% if call_phone %}
          <a class="call-button" href="tel:{{ call_phone }}">Questions? Call Us</a>
          {% endif %}
          <a class="portal-btn secondary" href="{{ print_url }}" target="_blank" rel="noopener">Print / Save PDF</a>

          {% if existing_response %}
          <div class="status">We already recorded your response: {{ existing_response.action_label }}{% if existing_response.responded_at_display %} on {{ existing_response.responded_at_display }}{% endif %}.</div>
          {% else %}
          <textarea id="response-note" placeholder="Add an optional note for the team"></textarea>
          <div>
            <button class="portal-btn primary" type="button" onclick="sendEstimateResponse('accept')">Accept Estimate</button>
            <button class="portal-btn secondary" type="button" onclick="sendEstimateResponse('request_changes')">Request Changes</button>
          </div>
          <div class="status" id="response-status"></div>
          {% endif %}
        </div>
      </div>
    </div>
  </div>

  {% if not existing_response %}
  <script>
    async function sendEstimateResponse(action) {
      const statusEl = document.getElementById('response-status');
      const note = document.getElementById('response-note').value.trim();
      statusEl.textContent = 'Sending your response...';
      try {
        const resp = await fetch('{{ response_endpoint }}', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, note })
        });
        if (!resp.ok) {
          throw new Error('Unable to save your response right now.');
        }
        statusEl.textContent = action === 'accept'
          ? 'Thank you. Your acceptance has been recorded.'
          : 'Thank you. Your request for changes has been recorded.';
      } catch (err) {
        statusEl.textContent = err.message || 'Unable to save your response right now.';
      }
    }
  </script>
  {% endif %}
</body>
</html>
"""


@app.errorhandler(404)
def handle_not_found(_e):
    return jsonify({"error": "Not found"}), 404

@app.errorhandler(405)
def handle_method_not_allowed(_e):
    return jsonify({"error": "Method not allowed"}), 405

@app.errorhandler(Exception)
def handle_unexpected_error(e):
    """Catch-all for unhandled exceptions — return clean JSON, never stack traces to client."""
    import traceback as _tb
    err_msg = f"Unhandled exception: {type(e).__name__}: {e}"
    app.logger.error(err_msg + "\n" + _tb.format_exc())
    # Don't expose internal details to client
    return jsonify({"error": "An internal error occurred. Please try again."}), 500


@app.errorhandler(RequestEntityTooLarge)
def handle_request_entity_too_large(_error):
    max_mb = max(1, round(MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024)))
    return jsonify({"error": f"Attachment exceeds {max_mb} MB limit"}), 413


@app.errorhandler(HTTPException)
def handle_http_exception(error):
    if request.path.startswith("/api/"):
        return jsonify({"error": error.description or error.name}), error.code
    return error

AUTH_COOKIE_NAME = "windowcalc_session"
AUTH_SESSION_HOURS = int(os.environ.get("AUTH_SESSION_HOURS", "12"))
AUTH_COOKIE_SECURE = os.environ.get(
    "AUTH_COOKIE_SECURE",
    "1" if IS_PRODUCTION_RUNTIME else "0",
).strip().lower() in ("1", "true", "yes", "on")

ROLE_HIERARCHY = ["viewer", "rep", "manager", "owner", "sysop"]
ALL_PERMISSIONS = [
    "can_access_admin_hub",
    "can_access_field_app",
    "can_view_dashboard",
    "can_view_products",
    "can_manage_products",
    "can_view_governance",
    "can_manage_governance",
    "can_view_approvals",
    "can_decide_approvals",
    "can_view_audit_log",
    "can_view_all_quotes",
    "can_create_quotes",
    "can_edit_quotes",
    "can_delete_openings",
    "can_submit_approval_requests",
    "can_view_margins",
    "can_set_discounts",
    "can_manage_users",
    "can_reset_passwords",
    "can_manage_feature_flags",
    "can_use_impersonation",
    "can_view_pricing_intelligence",
    "can_manage_pricing_intelligence",
    "can_view_cost_breakdown",
    "can_view_markup",
    "can_view_leads",
    "can_manage_leads",
    "can_export_leads",
]

def _perm_dict(enabled):
    return {k: (k in enabled) for k in ALL_PERMISSIONS}

ROLE_DEFAULT_PERMISSIONS = {
    "sysop": _perm_dict(set(ALL_PERMISSIONS)),
    "owner": _perm_dict({
        "can_access_admin_hub", "can_access_field_app", "can_view_dashboard", "can_view_products",
        "can_manage_products", "can_view_governance", "can_manage_governance", "can_view_approvals",
        "can_decide_approvals", "can_view_audit_log", "can_view_all_quotes", "can_create_quotes",
        "can_edit_quotes", "can_delete_openings", "can_submit_approval_requests", "can_view_margins",
        "can_set_discounts", "can_manage_users", "can_reset_passwords", "can_manage_feature_flags",
        "can_use_impersonation", "can_view_pricing_intelligence", "can_manage_pricing_intelligence",
        "can_view_cost_breakdown", "can_view_markup",
        "can_view_leads", "can_manage_leads", "can_export_leads",
    }),
    "manager": _perm_dict({
        "can_access_admin_hub", "can_access_field_app", "can_view_dashboard", "can_view_products",
        "can_manage_products", "can_view_governance", "can_view_approvals", "can_decide_approvals",
        "can_view_audit_log", "can_view_all_quotes", "can_create_quotes", "can_edit_quotes",
        "can_delete_openings", "can_submit_approval_requests", "can_view_margins", "can_set_discounts",
        "can_manage_users", "can_reset_passwords", "can_use_impersonation",
        "can_view_cost_breakdown", "can_view_markup",
    }),
    "rep": _perm_dict({
        "can_access_field_app", "can_view_products", "can_view_approvals", "can_create_quotes",
        "can_edit_quotes", "can_delete_openings", "can_submit_approval_requests", "can_view_margins",
        "can_set_discounts"
    }),
    "viewer": _perm_dict({
        "can_access_field_app", "can_view_products"
    }),
}

# ---------------------------------------------------------------------------
# CORS ? allow all origins (Cloud Run public endpoint)
# ---------------------------------------------------------------------------

@app.after_request
def add_cors_and_security_headers(response):
    # CORS — Cloud Run public endpoint
    response.headers["Access-Control-Allow-Origin"]  = "*"
    response.headers["Access-Control-Allow-Methods"] = "GET,POST,PUT,DELETE,OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = "Content-Type,Authorization"
    # Security hardening headers
    response.headers["X-Content-Type-Options"]  = "nosniff"
    response.headers["X-Frame-Options"]         = "SAMEORIGIN"
    response.headers["Referrer-Policy"]         = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"]      = "geolocation=(), microphone=(), camera=()"
    # Only set HSTS on HTTPS — Cloud Run always serves HTTPS in production
    if request.is_secure or request.headers.get("X-Forwarded-Proto") == "https":
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return response

@app.route("/api/<path:path>", methods=["OPTIONS"])
@app.route("/api", methods=["OPTIONS"])
def options_handler(path=""):
    return "", 204


# ---------------------------------------------------------------------------
# DB HELPERS
# ---------------------------------------------------------------------------

def _split_sql_statements(script):
    statements = []
    current = []
    in_single = False
    in_double = False
    escape = False
    for char in script:
        current.append(char)
        if escape:
            escape = False
            continue
        if char == "\\":
            escape = True
            continue
        if char == "'" and not in_double:
            in_single = not in_single
        elif char == '"' and not in_single:
            in_double = not in_double
        elif char == ";" and not in_single and not in_double:
            statement = ''.join(current).strip()
            if statement:
                statements.append(statement[:-1].strip() if statement.endswith(';') else statement)
            current = []
    tail = ''.join(current).strip()
    if tail:
        statements.append(tail)
    return statements


def _rewrite_qmark_sql(query):
    out = []
    in_single = False
    in_double = False
    escape = False
    for char in query:
        if escape:
            out.append(char)
            escape = False
            continue
        if char == "\\":
            out.append(char)
            escape = True
            continue
        if char == "'" and not in_double:
            in_single = not in_single
            out.append(char)
            continue
        if char == '"' and not in_single:
            in_double = not in_double
            out.append(char)
            continue
        if char == '?' and not in_single and not in_double:
            out.append('%s')
            continue
        out.append(char)
    return ''.join(out)


class CompatRow:
    def __init__(self, columns, values):
        self._columns = list(columns or [])
        self._values = tuple(values or ())
        self._mapping = {name: self._values[idx] for idx, name in enumerate(self._columns)}

    def __getitem__(self, key):
        if isinstance(key, int):
            return self._values[key]
        return self._mapping[key]

    def get(self, key, default=None):
        return self._mapping.get(key, default)

    def keys(self):
        return list(self._columns)

    def items(self):
        return self._mapping.items()

    def values(self):
        return self._mapping.values()

    def __iter__(self):
        return iter(self._values)

    def __len__(self):
        return len(self._values)

    def __repr__(self):
        return repr(self._mapping)


class PostgresCursorWrapper:
    def __init__(self, cursor):
        self._cursor = cursor
        self._columns = []

    def execute(self, query, params=None):
        params = tuple(params or ())
        self._cursor.execute(_rewrite_qmark_sql(query), params)
        self._columns = [col[0] for col in self._cursor.description] if self._cursor.description else []
        return self

    def executemany(self, query, params_seq):
        rewritten = _rewrite_qmark_sql(query)
        self._cursor.executemany(rewritten, [tuple(params or ()) for params in params_seq])
        self._columns = [col[0] for col in self._cursor.description] if self._cursor.description else []
        return self

    def fetchone(self):
        row = self._cursor.fetchone()
        return CompatRow(self._columns, row) if row is not None else None

    def fetchall(self):
        return [CompatRow(self._columns, row) for row in self._cursor.fetchall()]

    @property
    def rowcount(self):
        return self._cursor.rowcount

    def close(self):
        self._cursor.close()


class PostgresConnectionWrapper:
    backend = 'postgres'

    def __init__(self, raw_connection):
        self._raw = raw_connection

    def cursor(self):
        return PostgresCursorWrapper(self._raw.cursor())

    def execute(self, query, params=None):
        cursor = self.cursor()
        return cursor.execute(query, params)

    def executemany(self, query, params_seq):
        cursor = self.cursor()
        return cursor.executemany(query, params_seq)

    def executescript(self, script):
        for statement in _split_sql_statements(script):
            upper_stmt = statement.upper()
            if upper_stmt.startswith('PRAGMA '):
                continue
            self.execute(statement)
        return self

    def commit(self):
        self._raw.commit()

    def rollback(self):
        self._raw.rollback()

    def close(self):
        self._raw.close()


def _connect_postgres():
    if _pg_dbapi is None:
        raise RuntimeError('pg8000 is not installed. Add it to requirements before using DB_BACKEND=postgres.')
    missing = [name for name, value in (("DB_NAME", DB_NAME), ("DB_USER", DB_USER), ("DB_PASSWORD", DB_PASSWORD)) if not value]
    if missing:
        raise RuntimeError(f"Missing required Postgres settings: {', '.join(missing)}")

    kwargs = {
        'user': DB_USER,
        'password': DB_PASSWORD,
        'database': DB_NAME,
        'timeout': 15,
    }
    if INSTANCE_CONNECTION_NAME and os.path.isdir('/cloudsql'):
        kwargs['unix_sock'] = f"/cloudsql/{INSTANCE_CONNECTION_NAME}/.s.PGSQL.5432"
    elif DB_HOST:
        kwargs['host'] = DB_HOST
        kwargs['port'] = DB_PORT
    else:
        raise RuntimeError('Set INSTANCE_CONNECTION_NAME for Cloud Run or DB_HOST for direct Postgres access.')

    return PostgresConnectionWrapper(_pg_dbapi.connect(**kwargs))


def get_db():
    if DB_BACKEND == 'postgres':
        return _connect_postgres()

    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA foreign_keys=ON')
    return db


def _table_columns(db, table_name):
    if getattr(db, 'backend', 'sqlite') == 'postgres':
        rows = db.execute(
            """SELECT column_name
               FROM information_schema.columns
               WHERE table_schema = current_schema() AND table_name=?""",
            (table_name,),
        ).fetchall()
        return {r['column_name'] for r in rows}

    rows = db.execute(f"PRAGMA table_info({table_name})").fetchall()
    return {r['name'] for r in rows}


def _table_exists(db, table_name):
    if getattr(db, 'backend', 'sqlite') == 'postgres':
        row = db.execute(
            """SELECT 1
               FROM information_schema.tables
               WHERE table_schema = current_schema() AND table_name=?""",
            (table_name,),
        ).fetchone()
        return row is not None

    row = db.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (table_name,),
    ).fetchone()
    return row is not None


_SAFE_IDENTIFIER_RE = __import__("re").compile(r"^[a-zA-Z_][a-zA-Z0-9_]{0,127}$")

def _ensure_column(db, table_name, column_name, column_sql):
    # Guard: identifiers must be safe alphanumeric names only
    if not _SAFE_IDENTIFIER_RE.match(table_name):
        raise ValueError(f"Unsafe table name: {table_name!r}")
    if not _SAFE_IDENTIFIER_RE.match(column_name):
        raise ValueError(f"Unsafe column name: {column_name!r}")
    if not _table_exists(db, table_name):
        return
    if column_name not in _table_columns(db, table_name):
        db.execute(f"ALTER TABLE {table_name} ADD COLUMN {column_name} {column_sql}")


def _validate_sms_body(body: str) -> tuple[bool, str]:
    """Validate SMS body before sending — returns (ok, error_message)."""
    if not body or not body.strip():
        return False, "Message body cannot be empty"
    cleaned = _sanitize_text_field(body, 1600)  # Twilio max is ~1600 chars
    if len(cleaned) > 1600:
        return False, f"Message too long ({len(cleaned)} chars, max 1600)"
    # Block potential injection attempts in SMS
    if any(x in cleaned.lower() for x in ['<script', 'javascript:', 'data:text']):
        return False, "Invalid message content"
    return True, ""

def _normalize_email(value):
    return (value or "").strip().lower()


def _sqlite_index_list(db, table_name):
    rows = db.execute(f"PRAGMA index_list({table_name})").fetchall()
    out = []
    for row in rows:
        if hasattr(row, "keys"):
            out.append(dict(row))
        else:
            out.append({
                "seq": row[0] if len(row) > 0 else None,
                "name": row[1] if len(row) > 1 else "",
                "unique": row[2] if len(row) > 2 else 0,
                "origin": row[3] if len(row) > 3 else "",
                "partial": row[4] if len(row) > 4 else 0,
            })
    return out


def _ensure_users_email_uniqueness_per_tenant(db):
    if not _table_exists(db, "users"):
        return

    backend = getattr(db, "backend", "sqlite")
    if backend == "postgres":
        db.execute("ALTER TABLE users DROP CONSTRAINT IF EXISTS users_email_key")
        db.execute("DROP INDEX IF EXISTS users_email_key")
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email_unique ON users (tenant_id, lower(email)) WHERE email IS NOT NULL")
        db.commit()
        return

    indexes = _sqlite_index_list(db, "users")
    has_tenant_unique = any((idx.get("name") or "") == "idx_users_tenant_email_unique" for idx in indexes)
    has_legacy_email_unique = any(
        idx.get("unique")
        and idx.get("origin") == "u"
        and "email" in (idx.get("name") or "").lower()
        and (idx.get("name") or "") != "idx_users_tenant_email_unique"
        for idx in indexes
    )

    if has_legacy_email_unique:
        db.execute("PRAGMA foreign_keys=OFF")
        db.execute("ALTER TABLE users RENAME TO users_legacy")
        db.executescript("""
        CREATE TABLE users (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL REFERENCES tenants(id),
            name TEXT NOT NULL,
            email TEXT,
            role TEXT NOT NULL DEFAULT 'rep' CHECK(role IN ('sysop','owner','manager','rep','viewer')),
            tier TEXT DEFAULT 'standard' CHECK(tier IN ('junior','standard','senior')),
            permissions_json TEXT NOT NULL DEFAULT '{}',
            password_hash TEXT NOT NULL DEFAULT '',
            must_change_password INTEGER DEFAULT 1,
            last_login_at TEXT,
            active INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(tenant_id, email)
        );
        """)
        db.execute(
            """INSERT INTO users (id,tenant_id,name,email,role,tier,permissions_json,password_hash,must_change_password,last_login_at,active,created_at)
               SELECT id,tenant_id,name,email,role,tier,permissions_json,password_hash,must_change_password,last_login_at,active,created_at
               FROM users_legacy"""
        )
        db.execute("DROP TABLE users_legacy")
        db.execute("PRAGMA foreign_keys=ON")
        db.commit()
        has_tenant_unique = False

    if not has_tenant_unique:
        db.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_tenant_email_unique ON users (tenant_id, email)")
        db.commit()


def apply_schema_extensions(db):
    """
    Non-destructive schema extensions for 2026 governance and messaging updates.
    """
    # Drop hardcoded product_line CHECK constraint (PostgreSQL)
    try:
        db.execute("ALTER TABLE products DROP CONSTRAINT IF EXISTS products_product_line_check")
        db.commit()
    except Exception:
        pass  # Already dropped or SQLite

    _ensure_column(db, "governance_settings", "max_discount_pct", "REAL NOT NULL DEFAULT 5.0")
    _ensure_column(db, "governance_settings", "strict_noa_enforcement", "INTEGER DEFAULT 0")
    _ensure_column(db, "quotes", "pricing_locked_at", "TEXT")
    _ensure_column(db, "quotes", "required_zone", "TEXT")
    _ensure_column(db, "quotes", "pending_approval_payload", "TEXT")
    _ensure_column(db, "openings", "discount_pct", "REAL DEFAULT 0")
    _ensure_column(db, "openings", "requested_sell_price", "REAL")
    _ensure_column(db, "openings", "required_zone", "TEXT")
    _ensure_column(db, "openings", "baseline_sell_price", "REAL")
    _ensure_column(db, "audit_log", "rep_id", "TEXT")
    _ensure_column(db, "users", "permissions_json", "TEXT NOT NULL DEFAULT '{}'" )
    _ensure_column(db, "users", "password_hash", "TEXT NOT NULL DEFAULT ''")
    _ensure_column(db, "users", "must_change_password", "INTEGER DEFAULT 1")
    _ensure_column(db, "users", "last_login_at", "TEXT")
    _ensure_column(db, "job_messages", "attachment_storage", "TEXT")
    _ensure_column(db, "job_messages", "attachment_bucket", "TEXT")
    _ensure_column(db, "job_messages", "attachment_object_name", "TEXT")
    _ensure_column(db, "job_messages", "attachment_generation", "TEXT")
    _ensure_column(db, "job_messages", "attachment_deleted_at", "TEXT")
    _ensure_column(db, "job_messages", "attachment_url", "TEXT")
    _ensure_column(db, "job_messages", "attachment_kind", "TEXT")
    _ensure_column(db, "job_messages", "attachment_name", "TEXT")
    _ensure_column(db, "job_messages", "attachment_mime", "TEXT")
    _ensure_column(db, "job_messages", "attachment_size", "INTEGER")
    _ensure_column(db, "job_messages", "delivery_channel", "TEXT NOT NULL DEFAULT 'in_app'")
    _ensure_column(db, "job_messages", "external_direction", "TEXT")
    _ensure_column(db, "job_messages", "external_message_sid", "TEXT")
    _ensure_column(db, "job_messages", "external_status", "TEXT")
    _ensure_column(db, "job_messages", "external_from", "TEXT")
    _ensure_column(db, "job_messages", "external_to", "TEXT")
    _ensure_column(db, "job_messages", "external_error", "TEXT")
    _ensure_column(db, "quotes", "folio_number", "TEXT")
    _ensure_column(db, "quotes", "pa_owner_name", "TEXT")
    _ensure_column(db, "quotes", "pa_year_built", "INTEGER")
    _ensure_column(db, "quotes", "pa_living_sqft", "REAL")
    _ensure_column(db, "quotes", "pa_bedrooms", "INTEGER")
    _ensure_column(db, "quotes", "pa_bathrooms", "REAL")
    _ensure_column(db, "quotes", "pa_data_json", "TEXT")
    _ensure_column(db, "quotes", "maps_place_id", "TEXT")
    _ensure_column(db, "quotes", "maps_formatted_address", "TEXT")

    # Backfill baseline sell price for legacy openings so reset/adjust ranges can recover.
    try:
        db.execute(
            """
            UPDATE openings
               SET baseline_sell_price = CASE
                    WHEN COALESCE(discount_pct, 0) > 0
                     AND COALESCE(discount_pct, 0) < 99.9
                     AND COALESCE(sell_price, 0) > 0
                    THEN (sell_price / NULLIF((1 - (discount_pct / 100.0)), 0))
                    ELSE sell_price
               END
             WHERE baseline_sell_price IS NULL
            """
        )
        db.commit()
    except Exception:
        try:
            db.rollback()
        except Exception:
            pass
    _ensure_column(db, "tenants", "onboarding_state", "TEXT NOT NULL DEFAULT 'pending'")
    _ensure_column(db, "tenants", "onboarding_completed_steps", "TEXT NOT NULL DEFAULT '[]'")

    # --- Alpha 9.2: Section 3 — Property & Maps verification ---
    _ensure_column(db, "quotes", "property_verified", "INTEGER DEFAULT 0")
    _ensure_column(db, "quotes", "property_verified_at", "TEXT")
    _ensure_column(db, "quotes", "property_verified_by", "TEXT")
    _ensure_column(db, "quotes", "maps_verified", "INTEGER DEFAULT 0")
    _ensure_column(db, "quotes", "maps_verified_at", "TEXT")

    # --- Alpha 9.2: Section 4B — NOA tracking ---
    _ensure_column(db, "openings", "noa_checked_at", "TEXT")
    _ensure_column(db, "openings", "noa_source", "TEXT")

    # --- Alpha 9.2: Section 4C — Approval request enrichment ---
    _ensure_column(db, "approval_requests", "quote_total_price", "REAL")
    _ensure_column(db, "approval_requests", "opening_count", "INTEGER")
    _ensure_column(db, "approval_requests", "rep_tier", "TEXT")

    # --- Alpha 9.2: Section 8A — Message read receipts ---
    _ensure_column(db, "job_messages", "read_by_json", "TEXT NOT NULL DEFAULT '[]'")

    # --- Alpha 9.4e: DB-backed rate limiting (replaces in-memory threading.Lock dicts) ---
    db.execute("""
        CREATE TABLE IF NOT EXISTS rate_limit_attempts (
            id TEXT PRIMARY KEY,
            key TEXT NOT NULL,
            attempt_at TEXT NOT NULL
        )
    """)
    try:
        db.execute("CREATE INDEX IF NOT EXISTS idx_rla_key ON rate_limit_attempts(key, attempt_at)")
    except Exception:
        pass

    # --- Alpha 9.4e: Mobile API — idempotency log for sync events ---
    db.execute("""
        CREATE TABLE IF NOT EXISTS mobile_sync_log (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            rep_id TEXT NOT NULL,
            device_id TEXT,
            event_type TEXT NOT NULL,
            client_event_id TEXT NOT NULL,
            payload_json TEXT,
            status TEXT NOT NULL DEFAULT 'ok',
            error_msg TEXT,
            created_at TEXT NOT NULL
        )
    """)
    try:
        db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_msl_client_event "
            "ON mobile_sync_log(tenant_id, client_event_id)"
        )
        db.execute(
            "CREATE INDEX IF NOT EXISTS idx_msl_rep "
            "ON mobile_sync_log(tenant_id, rep_id, created_at)"
        )
    except Exception:
        pass

    # --- Alpha 9.4e: Tier 4 — Job-Size Discount Tiers ---
    db.execute("""
        CREATE TABLE IF NOT EXISTS discount_tiers (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NOT NULL,
            label TEXT NOT NULL,
            min_job_total REAL NOT NULL DEFAULT 0,
            max_job_total REAL,
            max_discount_pct REAL NOT NULL DEFAULT 0,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )
    """)
    try:
        db.execute("CREATE INDEX IF NOT EXISTS idx_discount_tiers_tenant ON discount_tiers(tenant_id, active)")
    except Exception:
        pass

    db.commit()

    db.executescript("""
    CREATE TABLE IF NOT EXISTS product_price_points (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        product_id TEXT NOT NULL REFERENCES products(id),
        width REAL NOT NULL,
        height REAL NOT NULL,
        price REAL NOT NULL,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, product_id, width, height)
    );

    CREATE TABLE IF NOT EXISTS zone_pressure_requirements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        zone_code TEXT NOT NULL,
        required_dp REAL NOT NULL,
        hvhz_required INTEGER DEFAULT 0,
        max_story_height INTEGER DEFAULT 10,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, zone_code)
    );

    CREATE TABLE IF NOT EXISTS feature_flags (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        flag_key TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, flag_key)
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL,
        impersonated_by TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS job_messages (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        quote_id TEXT NOT NULL REFERENCES quotes(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        user_name TEXT,
        content TEXT NOT NULL,
        attachment_storage TEXT,
        attachment_bucket TEXT,
        attachment_object_name TEXT,
        attachment_generation TEXT,
        attachment_deleted_at TEXT,
        attachment_url TEXT,
        attachment_kind TEXT,
        attachment_name TEXT,
        attachment_mime TEXT,
        attachment_size INTEGER,
        delivery_channel TEXT NOT NULL DEFAULT 'in_app',
        external_direction TEXT,
        external_message_sid TEXT,
        external_status TEXT,
        external_from TEXT,
        external_to TEXT,
        external_error TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sms_threads (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        quote_id TEXT NOT NULL REFERENCES quotes(id),
        customer_phone TEXT,
        customer_phone_norm TEXT,
        channel_provider TEXT NOT NULL DEFAULT 'twilio',
        channel_address TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        last_inbound_at TEXT,
        last_outbound_at TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, quote_id)
    );

    CREATE TABLE IF NOT EXISTS proposal_snapshots (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        quote_id TEXT NOT NULL REFERENCES quotes(id),
        generated_by TEXT NOT NULL REFERENCES users(id),
        quote_snapshot TEXT NOT NULL,
        pdf_gcs_path TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS proposal_shares (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        quote_id TEXT NOT NULL REFERENCES quotes(id),
        snapshot_id TEXT NOT NULL REFERENCES proposal_snapshots(id),
        created_by TEXT NOT NULL REFERENCES users(id),
        token TEXT NOT NULL UNIQUE,
        expires_at TEXT,
        viewed_count INTEGER DEFAULT 0,
        last_viewed_at TEXT,
        customer_response TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS governance_overrides (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        override_type TEXT NOT NULL CHECK(override_type IN ('margin_floor','max_discount','yellow_threshold')),
        override_value REAL NOT NULL,
        granted_by TEXT NOT NULL REFERENCES users(id),
        expires_at TEXT,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pricing_snapshots (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        quote_id TEXT NOT NULL REFERENCES quotes(id),
        opening_id TEXT REFERENCES openings(id),
        snapshot_type TEXT NOT NULL CHECK(snapshot_type IN ('opening_save','approval_request','quote_complete','manual_lock')),
        pricing_json TEXT NOT NULL,
        governance_json TEXT NOT NULL,
        created_by TEXT NOT NULL REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS quote_files (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        quote_id TEXT NOT NULL REFERENCES quotes(id),
        uploaded_by TEXT NOT NULL REFERENCES users(id),
        file_name TEXT NOT NULL,
        file_size INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        file_category TEXT DEFAULT 'general' CHECK(file_category IN ('general','permit','photo','contract','hoa','noa_doc','inspection','other')),
        storage_backend TEXT NOT NULL DEFAULT 'local',
        storage_bucket TEXT,
        storage_object_name TEXT NOT NULL,
        public_url TEXT,
        deleted_at TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS message_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        body TEXT NOT NULL,
        category TEXT DEFAULT 'general' CHECK(category IN ('general','appointment','follow_up','approval','completion','other')),
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_quote_files_quote
           ON quote_files(tenant_id, quote_id, deleted_at)"""
    )
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_pricing_snapshots_quote
           ON pricing_snapshots(tenant_id, quote_id, created_at)"""
    )
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_message_templates_tenant
           ON message_templates(tenant_id, active)"""
    )
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_sms_threads_lookup
           ON sms_threads(channel_provider, channel_address, customer_phone_norm, active)"""
    )
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_proposal_snapshots_quote
           ON proposal_snapshots(tenant_id, quote_id, created_at)"""
    )
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_proposal_shares_quote
           ON proposal_shares(tenant_id, quote_id, snapshot_id, created_at)"""
    )
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_governance_overrides_active
           ON governance_overrides(tenant_id, user_id, active, override_type, expires_at)"""
    )
    # --- Alpha 9.3: Section 1 — AI Pricing Studio tables ---
    db.executescript("""
    CREATE TABLE IF NOT EXISTS ai_pricing_profiles (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft'
            CHECK (status IN ('draft','review','active','archived')),
        created_by TEXT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        note TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_pricing_entries (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        profile_id TEXT NOT NULL REFERENCES ai_pricing_profiles(id),
        product_id TEXT NOT NULL,
        product_name TEXT,
        product_line TEXT,
        current_base_cost REAL,
        current_markup_pct REAL,
        current_sell_price REAL,
        ai_suggested_markup_pct REAL,
        ai_suggested_sell_price REAL,
        sample_size INTEGER,
        avg_sell_price REAL,
        avg_margin_pct REAL,
        min_sell_price REAL,
        max_sell_price REAL,
        data_period_start TEXT,
        data_period_end TEXT,
        metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_pricing_applications (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        profile_id TEXT NOT NULL REFERENCES ai_pricing_profiles(id),
        applied_by TEXT NOT NULL,
        applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        scope TEXT NOT NULL CHECK (scope IN ('all_products','selected_products')),
        details_json TEXT
    );
    """)
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_ai_profiles_tenant
           ON ai_pricing_profiles(tenant_id, status, created_at DESC)"""
    )
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_ai_entries_profile
           ON ai_pricing_entries(tenant_id, profile_id, product_id)"""
    )
    # --- Alpha 9.4: Section B3A — demo_requests (marketing, no tenant_id) ---
    db.executescript("""
    CREATE TABLE IF NOT EXISTS demo_requests (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        company TEXT,
        phone TEXT,
        company_size TEXT,
        source TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    db.execute(
        """CREATE INDEX IF NOT EXISTS idx_demo_requests_created
           ON demo_requests(created_at DESC)"""
    )
    _ensure_users_email_uniqueness_per_tenant(db)

    # ── Lead tracking columns (Alpha 9.4c) ───────────────────
    _ensure_column(db, "demo_requests", "status",          "TEXT NOT NULL DEFAULT 'new'")
    _ensure_column(db, "demo_requests", "priority",        "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(db, "demo_requests", "follow_up_date",  "TEXT")
    _ensure_column(db, "demo_requests", "custom_tag",      "TEXT")
    _ensure_column(db, "demo_requests", "score",           "INTEGER NOT NULL DEFAULT 0")
    _ensure_column(db, "demo_requests", "last_activity_at","TEXT")

    db.execute("""CREATE TABLE IF NOT EXISTS lead_notes (
        id          TEXT PRIMARY KEY,
        lead_id     TEXT NOT NULL REFERENCES demo_requests(id) ON DELETE CASCADE,
        note_text   TEXT NOT NULL,
        created_at  TEXT NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_lead_notes_lead ON lead_notes(lead_id)")

    db.execute("""CREATE TABLE IF NOT EXISTS lead_activity (
        id          TEXT PRIMARY KEY,
        lead_id     TEXT NOT NULL REFERENCES demo_requests(id) ON DELETE CASCADE,
        event_type  TEXT NOT NULL,
        old_value   TEXT,
        new_value   TEXT,
        created_at  TEXT NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_lead_activity_lead ON lead_activity(lead_id)")

    # ── Master Product Library tables (Alpha 9.4d) ───────────
    db.execute("""CREATE TABLE IF NOT EXISTS master_products (
        id                 TEXT PRIMARY KEY,
        manufacturer       TEXT NOT NULL,
        series             TEXT NOT NULL,
        model_number       TEXT NOT NULL,
        name               TEXT NOT NULL,
        opening_type       TEXT NOT NULL,
        min_width_in       REAL DEFAULT 12,
        max_width_in       REAL NOT NULL,
        min_height_in      REAL DEFAULT 12,
        max_height_in      REAL NOT NULL,
        dp_rating_pos      REAL,
        dp_rating_neg      REAL,
        hvhz_compliant     INTEGER DEFAULT 1,
        noa_number         TEXT,
        noa_expires        TEXT,
        missile_impact     TEXT DEFAULT 'LMI',
        frame_types_json   TEXT DEFAULT '["flange"]',
        glass_options_json TEXT DEFAULT '["impact_laminated"]',
        frame_colors_json  TEXT DEFAULT '["white","bronze"]',
        frame_depth        TEXT,
        lead_time_weeks    INTEGER DEFAULT 5,
        description        TEXT,
        spec_sheet_url     TEXT,
        base_msrp          REAL,
        active             INTEGER DEFAULT 1,
        created_at         TEXT,
        updated_at         TEXT
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_master_products_mfr ON master_products(manufacturer)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_master_products_series ON master_products(series)")

    db.execute("""CREATE TABLE IF NOT EXISTS master_product_shares (
        id                 TEXT PRIMARY KEY,
        master_product_id  TEXT NOT NULL REFERENCES master_products(id),
        tenant_id          TEXT NOT NULL REFERENCES tenants(id),
        shared_at          TEXT NOT NULL,
        shared_by          TEXT,
        status             TEXT NOT NULL DEFAULT 'active',
        revoked_at         TEXT,
        notes              TEXT,
        UNIQUE(master_product_id, tenant_id)
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_mps_tenant ON master_product_shares(tenant_id)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_mps_product ON master_product_shares(master_product_id)")

    db.execute("""CREATE TABLE IF NOT EXISTS tenant_product_requests (
        id                 TEXT PRIMARY KEY,
        tenant_id          TEXT NOT NULL REFERENCES tenants(id),
        product_id         TEXT,
        master_product_id  TEXT,
        request_type       TEXT NOT NULL DEFAULT 'field_update',
        field_name         TEXT,
        requested_value    TEXT,
        reason             TEXT,
        status             TEXT NOT NULL DEFAULT 'pending',
        admin_response     TEXT,
        responded_at       TEXT,
        responded_by       TEXT,
        created_at         TEXT NOT NULL
    )""")
    db.execute("CREATE INDEX IF NOT EXISTS idx_tpr_tenant ON tenant_product_requests(tenant_id)")
    db.execute("CREATE INDEX IF NOT EXISTS idx_tpr_status ON tenant_product_requests(status)")

    # ── Performance indexes for high-traffic queries (Alpha 9.4d) ──────────────
    # Wrapped in individual try/except — a missing column on an old DB schema
    # logs a warning but never prevents the app from starting.
    _perf_indexes = [
        ("idx_quotes_tenant_status",  "quotes(tenant_id, status)"),
        ("idx_quotes_tenant_created", "quotes(tenant_id, created_at DESC)"),
        ("idx_openings_quote",        "openings(quote_id)"),
        ("idx_users_tenant_email",    "users(tenant_id, email)"),
        ("idx_users_email_active",    "users(lower(email), active)"),
        ("idx_audit_log_tenant_ts",   "audit_log(tenant_id, created_at DESC)"),
        ("idx_products_tenant_active","products(tenant_id, active)"),
        ("idx_dp_ratings_product",    "dp_ratings(product_id, active)"),
        ("idx_sessions_token",        "auth_sessions(token_hash)"),
        ("idx_sessions_user",         "auth_sessions(user_id, expires_at)"),
        ("idx_demo_requests_status",  "demo_requests(status, created_at DESC)"),
    ]
    for _idx_name, _idx_cols in _perf_indexes:
        try:
            db.execute(f"CREATE INDEX IF NOT EXISTS {_idx_name} ON {_idx_cols}")
        except Exception as _idx_err:
            app.logger.warning(f"[init_db] Skipped index {_idx_name}: {_idx_err}")

    # Link existing tenant products to master library
    _ensure_column(db, "products", "master_product_id", "TEXT")
    _ensure_column(db, "products", "imported_at", "TEXT")

    # --- Tier 6: Multi-location / branch support ---
    _ensure_column(db, "users", "branch_id", "TEXT")
    _ensure_column(db, "quotes", "branch_id", "TEXT")

    # --- Tier 6: NOA document library ---
    _ensure_column(db, "noa_records", "document_url", "TEXT")
    _ensure_column(db, "noa_records", "document_filename", "TEXT")
    _ensure_column(db, "noa_records", "uploaded_at", "TEXT")
    _ensure_column(db, "noa_records", "uploaded_by", "TEXT")

    # --- Tier 6: Proposal share revocation ---
    _ensure_column(db, "proposal_shares", "revoked_at", "TEXT")

    db.commit()


def init_db():
    """Initialize or migrate the database non-destructively."""
    db = get_db()

    db.executescript("""
    PRAGMA user_version = 7;

    CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        logo_url TEXT,
        license_number TEXT,
        phone TEXT,
        email TEXT,
        address TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'rep' CHECK(role IN ('sysop','owner','manager','rep','viewer')),
        tier TEXT DEFAULT 'standard' CHECK(tier IN ('junior','standard','senior')),
        permissions_json TEXT NOT NULL DEFAULT '{}',
        password_hash TEXT NOT NULL DEFAULT '',
        must_change_password INTEGER DEFAULT 1,
        last_login_at TEXT,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, email)
    );

    CREATE TABLE IF NOT EXISTS products (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        model_number TEXT NOT NULL,
        product_line TEXT NOT NULL CHECK(product_line IN ('Prestige','Elite','Multimax')),
        manufacturer TEXT NOT NULL DEFAULT 'ESWindows',
        type TEXT NOT NULL,
        base_cost REAL NOT NULL,
        size_multiplier_per_sqft REAL DEFAULT 0,
        min_width REAL DEFAULT 12,
        max_width REAL DEFAULT 192,
        min_height REAL DEFAULT 12,
        max_height REAL DEFAULT 144,
        frame_depth TEXT,
        lead_time_weeks INTEGER DEFAULT 4,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dp_ratings (
        id TEXT PRIMARY KEY,
        product_id TEXT NOT NULL REFERENCES products(id),
        tenant_id TEXT NOT NULL,
        dp_positive REAL NOT NULL,
        dp_negative REAL NOT NULL,
        max_width_for_dp REAL,
        max_height_for_dp REAL,
        max_sqft_for_dp REAL,
        hvhz_approved INTEGER DEFAULT 0,
        max_story_height INTEGER DEFAULT 3,
        missile_rating TEXT DEFAULT 'large',
        noa_number TEXT,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS glass_options (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        cost_adder REAL DEFAULT 0,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS frame_colors (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        cost_adder REAL DEFAULT 0,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS complexity_items (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        cost REAL NOT NULL,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS noa_records (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        product_id TEXT NOT NULL REFERENCES products(id),
        noa_number TEXT NOT NULL,
        pressure_rating REAL,
        max_story_height INTEGER DEFAULT 3,
        hvhz_certified INTEGER DEFAULT 0,
        pdf_url TEXT,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS governance_settings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        tier TEXT NOT NULL,
        margin_floor REAL NOT NULL,
        yellow_threshold REAL DEFAULT 3.0,
        discount_approval_required INTEGER DEFAULT 1,
        max_discount_pct REAL NOT NULL DEFAULT 5.0,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS floor_labor (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        floor_level INTEGER NOT NULL,
        labor_adder REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS branches (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        name TEXT NOT NULL,
        address TEXT,
        phone TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS territory_multipliers (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        zip_code TEXT NOT NULL,
        multiplier REAL NOT NULL DEFAULT 1.0
    );

    CREATE TABLE IF NOT EXISTS product_price_points (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        product_id TEXT NOT NULL REFERENCES products(id),
        width REAL NOT NULL,
        height REAL NOT NULL,
        price REAL NOT NULL,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, product_id, width, height)
    );

    CREATE TABLE IF NOT EXISTS zone_pressure_requirements (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        zone_code TEXT NOT NULL,
        required_dp REAL NOT NULL,
        hvhz_required INTEGER DEFAULT 0,
        max_story_height INTEGER DEFAULT 10,
        active INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, zone_code)
    );

    CREATE TABLE IF NOT EXISTS quotes (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        rep_id TEXT NOT NULL REFERENCES users(id),
        customer_name TEXT NOT NULL,
        customer_phone TEXT,
        customer_email TEXT,
        job_address TEXT,
        job_zip TEXT,
        status TEXT DEFAULT 'draft' CHECK(status IN ('draft','pending_approval','approved','completed','denied')),
        total_price REAL DEFAULT 0,
        total_cost REAL DEFAULT 0,
        margin_pct REAL DEFAULT 0,
        margin_dollars REAL DEFAULT 0,
        pricing_locked_at TEXT,
        pricing_locked_until TEXT,
        required_zone TEXT,
        pending_approval_payload TEXT,
        notes TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS openings (
        id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL REFERENCES quotes(id),
        tenant_id TEXT NOT NULL,
        opening_number INTEGER NOT NULL,
        opening_mode TEXT DEFAULT 'single' CHECK(opening_mode IN ('single','multipart')),
        opening_type TEXT NOT NULL,
        total_width REAL NOT NULL,
        total_height REAL NOT NULL,
        floor_level INTEGER DEFAULT 1,
        wall_type TEXT DEFAULT 'cbs' CHECK(wall_type IN ('cbs','frame','concrete')),
        product_id TEXT REFERENCES products(id),
        glass_option_id TEXT,
        frame_color_id TEXT,
        complexity_ids TEXT DEFAULT '[]',
        photo_url TEXT,
        sell_price REAL DEFAULT 0,
        baseline_sell_price REAL,
        total_cost REAL DEFAULT 0,
        margin_pct REAL DEFAULT 0,
        margin_dollars REAL DEFAULT 0,
        dp_status TEXT DEFAULT 'pending' CHECK(dp_status IN ('pending','passed','failed')),
        dp_rating_used REAL,
        noa_number TEXT,
        dp_failure_reason TEXT,
        consumables_cost REAL DEFAULT 0,
        discount_pct REAL DEFAULT 0,
        requested_sell_price REAL,
        required_zone TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS assembly_panels (
        id TEXT PRIMARY KEY,
        opening_id TEXT NOT NULL REFERENCES openings(id),
        tenant_id TEXT NOT NULL,
        panel_index INTEGER NOT NULL,
        panel_label TEXT,
        product_id TEXT REFERENCES products(id),
        glass_option_id TEXT,
        frame_color_id TEXT,
        width REAL NOT NULL,
        height REAL NOT NULL,
        sell_price REAL DEFAULT 0,
        total_cost REAL DEFAULT 0,
        dp_status TEXT DEFAULT 'pending',
        dp_rating_used REAL,
        noa_number TEXT
    );

    CREATE TABLE IF NOT EXISTS assembly_templates (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        layout_type TEXT NOT NULL,
        panel_count INTEGER NOT NULL,
        description TEXT,
        default_types TEXT,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS consumables (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        name TEXT NOT NULL,
        unit_cost REAL NOT NULL,
        unit TEXT DEFAULT 'per_opening',
        wall_type_filter TEXT,
        min_openings INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS global_settings (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        setting_key TEXT NOT NULL,
        setting_value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, setting_key)
    );

    CREATE TABLE IF NOT EXISTS lead_time_overrides (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        frame_color_id TEXT REFERENCES frame_colors(id),
        product_line TEXT,
        lead_time_weeks INTEGER NOT NULL,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS feature_flags (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        flag_key TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        config_json TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(tenant_id, flag_key)
    );

    CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        user_id TEXT NOT NULL REFERENCES users(id),
        token_hash TEXT NOT NULL,
        impersonated_by TEXT,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS approval_requests (
        id TEXT PRIMARY KEY,
        quote_id TEXT NOT NULL REFERENCES quotes(id),
        tenant_id TEXT NOT NULL REFERENCES tenants(id),
        rep_id TEXT NOT NULL REFERENCES users(id),
        current_margin REAL NOT NULL,
        requested_margin REAL,
        rep_note TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
        owner_note TEXT,
        decided_by TEXT,
        decided_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        entity_type TEXT,
        entity_id TEXT,
        user_id TEXT,
        user_name TEXT,
        rep_id TEXT,
        details TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
    """)
    db.commit()
    apply_schema_extensions(db)

    count = db.execute("SELECT COUNT(*) FROM tenants").fetchone()[0]
    if count == 0 and SEED_DEMO_DATA:
        seed_demo_data(db)

    _ensure_default_permissions_and_passwords(db)
    _ensure_showcase_demo_data(db)
    _ensure_second_demo_tenant(db)
    _ensure_sample_leads(db)
    # Prune expired auth sessions — fast, always safe to run on startup
    try:
        cutoff = (datetime.utcnow() - timedelta(days=30)).isoformat()
        db.execute("DELETE FROM auth_sessions WHERE expires_at < ?", (cutoff,))
        # Also prune stale rate limit attempts older than 1 hour
        rl_cutoff = (datetime.utcnow() - timedelta(hours=1)).isoformat()
        db.execute("DELETE FROM rate_limit_attempts WHERE attempt_at < ?", (rl_cutoff,))
        db.commit()
    except Exception:
        pass  # Non-fatal — just cleanup
    _ensure_master_library_bootstrap(db)
    _ensure_cgi_vv_products(db)
    _ensure_expanded_products(db)
    # NOTE: _cleanup_oversized_text_payloads moved to /api/admin/maintenance
    # so it does not run on every cold start. Call via Cloud Scheduler daily.
    db.close()


# ---------------------------------------------------------------------------
# SEED DATA
# ---------------------------------------------------------------------------

def seed_demo_data(db):
    tenant_id = "t-demo-001"
    now = datetime.now()

    # Tenant
    db.execute(
        """INSERT INTO tenants
           (id, name, logo_url, license_number, phone, email, address, created_at)
           VALUES (?,?,?,?,?,?,?,?)""",
        (
            tenant_id,
            "Impact Window Dealer",
            None,
            "CGC1234567",
            "(954) 555-0100",
            "info@demo-dealer.example",
            "2500 S Andrews Ave, Fort Lauderdale, FL 33316",
            now.isoformat(),
        ),
    )

    # Users
    users = [
        ("u-sysop-001", tenant_id, "Sam Sysop",      "sysop@demo-dealer.example",          "sysop",   "senior"),
        ("u-owner-001", tenant_id, "Mike Reynolds",  "mike@demo-dealer.example",   "owner",   "senior"),
        ("u-mgr-001",   tenant_id, "Sarah Chen",     "sarah@demo-dealer.example",  "manager", "senior"),
        ("u-rep-001",   tenant_id, "Jordan Blake",   "jordan@demo-dealer.example",   "rep",     "senior"),
        ("u-rep-002",   tenant_id, "Carlos Mendez",  "carlos@demo-dealer.example", "rep",     "standard"),
        ("u-view-001",  tenant_id, "Ashley Rivera",  "ashley@demo-dealer.example", "viewer",  "junior"),
    ]
    for u in users:
        uid, tid, name, email, role, tier = u
        db.execute(
            """INSERT INTO users (id,tenant_id,name,email,role,tier,permissions_json,password_hash,must_change_password,active)
               VALUES (?,?,?,?,?,?,?,?,1,1)""",
            (uid, tid, name, email, role, tier, _permissions_to_json(role), _hash_password(DEMO_PASSWORD)),
        )

    # Frame Colors
    frame_colors = [
        ("fc-001", tenant_id, "White",                         0),
        ("fc-002", tenant_id, "Black (Duranar UC40577)",      120),
        ("fc-003", tenant_id, "Bone White (Duranar UC43350)",  85),
        ("fc-004", tenant_id, "Bronze 2604",                   75),
        ("fc-005", tenant_id, "Bronze 2605 (Duranar)",         95),
        ("fc-006", tenant_id, "Bermuda Bronze (Duranar)",     100),
        ("fc-007", tenant_id, "Arcadia Silver (Duranar)",     110),
        ("fc-008", tenant_id, "Silverstorm (Duranar)",        110),
        ("fc-009", tenant_id, "Clear Anodized",               180),
        ("fc-010", tenant_id, "Teka Wood Grain",              280),
        ("fc-011", tenant_id, "Nogal Wood Grain",             280),
        ("fc-012", tenant_id, "Sapely Wood Grain",            280),
        ("fc-013", tenant_id, "Embero Wood Grain",            280),
        ("fc-014", tenant_id, "Custom Kynar",                 450),
    ]
    for fc in frame_colors:
        db.execute("INSERT INTO frame_colors VALUES (?,?,?,?,1)", fc)

    # Glass Options
    glass_options = [
        ("g-001", tenant_id, "Impact Laminated",                       0),
        ("g-002", tenant_id, "Impact Laminated + Low-E SB70",        380),
        ("g-003", tenant_id, "Insulating IG (Special Order)",         520),
        ("g-004", tenant_id, "Insulating IG + Low-E SB70 (Special)", 680),
        ("g-005", tenant_id, "SentryGlas® Interlayer",             350),
        ("g-006", tenant_id, "Tinted / Privacy Laminated",            220),
    ]
    for g in glass_options:
        db.execute("INSERT INTO glass_options VALUES (?,?,?,?,1)", g)

    # Products ? Prestige Line
    prestige = [
        ("p-p001", "ES-P252",   "Casement/Awning/Fixed",  "casement",         820,  2.10, 48,  84, 5),
        ("p-p002", "ES-FX2020", "Fixed Window",           "fixed",             580,  1.70, 60, 144, 5),
        ("p-p003", "ES-FX3050", "Frameless Window Wall",  "fixed",            1450,  3.20, 60, 144, 8),
        ("p-p004", "ES-8000T",  "Storefront Window",      "fixed",            1200,  2.80, 84, 180, 6),
        ("p-p005", "ES-SW340",  "Sliding Window",         "horizontal_roller", 720,  1.90, 72,  62, 5),
        ("p-p006", "ES-H340",   "Single Hung",            "single_hung",       680,  1.85, 53,  74, 5),
        ("p-p007", "ES-46T",    "Swing Door",             "entry_door",       2800,  2.50, 42,  96, 6),
        ("p-p008", "ES-9000",   "Impact Door",            "entry_door",       3200,  2.80, 72, 120, 7),
        ("p-p009", "ES-SGD2020","Sliding Glass Door",     "sliding_glass_door",2400, 2.40,192, 120, 6),
        ("p-p010", "ES-SGD2040","ProSlide Door",          "sliding_glass_door",3100, 2.60,240, 120, 7),
        ("p-p011", "ES-BF5010T","Bifold Door",            "bifold_door",      4200,  3.50,240, 120, 8),
    ]
    for p in prestige:
        db.execute("""INSERT INTO products
            (id,tenant_id,name,model_number,product_line,manufacturer,type,
             base_cost,size_multiplier_per_sqft,min_width,max_width,min_height,max_height,lead_time_weeks)
            VALUES (?,?,?,?,'Prestige','ESWindows',?,?,?,12,?,12,?,?)""",
            (p[0], tenant_id, p[2], p[1], p[3], p[4], p[5], p[6], p[7], p[8]))

    # Products ? Elite Line
    elite = [
        ("p-e001", "ES-EL100",  "Single Hung",            "single_hung",       520, 1.60, 53, 74, 4),
        ("p-e002", "ES-EL150",  "Fixed Window",           "fixed",             440, 1.50, 72, 96, 4),
        ("p-e003", "ES-EL200",  "Horizontal Roller",      "horizontal_roller", 560, 1.70, 73, 62, 4),
        ("p-e004", "ES-5000",   "Casement",               "casement",          620, 1.80, 48, 84, 5),
        ("p-e005", "ES-EL300",  "French/Swing Door",      "french_door",      2200, 2.30, 72, 96, 5),
        ("p-e006", "ES-EL400",  "Sliding Glass Door",     "sliding_glass_door",1800,2.10,144, 96, 5),
    ]
    for p in elite:
        db.execute("""INSERT INTO products
            (id,tenant_id,name,model_number,product_line,manufacturer,type,
             base_cost,size_multiplier_per_sqft,min_width,max_width,min_height,max_height,lead_time_weeks)
            VALUES (?,?,?,?,'Elite','ESWindows',?,?,?,12,?,12,?,?)""",
            (p[0], tenant_id, p[2], p[1], p[3], p[4], p[5], p[6], p[7], p[8]))

    # Products ? Multimax Line
    multimax = [
        ("p-m001", "ES-MX1000", "Single Hung",        "single_hung",       380, 1.40,  53, 74, 3),
        ("p-m002", "ES-MX1500", "Fixed Window",       "fixed",             320, 1.20,  72, 96, 3),
        ("p-m003", "ES-MX2000", "Sliding Window",     "horizontal_roller", 420, 1.50, 111, 63, 3),
        ("p-m004", "ES-MX3000", "Swing Door",         "entry_door",       1600, 2.00,  42, 96, 4),
        ("p-m005", "ES-MX4000", "Sliding Glass Door", "sliding_glass_door",1400,1.80, 144, 96, 4),
    ]
    for p in multimax:
        db.execute("""INSERT INTO products
            (id,tenant_id,name,model_number,product_line,manufacturer,type,
             base_cost,size_multiplier_per_sqft,min_width,max_width,min_height,max_height,lead_time_weeks)
            VALUES (?,?,?,?,'Multimax','ESWindows',?,?,?,12,?,12,?,?)""",
            (p[0], tenant_id, p[2], p[1], p[3], p[4], p[5], p[6], p[7], p[8]))

    # DP Ratings
    dp_data = [
        # Prestige
        ("dp-p001", "p-p001",  95, 105, 48,  84,  None, 1, 3, "23-0401.01"),
        ("dp-p002", "p-p002",  95, 105, 60, 144,  None, 1, 4, "23-0401.02"),
        ("dp-p003", "p-p003",  55,  55, 60, 144,  None, 1, 2, "23-0401.03"),
        ("dp-p004", "p-p004",  90, 120, 84, 180,  None, 1, 4, "23-0401.04"),
        ("dp-p005", "p-p005",  80,  80, 72,  62,  None, 1, 3, "23-0401.05"),
        ("dp-p006", "p-p006",  85,  85, 53,  74,  None, 1, 3, "23-0401.06"),
        ("dp-p007", "p-p007", 100, 120, 42,  96,  None, 1, 4, "23-0401.07"),
        ("dp-p008", "p-p008",  90, 100, 72, 120,  None, 1, 3, "23-0401.08"),
        ("dp-p009", "p-p009",  80,  80,192, 120,  None, 1, 3, "23-0401.09"),
        ("dp-p010", "p-p010",  75,  75,240, 120,  None, 1, 3, "23-0401.10"),
        ("dp-p011", "p-p011",  95,  95,240, 120,  None, 1, 3, "23-0401.11"),
        # Elite
        ("dp-e001", "p-e001",  80,  80, 53,  74,  None, 1, 3, "23-0402.01"),
        ("dp-e002", "p-e002",  80,  80, 72,  96,  None, 1, 3, "23-0402.02"),
        ("dp-e003", "p-e003",  80,  80, 73,  62,  None, 1, 3, "23-0402.03"),
        ("dp-e004", "p-e004",  80,  80, 48,  84,  None, 1, 3, "23-0402.04"),
        ("dp-e005", "p-e005",  80,  80, 72,  96,  None, 1, 3, "23-0402.05"),
        ("dp-e006", "p-e006",  80,  80,144,  96,  None, 1, 3, "23-0402.06"),
        # Multimax
        ("dp-m001", "p-m001",  70,  70, 53,  74,  None, 0, 2, "23-0403.01"),
        ("dp-m002", "p-m002",  70,  70, 72,  96,  None, 0, 2, "23-0403.02"),
        ("dp-m003", "p-m003",  70,  70,111,  63,  None, 0, 2, "23-0403.03"),
        ("dp-m004", "p-m004",  70,  70, 42,  96,  None, 0, 2, "23-0403.04"),
        ("dp-m005", "p-m005",  70,  70,144,  96,  None, 0, 2, "23-0403.05"),
    ]
    for d in dp_data:
        dp_id, product_id, dp_pos, dp_neg, max_w, max_h, max_sqft, hvhz, stories, noa = d
        sqft_val = max_sqft if max_sqft else round((max_w * max_h) / 144.0, 1)
        db.execute("""INSERT INTO dp_ratings
            (id,product_id,tenant_id,dp_positive,dp_negative,
             max_width_for_dp,max_height_for_dp,max_sqft_for_dp,
             hvhz_approved,max_story_height,missile_rating,noa_number,active)
            VALUES (?,?,?,?,?,?,?,?,?,?,'large',?,1)""",
            (dp_id, product_id, tenant_id, dp_pos, dp_neg,
             max_w, max_h, sqft_val, hvhz, stories, noa))

    # NOA records (legacy compat)
    noa_records = [
        ("noa-p001", tenant_id, "p-p001", "23-0401.01", 105, 3, 1),
        ("noa-p002", tenant_id, "p-p002", "23-0401.02", 105, 4, 1),
        ("noa-p003", tenant_id, "p-p003", "23-0401.03",  55, 2, 1),
        ("noa-p004", tenant_id, "p-p004", "23-0401.04", 120, 4, 1),
        ("noa-p005", tenant_id, "p-p005", "23-0401.05",  80, 3, 1),
        ("noa-p006", tenant_id, "p-p006", "23-0401.06",  85, 3, 1),
        ("noa-p007", tenant_id, "p-p007", "23-0401.07", 120, 4, 1),
        ("noa-p008", tenant_id, "p-p008", "23-0401.08", 100, 3, 1),
        ("noa-p009", tenant_id, "p-p009", "23-0401.09",  80, 3, 1),
        ("noa-p010", tenant_id, "p-p010", "23-0401.10",  75, 3, 1),
        ("noa-p011", tenant_id, "p-p011", "23-0401.11",  95, 3, 1),
        ("noa-e001", tenant_id, "p-e001", "23-0402.01",  80, 3, 1),
        ("noa-e002", tenant_id, "p-e002", "23-0402.02",  80, 3, 1),
        ("noa-e003", tenant_id, "p-e003", "23-0402.03",  80, 3, 1),
        ("noa-e004", tenant_id, "p-e004", "23-0402.04",  80, 3, 1),
        ("noa-e005", tenant_id, "p-e005", "23-0402.05",  80, 3, 1),
        ("noa-e006", tenant_id, "p-e006", "23-0402.06",  80, 3, 1),
        ("noa-m001", tenant_id, "p-m001", "23-0403.01",  70, 2, 0),
        ("noa-m002", tenant_id, "p-m002", "23-0403.02",  70, 2, 0),
        ("noa-m003", tenant_id, "p-m003", "23-0403.03",  70, 2, 0),
        ("noa-m004", tenant_id, "p-m004", "23-0403.04",  70, 2, 0),
        ("noa-m005", tenant_id, "p-m005", "23-0403.05",  70, 2, 0),
    ]
    for n in noa_records:
        db.execute("INSERT INTO noa_records (id,tenant_id,product_id,noa_number,pressure_rating,max_story_height,hvhz_certified) VALUES (?,?,?,?,?,?,?)", n)

    # Complexity Items
    complexity = [
        ("cx-001", tenant_id, "Concrete slab cut required",     450),
        ("cx-002", tenant_id, "Frame removal & disposal",       180),
        ("cx-003", tenant_id, "High-access equipment needed",   600),
        ("cx-004", tenant_id, "Long-distance material haul",    220),
        ("cx-005", tenant_id, "Structural header modification",  850),
        ("cx-006", tenant_id, "Stucco repair required",         320),
        ("cx-007", tenant_id, "Mull post installation",         175),
        ("cx-008", tenant_id, "Permit expedite fee",            380),
    ]
    for cx in complexity:
        db.execute("INSERT INTO complexity_items VALUES (?,?,?,?,1)", cx)

    # Consumables
    consumables = [
        ("cons-001", tenant_id, "Buck Material (CBS)",    85,  "per_opening", "cbs",   0),
        ("cons-002", tenant_id, "Buck Material (Frame)",  65,  "per_opening", "frame", 0),
        ("cons-003", tenant_id, "Tapcon Anchors",         12,  "per_opening", None,    0),
        ("cons-004", tenant_id, "Sealant (DAP/OSI)",      18,  "per_opening", None,    0),
        ("cons-005", tenant_id, "Floor Protection",       35,  "per_opening", None,    0),
        ("cons-006", tenant_id, "Foam Backer Rod",         8,  "per_opening", None,    0),
        ("cons-007", tenant_id, "Debris Removal",        150,  "per_job",     None,    0),
        ("cons-008", tenant_id, "Stucco Patch Material",  45,  "per_opening", "cbs",   0),
    ]
    for c in consumables:
        db.execute("INSERT INTO consumables (id,tenant_id,name,unit_cost,unit,wall_type_filter,min_openings,active) VALUES (?,?,?,?,?,?,?,1)", c)

    # Global Settings
    gs = [
        ("gs-001", tenant_id, "global_multiplier",            "1.00"),
        ("gs-002", tenant_id, "default_markup",               "1.75"),
        ("gs-003", tenant_id, "mull_bar_cost",                "45"),
        ("gs-004", tenant_id, "mull_reinforcement_cost",      "85"),
        ("gs-005", tenant_id, "assembly_labor_per_mull",      "120"),
        ("gs-006", tenant_id, "ui_hide_pricing",               "0"),
        ("gs-007", tenant_id, "ui_hide_margin",                "0"),
        ("gs-008", tenant_id, "ui_hide_everything",            "0"),
        ("gs-009", tenant_id, "default_zone",                  "HVHZ"),
        ("gs-010", tenant_id, "pricing_intelligence_managers", "0"),
        ("gs-011", tenant_id, "hvhz_only_mode",                "1"),
    ]
    for g in gs:
        db.execute("INSERT INTO global_settings (id,tenant_id,setting_key,setting_value) VALUES (?,?,?,?)", g)

    # Tenant feature flags
    flags = [
        ("ff-001", tenant_id, "governance_v2026", 1, None),
        ("ff-002", tenant_id, "approval_loop", 1, None),
        ("ff-003", tenant_id, "system_console", 1, None),
        ("ff-004", tenant_id, "impersonation", 1, None),
        ("ff-005", tenant_id, "auth_required", 1, None),
    ]
    for ff in flags:
        db.execute(
            "INSERT INTO feature_flags (id,tenant_id,flag_key,enabled,config_json) VALUES (?,?,?,?,?)",
            ff,
        )
    # Lead Time Overrides
    lt_overrides = [
        ("lt-001", tenant_id, "fc-002", None,       2),
        ("lt-002", tenant_id, "fc-006", None,       3),
        ("lt-003", tenant_id, "fc-007", None,       4),
        ("lt-004", tenant_id, "fc-008", None,       4),
        ("lt-005", tenant_id, "fc-009", None,       4),
        ("lt-006", tenant_id, "fc-010", None,       4),
        ("lt-007", tenant_id, "fc-011", "Prestige", 6),
    ]
    for lt in lt_overrides:
        db.execute("INSERT INTO lead_time_overrides (id,tenant_id,frame_color_id,product_line,lead_time_weeks,active) VALUES (?,?,?,?,?,1)", lt)

    # Assembly Templates
    templates = [
        ("at-001", tenant_id, "Twin Single Hung",        "2-wide", 2,
         "Two SH windows mulled together",
         '["single_hung","single_hung"]'),
        ("at-002", tenant_id, "Triple Single Hung",      "3-wide", 3,
         "Three SH windows mulled",
         '["single_hung","single_hung","single_hung"]'),
        ("at-003", tenant_id, "Picture + 2 Flanking",    "3-wide", 3,
         "Center fixed with casement flankers",
         '["casement","fixed","casement"]'),
        ("at-004", tenant_id, "Slider + Fixed",          "2-wide", 2,
         "Slider with fixed sidelight",
         '["horizontal_roller","fixed"]'),
        ("at-005", tenant_id, "2x2 Grid",                "2x2",    4,
         "Four fixed windows in grid",
         '["fixed","fixed","fixed","fixed"]'),
        ("at-006", tenant_id, "Picture + 2 SH",          "3-wide", 3,
         "Center picture with SH flankers",
         '["single_hung","fixed","single_hung"]'),
    ]
    for t in templates:
        db.execute("INSERT INTO assembly_templates (id,tenant_id,name,layout_type,panel_count,description,default_types,active) VALUES (?,?,?,?,?,?,?,1)", t)

    # Governance Settings
    gov = [
        ("gov-001", tenant_id, "junior",   38.0, 3.0, 1),
        ("gov-002", tenant_id, "standard", 35.0, 3.0, 1),
        ("gov-003", tenant_id, "senior",   30.0, 3.0, 1),
    ]
    for g in gov:
        db.execute("INSERT INTO governance_settings (id,tenant_id,tier,margin_floor,yellow_threshold,discount_approval_required) VALUES (?,?,?,?,?,?)", g)

    # Floor Labor
    floors = [
        ("fl-001", tenant_id, 1,   0),
        ("fl-002", tenant_id, 2, 180),
        ("fl-003", tenant_id, 3, 420),
        ("fl-004", tenant_id, 4, 750),
    ]
    for f in floors:
        db.execute("INSERT INTO floor_labor VALUES (?,?,?,?)", f)

    # Territory Multipliers
    zips = [
        ("tm-001", tenant_id, "33139", 1.08),
        ("tm-002", tenant_id, "33316", 1.00),
        ("tm-003", tenant_id, "33019", 1.05),
        ("tm-004", tenant_id, "33062", 1.04),
        ("tm-005", tenant_id, "33004", 1.02),
        ("tm-006", tenant_id, "33308", 1.01),
        ("tm-007", tenant_id, "33060", 1.03),
    ]
    for z in zips:
        db.execute("INSERT INTO territory_multipliers VALUES (?,?,?,?)", z)

    zone_requirements = [
        ("zone-001", tenant_id, "HVHZ", 80.0, 1, 4),
        ("zone-002", tenant_id, "COASTAL", 65.0, 1, 4),
        ("zone-003", tenant_id, "INLAND", 50.0, 0, 4),
    ]
    for zr in zone_requirements:
        db.execute(
            "INSERT INTO zone_pressure_requirements (id,tenant_id,zone_code,required_dp,hvhz_required,max_story_height,active) VALUES (?,?,?,?,?,?,1)",
            zr,
        )

    # Demo Quotes
    q1_id = "q-001"
    db.execute("""INSERT INTO quotes (id,tenant_id,rep_id,customer_name,customer_phone,customer_email,
        job_address,job_zip,status,total_price,total_cost,margin_pct,margin_dollars,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        q1_id, tenant_id, "u-rep-001", "Maria Garcia", "(305) 555-0142", "maria.garcia@email.com",
        "1234 Ocean Drive, Miami Beach, FL 33139", "33139", "draft",
        28450, 16501, 42.0, 11949, None,
        (now - timedelta(hours=2)).isoformat(), now.isoformat()
    ))

    db.execute("""INSERT INTO openings
        (id,quote_id,tenant_id,opening_number,opening_mode,opening_type,total_width,total_height,
         floor_level,wall_type,product_id,glass_option_id,frame_color_id,complexity_ids,
         sell_price,total_cost,margin_pct,margin_dollars,dp_status,dp_rating_used,noa_number)
        VALUES (?,?,?,?,'single',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        "o-001", q1_id, tenant_id, 1, "sliding_glass_door", 96, 80,
        2, "cbs", "p-p009", "g-001", "fc-001", '["cx-001"]',
        5200, 2980, 42.7, 2220, "passed", 80, "23-0401.09"
    ))
    db.execute("""INSERT INTO openings
        (id,quote_id,tenant_id,opening_number,opening_mode,opening_type,total_width,total_height,
         floor_level,wall_type,product_id,glass_option_id,frame_color_id,complexity_ids,
         sell_price,total_cost,margin_pct,margin_dollars,dp_status,dp_rating_used,noa_number)
        VALUES (?,?,?,?,'single',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        "o-002", q1_id, tenant_id, 2, "single_hung", 48, 60,
        1, "cbs", "p-p006", "g-001", "fc-001", '[]',
        2120, 1190, 43.9, 930, "passed", 85, "23-0401.06"
    ))
    db.execute("""INSERT INTO openings
        (id,quote_id,tenant_id,opening_number,opening_mode,opening_type,total_width,total_height,
         floor_level,wall_type,product_id,glass_option_id,frame_color_id,complexity_ids,
         sell_price,total_cost,margin_pct,margin_dollars,dp_status,dp_rating_used,noa_number)
        VALUES (?,?,?,?,'single',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        "o-003", q1_id, tenant_id, 3, "single_hung", 36, 48,
        1, "cbs", "p-e001", "g-002", "fc-001", '[]',
        1680, 980, 41.7, 700, "passed", 80, "23-0402.01"
    ))

    # Quote 2 ? Pending approval
    q2_id = "q-002"
    db.execute("""INSERT INTO quotes (id,tenant_id,rep_id,customer_name,customer_phone,customer_email,
        job_address,job_zip,status,total_price,total_cost,margin_pct,margin_dollars,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        q2_id, tenant_id, "u-rep-002", "John Smith", "(954) 555-0198", "john.smith@email.com",
        "5678 Palm Ave, Fort Lauderdale, FL 33316", "33316", "pending_approval",
        41200, 29252, 29.0, 11948, None,
        (now - timedelta(hours=5)).isoformat(), (now - timedelta(minutes=30)).isoformat()
    ))
    db.execute("""INSERT INTO approval_requests
        (id,quote_id,tenant_id,rep_id,current_margin,requested_margin,rep_note,status,created_at)
        VALUES (?,?,?,?,?,?,?,?,?)""", (
        "ar-001", q2_id, tenant_id, "u-rep-002", 29.0, 29.0,
        "Competitive situation ? neighbor already has a lower quote from competitor",
        "pending", (now - timedelta(minutes=30)).isoformat()
    ))

    q2_openings = [
        ("sliding_glass_door", 120, 96, 1, "p-p009", 8200, 5900),
        ("single_hung",         36, 60, 2, "p-e001", 3400, 2450),
        ("single_hung",         36, 60, 2, "p-e001", 3400, 2450),
        ("fixed",               48, 72, 1, "p-e002", 4200, 3020),
        ("entry_door",          42, 84, 1, "p-p007", 12000, 8632),
    ]
    for i, (otype, w, h, fl, pid, price, cost) in enumerate(q2_openings, 1):
        margin_pct = round((price - cost) / price * 100, 1) if price > 0 else 0
        db.execute("""INSERT INTO openings
            (id,quote_id,tenant_id,opening_number,opening_mode,opening_type,total_width,total_height,
             floor_level,wall_type,product_id,glass_option_id,frame_color_id,complexity_ids,
             sell_price,total_cost,margin_pct,margin_dollars,dp_status,noa_number)
            VALUES (?,?,?,?,'single',?,?,?,?,'cbs',?,?,?,?,?,?,?,?,?,?)""", (
            f"o-q2-{i}", q2_id, tenant_id, i, otype, w, h, fl, pid,
            "g-001", "fc-001", '[]', price, cost, margin_pct, price - cost,
            "passed", "N/A"
        ))

    # Quote 3 ? Completed
    q3_id = "q-003"
    db.execute("""INSERT INTO quotes (id,tenant_id,rep_id,customer_name,customer_phone,customer_email,
        job_address,job_zip,status,total_price,total_cost,margin_pct,margin_dollars,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        q3_id, tenant_id, "u-rep-001", "David Chen", "(954) 555-0277", "dchen@email.com",
        "900 N Ocean Blvd, Pompano Beach, FL 33062", "33062", "completed",
        18750, 10875, 42.0, 7875, None,
        (now - timedelta(days=1)).isoformat(), (now - timedelta(hours=18)).isoformat()
    ))

    # Quote 4 ? Empty draft
    q4_id = "q-004"
    db.execute("""INSERT INTO quotes (id,tenant_id,rep_id,customer_name,customer_phone,customer_email,
        job_address,job_zip,status,total_price,total_cost,margin_pct,margin_dollars,notes,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""", (
        q4_id, tenant_id, "u-rep-001", "Patricia Williams", "(954) 555-0333", "pwilliams@email.com",
        "4200 Galt Ocean Dr, Fort Lauderdale, FL 33308", "33308", "draft",
        0, 0, 0, 0, None, now.isoformat(), now.isoformat()
    ))

    # Audit entries
    audit_entries = [
        ("al-001", tenant_id, "quote_created",    "quote", q1_id, "u-rep-001", "Jordan Blake",
         json.dumps({"customer": "Maria Garcia", "address": "1234 Ocean Drive"}),
         (now - timedelta(hours=2)).isoformat()),
        ("al-002", tenant_id, "opening_added",    "opening", "o-001", "u-rep-001", "Jordan Blake",
         json.dumps({"opening_type": "sliding_glass_door", "price": 5200}),
         (now - timedelta(hours=1, minutes=50)).isoformat()),
        ("al-003", tenant_id, "approval_requested", "quote", q2_id, "u-rep-002", "Carlos Mendez",
         json.dumps({"margin": 29.0, "floor": 35.0, "note": "Competitive situation"}),
         (now - timedelta(minutes=30)).isoformat()),
        ("al-004", tenant_id, "quote_completed",  "quote", q3_id, "u-rep-001", "Jordan Blake",
         json.dumps({"total": 18750, "margin": 42.0}),
         (now - timedelta(hours=18)).isoformat()),
        ("al-005", tenant_id, "db_migrated",      "system", "schema", "system", "System",
         json.dumps({"schema_version": SCHEMA_VERSION}), now.isoformat()),
    ]
    for a in audit_entries:
        db.execute("INSERT INTO audit_log (id,tenant_id,event_type,entity_type,entity_id,user_id,user_name,details,created_at) VALUES (?,?,?,?,?,?,?,?,?)", a)

    db.commit()


# ---------------------------------------------------------------------------
# TENANT + SESSION HELPERS
# ---------------------------------------------------------------------------

def _tenant_public_dict(tenant_row, membership_row=None):
    if not tenant_row:
        return None
    item = {
        "id": tenant_row["id"],
        "name": tenant_row["name"],
        "logo_url": tenant_row["logo_url"],
        "license_number": tenant_row["license_number"],
        "phone": tenant_row["phone"],
        "email": tenant_row["email"],
        "address": tenant_row["address"],
        "created_at": tenant_row["created_at"],
    }
    if membership_row:
        item["user_id"] = membership_row["id"]
        item["role"] = _role_normalize(membership_row["role"])
        item["tier"] = membership_row["tier"]
        item["active"] = bool(membership_row["active"])
    return item


def _get_tenant_row(db, tenant_id):
    if not tenant_id:
        return None
    return db.execute("SELECT * FROM tenants WHERE id=?", (tenant_id,)).fetchone()


ONBOARDING_STEPS = [
    ("company_profile", "Complete company profile"),
    ("catalog_loaded", "Add at least one product"),
    ("pricing_points", "Add pricing points for your products"),
    ("governance_reviewed", "Configure governance settings"),
    ("users_invited", "Invite your first team member"),
    ("test_quote", "Create a test quote"),
    ("ai_pricing_studio", "Configure AI Pricing Studio (optional)"),
    ("pricing_intelligence", "Review Pricing Intelligence analytics"),
]

GOVERNANCE_OVERRIDE_TYPES = {
    "margin_floor": "Margin Floor",
    "max_discount": "Max Discount",
    "yellow_threshold": "Yellow Threshold",
}


def _is_sysop_ctx(auth_ctx):
    if not auth_ctx or not auth_ctx.get("user"):
        return False
    return _role_normalize(auth_ctx["user"]["role"]) == "sysop"


def _assert_tenant_match(row, auth_ctx, label="Resource"):
    if not row:
        return
    if not auth_ctx or not auth_ctx.get("tenant_id"):
        abort(403, description=f"{label} access requires an authenticated tenant context.")
    if row["tenant_id"] != auth_ctx["tenant_id"]:
        abort(403, description=f"{label} does not belong to this tenant.")


def _load_user_row_any_tenant(db, user_id):
    if not user_id:
        return None
    return db.execute("SELECT * FROM users WHERE id=?", (user_id,)).fetchone()


def _load_product_row_any_tenant(db, product_id):
    if not product_id:
        return None
    return db.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()


def _load_opening_row_any_tenant(db, opening_id):
    if not opening_id:
        return None
    return db.execute("SELECT * FROM openings WHERE id=?", (opening_id,)).fetchone()


def _get_onboarding_status(db, tenant_id, persist_complete=False):
    row = db.execute(
        """SELECT t.*,
                  (SELECT COUNT(*) FROM products p WHERE p.tenant_id=t.id AND p.active=1) AS product_count,
                  (SELECT COUNT(*) FROM product_price_points pp WHERE pp.tenant_id=t.id AND pp.active=1) AS pricing_point_count,
                  (SELECT COUNT(*) FROM governance_settings gs WHERE gs.tenant_id=t.id) AS governance_count,
                  (SELECT COUNT(*) FROM users u WHERE u.tenant_id=t.id AND u.active=1) AS user_count,
                  (SELECT COUNT(*) FROM quotes q WHERE q.tenant_id=t.id) AS quote_count
           FROM tenants t
           WHERE t.id=?""",
        (tenant_id,),
    ).fetchone()
    if not row:
        return {
            "state": "pending",
            "steps": [],
            "complete_count": 0,
            "total_count": len(ONBOARDING_STEPS),
            "all_done": False,
            "blockers": [label for _, label in ONBOARDING_STEPS],
            "completed_steps": [],
        }

    tenant_data = dict(row)
    checks = {
        "company_profile": all(
            str(tenant_data.get(field) or "").strip()
            for field in ("name", "phone", "email", "address", "license_number")
        ),
        "catalog_loaded": int(tenant_data.get("product_count") or 0) > 0,
        "pricing_points": int(tenant_data.get("pricing_point_count") or 0) > 0,
        "governance_reviewed": int(tenant_data.get("governance_count") or 0) > 0,
        "users_invited": int(tenant_data.get("user_count") or 0) >= 2,
        "test_quote": int(tenant_data.get("quote_count") or 0) > 0,
    }

    # Section 6B: AI Pricing Studio — optional step
    ai_flag = db.execute(
        "SELECT enabled FROM feature_flags WHERE tenant_id=? AND flag_key='ai_pricing_studio'",
        (tenant_id,),
    ).fetchone()
    ai_flag_enabled = bool(ai_flag and ai_flag["enabled"])
    ai_profile_exists = db.execute(
        "SELECT 1 FROM ai_pricing_profiles WHERE tenant_id=? LIMIT 1", (tenant_id,)
    ).fetchone() is not None
    # Step is done if: flag disabled OR at least one profile exists
    checks["ai_pricing_studio"] = (not ai_flag_enabled) or ai_profile_exists

    # Section 6C: Pricing Intelligence — step done when at least 1 approved/completed quote exists
    pi_flag = db.execute(
        "SELECT enabled FROM feature_flags WHERE tenant_id=? AND flag_key='pricing_intelligence_console'",
        (tenant_id,),
    ).fetchone()
    pi_flag_enabled = bool(pi_flag and pi_flag["enabled"])
    pi_data_exists = False
    if pi_flag_enabled:
        pi_data_exists = db.execute(
            "SELECT 1 FROM quotes WHERE tenant_id=? AND status IN ('approved','completed') LIMIT 1",
            (tenant_id,),
        ).fetchone() is not None
    # Step done if flag disabled OR data exists to view
    checks["pricing_intelligence"] = (not pi_flag_enabled) or pi_data_exists

    steps = [{"key": key, "label": label, "done": bool(checks.get(key))} for key, label in ONBOARDING_STEPS]
    completed_steps = [step["key"] for step in steps if step["done"]]
    complete_count = len(completed_steps)
    total_count = len(steps)
    all_done = complete_count == total_count and total_count > 0

    stored_state = str(tenant_data.get("onboarding_state") or "pending").strip().lower()
    if stored_state not in ("pending", "in_progress", "complete"):
        stored_state = "pending"

    if stored_state == "complete" or all_done:
        state = "complete"
    elif complete_count > 0:
        state = "in_progress"
    else:
        state = "pending"

    if persist_complete and all_done and stored_state != "complete":
        db.execute(
            "UPDATE tenants SET onboarding_state='complete', onboarding_completed_steps=? WHERE id=?",
            (json.dumps(completed_steps), tenant_id),
        )

    return {
        "state": state,
        "steps": steps,
        "complete_count": complete_count,
        "total_count": total_count,
        "all_done": all_done,
        "blockers": [step["label"] for step in steps if not step["done"]],
        "completed_steps": completed_steps,
    }


def _build_onboarding_summary(db, tenant_id, tenant_row=None):
    return _get_onboarding_status(db, tenant_id, persist_complete=False)


def _build_tenant_health_summary(db, tenant_id, tenant_row=None):
    tenant_row = tenant_row or _get_tenant_row(db, tenant_id)
    if not tenant_row:
        return None

    onboarding = _get_onboarding_status(db, tenant_id, persist_complete=False)
    user_count = db.execute(
        "SELECT COUNT(*) AS c FROM users WHERE tenant_id=? AND active=1",
        (tenant_id,),
    ).fetchone()["c"]
    product_count = db.execute(
        "SELECT COUNT(*) AS c FROM products WHERE tenant_id=? AND active=1",
        (tenant_id,),
    ).fetchone()["c"]
    active_quotes = db.execute(
        """SELECT COUNT(*) AS c
           FROM quotes
           WHERE tenant_id=?
             AND status IN ('draft','pending_approval','approved')""",
        (tenant_id,),
    ).fetchone()["c"]
    pending_approvals = db.execute(
        "SELECT COUNT(*) AS c FROM approval_requests WHERE tenant_id=? AND status='pending'",
        (tenant_id,),
    ).fetchone()["c"]
    last_quote_activity = db.execute(
        "SELECT MAX(COALESCE(updated_at, created_at)) AS last_activity FROM quotes WHERE tenant_id=?",
        (tenant_id,),
    ).fetchone()["last_activity"]
    has_governance = db.execute(
        "SELECT 1 FROM governance_settings WHERE tenant_id=? LIMIT 1",
        (tenant_id,),
    ).fetchone() is not None
    has_pricing_points = db.execute(
        "SELECT 1 FROM product_price_points WHERE tenant_id=? AND active=1 LIMIT 1",
        (tenant_id,),
    ).fetchone() is not None

    return {
        "tenant_id": tenant_row["id"],
        "tenant_name": tenant_row["name"],
        "user_count": int(user_count or 0),
        "product_count": int(product_count or 0),
        "active_quotes": int(active_quotes or 0),
        "pending_approvals": int(pending_approvals or 0),
        "last_quote_activity": _json_safe_data(last_quote_activity),
        "has_governance": bool(has_governance),
        "has_pricing_points": bool(has_pricing_points),
        "twilio_enabled": _twilio_enabled(),
        "maps_enabled": bool(GOOGLE_MAPS_API_KEY),
        "onboarding_complete": onboarding["state"] == "complete",
        "onboarding": onboarding,
    }


def _feature_flag_dict_for_tenant(db, tenant_id):
    rows = db.execute(
        "SELECT flag_key, enabled FROM feature_flags WHERE tenant_id=? ORDER BY flag_key",
        (tenant_id,),
    ).fetchall()
    return {row["flag_key"]: bool(row["enabled"]) for row in rows}


def _upsert_feature_flags_for_tenant(db, tenant_id, flags):
    updated = 0
    for flag_key, enabled in (flags or {}).items():
        key = (flag_key or "").strip()
        if not key:
            continue
        db.execute(
            """INSERT INTO feature_flags (id,tenant_id,flag_key,enabled,config_json,updated_at)
               VALUES (?,?,?,?,?,?)
               ON CONFLICT(tenant_id,flag_key)
               DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at""",
            (
                f"ff-{uuid.uuid4().hex[:8]}",
                tenant_id,
                key,
                1 if enabled else 0,
                None,
                _now_iso(),
            ),
        )
        updated += 1
    return updated


def _list_accessible_tenants_for_email(db, email, current_tenant_id=None):
    email = _normalize_email(email)
    if not email:
        return []
    rows = db.execute(
        """SELECT t.*, u.id AS user_id, u.role AS role, u.tier AS tier, u.active AS active
           FROM users u
           JOIN tenants t ON t.id=u.tenant_id
           WHERE lower(u.email)=? AND u.active=1
           ORDER BY lower(t.name), lower(u.role)""",
        (email,),
    ).fetchall()
    items = [_tenant_public_dict(r, r) for r in rows]
    items.sort(key=lambda item: (0 if item["id"] == current_tenant_id else 1, (item.get("name") or "").lower()))
    return items


def _revoke_auth_session(db, session_id):
    if not session_id:
        return
    db.execute("UPDATE auth_sessions SET revoked_at=? WHERE id=?", (_now_iso(), session_id))


def _build_auth_payload(db, user_row, expires_at=None, impersonated_by=None):
    user = _user_public_dict(user_row)
    tenant = _get_tenant_row(db, user_row["tenant_id"])
    payload = {
        "status": "ok",
        "app_version": APP_VERSION,
        "schema_version": SCHEMA_VERSION,
        "user": user,
        "tenant_id": user_row["tenant_id"],
        "tenant": _tenant_public_dict(tenant, user_row),
        "available_tenants": _list_accessible_tenants_for_email(
            db,
            user_row["email"],
            current_tenant_id=user_row["tenant_id"],
        ),
        "impersonated_by": impersonated_by,
        "impersonator": None,
    }
    if expires_at:
        payload["expires_at"] = expires_at
    if impersonated_by:
        original_user = db.execute("SELECT * FROM users WHERE id=? AND active=1", (impersonated_by,)).fetchone()
        if original_user:
            payload["impersonator"] = _user_public_dict(original_user)
    return payload


def _create_user_record(
    db,
    tenant_id,
    name,
    email,
    role,
    tier="standard",
    password=None,
    password_hash=None,
    permissions=None,
    must_change_password=1,
    active=1,
    user_id=None,
):
    normalized_email = _normalize_email(email)
    uid = user_id or f"u-{uuid.uuid4().hex[:8]}"
    final_hash = password_hash or _hash_password(password or _generate_temp_password())
    db.execute(
        """INSERT INTO users (id,tenant_id,name,email,role,tier,permissions_json,password_hash,must_change_password,active)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            uid,
            tenant_id,
            (name or "").strip(),
            normalized_email,
            _role_normalize(role),
            tier if tier in ("junior", "standard", "senior") else "standard",
            _permissions_to_json(role, permissions),
            final_hash,
            1 if must_change_password else 0,
            1 if active else 0,
        ),
    )
    return uid


def _tenant_id_from_name(name):
    base = re.sub(r"[^a-z0-9]+", "-", (name or "").strip().lower()).strip("-")
    base = base or "company"
    base = base[:36]
    return f"t-{base}"


def _generate_unique_tenant_id(db, name, explicit_id=""):
    candidate = (explicit_id or "").strip().lower()
    if candidate:
        candidate = re.sub(r"[^a-z0-9-]+", "-", candidate).strip("-")
        if not candidate.startswith("t-"):
            candidate = f"t-{candidate}"
    else:
        candidate = _tenant_id_from_name(name)

    suffix = 1
    original = candidate
    while db.execute("SELECT 1 FROM tenants WHERE id=?", (candidate,)).fetchone():
        candidate = f"{original[:40]}-{suffix}"
        suffix += 1
    return candidate


def _clone_lookup_table(db, table_name, source_tenant_id, target_tenant_id, id_prefix, columns):
    rows = db.execute(
        f"SELECT id,{','.join(columns)} FROM {table_name} WHERE tenant_id=?",
        (source_tenant_id,),
    ).fetchall()
    mapping = {}
    for row in rows:
        new_id = f"{id_prefix}-{uuid.uuid4().hex[:8]}"
        mapping[row["id"]] = new_id
        insert_columns = ["id", "tenant_id", *columns]
        values = [new_id, target_tenant_id, *[row[col] for col in columns]]
        db.execute(
            f"INSERT INTO {table_name} ({','.join(insert_columns)}) VALUES ({','.join(['?'] * len(insert_columns))})",
            values,
        )
    return mapping


def _clone_simple_table(db, table_name, source_tenant_id, target_tenant_id, id_prefix, columns):
    rows = db.execute(
        f"SELECT {','.join(columns)} FROM {table_name} WHERE tenant_id=?",
        (source_tenant_id,),
    ).fetchall()
    for row in rows:
        insert_columns = ["id", "tenant_id", *columns]
        values = [f"{id_prefix}-{uuid.uuid4().hex[:8]}", target_tenant_id, *[row[col] for col in columns]]
        db.execute(
            f"INSERT INTO {table_name} ({','.join(insert_columns)}) VALUES ({','.join(['?'] * len(insert_columns))})",
            values,
        )


def _seed_tenant_basics(db, source_tenant_id, target_tenant_id):
    _clone_simple_table(
        db,
        "complexity_items",
        source_tenant_id,
        target_tenant_id,
        "cx",
        ["name", "cost", "active"],
    )
    _clone_simple_table(
        db,
        "consumables",
        source_tenant_id,
        target_tenant_id,
        "cons",
        ["name", "unit_cost", "unit", "wall_type_filter", "min_openings", "active"],
    )
    _clone_simple_table(
        db,
        "global_settings",
        source_tenant_id,
        target_tenant_id,
        "gs",
        ["setting_key", "setting_value", "updated_at"],
    )
    _clone_simple_table(
        db,
        "feature_flags",
        source_tenant_id,
        target_tenant_id,
        "ff",
        ["flag_key", "enabled", "config_json", "updated_at"],
    )
    _clone_simple_table(
        db,
        "assembly_templates",
        source_tenant_id,
        target_tenant_id,
        "at",
        ["name", "layout_type", "panel_count", "description", "default_types", "active"],
    )
    _clone_simple_table(
        db,
        "governance_settings",
        source_tenant_id,
        target_tenant_id,
        "gov",
        ["tier", "margin_floor", "yellow_threshold", "discount_approval_required", "max_discount_pct", "updated_at"],
    )
    _clone_simple_table(
        db,
        "floor_labor",
        source_tenant_id,
        target_tenant_id,
        "fl",
        ["floor_level", "labor_adder"],
    )
    _clone_simple_table(
        db,
        "territory_multipliers",
        source_tenant_id,
        target_tenant_id,
        "tm",
        ["zip_code", "multiplier"],
    )
    _clone_simple_table(
        db,
        "zone_pressure_requirements",
        source_tenant_id,
        target_tenant_id,
        "zone",
        ["zone_code", "required_dp", "hvhz_required", "max_story_height", "active", "created_at"],
    )

    # --- Alpha 9.2: Seed default message templates for new tenants ---
    now = _now_iso()
    default_templates = [
        ("Appointment Reminder", "Hi {customer_name}, this is a reminder of your appointment tomorrow. Reply with any questions.", "appointment"),
        ("Quote Ready", "Hi {customer_name}, your estimate for {job_address} is ready. We'll be in touch shortly.", "general"),
        ("Follow Up", "Hi {customer_name}, following up on the estimate we provided. Do you have any questions?", "follow_up"),
    ]
    for tpl_name, tpl_body, tpl_cat in default_templates:
        db.execute(
            "INSERT OR IGNORE INTO message_templates (id,tenant_id,name,body,category,active,created_at) VALUES (?,?,?,?,?,1,?)",
            (f"mt-{uuid.uuid4().hex[:8]}", target_tenant_id, tpl_name, tpl_body, tpl_cat, now),
        )


def _clone_product_catalog(db, source_tenant_id, target_tenant_id):
    frame_color_map = _clone_lookup_table(
        db,
        "frame_colors",
        source_tenant_id,
        target_tenant_id,
        "fc",
        ["name", "cost_adder", "active"],
    )
    _clone_lookup_table(
        db,
        "glass_options",
        source_tenant_id,
        target_tenant_id,
        "g",
        ["name", "cost_adder", "active"],
    )

    product_rows = db.execute(
        """SELECT id,name,model_number,product_line,manufacturer,type,base_cost,size_multiplier_per_sqft,
                  min_width,max_width,min_height,max_height,frame_depth,lead_time_weeks,active,created_at
           FROM products WHERE tenant_id=?""",
        (source_tenant_id,),
    ).fetchall()
    product_map = {}
    for row in product_rows:
        new_id = f"p-{uuid.uuid4().hex[:8]}"
        product_map[row["id"]] = new_id
        db.execute(
            """INSERT INTO products
               (id,tenant_id,name,model_number,product_line,manufacturer,type,base_cost,size_multiplier_per_sqft,
                min_width,max_width,min_height,max_height,frame_depth,lead_time_weeks,active,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                new_id,
                target_tenant_id,
                row["name"],
                row["model_number"],
                row["product_line"],
                row["manufacturer"],
                row["type"],
                row["base_cost"],
                row["size_multiplier_per_sqft"],
                row["min_width"],
                row["max_width"],
                row["min_height"],
                row["max_height"],
                row["frame_depth"],
                row["lead_time_weeks"],
                row["active"],
                row["created_at"],
            ),
        )

    dp_rows = db.execute(
        """SELECT product_id,dp_positive,dp_negative,max_width_for_dp,max_height_for_dp,max_sqft_for_dp,
                  hvhz_approved,max_story_height,missile_rating,noa_number,active
           FROM dp_ratings WHERE tenant_id=?""",
        (source_tenant_id,),
    ).fetchall()
    for row in dp_rows:
        mapped_product_id = product_map.get(row["product_id"])
        if not mapped_product_id:
            continue
        db.execute(
            """INSERT INTO dp_ratings
               (id,product_id,tenant_id,dp_positive,dp_negative,max_width_for_dp,max_height_for_dp,max_sqft_for_dp,
                hvhz_approved,max_story_height,missile_rating,noa_number,active)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                f"dp-{uuid.uuid4().hex[:8]}",
                mapped_product_id,
                target_tenant_id,
                row["dp_positive"],
                row["dp_negative"],
                row["max_width_for_dp"],
                row["max_height_for_dp"],
                row["max_sqft_for_dp"],
                row["hvhz_approved"],
                row["max_story_height"],
                row["missile_rating"],
                row["noa_number"],
                row["active"],
            ),
        )

    noa_rows = db.execute(
        "SELECT product_id,noa_number,pressure_rating,max_story_height,hvhz_certified,pdf_url,active FROM noa_records WHERE tenant_id=?",
        (source_tenant_id,),
    ).fetchall()
    for row in noa_rows:
        mapped_product_id = product_map.get(row["product_id"])
        if not mapped_product_id:
            continue
        db.execute(
            """INSERT INTO noa_records (id,tenant_id,product_id,noa_number,pressure_rating,max_story_height,hvhz_certified,pdf_url,active)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                f"noa-{uuid.uuid4().hex[:8]}",
                target_tenant_id,
                mapped_product_id,
                row["noa_number"],
                row["pressure_rating"],
                row["max_story_height"],
                row["hvhz_certified"],
                row["pdf_url"],
                row["active"],
            ),
        )

    price_rows = db.execute(
        "SELECT product_id,width,height,price,active,created_at FROM product_price_points WHERE tenant_id=?",
        (source_tenant_id,),
    ).fetchall()
    for row in price_rows:
        mapped_product_id = product_map.get(row["product_id"])
        if not mapped_product_id:
            continue
        db.execute(
            """INSERT INTO product_price_points (id,tenant_id,product_id,width,height,price,active,created_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (
                f"pp-{uuid.uuid4().hex[:8]}",
                target_tenant_id,
                mapped_product_id,
                row["width"],
                row["height"],
                row["price"],
                row["active"],
                row["created_at"],
            ),
        )

    lead_time_rows = db.execute(
        "SELECT frame_color_id,product_line,lead_time_weeks,active FROM lead_time_overrides WHERE tenant_id=?",
        (source_tenant_id,),
    ).fetchall()
    for row in lead_time_rows:
        mapped_frame_color_id = frame_color_map.get(row["frame_color_id"]) if row["frame_color_id"] else None
        db.execute(
            """INSERT INTO lead_time_overrides (id,tenant_id,frame_color_id,product_line,lead_time_weeks,active)
               VALUES (?,?,?,?,?,?)""",
            (
                f"lt-{uuid.uuid4().hex[:8]}",
                target_tenant_id,
                mapped_frame_color_id,
                row["product_line"],
                row["lead_time_weeks"],
                row["active"],
            ),
        )


def _create_tenant_company(db, actor_row, payload):
    company_name = (payload.get("name") or "").strip()
    owner_name = (payload.get("owner_name") or "").strip()
    owner_email = _normalize_email(payload.get("owner_email"))
    owner_password = payload.get("owner_password") or _generate_temp_password()
    company_email = _normalize_email(payload.get("email")) or owner_email
    if len(owner_password) < 8:
        raise ValueError("Owner password must be at least 8 characters.")
    if not company_name or not owner_name or not owner_email:
        raise ValueError("Company name, owner name, and owner email are required.")

    tenant_id = _generate_unique_tenant_id(db, company_name, explicit_id=payload.get("tenant_id"))
    db.execute(
        "INSERT INTO tenants (id,name,logo_url,license_number,phone,email,address,created_at) VALUES (?,?,?,?,?,?,?,?)",
        (
            tenant_id,
            company_name,
            (payload.get("logo_url") or "").strip() or None,
            (payload.get("license_number") or "").strip() or None,
            (payload.get("phone") or "").strip() or None,
            company_email,
            (payload.get("address") or "").strip() or None,
            _now_iso(),
        ),
    )

    source_tenant_id = (payload.get("source_tenant_id") or "").strip() or (actor_row["tenant_id"] if actor_row else "")
    source_exists = db.execute("SELECT 1 FROM tenants WHERE id=?", (source_tenant_id,)).fetchone()
    if source_exists:
        _seed_tenant_basics(db, source_tenant_id, tenant_id)
    catalog_mode = (payload.get("catalog_mode") or "blank").strip().lower()
    if catalog_mode == "copy_current" and source_exists:
        _clone_product_catalog(db, source_tenant_id, tenant_id)

    owner_user_id = _create_user_record(
        db,
        tenant_id,
        owner_name,
        owner_email,
        "owner",
        tier="senior",
        password=owner_password,
        must_change_password=1,
        active=1,
    )

    if actor_row and _role_normalize(actor_row["role"]) == "sysop":
        bridge_email = _normalize_email(actor_row["email"])
        bridge_exists = db.execute(
            "SELECT 1 FROM users WHERE tenant_id=? AND lower(email)=?",
            (tenant_id, bridge_email),
        ).fetchone()
        if bridge_email and not bridge_exists:
            _create_user_record(
                db,
                tenant_id,
                actor_row["name"],
                bridge_email,
                "sysop",
                tier=actor_row["tier"],
                password_hash=actor_row["password_hash"],
                must_change_password=0,
                active=1,
            )

    tenant_row = _get_tenant_row(db, tenant_id)
    owner_row = db.execute("SELECT * FROM users WHERE id=? AND tenant_id=?", (owner_user_id, tenant_id)).fetchone()
    return {
        "tenant": _tenant_public_dict(tenant_row, owner_row),
        "owner_user": _user_public_dict(owner_row),
        "owner_temporary_password": owner_password,
        "catalog_mode": catalog_mode,
    }


def _ensure_second_demo_tenant(db):
    if not SEED_DEMO_DATA:
        return

    source_tenant_id = "t-demo-001"
    tenant_id = "t-demo-002"
    if db.execute("SELECT 1 FROM tenants WHERE id=?", (tenant_id,)).fetchone():
        return
    if not db.execute("SELECT 1 FROM tenants WHERE id=?", (source_tenant_id,)).fetchone():
        return

    now = datetime.now()
    created_at = now.isoformat()
    db.execute(
        "INSERT INTO tenants (id,name,logo_url,license_number,phone,email,address,created_at) VALUES (?,?,?,?,?,?,?,?)",
        (
            tenant_id,
            "SEASIDE IMPACT WINDOWS (DEMO)",
            None,
            "CGC7654321",
            "(954) 555-0211",
            "info@seaside-demo.example",
            "100 Demo Way, Oakland Park, FL 33334",
            created_at,
        ),
    )
    _seed_tenant_basics(db, source_tenant_id, tenant_id)

    source_sysop = db.execute(
        """SELECT name,email,password_hash,tier
           FROM users
           WHERE tenant_id=? AND lower(role)='sysop'
           ORDER BY created_at, id
           LIMIT 1""",
        (source_tenant_id,),
    ).fetchone()
    if source_sysop:
        _create_user_record(
            db,
            tenant_id,
            source_sysop["name"],
            source_sysop["email"],
            "sysop",
            tier=source_sysop["tier"],
            password_hash=source_sysop["password_hash"],
            must_change_password=0,
            active=1,
            user_id="u-d2-sysop-001",
        )

    user_specs = [
        ("u-d2-owner-001", "Leo Grant", "leo@seaside-demo.example", "owner", "senior"),
        ("u-d2-mgr-001", "Valerie Tate", "valerie@seaside-demo.example", "manager", "senior"),
        ("u-d2-mgr-002", "Owen Carter", "owen@seaside-demo.example", "manager", "standard"),
        ("u-d2-rep-001", "Dana Park", "dana@seaside-demo.example", "rep", "senior"),
        ("u-d2-rep-002", "Sadie Moore", "sadie@seaside-demo.example", "rep", "standard"),
        ("u-d2-rep-003", "Miles Hart", "miles@seaside-demo.example", "rep", "standard"),
        ("u-d2-rep-004", "Erin Cole", "erin@seaside-demo.example", "rep", "junior"),
        ("u-d2-rep-005", "Nate Brooks", "nate@seaside-demo.example", "rep", "standard"),
        ("u-d2-rep-006", "Paige Sloan", "paige@seaside-demo.example", "rep", "standard"),
        ("u-d2-view-001", "Bree Lane", "bree@seaside-demo.example", "viewer", "junior"),
    ]
    for user_id, name, email, role, tier in user_specs:
        _create_user_record(
            db,
            tenant_id,
            name,
            email,
            role,
            tier=tier,
            password=DEMO_PASSWORD,
            must_change_password=1,
            active=1,
            user_id=user_id,
        )

    frame_colors = [
        ("m-fc-001", tenant_id, "White", 0),
        ("m-fc-002", tenant_id, "Bronze", 95),
        ("m-fc-003", tenant_id, "Clear Anodized", 140),
        ("m-fc-004", tenant_id, "Black", 155),
        ("m-fc-005", tenant_id, "Pebble Khaki", 110),
        ("m-fc-006", tenant_id, "Custom Color", 295),
    ]
    for frame_color in frame_colors:
        db.execute("INSERT INTO frame_colors (id,tenant_id,name,cost_adder,active) VALUES (?,?,?,?,1)", frame_color)

    glass_options = [
        ("m-g-001", tenant_id, "Impact Laminated",                       0),
        ("m-g-002", tenant_id, "Impact Laminated Bronze Tint",          180),
        ("m-g-003", tenant_id, "Impact Laminated Gray Tint",            180),
        ("m-g-004", tenant_id, "Impact Laminated + Low-E (EnergyVue)", 360),
        ("m-g-005", tenant_id, "Insulating IG + Low-E (Special Order)", 540),
    ]
    for glass_option in glass_options:
        db.execute("INSERT INTO glass_options (id,tenant_id,name,cost_adder,active) VALUES (?,?,?,?,1)", glass_option)

    products = [
        {
            "id": "m-p-001",
            "model": "SH7700A",
            "name": "PGT WinGuard 770 Single Hung",
            "type": "single_hung",
            "base_cost": 745,
            "size_mult": 2.05,
            "min_w": 17.0,
            "max_w": 53.125,
            "min_h": 24.0,
            "max_h": 84.0,
            "frame_depth": "4.56",
            "lead_time": 5,
            "dp_pos": 80,
            "dp_neg": 110,
            "max_sqft": 31.0,
            "max_story": 4,
            "hvhz": 1,
            "noa": "23-0303.02",
        },
        {
            "id": "m-p-002",
            "model": "HR7710A",
            "name": "PGT WinGuard 770 Horizontal Roller",
            "type": "horizontal_roller",
            "base_cost": 810,
            "size_mult": 2.1,
            "min_w": 19.75,
            "max_w": 76.0,
            "min_h": 18.0,
            "max_h": 76.0,
            "frame_depth": "4.56",
            "lead_time": 5,
            "dp_pos": 80,
            "dp_neg": 110,
            "max_sqft": 40.0,
            "max_story": 4,
            "hvhz": 1,
            "noa": "23-0303.02",
        },
        {
            "id": "m-p-003",
            "model": "PW7720A",
            "name": "PGT WinGuard 770 Picture Window",
            "type": "fixed",
            "base_cost": 655,
            "size_mult": 1.8,
            "min_w": 14.5,
            "max_w": 96.0,
            "min_h": 14.5,
            "max_h": 96.0,
            "frame_depth": "4.56",
            "lead_time": 4,
            "dp_pos": 90,
            "dp_neg": 110,
            "max_sqft": 42.0,
            "max_story": 4,
            "hvhz": 1,
            "noa": "23-0303.02",
        },
        {
            "id": "m-p-004",
            "model": "SGD770",
            "name": "PGT WinGuard 770 Sliding Glass Door",
            "type": "sliding_glass_door",
            "base_cost": 2890,
            "size_mult": 2.45,
            "min_w": 71.5,
            "max_w": 240.0,
            "min_h": 78.0,
            "max_h": 120.0,
            "frame_depth": "5.25",
            "lead_time": 6,
            "dp_pos": 70,
            "dp_neg": 80,
            "max_sqft": 120.0,
            "max_story": 4,
            "hvhz": 1,
            "noa": "23-0303.04",
        },
        {
            "id": "m-p-005",
            "model": "SGD780",
            "name": "PGT PremierVue SGD780 Sliding Glass Door",
            "type": "sliding_glass_door",
            "base_cost": 3340,
            "size_mult": 2.62,
            "min_w": 95.5,
            "max_w": 240.0,
            "min_h": 78.0,
            "max_h": 144.0,
            "frame_depth": "5.75",
            "lead_time": 7,
            "dp_pos": 70,
            "dp_neg": 75,
            "max_sqft": 160.0,
            "max_story": 4,
            "hvhz": 1,
            "noa": "22-0727.07",
        },
        {
            "id": "m-p-006",
            "model": "FD750",
            "name": "PGT FD750 French Door Outswing",
            "type": "french_door",
            "base_cost": 4040,
            "size_mult": 2.35,
            "min_w": 36.0,
            "max_w": 72.0,
            "min_h": 80.0,
            "max_h": 96.0,
            "frame_depth": "5.56",
            "lead_time": 6,
            "dp_pos": 75,
            "dp_neg": 85,
            "max_sqft": 48.0,
            "max_story": 4,
            "hvhz": 1,
            "noa": "23-0303.04",
        },
        {
            "id": "m-p-007",
            "model": "FD750-SL",
            "name": "PGT FD750 French Door + Sidelites",
            "type": "french_door",
            "base_cost": 4520,
            "size_mult": 2.5,
            "min_w": 96.0,
            "max_w": 144.0,
            "min_h": 80.0,
            "max_h": 96.0,
            "frame_depth": "5.56",
            "lead_time": 7,
            "dp_pos": 70,
            "dp_neg": 80,
            "max_sqft": 72.0,
            "max_story": 4,
            "hvhz": 1,
            "noa": "23-0303.04",
        },
        {
            "id": "m-p-008",
            "model": "FD101H",
            "name": "PGT FD101H Essential French Door",
            "type": "french_door",
            "base_cost": 4325,
            "size_mult": 2.4,
            "min_w": 36.0,
            "max_w": 72.0,
            "min_h": 80.0,
            "max_h": 96.0,
            "frame_depth": "5.31",
            "lead_time": 6,
            "dp_pos": 70,
            "dp_neg": 75,
            "max_sqft": 48.0,
            "max_story": 4,
            "hvhz": 1,
            "noa": "23-0303.04",
        },
    ]
    for product in products:
        db.execute(
            """INSERT INTO products
               (id,tenant_id,name,model_number,product_line,manufacturer,type,base_cost,size_multiplier_per_sqft,
                min_width,max_width,min_height,max_height,frame_depth,lead_time_weeks,active,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                product["id"],
                tenant_id,
                product["name"],
                product["model"],
                "Prestige",
                "PGT Windows + Doors",
                product["type"],
                product["base_cost"],
                product["size_mult"],
                product["min_w"],
                product["max_w"],
                product["min_h"],
                product["max_h"],
                product["frame_depth"],
                product["lead_time"],
                1,
                created_at,
            ),
        )
        db.execute(
            """INSERT INTO dp_ratings
               (id,product_id,tenant_id,dp_positive,dp_negative,max_width_for_dp,max_height_for_dp,max_sqft_for_dp,
                hvhz_approved,max_story_height,missile_rating,noa_number,active)
               VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,1)""",
            (
                f"m-dp-{product['id']}",
                product["id"],
                tenant_id,
                product["dp_pos"],
                product["dp_neg"],
                product["max_w"],
                product["max_h"],
                product["max_sqft"],
                product["hvhz"],
                product["max_story"],
                "large",
                product["noa"],
            ),
        )
        db.execute(
            """INSERT INTO noa_records
               (id,tenant_id,product_id,noa_number,pressure_rating,max_story_height,hvhz_certified,active)
               VALUES (?,?,?,?,?,?,?,1)""",
            (
                f"m-noa-{product['id']}",
                tenant_id,
                product["id"],
                product["noa"],
                max(product["dp_pos"], product["dp_neg"]),
                product["max_story"],
                product["hvhz"],
            ),
        )

    price_points = [
        ("m-pp-001", "m-p-001", 36, 60, 2380),
        ("m-pp-002", "m-p-001", 42, 60, 2580),
        ("m-pp-003", "m-p-001", 48, 72, 2960),
        ("m-pp-004", "m-p-002", 48, 48, 2190),
        ("m-pp-005", "m-p-002", 60, 48, 2760),
        ("m-pp-006", "m-p-002", 72, 60, 3180),
        ("m-pp-007", "m-p-003", 36, 48, 1490),
        ("m-pp-008", "m-p-003", 48, 60, 1890),
        ("m-pp-009", "m-p-003", 72, 72, 2740),
        ("m-pp-010", "m-p-004", 72, 80, 6190),
        ("m-pp-011", "m-p-004", 96, 80, 7650),
        ("m-pp-012", "m-p-004", 144, 96, 11240),
        ("m-pp-013", "m-p-005", 96, 80, 7340),
        ("m-pp-014", "m-p-005", 120, 96, 9180),
        ("m-pp-015", "m-p-005", 144, 96, 13480),
        ("m-pp-016", "m-p-006", 72, 80, 9640),
        ("m-pp-017", "m-p-006", 72, 96, 10550),
        ("m-pp-018", "m-p-007", 120, 96, 12800),
        ("m-pp-019", "m-p-008", 72, 80, 9980),
        ("m-pp-020", "m-p-008", 72, 96, 11240),
    ]
    for price_point_id, product_id, width, height, price in price_points:
        db.execute(
            """INSERT INTO product_price_points
               (id,tenant_id,product_id,width,height,price,active,created_at)
               VALUES (?,?,?,?,?,?,1,?)""",
            (price_point_id, tenant_id, product_id, width, height, price, created_at),
        )

    lead_time_overrides = [
        ("m-lt-001", tenant_id, "m-fc-004", None, 6),
        ("m-lt-002", tenant_id, "m-fc-006", None, 8),
        ("m-lt-003", tenant_id, "m-fc-003", "Prestige", 7),
    ]
    for lead_time in lead_time_overrides:
        db.execute(
            "INSERT INTO lead_time_overrides (id,tenant_id,frame_color_id,product_line,lead_time_weeks,active) VALUES (?,?,?,?,?,1)",
            lead_time,
        )

    rep_ids = [
        "u-d2-rep-001",
        "u-d2-rep-002",
        "u-d2-rep-003",
        "u-d2-rep-004",
        "u-d2-rep-005",
        "u-d2-rep-006",
    ]
    rep_name_map = {user_id: name for user_id, name, _, _, _ in user_specs if user_id.startswith("u-d2-rep")}
    complexity_map = {
        row["name"]: row["id"]
        for row in db.execute("SELECT id,name FROM complexity_items WHERE tenant_id=?", (tenant_id,)).fetchall()
    }

    def _complexity_payload(*names):
        ids = [complexity_map[name] for name in names if name in complexity_map]
        return json.dumps(ids)

    quote_customers = [
        ("Alicia Morgan", "(954) 555-1101", "alicia.morgan@email.com", "2610 NE 14th St, Pompano Beach, FL 33062", "33062"),
        ("Brandon Lee", "(954) 555-1102", "brandon.lee@email.com", "4010 N Ocean Blvd, Lauderdale-by-the-Sea, FL 33308", "33308"),
        ("Carla Nunez", "(954) 555-1103", "carla.nunez@email.com", "1271 SE 14th Ct, Deerfield Beach, FL 33441", "33441"),
        ("Derrick Wallace", "(954) 555-1104", "derrick.wallace@email.com", "2311 NE 27th Dr, Wilton Manors, FL 33306", "33306"),
        ("Erica Gomez", "(954) 555-1105", "erica.gomez@email.com", "7020 NW 44th Ter, Coconut Creek, FL 33073", "33073"),
        ("Felix Alvarez", "(954) 555-1106", "felix.alvarez@email.com", "1850 E Commercial Blvd, Oakland Park, FL 33334", "33334"),
        ("Grace Patel", "(954) 555-1107", "grace.patel@email.com", "1116 Coral Ridge Dr, Coral Springs, FL 33071", "33071"),
        ("Hector Ruiz", "(954) 555-1108", "hector.ruiz@email.com", "620 SW 12th Ave, Fort Lauderdale, FL 33312", "33312"),
        ("Isabel Turner", "(954) 555-1109", "isabel.turner@email.com", "1601 NW 82nd Ave, Plantation, FL 33322", "33322"),
        ("James O'Neil", "(954) 555-1110", "james.oneil@email.com", "9200 Bay Point Cir, Parkland, FL 33076", "33076"),
        ("Kelly Morris", "(954) 555-1111", "kelly.morris@email.com", "2114 E River Dr, Margate, FL 33063", "33063"),
        ("Luis Santana", "(954) 555-1112", "luis.santana@email.com", "1500 SE 11th Ct, Fort Lauderdale, FL 33316", "33316"),
        ("Monica Reed", "(954) 555-1113", "monica.reed@email.com", "7700 NW 44th St, Sunrise, FL 33351", "33351"),
        ("Nathan Brooks", "(954) 555-1114", "nathan.brooks@email.com", "2900 Harbor Dr, Hollywood, FL 33019", "33019"),
        ("Olivia Chavez", "(954) 555-1115", "olivia.chavez@email.com", "1280 SE 7th St, Dania Beach, FL 33004", "33004"),
        ("Peter Lawson", "(954) 555-1116", "peter.lawson@email.com", "3651 N 36th Ave, Lauderdale Lakes, FL 33309", "33309"),
        ("Quinn Foster", "(954) 555-1117", "quinn.foster@email.com", "940 Intracoastal Dr, Fort Lauderdale, FL 33304", "33304"),
        ("Renee Flores", "(954) 555-1118", "renee.flores@email.com", "5151 NE 29th Ave, Lighthouse Point, FL 33064", "33064"),
    ]
    quote_statuses = [
        "draft", "pending_approval", "approved", "completed", "draft", "completed",
        "pending_approval", "approved", "draft", "completed", "approved", "draft",
        "pending_approval", "completed", "draft", "approved", "pending_approval", "completed",
    ]
    quote_patterns = [
        [
            {"type": "single_hung", "w": 36, "h": 60, "floor": 1, "pid": "m-p-001", "price": 2380, "cost": 1490, "complexity": []},
            {"type": "single_hung", "w": 36, "h": 60, "floor": 1, "pid": "m-p-001", "price": 2380, "cost": 1490, "complexity": []},
            {"type": "fixed", "w": 48, "h": 60, "floor": 1, "pid": "m-p-003", "price": 1890, "cost": 1195, "complexity": []},
        ],
        [
            {"type": "horizontal_roller", "w": 72, "h": 60, "floor": 2, "pid": "m-p-002", "price": 3180, "cost": 2010, "complexity": ["Frame removal & disposal"]},
            {"type": "fixed", "w": 48, "h": 72, "floor": 2, "pid": "m-p-003", "price": 2140, "cost": 1350, "complexity": []},
        ],
        [
            {"type": "sliding_glass_door", "w": 96, "h": 80, "floor": 1, "pid": "m-p-004", "price": 7650, "cost": 4920, "complexity": ["Frame removal & disposal"]},
            {"type": "single_hung", "w": 36, "h": 60, "floor": 2, "pid": "m-p-001", "price": 2410, "cost": 1510, "complexity": []},
            {"type": "single_hung", "w": 36, "h": 60, "floor": 2, "pid": "m-p-001", "price": 2410, "cost": 1510, "complexity": []},
        ],
        [
            {"type": "french_door", "w": 72, "h": 96, "floor": 1, "pid": "m-p-006", "price": 10550, "cost": 6750, "complexity": ["Mull post installation"]},
            {"type": "fixed", "w": 48, "h": 60, "floor": 1, "pid": "m-p-003", "price": 1890, "cost": 1195, "complexity": []},
        ],
        [
            {"type": "french_door", "w": 120, "h": 96, "floor": 1, "pid": "m-p-007", "price": 12800, "cost": 8240, "complexity": ["Structural header modification"]},
        ],
        [
            {"type": "sliding_glass_door", "w": 144, "h": 96, "floor": 3, "pid": "m-p-005", "price": 13480, "cost": 8725, "complexity": ["High-access equipment needed"]},
            {"type": "fixed", "w": 72, "h": 72, "floor": 3, "pid": "m-p-003", "price": 2740, "cost": 1760, "complexity": []},
        ],
        [
            {"type": "single_hung", "w": 42, "h": 60, "floor": 1, "pid": "m-p-001", "price": 2580, "cost": 1610, "complexity": []},
            {"type": "horizontal_roller", "w": 60, "h": 48, "floor": 1, "pid": "m-p-002", "price": 2760, "cost": 1740, "complexity": []},
            {"type": "fixed", "w": 48, "h": 48, "floor": 1, "pid": "m-p-003", "price": 1650, "cost": 1040, "complexity": []},
        ],
        [
            {"type": "french_door", "w": 72, "h": 96, "floor": 2, "pid": "m-p-008", "price": 11240, "cost": 7240, "complexity": ["Permit expedite fee"]},
            {"type": "single_hung", "w": 36, "h": 60, "floor": 2, "pid": "m-p-001", "price": 2410, "cost": 1510, "complexity": []},
        ],
    ]
    status_factor = {
        "draft": 1.00,
        "pending_approval": 0.90,
        "approved": 0.97,
        "completed": 1.04,
    }
    frame_cycle = ["m-fc-001", "m-fc-002", "m-fc-004", "m-fc-005"]
    glass_cycle = ["m-g-001", "m-g-004", "m-g-002", "m-g-005"]
    product_map = {product["id"]: product for product in products}

    for index, customer in enumerate(quote_customers, start=1):
        customer_name, customer_phone, customer_email, job_address, job_zip = customer
        status = quote_statuses[index - 1]
        rep_id = rep_ids[(index - 1) % len(rep_ids)]
        rep_name = rep_name_map.get(rep_id, "Rep")
        pattern = quote_patterns[(index - 1) % len(quote_patterns)]
        factor = status_factor.get(status, 1.0)
        created_ts = (now - timedelta(days=index // 2 + 1, hours=(index % 4) * 3)).isoformat()
        updated_ts = (now - timedelta(days=max(0, index // 2), hours=(index % 3))).isoformat()
        qid = f"m-q-{index:03d}"

        openings_payload = []
        total_price = 0
        total_cost = 0
        for opening_index, opening in enumerate(pattern, start=1):
            sell_price = round(opening["price"] * factor, 2)
            opening_cost = round(opening["cost"], 2)
            total_price += sell_price
            total_cost += opening_cost
            product_meta = product_map[opening["pid"]]
            openings_payload.append(
                (
                    f"m-o-{index:03d}-{opening_index:02d}",
                    qid,
                    tenant_id,
                    opening_index,
                    opening["type"],
                    opening["w"],
                    opening["h"],
                    opening["floor"],
                    opening["pid"],
                    glass_cycle[(index + opening_index - 2) % len(glass_cycle)],
                    frame_cycle[(index + opening_index - 2) % len(frame_cycle)],
                    _complexity_payload(*opening["complexity"]),
                    sell_price,
                    opening_cost,
                    round(((sell_price - opening_cost) / sell_price * 100), 1) if sell_price > 0 else 0,
                    round(sell_price - opening_cost, 2),
                    product_meta["dp_neg"],
                    product_meta["noa"],
                )
            )

        margin_dollars = round(total_price - total_cost, 2)
        margin_pct = round((margin_dollars / total_price) * 100, 1) if total_price > 0 else 0
        notes = {
            "draft": "Initial homeowner consultation completed. Waiting on final glass and color selections.",
            "pending_approval": "Rep requested sharper pricing to stay competitive with another PGT proposal.",
            "approved": "Approved for HOA package and production release once deposit is posted.",
            "completed": "Proposal closed and archived as a completed sale for pipeline reporting.",
        }.get(status)

        db.execute(
            """INSERT INTO quotes
               (id,tenant_id,rep_id,customer_name,customer_phone,customer_email,job_address,job_zip,status,
                total_price,total_cost,margin_pct,margin_dollars,notes,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                qid,
                tenant_id,
                rep_id,
                customer_name,
                customer_phone,
                customer_email,
                job_address,
                job_zip,
                status,
                round(total_price, 2),
                round(total_cost, 2),
                margin_pct,
                margin_dollars,
                notes,
                created_ts,
                updated_ts,
            ),
        )

        for opening in openings_payload:
            db.execute(
                """INSERT INTO openings
                   (id,quote_id,tenant_id,opening_number,opening_mode,opening_type,total_width,total_height,
                    floor_level,wall_type,product_id,glass_option_id,frame_color_id,complexity_ids,
                    sell_price,total_cost,margin_pct,margin_dollars,dp_status,dp_rating_used,noa_number)
                   VALUES (?,?,?,?,'single',?,?,?,?,'cbs',?,?,?,?,?,?,?,?,'passed',?,?)""",
                opening,
            )

        audit(
            db,
            tenant_id,
            "quote_created",
            "quote",
            qid,
            rep_id,
            rep_name,
            {"customer": customer_name, "status": status, "source": "second_demo_tenant_seed"},
            rep_id=rep_id,
        )
        if status == "pending_approval":
            request_id = f"m-ar-{index:03d}"
            db.execute(
                """INSERT INTO approval_requests
                   (id,quote_id,tenant_id,rep_id,current_margin,requested_margin,rep_note,status,created_at)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (
                    request_id,
                    qid,
                    tenant_id,
                    rep_id,
                    margin_pct,
                    round(margin_pct + 1.5, 1),
                    "Customer is comparing PGT against a lower-priced vinyl option and wants us closer.",
                    "pending",
                    updated_ts,
                ),
            )
            audit(
                db,
                tenant_id,
                "approval_requested",
                "quote",
                qid,
                rep_id,
                rep_name,
                {"margin": margin_pct, "requested_margin": round(margin_pct + 1.5, 1)},
                rep_id=rep_id,
            )
        elif status == "completed":
            audit(
                db,
                tenant_id,
                "quote_completed",
                "quote",
                qid,
                rep_id,
                rep_name,
                {"total": round(total_price, 2), "margin": margin_pct},
                rep_id=rep_id,
            )

    db.commit()


# ---------------------------------------------------------------------------
# BUSINESS LOGIC HELPERS
# ---------------------------------------------------------------------------

def _get_global_setting(db, tenant_id, key, default=None):
    row = db.execute(
        "SELECT setting_value FROM global_settings WHERE tenant_id=? AND setting_key=?",
        (tenant_id, key)
    ).fetchone()
    return row["setting_value"] if row else default


def _hvhz_only_mode_enabled(db, tenant_id):
    raw = _get_global_setting(db, tenant_id, "hvhz_only_mode", "1")
    return _coerce_bool_flag(raw) == 1


def _normalize_required_zone(zone_value):
    zone = str(zone_value or "").strip().upper()
    if zone in ("HVHZ", "COASTAL", "INLAND"):
        return zone
    return "HVHZ"


def _resolve_required_zone(db, tenant_id, requested_zone=None, fallback_zone=None):
    if _hvhz_only_mode_enabled(db, tenant_id):
        return "HVHZ"
    zone_candidate = requested_zone or fallback_zone or _get_global_setting(db, tenant_id, "default_zone", "HVHZ")
    return _normalize_required_zone(zone_candidate)


def _calculate_consumables(db, tenant_id, wall_type, opening_count=1):
    wall_type = _normalize_wall_type(wall_type)
    consumables = db.execute(
        "SELECT * FROM consumables WHERE tenant_id=? AND active=1",
        (tenant_id,)
    ).fetchall()

    total = 0.0
    breakdown = []
    for c in consumables:
        wf = c["wall_type_filter"]
        if wf and wf != wall_type:
            continue
        if c["min_openings"] > opening_count:
            continue

        unit = c["unit"]
        if unit == "per_opening":
            cost = c["unit_cost"]
        elif unit == "per_job":
            cost = c["unit_cost"] / max(opening_count, 1)
        else:
            cost = c["unit_cost"]

        total += cost
        breakdown.append({"name": c["name"], "cost": cost, "unit": unit})

    return round(total, 2), breakdown


def _safe_float(value, default=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _fix_mojibake_text(value):
    text = str(value or "")
    # Heal common UTF-8/cp1252 mojibake from legacy deployments.
    if not any(token in text for token in ("Ã", "Â", "â")):
        return text
    for _ in range(3):
        try:
            repaired = text.encode("cp1252").decode("utf-8")
        except Exception:
            break
        if repaired == text:
            break
        text = repaired
        if not any(token in text for token in ("Ã", "Â", "â")):
            break
    return text


def _sanitize_text_field(value, max_length, default=""):
    text = _fix_mojibake_text(value if value is not None else default).replace("\x00", "").strip()
    if not text:
        return ""
    if len(text) <= max_length:
        return text
    suffix = "...[truncated]"
    if max_length <= len(suffix):
        return text[:max_length]
    return text[: max_length - len(suffix)].rstrip() + suffix


def _guess_attachment_mime(filename, fallback="application/octet-stream"):
    guessed, _ = mimetypes.guess_type(filename or "")
    return guessed or fallback


def _attachment_kind_for_upload(filename, mime_type=""):
    ext = os.path.splitext(filename or "")[1].lower()
    mime = (mime_type or "").strip().lower()

    if mime.startswith(CHAT_IMAGE_MIME_PREFIXES) or ext in CHAT_IMAGE_EXTENSIONS:
        return "image"
    if mime.startswith(CHAT_VIDEO_MIME_PREFIXES) or ext in CHAT_VIDEO_EXTENSIONS:
        return "video"
    return None


def _chat_media_storage():
    mode = CHAT_MEDIA_STORAGE or ("gcs" if CHAT_MEDIA_BUCKET else "local")
    return mode.lower()


def _chat_media_uses_gcs():
    return _chat_media_storage() == "gcs"


def _get_chat_storage_client():
    global _chat_storage_client
    if _gcs_storage is None:
        raise RuntimeError("google-cloud-storage is not installed")
    if _chat_storage_client is None:
        _chat_storage_client = _gcs_storage.Client()
    return _chat_storage_client


def _build_chat_attachment_object_name(tenant_id, quote_id, message_id, original_name, ext):
    now = datetime.utcnow()
    random_name = f"{uuid.uuid4().hex}{ext}"
    return "/".join([
        CHAT_MEDIA_PREFIX,
        tenant_id,
        "quotes",
        quote_id,
        "messages",
        message_id,
        now.strftime("%Y"),
        now.strftime("%m"),
        random_name,
    ])


def _prepare_job_message_attachment(file_storage):
    if not file_storage:
        return None

    original_name = secure_filename(file_storage.filename or "")
    if not original_name:
        raise ValueError("Attachment filename is required")

    detected_mime = (file_storage.mimetype or "").strip().lower()
    attachment_kind = _attachment_kind_for_upload(original_name, detected_mime)
    if not attachment_kind:
        raise ValueError("Only image and video attachments are supported")

    ext = os.path.splitext(original_name)[1].lower()
    if not ext:
        ext = mimetypes.guess_extension(detected_mime or "") or (".jpg" if attachment_kind == "image" else ".mp4")

    stream = getattr(file_storage, "stream", None) or file_storage
    try:
        current_pos = stream.tell()
    except Exception:
        current_pos = 0
    try:
        stream.seek(0, os.SEEK_END)
        size_bytes = stream.tell()
        stream.seek(0)
    except Exception:
        blob = file_storage.read()
        size_bytes = len(blob or b"")
        stream = file_storage
        try:
            stream.seek(0)
        except Exception:
            pass
    finally:
        try:
            stream.seek(current_pos if current_pos else 0)
            stream.seek(0)
        except Exception:
            pass

    if size_bytes <= 0:
        raise ValueError("Attachment file is empty")
    if size_bytes > MAX_CHAT_ATTACHMENT_BYTES:
        max_mb = max(1, round(MAX_CHAT_ATTACHMENT_BYTES / (1024 * 1024)))
        raise ValueError(f"Attachment exceeds {max_mb} MB limit")

    return {
        "stream": stream,
        "name": original_name,
        "mime": detected_mime or _guess_attachment_mime(original_name),
        "kind": attachment_kind,
        "ext": ext,
        "size": size_bytes,
    }


def _save_job_message_attachment_local(file_storage, tenant_id, quote_id, message_id, meta):
    rel_dir = os.path.join("uploads", "job-messages", tenant_id, quote_id, message_id)
    abs_dir = os.path.join(LOCAL_CHAT_MEDIA_ROOT, tenant_id, quote_id, message_id)
    os.makedirs(abs_dir, exist_ok=True)

    stored_name = f"{datetime.utcnow().strftime('%Y%m%d%H%M%S')}-{uuid.uuid4().hex[:10]}{meta['ext']}"
    rel_path = os.path.join(rel_dir, stored_name).replace("\\", "/")
    abs_path = os.path.join(abs_dir, stored_name)

    meta["stream"].seek(0)
    file_storage.save(abs_path)

    return {
        "storage": "local",
        "bucket": None,
        "object_name": None,
        "generation": None,
        "legacy_url": f"/{rel_path}",
        "kind": meta["kind"],
        "name": meta["name"],
        "mime": meta["mime"],
        "size": meta["size"],
    }


def _save_job_message_attachment_gcs(file_storage, tenant_id, quote_id, message_id, meta):
    if not CHAT_MEDIA_BUCKET:
        raise ValueError("CHAT_MEDIA_BUCKET is required for GCS chat media storage")

    object_name = _build_chat_attachment_object_name(tenant_id, quote_id, message_id, meta["name"], meta["ext"])
    bucket = _get_chat_storage_client().bucket(CHAT_MEDIA_BUCKET)
    blob = bucket.blob(object_name)
    blob.content_type = meta["mime"]
    blob.cache_control = "private, max-age=300"
    blob.metadata = {
        "tenant_id": tenant_id,
        "quote_id": quote_id,
        "message_id": message_id,
        "kind": meta["kind"],
        "original_name": meta["name"],
    }

    meta["stream"].seek(0)
    blob.upload_from_file(meta["stream"], rewind=True, content_type=meta["mime"], if_generation_match=0)
    blob.reload()

    return {
        "storage": "gcs",
        "bucket": CHAT_MEDIA_BUCKET,
        "object_name": object_name,
        "generation": str(blob.generation or ""),
        "legacy_url": None,
        "kind": meta["kind"],
        "name": meta["name"],
        "mime": meta["mime"],
        "size": meta["size"],
    }


def _save_job_message_attachment(file_storage, tenant_id, quote_id, message_id, prepared_meta=None):
    if not file_storage:
        return None

    meta = prepared_meta or _prepare_job_message_attachment(file_storage)
    if _chat_media_uses_gcs():
        return _save_job_message_attachment_gcs(file_storage, tenant_id, quote_id, message_id, meta)
    return _save_job_message_attachment_local(file_storage, tenant_id, quote_id, message_id, meta)


def _job_message_has_attachment(row):
    return bool(
        row.get("attachment_object_name")
        or row.get("attachment_url")
        or row.get("attachment_bucket")
    )


def _job_message_media_url(message_id, row):
    if not _job_message_has_attachment(row):
        return None
    return f"/api/chat-media/{message_id}"


def _job_message_public_payload(row):
    item = dict(row)
    item["content"] = _sanitize_text_field(item.get("content"), MAX_JOB_MESSAGE_LENGTH)
    item["attachment_name"] = _sanitize_text_field(item.get("attachment_name"), 180)
    item["delivery_channel"] = (item.get("delivery_channel") or "in_app").lower()
    item["external_direction"] = _sanitize_text_field(item.get("external_direction"), 32)
    item["external_status"] = _sanitize_text_field(item.get("external_status"), 64)
    item["external_from"] = _sanitize_text_field(item.get("external_from"), 32)
    item["external_to"] = _sanitize_text_field(item.get("external_to"), 32)
    item["external_error"] = _sanitize_text_field(item.get("external_error"), 240)
    item["is_customer_message"] = item["delivery_channel"] == "sms" and item.get("external_direction") == "inbound"
    if _job_message_has_attachment(item):
        item["attachment_storage"] = (
            item.get("attachment_storage") or ("gcs" if item.get("attachment_object_name") else "local")
        ).lower()
    else:
        item["attachment_storage"] = None
    item["attachment_url"] = _job_message_media_url(item["id"], item)
    if item.get("attachment_mime") and not item.get("attachment_kind"):
        item["attachment_kind"] = "image" if item["attachment_mime"].startswith("image/") else "video" if item["attachment_mime"].startswith("video/") else None
    return item


def _chat_message_preview(value, limit=180):
    preview = _sanitize_text_field(value, limit)
    if preview:
        return preview
    return ""


def _require_text(value, label):
    text = (value or "").strip()
    if not text:
        raise ValueError(f"{label} is required")
    return text


def _require_positive_float(value, label):
    number = _safe_float(value, None)
    if number is None or number <= 0:
        raise ValueError(f"{label} must be greater than 0")
    return float(number)


def _now_iso():
    return datetime.now().isoformat()


_VALID_WALL_TYPES = {"cbs", "frame", "concrete"}


def _normalize_wall_type(value, fallback="cbs"):
    raw = str(value or "").strip().lower()
    if raw == "masonry":
        return "concrete"
    if raw in _VALID_WALL_TYPES:
        return raw
    fallback_raw = str(fallback or "cbs").strip().lower()
    return fallback_raw if fallback_raw in _VALID_WALL_TYPES else "cbs"


def _twilio_enabled():
    return bool(TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN and (TWILIO_MESSAGING_SERVICE_SID or TWILIO_MESSAGING_FROM))


def _get_twilio_client():
    global _twilio_client
    if _TwilioClient is None:
        raise RuntimeError("twilio is not installed")
    if _twilio_client is None:
        _twilio_client = _TwilioClient(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    return _twilio_client


def _normalize_phone_number(value):
    raw = str(value or "").strip()
    if not raw:
        return ""
    if raw.startswith("+"):
        digits = "+" + re.sub(r"\D", "", raw)
        return digits if 8 <= len(digits) <= 16 else ""
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 10:
        return "+1" + digits
    if len(digits) == 11 and digits.startswith("1"):
        return "+" + digits
    return ""


def _current_public_base_url():
    if PUBLIC_BASE_URL:
        return PUBLIC_BASE_URL
    try:
        return request.url_root.rstrip("/")
    except RuntimeError:
        return ""


def _absolute_public_url(path):
    clean_path = "/" + str(path or "").lstrip("/")
    base_url = _current_public_base_url().rstrip("/")
    if not base_url:
        return clean_path
    return f"{base_url}{clean_path}"


def _json_safe_data(value):
    if isinstance(value, dict):
        return {key: _json_safe_data(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe_data(item) for item in value]
    if isinstance(value, Decimal):
        return float(value)
    if hasattr(value, "isoformat") and callable(value.isoformat):
        try:
            return value.isoformat()
        except Exception:
            return str(value)
    return value


def _load_json_text(raw, default=None):
    if raw in (None, ""):
        return default
    try:
        return json.loads(raw)
    except Exception:
        return default


def _row_get(row, key, default=None):
    if row is None:
        return default
    if isinstance(row, dict):
        return row.get(key, default)
    try:
        return row[key]
    except Exception:
        return default


def _parse_datetime_value(value):
    if value in (None, ""):
        return None
    if isinstance(value, datetime):
        if value.tzinfo is not None:
            return value.astimezone().replace(tzinfo=None)
        return value

    text = str(value).strip()
    if not text:
        return None
    if text.endswith("Z"):
        text = text[:-1] + "+00:00"

    try:
        parsed = datetime.fromisoformat(text)
        if parsed.tzinfo is not None:
            return parsed.astimezone().replace(tzinfo=None)
        return parsed
    except Exception:
        pass

    for fmt in ("%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def _format_display_date(value, include_time=False):
    parsed = _parse_datetime_value(value)
    if not parsed:
        return "-"

    date_part = parsed.strftime("%B %d, %Y").replace(" 0", " ")
    if include_time:
        time_part = parsed.strftime("%I:%M %p").lstrip("0")
        if time_part:
            return f"{date_part} {time_part}"
    return date_part


def _format_dimension(value):
    if value in (None, ""):
        return "-"
    number = _safe_float(value, None)
    if number is None:
        return str(value)
    if abs(number - round(number)) < 0.01:
        return str(int(round(number)))
    return f"{number:.2f}".rstrip("0").rstrip(".")


def _format_currency(value):
    amount = _safe_float(value, 0.0)
    return f"${amount:,.2f}"


def _proposal_type_label(value):
    mapping = {
        "single_hung": "Single Hung",
        "double_hung": "Double Hung",
        "casement": "Casement",
        "horizontal_roller": "Horizontal Roller",
        "fixed": "Picture Window",
        "picture_window": "Picture Window",
        "sliding_glass_door": "Sliding Glass Door",
        "entry_door": "Entry Door",
        "french_door": "French Door",
        "bifold_door": "Bifold Door",
        "assembly": "Assembly",
    }
    key = str(value or "").strip().lower()
    if not key:
        return "Opening"
    if key in mapping:
        return mapping[key]
    return " ".join(part.capitalize() for part in key.split("_"))


def _proposal_floor_label(value):
    floor_number = _coerce_int_or_none(value)
    if not floor_number:
        return "Floor not specified"
    suffix = "th"
    if floor_number % 100 not in (11, 12, 13):
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(floor_number % 10, "th")
    return f"{floor_number}{suffix} Floor"


def _simple_html_page(title, message, status=200):
    safe_title = html.escape(title or "WindowCalc")
    safe_message = html.escape(message or "")
    body = f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{safe_title}</title>
  <style>
    body {{
      margin: 0;
      font-family: Arial, Helvetica, sans-serif;
      background: #f5f8fb;
      color: #12202b;
      display: flex;
      min-height: 100vh;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }}
    .card {{
      max-width: 520px;
      width: 100%;
      background: #fff;
      border: 1px solid #d7e0e7;
      border-radius: 18px;
      padding: 28px;
      box-shadow: 0 16px 42px rgba(18, 32, 43, 0.08);
    }}
    h1 {{
      margin: 0 0 10px;
      font-size: 24px;
    }}
    p {{
      margin: 0;
      color: #61717d;
      line-height: 1.5;
    }}
  </style>
</head>
<body>
  <div class="card">
    <h1>{safe_title}</h1>
    <p>{safe_message}</p>
  </div>
</body>
</html>"""
    return Response(body, status=status, mimetype="text/html")


def _proposal_share_is_expired(share_row):
    expires_at_value = _row_get(share_row, "expires_at")
    expires_at = _parse_datetime_value(expires_at_value) if expires_at_value else None
    if not expires_at:
        return False
    return expires_at <= datetime.utcnow()


def _normalize_share_expiry(value):
    if value in (None, ""):
        return None
    parsed = _parse_datetime_value(value)
    if not parsed:
        raise ValueError("expires_at must be a valid ISO timestamp")
    if parsed <= datetime.utcnow():
        raise ValueError("expires_at must be in the future")
    return parsed.isoformat()


def _load_quote_access_row(db, tenant_id, qid):
    query = """SELECT q.*, u.name AS rep_name, u.tier AS rep_tier, u.role AS rep_role
               FROM quotes q
               LEFT JOIN users u ON u.id=q.rep_id AND u.tenant_id=q.tenant_id
               WHERE q.id=?"""
    params = [qid]
    if tenant_id:
        query += " AND q.tenant_id=?"
        params.append(tenant_id)
    return db.execute(query, params).fetchone()


def _auth_can_access_quote(auth_ctx, quote_row):
    if not auth_ctx or not quote_row:
        return False
    if auth_ctx.get("tenant_id") != quote_row["tenant_id"]:
        return False
    if _has_permission_ctx(auth_ctx, "can_view_all_quotes"):
        return True
    return quote_row["rep_id"] == auth_ctx["user"]["id"]


def _load_snapshot_row(db, tenant_id, qid, sid):
    return db.execute(
        """SELECT * FROM proposal_snapshots
           WHERE id=? AND quote_id=? AND tenant_id=?""",
        (sid, qid, tenant_id),
    ).fetchone()


def _load_active_share_row(db, token, qid=None, sid=None):
    token = (token or "").strip()
    if not token:
        return None

    row = db.execute(
        """SELECT ps.*, u.name AS created_by_name
           FROM proposal_shares ps
           LEFT JOIN users u ON u.id=ps.created_by AND u.tenant_id=ps.tenant_id
           WHERE ps.token=?""",
        (token,),
    ).fetchone()
    if not row:
        return None
    if qid and row["quote_id"] != qid:
        return None
    if sid and row["snapshot_id"] != sid:
        return None
    if _proposal_share_is_expired(row):
        return None
    return row


def _latest_active_share_for_snapshot(db, tenant_id, qid, sid):
    rows = db.execute(
        """SELECT ps.*, u.name AS created_by_name
           FROM proposal_shares ps
           LEFT JOIN users u ON u.id=ps.created_by AND u.tenant_id=ps.tenant_id
           WHERE ps.snapshot_id=? AND ps.quote_id=? AND ps.tenant_id=?
           ORDER BY ps.created_at DESC, ps.id DESC""",
        (sid, qid, tenant_id),
    ).fetchall()
    for row in rows:
        if not _proposal_share_is_expired(row):
            return row
    return None


def _build_proposal_snapshot_payload(db, tenant_id, qid, generated_at=None):
    quote_row = _load_quote_access_row(db, tenant_id, qid)
    tenant_row = _get_tenant_row(db, tenant_id)
    if not quote_row or not tenant_row:
        return None

    opening_rows = db.execute(
        """SELECT o.*,
                  p.name AS product_name,
                  p.model_number AS product_model_number,
                  p.manufacturer AS product_manufacturer,
                  g.name AS glass_name,
                  fc.name AS frame_name
           FROM openings o
           LEFT JOIN products p ON p.id=o.product_id AND p.tenant_id=o.tenant_id
           LEFT JOIN glass_options g ON g.id=o.glass_option_id AND g.tenant_id=o.tenant_id
           LEFT JOIN frame_colors fc ON fc.id=o.frame_color_id AND fc.tenant_id=o.tenant_id
           WHERE o.quote_id=? AND o.tenant_id=?
           ORDER BY o.opening_number, o.id""",
        (qid, tenant_id),
    ).fetchall()

    opening_items = [_json_safe_data(dict(row)) for row in opening_rows]
    opening_ids = [
        item["id"]
        for item in opening_items
        if (item.get("opening_mode") or "single") == "multipart"
    ]

    panel_map = {}
    if opening_ids:
        placeholders = ",".join(["?"] * len(opening_ids))
        panel_rows = db.execute(
            f"""SELECT ap.*,
                       p.name AS product_name,
                       p.model_number AS product_model_number,
                       p.manufacturer AS product_manufacturer,
                       g.name AS glass_name,
                       fc.name AS frame_name
                FROM assembly_panels ap
                LEFT JOIN products p ON p.id=ap.product_id AND p.tenant_id=ap.tenant_id
                LEFT JOIN glass_options g ON g.id=ap.glass_option_id AND g.tenant_id=ap.tenant_id
                LEFT JOIN frame_colors fc ON fc.id=ap.frame_color_id AND fc.tenant_id=ap.tenant_id
                WHERE ap.tenant_id=? AND ap.opening_id IN ({placeholders})
                ORDER BY ap.opening_id, ap.panel_index, ap.id""",
            [tenant_id, *opening_ids],
        ).fetchall()
        for row in panel_rows:
            item = _json_safe_data(dict(row))
            item["width"] = item.get("width")
            item["height"] = item.get("height")
            item["dimensions"] = f'{_format_dimension(item.get("width"))}" x {_format_dimension(item.get("height"))}"'
            panel_map.setdefault(item["opening_id"], []).append(item)

    for item in opening_items:
        item["width"] = item.get("width") or item.get("total_width")
        item["height"] = item.get("height") or item.get("total_height")
        item["dimensions"] = f'{_format_dimension(item.get("width"))}" x {_format_dimension(item.get("height"))}"'
        item["type_label"] = _proposal_type_label(item.get("opening_type"))
        item["floor_label"] = _proposal_floor_label(item.get("floor_level"))
        item["complexity_ids"] = _load_json_text(item.get("complexity_ids"), []) or []
        item["panels"] = panel_map.get(item["id"], [])
        if not item.get("product_name"):
            if item["panels"]:
                item["product_name"] = f"Custom {len(item['panels'])}-Panel Assembly"
            else:
                item["product_name"] = item["type_label"]

    return {
        "quote": _json_safe_data(dict(quote_row)),
        "openings": opening_items,
        "tenant": _json_safe_data(dict(tenant_row)),
        "generated_at": generated_at or _now_iso(),
    }


def _build_proposal_render_context(snapshot_row, share_row=None, share_token=None):
    snapshot_payload = _load_json_text(snapshot_row["quote_snapshot"], {}) or {}
    quote = snapshot_payload.get("quote") or {}
    tenant = snapshot_payload.get("tenant") or {}
    openings_raw = snapshot_payload.get("openings") or []
    generated_at = snapshot_payload.get("generated_at") or _row_get(snapshot_row, "created_at") or _now_iso()
    valid_until = (_parse_datetime_value(generated_at) or datetime.now()) + timedelta(days=30)

    opening_items = []
    total_price = _safe_float(quote.get("total_price"), 0.0)
    if total_price <= 0:
        total_price = sum(_safe_float(opening.get("sell_price"), 0.0) for opening in openings_raw if isinstance(opening, dict))

    for index, opening in enumerate(openings_raw, start=1):
        if not isinstance(opening, dict):
            continue
        sell_price = _safe_float(opening.get("sell_price"), 0.0)
        width = opening.get("width") or opening.get("total_width")
        height = opening.get("height") or opening.get("total_height")
        type_label = opening.get("type_label") or _proposal_type_label(opening.get("opening_type"))
        product_name = (opening.get("product_name") or "").strip()
        if not product_name:
            panels = opening.get("panels") or []
            product_name = f"Custom {len(panels)}-Panel Assembly" if panels else type_label
        opening_items.append(
            {
                "number": opening.get("opening_number") or index,
                "type_label": type_label,
                "dimensions": opening.get("dimensions") or f'{_format_dimension(width)}" x {_format_dimension(height)}"',
                "product_name": product_name,
                "sell_price": sell_price,
                "sell_price_display": _format_currency(sell_price),
                "floor_label": opening.get("floor_label") or _proposal_floor_label(opening.get("floor_level")),
                "noa_number": opening.get("noa_number"),
            }
        )

    active_share = share_row
    if active_share and _proposal_share_is_expired(active_share):
        active_share = None
    token = share_token or (active_share["token"] if active_share else None)

    existing_response = None
    if active_share and _row_get(active_share, "customer_response"):
        response_payload = _load_json_text(active_share["customer_response"], {}) or {}
        action = response_payload.get("action")
        if action in ("accept", "request_changes"):
            existing_response = {
                "action": action,
                "action_label": "Accepted" if action == "accept" else "Requested Changes",
                "note": response_payload.get("note") or "",
                "responded_at_display": _format_display_date(response_payload.get("responded_at"), include_time=True),
            }

    quote_id = quote.get("id") or snapshot_row["quote_id"]
    snapshot_id = snapshot_row["id"]
    print_path = f"/api/quotes/{quote_id}/proposal/snapshot/{snapshot_id}/print"
    if token:
        print_path = f"{print_path}?token={token}"

    return {
        "snapshot_id": snapshot_id,
        "quote": quote,
        "tenant": tenant,
        "openings": opening_items,
        "brand_initial": ((tenant.get("name") or "W").strip()[:1] or "W").upper(),
        "generated_at_display": _format_display_date(generated_at, include_time=True),
        "valid_until_display": _format_display_date(valid_until),
        "total_price_display": _format_currency(total_price),
        "share_url": _absolute_public_url(f"/estimate/{token}") if token else None,
        "print_url": _absolute_public_url(print_path),
        "response_endpoint": f"/estimate/{token}/respond" if token else "",
        "existing_response": existing_response,
        "call_phone": (tenant.get("phone") or "").strip(),
    }


def _request_public_url(req):
    if PUBLIC_BASE_URL:
        suffix = req.full_path.rstrip("?") or req.path
        return f"{PUBLIC_BASE_URL}{suffix}"
    return req.url


def _sign_public_media_token(message_id, expires_at):
    payload = f"{message_id}:{expires_at}".encode("utf-8")
    secret = app.config["SECRET_KEY"].encode("utf-8")
    return hmac.new(secret, payload, hashlib.sha256).hexdigest()


def _build_public_chat_media_url(message_id, base_url=None):
    root = (base_url or _current_public_base_url()).rstrip("/")
    if not root:
        raise RuntimeError("Set PUBLIC_BASE_URL so Twilio can fetch MMS media")
    expires_at = int(datetime.utcnow().timestamp()) + max(300, SMS_PUBLIC_MEDIA_TTL_SECONDS)
    sig = _sign_public_media_token(message_id, expires_at)
    return f"{root}/api/public/chat-media/{message_id}?expires={expires_at}&sig={sig}"


def _validate_public_media_access(message_id, expires_at, signature):
    try:
        expires_at = int(expires_at)
    except (TypeError, ValueError):
        return False
    if expires_at < int(datetime.utcnow().timestamp()):
        return False
    expected = _sign_public_media_token(message_id, expires_at)
    return hmac.compare_digest(expected, str(signature or ""))


def _validate_twilio_request(req):
    if not TWILIO_WEBHOOK_ENFORCE:
        return True
    if not TWILIO_AUTH_TOKEN or _TwilioRequestValidator is None:
        return False
    signature = req.headers.get("X-Twilio-Signature", "")
    if not signature:
        return False
    validator = _TwilioRequestValidator(TWILIO_AUTH_TOKEN)
    return validator.validate(_request_public_url(req), req.form.to_dict(flat=True), signature)


def _ensure_sms_external_user(db, tenant_id):
    uid = f"u-sms-ext-{tenant_id[-6:]}"
    row = db.execute("SELECT id FROM users WHERE id=? AND tenant_id=?", (uid, tenant_id)).fetchone()
    if row:
        return uid
    email = f"sms+{tenant_id}@windowcalc.local"
    db.execute(
        """INSERT INTO users (id,tenant_id,name,email,role,tier,permissions_json,password_hash,must_change_password,active)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (
            uid,
            tenant_id,
            "Customer SMS Bridge",
            email,
            "viewer",
            "junior",
            _permissions_to_json("viewer"),
            _hash_password(secrets.token_hex(12)),
            0,
            0,
        ),
    )
    return uid


def _ensure_sms_thread(db, quote_row, channel_address=None):
    customer_phone = (quote_row.get("customer_phone") if isinstance(quote_row, dict) else quote_row["customer_phone"]) or ""
    customer_phone_norm = _normalize_phone_number(customer_phone)
    if not customer_phone_norm:
        raise ValueError("Customer phone must be a valid US phone number for SMS/MMS")

    tenant_id = quote_row.get("tenant_id") if isinstance(quote_row, dict) else quote_row["tenant_id"]
    quote_id = quote_row.get("id") if isinstance(quote_row, dict) else quote_row["id"]
    now = _now_iso()
    existing = db.execute("SELECT * FROM sms_threads WHERE quote_id=? AND tenant_id=?", (quote_id, tenant_id)).fetchone()
    if existing:
        db.execute(
            "UPDATE sms_threads SET customer_phone=?, customer_phone_norm=?, channel_address=COALESCE(?, channel_address), active=1, updated_at=? WHERE id=?",
            (customer_phone, customer_phone_norm, channel_address, now, existing["id"]),
        )
        return db.execute("SELECT * FROM sms_threads WHERE id=?", (existing["id"],)).fetchone()

    stid = f"st-{uuid.uuid4().hex[:10]}"
    db.execute(
        """INSERT INTO sms_threads (id,tenant_id,quote_id,customer_phone,customer_phone_norm,channel_provider,channel_address,active,last_inbound_at,last_outbound_at,created_at,updated_at)
           VALUES (?,?,?,?,?,'twilio',?,?,?, ?, ?, ?)""",
        (stid, tenant_id, quote_id, customer_phone, customer_phone_norm, channel_address, 1, None, None, now, now),
    )
    return db.execute("SELECT * FROM sms_threads WHERE id=?", (stid,)).fetchone()


def _find_sms_thread_for_inbound(db, from_phone_norm, to_phone_norm):
    query = """SELECT st.*, q.customer_name, q.id AS quote_id, q.tenant_id
               FROM sms_threads st
               JOIN quotes q ON q.id=st.quote_id AND q.tenant_id=st.tenant_id
               WHERE st.active=1 AND st.customer_phone_norm=?"""
    vals = [from_phone_norm]
    if to_phone_norm:
        query += " AND (st.channel_address IS NULL OR st.channel_address=? )"
        vals.append(to_phone_norm)
    query += " ORDER BY COALESCE(st.last_inbound_at, st.last_outbound_at, st.updated_at, st.created_at) DESC LIMIT 1"
    row = db.execute(query, vals).fetchone()
    if row or not to_phone_norm:
        return row
    return db.execute(
        query.replace(" AND (st.channel_address IS NULL OR st.channel_address=? )", ""),
        (from_phone_norm,),
    ).fetchone()


_JOB_MESSAGE_COLUMNS = [
    "id", "tenant_id", "quote_id", "user_id", "user_name", "content",
    "attachment_storage", "attachment_bucket", "attachment_object_name", "attachment_generation",
    "attachment_deleted_at", "attachment_url", "attachment_kind", "attachment_name", "attachment_mime", "attachment_size",
    "delivery_channel", "external_direction", "external_message_sid", "external_status", "external_from", "external_to", "external_error",
]


def _insert_job_message(db, payload):
    row = {key: payload.get(key) for key in _JOB_MESSAGE_COLUMNS}
    row.setdefault("attachment_deleted_at", None)
    row.setdefault("attachment_storage", None)
    row.setdefault("attachment_bucket", None)
    row.setdefault("attachment_object_name", None)
    row.setdefault("attachment_generation", None)
    row.setdefault("attachment_url", None)
    row.setdefault("attachment_kind", None)
    row.setdefault("attachment_name", None)
    row.setdefault("attachment_mime", None)
    row.setdefault("attachment_size", None)
    row.setdefault("delivery_channel", "in_app")
    row.setdefault("external_direction", None)
    row.setdefault("external_message_sid", None)
    row.setdefault("external_status", None)
    row.setdefault("external_from", None)
    row.setdefault("external_to", None)
    row.setdefault("external_error", None)
    db.execute(
        f"INSERT INTO job_messages ({','.join(_JOB_MESSAGE_COLUMNS)}) VALUES ({','.join(['?'] * len(_JOB_MESSAGE_COLUMNS))})",
        [row[key] for key in _JOB_MESSAGE_COLUMNS],
    )
    return row


def _download_twilio_media(media_url):
    req = urllib.request.Request(media_url, headers={"User-Agent": "WindowCalc/1.0"})
    if TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN:
        token = base64.b64encode(f"{TWILIO_ACCOUNT_SID}:{TWILIO_AUTH_TOKEN}".encode("utf-8")).decode("ascii")
        req.add_header("Authorization", f"Basic {token}")
    with urllib.request.urlopen(req, timeout=20) as resp:
        return resp.read(), resp.headers.get_content_type()


def _save_external_media_attachment(media_url, content_type, tenant_id, quote_id, message_id):
    data, detected_type = _download_twilio_media(media_url)
    final_type = (content_type or detected_type or "application/octet-stream").strip().lower()
    parsed = urllib.parse.urlparse(media_url)
    basename = os.path.basename(parsed.path)
    ext = os.path.splitext(basename)[1]
    if not ext:
        ext = mimetypes.guess_extension(final_type or "") or ""
        basename = f"twilio-media{ext}"
    file_storage = FileStorage(stream=io.BytesIO(data), filename=basename or f"twilio-media{ext}", content_type=final_type)
    return _save_job_message_attachment(file_storage, tenant_id, quote_id, message_id)


def _validate_twilio_attachment_meta(meta):
    mime = (meta.get("mime") or "").split(";", 1)[0].strip().lower()
    if mime not in TWILIO_MMS_ALLOWED_MIME_TYPES:
        raise ValueError("SMS/MMS attachments currently support JPG, PNG, GIF, MP4, and MOV files.")


def _twilio_status_callback_url(base_url=None):
    root = (base_url or _current_public_base_url()).rstrip("/")
    if not root:
        return None
    return f"{root}/api/webhooks/twilio/status"


_CHAT_MEDIA_SELECT = """SELECT jm.id, jm.tenant_id, jm.quote_id, jm.attachment_storage, jm.attachment_bucket,
                               jm.attachment_object_name, jm.attachment_generation, jm.attachment_url,
                               jm.attachment_kind, jm.attachment_name, jm.attachment_mime, jm.attachment_size,
                               q.rep_id
                        FROM job_messages jm
                        JOIN quotes q ON q.id=jm.quote_id AND q.tenant_id=jm.tenant_id
                        WHERE jm.id=? AND jm.attachment_deleted_at IS NULL"""


def _load_chat_media_row(db, message_id, tenant_id=None):
    query = _CHAT_MEDIA_SELECT
    params = [message_id]
    if tenant_id is not None:
        query += " AND jm.tenant_id=?"
        params.append(tenant_id)
    return db.execute(query, params).fetchone()


def _serve_chat_media_item(item):
    storage_mode = (item.get("attachment_storage") or ("gcs" if item.get("attachment_object_name") else "local")).lower()
    if storage_mode == "gcs" and item.get("attachment_bucket") and item.get("attachment_object_name"):
        try:
            return _stream_chat_media_from_gcs(
                item["attachment_bucket"],
                item["attachment_object_name"],
                content_type=item.get("attachment_mime"),
                filename=item.get("attachment_name"),
            )
        except FileNotFoundError:
            return jsonify({"error": "Cloud media object not found"}), 404

    local_path = _local_chat_media_absolute_path(item.get("attachment_url"))
    if not local_path or not os.path.exists(local_path):
        return jsonify({"error": "Local media file not found"}), 404

    rel_path = os.path.relpath(local_path, STATIC_DIR).replace("\\", "/")
    return send_from_directory(
        STATIC_DIR,
        rel_path,
        mimetype=item.get("attachment_mime") or _guess_attachment_mime(item.get("attachment_name")),
        as_attachment=False,
    )


def _local_chat_media_absolute_path(stored_url):
    rel_path = (stored_url or "").lstrip("/")
    if not rel_path.startswith("uploads/job-messages/"):
        return None
    abs_path = os.path.abspath(os.path.join(STATIC_DIR, rel_path))
    static_root = os.path.abspath(STATIC_DIR)
    if not abs_path.startswith(static_root):
        return None
    return abs_path


def _stream_chat_media_from_gcs(bucket_name, object_name, content_type=None, filename=None):
    bucket = _get_chat_storage_client().bucket(bucket_name)
    blob = bucket.blob(object_name)
    if not blob.exists():
        raise FileNotFoundError("Chat media object not found")
    stream = blob.open("rb")

    def generate():
        with stream:
            while True:
                chunk = stream.read(1024 * 1024)
                if not chunk:
                    break
                yield chunk

    headers = {
        "Cache-Control": "private, max-age=60",
    }
    if filename:
        headers["Content-Disposition"] = f'inline; filename="{secure_filename(filename) or "attachment"}"'

    return Response(
        stream_with_context(generate()),
        mimetype=content_type or "application/octet-stream",
        headers=headers,
        direct_passthrough=True,
    )


def _role_normalize(role):
    r = (role or "rep").strip().lower()
    if r == "admin":
        return "manager"
    return r if r in ROLE_HIERARCHY else "rep"


def _role_rank(role):
    role = _role_normalize(role)
    return ROLE_HIERARCHY.index(role) if role in ROLE_HIERARCHY else 0


def _default_permissions_for_role(role):
    role = _role_normalize(role)
    return dict(ROLE_DEFAULT_PERMISSIONS.get(role, ROLE_DEFAULT_PERMISSIONS["rep"]))


def _parse_permissions(raw, role):
    base = _default_permissions_for_role(role)
    if not raw:
        return base
    try:
        data = json.loads(raw) if isinstance(raw, str) else dict(raw)
    except Exception:
        return base
    for key in ALL_PERMISSIONS:
        if key in data:
            base[key] = bool(data[key])
    return base


def _permissions_to_json(role, overrides=None):
    perms = _default_permissions_for_role(role)
    if overrides:
        for key, value in overrides.items():
            if key in ALL_PERMISSIONS:
                perms[key] = bool(value)
    return json.dumps(perms)


def _session_serializer():
    return URLSafeTimedSerializer(app.config["SECRET_KEY"], salt="windowcalc-session-v1")


def _token_hash(token):
    return hashlib.sha256((token or "").encode("utf-8")).hexdigest()


def _hash_password(password, salt=None, iterations=200000):
    if salt is None:
        salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"), bytes.fromhex(salt), iterations)
    return f"pbkdf2_sha256${iterations}${salt}${digest.hex()}"


def _verify_password(password, stored_hash):
    if not stored_hash:
        return False
    try:
        algo, iter_s, salt, digest = stored_hash.split("$", 3)
        if algo != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"), bytes.fromhex(salt), int(iter_s)).hex()
        return hmac.compare_digest(candidate, digest)
    except Exception:
        return False


def _user_public_dict(user_row):
    if not user_row:
        return None
    role = _role_normalize(user_row["role"])
    perms = _parse_permissions(user_row["permissions_json"], role)
    if role in ("sysop", "owner", "manager"):
        perms["can_use_impersonation"] = True
    return {
        "id": user_row["id"],
        "tenant_id": user_row["tenant_id"],
        "name": user_row["name"],
        "email": user_row["email"],
        "role": role,
        "tier": user_row["tier"],
        "active": user_row["active"],
        "must_change_password": bool(user_row["must_change_password"]),
        "permissions": perms,
        "last_login_at": user_row["last_login_at"],
        "created_at": user_row["created_at"],
    }


def _issue_auth_session(db, user_row, impersonated_by=None, ttl_hours=None):
    if ttl_hours is None:
        ttl_hours = AUTH_SESSION_HOURS
    token_payload = {
        "sid": f"sess-{uuid.uuid4().hex}",
        "uid": user_row["id"],
        "tid": user_row["tenant_id"],
        "imp": impersonated_by,
        "ts": int(datetime.now().timestamp()),
    }
    token = _session_serializer().dumps(token_payload)
    expires_at = (datetime.utcnow() + timedelta(hours=ttl_hours)).isoformat()
    db.execute(
        """INSERT INTO auth_sessions (id,tenant_id,user_id,token_hash,impersonated_by,expires_at,revoked_at)
           VALUES (?,?,?,?,?,?,NULL)""",
        (token_payload["sid"], user_row["tenant_id"], user_row["id"], _token_hash(token), impersonated_by, expires_at),
    )
    db.execute("UPDATE users SET last_login_at=? WHERE id=?", (_now_iso(), user_row["id"]))
    db.commit()
    return token, expires_at


def _set_auth_cookie(resp, token, expires_at):
    try:
        exp_dt = datetime.fromisoformat(expires_at)
    except Exception:
        exp_dt = datetime.now() + timedelta(hours=AUTH_SESSION_HOURS)
    resp.set_cookie(
        AUTH_COOKIE_NAME,
        token,
        httponly=True,
        samesite="Lax",
        secure=AUTH_COOKIE_SECURE,
        expires=exp_dt,
        path='/',
    )


def _clear_auth_cookie(resp):
    resp.set_cookie(AUTH_COOKIE_NAME, "", expires=0, httponly=True, samesite="Lax", secure=AUTH_COOKIE_SECURE, path='/')


def _get_bearer_token(req):
    auth = req.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        return auth.split(" ", 1)[1].strip()
    return None


def _load_auth_context(db, req):
    token = req.cookies.get(AUTH_COOKIE_NAME) or _get_bearer_token(req)
    if not token:
        return None

    # Use 30-day max_age for token signature validation; actual session expiry is
    # enforced by the expires_at column in auth_sessions (supports mobile long-lived tokens).
    try:
        claims = _session_serializer().loads(token, max_age=30 * 24 * 3600)
    except (BadSignature, SignatureExpired):
        return None

    sid = claims.get("sid")
    uid = claims.get("uid")
    tid = claims.get("tid")
    if not sid or not uid or not tid:
        return None

    sess = db.execute(
        """SELECT * FROM auth_sessions
           WHERE id=? AND tenant_id=? AND user_id=? AND revoked_at IS NULL""",
        (sid, tid, uid),
    ).fetchone()
    if not sess:
        return None

    if sess["token_hash"] != _token_hash(token):
        return None

    if sess["expires_at"] and datetime.fromisoformat(sess["expires_at"]) < datetime.utcnow():
        return None

    user_row = db.execute(
        "SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1",
        (uid, tid),
    ).fetchone()
    if not user_row:
        return None

    return {
        "token": token,
        "session_id": sid,
        "tenant_id": tid,
        "user": _user_public_dict(user_row),
        "impersonated_by": sess["impersonated_by"],
    }


def _has_permission_ctx(ctx, permission):
    if not ctx:
        return False
    if _role_normalize(ctx["user"]["role"]) == "sysop":
        return True
    return bool(ctx["user"].get("permissions", {}).get(permission, False))


def _can_manage_role(actor_role, target_role):
    actor = _role_normalize(actor_role)
    target = _role_normalize(target_role)
    if actor == "sysop":
        return True
    return _role_rank(actor) > _role_rank(target)


def _ensure_default_permissions_and_passwords(db):
    rows = db.execute("SELECT id, role, permissions_json, password_hash FROM users").fetchall()
    for r in rows:
        role = _role_normalize(r["role"])
        updates = []
        vals = []
        if r["role"] != role:
            updates.append("role=?")
            vals.append(role)
        if not (r["permissions_json"] or "").strip():
            updates.append("permissions_json=?")
            vals.append(_permissions_to_json(role))
        if not (r["password_hash"] or "").strip():
            updates.append("password_hash=?")
            vals.append(_hash_password(_generate_temp_password()))
            updates.append("must_change_password=?")
            vals.append(1)
        if updates:
            vals.append(r["id"])
            db.execute(f"UPDATE users SET {','.join(updates)} WHERE id=?", vals)
    db.commit()


def _cleanup_oversized_text_payloads(db):
    approval_rows = db.execute(
        "SELECT id, rep_note, owner_note FROM approval_requests"
    ).fetchall()
    for row in approval_rows:
        row_data = dict(row)
        rep_note = _sanitize_text_field(row_data.get("rep_note"), MAX_APPROVAL_NOTE_LENGTH)
        owner_note = _sanitize_text_field(row_data.get("owner_note"), MAX_OWNER_NOTE_LENGTH)
        if rep_note != (row_data.get("rep_note") or "") or owner_note != (row_data.get("owner_note") or ""):
            db.execute(
                "UPDATE approval_requests SET rep_note=?, owner_note=? WHERE id=?",
                (rep_note, owner_note, row["id"]),
            )

    message_rows = db.execute(
        """SELECT id, content, attachment_storage, attachment_url, attachment_bucket,
                  attachment_object_name, attachment_name, attachment_mime
           FROM job_messages"""
    ).fetchall()
    for row in message_rows:
        row_data = dict(row)
        content = _sanitize_text_field(row_data.get("content"), MAX_JOB_MESSAGE_LENGTH)
        attachment_name = _sanitize_text_field(row_data.get("attachment_name"), 180)
        attachment_storage = (row_data.get("attachment_storage") or "").strip().lower()
        if not attachment_storage:
            attachment_storage = "gcs" if row_data.get("attachment_object_name") else "local" if row_data.get("attachment_url") else None
        attachment_mime = row_data.get("attachment_mime") or _guess_attachment_mime(attachment_name or row_data.get("attachment_url"))

        if (
            content != (row_data.get("content") or "")
            or attachment_name != (row_data.get("attachment_name") or "")
            or attachment_storage != (row_data.get("attachment_storage") or None)
            or attachment_mime != (row_data.get("attachment_mime") or None)
        ):
            db.execute(
                """UPDATE job_messages
                   SET content=?, attachment_storage=?, attachment_name=?, attachment_mime=?
                   WHERE id=?""",
                (content, attachment_storage, attachment_name, attachment_mime, row["id"]),
            )
    db.commit()


def _ensure_showcase_demo_data(db):
    if not SEED_DEMO_DATA:
        return
    tenant_id = "t-demo-001"
    tenant = db.execute("SELECT id FROM tenants WHERE id=?", (tenant_id,)).fetchone()
    if not tenant:
        return

    users = [dict(r) for r in db.execute(
        "SELECT id, name, email, role, tier FROM users WHERE tenant_id=? AND active=1 ORDER BY created_at, id",
        (tenant_id,),
    ).fetchall()]
    if not users:
        return

    rep_ids = [u["id"] for u in users if _role_normalize(u["role"]) == "rep"]
    if not rep_ids:
        rep_ids = [u["id"] for u in users if _role_normalize(u["role"]) in ("manager", "owner", "sysop")]
    if not rep_ids:
        return

    owner_user = next((u for u in users if _role_normalize(u["role"]) in ("owner", "sysop")), users[0])
    manager_user = next((u for u in users if _role_normalize(u["role"]) == "manager"), owner_user)
    user_name_map = {u["id"]: u["name"] for u in users}
    product_table_cols = set(_table_columns(db, "products"))
    select_columns = [
        "id", "name", "type", "product_line",
        "base_cost", "size_multiplier_per_sqft",
        "min_width", "max_width", "min_height", "max_height",
    ]
    if "dp_positive" in product_table_cols:
        select_columns.append("dp_positive")
    if "noa_number" in product_table_cols:
        select_columns.append("noa_number")

    products = [dict(r) for r in db.execute(
        f"""SELECT {', '.join(select_columns)}
            FROM products
            WHERE tenant_id=? AND active=1
            ORDER BY product_line, name""",
        (tenant_id,),
    ).fetchall()]
    if not products:
        return

    glass_id = db.execute(
        "SELECT id FROM glass_options WHERE tenant_id=? AND active=1 ORDER BY id LIMIT 1",
        (tenant_id,),
    ).fetchone()
    frame_id = db.execute(
        "SELECT id FROM frame_colors WHERE tenant_id=? AND active=1 ORDER BY id LIMIT 1",
        (tenant_id,),
    ).fetchone()
    default_glass_id = glass_id["id"] if glass_id else None
    default_frame_id = frame_id["id"] if frame_id else None

    existing_quote_ids = {
        r["id"] for r in db.execute("SELECT id FROM quotes WHERE tenant_id=?", (tenant_id,)).fetchall()
    }
    existing_quote_count = len(existing_quote_ids)

    blueprints = [
        {"status": "completed", "markup": 1.44, "zone": "HVHZ", "city": "Fort Lauderdale", "zip": "33316", "openings": 3,
         "rep_note": "Final install complete. Customer signed off at site."},
        {"status": "approved", "markup": 1.39, "zone": "COASTAL", "city": "Hollywood", "zip": "33019", "openings": 4,
         "rep_note": "Owner approved premium glass due HOA requirement.", "owner_note": "Approved based on upgrade package value."},
        {"status": "pending_approval", "markup": 1.28, "zone": "HVHZ", "city": "Miami Beach", "zip": "33139", "openings": 4,
         "rep_note": "Competitive comp at lower price. Requested exception to close this week."},
        {"status": "denied", "markup": 1.24, "zone": "HVHZ", "city": "Pompano Beach", "zip": "33062", "openings": 3,
         "rep_note": "Requested aggressive discount for referral close.", "owner_note": "Denied. Margin is below policy floor."},
        {"status": "draft", "markup": 1.35, "zone": "INLAND", "city": "Pembroke Pines", "zip": "33028", "openings": 2,
         "rep_note": "Draft in progress. Waiting on final measurements."},
        {"status": "completed", "markup": 1.42, "zone": "COASTAL", "city": "Deerfield Beach", "zip": "33441", "openings": 5,
         "rep_note": "Large retrofit complete with staggered install schedule."},
        {"status": "approved", "markup": 1.37, "zone": "HVHZ", "city": "Weston", "zip": "33326", "openings": 3,
         "rep_note": "Approved exception after upsell to laminated IGU.", "owner_note": "Approved with margin guardrails confirmed."},
        {"status": "pending_approval", "markup": 1.29, "zone": "COASTAL", "city": "Hallandale Beach", "zip": "33009", "openings": 4,
         "rep_note": "Customer bundle requested with doors + windows. Pending decision."},
        {"status": "completed", "markup": 1.46, "zone": "HVHZ", "city": "Coral Gables", "zip": "33134", "openings": 3,
         "rep_note": "Premium package delivered. Clean pass on all DP checks."},
        {"status": "denied", "markup": 1.22, "zone": "INLAND", "city": "Miramar", "zip": "33025", "openings": 2,
         "rep_note": "Price-match request exceeded discount policy.", "owner_note": "Denied. Offer revised with compliant pricing."},
        {"status": "approved", "markup": 1.34, "zone": "COASTAL", "city": "Aventura", "zip": "33180", "openings": 3,
         "rep_note": "Approved after reducing scope to priority openings.", "owner_note": "Approved for phase-1 scope only."},
    ]
    customer_names = [
        "Anderson Residence", "Bennett Family", "Carter Home", "Diaz Renovation", "Evans Property",
        "Foster Project", "Garcia Residence", "Hernandez Home", "Irwin Estate", "Johnson Residence",
        "Kim Family", "Lopez Property", "Martin Residence", "Nelson Home", "Owens Residence",
    ]
    street_roots = ["Harbor", "Bayview", "Palm", "Ocean", "Canal", "Sunset", "Las Olas", "Seabreeze", "Coral", "Riverside"]
    opening_shapes = [
        (36, 60, "single_hung"),
        (48, 72, "fixed"),
        (72, 80, "horizontal_roller"),
        (96, 80, "sliding_glass_door"),
        (36, 84, "casement"),
        (42, 96, "entry_door"),
    ]

    def _pick_product(opening_type, cursor):
        typed = [p for p in products if p.get("type") == opening_type]
        pool = typed if typed else products
        return pool[cursor % len(pool)]

    def _clamp(value, min_value, max_value):
        result = value
        if min_value:
            result = max(result, float(min_value))
        if max_value:
            result = min(result, float(max_value))
        return result

    now = datetime.now()
    target_total = 15
    demo_index = 5
    inserted_quotes = []

    while existing_quote_count < target_total:
        qid = f"q-demo-{demo_index:03d}"
        demo_index += 1
        if qid in existing_quote_ids:
            continue

        blueprint = blueprints[(demo_index - 6) % len(blueprints)]
        rep_id = rep_ids[(demo_index - 6) % len(rep_ids)]
        customer_name = customer_names[(demo_index - 6) % len(customer_names)]
        street = street_roots[(demo_index - 6) % len(street_roots)]
        city = blueprint["city"]
        zip_code = blueprint["zip"]
        created_at = (now - timedelta(days=max(0, 8 - ((demo_index - 6) % 8)), hours=(demo_index - 6) * 2)).isoformat()
        notes = f"Showcase demo quote {demo_index - 1}: {blueprint['status'].replace('_', ' ')}."

        db.execute(
            """INSERT INTO quotes
               (id, tenant_id, rep_id, customer_name, customer_phone, customer_email,
                job_address, job_zip, status, total_price, total_cost, margin_pct, margin_dollars,
                required_zone, pending_approval_payload, notes, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                qid,
                tenant_id,
                rep_id,
                customer_name,
                "(954) 555-0100",
                f"{customer_name.lower().replace(' ', '.')}@example.com",
                f"{100 + (demo_index - 5) * 17} {street} Blvd, {city}, FL {zip_code}",
                zip_code,
                blueprint["status"],
                0,
                0,
                0,
                0,
                blueprint["zone"],
                None,
                notes,
                created_at,
                created_at,
            ),
        )

        total_price = 0.0
        total_cost = 0.0
        opening_count = max(2, int(blueprint["openings"]))
        for pos in range(1, opening_count + 1):
            shape_w, shape_h, opening_type = opening_shapes[(demo_index + pos) % len(opening_shapes)]
            product = _pick_product(opening_type, demo_index + pos)

            width = _clamp(shape_w, product.get("min_width"), product.get("max_width"))
            height = _clamp(shape_h, product.get("min_height"), product.get("max_height"))
            area_sqft = (width * height) / 144.0

            base_cost = _safe_float(product.get("base_cost"), 500.0)
            size_mult = max(0.5, _safe_float(product.get("size_multiplier_per_sqft"), 1.5))
            cost = round(base_cost + (area_sqft * size_mult), 2)
            sell = round(cost * float(blueprint["markup"]), 2)
            margin_dollars = round(sell - cost, 2)
            margin_pct = round((margin_dollars / sell * 100.0), 1) if sell > 0 else 0.0
            dp_status = "failed" if blueprint["status"] == "denied" and pos == 1 else "passed"

            opening_id = f"o-demo-{demo_index:03d}-{pos:02d}"
            db.execute(
                """INSERT INTO openings
                   (id, quote_id, tenant_id, opening_number, opening_mode, opening_type,
                    total_width, total_height, floor_level, wall_type, product_id,
                    glass_option_id, frame_color_id, complexity_ids, sell_price, total_cost,
                    margin_pct, margin_dollars, dp_status, dp_rating_used, noa_number, required_zone)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    opening_id,
                    qid,
                    tenant_id,
                    pos,
                    "single",
                    opening_type,
                    width,
                    height,
                    1 + ((pos + demo_index) % 3),
                    "cbs",
                    product["id"],
                    default_glass_id,
                    default_frame_id,
                    "[]",
                    sell,
                    cost,
                    margin_pct,
                    margin_dollars,
                    dp_status,
                    _safe_float(product.get("dp_positive"), 70.0),
                    product.get("noa_number") or "N/A",
                    blueprint["zone"],
                ),
            )
            total_price += sell
            total_cost += cost

        quote_margin_dollars = round(total_price - total_cost, 2)
        quote_margin_pct = round((quote_margin_dollars / total_price * 100.0), 1) if total_price > 0 else 0.0
        db.execute(
            """UPDATE quotes
               SET total_price=?, total_cost=?, margin_pct=?, margin_dollars=?, updated_at=?
               WHERE id=? AND tenant_id=?""",
            (
                round(total_price, 2),
                round(total_cost, 2),
                quote_margin_pct,
                quote_margin_dollars,
                datetime.now().isoformat(),
                qid,
                tenant_id,
            ),
        )

        if blueprint["status"] in ("pending_approval", "approved", "denied"):
            arid = f"ar-demo-{demo_index:03d}"
            exists = db.execute(
                "SELECT id FROM approval_requests WHERE id=? AND tenant_id=?",
                (arid, tenant_id),
            ).fetchone()
            rep_note = _sanitize_text_field(blueprint.get("rep_note"), MAX_APPROVAL_NOTE_LENGTH)
            owner_note = _sanitize_text_field(blueprint.get("owner_note"), MAX_OWNER_NOTE_LENGTH)
            if not exists:
                db.execute(
                    """INSERT INTO approval_requests
                       (id, quote_id, tenant_id, rep_id, current_margin, requested_margin, rep_note,
                        status, owner_note, decided_by, decided_at, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        arid,
                        qid,
                        tenant_id,
                        rep_id,
                        quote_margin_pct,
                        quote_margin_pct,
                        rep_note,
                        blueprint["status"].replace("pending_approval", "pending"),
                        owner_note if blueprint["status"] in ("approved", "denied") else None,
                        owner_user["id"] if blueprint["status"] in ("approved", "denied") else None,
                        datetime.now().isoformat() if blueprint["status"] in ("approved", "denied") else None,
                        created_at,
                    ),
                )

        inserted_quotes.append(qid)
        existing_quote_ids.add(qid)
        existing_quote_count += 1

    # Build size-band pricing points so products can be grouped by measurement categories in UI.
    size_points = [(24, 36), (30, 48), (36, 60), (42, 72), (48, 84), (60, 96)]
    for product in products:
        rows = db.execute(
            "SELECT width, height FROM product_price_points WHERE tenant_id=? AND product_id=? AND active=1",
            (tenant_id, product["id"]),
        ).fetchall()
        existing_dims = {(round(_safe_float(r["width"], 0), 2), round(_safe_float(r["height"], 0), 2)) for r in rows}
        if len(existing_dims) >= 6:
            continue

        min_w = _safe_float(product.get("min_width"), 0) or 12
        max_w = _safe_float(product.get("max_width"), 0) or 144
        min_h = _safe_float(product.get("min_height"), 0) or 12
        max_h = _safe_float(product.get("max_height"), 0) or 144
        base_cost = _safe_float(product.get("base_cost"), 500.0)
        size_mult = max(0.5, _safe_float(product.get("size_multiplier_per_sqft"), 1.5))

        for width, height in size_points:
            w = _clamp(width, min_w, max_w)
            h = _clamp(height, min_h, max_h)
            key = (round(w, 2), round(h, 2))
            if key in existing_dims:
                continue

            area_sqft = (w * h) / 144.0
            price = round((base_cost + (area_sqft * size_mult * 1.35)) / 5.0) * 5.0
            pp_id = f"pp-demo-{uuid.uuid4().hex[:8]}"
            db.execute(
                """INSERT INTO product_price_points (id, tenant_id, product_id, width, height, price, active)
                   VALUES (?,?,?,?,?,?,1)
                   ON CONFLICT(tenant_id, product_id, width, height)
                   DO UPDATE SET price=excluded.price, active=1""",
                (pp_id, tenant_id, product["id"], w, h, price),
            )
            existing_dims.add(key)
            if len(existing_dims) >= 6:
                break

    # Seed Job Hub conversation threads on recent demo quotes.
    recent_quotes = [dict(r) for r in db.execute(
        "SELECT id, rep_id, customer_name FROM quotes WHERE tenant_id=? ORDER BY created_at DESC LIMIT 6",
        (tenant_id,),
    ).fetchall()]
    for idx, quote in enumerate(recent_quotes, 1):
        msg_count = db.execute(
            "SELECT COUNT(*) FROM job_messages WHERE tenant_id=? AND quote_id=?",
            (tenant_id, quote["id"]),
        ).fetchone()[0]
        if msg_count >= 2:
            continue

        rep_id = quote["rep_id"] if quote.get("rep_id") in user_name_map else rep_ids[0]
        messages = [
            (rep_id, user_name_map.get(rep_id, "Field Rep"), f"Walkthrough complete for {quote['customer_name']}. Verifying final panel split before close."),
            (manager_user["id"], manager_user["name"], "Received. Keep requested pricing within policy bands and attach any DP constraints."),
            (owner_user["id"], owner_user["name"], "If customer accepts scope, proceed to final proposal and lock pricing."),
        ]
        for midx, (uid, uname, content) in enumerate(messages, 1):
            mid = f"msg-demo-{quote['id'][-3:]}-{midx:02d}"
            exists = db.execute(
                "SELECT id FROM job_messages WHERE id=? AND tenant_id=?",
                (mid, tenant_id),
            ).fetchone()
            if exists:
                continue
            db.execute(
                """INSERT INTO job_messages (id, tenant_id, quote_id, user_id, user_name, content, created_at)
                   VALUES (?,?,?,?,?,?,?)""",
                (
                    mid,
                    tenant_id,
                    quote["id"],
                    uid,
                    uname,
                    _sanitize_text_field(content, MAX_JOB_MESSAGE_LENGTH),
                    (datetime.now() - timedelta(minutes=(idx * 7) + midx)).isoformat(),
                ),
            )

    db.commit()


def _get_user_row(db, tenant_id, user_id):
    if not user_id:
        return None
    return db.execute(
        "SELECT * FROM users WHERE id=? AND tenant_id=?",
        (user_id, tenant_id)
    ).fetchone()


def _normalize_governance_override_type(value):
    key = str(value or "").strip().lower()
    if key not in GOVERNANCE_OVERRIDE_TYPES:
        raise ValueError("override_type must be margin_floor, max_discount, or yellow_threshold")
    return key


def _normalize_optional_expiry(value):
    raw = str(value or "").strip()
    if not raw:
        return None
    parsed = _parse_datetime_value(raw)
    if not parsed:
        raise ValueError("expires_at must be a valid ISO date or datetime")
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw):
        parsed = parsed.replace(hour=23, minute=59, second=59, microsecond=999999)
    return parsed.isoformat()


def _is_governance_override_active(row, now=None):
    if not row or not int(_row_get(row, "active", 0) or 0):
        return False
    expires_at = _parse_datetime_value(_row_get(row, "expires_at"))
    if expires_at is None:
        return True
    current_time = now or datetime.now()
    return expires_at >= current_time


def _serialize_governance_override(row):
    if not row:
        return None
    data = dict(row)
    data["active"] = bool(data.get("active", 0))
    data["override_value"] = round(_safe_float(data.get("override_value"), 0.0), 2)
    data["is_active"] = _is_governance_override_active(data)
    data["override_label"] = GOVERNANCE_OVERRIDE_TYPES.get(data.get("override_type"), data.get("override_type"))
    return data


def _list_governance_overrides(db, tenant_id, user_id=None, active_only=True):
    query = """
        SELECT go.*,
               u.name AS user_name,
               u.role AS user_role,
               u.tier AS user_tier,
               grantor.name AS granted_by_name
          FROM governance_overrides go
          JOIN users u
            ON u.id=go.user_id AND u.tenant_id=go.tenant_id
          LEFT JOIN users grantor
            ON grantor.id=go.granted_by AND grantor.tenant_id=go.tenant_id
         WHERE go.tenant_id=?
    """
    params = [tenant_id]
    if user_id:
        query += " AND go.user_id=?"
        params.append(user_id)
    if active_only:
        query += " AND go.active=1"
    query += " ORDER BY LOWER(COALESCE(u.name, go.user_id)), go.created_at DESC"

    rows = db.execute(query, params).fetchall()
    now = datetime.now()
    serialized = [_serialize_governance_override(row) for row in rows]
    if active_only:
        serialized = [row for row in serialized if _is_governance_override_active(row, now=now)]
    return serialized


def _strict_noa_enforcement_enabled(db, tenant_id):
    row = db.execute(
        """SELECT strict_noa_enforcement
             FROM governance_settings
            WHERE tenant_id=?
            ORDER BY updated_at DESC, id DESC
            LIMIT 1""",
        (tenant_id,),
    ).fetchone()
    return bool(row and int(row["strict_noa_enforcement"] or 0))


def _strict_noa_block_response():
    return jsonify(
        {
            "error": "noa_hard_block",
            "message": (
                "This opening does not meet DP/NOA requirements. Strict enforcement is enabled. "
                "Adjust the product or dimensions before saving."
            ),
        }
    ), 422


def _get_governance_for_rep(db, tenant_id, rep_id=None):
    user = _get_user_row(db, tenant_id, rep_id)
    tier = user["tier"] if user and user["tier"] else "standard"
    row = db.execute(
        "SELECT * FROM governance_settings WHERE tenant_id=? AND tier=?",
        (tenant_id, tier)
    ).fetchone()
    if not row:
        governance = {
            "tier": tier,
            "margin_floor": 30.0,
            "yellow_threshold": 3.0,
            "discount_approval_required": 1,
            "max_discount_pct": 5.0,
            "strict_noa_enforcement": 0,
        }
    else:
        governance = dict(row)

    if rep_id:
        overrides = _list_governance_overrides(db, tenant_id, user_id=rep_id, active_only=True)
        applied_types = set()
        for override in overrides:
            override_value = _safe_float(override.get("override_value"), None)
            if override_value is None:
                continue
            if override["override_type"] in applied_types:
                continue
            if override["override_type"] == "margin_floor":
                governance["margin_floor"] = override_value
            elif override["override_type"] == "max_discount":
                governance["max_discount_pct"] = override_value
            elif override["override_type"] == "yellow_threshold":
                governance["yellow_threshold"] = override_value
            applied_types.add(override["override_type"])
        if overrides:
            governance["active_overrides"] = [
                {
                    "id": row["id"],
                    "override_type": row["override_type"],
                    "override_label": row["override_label"],
                    "override_value": row["override_value"],
                    "expires_at": row["expires_at"],
                }
                for row in overrides
            ]

    return governance


def _can_access_reports(auth_ctx):
    role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx and auth_ctx.get("user") else "viewer"
    return role in ("manager", "owner", "sysop")


def _normalize_report_date_input(value, end_of_day=False):
    raw = (value or "").strip()
    if not raw:
        return None

    parsed = _parse_datetime_value(raw)
    if not parsed:
        raise ValueError("Report dates must be valid ISO date strings.")

    looks_like_date_only = bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", raw))
    if looks_like_date_only:
        if end_of_day:
            parsed = parsed.replace(hour=23, minute=59, second=59, microsecond=999999)
        else:
            parsed = parsed.replace(hour=0, minute=0, second=0, microsecond=0)
    return parsed.isoformat()


def _build_report_scope_filters(req, created_field, rep_field):
    from_date = (req.args.get("from_date") or "").strip() or None
    to_date = (req.args.get("to_date") or "").strip() or None
    rep_id = _sanitize_text_field(req.args.get("rep_id"), 80) or None

    from_ts = _normalize_report_date_input(from_date, end_of_day=False) if from_date else None
    to_ts = _normalize_report_date_input(to_date, end_of_day=True) if to_date else None

    if from_ts and to_ts and from_ts > to_ts:
        raise ValueError("from_date must be on or before to_date.")

    where_parts = []
    params = []
    if from_ts:
        where_parts.append(f"{created_field} >= ?")
        params.append(from_ts)
    if to_ts:
        where_parts.append(f"{created_field} <= ?")
        params.append(to_ts)
    if rep_id:
        where_parts.append(f"{rep_field} = ?")
        params.append(rep_id)

    return {
        "period": {"from": from_date, "to": to_date},
        "rep_id": rep_id,
        "where_parts": where_parts,
        "params": params,
    }


def _get_size_point_price(db, tenant_id, product_id, width, height):
    rows = db.execute(
        """SELECT width, height, price FROM product_price_points
           WHERE tenant_id=? AND product_id=? AND active=1""",
        (tenant_id, product_id)
    ).fetchall()
    if not rows:
        return None

    # Exact size hit first.
    for r in rows:
        if abs(r["width"] - width) < 0.01 and abs(r["height"] - height) < 0.01:
            return {"price": float(r["price"]), "method": "exact"}

    nearest = min(
        rows,
        key=lambda r: math.sqrt((r["width"] - width) ** 2 + (r["height"] - height) ** 2)
    )
    return {
        "price": float(nearest["price"]),
        "method": "nearest",
        "nearest_width": nearest["width"],
        "nearest_height": nearest["height"],
    }


def _evaluate_pricing_governance(db, tenant_id, rep_id, margin_pct, discount_pct, job_total=None):
    gov = _get_governance_for_rep(db, tenant_id, rep_id)
    floor = _safe_float(gov.get("margin_floor"), 30.0)
    yellow = _safe_float(gov.get("yellow_threshold"), 3.0)
    max_discount = _safe_float(gov.get("max_discount_pct"), 5.0)
    approval_required = bool(gov.get("discount_approval_required", 1))

    # Apply discount tier override if job_total is provided
    if job_total is not None:
        tier_max_discount = _get_discount_tier_for_total(db, tenant_id, job_total)
        if tier_max_discount is not None:
            max_discount = _safe_float(tier_max_discount, max_discount)

    reasons = []
    if approval_required and margin_pct < floor:
        reasons.append("margin_below_floor")
    if discount_pct > max_discount:
        reasons.append("discount_above_threshold")

    return {
        "tier": gov.get("tier", "standard"),
        "margin_floor": floor,
        "yellow_threshold": yellow,
        "max_discount_pct": max_discount,
        "discount_approval_required": approval_required,
        "margin_status": get_margin_status(margin_pct, floor, yellow),
        "requires_approval": len(reasons) > 0,
        "reasons": reasons,
    }


def _get_discount_tier_for_total(db, tenant_id, job_total):
    """
    Find a matching discount tier for the given job total.
    Returns the max_discount_pct of the matching tier, or None if no tier matches.
    """
    try:
        job_total = float(job_total) if job_total else 0
    except (ValueError, TypeError):
        return None

    row = db.execute("""
        SELECT max_discount_pct FROM discount_tiers
        WHERE tenant_id = ? AND active = 1
        AND min_job_total <= ?
        AND (max_job_total IS NULL OR max_job_total >= ?)
        ORDER BY min_job_total DESC
        LIMIT 1
    """, (tenant_id, job_total, job_total)).fetchone()

    return row["max_discount_pct"] if row else None


def _compute_opening_cost_components_fallback(**kw):
    """Inline fallback used only if pricing_engine.py is missing at import time."""
    bc, sc = kw["base_cost"], kw["size_cost"]
    sized = round(bc + sc, 2)
    sub = round(sized + kw["floor_labor"] + kw["glass_adder"] + kw["frame_adder"] + kw["complexity_cost"], 2)
    after_t = round(sub * kw["territory_mult"], 2)
    pre_c = round(after_t * kw["global_mult"], 2)
    total = round(pre_c + kw["consumables_cost"], 2)
    return {
        "base_cost": round(bc, 2), "size_cost": round(sc, 2),
        "size_method": kw["size_method"], "sqft": round(kw["sqft"], 2),
        "floor_labor": round(kw["floor_labor"], 2), "glass_adder": round(kw["glass_adder"], 2),
        "frame_adder": round(kw["frame_adder"], 2), "complexity_adder": round(kw["complexity_cost"], 2),
        "subtotal": sub, "territory_multiplier": kw["territory_mult"],
        "subtotal_after_territory": after_t, "global_multiplier": kw["global_mult"],
        "total_cost_pre_consumables": pre_c,
        "consumables_cost": round(kw["consumables_cost"], 2),
        "consumables_breakdown": kw["consumables_breakdown"],
        "total_cost": total,
    }


def _compute_sell_price_fallback(total_cost, default_markup, driveway_discount_pct=0.0, requested_sell_price=None):
    """Inline fallback used only if pricing_engine.py is missing at import time."""
    driveway_discount_pct = max(0.0, min(90.0, _safe_float(driveway_discount_pct, 0.0)))
    baseline = round(total_cost * default_markup, 2)
    if requested_sell_price is not None:
        sell = round(max(0.01, _safe_float(requested_sell_price, baseline)), 2)
        if baseline > 0:
            driveway_discount_pct = round(max(0.0, (1 - sell / baseline) * 100), 2)
    else:
        sell = round(max(0.01, baseline * (1 - driveway_discount_pct / 100.0)), 2)
    m_d = round(sell - total_cost, 2)
    m_p = round((m_d / sell) * 100, 1) if sell > 0 else 0.0
    mk_p = round((m_d / total_cost) * 100, 1) if total_cost > 0 else 0.0
    return {"sell_price": sell, "baseline_sell_price": baseline, "discount_pct": driveway_discount_pct,
            "margin_pct": m_p, "margin_dollars": m_d, "markup_pct": mk_p}


def calculate_price(db, tenant_id, product_id, width, height, floor_level,
                    glass_option_id=None, frame_color_id=None, complexity_ids=None,
                    zip_code=None, wall_type="cbs", opening_count=1,
                    rep_id=None, driveway_discount_pct=0, requested_sell_price=None):
    product = db.execute(
        "SELECT * FROM products WHERE id=? AND tenant_id=? AND active=1", (product_id, tenant_id)
    ).fetchone()
    if not product:
        return None

    width = _safe_float(width, 0)
    height = _safe_float(height, 0)
    floor_level = int(_safe_float(floor_level, 1))
    driveway_discount_pct = max(0.0, min(90.0, _safe_float(driveway_discount_pct, 0.0)))

    # Clamp to product dimension limits (delegates to pricing_engine if available)
    if _pe is not None:
        width, height = _pe.clamp_dimensions(
            width, height,
            product["min_width"], product["max_width"],
            product["min_height"], product["max_height"],
        )
    else:
        if product["min_width"] and width < product["min_width"]:
            width = product["min_width"]
        if product["max_width"] and width > product["max_width"]:
            width = product["max_width"]
        if product["min_height"] and height < product["min_height"]:
            height = product["min_height"]
        if product["max_height"] and height > product["max_height"]:
            height = product["max_height"]

    sqft = (width * height) / 144.0
    base_cost = _safe_float(product["base_cost"], 0)
    size_cost = round(sqft * _safe_float(product["size_multiplier_per_sqft"], 0), 2)

    size_point = _get_size_point_price(db, tenant_id, product_id, width, height)
    if size_point:
        sized_material_cost = round(size_point["price"], 2)
        size_cost = round(sized_material_cost - base_cost, 2)
        size_method = size_point["method"]
    else:
        size_method = "formula"

    # ── DB lookups for adders ─────────────────────────────────────────────
    floor_row = db.execute(
        "SELECT labor_adder FROM floor_labor WHERE tenant_id=? AND floor_level=?",
        (tenant_id, floor_level)
    ).fetchone()
    floor_cost = _safe_float(floor_row["labor_adder"], 0) if floor_row else 0

    glass_cost = 0
    if glass_option_id:
        g = db.execute(
            "SELECT cost_adder FROM glass_options WHERE id=? AND tenant_id=?",
            (glass_option_id, tenant_id)
        ).fetchone()
        if g:
            glass_cost = _safe_float(g["cost_adder"], 0)

    frame_cost = 0
    if frame_color_id:
        fc = db.execute(
            "SELECT cost_adder FROM frame_colors WHERE id=? AND tenant_id=?",
            (frame_color_id, tenant_id)
        ).fetchone()
        if fc:
            frame_cost = _safe_float(fc["cost_adder"], 0)

    complexity_cost = 0
    if complexity_ids:
        if isinstance(complexity_ids, str):
            try:
                complexity_ids = json.loads(complexity_ids)
            except Exception:
                complexity_ids = []
        for cid in complexity_ids:
            cx = db.execute(
                "SELECT cost FROM complexity_items WHERE id=? AND tenant_id=?",
                (cid, tenant_id)
            ).fetchone()
            if cx:
                complexity_cost += _safe_float(cx["cost"], 0)

    territory_mult = 1.0
    if zip_code:
        tm = db.execute(
            "SELECT multiplier FROM territory_multipliers WHERE tenant_id=? AND zip_code=?",
            (tenant_id, zip_code)
        ).fetchone()
        if tm:
            territory_mult = _safe_float(tm["multiplier"], 1.0)

    global_mult = _safe_float(_get_global_setting(db, tenant_id, "global_multiplier", "1.00"), 1.0)
    consumables_cost, consumables_breakdown = _calculate_consumables(db, tenant_id, wall_type, opening_count)
    default_markup = _safe_float(_get_global_setting(db, tenant_id, "default_markup", "1.75"), 1.75)

    # ── Pure math via pricing_engine ─────────────────────────────────────
    cost_components = (_pe.compute_opening_cost_components if _pe is not None else _compute_opening_cost_components_fallback)(
        base_cost=base_cost,
        size_cost=size_cost,
        size_method=size_method,
        sqft=sqft,
        floor_labor=floor_cost,
        glass_adder=glass_cost,
        frame_adder=frame_cost,
        complexity_cost=complexity_cost,
        territory_mult=territory_mult,
        global_mult=global_mult,
        consumables_cost=consumables_cost,
        consumables_breakdown=consumables_breakdown,
    )
    total_cost = cost_components["total_cost"]

    sell_result = (_pe.compute_sell_price if _pe is not None else _compute_sell_price_fallback)(
        total_cost=total_cost,
        default_markup=default_markup,
        driveway_discount_pct=driveway_discount_pct,
        requested_sell_price=requested_sell_price,
    )
    sell_price = sell_result["sell_price"]
    baseline_sell_price = sell_result["baseline_sell_price"]
    driveway_discount_pct = sell_result["discount_pct"]
    margin_pct = sell_result["margin_pct"]
    margin_dollars = sell_result["margin_dollars"]
    markup_pct = sell_result["markup_pct"]

    governance = _evaluate_pricing_governance(db, tenant_id, rep_id, margin_pct, driveway_discount_pct)

    return {
        "total_cost": total_cost,
        "sell_price": sell_price,
        "baseline_sell_price": baseline_sell_price,
        "discount_pct": driveway_discount_pct,
        "margin_pct": margin_pct,
        "margin_dollars": margin_dollars,
        "markup_pct": markup_pct,
        "margin_status": governance["margin_status"],
        "margin_floor": governance["margin_floor"],
        "requires_approval": governance["requires_approval"],
        "governance": governance,
        "breakdown": {**cost_components, "default_markup": default_markup},
    }


def calculate_assembly_price(db, tenant_id, opening_id, panels, floor_level,
                              glass_option_id=None, frame_color_id=None,
                              complexity_ids=None, zip_code=None, wall_type="cbs"):
    mull_bar_cost = float(_get_global_setting(db, tenant_id, "mull_bar_cost", "45"))
    mull_reinforcement_cost = float(_get_global_setting(db, tenant_id, "mull_reinforcement_cost", "85"))
    assembly_labor_per_mull = float(_get_global_setting(db, tenant_id, "assembly_labor_per_mull", "120"))

    panel_count = len(panels)
    mull_count = panel_count - 1

    panel_results = []
    total_panel_cost = 0.0
    total_panel_sell = 0.0
    needs_reinforcement = False

    for panel in panels:
        p_glass = panel.get("glass_option_id") or glass_option_id
        p_color = panel.get("frame_color_id") or frame_color_id
        p_complexity = panel.get("complexity_ids") or complexity_ids or []
        p_width = panel["width"]
        p_height = panel["height"]

        sqft = (p_width * p_height) / 144.0
        if sqft > 30:
            needs_reinforcement = True

        pricing = calculate_price(
            db, tenant_id, panel["product_id"], p_width, p_height,
            floor_level, p_glass, p_color, p_complexity, zip_code, wall_type,
            opening_count=panel_count
        )
        if not pricing:
            return None

        panel_results.append({
            "panel_index": panel.get("panel_index", 0),
            "panel_label": panel.get("panel_label", f"Panel {panel.get('panel_index',0)+1}"),
            "product_id": panel["product_id"],
            "width": p_width,
            "height": p_height,
            "sqft": round(sqft, 2),
            "pricing": pricing
        })
        total_panel_cost += pricing["total_cost"]
        total_panel_sell += pricing["sell_price"]

    mull_bar_total = round(mull_bar_cost * mull_count, 2)
    reinforcement_cost = round(mull_reinforcement_cost, 2) if needs_reinforcement else 0
    assembly_labor_total = round(assembly_labor_per_mull * mull_count, 2)

    total_cost = round(total_panel_cost + mull_bar_total + reinforcement_cost + assembly_labor_total, 2)

    default_markup = float(_get_global_setting(db, tenant_id, "default_markup", "1.75"))
    sell_price = round(total_cost * default_markup, 2)
    margin_dollars = round(sell_price - total_cost, 2)
    margin_pct = round((margin_dollars / sell_price) * 100, 1) if sell_price > 0 else 0
    markup_pct = round((margin_dollars / total_cost) * 100, 1) if total_cost > 0 else 0

    return {
        "total_cost": total_cost,
        "sell_price": sell_price,
        "margin_pct": margin_pct,
        "margin_dollars": margin_dollars,
        "markup_pct": markup_pct,
        "panel_results": panel_results,
        "assembly_breakdown": {
            "total_panel_cost": round(total_panel_cost, 2),
            "mull_count": mull_count,
            "mull_bar_cost": mull_bar_total,
            "needs_reinforcement": needs_reinforcement,
            "reinforcement_cost": reinforcement_cost,
            "assembly_labor": assembly_labor_total,
        }
    }


def _validate_zone_dp_requirement(db, tenant_id, dp_row, floor_level, required_zone=None):
    zone_code = _resolve_required_zone(db, tenant_id, required_zone)
    if not zone_code:
        return {"status": "passed", "zone_code": None, "required_dp": None, "failure_reason": None}

    zone = db.execute(
        """SELECT * FROM zone_pressure_requirements
           WHERE tenant_id=? AND zone_code=? AND active=1""",
        (tenant_id, zone_code)
    ).fetchone()
    if not zone:
        return {
            "status": "warning",
            "zone_code": zone_code,
            "required_dp": None,
            "failure_reason": f"No zone DP rule configured for zone '{zone_code}'.",
        }

    required_dp = _safe_float(zone["required_dp"], 0)
    offered_dp = abs(_safe_float(dp_row["dp_negative"], 0))

    if zone["max_story_height"] and floor_level > zone["max_story_height"]:
        return {
            "status": "failed",
            "zone_code": zone_code,
            "required_dp": required_dp,
            "failure_reason": (
                f"Zone {zone_code} is configured for max story {zone['max_story_height']}. "
                f"Current floor: {floor_level}."
            ),
        }

    if zone["hvhz_required"] and not dp_row["hvhz_approved"]:
        return {
            "status": "failed",
            "zone_code": zone_code,
            "required_dp": required_dp,
            "failure_reason": f"Zone {zone_code} requires HVHZ-rated products.",
        }

    if offered_dp < required_dp:
        return {
            "status": "failed",
            "zone_code": zone_code,
            "required_dp": required_dp,
            "failure_reason": (
                f"Zone {zone_code} requires DP {required_dp}, but selected product is DP {offered_dp}."
            ),
        }

    return {
        "status": "passed",
        "zone_code": zone_code,
        "required_dp": required_dp,
        "failure_reason": None,
    }


def validate_dp(db, tenant_id, product_id, width, height, floor_level, hvhz=None, required_zone=None):
    dp = db.execute(
        "SELECT * FROM dp_ratings WHERE product_id=? AND tenant_id=? AND active=1",
        (product_id, tenant_id)
    ).fetchone()

    product_row = db.execute("SELECT * FROM products WHERE id=?", (product_id,)).fetchone()
    product_name = product_row["name"] if product_row else product_id

    if not dp:
        return {
            "status": "failed",
            "dp_positive": None,
            "dp_negative": None,
            "noa_number": None,
            "zone": required_zone,
            "failure_reason": f"No DP rating record found for product '{product_name}'."
        }

    width = _safe_float(width, 0)
    height = _safe_float(height, 0)
    floor_level = int(_safe_float(floor_level, 1))
    sqft = (width * height) / 144.0

    if dp["max_width_for_dp"] and width > dp["max_width_for_dp"]:
        return {
            "status": "failed",
            "dp_positive": dp["dp_positive"],
            "dp_negative": dp["dp_negative"],
            "noa_number": dp["noa_number"],
            "zone": required_zone,
            "failure_reason": (
                f"Width {width}\" exceeds max approved width {dp['max_width_for_dp']}\" "
                f"for {product_name} under NOA {dp['noa_number']}."
            )
        }

    if dp["max_height_for_dp"] and height > dp["max_height_for_dp"]:
        return {
            "status": "failed",
            "dp_positive": dp["dp_positive"],
            "dp_negative": dp["dp_negative"],
            "noa_number": dp["noa_number"],
            "zone": required_zone,
            "failure_reason": (
                f"Height {height}\" exceeds max approved height {dp['max_height_for_dp']}\" "
                f"for {product_name} under NOA {dp['noa_number']}."
            )
        }

    if dp["max_sqft_for_dp"] and sqft > dp["max_sqft_for_dp"]:
        return {
            "status": "failed",
            "dp_positive": dp["dp_positive"],
            "dp_negative": dp["dp_negative"],
            "noa_number": dp["noa_number"],
            "zone": required_zone,
            "failure_reason": (
                f"Opening size {round(sqft, 1)} sqft exceeds max approved {dp['max_sqft_for_dp']} sqft "
                f"for {product_name} under NOA {dp['noa_number']}."
            )
        }

    if floor_level > dp["max_story_height"]:
        return {
            "status": "failed",
            "dp_positive": dp["dp_positive"],
            "dp_negative": dp["dp_negative"],
            "noa_number": dp["noa_number"],
            "zone": required_zone,
            "failure_reason": (
                f"{product_name} is not approved for floor {floor_level}. "
                f"Maximum approved: floor {dp['max_story_height']} per NOA {dp['noa_number']}."
            )
        }

    zone_check = _validate_zone_dp_requirement(db, tenant_id, dp, floor_level, required_zone)
    status = "passed"
    if zone_check["status"] == "failed":
        status = "failed"
    elif zone_check["status"] == "warning":
        status = "warning"

    return {
        "status": status,
        "dp_positive": dp["dp_positive"],
        "dp_negative": dp["dp_negative"],
        "noa_number": dp["noa_number"],
        "missile_rating": dp["missile_rating"],
        "hvhz_approved": bool(dp["hvhz_approved"]),
        "max_story_height": dp["max_story_height"],
        "zone": zone_check.get("zone_code"),
        "required_dp": zone_check.get("required_dp"),
        "failure_reason": zone_check.get("failure_reason"),
    }


def calculate_lead_time(db, tenant_id, product_id, frame_color_id=None):
    product = db.execute(
        "SELECT lead_time_weeks, product_line FROM products WHERE id=? AND tenant_id=?",
        (product_id, tenant_id)
    ).fetchone()
    if not product:
        return {"lead_time_weeks": 4, "breakdown": []}

    base_weeks = product["lead_time_weeks"]
    product_line = product["product_line"]
    breakdown = [{"reason": "Base product lead time", "weeks": base_weeks}]
    extra = 0

    if frame_color_id:
        overrides = db.execute(
            """SELECT * FROM lead_time_overrides
               WHERE tenant_id=? AND frame_color_id=? AND active=1
               AND (product_line IS NULL OR product_line=?)""",
            (tenant_id, frame_color_id, product_line)
        ).fetchall()
        for ov in overrides:
            extra = max(extra, ov["lead_time_weeks"])
            pl_label = ov["product_line"] or "all lines"
            breakdown.append({
                "reason": f"Frame color lead time ({pl_label})",
                "weeks": ov["lead_time_weeks"]
            })

    total = base_weeks + extra
    return {
        "lead_time_weeks": total,
        "base_weeks": base_weeks,
        "color_extra_weeks": extra,
        "breakdown": breakdown
    }


def get_margin_status(margin_pct, margin_floor, yellow_threshold):
    """Thin wrapper — delegates to pricing_engine when available."""
    if _pe is not None:
        return _pe.compute_margin_status(margin_pct, margin_floor, yellow_threshold)
    # Fallback (pricing_engine not installed — should not happen in production)
    if margin_pct >= margin_floor + yellow_threshold:
        return "green"
    elif margin_pct >= margin_floor:
        return "yellow"
    else:
        return "red"


def _update_quote_totals(db, quote_id, tenant_id):
    openings = db.execute(
        "SELECT sell_price, total_cost, discount_pct FROM openings WHERE quote_id=? AND tenant_id=?",
        (quote_id, tenant_id)
    ).fetchall()
    total_price = sum(o["sell_price"] for o in openings)
    total_cost = sum(o["total_cost"] for o in openings)
    margin_dollars = total_price - total_cost
    margin_pct = round((margin_dollars / total_price) * 100, 1) if total_price > 0 else 0
    max_discount_pct = max((_safe_float(o["discount_pct"], 0) for o in openings), default=0.0)

    db.execute(
        """UPDATE quotes SET total_price=?, total_cost=?, margin_pct=?, margin_dollars=?, updated_at=?
           WHERE id=? AND tenant_id=?""",
        (total_price, total_cost, margin_pct, margin_dollars,
         datetime.now().isoformat(), quote_id, tenant_id)
    )
    return {
        "total_price": round(total_price, 2),
        "total_cost": round(total_cost, 2),
        "margin_pct": margin_pct,
        "margin_dollars": round(margin_dollars, 2),
        "max_discount_pct": round(max_discount_pct, 2),
    }


def _build_approval_notification_payload(quote, rep, governance_state, rep_note=""):
    return {
        "event": "approval_required",
        "quote_id": quote["id"],
        "status": "pending_approval",
        "customer_name": quote.get("customer_name"),
        "job_address": quote.get("job_address"),
        "rep": {
            "id": rep.get("id") if rep else quote.get("rep_id"),
            "name": rep.get("name") if rep else None,
            "tier": rep.get("tier") if rep else None,
        },
        "financials": {
            "total_price": round(_safe_float(quote.get("total_price"), 0), 2),
            "total_cost": round(_safe_float(quote.get("total_cost"), 0), 2),
            "margin_pct": round(_safe_float(quote.get("margin_pct"), 0), 1),
            "margin_floor": governance_state.get("margin_floor"),
            "max_discount_pct": governance_state.get("max_discount_pct"),
            "reasons": governance_state.get("reasons", []),
        },
        "rep_note": _sanitize_text_field(rep_note, MAX_APPROVAL_NOTE_LENGTH),
        "created_at": datetime.now().isoformat(),
        "channel": "admin_hub",
    }


def _ensure_pending_approval_request(db, tenant_id, quote_id, rep_id, current_margin, rep_note=""):
    pending = db.execute(
        "SELECT id FROM approval_requests WHERE tenant_id=? AND quote_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
        (tenant_id, quote_id)
    ).fetchone()
    if pending:
        return pending["id"]

    arid = f"ar-{uuid.uuid4().hex[:8]}"
    safe_rep_note = _sanitize_text_field(rep_note or "Auto-generated by governance lock", MAX_APPROVAL_NOTE_LENGTH)

    # Section 4C: enrich approval request with quote totals
    q_row = db.execute("SELECT total_price FROM quotes WHERE id=? AND tenant_id=?", (quote_id, tenant_id)).fetchone()
    oc_row = db.execute("SELECT COUNT(*) as cnt FROM openings WHERE quote_id=? AND tenant_id=?", (quote_id, tenant_id)).fetchone()
    rep_row = db.execute("SELECT tier FROM users WHERE id=? AND tenant_id=?", (rep_id, tenant_id)).fetchone()
    quote_total_price = float(q_row["total_price"] or 0) if q_row else 0.0
    opening_count = int(oc_row["cnt"]) if oc_row else 0
    rep_tier = rep_row["tier"] if rep_row and rep_row["tier"] else None

    db.execute(
        """INSERT INTO approval_requests
           (id,quote_id,tenant_id,rep_id,current_margin,requested_margin,rep_note,status,
            quote_total_price,opening_count,rep_tier,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            arid, quote_id, tenant_id, rep_id, current_margin, current_margin,
            safe_rep_note, "pending", quote_total_price, opening_count, rep_tier,
            datetime.now().isoformat(),
        ),
    )
    return arid


def _enforce_quote_governance_lock(db, tenant_id, quote_id, rep_id=None, rep_note=""):
    quote = db.execute(
        "SELECT * FROM quotes WHERE id=? AND tenant_id=?",
        (quote_id, tenant_id)
    ).fetchone()
    if not quote:
        return {"requires_approval": False, "margin_floor": 30.0, "margin_status": "green"}

    rep_id = rep_id or quote["rep_id"]
    openings = db.execute(
        "SELECT discount_pct FROM openings WHERE quote_id=? AND tenant_id=?",
        (quote_id, tenant_id)
    ).fetchall()
    max_discount = max((_safe_float(o["discount_pct"], 0) for o in openings), default=0.0)
    governance_state = _evaluate_pricing_governance(
        db,
        tenant_id,
        rep_id,
        _safe_float(quote["margin_pct"], 0),
        max_discount,
    )

    rep_row = _get_user_row(db, tenant_id, rep_id)
    payload = _build_approval_notification_payload(dict(quote), dict(rep_row) if rep_row else None, governance_state, rep_note)

    if governance_state["requires_approval"]:
        _ensure_pending_approval_request(
            db,
            tenant_id,
            quote_id,
            rep_id,
            _safe_float(quote["margin_pct"], 0),
            rep_note=rep_note,
        )
        db.execute(
            """UPDATE quotes
               SET status='pending_approval', pending_approval_payload=?, updated_at=?
               WHERE id=? AND tenant_id=?""",
            (json.dumps(payload), datetime.now().isoformat(), quote_id, tenant_id),
        )
    else:
        db.execute(
            """UPDATE quotes
               SET pending_approval_payload=?,
                   status=CASE WHEN status='pending_approval' THEN 'draft' ELSE status END,
                   updated_at=?
               WHERE id=? AND tenant_id=?""",
            (None, datetime.now().isoformat(), quote_id, tenant_id),
        )

    return {
        **governance_state,
        "pending_approval_payload": payload if governance_state["requires_approval"] else None,
    }


def _log_price_change(db, tenant_id, quote_id, opening_id, user_id, user_name, before_price, after_price, extra=None):
    before_price = _safe_float(before_price, 0)
    after_price = _safe_float(after_price, 0)
    if round(before_price, 2) == round(after_price, 2):
        return

    details = {
        "quote_id": quote_id,
        "opening_id": opening_id,
        "before_sell_price": round(before_price, 2),
        "after_sell_price": round(after_price, 2),
    }
    if isinstance(extra, dict):
        details.update(extra)

    audit(
        db,
        tenant_id,
        "price_changed",
        "opening",
        opening_id,
        user_id,
        user_name,
        details,
        rep_id=user_id,
    )


def audit(db, tenant_id, event_type, entity_type, entity_id, user_id, user_name, details, rep_id=None):
    db.execute(
        "INSERT INTO audit_log (id,tenant_id,event_type,entity_type,entity_id,user_id,user_name,rep_id,details) VALUES (?,?,?,?,?,?,?,?,?)",
        (
            f"al-{uuid.uuid4().hex[:8]}",
            tenant_id,
            event_type,
            entity_type,
            entity_id,
            user_id,
            user_name,
            rep_id or user_id,
            json.dumps(details) if not isinstance(details, str) else details,
        )
    )


def _get_tenant(req):
    """Extract tenant_id, user_id, user_name from auth context or legacy request fields."""
    auth_ctx = getattr(g, "auth", None)
    if auth_ctx and auth_ctx.get("user"):
        return auth_ctx["tenant_id"], auth_ctx["user"]["id"], auth_ctx["user"]["name"]

    body = req.get_json(silent=True) or {}
    tenant_id = (req.args.get("tenant_id") or body.get("tenant_id") or "").strip()
    user_id = (req.args.get("user_id") or body.get("user_id") or "").strip()
    user_name = (req.args.get("user_name") or body.get("user_name") or "System").strip() or "System"

    if tenant_id:
        return tenant_id, user_id or "system", user_name

    db = get_db()
    fallback_tenant = db.execute("SELECT id FROM tenants ORDER BY created_at, id LIMIT 1").fetchone()
    fallback_user = None
    if fallback_tenant:
        fallback_user = db.execute(
            """SELECT id, name FROM users
               WHERE tenant_id=? AND active=1
               ORDER BY CASE lower(role)
                 WHEN 'sysop' THEN 0
                 WHEN 'owner' THEN 1
                 WHEN 'manager' THEN 2
                 WHEN 'rep' THEN 3
                 ELSE 4
               END, created_at, id
               LIMIT 1""",
            (fallback_tenant["id"],),
        ).fetchone()

    return (
        fallback_tenant["id"] if fallback_tenant else "",
        user_id or (fallback_user["id"] if fallback_user else "system"),
        user_name or (fallback_user["name"] if fallback_user else "System"),
    )


# ---------------------------------------------------------------------------
# DB INITIALIZATION ? lazy, thread-local flag
# ---------------------------------------------------------------------------

_db_initialized = False
_db_init_lock = threading.Lock()

def ensure_db():
    global _db_initialized
    if _db_initialized:
        return
    with _db_init_lock:
        if _db_initialized:
            return
        init_db()
        _db_initialized = True

def _required_permission_for_request(path, method):
    m = (method or "GET").upper()

    if path.startswith("/api/system/"):
        if path.startswith("/api/system/impersonate/revert"):
            return None
        if path.startswith("/api/system/impersonate"):
            return "can_use_impersonation"
        return "can_manage_feature_flags"

    if path.startswith("/api/feature-flags"):
        return "can_manage_feature_flags"

    if path.startswith("/api/users"):
        return "can_manage_users"

    if path.startswith("/api/products"):
        return "can_view_products" if m == "GET" else "can_manage_products"

    if path.startswith("/api/governance"):
        return "can_view_governance" if m == "GET" else "can_manage_governance"

    if path.startswith("/api/discount-tiers"):
        return "can_view_governance" if m == "GET" else "can_manage_governance"

    if path.startswith("/api/global-settings"):
        return "can_view_governance" if m == "GET" else "can_manage_governance"

    if path.startswith("/api/floor-labor") or path.startswith("/api/territory-multipliers") or path.startswith("/api/product-price-points") or path.startswith("/api/zone-pressure-requirements"):
        return "can_view_governance" if m == "GET" else "can_manage_governance"

    if path.startswith("/api/approvals"):
        if m == "GET":
            return "can_view_approvals"
        if m == "POST":
            return "can_submit_approval_requests"
        return "can_decide_approvals"

    if path.startswith("/api/quotes/") and path.endswith("/submit"):
        return "can_submit_approval_requests"

    if path.startswith("/api/quotes/") and path.endswith("/decide"):
        return "can_decide_approvals"

    if path.startswith("/api/audit-log"):
        return "can_view_audit_log"

    # Mobile API — sessions endpoint is public (handles its own auth via password)
    if path.startswith("/api/mobile/sessions"):
        return None
    # Mobile bundle + sync require field app access
    if path.startswith("/api/mobile"):
        return "can_access_field_app"

    if path.startswith("/api/maps") or path.startswith("/api/property/lookup"):
        return "can_create_quotes"

    if path.startswith("/api/chat-threads"):
        return "can_edit_quotes"

    if path.startswith("/api/stats"):
        return "can_view_dashboard"

    if path.startswith("/api/quotes"):
        if m == "POST":
            return "can_create_quotes"
        return "can_edit_quotes"

    if path.startswith("/api/openings"):
        if m == "DELETE":
            return "can_delete_openings"
        if m in ("PUT", "PATCH"):
            return "can_edit_quotes"
        return "can_edit_quotes"

    if path.startswith("/api/calculate") or path.startswith("/api/validate-") or path.startswith("/api/lead-time") or path.startswith("/api/dp-ratings"):
        return "can_edit_quotes"

    return None


@app.before_request
def before_request():
    ensure_db()

    if request.method == "OPTIONS":
        return None

    if not request.path.startswith("/api"):
        return None

    if re.match(r"^/api/quotes/[^/]+/proposal/snapshot/[^/]+/print$", request.path):
        return None

    public_paths = {"/api/login", "/api/health", "/api/mobile/sessions"}
    public_prefixes = ("/api/public/chat-media/", "/api/webhooks/twilio/", "/p/", "/noa-docs/")
    if request.path in public_paths or any(request.path.startswith(prefix) for prefix in public_prefixes):
        return None

    db = get_db()
    try:
        auth_ctx = _load_auth_context(db, request)
    finally:
        db.close()

    if not auth_ctx:
        if request.path == "/api/logout":
            return None
        return jsonify({"error": "Authentication required"}), 401

    g.auth = auth_ctx

    required_perm = _required_permission_for_request(request.path, request.method)
    if required_perm and not _has_permission_ctx(auth_ctx, required_perm):
        return jsonify({"error": f"Forbidden: missing permission '{required_perm}'"}), 403

    return None


# ---------------------------------------------------------------------------
# STATIC FILE SERVING
# ---------------------------------------------------------------------------

@app.route("/")
def index():
    resp = send_from_directory(STATIC_DIR, "index.html")
    resp.headers["Content-Type"] = "text/html; charset=utf-8"
    return resp

@app.route("/<path:filename>")
def static_files(filename):
    # Serve static files at root level (style.css, app.js, etc.)
    # Don't intercept /api/ routes
    if filename.startswith("api/"):
        abort(404)
    try:
        resp = send_from_directory(STATIC_DIR, filename)
        lower = filename.lower()
        if lower.endswith(".js"):
            resp.headers["Content-Type"] = "application/javascript; charset=utf-8"
        elif lower.endswith(".css"):
            resp.headers["Content-Type"] = "text/css; charset=utf-8"
        elif lower.endswith(".html"):
            resp.headers["Content-Type"] = "text/html; charset=utf-8"
        elif lower.endswith(".json"):
            resp.headers["Content-Type"] = "application/json; charset=utf-8"
        return resp
    except Exception:
        abort(404)


# ---------------------------------------------------------------------------
# PRODUCTS
# ---------------------------------------------------------------------------

_PRODUCT_LINE_LABELS = {
    "prestige": "Prestige",
    "elite": "Elite",
    "multimax": "Multimax",
    "winguard 770": "WinGuard 770",
    "winguard aluminum": "WinGuard Aluminum",
    "storefront 8000": "Storefront 8000",
    "storefront 9000": "Storefront 9000",
}


def _normalize_product_line(value, default="Prestige"):
    """Accept any product line value — normalize known ones, pass through unknowns."""
    raw = (value or "").strip()
    if not raw:
        return default
    # Return the canonical label if known, otherwise pass through as-is (allows any series)
    return _PRODUCT_LINE_LABELS.get(raw.lower(), raw)


def _normalize_manufacturer(value, default="ESWindows"):
    cleaned = _sanitize_text_field(value, 120)
    return cleaned or default


def _coerce_float_or_none(value):
    if value in ("", None):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _coerce_int_or_none(value):
    if value in ("", None):
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _coerce_bool_flag(value):
    if isinstance(value, bool):
        return 1 if value else 0
    if isinstance(value, (int, float)):
        return 1 if value else 0
    return 1 if str(value or "").strip().lower() in ("1", "true", "yes", "on") else 0


def _decorate_products_with_compliance(db, tenant_id, product_rows):
    items = [dict(row) for row in product_rows or []]
    if not items:
        return items

    dp_rows = db.execute(
        """SELECT product_id,dp_positive,dp_negative,max_sqft_for_dp,max_story_height,missile_rating,noa_number,hvhz_approved
           FROM dp_ratings
           WHERE tenant_id=? AND active=1
           ORDER BY product_id, ABS(COALESCE(dp_negative, 0)) DESC, ABS(COALESCE(dp_positive, 0)) DESC, id ASC""",
        (tenant_id,),
    ).fetchall()
    dp_map = {}
    for row in dp_rows:
        pid = row["product_id"]
        if pid not in dp_map:
            dp_map[pid] = dict(row)

    noa_rows = db.execute(
        """SELECT product_id,noa_number,pressure_rating,max_story_height,hvhz_certified
           FROM noa_records
           WHERE tenant_id=? AND active=1
           ORDER BY product_id, COALESCE(pressure_rating, 0) DESC, id ASC""",
        (tenant_id,),
    ).fetchall()
    noa_map = {}
    for row in noa_rows:
        pid = row["product_id"]
        if pid not in noa_map:
            noa_map[pid] = dict(row)

    for item in items:
        dp_row = dp_map.get(item["id"])
        noa_row = noa_map.get(item["id"])
        if dp_row:
            item["dp_positive"] = dp_row["dp_positive"]
            item["dp_negative"] = dp_row["dp_negative"]
            item["dp_max_sqft"] = dp_row["max_sqft_for_dp"]
            item["max_story"] = dp_row["max_story_height"]
            item["missile_rating"] = dp_row["missile_rating"]
            item["hvhz"] = bool(dp_row["hvhz_approved"])
            if dp_row.get("noa_number"):
                item["noa_number"] = dp_row["noa_number"]
        if noa_row:
            item["noa_number"] = item.get("noa_number") or noa_row.get("noa_number")
            item["max_story"] = item.get("max_story") or noa_row.get("max_story_height")
            if "hvhz" not in item:
                item["hvhz"] = bool(noa_row.get("hvhz_certified"))
    return items


def _upsert_product_compliance_records(db, tenant_id, product_id, product_fields, body):
    tracked_keys = {"dp_positive", "dp_negative", "dp_max_sqft", "max_story", "missile_rating", "noa_number", "hvhz"}
    if not tracked_keys.intersection(body.keys()):
        return

    existing_dp = db.execute(
        """SELECT id,dp_positive,dp_negative,max_sqft_for_dp,max_story_height,missile_rating,noa_number,hvhz_approved
           FROM dp_ratings
           WHERE tenant_id=? AND product_id=?
           ORDER BY active DESC, id ASC
           LIMIT 1""",
        (tenant_id, product_id),
    ).fetchone()
    existing_noa = db.execute(
        """SELECT id,noa_number,pressure_rating,max_story_height,hvhz_certified
           FROM noa_records
           WHERE tenant_id=? AND product_id=?
           ORDER BY active DESC, id ASC
           LIMIT 1""",
        (tenant_id, product_id),
    ).fetchone()

    max_width = _coerce_float_or_none(product_fields.get("max_width")) or 192.0
    max_height = _coerce_float_or_none(product_fields.get("max_height")) or 144.0
    dp_positive = _coerce_float_or_none(body.get("dp_positive"))
    dp_negative = _coerce_float_or_none(body.get("dp_negative"))
    max_sqft = _coerce_float_or_none(body.get("dp_max_sqft"))
    max_story = _coerce_int_or_none(body.get("max_story"))
    missile_rating = _sanitize_text_field(body.get("missile_rating"), 80)
    noa_number = _sanitize_text_field(body.get("noa_number"), 120)
    hvhz_flag = _coerce_bool_flag(body.get("hvhz"))

    final_dp_positive = dp_positive if dp_positive is not None else (existing_dp["dp_positive"] if existing_dp else 0)
    final_dp_negative = dp_negative if dp_negative is not None else (
        existing_dp["dp_negative"] if existing_dp and existing_dp["dp_negative"] is not None else final_dp_positive
    )
    final_max_sqft = max_sqft if max_sqft is not None else (
        existing_dp["max_sqft_for_dp"] if existing_dp and existing_dp["max_sqft_for_dp"] is not None else round((max_width * max_height) / 144.0, 1)
    )
    final_max_story = max_story if max_story is not None else (existing_dp["max_story_height"] if existing_dp else 4)
    final_missile = missile_rating or (existing_dp["missile_rating"] if existing_dp else "large")
    final_noa = noa_number or (existing_dp["noa_number"] if existing_dp else "") or (existing_noa["noa_number"] if existing_noa else "")
    final_hvhz = hvhz_flag if "hvhz" in body else (
        existing_dp["hvhz_approved"] if existing_dp else (existing_noa["hvhz_certified"] if existing_noa else 0)
    )

    if existing_dp:
        db.execute(
            """UPDATE dp_ratings
               SET dp_positive=?,dp_negative=?,max_width_for_dp=?,max_height_for_dp=?,max_sqft_for_dp=?,
                   hvhz_approved=?,max_story_height=?,missile_rating=?,noa_number=?,active=1
               WHERE id=? AND tenant_id=?""",
            (
                final_dp_positive,
                final_dp_negative,
                max_width,
                max_height,
                final_max_sqft,
                final_hvhz,
                final_max_story,
                final_missile,
                final_noa or None,
                existing_dp["id"],
                tenant_id,
            ),
        )
    elif any(value not in (None, "", 0) for value in (dp_positive, dp_negative, max_sqft, noa_number)) or "hvhz" in body:
        db.execute(
            """INSERT INTO dp_ratings
               (id,product_id,tenant_id,dp_positive,dp_negative,max_width_for_dp,max_height_for_dp,max_sqft_for_dp,
                hvhz_approved,max_story_height,missile_rating,noa_number,active)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)""",
            (
                f"dp-{uuid.uuid4().hex[:8]}",
                product_id,
                tenant_id,
                final_dp_positive,
                final_dp_negative,
                max_width,
                max_height,
                final_max_sqft,
                final_hvhz,
                final_max_story,
                final_missile,
                final_noa or None,
            ),
        )

    final_pressure = max([value for value in (final_dp_positive, final_dp_negative, existing_noa["pressure_rating"] if existing_noa else None) if value is not None] or [0])
    if existing_noa:
        db.execute(
            """UPDATE noa_records
               SET noa_number=?,pressure_rating=?,max_story_height=?,hvhz_certified=?,active=1
               WHERE id=? AND tenant_id=?""",
            (
                final_noa or existing_noa["noa_number"],
                final_pressure,
                final_max_story,
                final_hvhz,
                existing_noa["id"],
                tenant_id,
            ),
        )
    elif final_noa:
        db.execute(
            """INSERT INTO noa_records
               (id,tenant_id,product_id,noa_number,pressure_rating,max_story_height,hvhz_certified,active)
               VALUES (?,?,?,?,?,?,?,1)""",
            (
                f"noa-{uuid.uuid4().hex[:8]}",
                tenant_id,
                product_id,
                final_noa,
                final_pressure,
                final_max_story,
                final_hvhz,
            ),
        )


@app.route("/api/products", methods=["GET"])
def get_products():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        line_filter = request.args.get("line")
        type_filter = request.args.get("type")
        query = "SELECT * FROM products WHERE tenant_id=? AND active=1"
        vals = [tenant_id]
        if line_filter:
            query += " AND LOWER(product_line)=?"
            vals.append((line_filter or "").strip().lower())
        if type_filter:
            query += " AND type=?"
            vals.append(type_filter)
        query += " ORDER BY manufacturer, product_line, type, name"
        rows = db.execute(query, vals).fetchall()
        return jsonify(_decorate_products_with_compliance(db, tenant_id, rows))
    finally:
        db.close()


@app.route("/api/products/import", methods=["POST"])
def import_products_csv():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx or not auth_ctx.get("user"):
            return jsonify({"error": "Not authenticated"}), 401

        actor_role = _role_normalize(auth_ctx["user"]["role"])
        if actor_role not in ("owner", "manager"):
            return jsonify({"error": "Only owners or managers can import products"}), 403

        tenant_id, user_id, user_name = _get_tenant(request)
        upload = request.files.get("file")
        if not upload or not getattr(upload, "filename", ""):
            return jsonify({"error": "CSV file is required"}), 400

        try:
            csv_text = upload.stream.read().decode("utf-8-sig")
        except Exception:
            return jsonify({"error": "CSV must be UTF-8 encoded"}), 400

        reader = csv.DictReader(io.StringIO(csv_text))
        required_headers = [
            "name", "model_number", "product_line", "manufacturer", "type", "base_cost",
            "min_width", "max_width", "min_height", "max_height",
        ]
        fieldnames = [str(name or "").strip() for name in (reader.fieldnames or [])]
        missing_headers = [header for header in required_headers if header not in fieldnames]
        if missing_headers:
            return jsonify({"error": f"Missing required headers: {', '.join(missing_headers)}"}), 400

        allowed_lines = {"Prestige", "Elite", "Multimax"}
        dry_run = (request.args.get("dry_run") or "").strip().lower() in ("1", "true", "yes", "on")
        valid_rows = []
        error_rows = []

        def parse_number(raw_value, field_name, row_number, default=None):
            text = str(raw_value or "").strip()
            if text == "":
                return default
            try:
                return float(text)
            except ValueError:
                raise ValueError(f"{field_name} must be a number")

        for idx, row in enumerate(reader, start=2):
            raw = {key: (row.get(key) if row else None) for key in required_headers}
            try:
                name = _sanitize_text_field(raw.get("name"), 180)
                model_number = _sanitize_text_field(raw.get("model_number"), 120)
                product_line = _normalize_product_line(raw.get("product_line"), default="")
                manufacturer = _normalize_manufacturer(raw.get("manufacturer"), default="")
                opening_type = _sanitize_text_field(raw.get("type"), 80)
                base_cost = parse_number(raw.get("base_cost"), "base_cost", idx, default=None)
                min_width = parse_number(raw.get("min_width"), "min_width", idx, default=12.0)
                max_width = parse_number(raw.get("max_width"), "max_width", idx, default=192.0)
                min_height = parse_number(raw.get("min_height"), "min_height", idx, default=12.0)
                max_height = parse_number(raw.get("max_height"), "max_height", idx, default=144.0)

                if not name:
                    raise ValueError("name is required")
                if not model_number:
                    raise ValueError("model_number is required")
                if product_line not in allowed_lines:
                    raise ValueError("product_line must be Prestige, Elite, or Multimax")
                if not manufacturer:
                    raise ValueError("manufacturer is required")
                if not opening_type:
                    raise ValueError("type is required")
                if base_cost is None or base_cost < 0:
                    raise ValueError("base_cost must be 0 or greater")
                if min_width is None or max_width is None or min_height is None or max_height is None:
                    raise ValueError("all size columns must be valid numbers")
                if min_width <= 0 or max_width <= 0 or min_height <= 0 or max_height <= 0:
                    raise ValueError("size limits must be greater than 0")
                if min_width > max_width or min_height > max_height:
                    raise ValueError("min size cannot exceed max size")

                valid_rows.append(
                    {
                        "name": name,
                        "model_number": model_number,
                        "product_line": product_line,
                        "manufacturer": manufacturer,
                        "type": opening_type,
                        "base_cost": round(float(base_cost), 2),
                        "min_width": round(float(min_width), 2),
                        "max_width": round(float(max_width), 2),
                        "min_height": round(float(min_height), 2),
                        "max_height": round(float(max_height), 2),
                        "row_number": idx,
                    }
                )
            except ValueError as exc:
                error_rows.append({"row": idx, "error": str(exc), "data": raw})

        if dry_run:
            return jsonify(
                {
                    "valid_count": len(valid_rows),
                    "error_rows": error_rows,
                    "preview": valid_rows[:5],
                }
            )

        imported = 0
        insert_errors = list(error_rows)
        for item in valid_rows:
            product_id = f"p-{uuid.uuid4().hex[:8]}"
            try:
                db.execute(
                    """INSERT INTO products
                       (id,tenant_id,name,model_number,product_line,manufacturer,type,
                        base_cost,size_multiplier_per_sqft,min_width,max_width,min_height,max_height,
                        frame_depth,lead_time_weeks,active)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""",
                    (
                        product_id,
                        tenant_id,
                        item["name"],
                        item["model_number"],
                        item["product_line"],
                        item["manufacturer"],
                        item["type"],
                        item["base_cost"],
                        0,
                        item["min_width"],
                        item["max_width"],
                        item["min_height"],
                        item["max_height"],
                        None,
                        4,
                    ),
                )
                _upsert_product_compliance_records(
                    db,
                    tenant_id,
                    product_id,
                    {"max_width": item["max_width"], "max_height": item["max_height"]},
                    item,
                )
                imported += 1
            except Exception as exc:
                insert_errors.append({"row": item["row_number"], "error": str(exc), "data": item})

        audit(
            db,
            tenant_id,
            "catalog_import",
            "product",
            "catalog_import",
            user_id,
            user_name,
            {"imported": imported, "skipped": len(insert_errors), "errors": len(insert_errors)},
            rep_id=user_id,
        )
        db.commit()
        return jsonify({"imported": imported, "skipped": len(insert_errors), "errors": insert_errors})
    finally:
        db.close()


@app.route("/api/products", methods=["POST"])
def create_product():
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True)
        pid = f"p-{uuid.uuid4().hex[:8]}"
        product_line = _normalize_product_line(body.get("product_line"))
        manufacturer = _normalize_manufacturer(body.get("manufacturer"))
        product_fields = {
            "max_width": body.get("max_width", 192),
            "max_height": body.get("max_height", 144),
        }
        db.execute("""INSERT INTO products
            (id,tenant_id,name,model_number,product_line,manufacturer,type,
             base_cost,size_multiplier_per_sqft,min_width,max_width,min_height,max_height,
             frame_depth,lead_time_weeks,active)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)""", (
            pid, tenant_id,
            body["name"], body.get("model_number", ""), product_line,
            manufacturer, body["type"],
            body["base_cost"], body.get("size_multiplier_per_sqft", 0),
            body.get("min_width", 12), body.get("max_width", 192),
            body.get("min_height", 12), body.get("max_height", 144),
            body.get("frame_depth"), body.get("lead_time_weeks", 4)
        ))
        product_fields.update(
            {
                "max_width": body.get("max_width", 192),
                "max_height": body.get("max_height", 144),
            }
        )
        _upsert_product_compliance_records(db, tenant_id, pid, product_fields, body)
        db.commit()
        audit(db, tenant_id, "product_created", "product", pid, user_id, user_name,
              {"name": body["name"], "model_number": body.get("model_number", ""), "manufacturer": manufacturer})
        db.commit()
        return jsonify({"id": pid, "status": "created"}), 201
    finally:
        db.close()


@app.route("/api/products/<pid>", methods=["PUT"])
def update_product(pid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True)
        auth_ctx = getattr(g, "auth", None)
        current = _load_product_row_any_tenant(db, pid)
        if not current:
            return jsonify({"error": "Product not found"}), 404
        _assert_tenant_match(current, auth_ctx, "Product")
        tenant_id = current["tenant_id"]

        current_fields = dict(current)
        allowed = ["name", "model_number", "product_line", "manufacturer", "type",
                   "base_cost", "size_multiplier_per_sqft", "min_width", "max_width",
                   "min_height", "max_height", "frame_depth", "lead_time_weeks", "active"]
        sets, vals = [], []
        for k in allowed:
            if k in body:
                value = body[k]
                if k == "product_line":
                    value = _normalize_product_line(value, default=current_fields.get("product_line") or "Prestige")
                elif k == "manufacturer":
                    value = _normalize_manufacturer(value, default=current_fields.get("manufacturer") or "ESWindows")
                sets.append(f"{k}=?")
                vals.append(value)
                current_fields[k] = value
        if sets:
            vals.extend([pid, tenant_id])
            db.execute(f"UPDATE products SET {','.join(sets)} WHERE id=? AND tenant_id=?", vals)
        _upsert_product_compliance_records(db, tenant_id, pid, current_fields, body)
        db.commit()
        audit(db, tenant_id, "product_updated", "product", pid, user_id, user_name, body)
        db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


@app.route("/api/products/<pid>", methods=["DELETE"])
def delete_product(pid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        current = _load_product_row_any_tenant(db, pid)
        if not current:
            return jsonify({"error": "Product not found"}), 404
        _assert_tenant_match(current, auth_ctx, "Product")
        tenant_id = current["tenant_id"]
        db.execute("UPDATE products SET active=0 WHERE id=? AND tenant_id=?", (pid, tenant_id))
        db.commit()
        audit(db, tenant_id, "product_deleted", "product", pid, user_id, user_name, {})
        db.commit()
        return jsonify({"status": "deleted"})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# GLASS OPTIONS
# ---------------------------------------------------------------------------

@app.route("/api/glass-options", methods=["GET"])
def get_glass_options():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM glass_options WHERE tenant_id=? AND active=1 ORDER BY cost_adder",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/glass-options", methods=["POST"])
def create_glass_option():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        gid = f"g-{uuid.uuid4().hex[:8]}"
        db.execute("INSERT INTO glass_options VALUES (?,?,?,?,1)",
                   (gid, tenant_id, body["name"], body.get("cost_adder", 0)))
        db.commit()
        return jsonify({"id": gid, "status": "created"}), 201
    finally:
        db.close()


@app.route("/api/glass-options/<gid>", methods=["PUT"])
def update_glass_option(gid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        sets, vals = [], []
        for k in ["name", "cost_adder", "active"]:
            if k in body:
                sets.append(f"{k}=?")
                vals.append(body[k])
        if sets:
            vals.extend([gid, tenant_id])
            db.execute(f"UPDATE glass_options SET {','.join(sets)} WHERE id=? AND tenant_id=?", vals)
            db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


@app.route("/api/glass-options/<gid>", methods=["DELETE"])
def delete_glass_option(gid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        db.execute("UPDATE glass_options SET active=0 WHERE id=? AND tenant_id=?", (gid, tenant_id))
        db.commit()
        return jsonify({"status": "deleted"})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# FRAME COLORS
# ---------------------------------------------------------------------------

@app.route("/api/frame-colors", methods=["GET"])
def get_frame_colors():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM frame_colors WHERE tenant_id=? AND active=1 ORDER BY cost_adder",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/frame-colors", methods=["POST"])
def create_frame_color():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        fid = f"fc-{uuid.uuid4().hex[:8]}"
        db.execute("INSERT INTO frame_colors VALUES (?,?,?,?,1)",
                   (fid, tenant_id, body["name"], body.get("cost_adder", 0)))
        db.commit()
        return jsonify({"id": fid, "status": "created"}), 201
    finally:
        db.close()


@app.route("/api/frame-colors/<fid>", methods=["PUT"])
def update_frame_color(fid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        sets, vals = [], []
        for k in ["name", "cost_adder", "active"]:
            if k in body:
                sets.append(f"{k}=?")
                vals.append(body[k])
        if sets:
            vals.extend([fid, tenant_id])
            db.execute(f"UPDATE frame_colors SET {','.join(sets)} WHERE id=? AND tenant_id=?", vals)
            db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


@app.route("/api/frame-colors/<fid>", methods=["DELETE"])
def delete_frame_color(fid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        db.execute("UPDATE frame_colors SET active=0 WHERE id=? AND tenant_id=?", (fid, tenant_id))
        db.commit()
        return jsonify({"status": "deleted"})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# COMPLEXITY ITEMS
# ---------------------------------------------------------------------------

@app.route("/api/complexity-items", methods=["GET"])
def get_complexity_items():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM complexity_items WHERE tenant_id=? AND active=1 ORDER BY cost",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/complexity-items", methods=["POST"])
def create_complexity_item():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        cid = f"cx-{uuid.uuid4().hex[:8]}"
        db.execute("INSERT INTO complexity_items VALUES (?,?,?,?,1)",
                   (cid, tenant_id, body["name"], body["cost"]))
        db.commit()
        return jsonify({"id": cid, "status": "created"}), 201
    finally:
        db.close()


@app.route("/api/complexity-items/<cid>", methods=["PUT"])
def update_complexity_item(cid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        sets, vals = [], []
        for k in ["name", "cost", "active"]:
            if k in body:
                sets.append(f"{k}=?")
                vals.append(body[k])
        if sets:
            vals.extend([cid, tenant_id])
            db.execute(f"UPDATE complexity_items SET {','.join(sets)} WHERE id=? AND tenant_id=?", vals)
            db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


@app.route("/api/complexity-items/<cid>", methods=["DELETE"])
def delete_complexity_item(cid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        db.execute("UPDATE complexity_items SET active=0 WHERE id=? AND tenant_id=?", (cid, tenant_id))
        db.commit()
        return jsonify({"status": "deleted"})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# CONSUMABLES
# ---------------------------------------------------------------------------

@app.route("/api/consumables", methods=["GET"])
def get_consumables():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM consumables WHERE tenant_id=? AND active=1 ORDER BY name",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/consumables", methods=["POST"])
def create_consumable():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        cid = f"cons-{uuid.uuid4().hex[:8]}"
        db.execute("""INSERT INTO consumables
            (id,tenant_id,name,unit_cost,unit,wall_type_filter,min_openings,active)
            VALUES (?,?,?,?,?,?,?,1)""", (
            cid, tenant_id, body["name"], body["unit_cost"],
            body.get("unit", "per_opening"),
            body.get("wall_type_filter"),
            body.get("min_openings", 0)
        ))
        db.commit()
        return jsonify({"id": cid, "status": "created"}), 201
    finally:
        db.close()


@app.route("/api/consumables/<cid>", methods=["PUT"])
def update_consumable(cid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        allowed = ["name", "unit_cost", "unit", "wall_type_filter", "min_openings", "active"]
        sets, vals = [], []
        for k in allowed:
            if k in body:
                sets.append(f"{k}=?")
                vals.append(body[k])
        if sets:
            vals.extend([cid, tenant_id])
            db.execute(f"UPDATE consumables SET {','.join(sets)} WHERE id=? AND tenant_id=?", vals)
            db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


@app.route("/api/consumables/<cid>", methods=["DELETE"])
def delete_consumable(cid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        db.execute("UPDATE consumables SET active=0 WHERE id=? AND tenant_id=?", (cid, tenant_id))
        db.commit()
        return jsonify({"status": "deleted"})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# ASSEMBLY TEMPLATES
# ---------------------------------------------------------------------------

@app.route("/api/assembly-templates", methods=["GET"])
def get_assembly_templates():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM assembly_templates WHERE tenant_id=? AND active=1 ORDER BY name",
            (tenant_id,)
        ).fetchall()
        result = []
        for r in rows:
            row = dict(r)
            try:
                row["default_types"] = json.loads(row["default_types"] or "[]")
            except Exception:
                pass
            result.append(row)
        return jsonify(result)
    finally:
        db.close()


@app.route("/api/assembly-templates", methods=["POST"])
def create_assembly_template():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        tid = f"at-{uuid.uuid4().hex[:8]}"
        default_types = body.get("default_types", [])
        if isinstance(default_types, list):
            default_types = json.dumps(default_types)
        db.execute("""INSERT INTO assembly_templates
            (id,tenant_id,name,layout_type,panel_count,description,default_types,active)
            VALUES (?,?,?,?,?,?,?,1)""", (
            tid, tenant_id, body["name"], body["layout_type"],
            body["panel_count"], body.get("description", ""), default_types
        ))
        db.commit()
        return jsonify({"id": tid, "status": "created"}), 201
    finally:
        db.close()


@app.route("/api/assembly-templates/<tid>", methods=["PUT"])
def update_assembly_template(tid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True)
        allowed = ["name", "layout_type", "panel_count", "description", "default_types", "active"]
        sets, vals = [], []
        for k in allowed:
            if k in body:
                v = body[k]
                if k == "default_types" and isinstance(v, list):
                    v = json.dumps(v)
                sets.append(f"{k}=?")
                vals.append(v)
        if sets:
            vals.extend([tid, tenant_id])
            db.execute(f"UPDATE assembly_templates SET {','.join(sets)} WHERE id=? AND tenant_id=?", vals)
            db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


@app.route("/api/assembly-templates/<tid>", methods=["DELETE"])
def delete_assembly_template(tid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        db.execute("UPDATE assembly_templates SET active=0 WHERE id=? AND tenant_id=?", (tid, tenant_id))
        db.commit()
        return jsonify({"status": "deleted"})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# DP RATINGS
# ---------------------------------------------------------------------------

@app.route("/api/dp-ratings", methods=["GET"])
def get_dp_ratings():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        product_id = request.args.get("product_id")
        if product_id:
            rows = db.execute(
                "SELECT * FROM dp_ratings WHERE tenant_id=? AND product_id=? AND active=1",
                (tenant_id, product_id)
            ).fetchall()
        else:
            rows = db.execute(
                """SELECT dp.*, p.name as product_name, p.model_number, p.product_line
                   FROM dp_ratings dp
                   JOIN products p ON dp.product_id=p.id
                   WHERE dp.tenant_id=? AND dp.active=1
                   ORDER BY p.product_line, p.name""",
                (tenant_id,)
            ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


# ---------------------------------------------------------------------------
# GLOBAL SETTINGS
# ---------------------------------------------------------------------------

@app.route("/api/global-settings", methods=["GET"])
def get_global_settings():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM global_settings WHERE tenant_id=? ORDER BY setting_key",
            (tenant_id,)
        ).fetchall()
        data = {}
        for r in rows:
            data[r["setting_key"]] = r["setting_value"]
        return jsonify(data)
    finally:
        db.close()


@app.route("/api/global-settings", methods=["PUT"])
def update_global_settings():
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        now = datetime.now().isoformat()

        def upsert_setting(key, value):
            db.execute(
                """INSERT INTO global_settings (id,tenant_id,setting_key,setting_value,updated_at)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(tenant_id,setting_key)
                   DO UPDATE SET setting_value=excluded.setting_value, updated_at=excluded.updated_at""",
                (f"gs-{uuid.uuid4().hex[:8]}", tenant_id, key, str(value), now),
            )

        settings = body.get("settings")
        if isinstance(settings, list):
            for s in settings:
                upsert_setting(s["key"], s.get("value", ""))
        elif isinstance(body, dict) and "key" in body:
            upsert_setting(body["key"], body.get("value", ""))
        elif isinstance(body, dict):
            ignored = {"tenant_id", "user_id", "user_name", "settings"}
            for key, value in body.items():
                if key in ignored:
                    continue
                upsert_setting(key, value)

        db.commit()
        audit(db, tenant_id, "global_settings_updated", "settings", "global", user_id, user_name, body, rep_id=user_id)
        db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# LEAD TIME OVERRIDES
# ---------------------------------------------------------------------------

@app.route("/api/lead-time-overrides", methods=["GET"])
def get_lead_time_overrides():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            """SELECT lt.*, fc.name as color_name
               FROM lead_time_overrides lt
               LEFT JOIN frame_colors fc ON lt.frame_color_id=fc.id
               WHERE lt.tenant_id=? AND lt.active=1
               ORDER BY lt.lead_time_weeks DESC""",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/lead-time", methods=["GET"])
def get_lead_time():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        product_id = request.args.get("product_id")
        frame_color_id = request.args.get("frame_color_id")
        if not product_id:
            return jsonify({"error": "product_id required"}), 400
        lt = calculate_lead_time(db, tenant_id, product_id, frame_color_id)
        return jsonify({
            **lt,
            "estimated_weeks": lt.get("lead_time_weeks", 4),
            "display": f"{lt.get('lead_time_weeks', 4)} wks",
        })
    finally:
        db.close()


@app.route("/api/validate-dp", methods=["POST"])
def api_validate_dp():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True) or {}

        product_id = body.get("product_id")
        if not product_id:
            return jsonify({"error": "product_id required"}), 400

        width = body.get("width", 48)
        height = body.get("height", 60)
        required_zone = _resolve_required_zone(db, tenant_id, body.get("required_zone"))
        result = validate_dp(
            db,
            tenant_id,
            product_id,
            width,
            height,
            body.get("floor_level", 1),
            body.get("hvhz"),
            required_zone=required_zone,
        )
        # NOA/DP is warning-first in field flow; return 200 with status payload.
        return jsonify(result)
    finally:
        db.close()


@app.route("/api/validate-noa", methods=["POST"])
def api_validate_noa():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        body = request.get_json(force=True) or {}

        product_id = body.get("product_id")
        if not product_id:
            return jsonify({"error": "product_id required"}), 400

        required_zone = _resolve_required_zone(db, tenant_id, body.get("required_zone"))
        result = validate_dp(
            db,
            tenant_id,
            product_id,
            body.get("width", 48),
            body.get("height", 60),
            body.get("floor_level", 1),
            body.get("hvhz"),
            required_zone=required_zone,
        )
        return jsonify({
            "status": result.get("status"),
            "noa_number": result.get("noa_number"),
            "pressure_rating": result.get("dp_negative"),
            "reason": result.get("failure_reason"),
            "dp_positive": result.get("dp_positive"),
            "dp_negative": result.get("dp_negative"),
            "zone": result.get("zone"),
            "required_dp": result.get("required_dp"),
        })
    finally:
        db.close()


@app.route("/api/floor-labor", methods=["GET"])
def get_floor_labor():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM floor_labor WHERE tenant_id=? ORDER BY floor_level",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/floor-labor", methods=["PUT"])
def update_floor_labor():
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        items = body.get("items") if isinstance(body.get("items"), list) else [body]
        for item in items:
            if not item.get("id"):
                continue
            db.execute(
                "UPDATE floor_labor SET labor_adder=? WHERE id=? AND tenant_id=?",
                (_safe_float(item.get("labor_adder"), 0), item["id"], tenant_id)
            )
        db.commit()
        audit(db, tenant_id, "floor_labor_updated", "settings", "floor_labor", user_id, user_name, body, rep_id=user_id)
        db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


@app.route("/api/territory-multipliers", methods=["GET"])
def get_territory_multipliers():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM territory_multipliers WHERE tenant_id=? ORDER BY zip_code",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/territory-multipliers", methods=["POST"])
def create_territory_multiplier():
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        tid = f"tm-{uuid.uuid4().hex[:8]}"
        db.execute(
            "INSERT INTO territory_multipliers (id,tenant_id,zip_code,multiplier) VALUES (?,?,?,?)",
            (tid, tenant_id, body.get("zip_code"), _safe_float(body.get("multiplier"), 1.0))
        )
        db.commit()
        audit(db, tenant_id, "territory_multiplier_created", "settings", tid, user_id, user_name, body, rep_id=user_id)
        db.commit()
        return jsonify({"id": tid, "status": "created"}), 201
    finally:
        db.close()


@app.route("/api/product-price-points", methods=["GET"])
def get_product_price_points():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        product_id = request.args.get("product_id")
        query = "SELECT * FROM product_price_points WHERE tenant_id=? AND active=1"
        vals = [tenant_id]
        if product_id:
            query += " AND product_id=?"
            vals.append(product_id)
        query += " ORDER BY product_id, width, height"
        rows = db.execute(query, vals).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/product-price-points", methods=["POST"])
def upsert_product_price_points():
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        rows = body.get("points") if isinstance(body.get("points"), list) else [body]
        created = []
        for row in rows:
            if not row.get("product_id"):
                continue
            pid = f"pp-{uuid.uuid4().hex[:8]}"
            db.execute(
                """INSERT INTO product_price_points (id,tenant_id,product_id,width,height,price,active)
                   VALUES (?,?,?,?,?,?,1)
                   ON CONFLICT(tenant_id, product_id, width, height)
                   DO UPDATE SET price=excluded.price, active=1""",
                (
                    pid,
                    tenant_id,
                    row["product_id"],
                    _safe_float(row.get("width"), 0),
                    _safe_float(row.get("height"), 0),
                    _safe_float(row.get("price"), 0),
                ),
            )
            created.append({"product_id": row["product_id"], "width": row.get("width"), "height": row.get("height")})

        db.commit()
        audit(db, tenant_id, "price_points_upserted", "settings", "product_price_points", user_id, user_name, {"rows": created}, rep_id=user_id)
        db.commit()
        return jsonify({"status": "updated", "count": len(created)})
    finally:
        db.close()


@app.route("/api/zone-pressure-requirements", methods=["GET"])
def get_zone_pressure_requirements():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM zone_pressure_requirements WHERE tenant_id=? AND active=1 ORDER BY zone_code",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/zone-pressure-requirements", methods=["PUT"])
def upsert_zone_pressure_requirements():
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        rows = body.get("items") if isinstance(body.get("items"), list) else [body]
        for row in rows:
            if not row.get("zone_code"):
                continue
            zid = f"zone-{uuid.uuid4().hex[:8]}"
            db.execute(
                """INSERT INTO zone_pressure_requirements
                   (id,tenant_id,zone_code,required_dp,hvhz_required,max_story_height,active)
                   VALUES (?,?,?,?,?,?,1)
                   ON CONFLICT(tenant_id, zone_code)
                   DO UPDATE SET required_dp=excluded.required_dp,
                                 hvhz_required=excluded.hvhz_required,
                                 max_story_height=excluded.max_story_height,
                                 active=1""",
                (
                    zid,
                    tenant_id,
                    row["zone_code"].upper(),
                    _safe_float(row.get("required_dp"), 0),
                    int(row.get("hvhz_required", 0)),
                    int(_safe_float(row.get("max_story_height"), 10)),
                ),
            )
        db.commit()
        audit(db, tenant_id, "zone_requirements_updated", "settings", "zone_pressure_requirements", user_id, user_name, body, rep_id=user_id)
        db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# GOVERNANCE
# ---------------------------------------------------------------------------

@app.route("/api/governance", methods=["GET"])
def get_governance():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM governance_settings WHERE tenant_id=? ORDER BY tier",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/governance", methods=["PUT"])
def update_governance():
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        settings_list = body.get("settings")
        if not isinstance(settings_list, list):
            settings_list = [body]

        strict_noa_enforcement = None
        if "strict_noa_enforcement" in body:
            strict_noa_enforcement = 1 if body.get("strict_noa_enforcement") else 0

        for setting in settings_list:
            tier = setting.get("tier")
            if not tier:
                continue

            existing = db.execute(
                "SELECT id, strict_noa_enforcement FROM governance_settings WHERE tenant_id=? AND tier=?",
                (tenant_id, tier)
            ).fetchone()
            rid = existing["id"] if existing else f"gov-{uuid.uuid4().hex[:8]}"
            strict_flag = strict_noa_enforcement
            if strict_flag is None:
                if "strict_noa_enforcement" in setting:
                    strict_flag = 1 if setting.get("strict_noa_enforcement") else 0
                elif existing:
                    strict_flag = 1 if existing["strict_noa_enforcement"] else 0
                else:
                    strict_flag = 0

            if existing:
                db.execute(
                    """UPDATE governance_settings
                       SET margin_floor=?, yellow_threshold=?, discount_approval_required=?, max_discount_pct=?, strict_noa_enforcement=?, updated_at=?
                       WHERE id=? AND tenant_id=?""",
                    (
                        _safe_float(setting.get("margin_floor"), 30.0),
                        _safe_float(setting.get("yellow_threshold"), 3.0),
                        int(setting.get("discount_approval_required", 1)),
                        _safe_float(setting.get("max_discount_pct"), 5.0),
                        strict_flag,
                        datetime.now().isoformat(),
                        rid,
                        tenant_id,
                    ),
                )
            else:
                db.execute(
                    """INSERT INTO governance_settings
                       (id,tenant_id,tier,margin_floor,yellow_threshold,discount_approval_required,max_discount_pct,strict_noa_enforcement,updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?)""",
                    (
                        rid,
                        tenant_id,
                        tier,
                        _safe_float(setting.get("margin_floor"), 30.0),
                        _safe_float(setting.get("yellow_threshold"), 3.0),
                        int(setting.get("discount_approval_required", 1)),
                        _safe_float(setting.get("max_discount_pct"), 5.0),
                        strict_flag,
                        datetime.now().isoformat(),
                    ),
                )

        db.commit()
        audit(db, tenant_id, "governance_updated", "settings", "batch", user_id, user_name, body, rep_id=user_id)
        db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


@app.route("/api/governance/overrides", methods=["GET"])
def list_governance_overrides():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx or not auth_ctx.get("user"):
            return jsonify({"error": "Not authenticated"}), 401

        actor_role = _role_normalize(auth_ctx["user"]["role"])
        if actor_role not in ("owner", "manager", "sysop"):
            return jsonify({"error": "Only owners or managers can view overrides"}), 403

        tenant_id, _, _ = _get_tenant(request)
        return jsonify(_list_governance_overrides(db, tenant_id, active_only=True))
    finally:
        db.close()


@app.route("/api/governance/overrides", methods=["POST"])
def create_governance_override():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx or not auth_ctx.get("user"):
            return jsonify({"error": "Not authenticated"}), 401

        actor_role = _role_normalize(auth_ctx["user"]["role"])
        if actor_role not in ("owner", "sysop"):
            return jsonify({"error": "Only owners can create overrides"}), 403

        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        target_user_id = _sanitize_text_field(body.get("user_id"), 80)
        override_value = _safe_float(body.get("override_value"), None)
        if not target_user_id:
            return jsonify({"error": "user_id is required"}), 400
        if override_value is None:
            return jsonify({"error": "override_value must be numeric"}), 400
        if override_value < 0:
            return jsonify({"error": "override_value must be 0 or greater"}), 400

        try:
            override_type = _normalize_governance_override_type(body.get("override_type"))
            expires_at = _normalize_optional_expiry(body.get("expires_at"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        target_user = _get_user_row(db, tenant_id, target_user_id)
        if not target_user:
            return jsonify({"error": "User not found for this tenant"}), 404

        override_id = f"govovr-{uuid.uuid4().hex[:8]}"
        db.execute(
            """UPDATE governance_overrides
                  SET active=0
                WHERE tenant_id=? AND user_id=? AND override_type=? AND active=1""",
            (tenant_id, target_user_id, override_type),
        )
        db.execute(
            """INSERT INTO governance_overrides
               (id, tenant_id, user_id, override_type, override_value, granted_by, expires_at, active)
               VALUES (?,?,?,?,?,?,?,1)""",
            (
                override_id,
                tenant_id,
                target_user_id,
                override_type,
                round(float(override_value), 2),
                user_id,
                expires_at,
            ),
        )

        audit(
            db,
            tenant_id,
            "governance_override_created",
            "governance_override",
            override_id,
            user_id,
            user_name,
            {
                "user_id": target_user_id,
                "user_name": target_user["name"],
                "override_type": override_type,
                "override_value": round(float(override_value), 2),
                "expires_at": expires_at,
            },
            rep_id=user_id,
        )
        db.commit()

        created = _list_governance_overrides(db, tenant_id, user_id=target_user_id, active_only=True)
        created_row = next((row for row in created if row["id"] == override_id), None)
        return jsonify(created_row or {"id": override_id, "status": "created"}), 201
    finally:
        db.close()


@app.route("/api/governance/overrides/<override_id>", methods=["DELETE"])
def revoke_governance_override(override_id):
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx or not auth_ctx.get("user"):
            return jsonify({"error": "Not authenticated"}), 401

        actor_role = _role_normalize(auth_ctx["user"]["role"])
        if actor_role not in ("owner", "sysop"):
            return jsonify({"error": "Only owners can revoke overrides"}), 403

        tenant_id, user_id, user_name = _get_tenant(request)
        existing = db.execute(
            """SELECT go.*, u.name AS user_name
                 FROM governance_overrides go
                 LEFT JOIN users u
                   ON u.id=go.user_id AND u.tenant_id=go.tenant_id
                WHERE go.id=? AND go.tenant_id=?""",
            (override_id, tenant_id),
        ).fetchone()
        if not existing:
            return jsonify({"error": "Override not found"}), 404

        db.execute(
            "UPDATE governance_overrides SET active=0 WHERE id=? AND tenant_id=?",
            (override_id, tenant_id),
        )
        audit(
            db,
            tenant_id,
            "governance_override_revoked",
            "governance_override",
            override_id,
            user_id,
            user_name,
            {
                "user_id": existing["user_id"],
                "user_name": existing["user_name"],
                "override_type": existing["override_type"],
            },
            rep_id=user_id,
        )
        db.commit()
        return jsonify({"status": "revoked", "id": override_id})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# DISCOUNT TIERS (Tier 4)
# ---------------------------------------------------------------------------

@app.route("/api/discount-tiers", methods=["GET"])
def get_discount_tiers():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM discount_tiers WHERE tenant_id=? ORDER BY min_job_total ASC",
            (tenant_id,)
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/discount-tiers", methods=["POST"])
def create_discount_tier():
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        label = body.get("label", "").strip()
        min_total = _safe_float(body.get("min_job_total"), 0)
        max_total = body.get("max_job_total")
        if max_total is not None:
            max_total = _safe_float(max_total, None)
        max_discount = _safe_float(body.get("max_discount_pct"), 0)

        if not label:
            return jsonify({"error": "label required"}), 400

        tier_id = str(uuid.uuid4())
        now = datetime.now().isoformat()

        db.execute("""
            INSERT INTO discount_tiers
            (id, tenant_id, label, min_job_total, max_job_total, max_discount_pct, active, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
        """, (tier_id, tenant_id, label, min_total, max_total, max_discount, now, now))
        audit(db, tenant_id, "discount_tier_created", "discount_tier", tier_id, user_id, user_name, body, rep_id=user_id)
        db.commit()

        tier = db.execute("SELECT * FROM discount_tiers WHERE id=?", (tier_id,)).fetchone()
        return jsonify(dict(tier)), 201
    finally:
        db.close()


@app.route("/api/discount-tiers/<tid>", methods=["PUT"])
def update_discount_tier(tid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        existing = db.execute(
            "SELECT * FROM discount_tiers WHERE id=? AND tenant_id=?",
            (tid, tenant_id)
        ).fetchone()
        if not existing:
            return jsonify({"error": "Tier not found"}), 404

        body = request.get_json(force=True) or {}
        label = body.get("label", existing["label"]).strip()
        min_total = _safe_float(body.get("min_job_total", existing["min_job_total"]), 0)
        max_total = body.get("max_job_total", existing["max_job_total"])
        if max_total is not None:
            max_total = _safe_float(max_total, None)
        max_discount = _safe_float(body.get("max_discount_pct", existing["max_discount_pct"]), 0)
        active = body.get("active", existing["active"])

        now = datetime.now().isoformat()
        db.execute("""
            UPDATE discount_tiers
            SET label=?, min_job_total=?, max_job_total=?, max_discount_pct=?, active=?, updated_at=?
            WHERE id=? AND tenant_id=?
        """, (label, min_total, max_total, max_discount, active, now, tid, tenant_id))
        audit(db, tenant_id, "discount_tier_updated", "discount_tier", tid, user_id, user_name, body, rep_id=user_id)
        db.commit()

        tier = db.execute("SELECT * FROM discount_tiers WHERE id=?", (tid,)).fetchone()
        return jsonify(dict(tier))
    finally:
        db.close()


@app.route("/api/discount-tiers/<tid>", methods=["DELETE"])
def delete_discount_tier(tid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        existing = db.execute(
            "SELECT * FROM discount_tiers WHERE id=? AND tenant_id=?",
            (tid, tenant_id)
        ).fetchone()
        if not existing:
            return jsonify({"error": "Tier not found"}), 404

        db.execute("DELETE FROM discount_tiers WHERE id=? AND tenant_id=?", (tid, tenant_id))
        audit(db, tenant_id, "discount_tier_deleted", "discount_tier", tid, user_id, user_name, {}, rep_id=user_id)
        db.commit()
        return jsonify({"status": "deleted", "id": tid})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# STATS
# ---------------------------------------------------------------------------

@app.route("/api/stats", methods=["GET"])
def get_stats():
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        can_view_all = _has_permission_ctx(auth_ctx, "can_view_all_quotes")
        can_view_margins = _has_permission_ctx(auth_ctx, "can_view_margins")

        quote_where = "tenant_id=?"
        quote_vals = [tenant_id]
        if not can_view_all:
            quote_where += " AND rep_id=?"
            quote_vals.append(user_id)

        total_quotes = db.execute(
            f"SELECT COUNT(*) FROM quotes WHERE {quote_where}", quote_vals
        ).fetchone()[0]
        active_quotes = db.execute(
            f"SELECT COUNT(*) FROM quotes WHERE {quote_where} AND status IN ('draft','pending_approval')",
            quote_vals,
        ).fetchone()[0]
        completed_quotes = db.execute(
            f"SELECT COUNT(*) FROM quotes WHERE {quote_where} AND status='completed'",
            quote_vals,
        ).fetchone()[0]

        if can_view_all:
            pending_approvals = db.execute(
                "SELECT COUNT(*) FROM approval_requests WHERE tenant_id=? AND status='pending'",
                (tenant_id,),
            ).fetchone()[0]
        else:
            pending_approvals = db.execute(
                "SELECT COUNT(*) FROM approval_requests WHERE tenant_id=? AND rep_id=? AND status='pending'",
                (tenant_id, user_id),
            ).fetchone()[0]

        avg_margin = None
        if can_view_margins:
            avg_margin = db.execute(
                f"SELECT AVG(margin_pct) FROM quotes WHERE {quote_where} AND status='completed' AND margin_pct > 0",
                quote_vals,
            ).fetchone()[0]

        total_revenue = db.execute(
            f"SELECT SUM(total_price) FROM quotes WHERE {quote_where} AND status='completed'",
            quote_vals,
        ).fetchone()[0]
        product_count = db.execute(
            "SELECT COUNT(*) FROM products WHERE tenant_id=? AND active=1", (tenant_id,)
        ).fetchone()[0]
        products_by_line = db.execute(
            "SELECT product_line, COUNT(*) as count FROM products WHERE tenant_id=? AND active=1 GROUP BY product_line",
            (tenant_id,),
        ).fetchall()

        return jsonify({
            "total_quotes": total_quotes,
            "active_quotes": active_quotes,
            "completed_quotes": completed_quotes,
            "pending_approvals": pending_approvals,
            "avg_margin": round(avg_margin, 1) if (avg_margin and can_view_margins) else 0,
            "total_revenue": total_revenue or 0,
            "product_count": product_count,
            "products_by_line": {r["product_line"]: r["count"] for r in products_by_line},
        })
    finally:
        db.close()


# ---------------------------------------------------------------------------
# REPORTS
# ---------------------------------------------------------------------------

@app.route("/api/reports/pipeline", methods=["GET"])
def get_pipeline_report():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _can_access_reports(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        try:
            report_scope = _build_report_scope_filters(request, "created_at", "rep_id")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        where_parts = ["tenant_id=?"] + report_scope["where_parts"]
        params = [tenant_id, *report_scope["params"]]
        where_clause = " AND ".join(where_parts)

        rows = db.execute(
            f"""SELECT status,
                       COUNT(*) AS cnt,
                       COALESCE(SUM(total_price), 0) AS val
                FROM quotes
                WHERE {where_clause}
                GROUP BY status""",
            params,
        ).fetchall()

        by_status = {
            "draft": {"count": 0, "total_price": 0.0},
            "pending_approval": {"count": 0, "total_price": 0.0},
            "approved": {"count": 0, "total_price": 0.0},
            "completed": {"count": 0, "total_price": 0.0},
            "denied": {"count": 0, "total_price": 0.0},
        }

        total_quotes = 0
        total_pipeline_value = 0.0
        for row in rows:
            status = row["status"] or "draft"
            count = int(row["cnt"] or 0)
            total_price = float(row["val"] or 0.0)
            if status not in by_status:
                by_status[status] = {"count": 0, "total_price": 0.0}
            by_status[status]["count"] = count
            by_status[status]["total_price"] = total_price
            total_quotes += count
            total_pipeline_value += total_price

        return jsonify(
            {
                "period": report_scope["period"],
                "by_status": by_status,
                "total_quotes": total_quotes,
                "total_pipeline_value": round(total_pipeline_value, 2),
            }
        )
    finally:
        db.close()


@app.route("/api/reports/margins", methods=["GET"])
def get_margin_report():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _can_access_reports(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        try:
            report_scope = _build_report_scope_filters(request, "q.created_at", "q.rep_id")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        where_parts = ["q.tenant_id=?"] + report_scope["where_parts"]
        params = [tenant_id, *report_scope["params"]]
        where_clause = " AND ".join(where_parts)

        summary = db.execute(
            f"""SELECT COALESCE(AVG(CASE WHEN q.margin_pct IS NOT NULL THEN q.margin_pct END), 0) AS avg_margin_pct,
                       COALESCE(SUM(CASE WHEN q.status='completed' THEN COALESCE(q.total_price, 0) ELSE 0 END), 0) AS completed_revenue,
                       COALESCE(SUM(CASE WHEN q.status='completed' THEN 1 ELSE 0 END), 0) AS completed_count
                FROM quotes q
                LEFT JOIN users u ON u.id=q.rep_id AND u.tenant_id=q.tenant_id
                WHERE {where_clause}""",
            params,
        ).fetchone()

        below_floor_row = db.execute(
            f"""SELECT COUNT(*) AS below_floor_count
                FROM quotes q
                LEFT JOIN users u ON u.id=q.rep_id AND u.tenant_id=q.tenant_id
                LEFT JOIN governance_settings gs
                  ON gs.tenant_id=q.tenant_id AND gs.tier=COALESCE(u.tier, 'standard')
                WHERE {where_clause}
                  AND q.margin_pct IS NOT NULL
                  AND q.margin_pct < COALESCE(gs.margin_floor, 30)""",
            params,
        ).fetchone()

        by_rep_rows = db.execute(
            f"""SELECT q.rep_id,
                       COALESCE(u.name, q.rep_id, 'Unknown Rep') AS rep_name,
                       COUNT(*) AS quote_count,
                       COALESCE(AVG(CASE WHEN q.margin_pct IS NOT NULL THEN q.margin_pct END), 0) AS avg_margin_pct,
                       COALESCE(SUM(CASE WHEN q.status='completed' THEN COALESCE(q.total_price, 0) ELSE 0 END), 0) AS completed_revenue
                FROM quotes q
                LEFT JOIN users u ON u.id=q.rep_id AND u.tenant_id=q.tenant_id
                WHERE {where_clause}
                GROUP BY q.rep_id, u.name
                ORDER BY COALESCE(u.name, q.rep_id)""",
            params,
        ).fetchall()

        return jsonify(
            {
                "period": report_scope["period"],
                "avg_margin_pct": round(float(summary["avg_margin_pct"] or 0.0), 2),
                "completed_revenue": round(float(summary["completed_revenue"] or 0.0), 2),
                "completed_count": int(summary["completed_count"] or 0),
                "below_floor_count": int(below_floor_row["below_floor_count"] or 0),
                "by_rep": [
                    {
                        "rep_id": row["rep_id"],
                        "rep_name": row["rep_name"],
                        "quote_count": int(row["quote_count"] or 0),
                        "avg_margin_pct": round(float(row["avg_margin_pct"] or 0.0), 2),
                        "completed_revenue": round(float(row["completed_revenue"] or 0.0), 2),
                    }
                    for row in by_rep_rows
                ],
            }
        )
    finally:
        db.close()


@app.route("/api/reports/approvals", methods=["GET"])
def get_approval_report():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _can_access_reports(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        try:
            report_scope = _build_report_scope_filters(request, "ar.created_at", "ar.rep_id")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        where_parts = ["ar.tenant_id=?"] + report_scope["where_parts"]
        params = [tenant_id, *report_scope["params"]]
        where_clause = " AND ".join(where_parts)

        summary = db.execute(
            f"""SELECT COUNT(*) AS total_requests,
                       COALESCE(AVG(CASE WHEN ar.requested_margin IS NOT NULL THEN ar.requested_margin END), 0) AS avg_margin_requested
                FROM approval_requests ar
                LEFT JOIN users u ON u.id=ar.rep_id AND u.tenant_id=ar.tenant_id
                WHERE {where_clause}""",
            params,
        ).fetchone()

        status_rows = db.execute(
            f"""SELECT ar.status, COUNT(*) AS cnt
                FROM approval_requests ar
                LEFT JOIN users u ON u.id=ar.rep_id AND u.tenant_id=ar.tenant_id
                WHERE {where_clause}
                GROUP BY ar.status""",
            params,
        ).fetchall()

        counts = {"approved": 0, "denied": 0, "pending": 0}
        for row in status_rows:
            status = row["status"] or "pending"
            if status in counts:
                counts[status] = int(row["cnt"] or 0)

        by_rep_rows = db.execute(
            f"""SELECT ar.rep_id,
                       COALESCE(u.name, ar.rep_id, 'Unknown Rep') AS rep_name,
                       COUNT(*) AS requests,
                       COALESCE(SUM(CASE WHEN ar.status='approved' THEN 1 ELSE 0 END), 0) AS approved,
                       COALESCE(SUM(CASE WHEN ar.status='denied' THEN 1 ELSE 0 END), 0) AS denied
                FROM approval_requests ar
                LEFT JOIN users u ON u.id=ar.rep_id AND u.tenant_id=ar.tenant_id
                WHERE {where_clause}
                GROUP BY ar.rep_id, u.name
                ORDER BY COALESCE(u.name, ar.rep_id)""",
            params,
        ).fetchall()

        return jsonify(
            {
                "period": report_scope["period"],
                "total_requests": int(summary["total_requests"] or 0),
                "approved_count": counts["approved"],
                "denied_count": counts["denied"],
                "pending_count": counts["pending"],
                "avg_margin_requested": round(float(summary["avg_margin_requested"] or 0.0), 2),
                "by_rep": [
                    {
                        "rep_id": row["rep_id"],
                        "rep_name": row["rep_name"],
                        "requests": int(row["requests"] or 0),
                        "approved": int(row["approved"] or 0),
                        "denied": int(row["denied"] or 0),
                    }
                    for row in by_rep_rows
                ],
            }
        )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# QUOTES
# ---------------------------------------------------------------------------

@app.route("/api/quotes", methods=["GET"])
def get_quotes():
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        status_filter = request.args.get("status")
        rep_id = request.args.get("rep_id")

        can_view_all = _has_permission_ctx(auth_ctx, "can_view_all_quotes")
        can_view_margins = _has_permission_ctx(auth_ctx, "can_view_margins")

        # Section 1A: sort params
        sort_by = request.args.get("sort_by", "updated_at")
        sort_dir = request.args.get("sort_dir", "desc").lower()
        ALLOWED_SORT_COLS = {"updated_at", "created_at", "customer_name", "total_price", "total_cost", "margin_pct"}
        if sort_by not in ALLOWED_SORT_COLS:
            sort_by = "updated_at"
        if sort_dir not in ("asc", "desc"):
            sort_dir = "desc"
        # Never allow sorting by restricted fields if user can't view margins
        if sort_by in ("margin_pct", "total_cost") and not can_view_margins:
            sort_by = "updated_at"

        query = """SELECT q.*, u.name as rep_name,
            (SELECT COUNT(*) FROM openings o WHERE o.quote_id=q.id) as opening_count
            FROM quotes q JOIN users u ON q.rep_id=u.id
            WHERE q.tenant_id=?"""
        vals = [tenant_id]
        if status_filter:
            query += " AND q.status=?"
            vals.append(status_filter)
        if rep_id:
            query += " AND q.rep_id=?"
            vals.append(rep_id)
        if not can_view_all:
            query += " AND q.rep_id=?"
            vals.append(user_id)
        query += f" ORDER BY q.{sort_by} {sort_dir.upper()}"

        rows = [dict(r) for r in db.execute(query, vals).fetchall()]
        if not can_view_margins:
            for r in rows:
                r["margin_pct"] = None
                r["margin_dollars"] = None
                r["total_cost"] = None

        return jsonify(rows)
    finally:
        db.close()


@app.route("/api/quotes", methods=["POST"])
def create_quote():
    db = get_db()
    try:
        tenant_id, actor_id, actor_name = _get_tenant(request)
        body = request.get_json(force=True) or {}
        try:
            customer_name = _require_text(body.get("customer_name"), "Customer name")
            customer_phone = _require_text(body.get("customer_phone"), "Phone number")
            job_address = _require_text(body.get("job_address"), "Job address")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        auth_ctx = getattr(g, "auth", None)
        can_view_all = _has_permission_ctx(auth_ctx, "can_view_all_quotes")

        rep_id = body.get("rep_id") or actor_id
        if not can_view_all:
            rep_id = actor_id

        qid = f"q-{uuid.uuid4().hex[:8]}"
        required_zone = _resolve_required_zone(db, tenant_id, body.get("required_zone"))
        ts = datetime.now().isoformat()
        db.execute(
            """INSERT INTO quotes
            (id,tenant_id,rep_id,customer_name,customer_phone,customer_email,
             job_address,job_zip,required_zone,status,notes,created_at,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                qid,
                tenant_id,
                rep_id,
                customer_name,
                customer_phone,
                body.get("customer_email", ""),
                job_address,
                body.get("job_zip", ""),
                required_zone,
                "draft",
                body.get("notes", ""),
                ts,
                ts,
            ),
        )
        db.commit()
        audit(
            db,
            tenant_id,
            "quote_created",
            "quote",
            qid,
            actor_id,
            actor_name,
            {"customer": body.get("customer_name", ""), "rep_id": rep_id},
            rep_id=actor_id,
        )
        db.commit()
        return jsonify({"id": qid, "status": "created"}), 201
    finally:
        db.close()


@app.route("/api/quotes/<qid>", methods=["GET"])
def get_quote(qid):
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        can_view_all = _has_permission_ctx(auth_ctx, "can_view_all_quotes")
        can_view_margins = _has_permission_ctx(auth_ctx, "can_view_margins")

        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        tenant_id = quote["tenant_id"]

        if (not can_view_all) and quote["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        openings = db.execute(
            "SELECT * FROM openings WHERE quote_id=? AND tenant_id=? ORDER BY opening_number",
            (qid, tenant_id)
        ).fetchall()

        result = dict(quote)
        result["openings"] = [dict(o) for o in openings]

        for o in result["openings"]:
            o["width"] = o.get("total_width")
            o["height"] = o.get("total_height")
            o["noa_status"] = o.get("dp_status")

            if o.get("product_id"):
                p = db.execute("SELECT name, model_number FROM products WHERE id=?", (o["product_id"],)).fetchone()
                if p:
                    o["product_name"] = p["name"]
                    o["product_model_number"] = p["model_number"]
            if o.get("glass_option_id"):
                g_row = db.execute("SELECT name FROM glass_options WHERE id=?", (o["glass_option_id"],)).fetchone()
                if g_row:
                    o["glass_name"] = g_row["name"]
            if o.get("frame_color_id"):
                fc = db.execute("SELECT name FROM frame_colors WHERE id=?", (o["frame_color_id"],)).fetchone()
                if fc:
                    o["frame_name"] = fc["name"]

            if o.get("opening_mode") == "multipart":
                panels = db.execute(
                    "SELECT * FROM assembly_panels WHERE opening_id=? AND tenant_id=? ORDER BY panel_index",
                    (o["id"], tenant_id)
                ).fetchall()
                o["panels"] = [dict(p) for p in panels]

            if not can_view_margins:
                o["total_cost"] = None
                o["margin_pct"] = None
                o["margin_dollars"] = None

        gov = _get_governance_for_rep(db, tenant_id, quote["rep_id"])
        if gov:
            result["margin_floor"] = gov["margin_floor"]
            result["yellow_threshold"] = gov["yellow_threshold"]
            result["margin_status"] = get_margin_status(
                quote["margin_pct"], gov["margin_floor"], gov["yellow_threshold"]
            )

        if not can_view_margins:
            result["margin_pct"] = None
            result["margin_dollars"] = None
            result["total_cost"] = None

        return jsonify(result)
    finally:
        db.close()


@app.route("/api/quotes/<qid>", methods=["PUT"])
def update_quote(qid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}
        auth_ctx = getattr(g, "auth", None)
        can_view_all = _has_permission_ctx(auth_ctx, "can_view_all_quotes")
        existing_quote = _load_quote_access_row(db, None, qid)
        if not existing_quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(existing_quote, auth_ctx, "Quote")
        tenant_id = existing_quote["tenant_id"]
        if (not can_view_all) and existing_quote["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        if _hvhz_only_mode_enabled(db, tenant_id):
            body["required_zone"] = "HVHZ"
        elif "required_zone" in body:
            body["required_zone"] = _resolve_required_zone(
                db,
                tenant_id,
                body.get("required_zone"),
                existing_quote.get("required_zone"),
            )

        allowed = [
            "customer_name", "customer_phone", "customer_email",
            "job_address", "job_zip", "notes", "required_zone", "status",
        ]
        sets, vals = [], []
        for k in allowed:
            if k in body:
                sets.append(f"{k}=?")
                vals.append(body[k])

        if sets:
            sets.append("updated_at=?")
            vals.append(datetime.now().isoformat())
            vals.extend([qid, tenant_id])
            db.execute(f"UPDATE quotes SET {','.join(sets)} WHERE id=? AND tenant_id=?", vals)

        # Recompute totals server-side whenever quote is edited.
        totals = _update_quote_totals(db, qid, tenant_id)

        if body.get("status") == "completed":
            gov_state = _enforce_quote_governance_lock(db, tenant_id, qid, user_id)
            if gov_state.get("requires_approval"):
                db.commit()
                return jsonify({
                    "status": "pending_approval",
                    "requires_approval": True,
                    "governance": gov_state,
                    "notification_payload": gov_state.get("pending_approval_payload"),
                }), 409

            now = datetime.now()
            lock_until = now + timedelta(days=30)
            db.execute(
                """UPDATE quotes
                   SET status='completed', pricing_locked_at=?, pricing_locked_until=?, updated_at=?
                   WHERE id=? AND tenant_id=?""",
                (now.isoformat(), lock_until.isoformat(), now.isoformat(), qid, tenant_id),
            )

            audit(
                db,
                tenant_id,
                "quote_completed",
                "quote",
                qid,
                user_id,
                user_name,
                {
                    "status": "completed",
                    "snapshot_pricing": True,
                    "pricing_locked_until": lock_until.isoformat(),
                    "totals": totals,
                },
                rep_id=user_id,
            )

        db.commit()
        return jsonify({"status": "updated", "totals": totals})
    finally:
        db.close()


@app.route("/api/quotes/<qid>/messages", methods=["GET", "POST"])
def quote_messages(qid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)

        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        tenant_id = quote["tenant_id"]

        if (not _has_permission_ctx(auth_ctx, "can_view_all_quotes")) and quote["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        if request.method == "POST":
            if request.files:
                body = request.form or {}
                upload = request.files.get("attachment")
            else:
                body = request.get_json(force=True) or {}
                upload = None

            content = _sanitize_text_field(body.get("content"), MAX_JOB_MESSAGE_LENGTH)
            mid = f"msg-{uuid.uuid4().hex[:8]}"
            attachment = None
            if upload and getattr(upload, "filename", ""):
                try:
                    attachment = _save_job_message_attachment(upload, tenant_id, qid, mid)
                except ValueError as exc:
                    return jsonify({"error": str(exc)}), 400
                except RuntimeError as exc:
                    return jsonify({"error": str(exc)}), 500

            if not content and not attachment:
                return jsonify({"error": "Message content or attachment required"}), 400

            db.execute(
                """INSERT INTO job_messages
                   (id,tenant_id,quote_id,user_id,user_name,content,attachment_storage,attachment_bucket,
                    attachment_object_name,attachment_generation,attachment_url,attachment_kind,attachment_name,
                    attachment_mime,attachment_size)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    mid,
                    tenant_id,
                    qid,
                    user_id,
                    user_name,
                    content,
                    attachment["storage"] if attachment else None,
                    attachment["bucket"] if attachment else None,
                    attachment["object_name"] if attachment else None,
                    attachment["generation"] if attachment else None,
                    attachment["legacy_url"] if attachment else None,
                    attachment["kind"] if attachment else None,
                    attachment["name"] if attachment else None,
                    attachment["mime"] if attachment else None,
                    attachment["size"] if attachment else None,
                ),
            )
            audit(
                db,
                tenant_id,
                "job_message_sent",
                "quote",
                qid,
                user_id,
                user_name,
                {
                    "message_id": mid,
                    "has_attachment": bool(attachment),
                    "attachment_kind": attachment["kind"] if attachment else None,
                },
                rep_id=user_id,
            )
            db.commit()
            return jsonify(_job_message_public_payload({
                "id": mid,
                "quote_id": qid,
                "user_id": user_id,
                "user_name": user_name,
                "content": content,
                "attachment_storage": attachment["storage"] if attachment else None,
                "attachment_bucket": attachment["bucket"] if attachment else None,
                "attachment_object_name": attachment["object_name"] if attachment else None,
                "attachment_generation": attachment["generation"] if attachment else None,
                "attachment_url": attachment["legacy_url"] if attachment else None,
                "attachment_kind": attachment["kind"] if attachment else None,
                "attachment_name": attachment["name"] if attachment else None,
                "attachment_mime": attachment["mime"] if attachment else None,
                "attachment_size": attachment["size"] if attachment else None,
                "status": "sent",
            })), 201

        rows = db.execute(
            """SELECT id, quote_id, user_id, user_name, content,
                      attachment_storage, attachment_bucket, attachment_object_name, attachment_generation,
                      attachment_url, attachment_kind, attachment_name, attachment_mime, attachment_size,
                      delivery_channel, external_direction, external_message_sid, external_status,
                      external_from, external_to, external_error,
                      created_at
               FROM job_messages
               WHERE tenant_id=? AND quote_id=?
               ORDER BY created_at ASC, id ASC""",
            (tenant_id, qid),
        ).fetchall()
        return jsonify([_job_message_public_payload(dict(row)) for row in rows])
    finally:
        db.close()


@app.route("/api/quotes/<qid>/sms-messages", methods=["POST"])
def quote_sms_messages(qid):
    db = get_db()
    mid = None
    thread = None
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)

        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        tenant_id = quote["tenant_id"]

        if (not _has_permission_ctx(auth_ctx, "can_view_all_quotes")) and quote["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        if not _twilio_enabled():
            return jsonify({"error": "SMS/MMS is not configured on this deployment"}), 503

        if request.files:
            body = request.form or {}
            upload = request.files.get("attachment")
        else:
            body = request.get_json(force=True) or {}
            upload = None

        content = _sanitize_text_field(body.get("content"), MAX_JOB_MESSAGE_LENGTH)
        mid = f"msg-{uuid.uuid4().hex[:8]}"
        attachment = None
        prepared_meta = None
        if upload and getattr(upload, "filename", ""):
            try:
                prepared_meta = _prepare_job_message_attachment(upload)
                _validate_twilio_attachment_meta(prepared_meta)
                attachment = _save_job_message_attachment(upload, tenant_id, qid, mid, prepared_meta=prepared_meta)
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400
            except RuntimeError as exc:
                return jsonify({"error": str(exc)}), 500

        if not content and not attachment:
            return jsonify({"error": "Message content or attachment required"}), 400

        customer_phone_norm = _normalize_phone_number(quote["customer_phone"])
        if not customer_phone_norm:
            return jsonify({"error": "Quote must have a valid customer phone number before texting"}), 400

        thread = _ensure_sms_thread(db, quote, channel_address=TWILIO_MESSAGING_FROM or None)
        outbound_from = (thread["channel_address"] if thread else "") or TWILIO_MESSAGING_FROM or None
        _insert_job_message(db, {
            "id": mid,
            "tenant_id": tenant_id,
            "quote_id": qid,
            "user_id": user_id,
            "user_name": user_name,
            "content": content,
            "attachment_storage": attachment["storage"] if attachment else None,
            "attachment_bucket": attachment["bucket"] if attachment else None,
            "attachment_object_name": attachment["object_name"] if attachment else None,
            "attachment_generation": attachment["generation"] if attachment else None,
            "attachment_url": attachment["legacy_url"] if attachment else None,
            "attachment_kind": attachment["kind"] if attachment else None,
            "attachment_name": attachment["name"] if attachment else None,
            "attachment_mime": attachment["mime"] if attachment else None,
            "attachment_size": attachment["size"] if attachment else None,
            "delivery_channel": "sms",
            "external_direction": "outbound",
            "external_status": "queued",
            "external_from": outbound_from,
            "external_to": customer_phone_norm,
        })
        db.commit()

        base_url = _current_public_base_url()
        status_callback = _twilio_status_callback_url(base_url=base_url)
        message_args = {
            "to": customer_phone_norm,
            "body": content or None,
        }
        if attachment:
            message_args["media_url"] = [_build_public_chat_media_url(mid, base_url=base_url)]
        if status_callback:
            message_args["status_callback"] = status_callback
        if TWILIO_MESSAGING_SERVICE_SID:
            message_args["messaging_service_sid"] = TWILIO_MESSAGING_SERVICE_SID
        else:
            message_args["from_"] = TWILIO_MESSAGING_FROM

        try:
            sent = _get_twilio_client().messages.create(**message_args)
        except Exception as exc:
            error_text = _sanitize_text_field(str(exc), 240) or "Twilio send failed"
            db.execute(
                "UPDATE job_messages SET external_status='failed', external_error=? WHERE id=? AND tenant_id=?",
                (error_text, mid, tenant_id),
            )
            db.commit()
            return jsonify({"error": f"SMS/MMS send failed: {error_text}"}), 502

        status_text = _sanitize_text_field(getattr(sent, "status", None), 64) or "queued"
        actual_from = _normalize_phone_number(getattr(sent, "from_", None) or outbound_from or "")
        actual_to = _normalize_phone_number(getattr(sent, "to", None) or customer_phone_norm or "")
        now = _now_iso()
        db.execute(
            """UPDATE job_messages
               SET external_message_sid=?, external_status=?, external_from=?, external_to=?, external_error=NULL
               WHERE id=? AND tenant_id=?""",
            (
                getattr(sent, "sid", None),
                status_text,
                actual_from or outbound_from,
                actual_to or customer_phone_norm,
                mid,
                tenant_id,
            ),
        )
        if thread:
            db.execute(
                """UPDATE sms_threads
                   SET channel_address=?, last_outbound_at=?, active=1, updated_at=?
                   WHERE id=?""",
                (
                    actual_from or outbound_from,
                    now,
                    now,
                    thread["id"],
                ),
            )
        audit(
            db,
            tenant_id,
            "sms_message_sent",
            "quote",
            qid,
            user_id,
            user_name,
            {
                "message_id": mid,
                "direction": "outbound",
                "status": status_text,
                "has_attachment": bool(attachment),
            },
            rep_id=quote["rep_id"],
        )
        db.commit()

        row = db.execute(
            """SELECT id, quote_id, user_id, user_name, content,
                      attachment_storage, attachment_bucket, attachment_object_name, attachment_generation,
                      attachment_url, attachment_kind, attachment_name, attachment_mime, attachment_size,
                      delivery_channel, external_direction, external_message_sid, external_status,
                      external_from, external_to, external_error,
                      created_at
               FROM job_messages
               WHERE tenant_id=? AND id=?""",
            (tenant_id, mid),
        ).fetchone()
        return jsonify(_job_message_public_payload(dict(row))), 201
    finally:
        db.close()


@app.route("/api/chat-threads", methods=["GET"])
def get_chat_threads():
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        can_view_all = _has_permission_ctx(auth_ctx, "can_view_all_quotes")

        query = """SELECT q.id AS quote_id, q.customer_name, q.job_address, q.status, q.updated_at,
                          q.rep_id, u.name AS rep_name,
                          (SELECT COUNT(*)
                             FROM job_messages jm
                            WHERE jm.tenant_id=q.tenant_id
                              AND jm.quote_id=q.id
                              AND jm.attachment_deleted_at IS NULL) AS message_count,
                          (SELECT COUNT(*)
                             FROM job_messages jm
                            WHERE jm.tenant_id=q.tenant_id
                              AND jm.quote_id=q.id
                              AND jm.attachment_deleted_at IS NULL
                              AND (jm.attachment_object_name IS NOT NULL OR jm.attachment_url IS NOT NULL OR jm.attachment_bucket IS NOT NULL)) AS attachment_count,
                          (SELECT jm.user_name
                             FROM job_messages jm
                            WHERE jm.tenant_id=q.tenant_id
                              AND jm.quote_id=q.id
                              AND jm.attachment_deleted_at IS NULL
                            ORDER BY jm.created_at DESC, jm.id DESC
                            LIMIT 1) AS last_message_user_name,
                          (SELECT jm.content
                             FROM job_messages jm
                            WHERE jm.tenant_id=q.tenant_id
                              AND jm.quote_id=q.id
                              AND jm.attachment_deleted_at IS NULL
                            ORDER BY jm.created_at DESC, jm.id DESC
                            LIMIT 1) AS last_message_content,
                          (SELECT jm.created_at
                             FROM job_messages jm
                            WHERE jm.tenant_id=q.tenant_id
                              AND jm.quote_id=q.id
                              AND jm.attachment_deleted_at IS NULL
                            ORDER BY jm.created_at DESC, jm.id DESC
                            LIMIT 1) AS last_message_at,
                          (SELECT jm.attachment_kind
                             FROM job_messages jm
                            WHERE jm.tenant_id=q.tenant_id
                              AND jm.quote_id=q.id
                              AND jm.attachment_deleted_at IS NULL
                            ORDER BY jm.created_at DESC, jm.id DESC
                            LIMIT 1) AS last_message_attachment_kind
                   FROM quotes q
                   JOIN users u ON u.id=q.rep_id AND u.tenant_id=q.tenant_id
                   WHERE q.tenant_id=?
                     AND EXISTS (
                         SELECT 1
                           FROM job_messages jm
                          WHERE jm.tenant_id=q.tenant_id
                            AND jm.quote_id=q.id
                            AND jm.attachment_deleted_at IS NULL
                     )"""
        vals = [tenant_id]

        if not can_view_all:
            query += " AND q.rep_id=? AND q.status IN ('draft','pending_approval','approved')"
            vals.append(user_id)

        rows = [dict(r) for r in db.execute(query, vals).fetchall()]
        for row in rows:
            preview = _chat_message_preview(row.get("last_message_content"), 180)
            if not preview and row.get("last_message_attachment_kind"):
                preview = f"{row['last_message_attachment_kind'].title()} attachment"
            row["last_message_preview"] = preview or "No preview available"
            row["last_message_at"] = row.get("last_message_at") or row.get("updated_at")
        rows.sort(key=lambda item: item.get("last_message_at") or "", reverse=True)
        return jsonify(rows)
    finally:
        db.close()


@app.route("/api/chat-media/<message_id>", methods=["GET"])
def chat_media(message_id):
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)

        row = _load_chat_media_row(db, message_id, tenant_id=tenant_id)
        if not row:
            return jsonify({"error": "Media not found"}), 404

        item = dict(row)
        if not _job_message_has_attachment(item):
            return jsonify({"error": "No media attached to this message"}), 404

        if (not _has_permission_ctx(auth_ctx, "can_view_all_quotes")) and item["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        return _serve_chat_media_item(item)
    finally:
        db.close()


@app.route("/api/public/chat-media/<message_id>", methods=["GET", "HEAD"])
def public_chat_media(message_id):
    expires_at = request.args.get("expires")
    signature = request.args.get("sig")
    if not _validate_public_media_access(message_id, expires_at, signature):
        return jsonify({"error": "Expired or invalid media signature"}), 403

    db = get_db()
    try:
        row = _load_chat_media_row(db, message_id)
        if not row:
            return jsonify({"error": "Media not found"}), 404

        item = dict(row)
        if not _job_message_has_attachment(item):
            return jsonify({"error": "No media attached to this message"}), 404

        return _serve_chat_media_item(item)
    finally:
        db.close()


@app.route("/api/webhooks/twilio/inbound", methods=["POST"])
def twilio_inbound_webhook():
    if not _validate_twilio_request(request):
        return jsonify({"error": "Invalid Twilio signature"}), 403

    message_sid = (request.form.get("MessageSid") or "").strip()
    from_phone = _normalize_phone_number(request.form.get("From"))
    to_phone = _normalize_phone_number(request.form.get("To"))
    body = _sanitize_text_field(request.form.get("Body"), MAX_JOB_MESSAGE_LENGTH)
    try:
        num_media = max(0, int(request.form.get("NumMedia") or 0))
    except (TypeError, ValueError):
        num_media = 0

    if not from_phone:
        return Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', mimetype="text/xml")

    db = get_db()
    try:
        if message_sid:
            existing = db.execute(
                "SELECT id FROM job_messages WHERE external_message_sid=? AND external_direction='inbound' LIMIT 1",
                (message_sid,),
            ).fetchone()
            if existing:
                return Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', mimetype="text/xml")

        thread = _find_sms_thread_for_inbound(db, from_phone, to_phone)
        if not thread:
            return Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', mimetype="text/xml")

        tenant_id = thread["tenant_id"]
        quote_id = thread["quote_id"]
        user_id = _ensure_sms_external_user(db, tenant_id)
        customer_name = _sanitize_text_field(thread["customer_name"] if "customer_name" in thread.keys() else None, 140) or "Customer"
        now = _now_iso()

        media_items = []
        for idx in range(num_media):
            media_url = (request.form.get(f"MediaUrl{idx}") or "").strip()
            media_type = (request.form.get(f"MediaContentType{idx}") or "").strip().lower()
            if media_url:
                media_items.append((media_url, media_type))

        if not media_items:
            mid = f"msg-{uuid.uuid4().hex[:8]}"
            _insert_job_message(db, {
                "id": mid,
                "tenant_id": tenant_id,
                "quote_id": quote_id,
                "user_id": user_id,
                "user_name": customer_name,
                "content": body,
                "delivery_channel": "sms",
                "external_direction": "inbound",
                "external_message_sid": message_sid or None,
                "external_status": "received",
                "external_from": from_phone,
                "external_to": to_phone or None,
            })
        else:
            total_media = len(media_items)
            for idx, (media_url, media_type) in enumerate(media_items):
                mid = f"msg-{uuid.uuid4().hex[:8]}"
                attachment = None
                media_notice = None
                try:
                    attachment = _save_external_media_attachment(media_url, media_type, tenant_id, quote_id, mid)
                except ValueError as exc:
                    media_notice = f"Unsupported inbound media skipped: {exc}"
                except Exception:
                    media_notice = "Inbound media could not be downloaded."

                content = body if idx == 0 else ""
                if idx == 0 and total_media > 1 and not content:
                    content = f"Customer sent {total_media} attachments."
                if media_notice:
                    content = "\n\n".join(part for part in [content, f"[{media_notice}]"] if part)

                _insert_job_message(db, {
                    "id": mid,
                    "tenant_id": tenant_id,
                    "quote_id": quote_id,
                    "user_id": user_id,
                    "user_name": customer_name,
                    "content": content,
                    "attachment_storage": attachment["storage"] if attachment else None,
                    "attachment_bucket": attachment["bucket"] if attachment else None,
                    "attachment_object_name": attachment["object_name"] if attachment else None,
                    "attachment_generation": attachment["generation"] if attachment else None,
                    "attachment_url": attachment["legacy_url"] if attachment else None,
                    "attachment_kind": attachment["kind"] if attachment else None,
                    "attachment_name": attachment["name"] if attachment else None,
                    "attachment_mime": attachment["mime"] if attachment else None,
                    "attachment_size": attachment["size"] if attachment else None,
                    "delivery_channel": "sms",
                    "external_direction": "inbound",
                    "external_message_sid": message_sid or None,
                    "external_status": "received",
                    "external_from": from_phone,
                    "external_to": to_phone or None,
                })

        db.execute(
            """UPDATE sms_threads
               SET channel_address=COALESCE(?, channel_address),
                   last_inbound_at=?,
                   active=1,
                   updated_at=?
               WHERE id=?""",
            (to_phone or None, now, now, thread["id"]),
        )
        db.commit()
        return Response('<?xml version="1.0" encoding="UTF-8"?><Response></Response>', mimetype="text/xml")
    finally:
        db.close()


@app.route("/api/webhooks/twilio/status", methods=["POST"])
def twilio_status_webhook():
    if not _validate_twilio_request(request):
        return jsonify({"error": "Invalid Twilio signature"}), 403

    message_sid = (request.form.get("MessageSid") or request.form.get("SmsSid") or "").strip()
    if not message_sid:
        return ("", 204)

    status_text = _sanitize_text_field(
        request.form.get("MessageStatus") or request.form.get("SmsStatus"),
        64,
    ) or "updated"
    from_phone = _normalize_phone_number(request.form.get("From"))
    to_phone = _normalize_phone_number(request.form.get("To"))
    error_parts = [
        _sanitize_text_field(request.form.get("ErrorCode"), 32),
        _sanitize_text_field(request.form.get("ErrorMessage"), 180),
    ]
    error_text = " - ".join([part for part in error_parts if part]) or None

    db = get_db()
    try:
        row = db.execute(
            "SELECT id, tenant_id, quote_id FROM job_messages WHERE external_message_sid=? ORDER BY created_at DESC LIMIT 1",
            (message_sid,),
        ).fetchone()
        if row:
            db.execute(
                """UPDATE job_messages
                   SET external_status=?, external_error=?, external_from=COALESCE(?, external_from), external_to=COALESCE(?, external_to)
                   WHERE id=? AND tenant_id=?""",
                (
                    status_text,
                    error_text,
                    from_phone or None,
                    to_phone or None,
                    row["id"],
                    row["tenant_id"],
                ),
            )
            if status_text in ("delivered", "sent", "queued", "accepted"):
                now = _now_iso()
                db.execute(
                    """UPDATE sms_threads
                       SET channel_address=COALESCE(?, channel_address),
                           last_outbound_at=COALESCE(last_outbound_at, ?),
                           updated_at=?
                       WHERE quote_id=? AND tenant_id=?""",
                    (
                        from_phone or None,
                        now,
                        now,
                        row["quote_id"],
                        row["tenant_id"],
                    ),
                )
            db.commit()
        return ("", 204)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# OPENINGS (via quotes/:id/openings)
# ---------------------------------------------------------------------------

@app.route("/api/quotes/<qid>/openings", methods=["POST"])
def create_opening(qid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        oid = f"o-{uuid.uuid4().hex[:8]}"
        opening_mode = body.get("opening_mode", "single")
        wall_type = _normalize_wall_type(body.get("wall_type", "cbs"))

        auth_ctx = getattr(g, "auth", None)
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        tenant_id = quote["tenant_id"]
        if (not _has_permission_ctx(auth_ctx, "can_view_all_quotes")) and quote["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        required_zone = _resolve_required_zone(
            db,
            tenant_id,
            body.get("required_zone"),
            quote["required_zone"],
        )
        can_set_discounts = _has_permission_ctx(auth_ctx, "can_set_discounts")
        discount_pct = max(0.0, _safe_float(body.get("driveway_discount_pct"), 0.0)) if can_set_discounts else 0.0
        requested_sell_price = body.get("requested_sell_price") if can_set_discounts else None
        opening_count = db.execute(
            "SELECT COUNT(*) FROM openings WHERE quote_id=?", (qid,)
        ).fetchone()[0] + 1

        if opening_mode == "multipart":
            panels = body.get("panels", [])
            if not panels:
                return jsonify({"error": "panels required for multipart openings"}), 400

            try:
                total_width = _require_positive_float(body.get("total_width"), "Total width")
                total_height = _require_positive_float(body.get("total_height"), "Total height")
            except ValueError as exc:
                return jsonify({"error": str(exc)}), 400

            panel_count = len(panels)
            mull_bar_width = 2.5
            if panel_count > 0 and not panels[0].get("width"):
                panel_width = round((total_width - mull_bar_width * (panel_count - 1)) / panel_count, 2)
                for i, panel in enumerate(panels):
                    panel["width"] = panel_width
                    panel["height"] = panel.get("height", total_height)
                    panel["panel_index"] = i

            assembly_pricing = calculate_assembly_price(
                db,
                tenant_id,
                oid,
                panels,
                body.get("floor_level", 1),
                body.get("glass_option_id"),
                body.get("frame_color_id"),
                body.get("complexity_ids", []),
                body.get("zip_code"),
                wall_type,
            )
            if not assembly_pricing:
                return jsonify({"error": "Failed to calculate assembly pricing"}), 400

            # Apply driveway discount for assemblies after deterministic baseline calc.
            baseline_sell = assembly_pricing["sell_price"]
            if requested_sell_price is not None:
                adjusted_sell = round(max(0.01, _safe_float(requested_sell_price, baseline_sell)), 2)
                if baseline_sell > 0:
                    discount_pct = round(max(0.0, (1 - (adjusted_sell / baseline_sell)) * 100), 2)
            else:
                adjusted_sell = round(max(0.01, baseline_sell * (1 - discount_pct / 100.0)), 2)

            assembly_pricing["baseline_sell_price"] = baseline_sell
            assembly_pricing["sell_price"] = adjusted_sell
            assembly_pricing["margin_dollars"] = round(adjusted_sell - assembly_pricing["total_cost"], 2)
            assembly_pricing["margin_pct"] = round((assembly_pricing["margin_dollars"] / adjusted_sell) * 100, 1) if adjusted_sell > 0 else 0

            max_num = db.execute(
                "SELECT COALESCE(MAX(opening_number),0) FROM openings WHERE quote_id=?", (qid,)
            ).fetchone()[0]

            opening_type = body.get("opening_type", "assembly")
            dp_result = {"status": "pending", "dp_rating_used": None, "noa_number": None, "failure_reason": None}
            if panels and panels[0].get("product_id"):
                p0 = panels[0]
                dp_result = validate_dp(
                    db,
                    tenant_id,
                    p0["product_id"],
                    p0.get("width", total_width),
                    p0.get("height", total_height),
                    body.get("floor_level", 1),
                body.get("hvhz"),
                required_zone=required_zone,
            )

            panel_dp_results = {}
            for panel in panels:
                panel_index = int(_safe_float(panel.get("panel_index"), 0))
                panel_dp = {"status": "pending", "dp_negative": None, "noa_number": None}
                if panel.get("product_id"):
                    panel_dp = validate_dp(
                        db,
                        tenant_id,
                        panel["product_id"],
                        panel.get("width", total_width),
                        panel.get("height", total_height),
                        body.get("floor_level", 1),
                        body.get("hvhz"),
                        required_zone=required_zone,
                    )
                panel_dp_results[panel_index] = panel_dp

            consumables_cost, _ = _calculate_consumables(db, tenant_id, wall_type, opening_count)

            db.execute(
                """INSERT INTO openings
                   (id,quote_id,tenant_id,opening_number,opening_mode,opening_type,
                    total_width,total_height,floor_level,wall_type,
                    glass_option_id,frame_color_id,complexity_ids,photo_url,
                    sell_price,baseline_sell_price,total_cost,margin_pct,margin_dollars,
                    dp_status,dp_rating_used,noa_number,dp_failure_reason,consumables_cost,
                    discount_pct,requested_sell_price,required_zone)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    oid,
                    qid,
                    tenant_id,
                    max_num + 1,
                    "multipart",
                    opening_type,
                    total_width,
                    total_height,
                    body.get("floor_level", 1),
                    wall_type,
                    body.get("glass_option_id"),
                    body.get("frame_color_id"),
                    json.dumps(body.get("complexity_ids", [])),
                    body.get("photo_url"),
                    assembly_pricing["sell_price"],
                    assembly_pricing.get("baseline_sell_price", assembly_pricing["sell_price"]),
                    assembly_pricing["total_cost"],
                    assembly_pricing["margin_pct"],
                    assembly_pricing["margin_dollars"],
                    dp_result["status"],
                    dp_result.get("dp_negative"),
                    dp_result.get("noa_number"),
                    dp_result.get("failure_reason"),
                    consumables_cost,
                    discount_pct,
                    _safe_float(requested_sell_price) if requested_sell_price is not None else None,
                    required_zone,
                ),
            )

            for pr in assembly_pricing["panel_results"]:
                apid = f"ap-{uuid.uuid4().hex[:8]}"
                panel = panels[pr["panel_index"]] if pr["panel_index"] < len(panels) else {}
                panel_dp = panel_dp_results.get(pr["panel_index"], {"status": "pending", "dp_negative": None, "noa_number": None})
                db.execute(
                    """INSERT INTO assembly_panels
                       (id,opening_id,tenant_id,panel_index,panel_label,product_id,
                        glass_option_id,frame_color_id,width,height,
                        sell_price,total_cost,dp_status,dp_rating_used,noa_number)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        apid,
                        oid,
                        tenant_id,
                        pr["panel_index"],
                        pr["panel_label"],
                        panel.get("product_id"),
                        panel.get("glass_option_id") or body.get("glass_option_id"),
                        panel.get("frame_color_id") or body.get("frame_color_id"),
                        pr["width"],
                        pr["height"],
                        pr["pricing"]["sell_price"],
                        pr["pricing"]["total_cost"],
                        panel_dp["status"],
                        panel_dp.get("dp_negative"),
                        panel_dp.get("noa_number"),
                    ),
                )

            totals = _update_quote_totals(db, qid, tenant_id)
            gov_state = _enforce_quote_governance_lock(db, tenant_id, qid, quote["rep_id"])
            _log_price_change(
                db,
                tenant_id,
                qid,
                oid,
                user_id,
                user_name,
                0,
                assembly_pricing["sell_price"],
                {
                    "mode": "multipart",
                    "discount_pct": discount_pct,
                    "dp_status": dp_result.get("status"),
                },
            )

            audit(
                db,
                tenant_id,
                "opening_added",
                "opening",
                oid,
                user_id,
                user_name,
                {
                    "mode": "multipart",
                    "panels": panel_count,
                    "sell_price": assembly_pricing["sell_price"],
                    "required_zone": required_zone,
                    "dp_status": dp_result.get("status"),
                },
                rep_id=user_id,
            )
            db.commit()

            return jsonify(
                {
                    "id": oid,
                    "opening_number": max_num + 1,
                    "pricing": assembly_pricing,
                    "dp": dp_result,
                    "governance": gov_state,
                    "notification_payload": gov_state.get("pending_approval_payload"),
                    "status": "created",
                }
            ), 201

        # Single opening mode.
        product_id = body.get("product_id")
        if not product_id:
            return jsonify({"error": "product_id required for single mode opening"}), 400

        try:
            width = _require_positive_float(body.get("total_width", body.get("width")), "Width")
            height = _require_positive_float(body.get("total_height", body.get("height")), "Height")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        floor_level = int(_safe_float(body.get("floor_level", 1), 1))

        pricing = calculate_price(
            db,
            tenant_id,
            product_id,
            width,
            height,
            floor_level,
            body.get("glass_option_id"),
            body.get("frame_color_id"),
            body.get("complexity_ids", []),
            body.get("zip_code"),
            wall_type,
            opening_count,
            rep_id=quote["rep_id"],
            driveway_discount_pct=discount_pct,
            requested_sell_price=requested_sell_price,
        )
        if not pricing:
            return jsonify({"error": "Invalid product or pricing configuration"}), 400

        dp_result = validate_dp(
            db,
            tenant_id,
            product_id,
            width,
            height,
            floor_level,
            body.get("hvhz"),
            required_zone=required_zone,
        )
        max_num = db.execute(
            "SELECT COALESCE(MAX(opening_number),0) FROM openings WHERE quote_id=?", (qid,)
        ).fetchone()[0]

        complexity_json = json.dumps(body.get("complexity_ids", []))

        db.execute(
            """INSERT INTO openings
               (id,quote_id,tenant_id,opening_number,opening_mode,opening_type,
                total_width,total_height,floor_level,wall_type,
                product_id,glass_option_id,frame_color_id,complexity_ids,photo_url,
                sell_price,baseline_sell_price,total_cost,margin_pct,margin_dollars,
                dp_status,dp_rating_used,noa_number,dp_failure_reason,consumables_cost,
                discount_pct,requested_sell_price,required_zone)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                oid,
                qid,
                tenant_id,
                max_num + 1,
                "single",
                body.get("opening_type", "window"),
                width,
                height,
                floor_level,
                wall_type,
                product_id,
                body.get("glass_option_id"),
                body.get("frame_color_id"),
                complexity_json,
                body.get("photo_url"),
                pricing["sell_price"],
                pricing.get("baseline_sell_price", pricing["sell_price"]),
                pricing["total_cost"],
                pricing["margin_pct"],
                pricing["margin_dollars"],
                dp_result["status"],
                dp_result.get("dp_negative"),
                dp_result.get("noa_number"),
                dp_result.get("failure_reason"),
                pricing["breakdown"]["consumables_cost"],
                pricing.get("discount_pct", 0),
                pricing.get("sell_price") if requested_sell_price is not None else None,
                required_zone,
            ),
        )

        totals = _update_quote_totals(db, qid, tenant_id)
        gov_state = _enforce_quote_governance_lock(db, tenant_id, qid, quote["rep_id"])
        _log_price_change(
            db,
            tenant_id,
            qid,
            oid,
            user_id,
            user_name,
            0,
            pricing["sell_price"],
            {
                "discount_pct": pricing.get("discount_pct", 0),
                "dp_status": dp_result.get("status"),
                "required_zone": required_zone,
            },
        )

        audit(
            db,
            tenant_id,
            "opening_added",
            "opening",
            oid,
            user_id,
            user_name,
            {
                "opening_type": body.get("opening_type"),
                "sell_price": pricing["sell_price"],
                "required_zone": required_zone,
                "dp_status": dp_result.get("status"),
            },
            rep_id=user_id,
        )

        # Section 4A: pricing snapshot on opening save
        gov_rows = db.execute("SELECT * FROM governance_settings WHERE tenant_id=? ORDER BY tier", (tenant_id,)).fetchall()
        pricing_snap_json = json.dumps({
            "product_id": body.get("product_id"),
            "width": body.get("width"),
            "height": body.get("height"),
            "sell_price": pricing.get("sell_price"),
            "base_price": pricing.get("base_price"),
            "glass_adder": pricing.get("glass_adder"),
            "frame_adder": pricing.get("frame_adder"),
            "complexity_total": pricing.get("complexity_total"),
            "floor_adder": pricing.get("floor_adder"),
            "territory_multiplier": pricing.get("territory_multiplier"),
            "consumables_cost": pricing.get("consumables_cost"),
            "margin_pct": pricing.get("margin_pct"),
            "discount_pct": pricing.get("discount_pct", 0),
        })
        gov_snap_json = json.dumps(_json_safe_data([dict(r) for r in gov_rows]))
        db.execute(
            "INSERT INTO pricing_snapshots (id,tenant_id,quote_id,opening_id,snapshot_type,pricing_json,governance_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (f"ps-{uuid.uuid4().hex[:8]}", tenant_id, qid, oid, "opening_save", pricing_snap_json, gov_snap_json, user_id, _now_iso()),
        )
        db.commit()

        return jsonify(
            {
                "id": oid,
                "opening_number": max_num + 1,
                "pricing": pricing,
                "dp": dp_result,
                "governance": gov_state,
                "notification_payload": gov_state.get("pending_approval_payload"),
                "status": "created",
            }
        ), 201

    finally:
        db.close()


@app.route("/api/openings", methods=["POST"])
def create_opening_compat():
    body = request.get_json(force=True) or {}
    quote_id = body.get("quote_id")
    if not quote_id:
        return jsonify({"error": "quote_id required"}), 400
    return create_opening(quote_id)


@app.route("/api/openings/<oid>", methods=["DELETE"])
def delete_opening(oid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)

        opening_row = _load_opening_row_any_tenant(db, oid)
        if not opening_row:
            return jsonify({"error": "Opening not found"}), 404
        _assert_tenant_match(opening_row, auth_ctx, "Opening")
        tenant_id = opening_row["tenant_id"]

        opening = db.execute(
            """SELECT o.quote_id, o.tenant_id, q.rep_id
               FROM openings o
               JOIN quotes q ON q.id=o.quote_id AND q.tenant_id=o.tenant_id
               WHERE o.id=? AND o.tenant_id=?""",
            (oid, tenant_id),
        ).fetchone()
        if not opening:
            return jsonify({"error": "Opening not found"}), 404

        if (not _has_permission_ctx(auth_ctx, "can_view_all_quotes")) and opening["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        db.execute("DELETE FROM assembly_panels WHERE opening_id=? AND tenant_id=?", (oid, tenant_id))
        db.execute("DELETE FROM openings WHERE id=? AND tenant_id=?", (oid, tenant_id))

        totals = _update_quote_totals(db, opening["quote_id"], tenant_id)
        gov_state = _enforce_quote_governance_lock(db, tenant_id, opening["quote_id"], opening["rep_id"])

        audit(
            db,
            tenant_id,
            "opening_deleted",
            "opening",
            oid,
            user_id,
            user_name,
            {
                "quote_id": opening["quote_id"],
                "totals": totals,
                "requires_approval": bool(gov_state.get("requires_approval")),
            },
            rep_id=user_id,
        )
        db.commit()
        return jsonify({"status": "deleted", "totals": totals, "governance": gov_state})
    finally:
        db.close()


@app.route("/api/openings/<oid>", methods=["PUT"])
def update_opening(oid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}
        auth_ctx = getattr(g, "auth", None)

        existing = _load_opening_row_any_tenant(db, oid)
        if not existing:
            return jsonify({"error": "Opening not found"}), 404
        _assert_tenant_match(existing, auth_ctx, "Opening")
        tenant_id = existing["tenant_id"]

        quote = db.execute(
            "SELECT rep_id, required_zone FROM quotes WHERE id=? AND tenant_id=?",
            (existing["quote_id"], tenant_id)
        ).fetchone()
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        if (not _has_permission_ctx(auth_ctx, "can_view_all_quotes")) and quote["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        opening_type = body.get("opening_type", existing["opening_type"])
        width = _safe_float(body.get("total_width", existing["total_width"]), existing["total_width"])
        height = _safe_float(body.get("total_height", existing["total_height"]), existing["total_height"])
        floor_level = int(_safe_float(body.get("floor_level", existing["floor_level"]), existing["floor_level"]))
        wall_type = _normalize_wall_type(body.get("wall_type", existing["wall_type"]), existing["wall_type"])
        product_id = body.get("product_id", existing["product_id"])
        glass_option_id = body.get("glass_option_id", existing["glass_option_id"])
        frame_color_id = body.get("frame_color_id", existing["frame_color_id"])

        complexity_ids = body.get("complexity_ids")
        if complexity_ids is None:
            try:
                complexity_ids = json.loads(existing["complexity_ids"] or "[]")
            except Exception:
                complexity_ids = []

        can_set_discounts = _has_permission_ctx(auth_ctx, "can_set_discounts")
        discount_pct = _safe_float(body.get("discount_pct", existing["discount_pct"]), 0) if can_set_discounts else 0
        requested_sell_price = body.get("requested_sell_price", existing["requested_sell_price"]) if can_set_discounts else None
        required_zone = _resolve_required_zone(
            db,
            tenant_id,
            body.get("required_zone"),
            existing["required_zone"] or quote["required_zone"],
        )
        pricing = calculate_price(
            db,
            tenant_id,
            product_id,
            width,
            height,
            floor_level,
            glass_option_id,
            frame_color_id,
            complexity_ids,
            body.get("zip_code"),
            wall_type,
            1,
            rep_id=quote["rep_id"],
            driveway_discount_pct=discount_pct,
            requested_sell_price=requested_sell_price,
        )
        if not pricing:
            return jsonify({"error": "Unable to recalculate opening pricing"}), 400

        dp_result = validate_dp(
            db,
            tenant_id,
            product_id,
            width,
            height,
            floor_level,
            body.get("hvhz"),
            required_zone=required_zone,
        )
        db.execute(
            """UPDATE openings
               SET opening_type=?, total_width=?, total_height=?, floor_level=?, wall_type=?,
                   product_id=?, glass_option_id=?, frame_color_id=?, complexity_ids=?, photo_url=?,
                   sell_price=?, baseline_sell_price=?, total_cost=?, margin_pct=?, margin_dollars=?,
                   dp_status=?, dp_rating_used=?, noa_number=?, dp_failure_reason=?,
                   consumables_cost=?, discount_pct=?, requested_sell_price=?, required_zone=?
               WHERE id=? AND tenant_id=?""",
            (
                opening_type,
                width,
                height,
                floor_level,
                wall_type,
                product_id,
                glass_option_id,
                frame_color_id,
                json.dumps(complexity_ids),
                body.get("photo_url", existing["photo_url"]),
                pricing["sell_price"],
                pricing.get("baseline_sell_price", pricing["sell_price"]),
                pricing["total_cost"],
                pricing["margin_pct"],
                pricing["margin_dollars"],
                dp_result.get("status"),
                dp_result.get("dp_negative"),
                dp_result.get("noa_number"),
                dp_result.get("failure_reason"),
                pricing["breakdown"]["consumables_cost"],
                pricing.get("discount_pct", 0),
                pricing.get("sell_price") if requested_sell_price is not None else None,
                required_zone,
                oid,
                tenant_id,
            ),
        )

        totals = _update_quote_totals(db, existing["quote_id"], tenant_id)
        gov_state = _enforce_quote_governance_lock(db, tenant_id, existing["quote_id"], quote["rep_id"])

        _log_price_change(
            db,
            tenant_id,
            existing["quote_id"],
            oid,
            user_id,
            user_name,
            existing["sell_price"],
            pricing["sell_price"],
            {
                "dp_status": dp_result.get("status"),
                "required_zone": required_zone,
            },
        )

        # Section 4A: pricing snapshot on opening update
        gov_rows_upd = db.execute("SELECT * FROM governance_settings WHERE tenant_id=? ORDER BY tier", (tenant_id,)).fetchall()
        db.execute(
            "INSERT INTO pricing_snapshots (id,tenant_id,quote_id,opening_id,snapshot_type,pricing_json,governance_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
            (f"ps-{uuid.uuid4().hex[:8]}", tenant_id, existing["quote_id"], oid, "opening_save",
             json.dumps({"sell_price": pricing["sell_price"], "margin_pct": pricing.get("margin_pct"), "discount_pct": pricing.get("discount_pct", 0)}),
             json.dumps(_json_safe_data([dict(r) for r in gov_rows_upd])), user_id, _now_iso()),
        )
        db.commit()
        return jsonify({
            "status": "updated",
            "pricing": pricing,
            "dp": dp_result,
            "governance": gov_state,
            "totals": totals,
        })
    finally:
        db.close()


@app.route("/api/openings/<oid>", methods=["PATCH"])
def patch_opening_price(oid):
    """Update only the sell_price of an opening (Tier 4: per-opening price slider)."""
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}
        auth_ctx = getattr(g, "auth", None)

        existing = _load_opening_row_any_tenant(db, oid)
        if not existing:
            return jsonify({"error": "Opening not found"}), 404
        _assert_tenant_match(existing, auth_ctx, "Opening")
        tenant_id = existing["tenant_id"]

        quote = db.execute(
            "SELECT rep_id FROM quotes WHERE id=? AND tenant_id=?",
            (existing["quote_id"], tenant_id)
        ).fetchone()
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        if (not _has_permission_ctx(auth_ctx, "can_view_all_quotes")) and quote["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        sell_price = body.get("sell_price")
        if sell_price is None:
            return jsonify({"error": "sell_price required"}), 400

        sell_price = _safe_float(sell_price, existing["sell_price"])
        if sell_price <= 0:
            return jsonify({"error": "sell_price must be positive"}), 400

        total_cost = _safe_float(existing["total_cost"], 0)
        margin_dollars = round(sell_price - total_cost, 2)
        margin_pct = round((margin_dollars / sell_price) * 100, 1) if sell_price > 0 else 0.0
        discount_pct = round((1 - sell_price / existing["baseline_sell_price"]) * 100, 2) if existing.get("baseline_sell_price", 0) > 0 else 0.0

        db.execute(
            """UPDATE openings
               SET sell_price=?, margin_dollars=?, margin_pct=?, discount_pct=?
               WHERE id=? AND tenant_id=?""",
            (sell_price, margin_dollars, margin_pct, discount_pct, oid, tenant_id)
        )

        totals = _update_quote_totals(db, existing["quote_id"], tenant_id)

        _log_price_change(
            db,
            tenant_id,
            existing["quote_id"],
            oid,
            user_id,
            user_name,
            existing["sell_price"],
            sell_price,
            {"reason": "price_slider"},
        )

        db.commit()
        return jsonify({
            "status": "updated",
            "opening_id": oid,
            "sell_price": sell_price,
            "margin_pct": margin_pct,
            "margin_dollars": margin_dollars,
            "discount_pct": discount_pct,
            "totals": totals,
        })
    finally:
        db.close()


# ---------------------------------------------------------------------------
# QUOTE SUBMIT / DECIDE (approval workflow)
# ---------------------------------------------------------------------------

@app.route("/api/quotes/<qid>/submit", methods=["POST"])
def submit_quote(qid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        auth_ctx = getattr(g, "auth", None)

        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        tenant_id = quote["tenant_id"]

        if (not _has_permission_ctx(auth_ctx, "can_view_all_quotes")) and quote["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        opening_count = db.execute(
            "SELECT COUNT(*) FROM openings WHERE quote_id=? AND tenant_id=?",
            (qid, tenant_id),
        ).fetchone()[0]
        if opening_count == 0:
            return jsonify({"error": "Add at least one opening before requesting approval"}), 400

        current_margin = _safe_float(body.get("current_margin", quote["margin_pct"]), 0)
        rep_id = quote["rep_id"]
        if _has_permission_ctx(auth_ctx, "can_view_all_quotes") and body.get("rep_id"):
            rep_id = body.get("rep_id")
        rep_note = _sanitize_text_field(body.get("rep_note"), MAX_APPROVAL_NOTE_LENGTH)

        arid = _ensure_pending_approval_request(
            db,
            tenant_id,
            qid,
            rep_id,
            current_margin,
            rep_note=rep_note,
        )

        gov_state = _enforce_quote_governance_lock(db, tenant_id, qid, rep_id, rep_note=rep_note)

        audit(
            db,
            tenant_id,
            "approval_requested",
            "quote",
            qid,
            rep_id,
            user_name,
            {
                "margin": current_margin,
                "requested_margin": body.get("requested_margin", current_margin),
                "note": rep_note,
                "reasons": gov_state.get("reasons", []),
            },
            rep_id=rep_id,
        )

        # Section 4A: pricing snapshot on approval request
        q_snap = db.execute("SELECT * FROM quotes WHERE id=? AND tenant_id=?", (qid, tenant_id)).fetchone()
        gov_rows_ar = db.execute("SELECT * FROM governance_settings WHERE tenant_id=? ORDER BY tier", (tenant_id,)).fetchall()
        if q_snap:
            db.execute(
                "INSERT INTO pricing_snapshots (id,tenant_id,quote_id,opening_id,snapshot_type,pricing_json,governance_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)",
                (f"ps-{uuid.uuid4().hex[:8]}", tenant_id, qid, None, "approval_request",
                 json.dumps({"total_price": dict(q_snap).get("total_price"), "margin_pct": current_margin}),
                 json.dumps(_json_safe_data([dict(r) for r in gov_rows_ar])), rep_id, _now_iso()),
            )
        db.commit()

        return jsonify(
            {
                "id": arid,
                "status": "pending",
                "notification_payload": gov_state.get("pending_approval_payload"),
            }
        ), 201
    finally:
        db.close()


@app.route("/api/quotes/<qid>/decide", methods=["POST"])
def decide_quote(qid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}
        owner_note = _sanitize_text_field(body.get("owner_note"), MAX_OWNER_NOTE_LENGTH)
        auth_ctx = getattr(g, "auth", None)

        action = body.get("action", "approve")
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        tenant_id = quote["tenant_id"]

        ar = db.execute(
            "SELECT * FROM approval_requests WHERE quote_id=? AND tenant_id=? AND status='pending' ORDER BY created_at DESC LIMIT 1",
            (qid, tenant_id)
        ).fetchone()

        new_status = "approved" if action == "approve" else "denied"
        quote_status = "approved" if action == "approve" else "denied"

        if ar:
            db.execute(
                """UPDATE approval_requests
                   SET status=?, owner_note=?, decided_by=?, decided_at=? WHERE id=?""",
                (
                    new_status,
                    owner_note,
                    user_id,
                    datetime.now().isoformat(),
                    ar["id"],
                ),
            )

        db.execute(
            "UPDATE quotes SET status=?, pending_approval_payload=?, updated_at=? WHERE id=? AND tenant_id=?",
            (quote_status, None, datetime.now().isoformat(), qid, tenant_id),
        )

        audit(
            db,
            tenant_id,
            f"approval_{new_status}",
            "quote",
            qid,
            user_id,
            user_name,
            {"action": action, "note": owner_note},
            rep_id=user_id,
        )
        db.commit()
        return jsonify({"status": new_status, "quote_id": qid})
    finally:
        db.close()


@app.route("/api/quotes/<qid>/proposal/snapshot", methods=["POST"])
def create_proposal_snapshot(qid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        actor_role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx and auth_ctx.get("user") else "rep"
        if actor_role not in ("rep", "manager", "owner", "sysop"):
            return jsonify({"error": "Only reps, managers, or owners can generate proposal snapshots"}), 403

        quote_row = _load_quote_access_row(db, None, qid)
        if not quote_row:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote_row, auth_ctx, "Quote")
        tenant_id = quote_row["tenant_id"]
        if not _auth_can_access_quote(auth_ctx, quote_row):
            return jsonify({"error": "Forbidden"}), 403

        created_at = _now_iso()
        payload = _build_proposal_snapshot_payload(db, tenant_id, qid, generated_at=created_at)
        openings = payload.get("openings") if payload else []
        if not openings:
            return jsonify({"error": "Add at least one opening before generating a proposal"}), 400

        snapshot_id = f"ps-{uuid.uuid4().hex[:12]}"
        db.execute(
            """INSERT INTO proposal_snapshots
               (id,tenant_id,quote_id,generated_by,quote_snapshot,pdf_gcs_path,created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (
                snapshot_id,
                tenant_id,
                qid,
                user_id,
                json.dumps(payload),
                None,
                created_at,
            ),
        )

        audit(
            db,
            tenant_id,
            "proposal_snapshot_created",
            "quote",
            qid,
            user_id,
            user_name,
            {"snapshot_id": snapshot_id},
            rep_id=quote_row["rep_id"],
        )
        db.commit()
        return jsonify({"snapshot_id": snapshot_id, "created_at": created_at}), 201
    finally:
        db.close()


@app.route("/api/quotes/<qid>/proposal/snapshot/<sid>/print", methods=["GET"])
def print_proposal_snapshot(qid, sid):
    db = get_db()
    try:
        token = (request.args.get("token") or "").strip()
        share_row = _load_active_share_row(db, token, qid=qid, sid=sid) if token else None
        snapshot_row = None

        if share_row:
            snapshot_row = _load_snapshot_row(db, share_row["tenant_id"], qid, sid)

        if not snapshot_row:
            auth_ctx = _load_auth_context(db, request)
            if not auth_ctx:
                return _simple_html_page(
                    "Proposal unavailable",
                    "Sign in or use a valid estimate link to view this proposal.",
                    status=403,
                )

            quote_row = _load_quote_access_row(db, None, qid)
            if not quote_row:
                return _simple_html_page(
                    "Proposal unavailable",
                    "This proposal snapshot could not be found.",
                    status=404,
                )
            try:
                _assert_tenant_match(quote_row, auth_ctx, "Quote")
            except HTTPException:
                return _simple_html_page(
                    "Proposal unavailable",
                    "You do not have access to this proposal snapshot.",
                    status=403,
                )
            if not _auth_can_access_quote(auth_ctx, quote_row):
                return _simple_html_page(
                    "Proposal unavailable",
                    "You do not have access to this proposal snapshot.",
                    status=403,
                )

            snapshot_row = _load_snapshot_row(db, auth_ctx["tenant_id"], qid, sid)
            if not snapshot_row:
                return _simple_html_page(
                    "Snapshot not found",
                    "This proposal snapshot could not be found.",
                    status=404,
                )

            if not share_row:
                share_row = _latest_active_share_for_snapshot(db, auth_ctx["tenant_id"], qid, sid)

        if not snapshot_row:
            return _simple_html_page(
                "Snapshot not found",
                "This proposal snapshot could not be found.",
                status=404,
            )

        context = _build_proposal_render_context(snapshot_row, share_row=share_row, share_token=token or None)
        html_doc = render_template_string(PROPOSAL_HTML_TEMPLATE, **context)
        return Response(html_doc, mimetype="text/html")
    finally:
        db.close()


@app.route("/api/quotes/<qid>/proposal/share", methods=["POST"])
def create_proposal_share(qid):
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        actor_role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx and auth_ctx.get("user") else "rep"
        if actor_role not in ("manager", "owner", "sysop"):
            return jsonify({"error": "Only managers or owners can share proposal links"}), 403

        quote_row = _load_quote_access_row(db, None, qid)
        if not quote_row:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote_row, auth_ctx, "Quote")
        tenant_id = quote_row["tenant_id"]
        if not _auth_can_access_quote(auth_ctx, quote_row):
            return jsonify({"error": "Forbidden"}), 403

        body = request.get_json(force=True) or {}
        snapshot_id = _sanitize_text_field(body.get("snapshot_id"), 80)
        if not snapshot_id:
            return jsonify({"error": "snapshot_id is required"}), 400

        snapshot_row = _load_snapshot_row(db, tenant_id, qid, snapshot_id)
        if not snapshot_row:
            return jsonify({"error": "Snapshot not found"}), 404

        try:
            expires_at = _normalize_share_expiry(body.get("expires_at"))
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        share_id = f"share-{uuid.uuid4().hex[:12]}"
        token = secrets.token_hex(16)
        created_at = _now_iso()
        db.execute(
            """INSERT INTO proposal_shares
               (id,tenant_id,quote_id,snapshot_id,created_by,token,expires_at,viewed_count,last_viewed_at,customer_response,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                share_id,
                tenant_id,
                qid,
                snapshot_id,
                user_id,
                token,
                expires_at,
                0,
                None,
                None,
                created_at,
            ),
        )

        share_url = _absolute_public_url(f"/estimate/{token}")
        print_url = _absolute_public_url(f"/api/quotes/{qid}/proposal/snapshot/{snapshot_id}/print?token={token}")

        audit(
            db,
            tenant_id,
            "proposal_share_created",
            "quote",
            qid,
            user_id,
            user_name,
            {"snapshot_id": snapshot_id, "share_id": share_id, "expires_at": expires_at},
            rep_id=quote_row["rep_id"],
        )
        db.commit()
        return jsonify(
            {
                "id": share_id,
                "token": token,
                "share_url": share_url,
                "print_url": print_url,
                "expires_at": expires_at,
                "created_at": created_at,
            }
        ), 201
    finally:
        db.close()


@app.route("/estimate/<token>", methods=["GET"])
def view_public_estimate(token):
    db = get_db()
    try:
        share_row = _load_active_share_row(db, token)
        if not share_row:
            return _simple_html_page(
                "Link not found or expired",
                "This estimate link is no longer available.",
                status=404,
            )

        snapshot_row = _load_snapshot_row(db, share_row["tenant_id"], share_row["quote_id"], share_row["snapshot_id"])
        if not snapshot_row:
            return _simple_html_page(
                "Link not found or expired",
                "This estimate link is no longer available.",
                status=404,
            )

        last_viewed_at = _now_iso()
        db.execute(
            """UPDATE proposal_shares
               SET viewed_count=COALESCE(viewed_count, 0) + 1,
                   last_viewed_at=?
               WHERE id=? AND tenant_id=?""",
            (last_viewed_at, share_row["id"], share_row["tenant_id"]),
        )
        db.commit()

        share_row = db.execute(
            """SELECT ps.*, u.name AS created_by_name
               FROM proposal_shares ps
               LEFT JOIN users u ON u.id=ps.created_by AND u.tenant_id=ps.tenant_id
               WHERE ps.id=? AND ps.tenant_id=?""",
            (share_row["id"], share_row["tenant_id"]),
        ).fetchone()

        context = _build_proposal_render_context(snapshot_row, share_row=share_row, share_token=token)
        html_doc = render_template_string(ESTIMATE_PORTAL_HTML_TEMPLATE, **context)
        return Response(html_doc, mimetype="text/html")
    finally:
        db.close()


@app.route("/estimate/<token>/respond", methods=["POST"])
def respond_public_estimate(token):
    db = get_db()
    try:
        share_row = _load_active_share_row(db, token)
        if not share_row:
            return jsonify({"error": "Link not found or expired"}), 404

        body = request.get_json(force=True) or {}
        action = _sanitize_text_field(body.get("action"), 32)
        if action not in ("accept", "request_changes"):
            return jsonify({"error": "action must be 'accept' or 'request_changes'"}), 400

        note = _sanitize_text_field(body.get("note"), MAX_JOB_MESSAGE_LENGTH)
        responded_at = _now_iso()
        customer_response = json.dumps(
            {
                "action": action,
                "note": note,
                "responded_at": responded_at,
            }
        )

        db.execute(
            "UPDATE proposal_shares SET customer_response=? WHERE id=? AND tenant_id=?",
            (customer_response, share_row["id"], share_row["tenant_id"]),
        )

        creator_row = db.execute(
            "SELECT name FROM users WHERE id=? AND tenant_id=?",
            (share_row["created_by"], share_row["tenant_id"]),
        ).fetchone()

        message_text = f"Customer responded via estimate link: {action}"
        if note:
            message_text = f"{message_text} - {note}"

        _insert_job_message(
            db,
            {
                "id": f"jm-{uuid.uuid4().hex[:10]}",
                "tenant_id": share_row["tenant_id"],
                "quote_id": share_row["quote_id"],
                "user_id": share_row["created_by"],
                "user_name": creator_row["name"] if creator_row else (_row_get(share_row, "created_by_name") or "Estimate Portal"),
                "content": message_text,
                "delivery_channel": "in_app",
            },
        )

        audit(
            db,
            share_row["tenant_id"],
            "proposal_share_responded",
            "quote",
            share_row["quote_id"],
            share_row["created_by"],
            creator_row["name"] if creator_row else (_row_get(share_row, "created_by_name") or "Estimate Portal"),
            {"action": action, "note": note, "share_id": share_row["id"]},
            rep_id=share_row["created_by"],
        )
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


@app.route("/api/quotes/<qid>/proposal/snapshots", methods=["GET"])
def list_proposal_snapshots(qid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)

        quote_row = _load_quote_access_row(db, None, qid)
        if not quote_row:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote_row, auth_ctx, "Quote")
        tenant_id = quote_row["tenant_id"]
        if not _auth_can_access_quote(auth_ctx, quote_row):
            return jsonify({"error": "Forbidden"}), 403

        rows = db.execute(
            """SELECT ps.id,
                      ps.created_at,
                      ps.generated_by,
                      u.name AS generated_by_name,
                      CASE
                        WHEN EXISTS(
                            SELECT 1
                            FROM proposal_shares sh
                            WHERE sh.snapshot_id=ps.id AND sh.tenant_id=ps.tenant_id
                        ) THEN 1
                        ELSE 0
                      END AS has_share
               FROM proposal_snapshots ps
               LEFT JOIN users u ON u.id=ps.generated_by AND u.tenant_id=ps.tenant_id
               WHERE ps.quote_id=? AND ps.tenant_id=?
               ORDER BY ps.created_at DESC, ps.id DESC""",
            (qid, tenant_id),
        ).fetchall()

        return jsonify(
            [
                {
                    "id": row["id"],
                    "created_at": _json_safe_data(row["created_at"]),
                    "generated_by": row["generated_by"],
                    "generated_by_name": row["generated_by_name"],
                    "has_share": bool(row["has_share"]),
                }
                for row in rows
            ]
        )
    finally:
        db.close()


@app.route("/api/approvals", methods=["GET"])
def get_approvals():
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        status_filter = request.args.get("status")
        rep_id = request.args.get("rep_id")

        query = """SELECT ar.*, q.customer_name, q.job_address, q.total_price, q.margin_pct as quote_margin,
                          q.rep_id as quote_rep_id, u.name as rep_name, u.tier as rep_tier
                   FROM approval_requests ar
                   JOIN quotes q ON ar.quote_id=q.id
                   LEFT JOIN users u ON ar.rep_id=u.id
                   WHERE ar.tenant_id=?"""
        vals = [tenant_id]
        if status_filter:
            query += " AND ar.status=?"
            vals.append(status_filter)
        if rep_id:
            query += " AND ar.rep_id=?"
            vals.append(rep_id)
        if not _has_permission_ctx(auth_ctx, "can_view_all_quotes"):
            query += " AND ar.rep_id=?"
            vals.append(user_id)
        query += " ORDER BY ar.created_at DESC"

        rows = db.execute(query, vals).fetchall()
        result = []
        for row in rows:
            item = dict(row)
            item["rep_note"] = _sanitize_text_field(item.get("rep_note"), MAX_APPROVAL_NOTE_LENGTH)
            item["owner_note"] = _sanitize_text_field(item.get("owner_note"), MAX_OWNER_NOTE_LENGTH)
            effective_governance = _get_governance_for_rep(db, tenant_id, item.get("quote_rep_id") or item.get("rep_id"))
            item["margin_floor"] = effective_governance.get("margin_floor", 30.0) if effective_governance else 30.0
            item["quote_total"] = item.get("total_price", 0)
            result.append(item)
        return jsonify(result)
    finally:
        db.close()


@app.route("/api/approvals", methods=["POST"])
def create_approval():
    body = request.get_json(force=True) or {}
    quote_id = body.get("quote_id")
    if not quote_id:
        return jsonify({"error": "quote_id required"}), 400
    return submit_quote(quote_id)


@app.route("/api/approvals/<arid>", methods=["PUT"])
def decide_approval(arid):
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        row = db.execute(
            "SELECT quote_id FROM approval_requests WHERE id=? AND tenant_id=?",
            (arid, tenant_id)
        ).fetchone()
        if not row:
            return jsonify({"error": "Approval request not found"}), 404
    finally:
        db.close()
    return decide_quote(row["quote_id"])


# ---------------------------------------------------------------------------
# CALCULATE PRICE (standalone)
# ---------------------------------------------------------------------------

@app.route("/api/calculate-price", methods=["POST"])
@app.route("/api/calculate", methods=["POST"])
def api_calculate_price():
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        body = request.get_json(force=True) or {}

        product_id = body.get("product_id")
        if not product_id:
            return jsonify({"error": "product_id required"}), 400
        try:
            width = _require_positive_float(body.get("width"), "Width")
            height = _require_positive_float(body.get("height"), "Height")
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400

        quote_id = body.get("quote_id")
        quote = None
        if quote_id:
            quote = db.execute(
                "SELECT * FROM quotes WHERE id=? AND tenant_id=?",
                (quote_id, tenant_id)
            ).fetchone()
            if quote and (not _has_permission_ctx(auth_ctx, "can_view_all_quotes")) and quote["rep_id"] != user_id:
                return jsonify({"error": "Forbidden"}), 403

        required_zone = _resolve_required_zone(
            db,
            tenant_id,
            body.get("required_zone"),
            quote["required_zone"] if quote else None,
        )

        rep_id = quote["rep_id"] if quote else user_id
        if (not quote) and _has_permission_ctx(auth_ctx, "can_view_all_quotes") and body.get("rep_id"):
            rep_id = body.get("rep_id")

        can_set_discounts = _has_permission_ctx(auth_ctx, "can_set_discounts")
        discount_pct = body.get("driveway_discount_pct", 0) if can_set_discounts else 0
        requested_sell_price = body.get("requested_sell_price") if can_set_discounts else None

        pricing = calculate_price(
            db,
            tenant_id,
            product_id,
            width,
            height,
            body.get("floor_level", 1),
            body.get("glass_option_id"),
            body.get("frame_color_id"),
            body.get("complexity_ids", []),
            body.get("zip_code"),
            _normalize_wall_type(body.get("wall_type", "cbs")),
            body.get("opening_count", 1),
            rep_id=rep_id,
            driveway_discount_pct=discount_pct,
            requested_sell_price=requested_sell_price,
        )
        if not pricing:
            return jsonify({"error": "Invalid product or pricing configuration"}), 400

        dp_result = validate_dp(
            db,
            tenant_id,
            product_id,
            width,
            height,
            body.get("floor_level", 1),
            body.get("hvhz"),
            required_zone=required_zone,
        )

        pricing["required_zone"] = required_zone
        pricing["dp"] = dp_result
        pricing["noa_warning"] = dp_result.get("status") in ("failed", "warning")

        # Prepare approval payload for Admin Hub when a below-floor discount is requested.
        if pricing.get("requires_approval"):
            ref_quote = dict(quote) if quote else {
                "id": quote_id or "preview",
                "rep_id": rep_id,
                "customer_name": body.get("customer_name"),
                "job_address": body.get("job_address"),
                "total_price": pricing.get("sell_price"),
                "total_cost": pricing.get("total_cost"),
                "margin_pct": pricing.get("margin_pct"),
            }
            rep = _get_user_row(db, tenant_id, rep_id)
            payload = _build_approval_notification_payload(
                ref_quote,
                dict(rep) if rep else None,
                pricing.get("governance", {}),
                _sanitize_text_field(body.get("rep_note"), MAX_APPROVAL_NOTE_LENGTH),
            )
            pricing["notification_payload"] = payload

        return jsonify(pricing)
    finally:
        db.close()


# ---------------------------------------------------------------------------
# AUDIT LOG
# ---------------------------------------------------------------------------

@app.route("/api/audit-log", methods=["GET"])
def get_audit_log():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        limit = int(request.args.get("limit", "50"))
        entity_type = request.args.get("entity_type")
        entity_id = request.args.get("entity_id")
        user_id = request.args.get("user_id")
        query = "SELECT * FROM audit_log WHERE tenant_id=?"
        vals = [tenant_id]
        if entity_type:
            query += " AND entity_type=?"
            vals.append(entity_type)
        if entity_id:
            query += " AND entity_id=?"
            vals.append(entity_id)
        if user_id:
            query += " AND (user_id=? OR rep_id=?)"
            vals.extend([user_id, user_id])
        query += " ORDER BY created_at DESC LIMIT ?"
        vals.append(limit)
        rows = db.execute(query, vals).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


# ---------------------------------------------------------------------------
# AUTH + SYSTEM + USERS
# ---------------------------------------------------------------------------

@app.route("/api/login", methods=["POST"])
def login():
    db = get_db()
    try:
        # Brute-force protection — DB-backed, survives restarts and multi-instance
        client_ip = request.headers.get("X-Forwarded-For", request.remote_addr or "unknown").split(",")[0].strip()
        if not _db_check_rate_limit(db, f"login:{client_ip}", _LOGIN_MAX_ATTEMPTS, _LOGIN_WINDOW_SECONDS):
            return jsonify({"error": "Too many login attempts. Please wait 5 minutes and try again."}), 429

        body = request.get_json(force=True) or {}

        email = _normalize_email(body.get("email"))
        password = body.get("password") or ""
        tenant_id = (body.get("tenant_id") or "").strip()

        if not email or not password:
            return jsonify({"error": "email and password are required"}), 400

        if tenant_id:
            candidates = db.execute(
                "SELECT * FROM users WHERE lower(email)=? AND tenant_id=? AND active=1",
                (email, tenant_id),
            ).fetchall()
        else:
            candidates = db.execute(
                "SELECT * FROM users WHERE lower(email)=? AND active=1 ORDER BY tenant_id, created_at",
                (email,),
            ).fetchall()

        matching = [row for row in candidates if _verify_password(password, row["password_hash"])]
        if not matching:
            _db_record_attempt(db, f"login:{client_ip}")
            # Consistent timing — prevent user enumeration via response time
            time.sleep(0.15)
            return jsonify({"error": "Invalid credentials"}), 401
        if not tenant_id and len(matching) > 1:
            tenant_choices = []
            for user_row in matching:
                tenant_row = _get_tenant_row(db, user_row["tenant_id"])
                tenant_choices.append(_tenant_public_dict(tenant_row, user_row))
            return jsonify({
                "error": "tenant_selection_required",
                "message": "Multiple companies match this login. Choose the company you want to open.",
                "tenants": tenant_choices,
            }), 409

        user = matching[0]

        _db_clear_attempts(db, f"login:{client_ip}")  # Clear brute-force counter on success
        token, expires_at = _issue_auth_session(db, user)
        payload = _build_auth_payload(db, user, expires_at=expires_at)
        resp = make_response(jsonify(payload), 200)
        _set_auth_cookie(resp, token, expires_at)
        return resp
    finally:
        db.close()


@app.route("/api/logout", methods=["POST"])
def logout():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if auth_ctx:
            _revoke_auth_session(db, auth_ctx["session_id"])
            db.commit()

        resp = make_response(jsonify({"status": "logged_out"}), 200)
        _clear_auth_cookie(resp)
        return resp
    finally:
        db.close()


@app.route("/api/me", methods=["GET"])
def me():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx:
            return jsonify({"error": "Not authenticated"}), 401
        user = db.execute(
            "SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1",
            (auth_ctx["user"]["id"], auth_ctx["tenant_id"]),
        ).fetchone()
        if not user:
            return jsonify({"error": "User not found"}), 404
        return jsonify(_build_auth_payload(db, user, impersonated_by=auth_ctx.get("impersonated_by")))
    finally:
        db.close()


@app.route("/api/onboarding", methods=["GET"])
def get_onboarding_status():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx:
            return jsonify({"error": "Not authenticated"}), 401
        tenant_id = auth_ctx["tenant_id"]
        status = _get_onboarding_status(db, tenant_id, persist_complete=True)
        db.commit()
        return jsonify(status)
    finally:
        db.close()


@app.route("/api/onboarding/dismiss", methods=["POST"])
def dismiss_onboarding():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx or not auth_ctx.get("user"):
            return jsonify({"error": "Not authenticated"}), 401

        actor_role = _role_normalize(auth_ctx["user"]["role"])
        if actor_role not in ("owner", "manager"):
            return jsonify({"error": "Forbidden"}), 403

        tenant_id = auth_ctx["tenant_id"]
        status = _get_onboarding_status(db, tenant_id, persist_complete=False)
        db.execute(
            "UPDATE tenants SET onboarding_state='complete', onboarding_completed_steps=? WHERE id=?",
            (json.dumps(status.get("completed_steps") or []), tenant_id),
        )
        audit(
            db,
            tenant_id,
            "onboarding_dismissed",
            "tenant",
            tenant_id,
            auth_ctx["user"]["id"],
            auth_ctx["user"]["name"],
            {"completed_steps": status.get("completed_steps") or []},
            rep_id=auth_ctx["user"]["id"],
        )
        db.commit()
        return jsonify({"ok": True, "state": "complete"})
    finally:
        db.close()


@app.route("/api/session/switch-tenant", methods=["POST"])
def switch_tenant():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx:
            return jsonify({"error": "Not authenticated"}), 401
        if auth_ctx.get("impersonated_by"):
            return jsonify({"error": "Return to your original session before switching companies"}), 400

        body = request.get_json(force=True) or {}
        target_tenant_id = (body.get("tenant_id") or "").strip()
        if not target_tenant_id:
            return jsonify({"error": "tenant_id required"}), 400

        current_user = db.execute(
            "SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1",
            (auth_ctx["user"]["id"], auth_ctx["tenant_id"]),
        ).fetchone()
        if not current_user:
            return jsonify({"error": "Current user not found"}), 404

        if current_user["tenant_id"] == target_tenant_id:
            return jsonify(_build_auth_payload(db, current_user))

        target_user = db.execute(
            "SELECT * FROM users WHERE tenant_id=? AND lower(email)=? AND active=1",
            (target_tenant_id, _normalize_email(current_user["email"])),
        ).fetchone()
        if not target_user and _role_normalize(current_user["role"]) == "sysop":
            _create_user_record(
                db,
                target_tenant_id,
                current_user["name"],
                current_user["email"],
                "sysop",
                tier=current_user["tier"],
                password_hash=current_user["password_hash"],
                must_change_password=0,
                active=1,
            )
            target_user = db.execute(
                "SELECT * FROM users WHERE tenant_id=? AND lower(email)=? AND active=1",
                (target_tenant_id, _normalize_email(current_user["email"])),
            ).fetchone()

        if not target_user:
            return jsonify({"error": "This login does not have access to the selected company"}), 403

        _revoke_auth_session(db, auth_ctx["session_id"])
        token, expires_at = _issue_auth_session(db, target_user)
        payload = _build_auth_payload(db, target_user, expires_at=expires_at)
        db.commit()
        resp = make_response(jsonify(payload), 200)
        _set_auth_cookie(resp, token, expires_at)
        return resp
    finally:
        db.close()


@app.route("/api/change-password", methods=["POST"])
def change_password():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx:
            return jsonify({"error": "Not authenticated"}), 401

        body = request.get_json(force=True) or {}

        actor = auth_ctx["user"]
        target_user_id = body.get("target_user_id") or actor["id"]
        new_password = body.get("new_password") or ""

        if len(new_password) < 8:
            return jsonify({"error": "new_password must be at least 8 characters"}), 400

        target = db.execute(
            "SELECT * FROM users WHERE id=? AND tenant_id=?",
            (target_user_id, auth_ctx["tenant_id"]),
        ).fetchone()
        if not target:
            return jsonify({"error": "Target user not found"}), 404

        # Self-service path requires current password.
        if target_user_id == actor["id"]:
            current_password = body.get("current_password") or ""
            if not _verify_password(current_password, target["password_hash"]):
                return jsonify({"error": "Current password is incorrect"}), 401
        else:
            if not _has_permission_ctx(auth_ctx, "can_reset_passwords"):
                return jsonify({"error": "Forbidden"}), 403

        db.execute(
            "UPDATE users SET password_hash=?, must_change_password=0 WHERE id=? AND tenant_id=?",
            (_hash_password(new_password), target_user_id, auth_ctx["tenant_id"]),
        )
        audit(
            db,
            auth_ctx["tenant_id"],
            "password_changed",
            "user",
            target_user_id,
            actor["id"],
            actor["name"],
            {"self_service": target_user_id == actor["id"]},
            rep_id=actor["id"],
        )
        db.commit()
        return jsonify({"status": "updated"})
    finally:
        db.close()


@app.route("/api/feature-flags", methods=["GET"])
def get_feature_flags():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        rows = db.execute(
            "SELECT * FROM feature_flags WHERE tenant_id=? ORDER BY flag_key",
            (tenant_id,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/feature-flags", methods=["PUT"])
def upsert_feature_flags():
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        body = request.get_json(force=True) or {}

        flags = body.get("flags") if isinstance(body.get("flags"), list) else [body]
        updated = 0
        for fl in flags:
            key = (fl.get("flag_key") or "").strip()
            if not key:
                continue
            db.execute(
                """INSERT INTO feature_flags (id,tenant_id,flag_key,enabled,config_json,updated_at)
                   VALUES (?,?,?,?,?,?)
                   ON CONFLICT(tenant_id,flag_key)
                   DO UPDATE SET enabled=excluded.enabled, config_json=excluded.config_json, updated_at=excluded.updated_at""",
                (
                    f"ff-{uuid.uuid4().hex[:8]}",
                    tenant_id,
                    key,
                    1 if fl.get("enabled", True) else 0,
                    json.dumps(fl.get("config_json")) if isinstance(fl.get("config_json"), (dict, list)) else fl.get("config_json"),
                    _now_iso(),
                ),
            )
            updated += 1

        audit(db, tenant_id, "feature_flags_updated", "settings", "feature_flags", user_id, user_name, {"count": updated}, rep_id=user_id)
        db.commit()
        return jsonify({"status": "updated", "count": updated})
    finally:
        db.close()


@app.route("/api/system/tenants", methods=["GET"])
def system_tenants():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not _is_sysop_ctx(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        rows = db.execute("SELECT * FROM tenants ORDER BY name").fetchall()
        out = []
        for t in rows:
            role_counts = db.execute(
                "SELECT role, COUNT(*) as c FROM users WHERE tenant_id=? GROUP BY role",
                (t["id"],),
            ).fetchall()
            health = _build_tenant_health_summary(db, t["id"], tenant_row=t)
            quote_count = db.execute("SELECT COUNT(*) AS c FROM quotes WHERE tenant_id=?", (t["id"],)).fetchone()
            onboarding = health.get("onboarding") if health else {}
            out.append({
                **dict(t),
                "user_counts": {r["role"]: r["c"] for r in role_counts},
                "user_count": health["user_count"] if health else sum(r["c"] for r in role_counts),
                "product_count": health["product_count"] if health else 0,
                "quote_count": quote_count["c"] if quote_count else 0,
                "open_quote_count": health["active_quotes"] if health else 0,
                "pending_approval_count": health["pending_approvals"] if health else 0,
                "last_quote_activity": health["last_quote_activity"] if health else None,
                "onboarding_complete": health["onboarding_complete"] if health else False,
                "onboarding_complete_count": onboarding.get("complete_count", 0),
                "onboarding_total_count": onboarding.get("total_count", len(ONBOARDING_STEPS)),
                "onboarding_blockers": onboarding.get("blockers", []),
            })
        return jsonify(out)
    finally:
        db.close()


@app.route("/api/system/tenants/readiness", methods=["GET"])
def system_tenant_readiness():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not _is_sysop_ctx(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        tenants = db.execute("SELECT id, name FROM tenants ORDER BY name").fetchall()
        readiness = []
        for tenant in tenants:
            status = _get_onboarding_status(db, tenant["id"], persist_complete=False)
            readiness.append(
                {
                    "tenant_id": tenant["id"],
                    "tenant_name": tenant["name"],
                    "state": status["state"],
                    "steps": status["steps"],
                    "complete_count": status["complete_count"],
                    "total_count": status["total_count"],
                    "all_done": status["all_done"],
                    "blockers": status["blockers"],
                }
            )
        return jsonify(readiness)
    finally:
        db.close()


@app.route("/api/system/tenants/<tenant_id>/health", methods=["GET"])
def system_tenant_health(tenant_id):
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not _is_sysop_ctx(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        tenant_row = _get_tenant_row(db, tenant_id)
        if not tenant_row:
            return jsonify({"error": "Tenant not found"}), 404

        return jsonify(_build_tenant_health_summary(db, tenant_id, tenant_row=tenant_row))
    finally:
        db.close()


@app.route("/api/system/tenants/<tenant_id>/flags", methods=["GET", "PUT"])
def system_tenant_flags(tenant_id):
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not _is_sysop_ctx(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        tenant_row = _get_tenant_row(db, tenant_id)
        if not tenant_row:
            return jsonify({"error": "Tenant not found"}), 404

        if request.method == "GET":
            return jsonify(_feature_flag_dict_for_tenant(db, tenant_id))

        body = request.get_json(force=True) or {}
        if not isinstance(body, dict):
            return jsonify({"error": "Body must be an object of flag_key: boolean pairs"}), 400

        flags = {}
        for flag_key, enabled in body.items():
            key = str(flag_key or "").strip()
            if key:
                flags[key] = bool(enabled)

        updated = _upsert_feature_flags_for_tenant(db, tenant_id, flags)
        audit(
            db,
            tenant_id,
            "feature_flags_updated",
            "settings",
            "feature_flags",
            auth_ctx["user"]["id"],
            auth_ctx["user"]["name"],
            {"count": updated, "updated_keys": sorted(flags.keys()), "scope": "system_console"},
            rep_id=auth_ctx["user"]["id"],
        )
        db.commit()
        return jsonify({"status": "updated", "count": updated, "flags": _feature_flag_dict_for_tenant(db, tenant_id)})
    finally:
        db.close()


@app.route("/api/system/tenants", methods=["POST"])
def create_system_tenant():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not _is_sysop_ctx(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        actor = db.execute(
            "SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1",
            (auth_ctx["user"]["id"], auth_ctx["tenant_id"]),
        ).fetchone()
        if not actor:
            return jsonify({"error": "Current user not found"}), 404

        body = request.get_json(force=True) or {}
        try:
            result = _create_tenant_company(db, actor, body)
        except ValueError as exc:
            return jsonify({"error": str(exc)}), 400
        except DB_INTEGRITY_ERROR:
            return jsonify({"error": "Company or owner email already exists"}), 409

        audit(
            db,
            auth_ctx["tenant_id"],
            "tenant_created",
            "tenant",
            result["tenant"]["id"],
            actor["id"],
            actor["name"],
            {
                "catalog_mode": result["catalog_mode"],
                "company_name": result["tenant"]["name"],
                "owner_email": result["owner_user"]["email"],
            },
            rep_id=actor["id"],
        )
        db.commit()
        return jsonify({"status": "created", **result}), 201
    finally:
        db.close()


@app.route("/api/system/impersonate", methods=["POST"])
def system_impersonate():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx or not _has_permission_ctx(auth_ctx, "can_use_impersonation"):
            return jsonify({"error": "Forbidden"}), 403

        actor = auth_ctx["user"]
        actor_role = _role_normalize(actor["role"])

        body = request.get_json(force=True) or {}

        target_user_id = body.get("user_id")
        target_tenant_id = body.get("tenant_id")
        if not target_user_id:
            return jsonify({"error": "user_id required"}), 400
        if target_user_id == actor["id"]:
            return jsonify({"error": "Choose another user to impersonate"}), 400

        if actor_role == "sysop" and target_tenant_id:
            target = db.execute(
                "SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1",
                (target_user_id, target_tenant_id),
            ).fetchone()
        elif actor_role == "sysop":
            target = db.execute(
                "SELECT * FROM users WHERE id=? AND active=1",
                (target_user_id,),
            ).fetchone()
        else:
            target = db.execute(
                "SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1",
                (target_user_id, auth_ctx["tenant_id"]),
            ).fetchone()

        if not target:
            return jsonify({"error": "Target user not found"}), 404
        if actor_role != "sysop" and not _can_manage_role(actor_role, target["role"]):
            return jsonify({"error": "You cannot impersonate this role"}), 403

        token, expires_at = _issue_auth_session(db, target, impersonated_by=auth_ctx["user"]["id"])
        audit(
            db,
            target["tenant_id"],
            "impersonation_started",
            "user",
            target["id"],
            actor["id"],
            actor["name"],
            {"target_user_id": target["id"], "target_tenant_id": target["tenant_id"]},
            rep_id=target["id"],
        )
        db.commit()
        resp = make_response(jsonify({
            "status": "ok",
            "impersonated": _user_public_dict(target),
            "expires_at": expires_at,
        }), 200)
        _set_auth_cookie(resp, token, expires_at)
        return resp
    finally:
        db.close()


@app.route("/api/system/impersonate/revert", methods=["POST"])
def system_impersonate_revert():
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx:
            return jsonify({"error": "Not authenticated"}), 401

        original_user_id = auth_ctx.get("impersonated_by")
        if not original_user_id:
            return jsonify({"error": "No active impersonation session"}), 400

        original_user = db.execute(
            "SELECT * FROM users WHERE id=? AND active=1",
            (original_user_id,),
        ).fetchone()
        if not original_user:
            return jsonify({"error": "Original user session is no longer available"}), 404

        token, expires_at = _issue_auth_session(db, original_user)
        audit(
            db,
            original_user["tenant_id"],
            "impersonation_reverted",
            "user",
            auth_ctx["user"]["id"],
            original_user["id"],
            original_user["name"],
            {"from_user_id": auth_ctx["user"]["id"], "from_tenant_id": auth_ctx["tenant_id"]},
            rep_id=auth_ctx["user"]["id"],
        )
        db.commit()

        resp = make_response(jsonify({
            "status": "ok",
            "user": _user_public_dict(original_user),
            "expires_at": expires_at,
        }), 200)
        _set_auth_cookie(resp, token, expires_at)
        return resp
    finally:
        db.close()


@app.route("/api/users", methods=["GET"])
def get_users():
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        actor = auth_ctx["user"] if auth_ctx else None
        actor_role = _role_normalize(actor["role"]) if actor else "rep"

        tenant_scope = tenant_id
        if actor_role == "sysop" and request.args.get("tenant_id"):
            tenant_scope = request.args.get("tenant_id")

        role = request.args.get("role")
        query = "SELECT * FROM users WHERE tenant_id=?"
        vals = [tenant_scope]
        if role:
            query += " AND role=?"
            vals.append(_role_normalize(role))
        if actor_role != "sysop":
            query += " AND role != 'sysop'"

        rows = db.execute(query, vals).fetchall()
        ordered = sorted(rows, key=lambda r: (-_role_rank(r["role"]), (r["name"] or "").lower()))
        return jsonify([_user_public_dict(r) for r in ordered])
    finally:
        db.close()


@app.route("/api/users/<uid>/profile", methods=["GET"])
def get_user_profile(uid):
    """Section 2A: User profile summary panel — owner/manager only."""
    db = get_db()
    try:
        tenant_id, actor_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx:
            return jsonify({"error": "Unauthorized"}), 401
        actor_role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx.get("user") else "rep"
        if actor_role not in ("owner", "manager", "sysop"):
            return jsonify({"error": "Forbidden"}), 403

        user_row = db.execute("SELECT * FROM users WHERE id=? AND tenant_id=?", (uid, tenant_id)).fetchone()
        if not user_row:
            return jsonify({"error": "User not found"}), 404
        _assert_tenant_match(user_row, auth_ctx, "User")

        can_view_margins = _has_permission_ctx(auth_ctx, "can_view_margins")

        # Stats
        total_quotes = db.execute("SELECT COUNT(*) FROM quotes WHERE rep_id=? AND tenant_id=?", (uid, tenant_id)).fetchone()[0]
        draft_quotes = db.execute("SELECT COUNT(*) FROM quotes WHERE rep_id=? AND tenant_id=? AND status='draft'", (uid, tenant_id)).fetchone()[0]
        completed_quotes = db.execute("SELECT COUNT(*) FROM quotes WHERE rep_id=? AND tenant_id=? AND status='complete'", (uid, tenant_id)).fetchone()[0]
        pending_approvals = db.execute("SELECT COUNT(*) FROM approval_requests WHERE rep_id=? AND tenant_id=? AND status='pending'", (uid, tenant_id)).fetchone()[0]
        approved_count = db.execute("SELECT COUNT(*) FROM approval_requests WHERE rep_id=? AND tenant_id=? AND status='approved'", (uid, tenant_id)).fetchone()[0]
        denied_count = db.execute("SELECT COUNT(*) FROM approval_requests WHERE rep_id=? AND tenant_id=? AND status='denied'", (uid, tenant_id)).fetchone()[0]
        margin_row = db.execute("SELECT AVG(margin_pct) as avg_m, SUM(total_price) as total_rev FROM quotes WHERE rep_id=? AND tenant_id=?", (uid, tenant_id)).fetchone()
        avg_margin = round(float(margin_row["avg_m"] or 0), 2)
        total_revenue = round(float(margin_row["total_rev"] or 0), 2)

        stats = {
            "total_quotes": total_quotes,
            "draft_quotes": draft_quotes,
            "completed_quotes": completed_quotes,
            "pending_approvals": pending_approvals,
            "approved_count": approved_count,
            "denied_count": denied_count,
            "avg_margin_pct": avg_margin if can_view_margins else None,
            "total_revenue": total_revenue if can_view_margins else None,
        }

        # Recent quotes (last 10)
        rq_rows = db.execute(
            "SELECT id,customer_name,status,total_price,updated_at FROM quotes WHERE rep_id=? AND tenant_id=? ORDER BY updated_at DESC LIMIT 10",
            (uid, tenant_id),
        ).fetchall()
        recent_quotes = []
        for r in rq_rows:
            rq = dict(r)
            if not can_view_margins:
                rq["total_price"] = None
            recent_quotes.append(rq)

        # Recent approvals (last 10)
        ra_rows = db.execute(
            "SELECT id,created_at,current_margin,status,owner_note FROM approval_requests WHERE rep_id=? AND tenant_id=? ORDER BY created_at DESC LIMIT 10",
            (uid, tenant_id),
        ).fetchall()
        recent_approvals = [dict(r) for r in ra_rows]

        # Recent audit log (last 20)
        audit_rows = db.execute(
            "SELECT event_type,entity_type,entity_id,details,created_at FROM audit_log WHERE user_id=? AND tenant_id=? ORDER BY created_at DESC LIMIT 20",
            (uid, tenant_id),
        ).fetchall()
        recent_audit = [dict(r) for r in audit_rows]

        return jsonify({
            "user": _user_public_dict(user_row),
            "stats": stats,
            "recent_quotes": recent_quotes,
            "recent_approvals": recent_approvals,
            "recent_audit": recent_audit,
        })
    finally:
        db.close()


@app.route("/api/users", methods=["POST"])
def create_user():
    """Create a new user. Requires owner+ role."""
    db = get_db()
    try:
        tenant_id, actor_id, actor_name = _get_tenant(request)
        body = request.get_json(force=True) or {}
        auth_ctx = getattr(g, "auth", None)
        actor = auth_ctx["user"] if auth_ctx else None
        actor_role = _role_normalize(actor["role"]) if actor else "rep"

        tenant_scope = tenant_id
        if actor_role == "sysop" and body.get("tenant_id"):
            tenant_scope = body.get("tenant_id")

        role = _role_normalize(body.get("role", "rep"))
        if not _can_manage_role(actor_role, role):
            return jsonify({"error": f"Role '{actor_role}' cannot create role '{role}'"}), 403

        name = (body.get("name") or "").strip()
        email = _normalize_email(body.get("email"))
        if not name or not email:
            return jsonify({"error": "name and email are required"}), 400

        uid = f"u-{uuid.uuid4().hex[:8]}"
        temp_password = body.get("password") or _generate_temp_password()
        if len(temp_password) < 8:
            return jsonify({"error": "password must be at least 8 characters"}), 400

        tier = body.get("tier", "standard")
        if tier not in ("junior", "standard", "senior"):
            tier = "standard"

        perms_json = _permissions_to_json(role, body.get("permissions"))
        try:
            db.execute(
                """INSERT INTO users (id,tenant_id,name,email,role,tier,permissions_json,password_hash,must_change_password,active)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    uid,
                    tenant_scope,
                    name,
                    email,
                    role,
                    tier,
                    perms_json,
                    _hash_password(temp_password),
                    1,
                    1 if body.get("active", True) else 0,
                ),
            )
        except DB_INTEGRITY_ERROR:
            return jsonify({"error": "A user with this email already exists"}), 409

        audit(db, tenant_scope, "user_created", "user", uid, actor_id, actor_name, {"role": role}, rep_id=actor_id)
        db.commit()
        return jsonify({"id": uid, "status": "created", "temporary_password": temp_password}), 201
    finally:
        db.close()


@app.route("/api/users/<uid>", methods=["PUT"])
def update_user(uid):
    db = get_db()
    try:
        tenant_id, actor_id, actor_name = _get_tenant(request)
        body = request.get_json(force=True) or {}
        auth_ctx = getattr(g, "auth", None)
        actor = auth_ctx["user"] if auth_ctx else None
        actor_role = _role_normalize(actor["role"]) if actor else "rep"

        existing = _load_user_row_any_tenant(db, uid)
        if not existing:
            return jsonify({"error": "User not found"}), 404
        _assert_tenant_match(existing, auth_ctx, "User")
        tenant_scope = existing["tenant_id"]

        target_role = _role_normalize(existing["role"])
        if uid != actor_id and not _can_manage_role(actor_role, target_role):
            return jsonify({"error": f"Role '{actor_role}' cannot manage role '{target_role}'"}), 403

        if uid == actor_id and actor_role != "sysop":
            if any(k in body for k in ("role", "permissions", "active")):
                return jsonify({"error": "You cannot change your own role, permissions, or active state"}), 403

        sets, vals = [], []
        if "name" in body:
            sets.append("name=?")
            vals.append((body["name"] or "").strip())
        if "email" in body:
            sets.append("email=?")
            vals.append(_normalize_email(body["email"]))
        if "tier" in body:
            tier = body.get("tier")
            if tier not in ("junior", "standard", "senior"):
                return jsonify({"error": "tier must be junior, standard, or senior"}), 400
            sets.append("tier=?")
            vals.append(tier)
        if "active" in body:
            sets.append("active=?")
            vals.append(1 if body.get("active") else 0)
        if "role" in body:
            role = _role_normalize(body["role"])
            if not _can_manage_role(actor_role, role):
                return jsonify({"error": f"Role '{actor_role}' cannot grant role '{role}'"}), 403
            sets.append("role=?")
            vals.append(role)
        if "permissions" in body:
            role_for_perms = _role_normalize(body.get("role", existing["role"]))
            if not _can_manage_role(actor_role, role_for_perms) and actor_role != "sysop":
                return jsonify({"error": "Cannot set permissions for this role"}), 403
            sets.append("permissions_json=?")
            vals.append(_permissions_to_json(role_for_perms, body.get("permissions")))

        if sets:
            vals.extend([uid, tenant_scope])
            try:
                db.execute(f"UPDATE users SET {','.join(sets)} WHERE id=? AND tenant_id=?", vals)
            except DB_INTEGRITY_ERROR:
                return jsonify({"error": "Email already in use"}), 409

        audit(db, tenant_scope, "user_updated", "user", uid, actor_id, actor_name, body, rep_id=actor_id)
        db.commit()
        row = db.execute("SELECT * FROM users WHERE id=? AND tenant_id=?", (uid, tenant_scope)).fetchone()
        return jsonify({"status": "updated", "user": _user_public_dict(row)})
    finally:
        db.close()


@app.route("/api/users/<uid>/permissions", methods=["PUT"])
def update_user_permissions(uid):
    db = get_db()
    try:
        tenant_id, actor_id, actor_name = _get_tenant(request)
        body = request.get_json(force=True) or {}
        auth_ctx = getattr(g, "auth", None)
        actor = auth_ctx["user"] if auth_ctx else None
        actor_role = _role_normalize(actor["role"]) if actor else "rep"

        permissions = body.get("permissions") if isinstance(body.get("permissions"), dict) else body

        existing = _load_user_row_any_tenant(db, uid)
        if not existing:
            return jsonify({"error": "User not found"}), 404
        _assert_tenant_match(existing, auth_ctx, "User")
        tenant_scope = existing["tenant_id"]

        target_role = _role_normalize(existing["role"])
        if not _can_manage_role(actor_role, target_role):
            return jsonify({"error": f"Role '{actor_role}' cannot manage role '{target_role}'"}), 403

        if uid == actor_id and actor_role != "sysop":
            return jsonify({"error": "You cannot change your own permissions"}), 403

        merged = _default_permissions_for_role(existing["role"])
        for key in ALL_PERMISSIONS:
            if key in permissions:
                merged[key] = bool(permissions[key])

        db.execute(
            "UPDATE users SET permissions_json=? WHERE id=? AND tenant_id=?",
            (json.dumps(merged), uid, tenant_scope),
        )
        audit(db, tenant_scope, "user_permissions_updated", "user", uid, actor_id, actor_name, {"permissions": merged}, rep_id=actor_id)
        db.commit()
        return jsonify({"status": "updated", "permissions": merged})
    finally:
        db.close()


@app.route("/api/users/<uid>/reset-password", methods=["POST"])
def reset_user_password(uid):
    db = get_db()
    try:
        tenant_id, actor_id, actor_name = _get_tenant(request)
        body = request.get_json(force=True) or {}
        auth_ctx = getattr(g, "auth", None)
        actor = auth_ctx["user"] if auth_ctx else None
        actor_role = _role_normalize(actor["role"]) if actor else "rep"

        tenant_scope = tenant_id
        if actor_role == "sysop" and (body.get("tenant_id") or request.args.get("tenant_id")):
            tenant_scope = body.get("tenant_id") or request.args.get("tenant_id")

        temp_password = body.get("new_password") or _generate_temp_password()
        if len(temp_password) < 8:
            return jsonify({"error": "new_password must be at least 8 characters"}), 400

        row = _load_user_row_any_tenant(db, uid)
        if not row:
            return jsonify({"error": "User not found"}), 404
        _assert_tenant_match(row, auth_ctx, "User")
        tenant_scope = row["tenant_id"]

        target_role = _role_normalize(row["role"])
        if not _can_manage_role(actor_role, target_role):
            return jsonify({"error": f"Role '{actor_role}' cannot reset passwords for role '{target_role}'"}), 403

        db.execute(
            "UPDATE users SET password_hash=?, must_change_password=1 WHERE id=? AND tenant_id=?",
            (_hash_password(temp_password), uid, tenant_scope),
        )
        audit(db, tenant_scope, "user_password_reset", "user", uid, actor_id, actor_name, {}, rep_id=actor_id)
        db.commit()
        return jsonify({"status": "reset", "temporary_password": temp_password})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# GOOGLE MAPS + PROPERTY APPRAISER
# ---------------------------------------------------------------------------

# ZIP -> county mapping for South Florida
_BROWARD_ZIPS = {
    "33004","33009","33019","33020","33021","33022","33023","33024","33025",
    "33026","33027","33028","33029","33060","33061","33062","33063","33064",
    "33065","33066","33067","33068","33069","33071","33073","33076","33301",
    "33304","33305","33306","33308","33309","33310","33311","33312","33313",
    "33314","33315","33316","33317","33319","33321","33322","33323","33324",
    "33325","33326","33327","33328","33330","33331","33332","33334","33351",
}
_MIAMI_DADE_ZIPS = {
    "33101","33109","33122","33125","33126","33127","33128","33129","33130",
    "33131","33132","33133","33134","33135","33136","33137","33138","33139",
    "33140","33141","33142","33143","33144","33145","33146","33147","33149",
    "33150","33154","33155","33156","33157","33158","33160","33161","33162",
    "33165","33166","33167","33168","33169","33170","33172","33173","33174",
    "33175","33176","33177","33178","33179","33180","33181","33182","33183",
    "33184","33185","33186","33187","33189","33190","33193","33194","33196",
    "33030","33031","33032","33033","33034","33035","33039","33054","33055","33056",
}
_PALM_BEACH_ZIPS = {
    "33401","33403","33404","33405","33406","33407","33408","33409","33410",
    "33411","33412","33413","33414","33415","33417","33418","33426","33428",
    "33430","33431","33432","33433","33434","33435","33436","33437","33444",
    "33445","33446","33458","33460","33461","33462","33463","33467","33469",
    "33470","33472","33473","33476","33477","33478","33480","33483","33484",
    "33486","33487","33496","33498",
}


def _detect_county(zip_code: str) -> str:
    z = (zip_code or "").strip()[:5]
    if z in _BROWARD_ZIPS:
        return "broward"
    if z in _MIAMI_DADE_ZIPS:
        return "miami-dade"
    if z in _PALM_BEACH_ZIPS:
        return "palm-beach"
    return "unknown"


def _http_get_json(url: str, timeout: int = 8) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": "WindowCalc/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_post_json(url: str, payload: dict, timeout: int = 8) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "User-Agent": "WindowCalc/1.0",
            "Content-Type": "application/json; charset=UTF-8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _http_get_text(url: str, timeout: int = 12) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "WindowCalc/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", "ignore")


_STREET_DIRECTIONS = {"N", "S", "E", "W", "NE", "NW", "SE", "SW"}
_STREET_SUFFIXES = {
    "ALLEY": "ALY",
    "ALY": "ALY",
    "AV": "AVE",
    "AVE": "AVE",
    "AVENUE": "AVE",
    "BLVD": "BLVD",
    "BOULEVARD": "BLVD",
    "CIR": "CIR",
    "CIRCLE": "CIR",
    "COURT": "CT",
    "CT": "CT",
    "DR": "DR",
    "DRIVE": "DR",
    "HIGHWAY": "HWY",
    "HWY": "HWY",
    "LANE": "LN",
    "LN": "LN",
    "PARKWAY": "PKWY",
    "PKWY": "PKWY",
    "PLACE": "PL",
    "PL": "PL",
    "RD": "RD",
    "ROAD": "RD",
    "ST": "ST",
    "STREET": "ST",
    "TER": "TER",
    "TERRACE": "TER",
    "TRAIL": "TRL",
    "TRL": "TRL",
    "WAY": "WAY",
}


def _escape_arcgis_where(value: str) -> str:
    return str(value or "").replace("'", "''")


def _extract_zip_code(value: str) -> str:
    match = re.search(r"\b(\d{5})(?:-\d{4})?\b", value or "")
    return match.group(1) if match else ""


def _clean_parcel_id(value):
    return re.sub(r"\D", "", str(value or ""))


def _parse_int(value, default=None):
    try:
        if value in (None, "", "None"):
            return default
        return int(float(str(value).replace(",", "").strip()))
    except (TypeError, ValueError):
        return default


def _parse_float(value, default=None):
    try:
        if value in (None, "", "None"):
            return default
        return float(str(value).replace(",", "").strip())
    except (TypeError, ValueError):
        return default


def _parse_address_components(address: str) -> dict:
    raw = re.sub(r"\s+", " ", str(address or "").strip())
    zip_code = _extract_zip_code(raw)
    street_part = raw.split(",")[0]
    street_part = re.sub(
        r"\b(?:APT|APARTMENT|UNIT|STE|SUITE|LOT|BLDG|BUILDING|#)\b.*$",
        "",
        street_part,
        flags=re.I,
    )
    street_part = re.sub(r"[^0-9A-Za-z\s/-]", " ", street_part)
    tokens = [tok for tok in re.split(r"\s+", street_part.upper()) if tok]

    number = ""
    if tokens and re.match(r"^\d+[A-Z]?$", tokens[0]):
        number = tokens.pop(0)
    if tokens and re.match(r"^\d/\d$", tokens[0]):
        tokens.pop(0)

    pre_dir = tokens.pop(0) if tokens and tokens[0] in _STREET_DIRECTIONS else ""
    post_dir = ""
    suffix = ""

    if tokens and tokens[-1] in _STREET_DIRECTIONS:
        post_dir = tokens.pop()
    if tokens and tokens[-1] in _STREET_SUFFIXES:
        suffix = _STREET_SUFFIXES[tokens.pop()]

    street_name = " ".join(tokens).strip()
    city = ""
    parts = [part.strip() for part in raw.split(",") if part.strip()]
    if len(parts) > 1:
        city = re.sub(r"\bFL(?:ORIDA)?\b.*$", "", parts[1], flags=re.I).strip()

    return {
        "raw": raw,
        "number": number,
        "pre_dir": pre_dir,
        "street_name": street_name,
        "suffix": suffix,
        "post_dir": post_dir,
        "zip_code": zip_code,
        "city": city,
    }


def _extract_html_table_pairs(html_text: str) -> dict:
    pairs = {}
    for label, value in re.findall(
        r'<td[^>]*class="label"[^>]*>(.*?)</td>\s*<td[^>]*class="value"[^>]*>(.*?)</td>',
        html_text,
        flags=re.I | re.S,
    ):
        clean_label = html.unescape(re.sub(r"<[^>]+>", " ", label))
        clean_value = html.unescape(re.sub(r"<[^>]+>", " ", value))
        clean_label = " ".join(clean_label.split())
        clean_value = " ".join(clean_value.split())
        if clean_label:
            pairs[clean_label] = clean_value
    return pairs


def _parse_palm_beach_summary(parcel_id: str, address: str) -> dict:
    params = urllib.parse.urlencode({
        "propType": "RE",
        "searchvalue": address or parcel_id,
        "pcn": parcel_id,
    })
    html_text = _http_get_text(f"https://pbcpao.gov/MasterSearch/MasterSearch?{params}", timeout=20)
    return _extract_html_table_pairs(html_text)


def _query_palm_beach_parcel(address: str, zip_code: str = "") -> dict:
    comps = _parse_address_components(address)
    if not comps["number"] or not comps["street_name"]:
        return {}

    where_candidates = []
    base_clauses = [
        f"STREET_NUMBER='{_escape_arcgis_where(comps['number'])}'",
        f"UPPER(STREET_NAME)='{_escape_arcgis_where(comps['street_name'])}'",
    ]
    if comps["pre_dir"]:
        base_clauses.append(f"UPPER(PRE_DIR)='{_escape_arcgis_where(comps['pre_dir'])}'")
    if comps["suffix"]:
        base_clauses.append(f"UPPER(STREET_SUFFIX_ABBR)='{_escape_arcgis_where(comps['suffix'])}'")

    zip_search = (zip_code or comps["zip_code"])[:5]
    if zip_search:
        where_candidates.append(base_clauses + [f"ZIP_CODE='{_escape_arcgis_where(zip_search)}'"])
    where_candidates.append(base_clauses[:])
    if comps["pre_dir"]:
        where_candidates.append([
            f"STREET_NUMBER='{_escape_arcgis_where(comps['number'])}'",
            f"UPPER(STREET_NAME)='{_escape_arcgis_where(comps['street_name'])}'",
        ])
    where_candidates.append([
        f"STREET_NUMBER='{_escape_arcgis_where(comps['number'])}'",
        f"UPPER(STREET_NAME) LIKE '{_escape_arcgis_where(comps['street_name'])}%'",
    ] + ([f"ZIP_CODE='{_escape_arcgis_where(zip_search)}'"] if zip_search else []))

    for clauses in where_candidates:
        params = urllib.parse.urlencode({
            "where": " AND ".join(clauses),
            "outFields": "PARID,STREET_NUMBER,PRE_DIR,STREET_NAME,STREET_SUFFIX_ABBR,POST_DIR,ZIP_CITY,ZIP_CODE,SITUS_SEQ",
            "returnGeometry": "false",
            "resultRecordCount": "3",
            "orderByFields": "SITUS_SEQ ASC",
            "f": "json",
        })
        data = _http_get_json(
            f"https://gis.pbcgov.org/hosting/rest/services/Parcels/PARCEL_Data/MapServer/7/query?{params}",
            timeout=12,
        )
        features = data.get("features") or []
        if features:
            return features[0].get("attributes", {})
    return {}


def _pa_broward(address: str, zip_code: str = "") -> dict:
    try:
        comps = _parse_address_components(address)
        street_number = comps.get("number")
        street_name = comps.get("street_name")
        if not street_number or not street_name:
            return {}

        search = _http_post_json(
            "https://gisweb-adapters.bcpa.net/bcpawebmap_ex_new_web/bcpawebmap.aspx/GetDataByAddress",
            {"streetNumber": street_number, "streetName": street_name},
            timeout=12,
        )
        records = search.get("d") or []
        if not records:
            return {}

        record = records[0]
        folio = _clean_parcel_id(record.get("FolioNumber"))
        if not folio:
            return {}

        detail = record
        try:
            detail_payload = _http_post_json(
                "https://gisweb-adapters.bcpa.net/bcpawebmap_ex_new_web/bcpawebmap.aspx/GetDataByFolioNumber",
                {"folioNumber": folio},
                timeout=12,
            )
            detail_records = detail_payload.get("d") or []
            if detail_records:
                detail = detail_records[0]
        except Exception:
            pass

        owner = " ".join(
            part.strip()
            for part in (detail.get("Name1"), detail.get("Name2"))
            if str(part or "").strip()
        ).strip()
        year_built = _parse_int(detail.get("EffectiveAge"))
        return {
            "folio": folio,
            "owner_name": owner or _sanitize_text_field(detail.get("Name"), 200),
            "year_built": year_built if year_built and 1800 <= year_built <= datetime.now().year else None,
            "living_sqft": _parse_float(detail.get("BldgSqFT")),
            "bedrooms": None,
            "bathrooms": None,
            "address": _sanitize_text_field(detail.get("SitusAddress1"), 200) or _sanitize_text_field(detail.get("SitusAddress"), 200),
            "city": _sanitize_text_field(detail.get("SitusAddress2"), 120),
            "county": "Broward",
            "county_slug": "broward",
        }
    except Exception:
        return {}


def _pa_miami_dade(address: str, zip_code: str = "") -> dict:
    try:
        params = urllib.parse.urlencode({
            "Operation": "GetAddress",
            "clientAppName": "PropertySearch",
            "myUnit": "",
            "from": "1",
            "myAddress": address,
            "to": "200",
        })
        search = _http_get_json(
            f"https://apps.miamidadepa.gov/PApublicServiceProxy/PaServicesProxy.ashx?{params}",
            timeout=12,
        )
        props = search.get("MinimumPropertyInfos") or []
        if not isinstance(props, list) or not props:
            return {}

        p = props[0]
        folio_digits = _clean_parcel_id(p.get("Strap") or p.get("FolioNum"))
        if not folio_digits:
            return {}

        detail_params = urllib.parse.urlencode({
            "Operation": "GetPropertySearchByFolio",
            "clientAppName": "PropertySearch",
            "folioNumber": folio_digits,
        })
        detail = _http_get_json(
            f"https://apps.miamidadepa.gov/PApublicServiceProxy/PaServicesProxy.ashx?{detail_params}",
            timeout=12,
        ).get("PropertyInfo", {})

        full_baths = _parse_float(detail.get("BathroomCount"))
        half_baths = _parse_float(detail.get("HalfBathroomCount"), 0.0)
        bath_count = None
        if full_baths is not None:
            bath_count = full_baths + (half_baths or 0.0) * 0.5

        year_built = _parse_int(detail.get("YearBuilt"))
        return {
            "folio": str(p.get("Strap") or detail.get("FolioNumber") or ""),
            "owner_name": " ".join(
                part.strip()
                for part in (p.get("Owner1"), p.get("Owner2"), p.get("Owner3"))
                if str(part or "").strip()
            ),
            "year_built": year_built if year_built and 1800 <= year_built <= datetime.now().year else None,
            "living_sqft": (_parse_float(detail.get("BuildingHeatedArea")) if (_parse_float(detail.get("BuildingHeatedArea")) or 0) > 0 else None) or (_parse_float(detail.get("BuildingActualArea")) if (_parse_float(detail.get("BuildingActualArea")) or 0) > 0 else None),
            "bedrooms": _parse_int(detail.get("BedroomCount")),
            "bathrooms": bath_count,
            "address": _sanitize_text_field(p.get("SiteAddress"), 200),
            "city": _sanitize_text_field(p.get("Municipality"), 120),
            "county": "Miami-Dade",
            "county_slug": "miami-dade",
        }
    except Exception:
        return {}


def _pa_palm_beach(address: str, zip_code: str = "") -> dict:
    try:
        parcel = _query_palm_beach_parcel(address, zip_code=zip_code)
        parcel_id = _clean_parcel_id(parcel.get("PARID"))
        if not parcel_id:
            return {}

        summary = _parse_palm_beach_summary(parcel_id, address)
        total_sqft = _parse_float(summary.get("Total Square Feet*") or summary.get("Total Square Feet"))
        full_baths = _parse_float(summary.get("Full Baths"))
        half_baths = _parse_float(summary.get("Half Baths"), 0.0)
        bath_count = None
        if full_baths is not None:
            bath_count = full_baths + (half_baths or 0.0) * 0.5

        return {
            "folio": summary.get("Parcel Control Number") or parcel_id,
            "owner_name": summary.get("Owner Name", ""),
            "year_built": _parse_int(summary.get("Year Built")),
            "living_sqft": total_sqft,
            "bedrooms": _parse_int(summary.get("Bed Rooms")),
            "bathrooms": bath_count,
            "address": summary.get("Location Address") or " ".join(
                part for part in [
                    parcel.get("STREET_NUMBER"),
                    parcel.get("PRE_DIR"),
                    parcel.get("STREET_NAME"),
                    parcel.get("STREET_SUFFIX_ABBR"),
                    parcel.get("POST_DIR"),
                ]
                if str(part or "").strip()
            ),
            "city": summary.get("Municipality") or parcel.get("ZIP_CITY", ""),
            "county": "Palm Beach",
            "county_slug": "palm-beach",
            "property_use": summary.get("Property Use Code"),
        }
    except Exception:
        return {}


@app.route("/api/maps/config", methods=["GET"])
def maps_config():
    return jsonify({"has_key": bool(GOOGLE_MAPS_API_KEY)})


@app.route("/api/maps/autocomplete", methods=["GET"])
def maps_autocomplete():
    if not GOOGLE_MAPS_API_KEY:
        return jsonify({"predictions": [], "error": "Maps API key not configured"})
    input_text = request.args.get("input", "").strip()
    session_token = request.args.get("sessiontoken", "")
    if not input_text:
        return jsonify({"predictions": []})
    try:
        params = urllib.parse.urlencode({
            "input": input_text,
            "key": GOOGLE_MAPS_API_KEY,
            "components": "country:us",
            "types": "address",
            "sessiontoken": session_token,
        })
        data = _http_get_json(f"https://maps.googleapis.com/maps/api/place/autocomplete/json?{params}")
        predictions = [
            {
                "description": p.get("description", ""),
                "place_id": p.get("place_id", ""),
                "structured": p.get("structured_formatting", {}),
            }
            for p in data.get("predictions", [])
            if "FL" in p.get("description", "") or "Florida" in p.get("description", "")
        ]
        return jsonify({"predictions": predictions})
    except Exception as exc:
        return jsonify({"predictions": [], "error": str(exc)})


@app.route("/api/maps/geocode", methods=["GET"])
def maps_geocode():
    address = request.args.get("address", "").strip()
    if not address:
        return jsonify({"error": "address required"}), 400
    if not GOOGLE_MAPS_API_KEY:
        return jsonify({"found": False, "error": "Maps API key not configured"})
    try:
        params = urllib.parse.urlencode({"address": address, "key": GOOGLE_MAPS_API_KEY})
        data = _http_get_json(f"https://maps.googleapis.com/maps/api/geocode/json?{params}")
        results = data.get("results", [])
        if not results:
            return jsonify({"found": False})
        r = results[0]
        zip_code = ""
        for comp in r.get("address_components", []):
            if "postal_code" in comp.get("types", []):
                zip_code = comp.get("short_name", "")
        loc = r.get("geometry", {}).get("location", {})
        return jsonify({
            "found": True,
            "formatted_address": r.get("formatted_address", ""),
            "place_id": r.get("place_id", ""),
            "lat": loc.get("lat"),
            "lng": loc.get("lng"),
            "zip_code": zip_code,
        })
    except Exception as exc:
        return jsonify({"found": False, "error": str(exc)})


@app.route("/api/property/lookup", methods=["GET"])
def property_lookup():
    address = request.args.get("address", "").strip()
    zip_code = request.args.get("zip", "").strip()
    if not address:
        return jsonify({"error": "address required"}), 400

    county = _detect_county(zip_code)
    if county == "unknown":
        m = re.search(r"\b(3[34]\d{3})\b", address)
        if m:
            county = _detect_county(m.group(1))

    lookup_fns = {
        "broward": lambda: _pa_broward(address, zip_code=zip_code),
        "miami-dade": lambda: _pa_miami_dade(address, zip_code=zip_code),
        "palm-beach": lambda: _pa_palm_beach(address, zip_code=zip_code),
    }
    try:
        result = {}
        if county in lookup_fns:
            result = lookup_fns[county]()
        else:
            for fn in lookup_fns.values():
                result = fn()
                if result:
                    break
    
        if not result:
            return jsonify({
                "found": False,
                "county_detected": county,
                "message": "No record found. Verify the address or continue manually.",
            })
        actual_county = result.get("county_slug") or county
        result.pop("county_slug", None)
        return jsonify({"found": True, "county_detected": actual_county, **result})
    except Exception as exc:
        return jsonify({
            "error": "property_appraiser_lookup_failed",
            "message": f"PA lookup error: {exc}",
        }), 502


@app.route("/api/quotes/<qid>/property", methods=["PATCH"])
def update_quote_property(qid):
    auth_ctx = getattr(g, "auth", None)
    tenant_id, user_id, user_name = _get_tenant(request)
    body = request.get_json(silent=True) or {}
    db = get_db()
    try:
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        tenant_id = quote["tenant_id"]

        can_view_all = _has_permission_ctx(auth_ctx, "can_view_all_quotes")
        if (not can_view_all) and quote["rep_id"] != user_id:
            return jsonify({"error": "Forbidden"}), 403

        allowed = [
            "folio_number", "pa_owner_name", "pa_year_built",
            "pa_living_sqft", "pa_bedrooms", "pa_bathrooms",
            "pa_data_json", "maps_place_id", "maps_formatted_address",
        ]
        sets, vals = [], []
        changes = {}
        pa_fields = {"folio_number", "pa_owner_name", "pa_year_built", "pa_living_sqft", "pa_bedrooms", "pa_bathrooms", "pa_data_json"}
        for field in allowed:
            if field in body:
                value = body[field]
                if field == "pa_data_json" and isinstance(value, (dict, list)):
                    value = json.dumps(value)
                sets.append(f"{field}=?")
                vals.append(value)
                changes[field] = value
        if not sets:
            return jsonify({"error": "No valid fields provided"}), 400

        # Section 3A: set property_verified flags when PA data is included
        if pa_fields & set(changes.keys()):
            sets += ["property_verified=?", "property_verified_at=?", "property_verified_by=?"]
            vals += [1, _now_iso(), user_id]

        sets.append("updated_at=?")
        vals.append(_now_iso())
        vals.extend([qid, tenant_id])
        db.execute(f"UPDATE quotes SET {', '.join(sets)} WHERE id=? AND tenant_id=?", vals)
        audit(
            db, tenant_id, "quote_property_synced", "quote", qid,
            user_id, user_name, {"fields": sorted(changes.keys())}, rep_id=quote["rep_id"],
        )
        db.commit()
        return jsonify({"ok": True})
    except Exception as exc:
        return jsonify({"error": "property_save_failed", "message": f"Failed to save property data: {exc}"}), 500
    finally:
        db.close()


# ---------------------------------------------------------------------------
# SECTION 3B — ADDRESS VERIFICATION
# ---------------------------------------------------------------------------

@app.route("/api/quotes/<qid>/verify-address", methods=["POST"])
def verify_quote_address(qid):
    """Confirm a Maps address against place_id and mark quote maps_verified."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    tenant_id, user_id, user_name = _get_tenant(request)
    body = request.get_json(force=True) or {}
    place_id = (body.get("place_id") or "").strip()
    if not place_id:
        return jsonify({"ok": False, "reason": "place_id_required"}), 400

    if not GOOGLE_MAPS_API_KEY:
        return jsonify({"ok": False, "reason": "maps_not_configured"})

    db = get_db()
    try:
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")

        params = urllib.parse.urlencode({"place_id": place_id, "key": GOOGLE_MAPS_API_KEY})
        data = _http_get_json(f"https://maps.googleapis.com/maps/api/geocode/json?{params}")
        results = data.get("results", [])
        if not results:
            return jsonify({"ok": False, "reason": "place_not_found"})
        r = results[0]
        loc = r.get("geometry", {}).get("location", {})
        fmt_addr = r.get("formatted_address", body.get("formatted_address", ""))

        db.execute(
            "UPDATE quotes SET maps_place_id=?, maps_formatted_address=?, maps_verified=1, maps_verified_at=?, updated_at=? WHERE id=? AND tenant_id=?",
            (place_id, fmt_addr, _now_iso(), _now_iso(), qid, tenant_id),
        )
        audit(db, tenant_id, "address_verified", "quote", qid, user_id, user_name,
              {"place_id": place_id, "formatted_address": fmt_addr}, rep_id=quote["rep_id"])
        db.commit()
        return jsonify({"ok": True, "formatted_address": fmt_addr, "lat": loc.get("lat"), "lng": loc.get("lng")})
    except Exception as exc:
        return jsonify({"ok": False, "reason": str(exc)}), 500
    finally:
        db.close()


# ---------------------------------------------------------------------------
# SECTION 4A — PRICING HISTORY
# ---------------------------------------------------------------------------

@app.route("/api/quotes/<qid>/pricing-history", methods=["GET"])
def get_pricing_history(qid):
    """Return all pricing snapshots for a quote. Sysop/owner/manager only."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    actor_role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx.get("user") else "rep"
    if actor_role not in ("sysop", "owner", "manager"):
        return jsonify({"error": "Forbidden"}), 403
    tenant_id, _, _ = _get_tenant(request)
    db = get_db()
    try:
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        rows = db.execute(
            "SELECT * FROM pricing_snapshots WHERE quote_id=? AND tenant_id=? ORDER BY created_at DESC",
            (qid, tenant_id),
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


# ---------------------------------------------------------------------------
# SECTION 5 — QUOTE FILE UPLOAD / DOWNLOAD / DELETE
# ---------------------------------------------------------------------------

QUOTE_FILE_ALLOWED_MIME = {
    "image/jpeg", "image/png", "image/gif", "image/webp", "image/heic",
    "application/pdf",
    "video/mp4", "video/quicktime", "video/webm",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/plain",
}


@app.route("/api/quotes/<qid>/files", methods=["GET"])
def list_quote_files(qid):
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    tenant_id, user_id, _ = _get_tenant(request)
    db = get_db()
    try:
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        rows = db.execute(
            """SELECT qf.*, u.name as uploader_name FROM quote_files qf
               LEFT JOIN users u ON qf.uploaded_by=u.id
               WHERE qf.quote_id=? AND qf.tenant_id=? AND qf.deleted_at IS NULL
               ORDER BY qf.created_at DESC""",
            (qid, tenant_id),
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/quotes/<qid>/files", methods=["POST"])
def upload_quote_file(qid):
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    tenant_id, user_id, user_name = _get_tenant(request)
    db = get_db()
    try:
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")

        file = request.files.get("file")
        if not file:
            return jsonify({"error": "No file provided"}), 400
        category = (request.form.get("category") or "general").strip()
        valid_cats = {"general", "permit", "photo", "contract", "hoa", "noa_doc", "inspection", "other"}
        if category not in valid_cats:
            category = "general"

        orig_name = secure_filename(file.filename or "upload")
        mime = mimetypes.guess_type(orig_name)[0] or "application/octet-stream"
        file.seek(0, 2)
        size = file.tell()
        file.seek(0)
        max_bytes = MAX_FILE_UPLOAD_MB * 1024 * 1024
        if size > max_bytes:
            return jsonify({"error": f"File exceeds {MAX_FILE_UPLOAD_MB}MB limit"}), 413
        if mime not in QUOTE_FILE_ALLOWED_MIME:
            return jsonify({"error": f"File type not allowed: {mime}"}), 415

        fid = f"qf-{uuid.uuid4().hex[:8]}"
        obj_name = f"files/{tenant_id}/{qid}/{fid}/{orig_name}"

        if _chat_media_uses_gcs():
            bucket_name = CHAT_MEDIA_BUCKET
            client = _chat_media_storage()
            bucket = client.bucket(bucket_name)
            blob = bucket.blob(f"{CHAT_MEDIA_PREFIX}/{obj_name}")
            blob.upload_from_file(file, content_type=mime)
            storage_backend = "gcs"
        else:
            local_dir = os.path.join(LOCAL_CHAT_MEDIA_ROOT, "files", tenant_id, qid, fid)
            os.makedirs(local_dir, exist_ok=True)
            dest_path = os.path.join(local_dir, orig_name)
            file.save(dest_path)
            storage_backend = "local"
            bucket_name = None

        db.execute(
            """INSERT INTO quote_files (id,tenant_id,quote_id,uploaded_by,file_name,file_size,mime_type,
               file_category,storage_backend,storage_bucket,storage_object_name,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
            (fid, tenant_id, qid, user_id, orig_name, size, mime, category,
             storage_backend, bucket_name, obj_name, _now_iso()),
        )
        audit(db, tenant_id, "quote_file_uploaded", "quote", qid, user_id, user_name,
              {"file_id": fid, "file_name": orig_name, "category": category, "size": size}, rep_id=quote["rep_id"])
        db.commit()
        return jsonify({"ok": True, "id": fid, "file_name": orig_name, "mime_type": mime, "file_size": size, "file_category": category}), 201
    finally:
        db.close()


@app.route("/api/quotes/<qid>/files/<fid>", methods=["GET"])
def download_quote_file(qid, fid):
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    tenant_id, _, _ = _get_tenant(request)
    db = get_db()
    try:
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        row = db.execute(
            "SELECT * FROM quote_files WHERE id=? AND quote_id=? AND tenant_id=? AND deleted_at IS NULL",
            (fid, qid, tenant_id),
        ).fetchone()
        if not row:
            return jsonify({"error": "File not found"}), 404
        row = dict(row)
        if row["storage_backend"] == "gcs" and _chat_media_uses_gcs():
            client = _chat_media_storage()
            bucket = client.bucket(row["storage_bucket"])
            blob = bucket.blob(f"{CHAT_MEDIA_PREFIX}/{row['storage_object_name']}")
            signed_url = blob.generate_signed_url(expiration=timedelta(seconds=900), method="GET")
            from flask import redirect
            return redirect(signed_url)
        else:
            local_path = os.path.join(LOCAL_CHAT_MEDIA_ROOT, "files", tenant_id, qid, fid, row["file_name"])
            from flask import send_file
            return send_file(local_path, as_attachment=True, download_name=row["file_name"])
    finally:
        db.close()


@app.route("/api/quotes/<qid>/files/<fid>", methods=["DELETE"])
def delete_quote_file(qid, fid):
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    tenant_id, user_id, user_name = _get_tenant(request)
    actor_role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx.get("user") else "rep"
    db = get_db()
    try:
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        row = db.execute(
            "SELECT * FROM quote_files WHERE id=? AND quote_id=? AND tenant_id=? AND deleted_at IS NULL",
            (fid, qid, tenant_id),
        ).fetchone()
        if not row:
            return jsonify({"error": "File not found"}), 404
        if actor_role not in ("owner", "manager", "sysop") and row["uploaded_by"] != user_id:
            return jsonify({"error": "Forbidden"}), 403
        db.execute("UPDATE quote_files SET deleted_at=? WHERE id=?", (_now_iso(), fid))
        audit(db, tenant_id, "quote_file_deleted", "quote", qid, user_id, user_name,
              {"file_id": fid, "file_name": row["file_name"]}, rep_id=quote["rep_id"])
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


@app.route("/api/quotes/<qid>/price-bounds", methods=["GET"])
def get_quote_price_bounds(qid):
    """
    Returns price bounds for each opening in a quote for the frontend slider.
    Used by Tier 4 (Per-Opening Price Slider).
    """
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)

        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")

        openings = db.execute(
            "SELECT * FROM openings WHERE quote_id=? AND tenant_id=? ORDER BY opening_number",
            (qid, tenant_id)
        ).fetchall()

        # Get governance settings for this rep
        gov = _get_governance_for_rep(db, tenant_id, quote["rep_id"])
        max_discount_pct = _safe_float(gov.get("max_discount_pct"), 5.0)

        # Check if a discount tier overrides this
        quote_total = _safe_float(quote.get("total_price"), 0)
        tier_max_discount = _get_discount_tier_for_total(db, tenant_id, quote_total)
        if tier_max_discount is not None:
            max_discount_pct = _safe_float(tier_max_discount, max_discount_pct)

        discount_tier = None
        if tier_max_discount is not None:
            # Find which tier matched
            tier_row = db.execute("""
                SELECT * FROM discount_tiers
                WHERE tenant_id=? AND active=1
                AND min_job_total <= ?
                AND (max_job_total IS NULL OR max_job_total >= ?)
                ORDER BY min_job_total DESC LIMIT 1
            """, (tenant_id, quote_total, quote_total)).fetchone()
            if tier_row:
                discount_tier = {
                    "label": tier_row["label"],
                    "max_discount_pct": tier_row["max_discount_pct"],
                }

        # Get margin floor
        margin_floor = _safe_float(gov.get("margin_floor"), 30.0)

        openings_data = []
        for op in openings:
            total_cost = _safe_float(op.get("total_cost"), 0)
            current_sell = _safe_float(op.get("sell_price"), 0)
            stored_baseline = _safe_float(op.get("baseline_sell_price"), 0)
            discount_pct = _safe_float(op.get("discount_pct"), 0)

            # Legacy rows may not have baseline_sell_price populated.
            if stored_baseline > 0:
                baseline_sell = stored_baseline
            elif current_sell > 0 and 0 < discount_pct < 99.9:
                baseline_sell = round(current_sell / (1 - (discount_pct / 100.0)), 2)
            else:
                baseline_sell = current_sell

            # floor_sell_price = minimum price before hitting margin floor
            # Calculate: floor_sell_price = total_cost / (1 - margin_floor/100)
            if margin_floor >= 100:
                floor_sell = 0.0  # margin_floor=100 is nonsensical; allow any price
            else:
                floor_sell = round(total_cost / (1 - margin_floor / 100), 2) if total_cost > 0 else 0

            # CRITICAL: floor_sell must never exceed baseline_sell or the range collapses
            # and every adjustment button becomes a no-op. If costs are so high that the
            # margin floor can't be met at baseline, just cap the floor at the max-discount
            # boundary and let governance decide whether to approve.
            max_discount_floor = round(baseline_sell * (1 - max_discount_pct / 100), 2) if baseline_sell > 0 else 0
            floor_sell = min(floor_sell, baseline_sell)   # never exceed baseline
            floor_sell = max(floor_sell, max_discount_floor)  # never allow more than max_discount_pct

            # min_sell_price = the harder of the two constraints, still capped at baseline
            min_sell = max(max_discount_floor, floor_sell)
            min_sell = min(min_sell, baseline_sell)  # safety cap

            openings_data.append({
                "opening_id": op["id"],
                "opening_number": op["opening_number"],
                "baseline_sell_price": baseline_sell,
                "floor_sell_price": floor_sell,
                "max_discount_pct": max_discount_pct,
                "min_sell_price": min_sell,
            })

        result = {
            "quote_id": qid,
            "quote_total": quote_total,
            "discount_tier": discount_tier,
            "governance_max_discount_pct": _safe_float(gov.get("max_discount_pct"), 5.0),
            "effective_max_discount_pct": max_discount_pct,
            "openings": openings_data,
        }
        return jsonify(result)
    finally:
        db.close()


@app.route("/api/quotes/<qid>/bulk-adjust", methods=["POST"])
def bulk_adjust_quote(qid):
    """
    Adjust all opening prices in a quote by a percentage (Tier 4: Bulk adjustment).
    Body: { adjustment_pct: -5.0 } or { reset: true }
    """
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        body = request.get_json(force=True) or {}

        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")

        # Get openings and price bounds
        openings = db.execute(
            "SELECT * FROM openings WHERE quote_id=? AND tenant_id=? ORDER BY opening_number",
            (qid, tenant_id)
        ).fetchall()

        if not openings:
            return jsonify({"error": "No openings in quote"}), 400

        # Get bounds
        bounds_result = json.loads(get_quote_price_bounds(qid).get_data(as_text=True))
        if bounds_result.get("error"):
            return jsonify(bounds_result), 400
        bounds_by_id = {op["opening_id"]: op for op in bounds_result["openings"]}

        # Process adjustment
        reset = body.get("reset", False)
        adjustment_pct = _safe_float(body.get("adjustment_pct"), 0) if not reset else 0

        updates = []
        for op in openings:
            current_sell = _safe_float(op.get("sell_price"), 0)
            stored_baseline = _safe_float(op.get("baseline_sell_price"), 0)
            op_discount_pct = _safe_float(op.get("discount_pct"), 0)
            if stored_baseline > 0:
                baseline_sell = stored_baseline
            elif current_sell > 0 and 0 < op_discount_pct < 99.9:
                baseline_sell = round(current_sell / (1 - (op_discount_pct / 100.0)), 2)
            else:
                baseline_sell = current_sell

            if reset:
                # Reset to baseline
                new_sell = baseline_sell
            else:
                # Apply percentage adjustment
                new_sell = current_sell * (1 + adjustment_pct / 100.0)

            # Clamp to bounds
            bounds = bounds_by_id.get(op["id"])
            if bounds:
                min_sell = _safe_float(bounds.get("min_sell_price"), 0)
                baseline = _safe_float(bounds.get("baseline_sell_price"), 0)
                new_sell = max(min_sell, min(baseline, new_sell))
            else:
                new_sell = max(0.01, new_sell)

            new_sell = round(new_sell, 2)

            # Recalculate margin
            total_cost = _safe_float(op.get("total_cost"), 0)
            margin_dollars = round(new_sell - total_cost, 2)
            margin_pct = round((margin_dollars / new_sell) * 100, 1) if new_sell > 0 else 0.0
            discount_pct = round((1 - new_sell / baseline_sell) * 100, 2) if baseline_sell > 0 else 0.0

            db.execute(
                """UPDATE openings
                   SET sell_price=?, margin_dollars=?, margin_pct=?, discount_pct=?
                   WHERE id=? AND tenant_id=?""",
                (new_sell, margin_dollars, margin_pct, discount_pct, op["id"], tenant_id)
            )

            updates.append({
                "opening_id": op["id"],
                "old_sell_price": _safe_float(op.get("sell_price"), 0),
                "new_sell_price": new_sell,
                "margin_pct": margin_pct,
            })

            _log_price_change(
                db,
                tenant_id,
                qid,
                op["id"],
                user_id,
                user_name,
                _safe_float(op.get("sell_price"), 0),
                new_sell,
                {"reason": "bulk_adjust", "adjustment_pct": adjustment_pct if not reset else "reset"},
            )

        # Update quote totals
        totals = _update_quote_totals(db, qid, tenant_id)
        db.commit()

        return jsonify({
            "status": "adjusted",
            "quote_id": qid,
            "adjustment_pct": adjustment_pct if not reset else 0,
            "reset": reset,
            "updates": updates,
            "totals": totals,
        })
    finally:
        db.close()


@app.route("/api/quotes/<qid>/generate-narrative", methods=["POST"])
def generate_quote_narrative(qid):
    """
    AI-powered quote narrative generator (Tier 4-E).
    Generates a professional 2-3 sentence summary for the quote.
    """
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)

        if not ANTHROPIC_API_KEY or not _AnthropicClient:
            return jsonify({"error": "AI not configured"}), 503

        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")

        # Rate limit check
        if not _db_check_ai_rate_limit(db, user_id):
            return jsonify({"error": "Rate limit exceeded. Try again in an hour."}), 429

        # Load openings with product names
        openings = db.execute("""
            SELECT o.id, o.opening_number, o.opening_type, o.total_width, o.total_height,
                   o.product_id, o.glass_option_id, o.floor_level, o.noa_status, o.sell_price,
                   p.name as product_name, g.name as glass_name
            FROM openings o
            LEFT JOIN products p ON p.id=o.product_id
            LEFT JOIN glass_options g ON g.id=o.glass_option_id
            WHERE o.quote_id=? AND o.tenant_id=?
            ORDER BY o.opening_number
        """, (qid, tenant_id)).fetchall()

        if not openings:
            return jsonify({"narrative": "No openings to summarize.", "generated_at": _now_iso()}), 200

        # Build structured prompt data
        openings_data = []
        for op in openings:
            openings_data.append({
                "opening_number": op["opening_number"],
                "type": op["opening_type"],
                "dimensions": f"{op['total_width']}\" × {op['total_height']}\"",
                "product": op["product_name"] or "Custom",
                "glass": op["glass_name"],
                "floor": f"Floor {op['floor_level']}",
                "noa_status": op["noa_status"],
                "price": round(_safe_float(op["sell_price"], 0), 2),
            })

        prompt_data = {
            "customer_name": quote.get("customer_name", "Customer"),
            "job_address": quote.get("job_address", ""),
            "opening_count": len(openings),
            "total_price": round(_safe_float(quote.get("total_price"), 0), 2),
            "openings": openings_data,
        }

        # Call Claude Haiku
        client = _AnthropicClient(api_key=ANTHROPIC_API_KEY)
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=200,
            system="""You write professional, friendly customer-facing summaries for impact window and door replacement proposals.
Write 2-3 sentences max. Focus on protection, value, and clarity. Never mention cost, margin, or markup.
Do not use technical installer jargon. Output plain text only.""",
            messages=[
                {
                    "role": "user",
                    "content": f"""Generate a summary for this window/door proposal:
{json.dumps(prompt_data, indent=2)}"""
                }
            ]
        )

        narrative = response.content[0].text.strip() if response.content else ""

        _db_record_ai_attempt(db, user_id)
        db.commit()

        return jsonify({
            "narrative": narrative,
            "generated_at": _now_iso(),
        })
    except Exception as e:
        app.logger.error(f"[generate_quote_narrative] {e}")
        return jsonify({"error": "Failed to generate narrative"}), 500
    finally:
        db.close()


# ---------------------------------------------------------------------------
# SECTION 7A — AI ASSISTANT
# ---------------------------------------------------------------------------

@app.route("/api/quotes/<qid>/ai-assist", methods=["POST"])
def ai_assist(qid):
    """Context-aware AI assistant for quote/opening/governance questions."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401

    # Rate limit: DB-backed, survives restarts and multi-instance (Alpha 9.4e)
    uid = auth_ctx.get("user_id") or auth_ctx.get("user", {}).get("id", "unknown")

    if not ANTHROPIC_API_KEY or not _AnthropicClient:
        return jsonify({"error": "AI assistant not configured on this server."}), 503

    tenant_id, user_id, _ = _get_tenant(request)
    body = request.get_json(force=True) or {}
    message = (body.get("message") or "").strip()
    context_type = body.get("context_type", "general")
    opening_id = body.get("opening_id")
    if not message:
        return jsonify({"error": "message required"}), 400

    db = get_db()
    try:
        # Check AI rate limit via DB (20 req/user/hour)
        if not _db_check_ai_rate_limit(db, uid):
            return jsonify({"error": "Rate limit exceeded. Try again in an hour."}), 429
        _db_record_ai_attempt(db, uid)
        quote = _load_quote_access_row(db, None, qid)
        if not quote:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote, auth_ctx, "Quote")
        can_view_margins = _has_permission_ctx(auth_ctx, "can_view_margins")

        context_data = {}
        if context_type == "quote":
            q = dict(quote)
            if not can_view_margins:
                q.pop("margin_pct", None); q.pop("total_cost", None); q.pop("margin_dollars", None)
            openings = [dict(r) for r in db.execute("SELECT * FROM openings WHERE quote_id=? AND tenant_id=?", (qid, tenant_id)).fetchall()]
            context_data = {"quote": q, "openings": openings}
        elif context_type == "opening" and opening_id:
            op = db.execute("SELECT * FROM openings WHERE id=? AND quote_id=? AND tenant_id=?", (opening_id, qid, tenant_id)).fetchone()
            if op:
                op_dict = dict(op)
                product = db.execute("SELECT * FROM products WHERE id=? AND tenant_id=?", (op_dict.get("product_id"), tenant_id)).fetchone()
                context_data = {"opening": op_dict, "product": dict(product) if product else None}
        elif context_type == "governance":
            gov = db.execute("SELECT * FROM governance_settings WHERE tenant_id=? LIMIT 4", (tenant_id,)).fetchall()
            context_data = {"governance": [dict(r) for r in gov]}
        else:
            context_data = {"note": "General WindowCalc question — no specific quote context."}

        client = _AnthropicClient(api_key=ANTHROPIC_API_KEY)
        system_prompt = (
            "You are a knowledgeable assistant for WindowCalc, a quoting platform for impact window and door "
            "contractors in South Florida. You help sales reps and managers understand pricing, DP/NOA compliance, "
            "and quote decisions. Be concise. Use plain language. Do not fabricate product specifications. "
            "If you don't know something, say so clearly."
        )
        response = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=500,
            system=system_prompt,
            messages=[{"role": "user", "content": f"Context:\n{json.dumps(context_data, indent=2)}\n\nQuestion: {message}"}],
        )
        reply = response.content[0].text if response.content else "No response generated."
        tokens_used = response.usage.input_tokens + response.usage.output_tokens if response.usage else 0
        return jsonify({"response": reply, "context_type": context_type, "tokens_used": tokens_used})
    except Exception as exc:
        return jsonify({"error": f"AI assistant error: {exc}"}), 500
    finally:
        db.close()


# ---------------------------------------------------------------------------
# SECTION 8A — MESSAGE READ RECEIPTS
# ---------------------------------------------------------------------------

@app.route("/api/quotes/<qid>/messages/<mid>/read", methods=["POST"])
def mark_message_read(qid, mid):
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    tenant_id, user_id, _ = _get_tenant(request)
    db = get_db()
    try:
        msg = db.execute(
            "SELECT * FROM job_messages WHERE id=? AND quote_id=? AND tenant_id=?", (mid, qid, tenant_id)
        ).fetchone()
        if not msg:
            return jsonify({"error": "Message not found"}), 404
        try:
            read_by = json.loads(msg["read_by_json"] or "[]")
        except Exception:
            read_by = []
        if not any(r.get("user_id") == user_id for r in read_by):
            read_by.append({"user_id": user_id, "read_at": _now_iso()})
            db.execute("UPDATE job_messages SET read_by_json=? WHERE id=?", (json.dumps(read_by), mid))
            db.commit()
        return jsonify({"ok": True, "read_count": len(read_by)})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# SECTION 8B — MESSAGE TEMPLATES
# ---------------------------------------------------------------------------

@app.route("/api/message-templates", methods=["GET"])
def list_message_templates():
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    tenant_id, _, _ = _get_tenant(request)
    db = get_db()
    try:
        rows = db.execute(
            "SELECT * FROM message_templates WHERE tenant_id=? AND active=1 ORDER BY category, name",
            (tenant_id,),
        ).fetchall()
        return jsonify([dict(r) for r in rows])
    finally:
        db.close()


@app.route("/api/message-templates", methods=["POST"])
def create_message_template():
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    actor_role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx.get("user") else "rep"
    if actor_role not in ("owner", "manager", "sysop"):
        return jsonify({"error": "Forbidden"}), 403
    tenant_id, user_id, _ = _get_tenant(request)
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    tpl_body = (body.get("body") or "").strip()
    category = body.get("category", "general")
    valid_cats = {"general", "appointment", "follow_up", "approval", "completion", "other"}
    if not name or not tpl_body:
        return jsonify({"error": "name and body required"}), 400
    if category not in valid_cats:
        category = "general"
    tid = f"mt-{uuid.uuid4().hex[:8]}"
    db = get_db()
    try:
        db.execute(
            "INSERT INTO message_templates (id,tenant_id,name,body,category,active,created_at) VALUES (?,?,?,?,?,1,?)",
            (tid, tenant_id, name, tpl_body, category, _now_iso()),
        )
        db.commit()
        return jsonify({"ok": True, "id": tid}), 201
    finally:
        db.close()


@app.route("/api/message-templates/<tid>", methods=["PUT"])
def update_message_template(tid):
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    actor_role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx.get("user") else "rep"
    if actor_role not in ("owner", "manager", "sysop"):
        return jsonify({"error": "Forbidden"}), 403
    tenant_id, _, _ = _get_tenant(request)
    body = request.get_json(force=True) or {}
    db = get_db()
    try:
        row = db.execute("SELECT * FROM message_templates WHERE id=? AND tenant_id=?", (tid, tenant_id)).fetchone()
        if not row:
            return jsonify({"error": "Template not found"}), 404
        sets, vals = [], []
        for field in ("name", "body", "category", "active"):
            if field in body:
                sets.append(f"{field}=?")
                vals.append(body[field])
        if not sets:
            return jsonify({"error": "Nothing to update"}), 400
        vals.append(tid)
        db.execute(f"UPDATE message_templates SET {', '.join(sets)} WHERE id=?", vals)
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


@app.route("/api/message-templates/<tid>", methods=["DELETE"])
def delete_message_template(tid):
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Unauthorized"}), 401
    actor_role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx.get("user") else "rep"
    if actor_role not in ("owner", "manager", "sysop"):
        return jsonify({"error": "Forbidden"}), 403
    tenant_id, _, _ = _get_tenant(request)
    db = get_db()
    try:
        db.execute("UPDATE message_templates SET active=0 WHERE id=? AND tenant_id=?", (tid, tenant_id))
        db.commit()
        return jsonify({"ok": True})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# SECTION 6A — PWA MANIFEST + SERVICE WORKER ROUTES
# ---------------------------------------------------------------------------

@app.route("/static/manifest.json")
def serve_manifest():
    return send_from_directory("static", "manifest.json", mimetype="application/manifest+json")


@app.route("/static/sw.js")
def serve_sw():
    response = send_from_directory("static", "sw.js", mimetype="application/javascript")
    response.headers["Service-Worker-Allowed"] = "/"
    response.headers["Cache-Control"] = "no-cache"
    return response


# ---------------------------------------------------------------------------

# ===========================================================================
# AI PRICING STUDIO — Alpha 9.3
# ===========================================================================

def _require_ai_pricing_perm(auth_ctx):
    """Allow owner/sysop, or manager with can_manage_products or can_manage_governance."""
    if not auth_ctx:
        abort(401)
    role = _role_normalize(auth_ctx.get("user", {}).get("role", ""))
    if role in ("sysop", "owner"):
        return
    if role == "manager":
        perms = auth_ctx.get("permissions", {})
        if perms.get("can_manage_products") or perms.get("can_manage_governance"):
            return
    abort(403, description="AI Pricing Studio requires owner/manager with product or governance permissions.")


def _ai_compute_suggestion(avg_sell, avg_margin_pct, current_base_cost, gov_floor_pct):
    """
    Simple statistical suggestion:
    - Target margin = max(avg_margin_pct, gov_floor_pct + 2)
    - Back-calculate sell price from base cost and target margin
    """
    target_margin = max(avg_margin_pct or 0, (gov_floor_pct or 30) + 2.0)
    if current_base_cost and current_base_cost > 0 and target_margin < 100:
        suggested_price = round(current_base_cost / (1.0 - target_margin / 100.0), 2)
    elif avg_sell and avg_sell > 0:
        suggested_price = round(avg_sell, 2)
    else:
        suggested_price = None
    if suggested_price and current_base_cost and current_base_cost > 0:
        suggested_markup = round((suggested_price - current_base_cost) / current_base_cost * 100, 2)
    else:
        suggested_markup = None
    return suggested_markup, suggested_price


@app.route("/api/ai-pricing/profiles/from-history", methods=["POST"])
def ai_pricing_create_profile_from_history():
    """Section 2A — Create a draft AI pricing profile from historical quote data."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        abort(401)
    _require_ai_pricing_perm(auth_ctx)
    tenant_id = auth_ctx["tenant_id"]
    user_id = auth_ctx["user"]["id"]
    user_name = auth_ctx["user"]["name"]
    db = get_db()

    body = request.get_json(silent=True) or {}
    name = (body.get("name") or "").strip()
    if not name:
        abort(400, description="Profile name is required.")
    note = (body.get("note") or "").strip() or None
    filters = body.get("filters") or {}

    now = datetime.now()
    default_from = (now - timedelta(days=365)).strftime("%Y-%m-%d")
    default_to = now.strftime("%Y-%m-%d")
    from_date = filters.get("from_date") or default_from
    to_date = filters.get("to_date") or default_to
    include_statuses = filters.get("include_statuses") or ["approved", "completed"]
    min_sample_size = int(filters.get("min_sample_size") or 3)

    # Validate date format
    try:
        datetime.strptime(from_date, "%Y-%m-%d")
        datetime.strptime(to_date, "%Y-%m-%d")
    except ValueError:
        abort(400, description="Invalid date format. Use YYYY-MM-DD.")

    # Clamp statuses to allowed values
    allowed_statuses = {"draft", "pending_approval", "approved", "completed", "denied"}
    include_statuses = [s for s in include_statuses if s in allowed_statuses]
    if not include_statuses:
        include_statuses = ["approved", "completed"]

    # Build placeholders for IN clause
    status_placeholders = ",".join("?" * len(include_statuses))

    # Aggregate per-product stats from historical openings
    agg_rows = db.execute(
        f"""
        SELECT
            o.product_id,
            p.name AS product_name,
            p.product_line,
            p.base_cost AS current_base_cost,
            COUNT(o.id) AS sample_size,
            AVG(o.sell_price) AS avg_sell_price,
            AVG(o.margin_pct) AS avg_margin_pct,
            MIN(o.sell_price) AS min_sell_price,
            MAX(o.sell_price) AS max_sell_price
        FROM openings o
        JOIN quotes q ON o.quote_id = q.id
        JOIN products p ON o.product_id = p.id
        WHERE o.tenant_id = ?
          AND q.status IN ({status_placeholders})
          AND q.created_at >= ?
          AND q.created_at <= ?
          AND o.sell_price > 0
        GROUP BY o.product_id
        HAVING COUNT(o.id) >= ?
        """,
        [tenant_id] + include_statuses + [from_date, to_date + " 23:59:59", min_sample_size],
    ).fetchall()

    # Get governance floor for suggestions
    gov_row = db.execute(
        "SELECT margin_floor FROM governance_settings WHERE tenant_id=? ORDER BY id LIMIT 1",
        (tenant_id,),
    ).fetchone()
    gov_floor = float(gov_row["margin_floor"]) if gov_row else 30.0

    # Create profile
    profile_id = f"aip-{uuid.uuid4().hex[:8]}"
    now_iso = _now_iso()
    db.execute(
        "INSERT INTO ai_pricing_profiles (id,tenant_id,name,status,created_by,created_at,note) VALUES (?,?,?,?,?,?,?)",
        (profile_id, tenant_id, name, "draft", user_id, now_iso, note),
    )

    # Insert entries
    products_included = 0
    total_sample = 0
    for row in agg_rows:
        avg_sell = _safe_float(row["avg_sell_price"])
        avg_margin = _safe_float(row["avg_margin_pct"])
        base_cost = _safe_float(row["current_base_cost"])
        sugg_markup, sugg_price = _ai_compute_suggestion(avg_sell, avg_margin, base_cost, gov_floor)

        entry_id = f"aie-{uuid.uuid4().hex[:8]}"
        db.execute(
            """INSERT INTO ai_pricing_entries
               (id, tenant_id, profile_id, product_id, product_name, product_line,
                current_base_cost, ai_suggested_markup_pct, ai_suggested_sell_price,
                sample_size, avg_sell_price, avg_margin_pct, min_sell_price, max_sell_price,
                data_period_start, data_period_end)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                entry_id, tenant_id, profile_id,
                row["product_id"], row["product_name"], row["product_line"],
                base_cost, sugg_markup, sugg_price,
                row["sample_size"], avg_sell, avg_margin,
                _safe_float(row["min_sell_price"]), _safe_float(row["max_sell_price"]),
                from_date, to_date,
            ),
        )
        products_included += 1
        total_sample += int(row["sample_size"] or 0)

    db.commit()

    audit(
        db, tenant_id, "ai_pricing_profile_created", "ai_pricing_profile",
        profile_id, user_id, user_name,
        {"name": name, "products_included": products_included, "period": f"{from_date}→{to_date}"},
    )

    avg_sample = round(total_sample / products_included, 1) if products_included else 0
    return jsonify({
        "profile": {
            "id": profile_id,
            "name": name,
            "status": "draft",
            "created_at": now_iso,
            "note": note,
            "summary": {
                "products_included": products_included,
                "avg_sample_size": avg_sample,
                "data_period_start": from_date,
                "data_period_end": to_date,
            },
        }
    }), 201


@app.route("/api/ai-pricing/profiles", methods=["GET"])
def ai_pricing_list_profiles():
    """Section 2B — List all AI pricing profiles for current tenant."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        abort(401)
    _require_ai_pricing_perm(auth_ctx)
    tenant_id = auth_ctx["tenant_id"]
    db = get_db()

    rows = db.execute(
        """SELECT p.*,
                  (SELECT COUNT(*) FROM ai_pricing_entries e WHERE e.profile_id=p.id) AS product_count,
                  (SELECT COUNT(*) FROM ai_pricing_applications a WHERE a.profile_id=p.id) AS application_count
           FROM ai_pricing_profiles p
           WHERE p.tenant_id=?
             AND p.status != 'archived'
           ORDER BY p.created_at DESC""",
        (tenant_id,),
    ).fetchall()

    return jsonify([dict(r) for r in rows])


@app.route("/api/ai-pricing/profiles/<pid>", methods=["GET"])
def ai_pricing_get_profile(pid):
    """Section 2B — Get a single profile with its entries."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        abort(401)
    _require_ai_pricing_perm(auth_ctx)
    tenant_id = auth_ctx["tenant_id"]
    db = get_db()

    profile = db.execute(
        "SELECT * FROM ai_pricing_profiles WHERE id=? AND tenant_id=?", (pid, tenant_id)
    ).fetchone()
    if not profile:
        abort(404, description="AI pricing profile not found.")

    entries = db.execute(
        "SELECT * FROM ai_pricing_entries WHERE profile_id=? AND tenant_id=? ORDER BY product_name",
        (pid, tenant_id),
    ).fetchall()

    return jsonify({"profile": dict(profile), "entries": [dict(e) for e in entries]})


@app.route("/api/ai-pricing/profiles/<pid>", methods=["PATCH"])
def ai_pricing_patch_profile(pid):
    """Archive or update profile status."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        abort(401)
    _require_ai_pricing_perm(auth_ctx)
    tenant_id = auth_ctx["tenant_id"]
    db = get_db()

    profile = db.execute(
        "SELECT * FROM ai_pricing_profiles WHERE id=? AND tenant_id=?", (pid, tenant_id)
    ).fetchone()
    if not profile:
        abort(404)

    body = request.get_json(silent=True) or {}
    new_status = body.get("status")
    allowed = {"draft", "review", "active", "archived"}
    if new_status and new_status not in allowed:
        abort(400, description=f"Status must be one of: {', '.join(allowed)}")

    if new_status:
        db.execute(
            "UPDATE ai_pricing_profiles SET status=? WHERE id=? AND tenant_id=?",
            (new_status, pid, tenant_id),
        )
        db.commit()

    return jsonify({"ok": True, "status": new_status or profile["status"]})


@app.route("/api/ai-pricing/profiles/<pid>/apply", methods=["POST"])
def ai_pricing_apply_profile(pid):
    """Section 3A — Apply AI pricing suggestions to real products."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        abort(401)
    # Only owner or sysop can apply
    role = _role_normalize(auth_ctx.get("user", {}).get("role", ""))
    if role not in ("owner", "sysop"):
        abort(403, description="Only owners can apply AI pricing suggestions.")
    tenant_id = auth_ctx["tenant_id"]
    user_id = auth_ctx["user"]["id"]
    user_name = auth_ctx["user"]["name"]
    db = get_db()

    profile = db.execute(
        "SELECT * FROM ai_pricing_profiles WHERE id=? AND tenant_id=?", (pid, tenant_id)
    ).fetchone()
    if not profile:
        abort(404, description="AI pricing profile not found.")

    body = request.get_json(silent=True) or {}
    scope = body.get("scope", "selected_products")
    if scope not in ("all_products", "selected_products"):
        abort(400, description="scope must be 'all_products' or 'selected_products'.")
    requested_ids = set(body.get("product_ids") or [])

    # Fetch all entries for this profile
    entries = db.execute(
        "SELECT * FROM ai_pricing_entries WHERE profile_id=? AND tenant_id=?",
        (pid, tenant_id),
    ).fetchall()

    updated_count = 0
    skipped_count = 0
    details = []

    for entry in entries:
        product_id = entry["product_id"]
        if scope == "selected_products" and product_id not in requested_ids:
            skipped_count += 1
            continue
        if not entry["ai_suggested_sell_price"] or not entry["ai_suggested_markup_pct"]:
            skipped_count += 1
            continue

        product = db.execute(
            "SELECT * FROM products WHERE id=? AND tenant_id=?", (product_id, tenant_id)
        ).fetchone()
        if not product:
            skipped_count += 1
            continue

        before_cost = _safe_float(product["base_cost"])
        # Calculate what current sell price would be (base_cost + markup)
        # WindowCalc uses base_cost as the reference; we store suggested as base markup %
        # We update base_cost to the AI-suggested value to shift pricing
        new_base_cost = round(entry["ai_suggested_sell_price"] / (1 + entry["ai_suggested_markup_pct"] / 100), 2) \
            if entry["ai_suggested_markup_pct"] and entry["ai_suggested_markup_pct"] > -100 else before_cost

        db.execute(
            "UPDATE products SET base_cost=? WHERE id=? AND tenant_id=?",
            (new_base_cost, product_id, tenant_id),
        )
        details.append({
            "product_id": product_id,
            "product_name": entry["product_name"],
            "before_base_cost": before_cost,
            "after_base_cost": new_base_cost,
            "ai_suggested_markup_pct": entry["ai_suggested_markup_pct"],
            "ai_suggested_sell_price": entry["ai_suggested_sell_price"],
        })
        updated_count += 1

    db.commit()

    # Record application
    app_id = f"aia-{uuid.uuid4().hex[:8]}"
    db.execute(
        """INSERT INTO ai_pricing_applications
           (id, tenant_id, profile_id, applied_by, applied_at, scope, details_json)
           VALUES (?,?,?,?,?,?,?)""",
        (app_id, tenant_id, pid, user_id, _now_iso(), scope, json.dumps(details)),
    )
    db.commit()

    audit(
        db, tenant_id, "ai_pricing_applied", "ai_pricing_profile",
        pid, user_id, user_name,
        {"scope": scope, "updated_count": updated_count, "skipped_count": skipped_count},
    )

    return jsonify({
        "profile_id": pid,
        "updated_count": updated_count,
        "skipped_count": skipped_count,
        "scope": scope,
    })


@app.route("/api/ai-pricing/profiles/<pid>/refine-with-ai", methods=["POST"])
def ai_pricing_refine_with_ai(pid):
    """Section 4A — External AI refinement hook (stub for Alpha 9.3)."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        abort(401)
    _require_ai_pricing_perm(auth_ctx)
    tenant_id = auth_ctx["tenant_id"]
    db = get_db()

    profile = db.execute(
        "SELECT * FROM ai_pricing_profiles WHERE id=? AND tenant_id=?", (pid, tenant_id)
    ).fetchone()
    if not profile:
        abort(404)

    AI_PRICING_API_URL = os.environ.get("AI_PRICING_API_URL", "").strip()
    AI_PRICING_API_KEY = os.environ.get("AI_PRICING_API_KEY", "").strip()

    if not AI_PRICING_API_URL or not AI_PRICING_API_KEY:
        # Stub mode: nudge markup by +1.5%
        entries = db.execute(
            "SELECT * FROM ai_pricing_entries WHERE profile_id=? AND tenant_id=?",
            (pid, tenant_id),
        ).fetchall()
        for e in entries:
            if e["ai_suggested_markup_pct"] is not None:
                new_markup = round(float(e["ai_suggested_markup_pct"]) + 1.5, 2)
                new_price = round(float(e["current_base_cost"] or 0) * (1 + new_markup / 100), 2) \
                    if e["current_base_cost"] else e["ai_suggested_sell_price"]
                meta = json.loads(e["metadata_json"] or "{}")
                meta["stub_refine"] = True
                meta["original_markup"] = e["ai_suggested_markup_pct"]
                db.execute(
                    """UPDATE ai_pricing_entries
                       SET ai_suggested_markup_pct=?, ai_suggested_sell_price=?, metadata_json=?
                       WHERE id=?""",
                    (new_markup, new_price, json.dumps(meta), e["id"]),
                )
        db.commit()
        return jsonify({
            "ok": True,
            "mode": "stub",
            "note": "AI pricing API not configured. Applied +1.5% markup nudge as simulation.",
            "profile_id": pid,
        })

    # Real integration placeholder
    return jsonify({"ok": False, "reason": "ai_not_configured"}), 200


@app.route("/api/ai-pricing/profiles/<pid>/test-simulation", methods=["POST"])
def test_pricing_simulation(pid):
    """
    Test a pricing profile against recent completed quotes (Tier 4-F).
    Body: { sample_size: 20 } (default 20, max 50)
    Returns simulation results showing impact of profile on actual past quotes.
    """
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        abort(401)
    _require_ai_pricing_perm(auth_ctx)
    tenant_id = auth_ctx["tenant_id"]
    db = get_db()

    try:
        profile = db.execute(
            "SELECT * FROM ai_pricing_profiles WHERE id=? AND tenant_id=?", (pid, tenant_id)
        ).fetchone()
        if not profile:
            abort(404)

        body = request.get_json(force=True) or {}
        sample_size = min(int(body.get("sample_size", 20)), 50)

        # Load profile entries (markup targets per product/category)
        entries = db.execute(
            "SELECT * FROM ai_pricing_entries WHERE profile_id=? AND tenant_id=?",
            (pid, tenant_id),
        ).fetchall()

        # Create lookup: product_id -> markup_pct
        markup_map = {}
        for e in entries:
            if e.get("product_id"):
                markup_map[e["product_id"]] = _safe_float(e.get("ai_suggested_markup_pct"), 1.5)

        # Load last N completed quotes
        quotes = db.execute("""
            SELECT id, rep_id, total_price, total_cost
            FROM quotes
            WHERE tenant_id=? AND status='completed'
            ORDER BY updated_at DESC
            LIMIT ?
        """, (tenant_id, sample_size)).fetchall()

        if not quotes:
            return jsonify({
                "quotes_tested": 0,
                "avg_margin_delta_pct": 0,
                "avg_price_delta_pct": 0,
                "total_revenue_delta": 0,
                "sample": [],
            }), 200

        sample_data = []
        total_price_delta = 0
        total_margin_delta_pct = 0

        for quote in quotes:
            quote_id = quote["id"]
            actual_total_cost = _safe_float(quote.get("total_cost"), 0)
            actual_sell = _safe_float(quote.get("total_price"), 0)

            # Load openings for this quote
            openings = db.execute(
                "SELECT id, product_id, total_cost FROM openings WHERE quote_id=?",
                (quote_id,)
            ).fetchall()

            # Simulate under new profile
            simulated_sell = 0
            for op in openings:
                op_total_cost = _safe_float(op.get("total_cost"), 0)
                product_id = op.get("product_id")

                # Get markup from profile
                markup_pct = markup_map.get(product_id, 1.5)

                # Simulate sell price
                op_simulated_sell = round(op_total_cost * (1 + markup_pct / 100), 2)
                simulated_sell += op_simulated_sell

            price_delta = simulated_sell - actual_sell
            total_price_delta += price_delta

            # Margin calculation
            actual_margin = round((actual_sell - actual_total_cost) / actual_sell * 100, 1) if actual_sell > 0 else 0
            simulated_margin = round((simulated_sell - actual_total_cost) / simulated_sell * 100, 1) if simulated_sell > 0 else 0
            margin_delta = simulated_margin - actual_margin
            total_margin_delta_pct += margin_delta

            sample_data.append({
                "quote_id": quote_id,
                "customer_name": db.execute(
                    "SELECT customer_name FROM quotes WHERE id=?", (quote_id,)
                ).fetchone().get("customer_name", ""),
                "actual_total": round(actual_sell, 2),
                "simulated_total": round(simulated_sell, 2),
                "delta": round(price_delta, 2),
                "actual_margin_pct": actual_margin,
                "simulated_margin_pct": simulated_margin,
            })

        n = len(quotes)
        return jsonify({
            "quotes_tested": n,
            "avg_margin_delta_pct": round(total_margin_delta_pct / n, 1) if n > 0 else 0,
            "avg_price_delta_pct": round((total_price_delta / sum(quote["total_price"] for quote in quotes) * 100), 1) if sum(quote["total_price"] for quote in quotes) > 0 else 0,
            "total_revenue_delta": round(total_price_delta, 2),
            "sample": sample_data,
        }), 200
    finally:
        db.close()


# HEALTH CHECK
# ---------------------------------------------------------------------------

def _demo_requests_table_ok():
    """Verify the demo_requests table is accessible."""
    try:
        db = get_db()
        db.execute("SELECT 1 FROM demo_requests LIMIT 1")
        return True
    except Exception:
        return False
    finally:
        try:
            db.close()
        except Exception:
            pass


# ---------------------------------------------------------------------------
# ALPHA 9.4e — MAINTENANCE ENDPOINT
# Called by Cloud Scheduler (or manually by sysop) to run periodic DB cleanup.
# Keeps cold-start time fast by moving non-critical cleanup here.
# Secure: requires sysop role OR a secret maintenance token env var.
# ---------------------------------------------------------------------------

_MAINTENANCE_TOKEN = os.environ.get("MAINTENANCE_TOKEN", "").strip()

@app.route("/api/admin/maintenance", methods=["POST"])
def run_maintenance():
    """Periodic DB cleanup — intended to be called by Cloud Scheduler daily.
    Auth: sysop session OR Authorization: Bearer <MAINTENANCE_TOKEN> header."""
    # Accept either a valid sysop session or a static maintenance token
    auth_ctx = getattr(g, "auth", None)
    bearer = (request.headers.get("Authorization", "") or "").strip()
    token_ok = (
        _MAINTENANCE_TOKEN
        and bearer == f"Bearer {_MAINTENANCE_TOKEN}"
    )
    sysop_ok = (
        auth_ctx
        and _role_normalize(auth_ctx.get("user", {}).get("role", "")) == "sysop"
    )
    if not token_ok and not sysop_ok:
        return jsonify({"error": "Unauthorized"}), 401

    db = get_db()
    results = {}
    try:
        # 1. Prune expired auth sessions
        cutoff_sessions = (datetime.utcnow() - timedelta(days=30)).isoformat()
        cur = db.execute(
            "DELETE FROM auth_sessions WHERE expires_at < ?", (cutoff_sessions,)
        )
        results["sessions_pruned"] = cur.rowcount if hasattr(cur, "rowcount") else "ok"

        # 2. Prune stale rate limit attempts
        cutoff_rl = (datetime.utcnow() - timedelta(hours=2)).isoformat()
        cur = db.execute(
            "DELETE FROM rate_limit_attempts WHERE attempt_at < ?", (cutoff_rl,)
        )
        results["rate_limit_attempts_pruned"] = cur.rowcount if hasattr(cur, "rowcount") else "ok"

        # 3. Run the oversized text payload cleanup (previously ran on every cold start)
        try:
            _cleanup_oversized_text_payloads(db)
            results["oversized_payloads"] = "cleaned"
        except Exception as e:
            results["oversized_payloads"] = f"error: {e}"

        db.commit()
        results["status"] = "ok"
        results["ran_at"] = datetime.utcnow().isoformat()
        return jsonify(results), 200
    except Exception as e:
        return jsonify({"status": "error", "error": str(e)}), 500
    finally:
        db.close()


# ---------------------------------------------------------------------------
# ALPHA 9.4e — MOBILE API GROUNDWORK (Tier 3)
# Three endpoints that form the React Native app's data contract.
# Auth: Bearer token from /api/mobile/sessions OR a normal session cookie.
# ---------------------------------------------------------------------------

_MOBILE_SESSION_HOURS = int(os.environ.get("MOBILE_SESSION_HOURS", str(30 * 24)))  # 30 days default


@app.route("/api/mobile/sessions", methods=["POST"])
def mobile_create_session():
    """Authenticate a mobile device and return a long-lived Bearer token.

    Body: { email, password, device_id?, device_name?, platform? }
    Returns: { token, expires_at, session_id, user: {...} }

    This endpoint is public (no session required); it validates credentials
    and issues a 30-day Bearer token suitable for React Native storage.
    Rate-limited by IP the same way the web login is.
    """
    db = get_db()
    try:
        client_ip = (
            request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            or request.remote_addr
            or "unknown"
        )
        rl_key = f"mobile_login:{client_ip}"
        if not _db_check_rate_limit(db, rl_key, max_attempts=10, window_seconds=900):
            return jsonify({"error": "Too many login attempts. Try again in 15 minutes."}), 429

        body = request.get_json(force=True) or {}
        email = _normalize_email(body.get("email"))
        password = (body.get("password") or "").strip()
        device_id = (body.get("device_id") or "").strip() or None
        device_name = (body.get("device_name") or "").strip() or None
        platform = (body.get("platform") or "").strip() or None  # "ios" | "android"

        if not email or not password:
            return jsonify({"error": "email and password are required"}), 400

        # Find user across any tenant (email is globally unique by convention)
        user_row = db.execute(
            "SELECT * FROM users WHERE lower(email)=? AND active=1 LIMIT 1",
            (email,)
        ).fetchone()

        if not user_row or not _verify_password(password, user_row["password_hash"]):
            _db_record_attempt(db, rl_key)
            return jsonify({"error": "Invalid email or password"}), 401

        # Check field app access
        perms = _parse_permissions(user_row["permissions_json"], _role_normalize(user_row["role"]))
        role = _role_normalize(user_row["role"])
        if role not in ("sysop", "owner", "manager") and not perms.get("can_access_field_app"):
            return jsonify({"error": "This account does not have Field App access"}), 403

        _db_clear_attempts(db, rl_key)

        token, expires_at = _issue_auth_session(db, user_row, ttl_hours=_MOBILE_SESSION_HOURS)

        # Log device info in audit log for security visibility
        audit(
            db, user_row["tenant_id"], "mobile_session_created", "auth", user_row["id"],
            user_row["id"], user_row["name"],
            {"device_id": device_id, "device_name": device_name, "platform": platform},
            rep_id=user_row["id"]
        )
        db.commit()

        return jsonify({
            "token": token,
            "expires_at": expires_at,
            "session_id": None,  # embedded in token
            "device_id": device_id,
            "platform": platform,
            "user": _user_public_dict(user_row),
        }), 201

    finally:
        db.close()


@app.route("/api/mobile/bundle/<rep_id>", methods=["GET"])
def mobile_bundle(rep_id):
    """Return a complete offline data bundle for the React Native app.

    The bundle contains everything a rep needs to work offline:
    quotes, products, pricing rules, governance, and config.
    Auth: any valid session (cookie or Bearer token).
    Permission: must be the rep themselves OR have can_view_all_quotes.
    """
    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx:
            return jsonify({"error": "Authentication required"}), 401

        tenant_id = auth_ctx["tenant_id"]
        actor = auth_ctx["user"]
        actor_id = actor["id"]
        actor_role = _role_normalize(actor["role"])
        can_view_all = _has_permission_ctx(auth_ctx, "can_view_all_quotes")

        # Access control: rep can only pull their own bundle unless privileged
        if rep_id != actor_id and not can_view_all:
            return jsonify({"error": "Forbidden: you may only fetch your own bundle"}), 403

        rep_row = db.execute(
            "SELECT * FROM users WHERE id=? AND tenant_id=? AND active=1",
            (rep_id, tenant_id)
        ).fetchone()
        if not rep_row:
            return jsonify({"error": "Rep not found"}), 404

        # ── Quotes (active only, with openings inline) ──────────────────────
        quote_scope = "rep"
        quote_limit = 100
        if can_view_all and rep_id == actor_id and actor_role in ("sysop", "owner", "manager"):
            quote_scope = "tenant"
            quote_limit = 250

        if quote_scope == "tenant":
            q_rows = db.execute(
                """SELECT q.*, u.name AS rep_name, u.tier AS rep_tier
                   FROM quotes q
                   LEFT JOIN users u ON u.id = q.rep_id
                   WHERE q.tenant_id=? AND q.status != 'completed'
                   ORDER BY q.updated_at DESC
                   LIMIT ?""",
                (tenant_id, quote_limit)
            ).fetchall()
        else:
            q_rows = db.execute(
                """SELECT q.*, u.name AS rep_name, u.tier AS rep_tier
                   FROM quotes q
                   LEFT JOIN users u ON u.id = q.rep_id
                   WHERE q.tenant_id=? AND q.rep_id=? AND q.status != 'completed'
                   ORDER BY q.updated_at DESC
                   LIMIT ?""",
                (tenant_id, rep_id, quote_limit)
            ).fetchall()

        quotes = []
        for q in q_rows:
            qd = dict(q)
            opening_rows = db.execute(
                "SELECT * FROM openings WHERE quote_id=? AND tenant_id=? ORDER BY opening_number",
                (qd["id"], tenant_id)
            ).fetchall()
            openings = []
            for o in opening_rows:
                od = dict(o)
                od["width"] = od.get("total_width")
                od["height"] = od.get("total_height")
                od["noa_status"] = "ready" if od.get("noa_number") else "pending"
                if od.get("product_id"):
                    p = db.execute("SELECT name FROM products WHERE id=?", (od["product_id"],)).fetchone()
                    if p:
                        od["product_name"] = p["name"]
                if od.get("glass_option_id"):
                    g_row = db.execute("SELECT name FROM glass_options WHERE id=?", (od["glass_option_id"],)).fetchone()
                    if g_row:
                        od["glass_name"] = g_row["name"]
                if od.get("frame_color_id"):
                    fc = db.execute("SELECT name FROM frame_colors WHERE id=?", (od["frame_color_id"],)).fetchone()
                    if fc:
                        od["frame_name"] = fc["name"]
                openings.append(od)
            qd["openings"] = openings
            quotes.append(qd)

        # ── Product catalog ─────────────────────────────────────────────────
        products = [dict(r) for r in db.execute(
            "SELECT * FROM products WHERE tenant_id=? AND active=1 ORDER BY name",
            (tenant_id,)
        ).fetchall()]

        glass_options = [dict(r) for r in db.execute(
            "SELECT * FROM glass_options WHERE tenant_id=? AND active=1 ORDER BY name",
            (tenant_id,)
        ).fetchall()]

        frame_colors = [dict(r) for r in db.execute(
            "SELECT * FROM frame_colors WHERE tenant_id=? AND active=1 ORDER BY name",
            (tenant_id,)
        ).fetchall()]

        # ── Complexity items ─────────────────────────────────────────────────
        complexity_items = [dict(r) for r in db.execute(
            "SELECT * FROM complexity_items WHERE tenant_id=? ORDER BY name",
            (tenant_id,)
        ).fetchall()]

        # ── Floor labor & territory multipliers ──────────────────────────────
        floor_labor = [dict(r) for r in db.execute(
            "SELECT * FROM floor_labor WHERE tenant_id=? ORDER BY floor_level",
            (tenant_id,)
        ).fetchall()]

        territory_multipliers = [dict(r) for r in db.execute(
            "SELECT * FROM territory_multipliers WHERE tenant_id=? ORDER BY zip_code",
            (tenant_id,)
        ).fetchall()]

        consumables = [dict(r) for r in db.execute(
            "SELECT * FROM consumables WHERE tenant_id=? AND active=1 ORDER BY name",
            (tenant_id,)
        ).fetchall()]

        product_price_points = [dict(r) for r in db.execute(
            """SELECT * FROM product_price_points
               WHERE tenant_id=? AND active=1
               ORDER BY product_id, width, height""",
            (tenant_id,)
        ).fetchall()]

        discount_tiers = [dict(r) for r in db.execute(
            """SELECT * FROM discount_tiers
               WHERE tenant_id=? AND active=1
               ORDER BY min_job_total DESC""",
            (tenant_id,)
        ).fetchall()]

        # ── Governance for this rep ──────────────────────────────────────────
        governance = _get_governance_for_rep(db, tenant_id, rep_id)

        # ── Global settings ──────────────────────────────────────────────────
        gs_rows = db.execute(
            "SELECT setting_key, setting_value FROM global_settings WHERE tenant_id=?",
            (tenant_id,)
        ).fetchall()
        global_settings = {r["setting_key"]: r["setting_value"] for r in gs_rows}

        # ── Feature flags ────────────────────────────────────────────────────
        ff_rows = db.execute(
            "SELECT flag_key, enabled FROM feature_flags WHERE tenant_id=?",
            (tenant_id,)
        ).fetchall()
        feature_flags = {r["flag_key"]: bool(r["enabled"]) for r in ff_rows}

        # ── DP ratings summary (product → presure ratings map) ───────────────
        dp_ratings = [dict(r) for r in db.execute(
            """SELECT dp.*, p.name AS product_name
               FROM dp_ratings dp
               LEFT JOIN products p ON p.id = dp.product_id
               WHERE dp.tenant_id=? AND dp.active=1""",
            (tenant_id,)
        ).fetchall()]

        return jsonify({
            "bundled_at": datetime.utcnow().isoformat() + "Z",
            "app_version": APP_VERSION,
            "schema_version": SCHEMA_VERSION,
            "rep": _user_public_dict(rep_row),
            "quotes": quotes,
            "products": products,
            "glass_options": glass_options,
            "frame_colors": frame_colors,
            "complexity_items": complexity_items,
            "floor_labor": floor_labor,
            "territory_multipliers": territory_multipliers,
            "consumables": consumables,
            "product_price_points": product_price_points,
            "discount_tiers": discount_tiers,
            "governance": governance,
            "global_settings": global_settings,
            "feature_flags": feature_flags,
            "dp_ratings": dp_ratings,
            "pricing_engine_version": _PRICING_ENGINE_VERSION,
            "quote_scope": quote_scope,
        })

    finally:
        db.close()


@app.route("/api/mobile/sync/events", methods=["POST"])
def mobile_sync_events():
    """Accept a batch of offline events from the React Native app.

    Body: {
      device_id: str,
      events: [
        {
          client_event_id: str,   # UUID, idempotency key
          type: str,              # see SUPPORTED_EVENT_TYPES below
          occurred_at: str,       # ISO8601, when action happened offline
          payload: { ... }        # event-specific data
        }
      ]
    }

    Returns: { processed: int, skipped: int, errors: [...], server_time: str }

    Supported event types:
      quote_update    — update quote fields (notes, status)
      opening_add     — add a new opening to a quote
      opening_update  — update an existing opening
      opening_delete  — delete an opening
    """
    SUPPORTED_EVENT_TYPES = {"quote_create", "quote_update", "opening_add", "opening_update", "opening_delete"}

    db = get_db()
    try:
        auth_ctx = getattr(g, "auth", None)
        if not auth_ctx:
            return jsonify({"error": "Authentication required"}), 401

        tenant_id = auth_ctx["tenant_id"]
        actor = auth_ctx["user"]
        actor_id = actor["id"]
        actor_name = actor["name"]

        body = request.get_json(force=True) or {}
        device_id = (body.get("device_id") or "").strip() or None
        events = body.get("events") or []

        if not isinstance(events, list):
            return jsonify({"error": "events must be an array"}), 400
        if len(events) > 200:
            return jsonify({"error": "Maximum 200 events per batch"}), 400

        processed = 0
        skipped = 0
        errors = []

        for evt in events:
            client_event_id = (evt.get("client_event_id") or "").strip()
            evt_type = (evt.get("type") or "").strip()
            occurred_at = (evt.get("occurred_at") or _now_iso())
            payload = evt.get("payload") or {}

            if not client_event_id:
                errors.append({"error": "missing client_event_id", "event": evt_type})
                continue

            if evt_type not in SUPPORTED_EVENT_TYPES:
                errors.append({"client_event_id": client_event_id, "error": f"unsupported event type: {evt_type}"})
                continue

            # Idempotency check — skip events we've already processed
            existing = db.execute(
                "SELECT id, status FROM mobile_sync_log WHERE tenant_id=? AND client_event_id=?",
                (tenant_id, client_event_id)
            ).fetchone()
            if existing:
                skipped += 1
                continue

            log_id = f"msl-{uuid.uuid4().hex[:12]}"
            status = "ok"
            error_msg = None

            try:
                if evt_type == "quote_create":
                    qid = (payload.get("quote_id") or "").strip()
                    customer_name = (payload.get("customer_name") or "").strip()
                    if not qid:
                        raise ValueError("quote_id required")
                    if not customer_name:
                        raise ValueError("customer_name required")

                    existing_quote = db.execute(
                        "SELECT id, rep_id FROM quotes WHERE id=? AND tenant_id=?",
                        (qid, tenant_id)
                    ).fetchone()
                    if existing_quote:
                        if existing_quote["rep_id"] != actor_id and not _has_permission_ctx(auth_ctx, "can_view_all_quotes"):
                            raise ValueError("Forbidden")
                    else:
                        now = _now_iso()
                        db.execute(
                            """INSERT INTO quotes
                               (id, tenant_id, rep_id, customer_name, customer_phone, job_address, status,
                                total_price, total_cost, margin_pct, margin_dollars, notes, created_at, updated_at)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                            (
                                qid,
                                tenant_id,
                                actor_id,
                                customer_name,
                                (payload.get("customer_phone") or "").strip() or None,
                                (payload.get("job_address") or "").strip() or None,
                                (payload.get("status") or "draft").strip() or "draft",
                                _safe_float(payload.get("total_price"), 0.0),
                                _safe_float(payload.get("total_cost"), 0.0),
                                _safe_float(payload.get("margin_pct"), 0.0),
                                _safe_float(payload.get("margin_dollars"), 0.0),
                                (payload.get("notes") or "").strip() or None,
                                now,
                                now,
                            )
                        )
                        audit(
                            db, tenant_id, "quote_created_mobile", "quote", qid,
                            actor_id, actor_name,
                            {"device_id": device_id, "job_address": payload.get("job_address")},
                            rep_id=actor_id
                        )

                elif evt_type == "quote_update":
                    qid = payload.get("quote_id")
                    if not qid:
                        raise ValueError("quote_id required")
                    q = db.execute(
                        "SELECT id, rep_id FROM quotes WHERE id=? AND tenant_id=?",
                        (qid, tenant_id)
                    ).fetchone()
                    if not q:
                        raise ValueError(f"Quote {qid} not found")
                    # Reps may only update their own quotes unless privileged
                    if q["rep_id"] != actor_id and not _has_permission_ctx(auth_ctx, "can_view_all_quotes"):
                        raise ValueError("Forbidden")
                    # Whitelist of safely updatable fields from mobile
                    allowed = {"notes", "status"}
                    sets, vals = [], []
                    for k in allowed:
                        if k in payload and k != "quote_id":
                            sets.append(f"{k}=?")
                            vals.append(payload[k])
                    if sets:
                        sets.append("updated_at=?")
                        vals.append(_now_iso())
                        vals.extend([qid, tenant_id])
                        db.execute(
                            f"UPDATE quotes SET {', '.join(sets)} WHERE id=? AND tenant_id=?",
                            vals
                        )
                        audit(db, tenant_id, "quote_updated_mobile", "quote", qid,
                              actor_id, actor_name, {"device_id": device_id, "fields": list(allowed & set(payload.keys()))},
                              rep_id=actor_id)

                elif evt_type == "opening_add":
                    qid = payload.get("quote_id")
                    if not qid:
                        raise ValueError("quote_id required")
                    q = db.execute(
                        "SELECT id, rep_id FROM quotes WHERE id=? AND tenant_id=?",
                        (qid, tenant_id)
                    ).fetchone()
                    if not q:
                        raise ValueError(f"Quote {qid} not found")
                    if q["rep_id"] != actor_id and not _has_permission_ctx(auth_ctx, "can_edit_quotes"):
                        raise ValueError("Forbidden")
                    # Determine next opening number
                    max_num = db.execute(
                        "SELECT COALESCE(MAX(opening_number), 0) FROM openings WHERE quote_id=? AND tenant_id=?",
                        (qid, tenant_id)
                    ).fetchone()[0]
                    oid = (payload.get("opening_id") or "").strip() or f"op-{uuid.uuid4().hex[:10]}"
                    existing_opening = db.execute(
                        "SELECT id FROM openings WHERE id=? AND tenant_id=?",
                        (oid, tenant_id)
                    ).fetchone()
                    if existing_opening:
                        processed += 1
                        continue
                    now = _now_iso()
                    db.execute(
                        """INSERT INTO openings
                           (id, tenant_id, quote_id, rep_id, opening_number, opening_type, opening_mode,
                            total_width, total_height, floor_level, wall_type, product_id, glass_option_id, frame_color_id,
                            sell_price, total_cost, discount_pct, margin_pct, margin_dollars, dp_status, created_at, updated_at)
                           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                        (
                            oid, tenant_id, qid, actor_id, max_num + 1,
                            payload.get("opening_type", "single_hung"),
                            payload.get("opening_mode", "standard"),
                            _safe_float(payload.get("total_width", payload.get("width")), 36.0),
                            _safe_float(payload.get("total_height", payload.get("height")), 48.0),
                            payload.get("floor_level", "first"),
                            _normalize_wall_type(payload.get("wall_type", "cbs")),
                            payload.get("product_id"),
                            payload.get("glass_option_id"),
                            payload.get("frame_color_id"),
                            _safe_float(payload.get("sell_price"), 0.0),
                            _safe_float(payload.get("total_cost"), 0.0),
                            _safe_float(payload.get("discount_pct"), 0.0),
                            _safe_float(payload.get("margin_pct"), 0.0),
                            _safe_float(payload.get("margin_dollars"), 0.0),
                            payload.get("dp_status", "pending"),
                            now, now
                        )
                    )
                    audit(db, tenant_id, "opening_added_mobile", "opening", oid,
                          actor_id, actor_name, {"quote_id": qid, "device_id": device_id}, rep_id=actor_id)

                elif evt_type == "opening_update":
                    oid = payload.get("opening_id")
                    if not oid:
                        raise ValueError("opening_id required")
                    op = db.execute(
                        """SELECT o.id, o.quote_id, q.rep_id
                           FROM openings o JOIN quotes q ON q.id=o.quote_id
                           WHERE o.id=? AND o.tenant_id=?""",
                        (oid, tenant_id)
                    ).fetchone()
                    if not op:
                        raise ValueError(f"Opening {oid} not found")
                    if op["rep_id"] != actor_id and not _has_permission_ctx(auth_ctx, "can_edit_quotes"):
                        raise ValueError("Forbidden")
                    allowed_op = {
                        "opening_type", "opening_mode", "total_width", "total_height",
                        "floor_level", "wall_type", "product_id", "glass_option_id", "frame_color_id",
                        "sell_price", "total_cost", "discount_pct", "margin_pct", "margin_dollars", "dp_status"
                    }
                    sets, vals = [], []
                    for k in allowed_op:
                        if k in payload:
                            sets.append(f"{k}=?")
                            vals.append(_normalize_wall_type(payload[k], op["wall_type"]) if k == "wall_type" else payload[k])
                    if sets:
                        sets.append("updated_at=?")
                        vals.append(_now_iso())
                        vals.extend([oid, tenant_id])
                        db.execute(
                            f"UPDATE openings SET {', '.join(sets)} WHERE id=? AND tenant_id=?",
                            vals
                        )
                        audit(db, tenant_id, "opening_updated_mobile", "opening", oid,
                              actor_id, actor_name, {"device_id": device_id}, rep_id=actor_id)

                elif evt_type == "opening_delete":
                    oid = payload.get("opening_id")
                    if not oid:
                        raise ValueError("opening_id required")
                    op = db.execute(
                        """SELECT o.id, q.rep_id FROM openings o
                           JOIN quotes q ON q.id=o.quote_id
                           WHERE o.id=? AND o.tenant_id=?""",
                        (oid, tenant_id)
                    ).fetchone()
                    if not op:
                        raise ValueError(f"Opening {oid} not found")
                    if op["rep_id"] != actor_id and not _has_permission_ctx(auth_ctx, "can_delete_openings"):
                        raise ValueError("Forbidden")
                    db.execute("DELETE FROM openings WHERE id=? AND tenant_id=?", (oid, tenant_id))
                    audit(db, tenant_id, "opening_deleted_mobile", "opening", oid,
                          actor_id, actor_name, {"device_id": device_id}, rep_id=actor_id)

                processed += 1

            except Exception as e:
                status = "error"
                error_msg = str(e)
                errors.append({"client_event_id": client_event_id, "type": evt_type, "error": str(e)})

            # Write idempotency log entry regardless of success/failure
            try:
                db.execute(
                    """INSERT INTO mobile_sync_log
                       (id, tenant_id, rep_id, device_id, event_type, client_event_id,
                        payload_json, status, error_msg, created_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?)""",
                    (log_id, tenant_id, actor_id, device_id, evt_type, client_event_id,
                     json.dumps(payload), status, error_msg, _now_iso())
                )
            except Exception:
                pass  # If idempotency log fails, don't abort the whole batch

        db.commit()
        return jsonify({
            "processed": processed,
            "skipped": skipped,
            "errors": errors,
            "server_time": datetime.utcnow().isoformat() + "Z",
        })

    finally:
        db.close()


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "app_version": APP_VERSION,
        "schema_version": SCHEMA_VERSION,
        "db_backend": DB_BACKEND,
        "app_secret_configured": APP_SECRET_KEY != "windowcalc-dev-secret-change-me",
        "auth_cookie_secure": AUTH_COOKIE_SECURE,
        "chat_media_storage": CHAT_MEDIA_STORAGE,
        "chat_media_bucket_configured": bool(CHAT_MEDIA_BUCKET),
        "chat_media_url_mode": CHAT_MEDIA_URL_MODE,
        "maps_key_configured": bool(GOOGLE_MAPS_API_KEY),
        "twilio_enabled": _twilio_enabled(),
        "ai_assistant_configured": bool(ANTHROPIC_API_KEY and _AnthropicClient),
        "public_base_url_configured": bool(PUBLIC_BASE_URL),
        "marketing_landing_enabled": True,
        "demo_requests_table_ok": _demo_requests_table_ok(),
        "build_date": BUILD_DATE or None,
        "git_commit": GIT_COMMIT[:8] if GIT_COMMIT else None,
        "pricing_engine_version": _PRICING_ENGINE_VERSION,
        "timestamp": datetime.now().isoformat()
    })


# ---------------------------------------------------------------------------
# ALPHA 9.4 — PRICING INTELLIGENCE CONSOLE
# ---------------------------------------------------------------------------

def _check_pricing_intelligence_access(db, auth_ctx, require_manage=False):
    if not auth_ctx:
        abort(401)
    tid = auth_ctx.get("tenant_id") or auth_ctx.get("user", {}).get("tenant_id")
    if not tid:
        abort(401)
    flag_row = db.execute(
        "SELECT enabled FROM feature_flags WHERE tenant_id=? AND flag_key='pricing_intelligence_console'",
        (tid,)
    ).fetchone()
    if not flag_row or not flag_row["enabled"]:
        abort(403, description="Pricing Intelligence Console is not enabled for this tenant.")
    role = _role_normalize(auth_ctx.get("user", {}).get("role", ""))
    perms = auth_ctx.get("permissions", {})
    if role in ("sysop", "owner"):
        return
    if role == "manager":
        if require_manage:
            if perms.get("can_manage_pricing_intelligence"):
                return
            abort(403, description="Manage permission required for this action.")
        if perms.get("can_view_pricing_intelligence"):
            return
        mgr_toggle = _get_global_setting(db, tid, "pricing_intelligence_managers", "0")
        if str(mgr_toggle).strip() == "1":
            return
        abort(403, description="Pricing Intelligence access not enabled for managers.")
    abort(403, description="Pricing Intelligence requires owner or authorized manager.")


def _pi_date_filters(args, default_days=365):
    from_date = args.get("from_date", "")
    to_date   = args.get("to_date", "")
    if not from_date:
        from_date = (datetime.now() - timedelta(days=default_days)).strftime("%Y-%m-%d")
    if not to_date:
        to_date = datetime.now().strftime("%Y-%m-%d")
    return from_date, to_date


@app.route("/api/pricing-intelligence/overview", methods=["GET"])
def pricing_intelligence_overview():
    db = get_db()
    auth_ctx = getattr(g, "auth", None)
    _check_pricing_intelligence_access(db, auth_ctx)
    tid = auth_ctx["tenant_id"]
    from_date, to_date = _pi_date_filters(request.args)
    approved_only   = request.args.get("approved_only", "0") == "1"
    discounted_only = request.args.get("discounted_only", "0") == "1"
    where  = ["o.tenant_id=?", "o.created_at>=?", "o.created_at<=?"]
    params = [tid, from_date, to_date + " 23:59:59"]
    if approved_only:
        where.append("q.status IN ('approved','completed')")
    if discounted_only:
        where.append("o.discount_pct > 0")
    w = " AND ".join(where)
    base = "FROM openings o JOIN quotes q ON q.id=o.quote_id LEFT JOIN products p ON p.id=o.product_id"
    agg = db.execute(f"""
        SELECT COUNT(DISTINCT q.id) AS quotes_analyzed,
               COUNT(o.id) AS openings_analyzed,
               ROUND(AVG(o.sell_price),2) AS avg_sell_price,
               ROUND(AVG(o.total_cost),2) AS avg_cost,
               ROUND(AVG(o.margin_pct),2) AS avg_margin_pct,
               ROUND(AVG(o.discount_pct),2) AS avg_discount_pct,
               SUM(CASE WHEN q.status='pending_approval' THEN 1 ELSE 0 END) AS approval_requests,
               SUM(CASE WHEN q.status IN ('approved','completed') THEN 1 ELSE 0 END) AS closed_count
        {base} WHERE {w}
    """, params).fetchone()
    total_q = agg["quotes_analyzed"] or 0
    approval_rate = round((agg["approval_requests"] or 0) / total_q * 100, 1) if total_q else 0
    margin_buckets = []
    for lo, hi in [(0,10),(10,20),(20,30),(30,40),(40,50),(50,60),(60,None)]:
        if hi is None:
            cnt = db.execute(f"SELECT COUNT(*) {base} WHERE {w} AND o.margin_pct>=?", params+[lo]).fetchone()[0]
            label = f"{lo}+"
        else:
            cnt = db.execute(f"SELECT COUNT(*) {base} WHERE {w} AND o.margin_pct>=? AND o.margin_pct<?", params+[lo,hi]).fetchone()[0]
            label = f"{lo}-{hi}"
        margin_buckets.append({"bucket": label, "count": cnt})
    price_buckets = []
    for lo, hi in [(0,2500),(2500,5000),(5000,10000),(10000,20000),(20000,50000),(50000,None)]:
        if hi is None:
            cnt = db.execute(f"SELECT COUNT(*) {base} WHERE {w} AND o.sell_price>=?", params+[lo]).fetchone()[0]
            label = f"{lo}+"
        else:
            cnt = db.execute(f"SELECT COUNT(*) {base} WHERE {w} AND o.sell_price>=? AND o.sell_price<?", params+[lo,hi]).fetchone()[0]
            label = f"{lo}-{hi}"
        price_buckets.append({"bucket": label, "count": cnt})
    trend_rows = db.execute(f"""
        SELECT strftime('%Y-%m', o.created_at) AS period,
               ROUND(AVG(o.margin_pct),2) AS avg_margin_pct,
               ROUND(AVG(o.sell_price),2) AS avg_sell_price,
               COUNT(o.id) AS opening_count
        {base} WHERE {w}
        GROUP BY period ORDER BY period
    """, params).fetchall()
    return jsonify({
        "quotes_analyzed":     total_q,
        "openings_analyzed":   agg["openings_analyzed"] or 0,
        "avg_sell_price":      agg["avg_sell_price"] or 0,
        "avg_cost":            agg["avg_cost"] or 0,
        "avg_margin_pct":      agg["avg_margin_pct"] or 0,
        "approval_rate":       approval_rate,
        "discount_rate":       round(agg["avg_discount_pct"] or 0, 1),
        "margin_distribution": margin_buckets,
        "price_distribution":  price_buckets,
        "trend_over_time":     [dict(r) for r in trend_rows],
    })


@app.route("/api/pricing-intelligence/by-brand-model", methods=["GET"])
def pricing_intelligence_by_brand_model():
    db = get_db()
    auth_ctx = getattr(g, "auth", None)
    _check_pricing_intelligence_access(db, auth_ctx)
    tid = auth_ctx["tenant_id"]
    from_date, to_date = _pi_date_filters(request.args)
    where  = ["o.tenant_id=?", "o.created_at>=?", "o.created_at<=?"]
    params = [tid, from_date, to_date+" 23:59:59"]
    if request.args.get("brand"):
        where.append("p.manufacturer=?"); params.append(request.args["brand"])
    if request.args.get("product_line"):
        where.append("p.product_line=?"); params.append(request.args["product_line"])
    if request.args.get("rep_id"):
        where.append("q.rep_id=?"); params.append(request.args["rep_id"])
    if request.args.get("approved_only") == "1":
        where.append("q.status IN ('approved','completed')")
    if request.args.get("discounted_only") == "1":
        where.append("o.discount_pct > 0")
    w = " AND ".join(where)
    rows = db.execute(f"""
        SELECT COALESCE(p.manufacturer,'Unknown') AS brand,
               COALESCE(p.model_number,'Unknown') AS model,
               COALESCE(p.product_line,'Unknown') AS product_line,
               o.opening_type,
               COUNT(DISTINCT q.id) AS quote_count,
               COUNT(o.id) AS opening_count,
               ROUND(AVG(o.sell_price),2) AS avg_sell_price,
               ROUND(AVG(o.total_cost),2) AS avg_cost,
               ROUND(AVG(o.margin_pct),2) AS avg_margin_pct,
               ROUND(AVG(o.discount_pct),2) AS avg_discount_pct,
               ROUND(SUM(CASE WHEN q.status IN ('approved','completed') THEN 1.0 ELSE 0 END)/COUNT(DISTINCT q.id)*100,1) AS approval_rate
        FROM openings o JOIN quotes q ON q.id=o.quote_id LEFT JOIN products p ON p.id=o.product_id
        WHERE {w}
        GROUP BY brand, model, product_line, o.opening_type
        ORDER BY opening_count DESC
    """, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/pricing-intelligence/by-category", methods=["GET"])
def pricing_intelligence_by_category():
    db = get_db()
    auth_ctx = getattr(g, "auth", None)
    _check_pricing_intelligence_access(db, auth_ctx)
    tid = auth_ctx["tenant_id"]
    from_date, to_date = _pi_date_filters(request.args)
    where  = ["o.tenant_id=?", "o.created_at>=?", "o.created_at<=?"]
    params = [tid, from_date, to_date+" 23:59:59"]
    if request.args.get("approved_only") == "1":
        where.append("q.status IN ('approved','completed')")
    if request.args.get("discounted_only") == "1":
        where.append("o.discount_pct > 0")
    w = " AND ".join(where)
    rows = db.execute(f"""
        SELECT o.opening_type,
               COUNT(o.id) AS opening_count,
               ROUND(AVG(o.sell_price),2) AS avg_sell_price,
               ROUND(AVG(o.margin_pct),2) AS avg_margin_pct,
               ROUND(AVG(o.discount_pct),2) AS avg_discount_pct,
               ROUND(SUM(CASE WHEN q.status IN ('approved','completed') THEN 1.0 ELSE 0 END)/COUNT(DISTINCT q.id)*100,1) AS approval_rate
        FROM openings o JOIN quotes q ON q.id=o.quote_id
        WHERE {w}
        GROUP BY o.opening_type ORDER BY opening_count DESC
    """, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/pricing-intelligence/brand-comparison", methods=["GET"])
def pricing_intelligence_brand_comparison():
    db = get_db()
    auth_ctx = getattr(g, "auth", None)
    _check_pricing_intelligence_access(db, auth_ctx)
    tid = auth_ctx["tenant_id"]
    from_date, to_date = _pi_date_filters(request.args)
    where  = ["o.tenant_id=?", "o.created_at>=?", "o.created_at<=?"]
    params = [tid, from_date, to_date+" 23:59:59"]
    if request.args.get("brand"):
        where.append("p.manufacturer=?"); params.append(request.args["brand"])
    if request.args.get("product_line"):
        where.append("p.product_line=?"); params.append(request.args["product_line"])
    if request.args.get("rep_id"):
        where.append("q.rep_id=?"); params.append(request.args["rep_id"])
    if request.args.get("approved_only") == "1":
        where.append("q.status IN ('approved','completed')")
    if request.args.get("discounted_only") == "1":
        where.append("o.discount_pct > 0")
    w = " AND ".join(where)
    rows = db.execute(f"""
        SELECT o.opening_type,
               COALESCE(p.manufacturer,'Unknown') AS brand,
               COUNT(o.id) AS opening_count,
               ROUND(AVG(o.margin_pct),2) AS avg_margin_pct,
               ROUND(AVG(o.sell_price),2) AS avg_sell_price,
               ROUND(AVG(o.discount_pct),2) AS avg_discount_pct
        FROM openings o JOIN quotes q ON q.id=o.quote_id LEFT JOIN products p ON p.id=o.product_id
        WHERE {w}
        GROUP BY o.opening_type, brand
        ORDER BY o.opening_type, opening_count DESC
    """, params).fetchall()
    return jsonify([dict(r) for r in rows])


@app.route("/api/pricing-intelligence/by-rep", methods=["GET"])
def pricing_intelligence_by_rep():
    db = get_db()
    auth_ctx = getattr(g, "auth", None)
    _check_pricing_intelligence_access(db, auth_ctx)
    tid = auth_ctx["tenant_id"]
    from_date, to_date = _pi_date_filters(request.args)
    where  = ["o.tenant_id=?", "o.created_at>=?", "o.created_at<=?"]
    params = [tid, from_date, to_date+" 23:59:59"]
    if request.args.get("approved_only") == "1":
        where.append("q.status IN ('approved','completed')")
    if request.args.get("discounted_only") == "1":
        where.append("o.discount_pct > 0")
    w = " AND ".join(where)
    gov_rows = db.execute("SELECT tier, margin_floor FROM governance_settings WHERE tenant_id=?", (tid,)).fetchall()
    gov_by_tier = {r["tier"]: r["margin_floor"] for r in gov_rows}
    default_floor = gov_by_tier.get("standard", 30.0)
    rep_rows = db.execute(f"""
        SELECT q.rep_id, u.name AS rep_name, u.tier AS rep_tier,
               COUNT(DISTINCT q.id) AS quote_count,
               COUNT(o.id) AS opening_count,
               ROUND(AVG(o.margin_pct),2) AS avg_margin_pct,
               ROUND(AVG(o.discount_pct),2) AS avg_discount_pct,
               SUM(CASE WHEN q.status='pending_approval' THEN 1 ELSE 0 END) AS approval_requests,
               SUM(CASE WHEN q.status IN ('approved','completed') THEN 1 ELSE 0 END) AS closed_count
        FROM openings o JOIN quotes q ON q.id=o.quote_id JOIN users u ON u.id=q.rep_id
        WHERE {w}
        GROUP BY q.rep_id ORDER BY opening_count DESC
    """, params).fetchall()
    result = []
    for r in rep_rows:
        floor = gov_by_tier.get(r["rep_tier"] or "standard", default_floor)
        below_count = db.execute("""
            SELECT COUNT(o.id) FROM openings o JOIN quotes q ON q.id=o.quote_id
            WHERE o.tenant_id=? AND q.rep_id=? AND o.created_at>=? AND o.created_at<=? AND o.margin_pct<?
        """, (tid, r["rep_id"], from_date, to_date+" 23:59:59", floor)).fetchone()[0]
        total = r["opening_count"] or 1
        closed = r["closed_count"] or 0
        denom  = closed + (r["approval_requests"] or 0)
        result.append({
            "rep_id":            r["rep_id"],
            "rep_name":          r["rep_name"] or r["rep_id"],
            "quote_count":       r["quote_count"],
            "opening_count":     r["opening_count"],
            "avg_margin_pct":    r["avg_margin_pct"] or 0,
            "avg_discount_pct":  r["avg_discount_pct"] or 0,
            "approval_requests": r["approval_requests"],
            "below_floor_rate":  round(below_count / total * 100, 1),
            "close_rate":        round(closed / denom * 100, 1) if denom else 0,
        })
    return jsonify(result)


@app.route("/api/pricing-intelligence/model-detail", methods=["GET"])
def pricing_intelligence_model_detail():
    db = get_db()
    auth_ctx = getattr(g, "auth", None)
    _check_pricing_intelligence_access(db, auth_ctx)
    tid = auth_ctx["tenant_id"]
    brand        = request.args.get("brand", "")
    model        = request.args.get("model", "")
    product_line = request.args.get("product_line", "")
    from_date, to_date = _pi_date_filters(request.args)
    where  = ["o.tenant_id=?", "o.created_at>=?", "o.created_at<=?"]
    params = [tid, from_date, to_date+" 23:59:59"]
    if brand:
        where.append("COALESCE(p.manufacturer,'Unknown')=?"); params.append(brand)
    if model:
        where.append("COALESCE(p.model_number,'Unknown')=?"); params.append(model)
    if product_line:
        where.append("COALESCE(p.product_line,'Unknown')=?"); params.append(product_line)
    w  = " AND ".join(where)
    bj = "FROM openings o JOIN quotes q ON q.id=o.quote_id LEFT JOIN products p ON p.id=o.product_id"
    margin_buckets = []
    for lo, hi in [(0,10),(10,20),(20,30),(30,40),(40,50),(50,60),(60,None)]:
        if hi is None:
            cnt = db.execute(f"SELECT COUNT(*) {bj} WHERE {w} AND o.margin_pct>=?", params+[lo]).fetchone()[0]
            label = f"{lo}+"
        else:
            cnt = db.execute(f"SELECT COUNT(*) {bj} WHERE {w} AND o.margin_pct>=? AND o.margin_pct<?", params+[lo,hi]).fetchone()[0]
            label = f"{lo}-{hi}"
        margin_buckets.append({"bucket": label, "count": cnt})
    price_buckets = []
    for lo, hi in [(0,2500),(2500,5000),(5000,10000),(10000,20000),(20000,50000),(50000,None)]:
        if hi is None:
            cnt = db.execute(f"SELECT COUNT(*) {bj} WHERE {w} AND o.sell_price>=?", params+[lo]).fetchone()[0]
            label = f"{lo}+"
        else:
            cnt = db.execute(f"SELECT COUNT(*) {bj} WHERE {w} AND o.sell_price>=? AND o.sell_price<?", params+[lo,hi]).fetchone()[0]
            label = f"{lo}-{hi}"
        price_buckets.append({"bucket": label, "count": cnt})
    trend = db.execute(f"""
        SELECT strftime('%Y-%m', o.created_at) AS period,
               ROUND(AVG(o.margin_pct),2) AS avg_margin_pct,
               ROUND(AVG(o.sell_price),2) AS avg_sell_price,
               COUNT(o.id) AS opening_count
        {bj} WHERE {w} GROUP BY period ORDER BY period
    """, params).fetchall()
    scatter = db.execute(f"""
        SELECT o.total_width AS width, o.total_height AS height,
               o.sell_price, o.margin_pct
        {bj} WHERE {w} AND o.sell_price>0
        ORDER BY o.created_at DESC LIMIT 200
    """, params).fetchall()
    return jsonify({
        "brand": brand, "model": model, "product_line": product_line,
        "price_distribution":  price_buckets,
        "margin_distribution": margin_buckets,
        "trend_over_time":     [dict(r) for r in trend],
        "size_vs_price":       [dict(r) for r in scatter],
    })


# ---------------------------------------------------------------------------
# ALPHA 9.4 — PART B: MARKETING / DEMO REQUESTS
# ---------------------------------------------------------------------------

def _send_notification_email(subject, body_text):
    """Send notification email to the configured address.
    Requires env vars: SMTP_EMAIL (sender address), SMTP_PASSWORD (Gmail App Password).
    Recipient comes from NOTIFY_EMAIL; nothing is sent when it is unset.
    Fails silently — never blocks the main request.
    """
    import smtplib, ssl as _ssl
    from email.mime.text import MIMEText
    from email.mime.multipart import MIMEMultipart as _MIME

    smtp_email    = os.environ.get("SMTP_EMAIL", "").strip()
    smtp_password = os.environ.get("SMTP_PASSWORD", "").strip()
    notify_to     = os.environ.get("NOTIFY_EMAIL", "").strip()

    if not smtp_email or not smtp_password or not notify_to:
        app.logger.info("_send_notification_email: SMTP_EMAIL/SMTP_PASSWORD not set — skipped")
        return False
    try:
        msg = _MIME("alternative")
        msg["Subject"] = subject
        msg["From"]    = f"WindowCalc Leads <{smtp_email}>"
        msg["To"]      = notify_to
        msg.attach(MIMEText(body_text, "plain"))
        ctx = _ssl.create_default_context()
        with smtplib.SMTP("smtp.gmail.com", 587) as srv:
            srv.ehlo()
            srv.starttls(context=ctx)
            srv.login(smtp_email, smtp_password)
            srv.sendmail(smtp_email, notify_to, msg.as_string())
        app.logger.info(f"_send_notification_email: sent '{subject}' to {notify_to}")
        return True
    except Exception as ex:
        app.logger.error(f"_send_notification_email failed: {ex}")
        return False


@app.route("/api/marketing/demo-request", methods=["POST"])
def marketing_demo_request():
    """B3A — Public demo lead capture. No auth required."""
    db   = get_db()
    body = request.get_json(silent=True) or {}
    # Sanitize and validate all incoming lead fields
    name  = _sanitize_text_field((body.get("name")  or ""), 120).strip()
    email = _sanitize_text_field((body.get("email") or ""), 200).strip().lower()
    if not name:
        return jsonify({"error": "Name is required."}), 400
    if not email or "@" not in email or len(email) > 200:
        return jsonify({"error": "Valid email is required."}), 400

    company    = _sanitize_text_field((body.get("company")      or ""), 200).strip() or None
    phone      = _sanitize_text_field((body.get("phone")        or ""), 30).strip()  or None
    size       = _sanitize_text_field((body.get("company_size") or ""), 50).strip()  or None
    source     = _sanitize_text_field((body.get("source")       or "landing"), 80).strip()
    challenge  = _sanitize_text_field((body.get("challenge")    or ""), 200).strip() or None
    volume     = _sanitize_text_field((body.get("volume")       or ""), 50).strip()  or None

    # Build notes from enriched fields
    note_parts = []
    if challenge: note_parts.append(f"Challenge: {challenge}")
    if volume:    note_parts.append(f"Volume: {volume}")
    notes = " | ".join(note_parts) or None

    dr_id = f"dr-{uuid.uuid4().hex[:10]}"
    db.execute(
        """INSERT INTO demo_requests (id,name,email,company,phone,company_size,source,notes,created_at)
           VALUES (?,?,?,?,?,?,?,?,?)""",
        (dr_id, name, email, company, phone, size, source, notes, _now_iso())
    )
    db.commit()

    # Fire-and-forget email notification — never blocks response
    try:
        lines = [
            "New WindowCalc Demo Request",
            "=" * 44,
            f"Name:         {name}",
            f"Email:        {email}",
            f"Company:      {company or '—'}",
            f"Phone:        {phone or '—'}",
            f"Team Size:    {size or '—'}",
            f"Volume:       {volume or '—'}",
            f"Challenge:    {challenge or '—'}",
            f"Source:       {source}",
            f"Lead ID:      {dr_id}",
            f"Submitted:    {_now_iso()}",
            "",
            "View in System Console → Demo Requests",
        ]
        _send_notification_email(
            f"🪟 New Demo Request — {name} ({company or email})",
            "\n".join(lines)
        )
    except Exception:
        pass  # never fail the main request

    # Auto-score the lead (1–5 based on signals)
    score = 1
    size_map = {"30+ reps": 5, "16–30 reps": 4, "16-30 reps": 4,
                "8–15 reps": 3, "8-15 reps": 3, "4–7 reps": 2, "4-7 reps": 2}
    score = size_map.get(size or "", 1)
    if phone:  score = min(score + 1, 5)
    if challenge: score = min(score + 1, 5)
    if email and not any(d in email for d in ["@gmail","@yahoo","@hotmail","@outlook","@icloud"]):
        score = min(score + 1, 5)
    db.execute("UPDATE demo_requests SET score=?, last_activity_at=? WHERE id=?",
               (score, _now_iso(), dr_id))
    db.commit()

    return jsonify({"ok": True, "id": dr_id}), 201


@app.route("/api/marketing/demo-requests", methods=["GET"])
def marketing_demo_requests_list():
    """Sysop only — view captured leads."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        abort(401)
    if _role_normalize(auth_ctx.get("user", {}).get("role", "")) != "sysop":
        abort(403, description="Sysop only.")
    db     = get_db()
    limit  = min(int(request.args.get("limit", 50)), 200)
    offset = int(request.args.get("offset", 0))
    rows   = db.execute(
        "SELECT * FROM demo_requests ORDER BY created_at DESC LIMIT ? OFFSET ?",
        (limit, offset)
    ).fetchall()
    total  = db.execute("SELECT COUNT(*) FROM demo_requests").fetchone()[0]
    return jsonify({"items": [dict(r) for r in rows], "total": total})


# ---------------------------------------------------------------------------
# ALPHA 9.4 — SYSTEM: DEMO REQUESTS PANEL (Sysop-only)
# ---------------------------------------------------------------------------

import csv
import io as _io


def _demo_requests_sysop_gate(auth_ctx):
    """Abort if caller is not a sysop."""
    if not auth_ctx:
        abort(401)
    if _role_normalize(auth_ctx.get("user", {}).get("role", "")) != "sysop":
        abort(403, description="Sysop only.")


def _demo_requests_query(db, args):
    """Build WHERE + params for demo_requests with optional date filters."""
    where_parts = []
    params = []
    from_date = (args.get("from_date") or "").strip()
    to_date   = (args.get("to_date")   or "").strip()
    if from_date:
        where_parts.append("created_at >= ?")
        params.append(from_date)
    if to_date:
        where_parts.append("created_at <= ?")
        params.append(to_date + "T23:59:59")
    where = ("WHERE " + " AND ".join(where_parts)) if where_parts else ""
    return where, params


@app.route("/api/system/demo-requests", methods=["GET"])
def system_demo_requests():
    """Sysop-only — paginated demo request list with optional date range."""
    auth_ctx = getattr(g, "auth", None)
    _demo_requests_sysop_gate(auth_ctx)
    db = get_db()
    try:
        limit  = min(int(request.args.get("limit", 100)), 500)
        offset = int(request.args.get("offset", 0))
        where, params = _demo_requests_query(db, request.args)
        rows = db.execute(
            f"SELECT id,name,email,company,phone,company_size,source,created_at "
            f"FROM demo_requests {where} ORDER BY created_at DESC LIMIT ? OFFSET ?",
            (*params, limit, offset),
        ).fetchall()
        total = db.execute(
            f"SELECT COUNT(*) FROM demo_requests {where}", params
        ).fetchone()[0]
        return jsonify({"items": [dict(r) for r in rows], "total": total})
    finally:
        db.close()


@app.route("/api/system/demo-requests/export", methods=["GET"])
def system_demo_requests_export():
    """Sysop-only — CSV export of demo requests."""
    auth_ctx = getattr(g, "auth", None)
    _demo_requests_sysop_gate(auth_ctx)
    db = get_db()
    try:
        where, params = _demo_requests_query(db, request.args)
        rows = db.execute(
            f"SELECT id,name,email,company,phone,company_size,source,created_at "
            f"FROM demo_requests {where} ORDER BY created_at DESC",
            params,
        ).fetchall()
        buf = _io.StringIO()
        writer = csv.DictWriter(
            buf,
            fieldnames=["id", "name", "email", "company", "phone", "company_size", "source", "created_at"],
        )
        writer.writeheader()
        for row in rows:
            writer.writerow({
                "id": row["id"] or "",
                "name": row["name"] or "",
                "email": row["email"] or "",
                "company": row["company"] or "",
                "phone": row["phone"] or "",
                "company_size": row["company_size"] or "",
                "source": row["source"] or "",
                "created_at": (row["created_at"] or "")[:10],
            })
        csv_bytes = buf.getvalue().encode("utf-8")
        return Response(
            csv_bytes,
            mimetype="text/csv",
            headers={"Content-Disposition": "attachment; filename=demo_requests.csv"},
        )
    finally:
        db.close()


# ---------------------------------------------------------------------------
# ALPHA 9.4 — PROPOSAL VIEW TOKEN (Convenience wrapper)
# ---------------------------------------------------------------------------

@app.route("/api/quotes/<qid>/proposal-view-token", methods=["GET"])
def get_proposal_view_token(qid):
    """
    Create a snapshot + share link in one call and return the public URL.
    Permissions: owner, manager, sysop.
    """
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        actor_role = _role_normalize(auth_ctx["user"]["role"]) if auth_ctx and auth_ctx.get("user") else ""
        if actor_role not in ("manager", "owner", "sysop"):
            return jsonify({"error": "Managers or owners can generate proposal links."}), 403

        quote_row = _load_quote_access_row(db, None, qid)
        if not quote_row:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote_row, auth_ctx, "Quote")
        tenant_id = quote_row["tenant_id"]
        if not _auth_can_access_quote(auth_ctx, quote_row):
            return jsonify({"error": "Forbidden"}), 403

        # Build snapshot
        created_at = _now_iso()
        payload = _build_proposal_snapshot_payload(db, tenant_id, qid, generated_at=created_at)
        if not (payload and payload.get("openings")):
            return jsonify({"error": "Add at least one opening before generating a proposal link."}), 400

        snapshot_id = f"ps-{uuid.uuid4().hex[:12]}"
        db.execute(
            """INSERT INTO proposal_snapshots
               (id,tenant_id,quote_id,generated_by,quote_snapshot,pdf_gcs_path,created_at)
               VALUES (?,?,?,?,?,?,?)""",
            (snapshot_id, tenant_id, qid, user_id, json.dumps(payload), None, created_at),
        )

        # Build share (7-day expiry)
        share_id = f"share-{uuid.uuid4().hex[:12]}"
        token = secrets.token_hex(16)
        from datetime import timedelta
        expires_at = (datetime.utcnow() + timedelta(days=7)).isoformat()
        db.execute(
            """INSERT INTO proposal_shares
               (id,tenant_id,quote_id,snapshot_id,created_by,token,expires_at,viewed_count,last_viewed_at,customer_response,created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (share_id, tenant_id, qid, snapshot_id, user_id, token, expires_at, 0, None, None, created_at),
        )

        audit(db, tenant_id, "proposal_view_token_created", "quote", qid,
              user_id, user_name, {"snapshot_id": snapshot_id, "share_id": share_id})
        db.commit()

        share_url = _absolute_public_url(f"/estimate/{token}")
        return jsonify({
            "token": token,
            "expires_at": expires_at,
            "url": share_url,
            "snapshot_id": snapshot_id,
            "share_id": share_id,
        })
    finally:
        db.close()


# ---------------------------------------------------------------------------
# ALPHA 9.4 — REPORTS: MARGIN TREND + REP PERFORMANCE
# ---------------------------------------------------------------------------

@app.route("/api/reports/margin-trend", methods=["GET"])
def get_margin_trend_report():
    """Monthly margin trend — avg_margin, revenue, quote_count per month."""
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _can_access_reports(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        # Date window — default last 12 months
        from_date = (request.args.get("from_date") or "").strip()
        to_date   = (request.args.get("to_date")   or "").strip()
        if not from_date:
            from datetime import timedelta
            from_date = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
        if not to_date:
            to_date = datetime.now().strftime("%Y-%m-%d")

        rep_id = (request.args.get("rep_id") or "").strip() or None

        where_parts = ["tenant_id=?", "created_at >= ?", "created_at <= ?"]
        params = [tenant_id, from_date, to_date + "T23:59:59"]
        if rep_id:
            where_parts.append("rep_id = ?")
            params.append(rep_id)
        where = " AND ".join(where_parts)
        month_expr = "strftime('%Y-%m', created_at)" if DB_BACKEND == "sqlite" else "TO_CHAR(created_at, 'YYYY-MM')"

        rows = db.execute(
            f"""SELECT {month_expr} AS month,
                       AVG(CASE WHEN margin_pct IS NOT NULL THEN margin_pct END) AS avg_margin,
                       SUM(CASE WHEN status='completed' THEN COALESCE(total_price,0) ELSE 0 END) AS revenue,
                       COUNT(*) AS quote_count
                FROM quotes
                WHERE {where}
                GROUP BY month
                ORDER BY month""",
            params,
        ).fetchall()

        return jsonify([{
            "month": r["month"],
            "avg_margin": round(float(r["avg_margin"] or 0.0), 2),
            "revenue": round(float(r["revenue"] or 0.0), 2),
            "quote_count": int(r["quote_count"] or 0),
        } for r in rows])
    finally:
        db.close()


@app.route("/api/reports/rep-performance", methods=["GET"])
def get_rep_performance_report():
    """Rep leaderboard — quotes, completed_jobs, avg_margin, close_rate per rep."""
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _can_access_reports(auth_ctx):
            return jsonify({"error": "Forbidden"}), 403

        from_date = (request.args.get("from_date") or "").strip()
        to_date   = (request.args.get("to_date")   or "").strip()
        if not from_date:
            from datetime import timedelta
            from_date = (datetime.now() - timedelta(days=365)).strftime("%Y-%m-%d")
        if not to_date:
            to_date = datetime.now().strftime("%Y-%m-%d")

        where_parts = ["q.tenant_id=?", "q.created_at >= ?", "q.created_at <= ?"]
        params = [tenant_id, from_date, to_date + "T23:59:59"]
        where = " AND ".join(where_parts)

        rows = db.execute(
            f"""SELECT q.rep_id,
                       COALESCE(u.name, q.rep_id, 'Unknown') AS rep_name,
                       COUNT(*) AS quotes,
                       SUM(CASE WHEN q.status='completed' THEN 1 ELSE 0 END) AS completed_jobs,
                       AVG(CASE WHEN q.margin_pct IS NOT NULL THEN q.margin_pct END) AS avg_margin,
                       100.0 * SUM(CASE WHEN q.status IN ('approved','completed') THEN 1 ELSE 0 END)
                       / NULLIF(COUNT(*), 0) AS close_rate
                FROM quotes q
                LEFT JOIN users u ON u.id=q.rep_id AND u.tenant_id=q.tenant_id
                WHERE {where}
                GROUP BY q.rep_id, u.name
                ORDER BY completed_jobs DESC, avg_margin DESC""",
            params,
        ).fetchall()

        return jsonify([{
            "rep_id": r["rep_id"],
            "rep_name": r["rep_name"],
            "quotes": int(r["quotes"] or 0),
            "completed_jobs": int(r["completed_jobs"] or 0),
            "avg_margin": round(float(r["avg_margin"] or 0.0), 2),
            "close_rate": round(float(r["close_rate"] or 0.0), 2),
        } for r in rows])
    finally:
        db.close()


# ---------------------------------------------------------------------------
# ENTRY POINT
# ---------------------------------------------------------------------------

def _run_dev_server():
    """Start the Flask dev server after all routes have been registered."""
    port = int(os.environ.get("PORT", 8080))
    app.run(host="0.0.0.0", port=port, debug=False)

def _ensure_sample_leads(db):
    """Seed 6 sample leads (demo data only) if no leads exist yet. Idempotent."""
    if not SEED_DEMO_DATA:
        return
    existing = db.execute("SELECT COUNT(*) FROM demo_requests").fetchone()[0]
    if existing > 0:
        return  # already have leads, don't re-seed

    import uuid as _uuid

    sample_leads = [
        {
            "id":           "dr-sample-0001",
            "name":         "Carlos Mendez",
            "email":        "carlos.mendez@example.com",
            "company":      "Sunrise Demo Windows LLC",
            "phone":        "(954) 555-0301",
            "company_size": "8–15 reps",
            "source":       "Google Search",
            "status":       "new",
            "priority":     1,
            "score":        5,
            "notes":        "Challenge: Reps discounting too aggressively | Volume: 50–100/mo",
            "follow_up_date": None,
            "custom_tag":   None,
        },
        {
            "id":           "dr-sample-0002",
            "name":         "Diana Fuentes",
            "email":        "diana.fuentes@example.com",
            "company":      "Sample Window and Door Inc.",
            "phone":        "(305) 555-0302",
            "company_size": "4–7 reps",
            "source":       "Industry referral",
            "status":       "contacted",
            "priority":     1,
            "score":        4,
            "notes":        "Challenge: No visibility into field pricing decisions | Volume: 20–50/mo",
            "follow_up_date": None,
            "custom_tag":   None,
        },
        {
            "id":           "dr-sample-0003",
            "name":         "Marcus Thompson",
            "email":        "marcus.thompson@example.com",
            "company":      "Demo Shield Windows",
            "phone":        "(561) 555-0303",
            "company_size": "16–30 reps",
            "source":       "Trade show",
            "status":       "in_progress",
            "priority":     1,
            "score":        5,
            "notes":        "Challenge: All of the above | Volume: 100+/mo",
            "follow_up_date": None,
            "custom_tag":   None,
        },
        {
            "id":           "dr-sample-0004",
            "name":         "Rachel Kim",
            "email":        "rachel.kim@example.com",
            "company":      "Kim Home Renovations",
            "phone":        None,
            "company_size": "1–3 reps",
            "source":       "Social media",
            "status":       "cold",
            "priority":     0,
            "score":        1,
            "notes":        "Challenge: Manual spreadsheet quoting is error-prone | Volume: Under 20/mo",
            "follow_up_date": None,
            "custom_tag":   None,
        },
        {
            "id":           "dr-sample-0005",
            "name":         "James Okafor",
            "email":        "james.okafor@example.com",
            "company":      "Example Impact Solutions",
            "phone":        "(561) 555-0305",
            "company_size": "8–15 reps",
            "source":       "Direct outreach",
            "status":       "quoted",
            "priority":     0,
            "score":        4,
            "notes":        "Challenge: Need CPA-ready financial controls | Volume: 50–100/mo",
            "follow_up_date": None,
            "custom_tag":   "Hot Lead",
        },
        {
            "id":           "dr-sample-0006",
            "name":         "Sofia Reyes",
            "email":        "sofia.reyes@example.com",
            "company":      "Sample Coast Windows & Doors",
            "phone":        "(786) 555-0306",
            "company_size": "4–7 reps",
            "source":       "Google Search",
            "status":       "new",
            "priority":     0,
            "score":        3,
            "notes":        "Challenge: No approval workflow for exceptions | Volume: 20–50/mo",
            "follow_up_date": None,
            "custom_tag":   None,
        },
    ]

    from datetime import datetime, timedelta, timezone
    now = datetime.now(timezone.utc)

    for i, lead in enumerate(sample_leads):
        # Stagger submission times — most recent first
        submitted_at = (now - timedelta(days=i * 3, hours=i * 2)).strftime("%Y-%m-%dT%H:%M:%S")
        last_act     = (now - timedelta(days=i,     hours=i)).strftime("%Y-%m-%dT%H:%M:%S")

        db.execute(
            """INSERT OR IGNORE INTO demo_requests
               (id, name, email, company, phone, company_size, source, notes,
                status, priority, score, custom_tag, follow_up_date,
                last_activity_at, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                lead["id"], lead["name"], lead["email"],
                lead["company"], lead["phone"], lead["company_size"],
                lead["source"], lead["notes"],
                lead["status"], lead["priority"], lead["score"],
                lead["custom_tag"], lead["follow_up_date"],
                last_act, submitted_at,
            )
        )

        # Seed an activity entry for non-new leads
        if lead["status"] != "new":
            db.execute(
                """INSERT OR IGNORE INTO lead_activity
                   (id, lead_id, event_type, old_value, new_value, created_at)
                   VALUES (?,?,?,?,?,?)""",
                (
                    "la-seed-" + lead["id"][-4:],
                    lead["id"],
                    "status_changed",
                    "new",
                    lead["status"],
                    last_act,
                )
            )

        # Seed a sample note for the first 3 leads
        if i < 3:
            note_texts = [
                "Spoke on the phone — very interested in governance features. Sending demo link.",
                "Email sent with product overview deck. Following up Friday.",
                "Had 30-min call. Large operation, multiple locations. Demo scheduled for next week.",
            ]
            db.execute(
                """INSERT OR IGNORE INTO lead_notes
                   (id, lead_id, note_text, created_at)
                   VALUES (?,?,?,?)""",
                (
                    "ln-seed-" + lead["id"][-4:],
                    lead["id"],
                    note_texts[i],
                    last_act,
                )
            )

    db.commit()


# ══════════════════════════════════════════════════════════════
# LEAD MANAGEMENT — Alpha 9.4c
# ══════════════════════════════════════════════════════════════

LEAD_STATUSES = {"new", "contacted", "in_progress", "quoted", "closed_won", "cold", "custom"}


def _require_lead_perm(auth_ctx, perm):
    from flask import abort
    if not auth_ctx:
        abort(401)
    role = (auth_ctx.get("role") or "").lower()
    if role == "sysop":
        return True
    if _has_permission_ctx(auth_ctx, perm):
        return True
    abort(403)


@app.route("/api/leads", methods=["GET"])
def list_leads():
    auth_ctx = getattr(g, "auth", None)
    _require_lead_perm(auth_ctx, "can_view_leads")
    db = get_db()

    status   = request.args.get("status", "")
    priority = request.args.get("priority", "")
    source   = request.args.get("source", "")
    q        = request.args.get("q", "").strip()
    sort_by  = request.args.get("sort_by", "created_at")
    sort_dir = request.args.get("sort_dir", "desc").lower()
    limit    = min(int(request.args.get("limit", 200) or 200), 500)

    allowed_sort = {"created_at", "last_activity_at", "score", "name", "company", "status", "follow_up_date"}
    if sort_by not in allowed_sort:
        sort_by = "created_at"
    if sort_dir not in ("asc", "desc"):
        sort_dir = "desc"

    sql = (
        "SELECT id, name, email, company, phone, company_size, source,"
        " status, priority, follow_up_date, custom_tag, score,"
        " last_activity_at, created_at, notes"
        " FROM demo_requests WHERE 1=1"
    )
    params = []

    if status:
        sql += " AND status=?"
        params.append(status)
    if priority:
        sql += " AND priority=?"
        params.append(int(priority))
    if source:
        sql += " AND source=?"
        params.append(source)
    if q:
        sql += " AND (name LIKE ? OR email LIKE ? OR company LIKE ?)"
        lq = "%" + q + "%"
        params += [lq, lq, lq]

    sql += " ORDER BY " + sort_by + " " + sort_dir.upper() + " LIMIT ?"
    params.append(limit)

    rows  = db.execute(sql, params).fetchall()
    leads = [dict(r) for r in rows]

    counts = {}
    for s in LEAD_STATUSES:
        counts[s] = db.execute(
            "SELECT COUNT(*) FROM demo_requests WHERE status=?", (s,)
        ).fetchone()[0]
    counts["total"]      = sum(counts.values())
    counts["new_unread"] = counts.get("new", 0)

    return jsonify({"leads": leads, "counts": counts})


@app.route("/api/leads/<lead_id>", methods=["GET"])
def get_lead(lead_id):
    auth_ctx = getattr(g, "auth", None)
    _require_lead_perm(auth_ctx, "can_view_leads")
    db = get_db()

    row = db.execute("SELECT * FROM demo_requests WHERE id=?", (lead_id,)).fetchone()
    if not row:
        return jsonify({"error": "Lead not found"}), 404

    lead = dict(row)
    lead["notes_list"] = [dict(n) for n in db.execute(
        "SELECT * FROM lead_notes WHERE lead_id=? ORDER BY created_at ASC", (lead_id,)
    ).fetchall()]
    lead["activity"] = [dict(a) for a in db.execute(
        "SELECT * FROM lead_activity WHERE lead_id=? ORDER BY created_at DESC LIMIT 50", (lead_id,)
    ).fetchall()]
    return jsonify(lead)


@app.route("/api/leads/<lead_id>", methods=["PUT"])
def update_lead(lead_id):
    auth_ctx = getattr(g, "auth", None)
    _require_lead_perm(auth_ctx, "can_manage_leads")
    db = get_db()

    row = db.execute("SELECT * FROM demo_requests WHERE id=?", (lead_id,)).fetchone()
    if not row:
        return jsonify({"error": "Lead not found"}), 404

    body     = request.get_json(silent=True) or {}
    updates  = {}
    events   = []
    now      = _now_iso()
    row_dict = dict(row)

    if "status" in body:
        new_s = body["status"]
        if new_s not in LEAD_STATUSES:
            return jsonify({"error": "Invalid status"}), 400
        old_s = row_dict.get("status", "new")
        if old_s != new_s:
            updates["status"] = new_s
            events.append(("status_changed", old_s, new_s))

    if "priority" in body:
        new_p = 1 if body["priority"] else 0
        updates["priority"] = new_p
        events.append(("priority_changed", str(row_dict.get("priority", 0)), str(new_p)))

    if "follow_up_date" in body:
        updates["follow_up_date"] = body["follow_up_date"] or None
        events.append(("follow_up_set", None, updates["follow_up_date"]))

    if "custom_tag" in body:
        updates["custom_tag"] = (body["custom_tag"] or "").strip() or None
        events.append(("tag_changed", row_dict.get("custom_tag"), updates["custom_tag"]))

    if not updates:
        return jsonify({"ok": True, "message": "No changes"})

    updates["last_activity_at"] = now
    set_clause = ", ".join(k + "=?" for k in updates)
    db.execute("UPDATE demo_requests SET " + set_clause + " WHERE id=?",
               list(updates.values()) + [lead_id])

    for etype, oval, nval in events:
        aid = "la-" + uuid.uuid4().hex[:10]
        db.execute(
            "INSERT INTO lead_activity (id,lead_id,event_type,old_value,new_value,created_at)"
            " VALUES (?,?,?,?,?,?)",
            (aid, lead_id, etype, oval, nval, now)
        )

    db.commit()
    updated = dict(db.execute("SELECT * FROM demo_requests WHERE id=?", (lead_id,)).fetchone())
    return jsonify(updated)


@app.route("/api/leads/<lead_id>/notes", methods=["POST"])
def add_lead_note(lead_id):
    auth_ctx = getattr(g, "auth", None)
    _require_lead_perm(auth_ctx, "can_manage_leads")
    db = get_db()

    row = db.execute("SELECT id FROM demo_requests WHERE id=?", (lead_id,)).fetchone()
    if not row:
        return jsonify({"error": "Lead not found"}), 404

    body      = request.get_json(silent=True) or {}
    note_text = (body.get("note") or "").strip()
    if not note_text:
        return jsonify({"error": "Note text is required"}), 400

    now     = _now_iso()
    note_id = "ln-" + uuid.uuid4().hex[:10]
    db.execute(
        "INSERT INTO lead_notes (id,lead_id,note_text,created_at) VALUES (?,?,?,?)",
        (note_id, lead_id, note_text, now)
    )
    aid = "la-" + uuid.uuid4().hex[:10]
    db.execute(
        "INSERT INTO lead_activity (id,lead_id,event_type,old_value,new_value,created_at)"
        " VALUES (?,?,?,?,?,?)",
        (aid, lead_id, "note_added", None, note_text[:80], now)
    )
    db.execute("UPDATE demo_requests SET last_activity_at=? WHERE id=?", (now, lead_id))
    db.commit()
    return jsonify({"id": note_id, "note_text": note_text, "created_at": now}), 201


@app.route("/api/leads/badge", methods=["GET"])
def leads_badge():
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"count": 0})
    role     = (auth_ctx.get("role") or "").lower()
    has_perm = role == "sysop" or _has_permission_ctx(auth_ctx, "can_view_leads")
    if not has_perm:
        return jsonify({"count": 0})
    db    = get_db()
    count = db.execute(
        "SELECT COUNT(*) FROM demo_requests WHERE status='new'"
    ).fetchone()[0]
    return jsonify({"count": count})


@app.route("/api/leads/export", methods=["GET"])
def export_leads_csv():
    auth_ctx = getattr(g, "auth", None)
    _require_lead_perm(auth_ctx, "can_export_leads")
    db = get_db()

    status    = request.args.get("status", "")
    source    = request.args.get("source", "")
    from_date = request.args.get("from_date", "")
    to_date   = request.args.get("to_date", "")

    sql    = (
        "SELECT name, email, company, phone, company_size, source,"
        " status, priority, score, custom_tag,"
        " follow_up_date, last_activity_at, created_at, notes"
        " FROM demo_requests WHERE 1=1"
    )
    params = []
    if status:    sql += " AND status=?";     params.append(status)
    if source:    sql += " AND source=?";     params.append(source)
    if from_date: sql += " AND created_at>=?"; params.append(from_date)
    if to_date:   sql += " AND created_at<=?"; params.append(to_date + "T23:59:59")
    sql += " ORDER BY created_at DESC"

    rows = db.execute(sql, params).fetchall()

    import io as _io, csv as _csv
    output = _io.StringIO()
    writer = _csv.writer(output)
    writer.writerow(["Name","Email","Company","Phone","Team Size","Source",
                     "Status","Priority","Score","Tag",
                     "Follow-Up Date","Last Activity","Submitted","Notes"])
    for r in rows:
        writer.writerow([
            r["name"], r["email"],
            r["company"] or "", r["phone"] or "",
            r["company_size"] or "", r["source"] or "",
            r["status"] or "new",
            "Star" if r["priority"] else "",
            r["score"] or 0,
            r["custom_tag"] or "",
            r["follow_up_date"] or "",
            r["last_activity_at"] or "",
            r["created_at"] or "",
            (r["notes"] or "").replace("\n", " "),
        ])
    csv_data = output.getvalue()
    from flask import Response as _Resp
    filename = "windowcalc_leads_" + _now_iso()[:10] + ".csv"
    return _Resp(
        csv_data,
        mimetype="text/csv",
        headers={"Content-Disposition": "attachment; filename=" + filename}
    )


# ══════════════════════════════════════════════════════════════
# MASTER PRODUCT LIBRARY — Alpha 9.4d
# ══════════════════════════════════════════════════════════════

def _ensure_master_library_bootstrap(db):
    """Seed 48 master products from ESWindows + PGT. Idempotent."""
    existing = db.execute("SELECT COUNT(*) FROM master_products").fetchone()[0]
    if existing > 0:
        return

    now = "2026-03-18T00:00:00"

    # Glass option keys (no argon in standard display)
    G_STD  = '["impact_laminated","impact_laminated_lowe"]'
    G_ELITE = '["impact_laminated","impact_laminated_lowe","impact_laminated_lowe_sb60","sentryglas","tinted_privacy","insulating_ig"]'
    G_PRES = '["impact_laminated","impact_laminated_lowe","impact_laminated_lowe_sb60","sentryglas","tinted_privacy","insulating_ig"]'
    G_SF   = '["impact_laminated","impact_laminated_lowe","insulating_ig"]'
    G_PGT  = '["impact_laminated","impact_laminated_lowe","sentryglas","tinted_privacy"]'

    # Frame color keys
    FC_MX   = '["white","bronze"]'
    FC_EL   = '["white","bronze_2604","bronze_2605","black","bone_white","bermuda_bronze","arcadia_silver","silverstorm"]'
    FC_PRES = '["white","bronze_2604","bronze_2605","black","bone_white","bermuda_bronze","arcadia_silver","silverstorm","dark_gray","custom_kynar"]'
    FC_SF   = '["white","bronze","bone_white","bermuda_bronze","arcadia_silver","hatteras_white","sanibel_sand","caribbean_creme"]'
    FC_PGT  = '["white","bronze","dark_bronze","sandtone"]'

    FT_FLANGE     = '["flange"]'
    FT_ELITE      = '["flange","flush","fin"]'
    FT_PRES_FF    = '["flush","flange","nail_fin"]'
    FT_PRES_FLUSH = '["flush","flange"]'

    products = [
        # ── MULTIMAX (8) ─────────────────────────────────────
        ("mp-mx-1000", "ESWindows", "Multimax", "1000/1050",
         "Single Hung LMI", "single_hung",
         19.125, 53.125, 12, 74.25, 80, 90, 1,
         "25-0728.07", "2028-11-06", "LMI", FT_FLANGE, G_STD, FC_MX, "2.5\"",  5,
         "Entry-level single hung LMI. Hi-Rise sill available for higher DP.", None),

        ("mp-mx-1100", "ESWindows", "Multimax", "1100",
         "Single Hung SMI", "single_hung",
         19.125, 53.125, 12, 50.625, 80, 140, 1,
         "25-0724.01", "2030-08-11", "SMI", FT_FLANGE, G_STD, FC_MX, "2.5\"",  5,
         "SMI variant — shutters required below 30ft grade. Higher DP than LMI version.", None),

        ("mp-mx-1500", "ESWindows", "Multimax", "1500",
         "Fixed Window LMI", "fixed",
         19.125, 53.125, 12, 74.25, 90, 90, 1,
         "25-0929.10", "2030-11-06", "LMI", FT_FLANGE, G_STD, FC_MX, "2.5\"",  4,
         "Fixed/picture window LMI. W/H interchangeable.", None),

        ("mp-mx-1600", "ESWindows", "Multimax", "1600",
         "Fixed Window SMI", "fixed",
         19.125, 53.125, 12, 53.125, 82, 82, 1,
         "26-0211.01", "2027-03-31", "SMI", FT_FLANGE, G_STD, FC_MX, "2.5\"",  4,
         "SMI fixed. Renewal NOA 26-0211.01 filed. Verify status before specifying.", None),

        ("mp-mx-2000", "ESWindows", "Multimax", "2000/2050",
         "Horizontal Roller LMI", "horizontal_roller",
         26.5, 141, 12, 74, 80, 90, 1,
         "24-1101.01", "2029-11-06", "LMI", FT_FLANGE, G_STD, FC_MX, "2.375\"", 5,
         "XO/XOX up to 141\" wide. Hi-Rise sill for max DP.", None),

        ("mp-mx-2100", "ESWindows", "Multimax", "2100",
         "Horizontal Roller SMI", "horizontal_roller",
         26.5, 111, 12, 96, 82, 82, 1,
         "24-0912.15", "2030-02-10", "SMI", FT_FLANGE, G_STD, FC_MX, "2.375\"", 5,
         "SMI slider. XOX max 111\" wide, 96\" tall. Shutters required below 30ft.", None),

        ("mp-mx-3000", "ESWindows", "Multimax", "3000",
         "Outswing Door LMI", "entry_door",
         31.5, 76, 78, 96, 100, 120, 1,
         "23-0714.08", "2028-12-20", "LMI", FT_FLANGE, G_STD, FC_MX, "3.5\"",  6,
         "Single or double outswing door. Hi-Rise sill for up to +100/-120 PSF.", None),

        ("mp-mx-4000", "ESWindows", "Multimax", "4000",
         "Sliding Glass Door LMI", "sliding_glass_door",
         29, 192, 78, 110, 80, 103, 1,
         "23-0714.11", "2029-03-18", "LMI", FT_FLANGE, G_STD, FC_MX, "4\"",    6,
         "XO/XOX/multi-panel SGD up to 192\" total frame width.", None),

        # ── ELITE (9) ────────────────────────────────────────
        ("mp-el-100", "ESWindows", "Elite", "EL-100",
         "Single Hung", "single_hung",
         12, 53.125, 12, 84, 80, 80, 1,
         "23-0913.06", "2027-05-04", "LMI", FT_ELITE, G_ELITE, FC_EL, "[DATA PENDING]", 5,
         "28.04 sqft max area. Flange, Flush, Fin frame types. 8 standard colors.", None),

        ("mp-el-150", "ESWindows", "Elite", "EL-150",
         "Fixed Window", "fixed",
         19.125, 60, 12, 144, 80, 105, 1,
         "23-0714.17", "2027-05-18", "LMI", FT_ELITE, G_ELITE, FC_EL, "[DATA PENDING]", 5,
         "AA/AAi glass achieves +80/-105 PSF at 48\"x48\". W/H interchangeable.", None),

        ("mp-el-200", "ESWindows", "Elite", "EL200",
         "Horizontal Roller", "horizontal_roller",
         12, 111, 12, 74, 80, 90, 1,
         "23-0714.18", "2027-01-19", "LMI", FT_ELITE, G_ELITE, FC_EL, "[DATA PENDING]", 5,
         "XO/XOX up to 111\". Stile stiffeners required for reinforced configs.", None),

        ("mp-el-300-8", "ESWindows", "Elite", "EL300",
         "Outswing Door 8ft", "entry_door",
         12, 76, 78, 96, 80, 80, 1,
         "23-0714.09", "2028-01-04", "LMI", FT_ELITE, G_ELITE, FC_EL, "[DATA PENDING]", 6,
         "8ft LMI outswing. Single/double configurations. Interlock USA 3-pt lock.", None),

        ("mp-el-300-9", "ESWindows", "Elite", "EL300-9",
         "Outswing Door 9ft", "entry_door",
         12, 76, 96, 108, 80, 80, 1,
         "23-0714.10", "2028-01-04", "LMI", FT_ELITE, G_ELITE, FC_EL, "[DATA PENDING]", 6,
         "9ft LMI outswing. Same hardware as 8ft EL300.", None),

        ("mp-el-400", "ESWindows", "Elite", "EL400",
         "Sliding Glass Door", "sliding_glass_door",
         24, 60, 78, 108, 80, 80, 1,
         "23-0714.13", "2027-07-20", "LMI", '["flange"]', G_ELITE, FC_EL, "2.75\"-3.69\"", 6,
         "2/3/4-track. 24\"-60\" panel width. Pocketed jamb option available.", None),

        ("mp-el-400-10", "ESWindows", "Elite", "EL400-10",
         "Sliding Glass Door 10ft", "sliding_glass_door",
         24, 60, 78, 120, 80, 80, 1,
         "23-0714.12", "2027-07-20", "LMI", '["flange"]', G_ELITE, FC_EL, "2.75\"-3.69\"", 7,
         "10ft height variant of EL400.", None),

        ("mp-el-5000", "ESWindows", "Elite", "5000",
         "Casement Window", "casement",
         12, 53.125, 12, 84, 90, 90, 1,
         "23-0717.25", "2028-04-03", "LMI", '["flange","flush"]', G_ELITE, FC_EL, "[DATA PENDING]", 5,
         "Single or double (XX) vent. Multi-point lock achieves +90/-90 PSF.", None),

        ("mp-el-5500", "ESWindows", "Elite", "ES-5500",
         "Project-Out Window", "casement",
         12, 48, 12, 84, 100, 125, 1,
         "23-0724.06", "2028-10-11", "LMI", '["flange","flush"]', G_ELITE, FC_EL, "[DATA PENDING]", 5,
         "Highest DP in Elite line. SentryGlas interlayer. 3-point surface lock.", None),

        # ── PRESTIGE (14) ────────────────────────────────────
        ("mp-pr-p252c", "ESWindows", "Prestige", "ES-P252",
         "Casement Window LMI", "casement",
         12, 48, 12, 84, 95, 105, 1,
         "24-1007.06", "2026-08-25", "LMI", '["flush","equal_leg","receptor"]', G_PRES, FC_PRES, "2.84\"", 6,
         "EXPIRING SOON — 08/25/2026. Thermal break Ensinger Tecatherm 66 GF. 7-pt lock.", None),

        ("mp-pr-p252cs", "ESWindows", "Prestige", "ES-P252-SMI",
         "Casement Window SMI", "casement",
         12, 48, 12, 84, 95, 105, 1,
         "24-1007.07", "2026-12-22", "SMI", '["flush","equal_leg","receptor"]', G_PRES, FC_PRES, "2.84\"", 6,
         "SMI casement. Shutters required below 30ft. Same profile as LMI version.", None),

        ("mp-pr-p252f", "ESWindows", "Prestige", "ES-P252",
         "Fixed Window LMI", "fixed",
         12, 144, 12, 120, 110, 150, 1,
         "24-1101.03", "2030-01-16", "LMI", '["flush","flange","nail_fin","impost"]', G_PRES, FC_PRES, "2.75\"", 5,
         "Up to 144\"W with impost. Best DP fixed in Prestige line. ANSI Z97.1.", None),

        ("mp-pr-h340", "ESWindows", "Prestige", "ES-H340",
         "Single Hung LMI", "single_hung",
         12, 54, 12, 96, 70, 90, 1,
         "25-0519.03", "2030-06-25", "LMI", FT_PRES_FF, G_PRES, FC_PRES, "3.4\"", 5,
         "Thermally broken SH. Max 54\"W x 96\"H. Two-tone finish available.", None),

        ("mp-pr-h340s", "ESWindows", "Prestige", "ES-H340-SMI",
         "Single Hung SMI", "single_hung",
         12, 54, 12, 81, 80, 90, 1,
         "25-0613.04", "2026-06-25", "SMI", FT_PRES_FF, G_PRES, FC_PRES, "3.4\"", 5,
         "EXPIRING SOON — 06/25/2026. SMI version. Shutters required below 30ft.", None),

        ("mp-pr-sw340", "ESWindows", "Prestige", "ES-SW340",
         "Horizontal Slider SMI", "horizontal_roller",
         12, 126, 12, 63, 80, 110, 1,
         "23-0928.19", "2026-08-25", "SMI", FT_PRES_FLUSH, G_PRES, FC_PRES, "3.5\"", 6,
         "EXPIRING SOON — 08/25/2026. 3-lite OXO up to 126\". +80/-110 PSF thermal slider.", None),

        ("mp-pr-p300", "ESWindows", "Prestige", "ES-P300",
         "Casement/Awning/Fixed", "casement",
         12, 57, 12, 96, 80, 90, 1,
         None, None, "LMI/SMI", FT_PRES_FLUSH, G_PRES, FC_PRES, "3\"", 6,
         "AW-PG100 architectural grade. U=0.295 fixed. Brochure data — verify NOA with ESWindows.", None),

        ("mp-pr-fx3050", "ESWindows", "Prestige", "ES-FX3050",
         "Frameless Window Wall", "fixed",
         12, 97.5, 12, 192, 100, 100, 1,
         None, None, "LMI", '["flange"]', G_PRES, FC_PRES, "3.375\"", 8,
         "Only impact-rated frameless window wall on market. Top/bottom rail only. Brochure data.", None),

        ("mp-pr-fx4017", "ESWindows", "Prestige", "ES-FX4017",
         "Fixed Window (Minimal Sightline)", "fixed",
         12, 60, 12, 120, 95, 95, 1,
         None, None, "LMI", '["flange"]', G_PRES, FC_PRES, "4\"", 6,
         "Best U=0.288 in ESWindows lineup. Seamless glass system. Brochure data.", None),

        ("mp-pr-46t", "ESWindows", "Prestige", "ES-46T",
         "Swing Door", "entry_door",
         12, 80, 96, 120, 100, 120, 1,
         None, None, "LMI/SMI", '["flange"]', G_PRES, FC_PRES, "4.5\"", 7,
         "Single up to 41\"W x 120\"H, double up to 80\"W. ADA threshold option. U=0.44.", None),

        ("mp-pr-psd", "ESWindows", "Prestige", "ES-PSD5030T",
         "Pivot Entry Door", "entry_door",
         12, 80, 96, 120, 100, 120, 1,
         None, None, "LMI/SMI", '["flange"]', G_PRES, FC_PRES, "4.5\"", 8,
         "Self-closing pivot with damper. Hold at 0/90/-90. Multi-point hardware. U=0.44.", None),

        ("mp-pr-sgd2020", "ESWindows", "Prestige", "ES-SGD2020",
         "Sliding Glass Door", "sliding_glass_door",
         12, 72, 78, 144, 90, 102, 1,
         None, None, "LMI", '["flange"]', G_PRES, FC_PRES, "4.375\"-10.5\"", 7,
         "2-5 track. 90 and 135-degree corner options. U=0.57. Brochure data.", None),

        ("mp-pr-sgd2020t", "ESWindows", "Prestige", "ES-SGD2020T",
         "Sliding Glass Door Thermal", "sliding_glass_door",
         12, 60, 78, 132, 105, 105, 1,
         "NFRC-12449", "2028-09-06", "LMI/SMI", '["flange"]', G_PRES, FC_PRES, "4.375\"", 7,
         "NFRC certified U=0.333. +/-105 PSF. FL Approvals 46878.1/2/3. Premium thermal SGD.", None),

        ("mp-pr-bf5010t", "ESWindows", "Prestige", "ES-BF5010T",
         "Bi-Fold Door", "bifold_door",
         12, 42, 96, 120, 95, 95, 1,
         None, None, "LMI", '["flange"]', G_PRES, FC_PRES, "5\"", 10,
         "Up to 16 panels, 42\"/panel. Center-meet option. Stainless hinges. U=0.77.", None),

        # ── STOREFRONT 8000/9000 (8) ─────────────────────────
        ("mp-sf-8000", "ESWindows", "Storefront 8000", "ES-8000",
         "Window Wall LMI", "fixed",
         12, 48, 12, 120, 130, 130, 1,
         "24-0321.07", "2028-04-03", "LMI", '["flange"]', G_SF, FC_SF, "5\"", 6,
         "Standard storefront system. 9/16\" laminated glass. Pre-glazed.", None),

        ("mp-sf-8000t", "ESWindows", "Storefront 8000", "ES-8000T",
         "Thermal Window Wall LMI", "fixed",
         12, 84, 12, 180, 90, 120, 1,
         "21-0914.03", "2031-08-25", "LMI", '["flange"]', G_SF, FC_SF, "5\"", 7,
         "Pour-and-debridge thermal break. Best U=0.38. Jumbo option 84\"x180\".", None),

        ("mp-sf-7000", "ESWindows", "Storefront 9000", "Series 7000",
         "Window Wall LMI", "fixed",
         12, 60, 12, 120, 125, 150, 1,
         "23-0724.09", "2028-07-25", "LMI", '["flange"]', G_SF, FC_SF, "6.125\"", 6,
         "Highest DP in ESWindows lineup. +125/-150 PSF. 6-1/8\" frame depth.", None),

        ("mp-sf-7100", "ESWindows", "Storefront 9000", "Series 7100",
         "Window Wall SMI", "fixed",
         12, 60, 12, 120, 100, 150, 1,
         "23-0724.10", "2028-11-07", "SMI", '["flange"]', G_SF, FC_SF, "6.125\"", 6,
         "SMI variant of Series 7000. Shutters required below 30ft grade.", None),

        ("mp-sf-9000", "ESWindows", "Storefront 9000", "Series 9000",
         "Outswing French Door LMI", "french_door",
         36, 89, 78, 110.5, 130, 130, 1,
         "23-0724.12", "2028-12-24", "LMI", '["flange"]', G_SF, FC_SF, "5\"", 7,
         "Single up to 47\"W, double up to 89\"W. Mull to 8000/9500 systems.", None),

        ("mp-sf-9100", "ESWindows", "Storefront 9000", "ES-9100",
         "Outswing Door SMI", "entry_door",
         12, 53, 78, 120, 120, 150, 1,
         "23-0724.13", "2027-10-12", "SMI", '["flange"]', G_SF, FC_SF, "5\"", 7,
         "Heavy-duty commercial entry. +120/-150 PSF. Anchor type B only at sill.", None),

        ("mp-sf-9500", "ESWindows", "Storefront 9000", "Series 9500",
         "Window Wall LMI", "fixed",
         12, 48, 12, 120, 120, 120, 1,
         "24-0513.04", "2029-10-28", "LMI", '["flange"]', G_SF, FC_SF, "5\"", 6,
         "Wider 2.5\" sightline storefront. U=0.44 ins-lam with Low-E.", None),

        ("mp-sf-9500f", "ESWindows", "Storefront 9000", "9500 Fixed",
         "Fixed Window LMI", "fixed",
         12, 48, 12, 120, 120, 120, 1,
         "25-1024.01", "2030-10-28", "LMI", '["flange"]', G_SF, FC_SF, "5\"", 6,
         "Provisional 1-year approval. Verification testing per 11/5/24 agreement.", None),

        # ── PGT WINGUARD 770 (9) ─────────────────────────────
        ("mp-pgt-sh7700a", "PGT Windows + Doors", "WinGuard 770", "SH7700A",
         "Single Hung", "single_hung",
         17, 53.125, 24, 84, 65, 80, 1,
         "23-0707.10", "2028-08-23", "LMI", '["flange","integral_fin","equal_leg"]', G_PGT, FC_PGT, "2.784\"", 5,
         "Best-selling WinGuard. Pre-tensioned spiral balance. Low-profile sweep lock.", None),

        ("mp-pgt-hr7710a", "PGT Windows + Doors", "WinGuard 770", "HR7710A",
         "Horizontal Roller", "horizontal_roller",
         19.75, 76, 18, 76, 65, 70, 1,
         "23-0707.06", "2028-08-23", "LMI", '["flange","integral_fin"]', G_PGT, FC_PGT, "2.784\"", 5,
         "XO/OX/XOX configurations. 4 brass rollers per housing.", None),

        ("mp-pgt-pw7720a", "PGT Windows + Doors", "WinGuard 770", "PW7720A",
         "Picture Window", "fixed",
         14.5, 96, 14.5, 96, 90, 110, 1,
         "23-0816.02", "2029-02-19", "LMI", '["flange","integral_fin"]', G_PGT, FC_PGT, "2.784\"", 4,
         "Fixed lite up to 42 sqft. Multiple shape options available (arch, circle, etc).", None),

        ("mp-pgt-ca740", "PGT Windows + Doors", "WinGuard 770", "CA740",
         "Casement Window", "casement",
         12, 42, 12, 84, 65, 80, 1,
         "23-0816.12", "2028-04-11", "LMI", '["flange","integral_fin"]', G_PGT, FC_PGT, "2.784\"", 5,
         "Single/double vent. Also available as awning (AW740) and picture (PW740).", None),

        ("mp-pgt-sgd770", "PGT Windows + Doors", "WinGuard 770", "SGD770",
         "Preferred Sliding Glass Door", "sliding_glass_door",
         71.5, 240, 78, 120, 70, 80, 1,
         "24-1219.08", "2030-02-17", "LMI", '["flange"]', G_PGT, FC_PGT, "5.25\"", 6,
         "Up to 40ft wide, 8 panels. Bypass or pocket configurations.", None),

        ("mp-pgt-sgd770ns", "PGT Windows + Doors", "WinGuard 770", "SGD770NS",
         "Preferred SGD (No Screen)", "sliding_glass_door",
         71.5, 240, 78, 120, 70, 80, 1,
         "24-1219.08", "2030-02-17", "LMI", '["flange"]', G_PGT, FC_PGT, "5.25\"", 6,
         "No-screen variant of SGD770. Same sizing and DP ratings.", None),

        ("mp-pgt-sgd780", "PGT Windows + Doors", "WinGuard 770", "SGD780",
         "Premium Sliding Glass Door", "sliding_glass_door",
         95.5, 240, 78, 144, 70, 75, 1,
         "22-0727.07", "2027-07-31", "LMI", '["flange"]', G_PGT, FC_PGT, "5.75\"", 7,
         "Premium SGD. Up to 144\" tall. Ogee Raised grid only.", None),

        ("mp-pgt-fd750", "PGT Windows + Doors", "WinGuard 770", "FD750",
         "Preferred French Door", "french_door",
         36, 72, 80, 96, 75, 85, 1,
         "24-1219.10", "2030-02-24", "LMI", '["flange"]', G_PGT, FC_PGT, "5.56\"", 6,
         "Single or double. Ogee Raised grid only on FD750.", None),

        ("mp-pgt-fd101h", "PGT Windows + Doors", "WinGuard 770", "FD101H",
         "Essential French Door", "french_door",
         36, 72, 80, 96, 70, 75, 1,
         "23-0303.04", "2028-03-31", "LMI", '["flange"]', G_PGT, FC_PGT, "5.31\"", 6,
         "Entry-level French door. Single or double configurations.", None),
    ]

    for p in products:
        (pid, mfr, series, model, name, otype,
         min_w, max_w, min_h, max_h, dp_pos, dp_neg, hvhz,
         noa, noa_exp, missile, ft_json, glass_json, color_json,
         frame_depth, lead_time, description, spec_url) = p

        db.execute(
            """INSERT INTO master_products
               (id,manufacturer,series,model_number,name,opening_type,
                min_width_in,max_width_in,min_height_in,max_height_in,
                dp_rating_pos,dp_rating_neg,hvhz_compliant,
                noa_number,noa_expires,missile_impact,
                frame_types_json,glass_options_json,frame_colors_json,
                frame_depth,lead_time_weeks,description,spec_sheet_url,
                base_msrp,active,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?)
               ON CONFLICT (id) DO NOTHING""",
            (pid, mfr, series, model, name, otype,
             min_w, max_w, min_h, max_h,
             dp_pos, dp_neg, hvhz,
             noa, noa_exp, missile,
             ft_json, glass_json, color_json,
             frame_depth, lead_time, description, spec_url,
             now, now)
        )

    db.commit()
    count = db.execute("SELECT COUNT(*) FROM master_products").fetchone()[0]
    print(f"[bootstrap] Seeded {count} master products")


# ── Master Library API Routes ─────────────────────────────────

def _is_sysop(auth_ctx):
    if not auth_ctx or not auth_ctx.get("user"):
        return False
    return (auth_ctx["user"].get("role") or "").lower() == "sysop"

def _require_sysop(auth_ctx):
    from flask import abort
    if not _is_sysop(auth_ctx):
        abort(403)

def _strip_msrp(product_dict, auth_ctx):
    """Remove base_msrp for non-sysop users — server enforced, never a UI toggle."""
    if not _is_sysop(auth_ctx):
        product_dict.pop("base_msrp", None)
    return product_dict




@app.route("/api/master-products/debug", methods=["GET"])
def debug_master_products():
    """Diagnostic endpoint — SysOp only. Returns schema and count info."""
    auth_ctx = getattr(g, "auth", None)
    if not _is_sysop(auth_ctx):
        return jsonify({"error": "sysop only"}), 403
    db = get_db()
    try:
        results = {}
        # Check if table exists
        try:
            count = db.execute("SELECT COUNT(*) FROM master_products").fetchone()[0]
            results["master_products_count"] = count
        except Exception as e:
            results["master_products_error"] = str(e)

        # Check if share table exists
        try:
            sc = db.execute("SELECT COUNT(*) FROM master_product_shares").fetchone()[0]
            results["master_product_shares_count"] = sc
        except Exception as e:
            results["master_product_shares_error"] = str(e)

        # Check role of current user
        if auth_ctx and auth_ctx.get("user"):
            results["user_role"] = auth_ctx["user"].get("role")
            results["user_email"] = auth_ctx["user"].get("email")
            results["is_sysop"] = _is_sysop(auth_ctx)

        # Sample products
        try:
            samples = [dict(r) for r in db.execute(
                "SELECT id, manufacturer, name FROM master_products LIMIT 3"
            ).fetchall()]
            results["sample_products"] = samples
        except Exception as e:
            results["sample_error"] = str(e)

        return jsonify(results)
    finally:
        db.close()

@app.route("/api/master-products", methods=["GET"])
def list_master_products():
    auth_ctx = getattr(g, "auth", None)
    _require_sysop(auth_ctx)
    db = get_db()
    try:
        mfr      = request.args.get("manufacturer", "")
        series   = request.args.get("series", "")
        otype    = request.args.get("opening_type", "")
        active   = request.args.get("active", "1")
        q        = request.args.get("q", "").strip()

        sql    = "SELECT * FROM master_products WHERE 1=1"
        params = []
        if mfr:    sql += " AND manufacturer=?"; params.append(mfr)
        if series: sql += " AND series=?";       params.append(series)
        if otype:  sql += " AND opening_type=?"; params.append(otype)
        if active != "all": sql += " AND active=?"; params.append(int(active))
        if q:
            sql += " AND (name LIKE ? OR model_number LIKE ? OR noa_number LIKE ?)"
            lq = "%" + q + "%"
            params += [lq, lq, lq]
        sql += " ORDER BY manufacturer, series, name"

        rows = [dict(r) for r in db.execute(sql, params).fetchall()]

        # Share counts per product
        share_counts = {}
        for row in db.execute(
            "SELECT master_product_id, COUNT(*) FROM master_product_shares WHERE status='active' GROUP BY master_product_id"
        ).fetchall():
            share_counts[row[0]] = row[1]

        for r in rows:
            r["share_count"] = share_counts.get(r["id"], 0)

        # Distinct manufacturer/series/types for filter dropdowns
        manufacturers = [r[0] for r in db.execute("SELECT DISTINCT manufacturer FROM master_products WHERE active=1 ORDER BY manufacturer").fetchall()]
        series_list   = [r[0] for r in db.execute("SELECT DISTINCT series FROM master_products WHERE active=1 ORDER BY series").fetchall()]

        return jsonify({"products": rows, "manufacturers": manufacturers, "series": series_list, "total": len(rows)})
    except Exception as e:
        import traceback as _tb
        app.logger.error(f"list_master_products error: {type(e).__name__}: {e}\n{_tb.format_exc()}")
        return jsonify({"error": f"master_products query failed: {type(e).__name__}: {str(e)}"}), 500
    finally:
        db.close()


@app.route("/api/master-products", methods=["POST"])
def create_master_product():
    auth_ctx = getattr(g, "auth", None)
    _require_sysop(auth_ctx)
    db   = get_db()
    body = request.get_json(silent=True) or {}

    required = ["manufacturer", "series", "model_number", "name", "opening_type", "max_width_in", "max_height_in"]
    for field in required:
        if not body.get(field):
            return jsonify({"error": f"{field} is required"}), 400

    pid = "mp-" + uuid.uuid4().hex[:10]
    now = _now_iso()

    import json as _json
    db.execute(
        """INSERT INTO master_products
           (id,manufacturer,series,model_number,name,opening_type,
            min_width_in,max_width_in,min_height_in,max_height_in,
            dp_rating_pos,dp_rating_neg,hvhz_compliant,noa_number,noa_expires,
            missile_impact,frame_types_json,glass_options_json,frame_colors_json,
            frame_depth,lead_time_weeks,description,spec_sheet_url,base_msrp,
            active,created_at,updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)""",
        (pid,
         body["manufacturer"], body["series"], body["model_number"], body["name"], body["opening_type"],
         body.get("min_width_in", 12), body["max_width_in"],
         body.get("min_height_in", 12), body["max_height_in"],
         body.get("dp_rating_pos"), body.get("dp_rating_neg"),
         1 if body.get("hvhz_compliant", True) else 0,
         body.get("noa_number"), body.get("noa_expires"),
         body.get("missile_impact", "LMI"),
         body.get("frame_types_json", '["flange"]'),
         body.get("glass_options_json", '["impact_laminated"]'),
         body.get("frame_colors_json", '["white","bronze"]'),
         body.get("frame_depth"), body.get("lead_time_weeks", 5),
         body.get("description"), body.get("spec_sheet_url"),
         body.get("base_msrp"),
         now, now)
    )
    db.commit()
    row = dict(db.execute("SELECT * FROM master_products WHERE id=?", (pid,)).fetchone())
    return jsonify(row), 201


@app.route("/api/master-products/<mpid>", methods=["PUT"])
def update_master_product(mpid):
    auth_ctx = getattr(g, "auth", None)
    _require_sysop(auth_ctx)
    db   = get_db()
    row  = db.execute("SELECT * FROM master_products WHERE id=?", (mpid,)).fetchone()
    if not row:
        return jsonify({"error": "Not found"}), 404

    body    = request.get_json(silent=True) or {}
    allowed = ["manufacturer","series","model_number","name","opening_type",
               "min_width_in","max_width_in","min_height_in","max_height_in",
               "dp_rating_pos","dp_rating_neg","hvhz_compliant","noa_number","noa_expires",
               "missile_impact","frame_types_json","glass_options_json","frame_colors_json",
               "frame_depth","lead_time_weeks","description","spec_sheet_url",
               "base_msrp","active"]

    updates = {k: v for k, v in body.items() if k in allowed}
    if not updates:
        return jsonify({"ok": True, "message": "No changes"})

    updates["updated_at"] = _now_iso()
    set_clause = ", ".join(k + "=?" for k in updates)
    db.execute("UPDATE master_products SET " + set_clause + " WHERE id=?",
               list(updates.values()) + [mpid])
    db.commit()
    updated = dict(db.execute("SELECT * FROM master_products WHERE id=?", (mpid,)).fetchone())
    return jsonify(updated)


@app.route("/api/master-products/<mpid>/deactivate", methods=["POST"])
def deactivate_master_product(mpid):
    auth_ctx = getattr(g, "auth", None)
    _require_sysop(auth_ctx)
    db = get_db()
    db.execute("UPDATE master_products SET active=0, updated_at=? WHERE id=?", (_now_iso(), mpid))
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/master-products/<mpid>/shares", methods=["GET"])
def get_product_shares(mpid):
    auth_ctx = getattr(g, "auth", None)
    _require_sysop(auth_ctx)
    db = get_db()

    shares = [dict(r) for r in db.execute(
        """SELECT s.*, t.name as tenant_name
           FROM master_product_shares s
           JOIN tenants t ON s.tenant_id = t.id
           WHERE s.master_product_id=?
           ORDER BY s.shared_at DESC""",
        (mpid,)
    ).fetchall()]

    # Also return all tenants for the share picker
    all_tenants = [dict(r) for r in db.execute(
        "SELECT id, name FROM tenants ORDER BY name"
    ).fetchall()]
    shared_ids = {s["tenant_id"] for s in shares if s["status"] == "active"}

    return jsonify({"shares": shares, "all_tenants": all_tenants, "shared_tenant_ids": list(shared_ids)})


@app.route("/api/master-products/<mpid>/shares", methods=["POST"])
def share_master_product(mpid):
    auth_ctx = getattr(g, "auth", None)
    _require_sysop(auth_ctx)
    db = get_db()

    mp = db.execute("SELECT id FROM master_products WHERE id=?", (mpid,)).fetchone()
    if not mp:
        return jsonify({"error": "Product not found"}), 404

    body       = request.get_json(silent=True) or {}
    tenant_ids = body.get("tenant_ids", [])
    notes      = (body.get("notes") or "").strip() or None
    if not tenant_ids:
        return jsonify({"error": "tenant_ids required"}), 400

    now     = _now_iso()
    by_user = auth_ctx.get("user_id") if auth_ctx else None
    shared  = []
    for tid in tenant_ids:
        t = db.execute("SELECT id FROM tenants WHERE id=?", (tid,)).fetchone()
        if not t:
            continue
        sid = "mps-" + uuid.uuid4().hex[:8]
        db.execute(
            """INSERT INTO master_product_shares
               (id,master_product_id,tenant_id,shared_at,shared_by,status,notes)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT (master_product_id,tenant_id)
               DO UPDATE SET status='active', shared_at=excluded.shared_at,
                             shared_by=excluded.shared_by, notes=excluded.notes,
                             revoked_at=NULL""",
            (sid, mpid, tid, now, by_user, "active", notes)
        )
        shared.append(tid)

    db.commit()
    return jsonify({"ok": True, "shared": shared}), 201


@app.route("/api/master-products/<mpid>/shares/<tenant_id>", methods=["DELETE"])
def revoke_product_share(mpid, tenant_id):
    auth_ctx = getattr(g, "auth", None)
    _require_sysop(auth_ctx)
    db = get_db()
    db.execute(
        "UPDATE master_product_shares SET status='revoked', revoked_at=? WHERE master_product_id=? AND tenant_id=?",
        (_now_iso(), mpid, tenant_id)
    )
    db.commit()
    return jsonify({"ok": True})


@app.route("/api/library", methods=["GET"])
def browse_product_library():
    """Tenant view — products shared to their tenant. MSRP never returned."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Auth required"}), 401
    tenant_id = auth_ctx.get("tenant_id")
    db = get_db()

    rows = [dict(r) for r in db.execute(
        """SELECT mp.*, mps.shared_at
           FROM master_products mp
           JOIN master_product_shares mps ON mp.id = mps.master_product_id
           WHERE mps.tenant_id=? AND mps.status='active' AND mp.active=1
           ORDER BY mp.manufacturer, mp.series, mp.name""",
        (tenant_id,)
    ).fetchall()]

    # Strip MSRP — always
    for r in rows:
        r.pop("base_msrp", None)

    # Mark which are already imported
    imported = {r[0] for r in db.execute(
        "SELECT master_product_id FROM products WHERE tenant_id=? AND master_product_id IS NOT NULL",
        (tenant_id,)
    ).fetchall()}

    for r in rows:
        r["already_imported"] = r["id"] in imported

    return jsonify({"products": rows, "total": len(rows)})


@app.route("/api/library/<mpid>/import", methods=["POST"])
def import_library_product(mpid):
    """Tenant imports a shared product into their catalog."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Auth required"}), 401
    if not (_has_permission_ctx(auth_ctx, "can_manage_products") or
            (auth_ctx.get("role") or "").lower() in ("owner", "manager", "sysop")):
        return jsonify({"error": "Insufficient permissions"}), 403

    tenant_id = auth_ctx.get("tenant_id")
    db = get_db()

    # Verify the product is shared to this tenant
    share = db.execute(
        """SELECT mp.* FROM master_products mp
           JOIN master_product_shares mps ON mp.id=mps.master_product_id
           WHERE mp.id=? AND mps.tenant_id=? AND mps.status='active' AND mp.active=1""",
        (mpid, tenant_id)
    ).fetchone()
    if not share:
        return jsonify({"error": "Product not available in your library"}), 404

    mp = dict(share)

    # Check already imported
    existing = db.execute(
        "SELECT id FROM products WHERE tenant_id=? AND master_product_id=?",
        (tenant_id, mpid)
    ).fetchone()
    if existing:
        return jsonify({"ok": True, "id": existing["id"], "message": "Already imported"}), 200

    body       = request.get_json(silent=True) or {}
    now        = _now_iso()
    pid        = "p-lib-" + uuid.uuid4().hex[:8]
    base_cost  = body.get("base_cost") or 0

    db.execute(
        """INSERT INTO products
           (id,tenant_id,name,model_number,product_line,manufacturer,type,
            base_cost,size_multiplier_per_sqft,
            min_width,max_width,min_height,max_height,
            frame_depth,lead_time_weeks,active,
            master_product_id,imported_at,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?)""",
        (pid, tenant_id, mp["name"], mp["model_number"], mp["series"], mp["manufacturer"],
         mp["opening_type"], base_cost, 1.5,
         mp["min_width_in"], mp["max_width_in"],
         mp["min_height_in"], mp["max_height_in"],
         mp.get("frame_depth"), mp.get("lead_time_weeks", 5),
         mpid, now, now)
    )
    db.commit()
    return jsonify({"ok": True, "id": pid}), 201


@app.route("/api/product-requests", methods=["POST"])
def create_product_request():
    """Tenant submits a request to update a product."""
    auth_ctx = getattr(g, "auth", None)
    if not auth_ctx:
        return jsonify({"error": "Auth required"}), 401
    tenant_id = auth_ctx.get("tenant_id")
    db   = get_db()
    body = request.get_json(silent=True) or {}

    req_type = (body.get("request_type") or "question").strip()
    reason   = (body.get("reason") or "").strip()
    if not reason:
        return jsonify({"error": "Reason is required"}), 400

    rid = "tpr-" + uuid.uuid4().hex[:8]
    db.execute(
        """INSERT INTO tenant_product_requests
           (id,tenant_id,product_id,master_product_id,request_type,
            field_name,requested_value,reason,status,created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)""",
        (rid, tenant_id,
         body.get("product_id"), body.get("master_product_id"),
         req_type, body.get("field_name"), body.get("requested_value"),
         reason, "pending", _now_iso())
    )
    db.commit()
    return jsonify({"ok": True, "id": rid}), 201


@app.route("/api/product-requests", methods=["GET"])
def list_product_requests():
    auth_ctx = getattr(g, "auth", None)
    _require_sysop(auth_ctx)
    db     = get_db()
    status = request.args.get("status", "pending")

    sql = """SELECT r.*, t.name as tenant_name
             FROM tenant_product_requests r
             JOIN tenants t ON r.tenant_id=t.id
             WHERE 1=1"""
    params = []
    if status != "all":
        sql += " AND r.status=?"; params.append(status)
    sql += " ORDER BY r.created_at DESC LIMIT 100"

    rows = [dict(r) for r in db.execute(sql, params).fetchall()]
    return jsonify(rows)


@app.route("/api/product-requests/<rid>", methods=["PUT"])
def respond_product_request(rid):
    auth_ctx = getattr(g, "auth", None)
    _require_sysop(auth_ctx)
    db   = get_db()
    body = request.get_json(silent=True) or {}

    row = db.execute("SELECT * FROM tenant_product_requests WHERE id=?", (rid,)).fetchone()
    if not row:
        return jsonify({"error": "Not found"}), 404

    status   = body.get("status", "approved")
    response = (body.get("admin_response") or "").strip()
    db.execute(
        "UPDATE tenant_product_requests SET status=?,admin_response=?,responded_at=?,responded_by=? WHERE id=?",
        (status, response, _now_iso(), auth_ctx.get("user_id"), rid)
    )
    db.commit()
    return jsonify({"ok": True})


# ---------------------------------------------------------------------------
# TIER 6: SHAREABLE PROPOSAL LINK (6-A)
# ---------------------------------------------------------------------------

@app.route("/api/quotes/<qid>/share-link", methods=["GET"])
def get_quote_share_link(qid):
    """Get existing share link for a quote, or null if none exists."""
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_edit_quotes"):
            return jsonify({"error": "Forbidden"}), 403

        quote_row = _load_quote_access_row(db, None, qid)
        if not quote_row:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote_row, auth_ctx, "Quote")
        tenant_id = quote_row["tenant_id"]

        share_row = db.execute(
            """SELECT id, token, expires_at, revoked_at FROM proposal_shares
               WHERE quote_id=? AND tenant_id=? AND revoked_at IS NULL
               ORDER BY created_at DESC LIMIT 1""",
            (qid, tenant_id),
        ).fetchone()

        if not share_row:
            return jsonify({"share_url": None, "token": None, "expires_at": None, "share_id": None})

        share_url = _absolute_public_url(f"/p/{share_row['token']}")
        return jsonify({
            "share_url": share_url,
            "token": share_row["token"],
            "expires_at": share_row["expires_at"],
            "share_id": share_row["id"],
        })
    finally:
        db.close()


@app.route("/api/quotes/<qid>/share-link", methods=["POST"])
def create_quote_share_link(qid):
    """Create a new share link for a quote (30-day expiry)."""
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_edit_quotes"):
            return jsonify({"error": "Forbidden"}), 403

        quote_row = _load_quote_access_row(db, None, qid)
        if not quote_row:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote_row, auth_ctx, "Quote")
        tenant_id = quote_row["tenant_id"]

        # Create new share (30-day expiry)
        from datetime import timedelta
        share_id = f"share-{uuid.uuid4().hex[:16]}"
        token = secrets.token_urlsafe(24)
        expires_at = (datetime.utcnow() + timedelta(days=30)).isoformat()
        created_at = _now_iso()

        db.execute(
            """INSERT INTO proposal_shares
               (id, tenant_id, quote_id, snapshot_id, created_by, token, expires_at, viewed_count, last_viewed_at, customer_response, created_at, revoked_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (share_id, tenant_id, qid, "snapshot-placeholder", user_id, token, expires_at, 0, None, None, created_at, None),
        )

        audit(db, tenant_id, "quote_share_link_created", "quote", qid, user_id, user_name, {"share_id": share_id})
        db.commit()

        share_url = _absolute_public_url(f"/p/{token}")
        return jsonify({
            "share_url": share_url,
            "token": token,
            "expires_at": expires_at,
            "share_id": share_id,
        }), 201
    finally:
        db.close()


@app.route("/api/quotes/<qid>/share-link", methods=["DELETE"])
def revoke_quote_share_link(qid):
    """Revoke an active share link."""
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_edit_quotes"):
            return jsonify({"error": "Forbidden"}), 403

        quote_row = _load_quote_access_row(db, None, qid)
        if not quote_row:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote_row, auth_ctx, "Quote")
        tenant_id = quote_row["tenant_id"]

        db.execute(
            "UPDATE proposal_shares SET revoked_at=? WHERE quote_id=? AND tenant_id=? AND revoked_at IS NULL",
            (_now_iso(), qid, tenant_id),
        )

        audit(db, tenant_id, "quote_share_link_revoked", "quote", qid, user_id, user_name, {})
        db.commit()

        return jsonify({"ok": True})
    finally:
        db.close()


@app.route("/p/<token>", methods=["GET"])
def view_public_proposal(token):
    """Public proposal view (no auth required). Shows customer-facing proposal."""
    db = get_db()
    try:
        share_row = db.execute(
            """SELECT ps.*, q.customer_name, q.job_address, q.total_price
               FROM proposal_shares ps
               JOIN quotes q ON ps.quote_id = q.id
               WHERE ps.token = ? AND (ps.expires_at IS NULL OR ps.expires_at > datetime('now')) AND ps.revoked_at IS NULL""",
            (token,),
        ).fetchone()

        if not share_row:
            return _simple_html_page(
                "Link Expired or Not Found",
                "This proposal link is no longer available.",
                status=404,
            )

        # Load openings for this quote
        tenant_id = share_row["tenant_id"]
        qid = share_row["quote_id"]
        openings = db.execute(
            """SELECT opening_type, dimensions_string, sell_price, product_name
               FROM openings WHERE quote_id = ? AND tenant_id = ?
               ORDER BY created_at ASC""",
            (qid, tenant_id),
        ).fetchall()

        # Build HTML
        html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Proposal</title>
    <style>
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }}
        .container {{ max-width: 700px; margin: 0 auto; background: white; }}
        .header {{ background: #14B8A6; color: white; padding: 30px 24px; text-align: center; }}
        .logo {{ font-size: 28px; font-weight: 800; letter-spacing: -0.5px; }}
        .content {{ padding: 24px; }}
        .customer-info {{ margin-bottom: 24px; }}
        .customer-name {{ font-size: 24px; font-weight: 700; }}
        .customer-address {{ font-size: 14px; color: #666; margin-top: 4px; }}
        .openings-section {{ margin: 24px 0; }}
        .section-title {{ font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #666; font-weight: 600; margin-bottom: 12px; }}
        .opening-item {{ background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; }}
        .opening-info {{ flex: 1; }}
        .opening-type {{ font-size: 14px; font-weight: 600; }}
        .opening-details {{ font-size: 12px; color: #666; margin-top: 4px; }}
        .opening-price {{ font-size: 18px; font-weight: 700; font-family: monospace; }}
        .total-section {{ background: #14B8A6; color: white; border-radius: 8px; padding: 16px; margin: 24px 0; display: flex; justify-content: space-between; align-items: center; }}
        .total-label {{ font-size: 14px; font-weight: 600; }}
        .total-amount {{ font-size: 28px; font-weight: 800; font-family: monospace; }}
        .footer {{ padding: 16px 24px; text-align: center; font-size: 11px; color: #999; border-top: 1px solid #e2e8f0; }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">WindowCalc</div>
        </div>
        <div class="content">
            <div class="customer-info">
                <div class="customer-name">{share_row['customer_name'] or 'Customer'}</div>
                <div class="customer-address">{share_row['job_address'] or 'No address provided'}</div>
            </div>
            <div class="openings-section">
                <div class="section-title">Proposed Openings</div>
"""

        if openings:
            for opening in openings:
                html += f"""                <div class="opening-item">
                    <div class="opening-info">
                        <div class="opening-type">{opening['opening_type'] or 'Opening'}</div>
                        <div class="opening-details">{opening['dimensions_string'] or 'No dimensions'}</div>
                        {f'<div class="opening-details">{opening["product_name"]}</div>' if opening['product_name'] else ''}
                    </div>
                    <div class="opening-price">${opening['sell_price'] or 0:.0f}</div>
                </div>
"""
        else:
            html += '                <p style="color: #999;">No openings in this proposal.</p>\n'

        html += f"""            </div>
            <div class="total-section">
                <div class="total-label">Proposal Total</div>
                <div class="total-amount">${share_row['total_price'] or 0:.0f}</div>
            </div>
            <div class="footer">
                <p>This proposal expires on {share_row['expires_at'][:10] if share_row['expires_at'] else 'unknown'}</p>
                <p style="margin-top: 8px;">Prices subject to final measurement and site conditions.</p>
            </div>
        </div>
    </div>
</body>
</html>"""

        # Update view count
        db.execute(
            "UPDATE proposal_shares SET viewed_count=viewed_count+1, last_viewed_at=? WHERE id=?",
            (_now_iso(), share_row["id"]),
        )
        db.commit()

        return html
    finally:
        db.close()


# ---------------------------------------------------------------------------
# TIER 6: PIPELINE KANBAN DASHBOARD (6-C)
# ---------------------------------------------------------------------------

@app.route("/api/pipeline", methods=["GET"])
def get_pipeline():
    """Get quotes grouped by status with totals and summary."""
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_view_dashboard"):
            return jsonify({"error": "Forbidden"}), 403

        rep_id_filter = request.args.get("rep_id")
        date_from = request.args.get("date_from")
        date_to = request.args.get("date_to")

        # Build base query
        query = """SELECT id, customer_name, job_address, total_price, rep_id, status, updated_at,
                          (SELECT COUNT(*) FROM openings WHERE quote_id=quotes.id) as opening_count
                   FROM quotes WHERE tenant_id=?"""
        vals = [tenant_id]

        if rep_id_filter:
            query += " AND rep_id=?"
            vals.append(rep_id_filter)
        if date_from:
            query += " AND created_at >= ?"
            vals.append(date_from)
        if date_to:
            query += " AND created_at <= ?"
            vals.append(date_to)
        if not _has_permission_ctx(auth_ctx, "can_view_all_quotes"):
            query += " AND rep_id=?"
            vals.append(user_id)

        query += " ORDER BY updated_at DESC"
        rows = db.execute(query, vals).fetchall()

        # Group by status
        columns = {
            "draft": {"quotes": [], "count": 0, "total_value": 0.0},
            "pending_approval": {"quotes": [], "count": 0, "total_value": 0.0},
            "approved": {"quotes": [], "count": 0, "total_value": 0.0},
            "completed": {"quotes": [], "count": 0, "total_value": 0.0},
            "denied": {"quotes": [], "count": 0, "total_value": 0.0},
        }

        total_pipeline = 0.0
        for row in rows:
            status = row["status"] or "draft"
            if status not in columns:
                status = "draft"

            price = row["total_price"] or 0.0
            columns[status]["quotes"].append({
                "id": row["id"],
                "customer_name": row["customer_name"],
                "job_address": row["job_address"],
                "total_price": price,
                "rep_id": row["rep_id"],
                "updated_at": row["updated_at"],
                "opening_count": row["opening_count"] or 0,
            })
            columns[status]["count"] += 1
            columns[status]["total_value"] += price
            if status in ("draft", "pending_approval", "approved"):
                total_pipeline += price

        # Calculate win rate
        completed = columns["completed"]["count"]
        denied = columns["denied"]["count"]
        won_rate = 100.0 * completed / (completed + denied) if (completed + denied) > 0 else 0.0

        # Avg deal size
        pipeline_quote_count = sum(columns[status]["count"] for status in ("draft", "pending_approval", "approved"))
        avg_deal_size = total_pipeline / pipeline_quote_count if pipeline_quote_count > 0 else 0.0

        return jsonify({
            "columns": columns,
            "summary": {
                "total_pipeline": total_pipeline,
                "won_rate": won_rate,
                "avg_deal_size": avg_deal_size,
            },
        })
    finally:
        db.close()


@app.route("/api/quotes/<qid>/status", methods=["PUT"])
def update_quote_status(qid):
    """Update quote status with validation."""
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_edit_quotes"):
            return jsonify({"error": "Forbidden"}), 403

        quote_row = _load_quote_access_row(db, None, qid)
        if not quote_row:
            return jsonify({"error": "Quote not found"}), 404
        _assert_tenant_match(quote_row, auth_ctx, "Quote")
        tenant_id = quote_row["tenant_id"]

        body = request.get_json(force=True) or {}
        new_status = body.get("status")
        if not new_status or new_status not in ("draft", "pending_approval", "approved", "completed", "denied"):
            return jsonify({"error": "Invalid status"}), 400

        old_status = quote_row["status"] or "draft"

        # Simple validation: can't move from denied or completed back to earlier stages
        if old_status in ("denied", "completed") and new_status not in ("denied", "completed"):
            return jsonify({"error": "Cannot change status from final state"}), 400

        db.execute("UPDATE quotes SET status=?, updated_at=? WHERE id=?", (new_status, _now_iso(), qid))

        audit(db, tenant_id, "quote_status_changed", "quote", qid, user_id, user_name, {"old_status": old_status, "new_status": new_status})
        db.commit()

        updated_quote = _load_quote_access_row(db, None, qid)
        return jsonify({
            "id": updated_quote["id"],
            "status": updated_quote["status"],
            "updated_at": updated_quote["updated_at"],
        })
    finally:
        db.close()


# ---------------------------------------------------------------------------
# TIER 6: BRANCHES / MULTI-LOCATION (6-D)
# ---------------------------------------------------------------------------

@app.route("/api/branches", methods=["GET"])
def get_branches():
    """List branches for tenant."""
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_view_governance"):
            return jsonify({"error": "Forbidden"}), 403

        rows = db.execute(
            """SELECT id, name, address, phone, active, created_at, updated_at FROM branches
               WHERE tenant_id=? ORDER BY name ASC""",
            (tenant_id,),
        ).fetchall()

        return jsonify([dict(row) for row in rows])
    finally:
        db.close()


@app.route("/api/branches", methods=["POST"])
def create_branch():
    """Create a new branch."""
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_manage_governance"):
            return jsonify({"error": "Forbidden"}), 403

        body = request.get_json(force=True) or {}
        name = _sanitize_text_field(body.get("name"), 200)
        address = _sanitize_text_field(body.get("address"), 500)
        phone = _sanitize_text_field(body.get("phone"), 20)

        if not name:
            return jsonify({"error": "name is required"}), 400

        bid = f"branch-{uuid.uuid4().hex[:12]}"
        now = _now_iso()

        db.execute(
            """INSERT INTO branches (id, tenant_id, name, address, phone, active, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?)""",
            (bid, tenant_id, name, address, phone, now, now),
        )

        audit(db, tenant_id, "branch_created", "branch", bid, user_id, user_name, {"name": name})
        db.commit()

        return jsonify({"id": bid, "name": name, "address": address, "phone": phone, "active": 1}), 201
    finally:
        db.close()


@app.route("/api/branches/<bid>", methods=["PUT"])
def update_branch(bid):
    """Update a branch."""
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_manage_governance"):
            return jsonify({"error": "Forbidden"}), 403

        branch = db.execute("SELECT * FROM branches WHERE id=? AND tenant_id=?", (bid, tenant_id)).fetchone()
        if not branch:
            return jsonify({"error": "Branch not found"}), 404

        body = request.get_json(force=True) or {}
        name = body.get("name", branch["name"])
        address = body.get("address", branch["address"])
        phone = body.get("phone", branch["phone"])

        db.execute(
            "UPDATE branches SET name=?, address=?, phone=?, updated_at=? WHERE id=?",
            (name, address, phone, _now_iso(), bid),
        )

        audit(db, tenant_id, "branch_updated", "branch", bid, user_id, user_name, {"name": name})
        db.commit()

        return jsonify({"id": bid, "name": name, "address": address, "phone": phone, "active": branch["active"]})
    finally:
        db.close()


@app.route("/api/branches/<bid>", methods=["DELETE"])
def deactivate_branch(bid):
    """Deactivate a branch."""
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_manage_governance"):
            return jsonify({"error": "Forbidden"}), 403

        branch = db.execute("SELECT * FROM branches WHERE id=? AND tenant_id=?", (bid, tenant_id)).fetchone()
        if not branch:
            return jsonify({"error": "Branch not found"}), 404

        db.execute("UPDATE branches SET active=0, updated_at=? WHERE id=?", (_now_iso(), bid))

        audit(db, tenant_id, "branch_deactivated", "branch", bid, user_id, user_name, {})
        db.commit()

        return jsonify({"ok": True})
    finally:
        db.close()


# ---------------------------------------------------------------------------
# TIER 6: NOA DOCUMENT LIBRARY (6-E)
# ---------------------------------------------------------------------------

@app.route("/api/noa-records/<nid>/upload-document", methods=["POST"])
def upload_noa_document(nid):
    """Upload a PDF document to an NOA record."""
    db = get_db()
    try:
        tenant_id, user_id, user_name = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_manage_products"):
            return jsonify({"error": "Forbidden"}), 403

        noa = db.execute("SELECT * FROM noa_records WHERE id=? AND tenant_id=?", (nid, tenant_id)).fetchone()
        if not noa:
            return jsonify({"error": "NOA record not found"}), 404

        if "file" not in request.files:
            return jsonify({"error": "No file provided"}), 400

        file = request.files["file"]
        if not file or not file.filename:
            return jsonify({"error": "No file selected"}), 400

        if not file.filename.lower().endswith(".pdf"):
            return jsonify({"error": "Only PDF files are allowed"}), 400

        # Save locally for now
        filename = f"{nid}_{uuid.uuid4().hex[:8]}.pdf"
        filepath = f"static/noa-docs/{tenant_id}"
        os.makedirs(filepath, exist_ok=True)
        full_path = os.path.join(filepath, filename)
        file.save(full_path)

        doc_url = f"/noa-docs/{tenant_id}/{filename}"
        now = _now_iso()

        db.execute(
            """UPDATE noa_records SET document_url=?, document_filename=?, uploaded_at=?, uploaded_by=?
               WHERE id=?""",
            (doc_url, filename, now, user_id, nid),
        )

        audit(db, tenant_id, "noa_document_uploaded", "noa_record", nid, user_id, user_name, {"filename": filename})
        db.commit()

        return jsonify({"document_url": doc_url, "uploaded_at": now}), 201
    finally:
        db.close()


@app.route("/api/noa-records/<nid>/document", methods=["GET"])
def get_noa_document(nid):
    """Get/download NOA document."""
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_view_products"):
            return jsonify({"error": "Forbidden"}), 403

        noa = db.execute("SELECT document_url, document_filename FROM noa_records WHERE id=? AND tenant_id=?", (nid, tenant_id)).fetchone()
        if not noa or not noa["document_url"]:
            return jsonify({"error": "Document not found"}), 404

        # Serve the file
        filepath = noa["document_url"].lstrip("/")
        if os.path.exists(filepath):
            return send_file(filepath, mimetype="application/pdf", as_attachment=True, download_name=noa["document_filename"])
        else:
            return jsonify({"error": "File not found"}), 404
    finally:
        db.close()


@app.route("/api/noa-library", methods=["GET"])
def get_noa_library():
    """Get all NOA records with document status."""
    db = get_db()
    try:
        tenant_id, _, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_view_products"):
            return jsonify({"error": "Forbidden"}), 403

        product_id = request.args.get("product_id")
        has_document = request.args.get("has_document")
        expiring_soon = request.args.get("expiring_soon")

        query = """SELECT n.id, n.product_id, n.noa_number, n.expires_at, n.pressure_rating,
                          n.max_story_height, n.hvhz_certified, n.document_url, n.document_filename,
                          n.uploaded_at, n.uploaded_by, p.name as product_name
                   FROM noa_records n
                   LEFT JOIN products p ON n.product_id=p.id
                   WHERE n.tenant_id=?"""
        vals = [tenant_id]

        if product_id:
            query += " AND n.product_id=?"
            vals.append(product_id)

        if has_document == "true":
            query += " AND n.document_url IS NOT NULL"
        elif has_document == "false":
            query += " AND n.document_url IS NULL"

        if expiring_soon == "true":
            query += " AND n.expires_at IS NOT NULL AND date(n.expires_at) <= date('now', '+90 days')"

        query += " ORDER BY n.expires_at ASC, n.noa_number ASC"
        rows = db.execute(query, vals).fetchall()

        records = []
        missing_docs = 0
        expiring_count = 0

        for row in rows:
            has_doc = bool(row["document_url"])
            if not has_doc:
                missing_docs += 1

            is_expiring = False
            if row["expires_at"]:
                from datetime import datetime, timedelta
                exp_date = datetime.fromisoformat(row["expires_at"])
                if exp_date <= datetime.now() + timedelta(days=90):
                    is_expiring = True
                    expiring_count += 1

            records.append({
                "id": row["id"],
                "product_id": row["product_id"],
                "product_name": row["product_name"],
                "noa_number": row["noa_number"],
                "expires_at": row["expires_at"],
                "has_document": has_doc,
                "document_filename": row["document_filename"],
                "uploaded_at": row["uploaded_at"],
                "is_expiring": is_expiring,
            })

        return jsonify({
            "records": records,
            "total": len(records),
            "missing_docs": missing_docs,
            "expiring_soon": expiring_count,
        })
    finally:
        db.close()


# ---------------------------------------------------------------------------
# TIER 6: SMS ENHANCEMENT PREP (6-G) — Twilio pending
# ---------------------------------------------------------------------------

@app.route("/api/chat-threads/unread-count", methods=["GET"])
def get_unread_count():
    """Get count of unread SMS messages for current user."""
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_edit_quotes"):
            return jsonify({"error": "Forbidden"}), 403

        # Count messages where current user not in read_by_json and from customer
        unread = db.execute(
            """SELECT COUNT(*) FROM job_messages
               WHERE tenant_id=? AND delivery_channel='sms' AND external_direction='inbound'
               AND (read_by_json IS NULL OR read_by_json NOT LIKE ?)""",
            (tenant_id, f'%"{user_id}"%'),
        ).fetchone()[0]

        return jsonify({"unread_count": unread})
    finally:
        db.close()


@app.route("/api/chat-threads/<thread_id>/suggest-reply", methods=["POST"])
def suggest_sms_reply(thread_id):
    """Suggest AI replies for SMS messages."""
    db = get_db()
    try:
        tenant_id, user_id, _ = _get_tenant(request)
        auth_ctx = getattr(g, "auth", None)
        if not _has_permission_ctx(auth_ctx, "can_edit_quotes"):
            return jsonify({"error": "Forbidden"}), 403

        if not ANTHROPIC_API_KEY:
            return jsonify({"error": "AI not configured"}), 501

        # Load last 10 messages
        messages = db.execute(
            """SELECT body, external_direction FROM job_messages
               WHERE id LIKE ? AND tenant_id=?
               ORDER BY created_at DESC LIMIT 10""",
            (f"{thread_id}%", tenant_id),
        ).fetchall()

        if not messages:
            return jsonify({"error": "Thread not found"}), 404

        # Build context
        context = "\n".join([f"{'Customer' if m['external_direction']=='inbound' else 'Rep'}: {m['body']}" for m in reversed(messages)])

        prompt = f"""You are helping a window and door contractor reply to a homeowner's text message.
Based on this conversation:
{context}

Suggest 3 short, friendly, professional reply options. Each should be under 160 characters.
Return ONLY a JSON array of 3 strings, nothing else."""

        client = _AnthropicClient(api_key=ANTHROPIC_API_KEY)
        message = client.messages.create(
            model="claude-haiku-4-5-20251001",
            max_tokens=300,
            messages=[{"role": "user", "content": prompt}],
        )

        try:
            suggestions = json.loads(message.content[0].text)
            if not isinstance(suggestions, list) or len(suggestions) < 3:
                suggestions = ["Thanks for your interest!", "I'll get back to you shortly.", "Can I schedule a measurement?"]
        except:
            suggestions = ["Thanks for your interest!", "I'll get back to you shortly.", "Can I schedule a measurement?"]

        return jsonify({"suggestions": suggestions[:3]})
    finally:
        db.close()


def _ensure_cgi_vv_products(db):
    """
    Seed CGI Sentinel, CGI Estate, and V&V product lines into master_products.
    Idempotent — uses ON CONFLICT DO NOTHING.
    Source: Miami-Dade NOA PDFs (verified March 2026).
    """
    existing = db.execute(
        "SELECT COUNT(*) FROM master_products WHERE manufacturer IN ('CGI Windows','V&V Windows and Doors')"
    ).fetchone()[0]
    if existing > 0:
        return

    now = "2026-03-18T00:00:00"

    # ── Glass options ────────────────────────────────────────
    # CGI Sentinel uses SentryGlas interlayer as a primary option (explicitly in NOA)
    G_CGI  = '["impact_laminated","impact_laminated_lowe","sentryglas","tinted_privacy"]'
    G_VV   = '["impact_laminated","impact_laminated_lowe","sentryglas","tinted_privacy"]'

    # ── Frame colors ─────────────────────────────────────────
    # CGI Sentinel standard: White, Bronze, Dark Bronze, Black (Duranar), Sandstone, Champagne
    FC_CGI = '["white","bronze","dark_bronze","black","sandstone","champagne"]'
    # V&V standard aluminum: White, Bronze, Dark Bronze, Black
    FC_VV  = '["white","bronze","dark_bronze","black"]'

    # ── Frame types ──────────────────────────────────────────
    FT_FL   = '["flange","fin"]'            # Flange + Fin (most window lines)
    FT_FL3  = '["flange","fin","flush"]'    # Some fixed lines
    FT_DOOR = '["flange"]'

    products = [
        # ══ CGI SENTINEL (5) ══════════════════════════════════
        # All LMI+SMI, all HVHZ, all NOA expires 2030-09-22 except 160

        # Sentinel 110 — Single Hung
        # Source: NOA 25-0812.07, Design Pressure Tables + Extrusions sheet
        # Max size: 53-1/8" W × 85" H (extrusion drawing + elevation sheet)
        # DP: +85/-85 PSF max (Glass B/B1 with hi-rise sill)
        # Frame depth: 2.505" (Extrusions page, frame head callout)
        # Note: Glass A/A1 limited to ±75; Glass B/B1 achieves ±85
        (
            "mp-cgi-s110", "CGI Windows", "Sentinel", "110",
            "Single Hung", "single_hung",
            19.0, 53.125, 24.0, 85.0,
            85.0, 85.0, 1,
            "25-0812.07", "2030-09-22", "LMI/SMI",
            FT_FL, G_CGI, FC_CGI, '2.505"', 5,
            "Renews 23-0911.03. DP ±85 PSF with Glass B/B1; Glass A/A1 limited to ±75. "
            "Hi-Rise sill achieves max DP. HVHZ approved.",
            "https://www.miamidade.gov/building/library/productcontrol/noa/25081207.pdf"
        ),

        # Sentinel 120 — Horizontal Roller (Slider)
        # Source: NOA 25-0812.08, Design Pressure Tables + Extrusions sheet
        # Max size: 111" W (XOX config) × 63" H
        # DP: +80/-90 PSF (HD meeting rail + Glass B/B1)
        # Frame depth: 2.440" (frame head, Extrusions sheet)
        # Note: Fin-frame tables show +80/-80 in some configs; +80/-90 requires HD meeting rail
        (
            "mp-cgi-s120", "CGI Windows", "Sentinel", "120",
            "Horizontal Roller", "horizontal_roller",
            19.0, 111.0, 18.0, 63.0,
            80.0, 90.0, 1,
            "25-0812.08", "2030-09-22", "LMI/SMI",
            FT_FL, G_CGI, FC_CGI, '2.440"', 5,
            "Renews 23-0911.05. Max +80/-90 PSF requires HD meeting rail + Glass B/B1. "
            "XO/OX/XOX configurations. Max XOX width 111\".",
            "https://www.miamidade.gov/building/library/productcontrol/noa/25081208.pdf"
        ),

        # Sentinel 130 — Fixed / Picture Window
        # Source: NOA 25-0812.06, Design Load Charts + Extrusions sheet
        # Max size: 121" W (longest side) × 93.75" H — W/L interchangeable
        # DP: +80/-80 PSF
        # Frame depth: 2.505" (matches Sentinel 110 frame profile)
        # Note: orientation swap allowed; store as max_w=121, max_h=93.75
        (
            "mp-cgi-s130", "CGI Windows", "Sentinel", "130",
            "Fixed / Picture Window", "fixed",
            14.0, 121.0, 14.0, 93.75,
            80.0, 80.0, 1,
            "25-0812.06", "2030-09-22", "LMI/SMI",
            FT_FL3, G_CGI, FC_CGI, '2.505"', 4,
            "Renews 23-0911.02. W/L orientation interchangeable — max side 121\", other side 93.75\". "
            "±80 PSF across size range.",
            "https://www.miamidade.gov/building/library/productcontrol/noa/25081206.pdf"
        ),

        # Sentinel 150 — Sliding Glass Door
        # Source: NOA 25-0812.05, DP Tables (Sheet 13+15) + Extrusions + Elevations
        # Max frame width: 253.25" (6-panel configuration per typical elevation)
        # Max frame height: 120"
        # DP: +80/-80 PSF (reinforced); non-reinforced limited to ±60 PSF
        # Frame depth: 4.765" (2-track) / 5.951" (3-track) / 7.750" (4-track)
        # Storing 2-track as primary frame depth; note others in description
        (
            "mp-cgi-s150", "CGI Windows", "Sentinel", "150",
            "Sliding Glass Door", "sliding_glass_door",
            29.0, 253.25, 78.0, 120.0,
            80.0, 80.0, 1,
            "25-0812.05", "2030-09-22", "LMI/SMI",
            FT_DOOR, G_CGI, FC_CGI, '4.765" (2-track)', 6,
            "Renews 23-0717.06. Max ±80 PSF (reinforced); non-reinforced ±60 PSF. "
            "Frame depth by track: 2-track 4.765\", 3-track 5.951\", 4-track 7.750\". "
            "Max width 253.25\" (6-panel). XO/XOX/XOXX/XXOXX configurations.",
            "https://www.miamidade.gov/building/library/productcontrol/noa/25081205.pdf"
        ),

        # Sentinel 160 — Outswing Glazed Door (single/double + sidelite option)
        # Source: NOA 25-0701.06, DP Tables + Elevations + Extrusions
        # Max size: 81.5" W (double door frame) × 96" H
        # With OXXO + sidelites: 165.5" total frame width
        # DP: +80/-80 PSF across configurations
        # Frame depth: 3.825" (Extrusions sheet, frame head/sill callout)
        (
            "mp-cgi-s160", "CGI Windows", "Sentinel", "160",
            "Outswing Glazed Door", "french_door",
            36.0, 81.5, 80.0, 96.0,
            80.0, 80.0, 1,
            "25-0701.06", "2028-08-08", "LMI/SMI",
            FT_DOOR, G_CGI, FC_CGI, '3.825"', 6,
            "Revises 23-0717.02. Single (42\" max) or double (81.5\" max) door frame. "
            "OXXO with sidelites reaches 165.5\" total. DP ±80 PSF. Sidelite option available.",
            "https://www.miamidade.gov/building/library/productcontrol/noa/25070106.pdf"
        ),

        # ══ CGI ESTATE (1) ════════════════════════════════════
        # Estate 238 — Casement Outswing
        # Source: NOA 24-0624.04 confirmed File Approved — physical specs NOT extracted
        # Loading as placeholder with NOA/expiry only. Specs pending NOA PDF pull.
        (
            "mp-cgi-e238", "CGI Windows", "Estate", "238",
            "Casement Window", "casement",
            12.0, 53.0, 12.0, 84.0,
            80.0, 80.0, 1,
            "24-0624.04", "2028-10-26", "LMI/SMI",
            FT_FL, G_CGI, FC_CGI, "[DATA PENDING]", 5,
            "Revises 23-0906.02. File Approved confirmed via Miami-Dade PC page. "
            "Physical specs (exact max W/H, DP tables, frame depth) pending NOA PDF extraction. "
            "Size/DP values shown are estimates — verify from NOA 24-0624.04 drawing pages.",
            "https://www.miamidade.gov/building/library/productcontrol/noa/24062404.pdf"
        ),

        # ══ V&V WINDOWS AND DOORS (4) ═══════════════════════
        # All LMI+SMI, all HVHZ confirmed via Miami-Dade PC pages

        # V&V Series 100 — Single Hung
        # Source: NOA 25-0423.04, typical elevations + Design Load Tables + Extrusions
        # Max size: 53.125" W × 78" H (typical elevation sheet)
        # DP: +80/-120 PSF (Glass Type D — asymmetric, common in South FL wind loading)
        # Frame depth: ~2.827" (extrusion head dimension)
        # ⚠️  EXPIRES 2026-10-20 — flag in library
        (
            "mp-vv-100", "V&V Windows and Doors", "Series 100", "S-100",
            "Single Hung", "single_hung",
            19.0, 53.125, 24.0, 78.0,
            80.0, 120.0, 1,
            "25-0423.04", "2026-10-20", "LMI/SMI",
            FT_FL, G_VV, FC_VV, '2.827"', 5,
            "EXPIRING 2026-10-20 — verify renewal before specifying. "
            "Asymmetric DP: +80 EXT / -120 INT PSF (Glass Type D). "
            "Typical elevation: 53.125\" W × 78\" H max.",
            "https://www.miamidade.gov/building/library/productcontrol/noa/25042304.pdf"
        ),

        # V&V Series 200 — Horizontal Sliding Window
        # Source: NOA 25-0319.03, Design Load Tables + Extrusions
        # Max size: 111" W × 63" H (XOX configuration)
        # DP: +80/-90 PSF (Glass Type D)
        # Frame depth: 2.765" (frame head, Extrusions sheet)
        (
            "mp-vv-200", "V&V Windows and Doors", "Series 200", "S-200",
            "Horizontal Roller", "horizontal_roller",
            19.0, 111.0, 18.0, 63.0,
            80.0, 90.0, 1,
            "25-0319.03", "2030-12-30", "LMI/SMI",
            FT_FL, G_VV, FC_VV, '2.765"', 5,
            "File Approved. Max +80/-90 PSF (Glass Type D). "
            "Multi-panel up to 111\" wide (XOX). Frame head 2.765\".",
            "https://www.miamidade.gov/building/library/productcontrol/noa/25031903.pdf"
        ),

        # V&V Series 350 — Fixed / Picture Window
        # Source: NOA 25-0421.04, Design Load Charts + Extrusions
        # Max size: 120" W (length; orientation swappable) × 72" H
        # DP: +100/-100 PSF (Glass Types B/Bi — highest DP in V&V window line)
        # Frame depth: 3.000" (frame head/sill/jamb dimension)
        (
            "mp-vv-350", "V&V Windows and Doors", "Series 350", "S-350",
            "Fixed / Picture Window", "fixed",
            14.0, 120.0, 14.0, 72.0,
            100.0, 100.0, 1,
            "25-0421.04", "2029-06-06", "LMI/SMI",
            FT_FL3, G_VV, FC_VV, '3.000"', 4,
            "File Approved. W/L orientation interchangeable. "
            "Max ±100 PSF with premium Glass B/Bi — highest DP in V&V window lineup. "
            "Many standard sizes at ±80 PSF; verify per size from DP charts.",
            "https://www.miamidade.gov/building/library/productcontrol/noa/25042104.pdf"
        ),

        # V&V Series 300 — Outswing Glazed Door (with/without transom)
        # Source: NOA 25-0317.01, Door Elevations + Load Capacity Tables + Extrusions
        # Max size: 76" W (double door frame) × 120" H (with transom)
        # DP: +80/-80 PSF
        # Frame depth: 4.000" (frame head/jamb dimension, Extrusions sheet)
        (
            "mp-vv-300", "V&V Windows and Doors", "Series 300", "S-300",
            "Outswing Glazed Door", "entry_door",
            36.0, 76.0, 80.0, 120.0,
            80.0, 80.0, 1,
            "25-0317.01", "2030-09-10", "LMI/SMI",
            FT_DOOR, G_VV, FC_VV, '4.000"', 6,
            "Revises prior NOA. Double door frame max 76\". "
            "Max height 120\" includes transom; door panel alone approx 96\" max. "
            "±80 PSF across door and sidelite components. Frame head/jamb 4.000\".",
            "https://www.miamidade.gov/building/library/productcontrol/noa/25031701.pdf"
        ),
    ]

    for p in products:
        (pid, mfr, series, model, name, otype,
         min_w, max_w, min_h, max_h, dp_pos, dp_neg, hvhz,
         noa, noa_exp, missile, ft_json, glass_json, color_json,
         frame_depth, lead_time, description, spec_url) = p

        db.execute(
            """INSERT INTO master_products
               (id,manufacturer,series,model_number,name,opening_type,
                min_width_in,max_width_in,min_height_in,max_height_in,
                dp_rating_pos,dp_rating_neg,hvhz_compliant,
                noa_number,noa_expires,missile_impact,
                frame_types_json,glass_options_json,frame_colors_json,
                frame_depth,lead_time_weeks,description,spec_sheet_url,
                base_msrp,active,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,1,?,?)
               ON CONFLICT (id) DO NOTHING""",
            (pid, mfr, series, model, name, otype,
             min_w, max_w, min_h, max_h,
             dp_pos, dp_neg, hvhz,
             noa, noa_exp, missile,
             ft_json, glass_json, color_json,
             frame_depth, lead_time, description, spec_url,
             now, now)
        )

    db.commit()
    added = db.execute(
        "SELECT COUNT(*) FROM master_products WHERE manufacturer IN ('CGI Windows','V&V Windows and Doors')"
    ).fetchone()[0]
    print(f"[bootstrap] CGI + V&V: {added} products loaded")


def _ensure_expanded_products(db):
    """
    Seed CWS Hurricane Guard, PGT AW-740, V&V additions,
    WinDoor, EMC 2100 series, and Eco-Guard products.
    Idempotent. Source: Miami-Dade NOA library + FL Product Approvals (March 2026).
    """
    # Check if already seeded
    existing = db.execute(
        "SELECT COUNT(*) FROM master_products WHERE manufacturer IN "
        "('CWS Custom Window Systems','WinDoor','EMC Windows','Eco Window Systems')"
    ).fetchone()[0]
    # Also check PGT AW-740 and V&V additions
    vv_extra = db.execute(
        "SELECT COUNT(*) FROM master_products WHERE id IN ('mp-vv-400','mp-vv-s3000','mp-pgt-aw740')"
    ).fetchone()[0]
    if existing > 0 and vv_extra >= 3:
        return

    now = "2026-03-18T00:00:00"

    G_STD  = '["impact_laminated","impact_laminated_lowe","sentryglas","tinted_privacy"]'
    G_FPA  = '["impact_laminated","impact_laminated_lowe","tinted_privacy"]'
    FC_ALU = '["white","bronze","dark_bronze","black"]'
    FC_CWS = '["white","bronze","dark_bronze","black","clay","sandstone"]'
    FC_EMC = '["white","bronze","dark_bronze"]'
    FC_ECO = '["white","bronze"]'
    FC_WD  = '["white","bronze","dark_bronze","black","silver","champagne"]'
    FT_FL  = '["flange","fin"]'
    FT_FLG = '["flange"]'
    FT_FIN = '["fin"]'
    FT_DOO = '["flange"]'

    products = [

        # ══ CWS HURRICANE GUARD (8) ══════════════════════════
        # Source: Miami-Dade applicant listing app_alias=100149
        # Physical specs PENDING — NOA PDFs not extracted.
        # Storing compliance identity (NOA + expiry) with spec placeholders.

        # 7100 Flange Frame — Single Hung LMI
        ("mp-cws-7100f", "CWS Custom Window Systems", "Hurricane Guard", "7100",
         "Single Hung (Flange Frame)", "single_hung",
         19.0, 53.125, 24.0, 74.25, 80.0, 90.0, 1,
         "25-0929.03", "2031-12-27", "LMI",
         FT_FLG, G_STD, FC_CWS, "[DATA PENDING]", 5,
         "Flange frame LMI. NOA confirmed active expires 12/27/2031. "
         "Physical specs (exact DP tables, frame depth, max size) pending NOA PDF extraction. "
         "See NOA 25-0929.03 drawings for size/DP tables.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/25092903.pdf"),

        # SH-7100 Fin Frame — Single Hung LMI
        ("mp-cws-7100n", "CWS Custom Window Systems", "Hurricane Guard", "SH-7100",
         "Single Hung (Fin Frame)", "single_hung",
         19.0, 53.125, 24.0, 74.25, 80.0, 90.0, 1,
         "25-0929.06", "2028-11-06", "LMI",
         FT_FIN, G_STD, FC_CWS, "[DATA PENDING]", 5,
         "Fin frame LMI version of 7100 series. NOA confirmed active expires 11/06/2028. "
         "Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/25092906.pdf"),

        # 7200 Flange Frame — Horizontal Roller LMI
        ("mp-cws-7200f", "CWS Custom Window Systems", "Hurricane Guard", "7200",
         "Horizontal Roller (Flange Frame)", "horizontal_roller",
         19.0, 111.0, 18.0, 63.0, 80.0, 80.0, 1,
         "25-0929.04", "2027-04-11", "LMI",
         FT_FLG, G_STD, FC_CWS, "[DATA PENDING]", 5,
         "Flange frame horizontal roller. NOA confirmed active expires 04/11/2027. "
         "Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/25092904.pdf"),

        # 7200 Fin Frame — Horizontal Roller LMI
        ("mp-cws-7200n", "CWS Custom Window Systems", "Hurricane Guard", "7200",
         "Horizontal Roller (Fin Frame)", "horizontal_roller",
         19.0, 111.0, 18.0, 63.0, 80.0, 80.0, 1,
         "25-0929.05", "2028-10-09", "LMI",
         FT_FIN, G_STD, FC_CWS, "[DATA PENDING]", 5,
         "Fin frame horizontal roller. NOA confirmed active expires 10/09/2028. "
         "Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/25092905.pdf"),

        # 7300 Fin Frame — Fixed/Picture LMI
        ("mp-cws-7300n", "CWS Custom Window Systems", "Hurricane Guard", "7300",
         "Fixed / Picture Window (Fin Frame)", "fixed",
         14.0, 53.125, 14.0, 74.25, 80.0, 80.0, 1,
         "25-0929.07", "2027-07-19", "LMI",
         FT_FIN, G_STD, FC_CWS, "[DATA PENDING]", 4,
         "Fin frame fixed window. NOA confirmed active expires 07/19/2027. "
         "Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/25092907.pdf"),

        # 7300 Flange Frame — Fixed/Picture LMI
        ("mp-cws-7300f", "CWS Custom Window Systems", "Hurricane Guard", "7300",
         "Fixed / Picture Window (Flange Frame)", "fixed",
         14.0, 53.125, 14.0, 74.25, 80.0, 80.0, 1,
         "25-0929.08", "2027-08-22", "LMI",
         FT_FLG, G_STD, FC_CWS, "[DATA PENDING]", 4,
         "Flange frame fixed window. NOA confirmed active expires 08/22/2027. "
         "Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/25092908.pdf"),

        # 7400 — Casement Outswing LMI+SMI (already have 24-0116.11)
        # Skipping — already loaded as mp-... wait, CWS 7400 not in existing list
        ("mp-cws-7400", "CWS Custom Window Systems", "Hurricane Guard", "7400",
         "Casement Outswing", "casement",
         12.0, 53.0, 12.0, 84.0, 80.0, 90.0, 1,
         "24-0116.11", "2029-03-04", "LMI/SMI",
         FT_FL, G_STD, FC_CWS, "[DATA PENDING]", 5,
         "Casement LMI+SMI. NOA confirmed File Approved expires 03/04/2029. "
         "Physical specs pending NOA PDF extraction. "
         "See NOA 24-0116.11.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/24011611.pdf"),

        # 7700 — French/Swing Door LMI+SMI
        ("mp-cws-7700", "CWS Custom Window Systems", "Hurricane Guard", "7700",
         "French / Swing Door", "french_door",
         36.0, 76.0, 80.0, 96.0, 80.0, 80.0, 1,
         "24-0116.12", "2028-06-05", "LMI/SMI",
         FT_DOO, G_STD, FC_CWS, "[DATA PENDING]", 6,
         "French/swing door LMI+SMI. File Approved confirmed via Miami-Dade PC page. "
         "Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/24011612.pdf"),

        # 7900 — Sliding Glass Door LMI+SMI
        ("mp-cws-7900", "CWS Custom Window Systems", "Hurricane Guard", "CWS-7900",
         "Sliding Glass Door", "sliding_glass_door",
         29.0, 192.0, 78.0, 110.0, 80.0, 80.0, 1,
         "25-1201.04", "2028-02-13", "LMI/SMI",
         FT_DOO, G_STD, FC_CWS, "[DATA PENDING]", 6,
         "SGD LMI+SMI. Revises NOA 23-1012.04. File Approved. "
         "Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/25120104.pdf"),

        # ══ PGT WINGUARD — AW-740 (new, not in existing list) ══
        ("mp-pgt-aw740", "PGT Windows + Doors", "WinGuard 770", "AW-740",
         "Awning Window", "casement",
         12.0, 42.0, 12.0, 48.0, 65.0, 80.0, 1,
         "23-0816.15", "2028-04-11", "LMI",
         '["flange","integral_fin"]', G_STD, FC_ALU, "2.784\"", 5,
         "WinGuard aluminum awning window. LMI HVHZ approved. "
         "Same 770 series frame profile as CA-740 casement.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/23081615.pdf"),

        # ══ V&V ADDITIONS (2 new) ══════════════════════════════

        # V&V Series 400 — Casement Outswing
        ("mp-vv-400", "V&V Windows and Doors", "Series 400", "S-400",
         "Casement Window", "casement",
         12.0, 53.0, 12.0, 84.0, 80.0, 90.0, 1,
         "24-0425.05", "2029-12-24", "LMI",
         FT_FL, G_STD, FC_ALU, "[DATA PENDING]", 5,
         "Casement LMI. File Approved confirmed via V&V applicant listing. "
         "Expires 12/24/2029. Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/24042505.pdf"),

        # V&V S-3000 — Sliding Glass Door
        ("mp-vv-s3000", "V&V Windows and Doors", "Series S-3000", "S-3000",
         "Sliding Glass Door", "sliding_glass_door",
         29.0, 192.0, 78.0, 120.0, 80.0, 80.0, 1,
         "25-0829.07", "2031-09-02", "LMI",
         FT_DOO, G_STD, FC_ALU, "[DATA PENDING]", 6,
         "SGD LMI. Confirmed via V&V applicant listing. Expires 09/02/2031. "
         "Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/25082907.pdf"),

        # ══ ESWINDOWS ADDITIONS ════════════════════════════════

        # ESWindows 5100 Fixed Casement — new, not in current list
        ("mp-es-5100", "ESWindows", "Elite", "5100",
         "Fixed Casement Window", "casement",
         12.0, 53.125, 12.0, 84.0, 80.0, 80.0, 1,
         "24-0930.02", "2026-09-22", "LMI",
         '["flange","flush"]', G_STD,
         '["white","bronze_2604","bronze_2605","black","bone_white","bermuda_bronze","arcadia_silver","silverstorm"]',
         "[DATA PENDING]", 5,
         "EXPIRING 2026-09-22 — verify renewal. Fixed casement LMI. "
         "Physical specs pending NOA PDF extraction.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/24093002.pdf"),

        # ══ WINDOOR (Florida Product Approvals — no Miami-Dade NOA) ══
        # HVHZ status per FL approval record — treat as 1 pending verification
        # Note: WinDoor uses FL# not Miami-Dade NOA as primary approval

        ("mp-wd-8100", "WinDoor", "WinDoor 8100", "8100",
         "Sliding Glass Door", "sliding_glass_door",
         29.0, 192.0, 78.0, 120.0, 70.0, 80.0, 1,
         "FL16755", None, "LMI/SMI",
         FT_DOO, G_STD, FC_WD, "[DATA PENDING]", 7,
         "Florida Product Approval FL16755. HVHZ approval — verify current FL record status. "
         "No Miami-Dade NOA on file; WinDoor uses FPA as primary approval. "
         "Physical specs from FL install instructions. Per WinDoor approvals page.",
         "https://windoorinc.com/approvals-and-certifications"),

        ("mp-wd-9020", "WinDoor", "WinDoor 9020", "9020",
         "Fixed / Picture Window", "fixed",
         14.0, 96.0, 14.0, 96.0, 80.0, 80.0, 1,
         "FL15709", None, "LMI/SMI",
         FT_FL, G_STD, FC_WD, "[DATA PENDING]", 5,
         "Florida Product Approval FL15709. Verify current FL record. "
         "Physical specs from FL install instructions.",
         "https://windoorinc.com/approvals-and-certifications"),

        ("mp-wd-9050", "WinDoor", "WinDoor 9050", "9050",
         "Terrace Door (Thermally Broken)", "entry_door",
         36.0, 72.0, 80.0, 96.0, 70.0, 80.0, 1,
         "FL29783", None, "LMI/SMI",
         FT_DOO, G_STD, FC_WD, "[DATA PENDING]", 7,
         "Florida Product Approval FL29783. Thermally broken terrace door. "
         "Verify current FL record. Physical specs from FL install instructions.",
         "https://windoorinc.com/approvals-and-certifications"),

        # ══ EMC 2100 SERIES (Florida Product Approvals + HVHZ confirmed) ═

        ("mp-emc-sh2100", "EMC Windows", "2100 Series", "SH-2100",
         "Single Hung", "single_hung",
         19.0, 53.125, 24.0, 74.25, 70.0, 90.0, 1,
         "FL17597", None, "LMI/SMI",
         FT_FL, G_FPA, FC_EMC, "[DATA PENDING]", 5,
         "FL17597. HVHZ approved — confirmed in Installation Instructions PDF. "
         "LMI + SMI. Physical specs in FL install doc (max size + DP tables). "
         "Verify current FL record.",
         "https://www.floridabuilding.org/upload/PR_Instl_Docs/FL17597_R3_II_Series%20SH2100%20Aluminum%20Single%20Hung%20Window%20-%20L.M.I.%20and%20S.M.I.%20FL17597%20AD15-15%20R09.25.2023-SS.pdf"),

        ("mp-emc-hr2100", "EMC Windows", "2100 Series", "HR-2100",
         "Horizontal Roller", "horizontal_roller",
         19.0, 111.0, 18.0, 63.0, 70.0, 80.0, 1,
         "FL17595", None, "LMI/SMI",
         FT_FL, G_FPA, FC_EMC, "[DATA PENDING]", 5,
         "FL17595. HVHZ approved — confirmed in HR2100 Installation Instructions PDF. "
         "LMI + SMI.",
         "https://www.floridabuilding.org/upload/PR_Instl_Docs/FL17595_R3_II_HR%202100%20Aluminum%20Horizontal%20Sliding%20Window%20-%20L.M.I.%20S.M.I.-FL17595%20AD15-14%20R10.09.2023_ss.pdf"),

        ("mp-emc-fx2100", "EMC Windows", "2100 Series", "FX-2100",
         "Fixed / Picture Window", "fixed",
         14.0, 72.0, 14.0, 72.0, 70.0, 80.0, 1,
         "FL17583", None, "LMI/SMI",
         FT_FL, G_FPA, FC_EMC, "[DATA PENDING]", 4,
         "FL17583. HVHZ approved — confirmed in FX2100 Installation Instructions PDF. "
         "LMI + SMI.",
         "https://www.floridabuilding.org/upload/PR_Instl_Docs/FL17583_R2_II_AD15-13-%20FX%202100-SS.pdf"),

        ("mp-emc-sg2100", "EMC Windows", "2100 Series", "SG-2100",
         "Sliding Glass Door", "sliding_glass_door",
         29.0, 192.0, 78.0, 96.0, 70.0, 80.0, 1,
         "FL17596", None, "LMI/SMI",
         FT_DOO, G_FPA, FC_EMC, "[DATA PENDING]", 6,
         "FL17596. HVHZ approved — confirmed in SG2100 Installation Instructions PDF. "
         "LMI + SMI.",
         "https://www.floridabuilding.org/upload/PR_Instl_Docs/FL17596_R3_II_Series%20SG2100%20Sliding%20Glass%20Door%20-%20L.M.I.%20%20%20S.M.I.%20FL17596%20AD15-16%20R09.28.2023%20ss.pdf"),

        ("mp-emc-fd2100", "EMC Windows", "2100 Series", "FD-2100",
         "French / Swing Door", "french_door",
         36.0, 76.0, 80.0, 96.0, 70.0, 80.0, 1,
         "FL29477", None, "LMI/SMI",
         FT_DOO, G_FPA, FC_EMC, "[DATA PENDING]", 6,
         "FL29477. HVHZ approval — verify current FL record. "
         "Physical specs in FL install instructions PDF.",
         "https://www.floridabuilding.org/upload/PR_Instl_Docs/FL29477_R2_II_FRENCH%20DOOR%20FL29477-%20AD19-16%20R09.25.2023-SS.pdf"),

        # ══ ECO WINDOW SYSTEMS ══════════════════════════════════
        # Eco-Guard 50 — ONLY active HVHZ product in Eco lineup (March 2026)
        ("mp-eco-50", "Eco Window Systems", "Eco-Guard", "50",
         "Single Hung LMI", "single_hung",
         19.0, 53.125, 24.0, 74.25, 70.0, 80.0, 1,
         "22-0105.03", "2027-11-21", "LMI",
         '["flange"]', G_FPA, FC_ECO, "[DATA PENDING]", 5,
         "ONLY active HVHZ Eco product. Renewal of prior Eco-Guard 50 NOA. "
         "Expires 11/21/2027. Physical specs pending.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/22010503.pdf"),

        # Eco expired products — stored as inactive (active=0) for reference
        # These should NOT appear in quoting or sharing flows
        ("mp-eco-60", "Eco Window Systems", "Eco-Guard", "60",
         "Horizontal Roller LMI", "horizontal_roller",
         19.0, 53.125, 18.0, 63.0, 70.0, 80.0, 1,
         "20-1119.09", "2024-06-19", "LMI",
         '["flange"]', G_FPA, FC_ECO, "[DATA PENDING]", 5,
         "EXPIRED 06/19/2024 — NOT valid for HVHZ quoting. "
         "Stored as inactive reference only. Do not activate without confirmed renewal NOA.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/20111909.pdf"),

        ("mp-eco-100", "Eco Window Systems", "Eco-Guard", "100",
         "Single Hung LMI", "single_hung",
         19.0, 53.125, 24.0, 74.25, 70.0, 80.0, 1,
         "20-1119.14", "2024-04-08", "LMI",
         '["flange"]', G_FPA, FC_ECO, "[DATA PENDING]", 5,
         "EXPIRED 04/08/2024 — NOT valid for HVHZ quoting. Inactive reference only.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/20111914.pdf"),

        ("mp-eco-300", "Eco Window Systems", "Eco-Guard", "300",
         "Fixed Window LMI", "fixed",
         14.0, 53.125, 14.0, 74.25, 70.0, 80.0, 1,
         "20-1119.05", "2024-06-17", "LMI",
         '["flange"]', G_FPA, FC_ECO, "[DATA PENDING]", 4,
         "EXPIRED 06/17/2024 — NOT valid for HVHZ quoting. Inactive reference only.",
         "https://www.miamidade.gov/building/library/productcontrol/noa/20111905.pdf"),

        ("mp-eco-700", "Eco Window Systems", "Eco Series", "700",
         "Sliding Glass Door LMI", "sliding_glass_door",
         29.0, 192.0, 78.0, 96.0, 70.0, 80.0, 1,
         "21-0114.11", "2024-03-20", "LMI",
         '["flange"]', G_FPA, FC_ECO, "[DATA PENDING]", 6,
         "EXPIRED 03/20/2024 — NOT valid for HVHZ quoting. Inactive reference only. "
         "Listed under ECO Windows Systems, LLC (separate entity from Eco Window Systems LLC).",
         "https://www.miamidade.gov/building/library/productcontrol/noa/21011411.pdf"),
    ]

    # Expired Eco products get active=0
    expired_ids = {"mp-eco-60", "mp-eco-100", "mp-eco-300", "mp-eco-700"}

    for p in products:
        (pid, mfr, series, model, name, otype,
         min_w, max_w, min_h, max_h, dp_pos, dp_neg, hvhz,
         noa, noa_exp, missile, ft_json, glass_json, color_json,
         frame_depth, lead_time, description, spec_url) = p

        active = 0 if pid in expired_ids else 1

        db.execute(
            """INSERT INTO master_products
               (id,manufacturer,series,model_number,name,opening_type,
                min_width_in,max_width_in,min_height_in,max_height_in,
                dp_rating_pos,dp_rating_neg,hvhz_compliant,
                noa_number,noa_expires,missile_impact,
                frame_types_json,glass_options_json,frame_colors_json,
                frame_depth,lead_time_weeks,description,spec_sheet_url,
                base_msrp,active,created_at,updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL,?,?,?)
               ON CONFLICT (id) DO NOTHING""",
            (pid, mfr, series, model, name, otype,
             min_w, max_w, min_h, max_h,
             dp_pos, dp_neg, hvhz,
             noa, noa_exp, missile,
             ft_json, glass_json, color_json,
             frame_depth, lead_time, description, spec_url,
             active, now, now)
        )

    db.commit()
    total = db.execute(
        "SELECT COUNT(*) FROM master_products WHERE manufacturer IN "
        "('CWS Custom Window Systems','WinDoor','EMC Windows','Eco Window Systems')"
    ).fetchone()[0]
    new_pgt = db.execute(
        "SELECT COUNT(*) FROM master_products WHERE id IN ('mp-vv-400','mp-vv-s3000','mp-pgt-aw740','mp-es-5100')"
    ).fetchone()[0]
    print(f"[bootstrap] CWS/WinDoor/EMC/Eco: {total} | V&V+PGT additions: {new_pgt}")


if __name__ == "__main__":
    _run_dev_server()

