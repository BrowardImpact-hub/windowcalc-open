/* ============================================================
   WINDOWCALC — Frontend Application v3.0
   Vanilla JS, fetch() API, hash-based routing
   ============================================================ */

const API = (window.WINDOWCALC_API_BASE || "/api");
const TENANT_ID = "";

/* ============================================================
   STATE
   ============================================================ */
const STATE = {
  mode: "admin",
  currentUser: null,
  currentTenant: null,
  availableTenants: [],
  systemTenants: [],
  onboardingStatus: null,
  productImportPreview: null,
  loginTenantChoices: [],
  currentQuote: null,
  currentQuoteId: null,
  openingBuilder: {
    step: 1,
    quoteId: null,
    openingMode: "single", // 'single' | 'multipart'
    openingType: null,
    width: null,
    height: null,
    floorLevel: 1,
    wallType: "cbs",
    productId: null,
    glassOptionId: null,
    frameColorId: null,
    complexityIds: [],
    liveCalc: null,
    drivewayDiscountPct: 0,
    requestedSellPrice: null,
    // Multipart fields
    assemblyTemplate: null,
    panelCount: 2,
    layoutType: "2-wide",
    panels: [], // [{productType, productId, glassOptionId, frameColorId, width, height}]
    currentPanelIndex: 0,
  },
  // Cached data
  products: [],
  glassOptions: [],
  frameColors: [],
  complexityItems: [],
  consumables: [],
  assemblyTemplates: [],
  productPricePoints: [],
  globalSettings: {},
  users: [],
  governance: null,
  governanceOverrides: [],
  dpRatings: [],
  pendingApprovalCount: 0,
  dashboardQuotes: [],
  selectedUserProfile: null,
  selectedUserProfileTab: "overview",
  system: {},
  hubContext: {
    quoteId: null,
    customerName: "",
    customerPhone: "",
    smsAvailable: false,
    smsReason: "",
  },
};

const IS_MOBILE_LITE = window.innerWidth <= 768;
const CONNECTION_PREFERS_SAVE_DATA = Boolean(navigator.connection && navigator.connection.saveData);
const AUTO_MOBILE_LITE = IS_MOBILE_LITE || CONNECTION_PREFERS_SAVE_DATA;
const PREFERS_REDUCED_MOTION = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const SHOULD_LIMIT_MOTION = AUTO_MOBILE_LITE || PREFERS_REDUCED_MOTION;
const BOOT_SPLASH_MIN_MS = SHOULD_LIMIT_MOTION ? 900 : 1500;
const LOGO_REPLAY_DURATION_MS = SHOULD_LIMIT_MOTION ? 1800 : 3000;
const MOBILE_LITE_STORAGE_KEY = "wc_mobile_lite";

let hubPollInterval = null;
let activeHubQuoteId = null;
let confettiLoader = null;
let hubAttachmentPreviewUrl = null;
let reportsMarginChart = null;
let _bootSplashStartedAt = Date.now();
let _bootReleaseTimer = null;
let _logoReplayTimer = null;
let _mobileLiteOverride = null;

if (AUTO_MOBILE_LITE) {
  document.body.classList.add("mobile-lite");
}

/* ============================================================
   THEME SYSTEM
   ============================================================ */
let _themeStore = 'dark';
function initTheme() {
  document.documentElement.setAttribute('data-theme', _themeStore);
  updateThemeIcon(_themeStore);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  _themeStore = next;
  updateThemeIcon(next);
}
function updateThemeIcon(theme) {
  const sun = document.getElementById('theme-icon-sun');
  const moon = document.getElementById('theme-icon-moon');
  if (sun && moon) {
    sun.style.display = theme === 'light' ? 'block' : 'none';
    moon.style.display = theme === 'dark' ? 'block' : 'none';
  }
}

function isMobileLiteEnabled() {
  return _mobileLiteOverride == null ? AUTO_MOBILE_LITE : _mobileLiteOverride;
}

function updateMobileLiteToggle() {
  const btn = document.getElementById("mobile-lite-toggle");
  if (!btn) return;
  const active = isMobileLiteEnabled();
  btn.classList.toggle("active", active);
  btn.setAttribute("aria-pressed", active ? "true" : "false");
  btn.textContent = active ? "Lite On" : "Lite";
  btn.setAttribute("title", active ? "Disable fast mobile or low-data view" : "Enable fast mobile or low-data view");
}

function applyMobileLiteMode() {
  document.body.classList.toggle("mobile-lite", isMobileLiteEnabled());
  updateMobileLiteToggle();
}

function initMobileLiteMode() {
  try {
    const stored = localStorage.getItem(MOBILE_LITE_STORAGE_KEY);
    if (stored === "1") _mobileLiteOverride = true;
    else if (stored === "0") _mobileLiteOverride = false;
  } catch (_) {}
  applyMobileLiteMode();
}

function toggleMobileLiteMode() {
  _mobileLiteOverride = !isMobileLiteEnabled();
  try {
    localStorage.setItem(MOBILE_LITE_STORAGE_KEY, _mobileLiteOverride ? "1" : "0");
  } catch (_) {}
  applyMobileLiteMode();
}

/* ============================================================
   API HELPERS
   ============================================================ */
async function apiFetch(path, options = {}, _retries = 1) {
  const sep = path.includes("?") ? "&" : "?";
  const url = `${API}${path}${sep}tenant_id=${TENANT_ID}`;
  const headers = { ...(options.headers || {}) };
  const hasContentType = Object.keys(headers).some((key) => key.toLowerCase() === "content-type");
  if (!(options.body instanceof FormData) && !hasContentType) {
    headers["Content-Type"] = "application/json";
  }

  // AbortController timeout — 30s default (uploads get more time)
  const isUpload = options.body instanceof FormData;
  const timeoutMs = isUpload ? 120000 : 30000;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      const err = new Error(`API ${res.status}: ${errText}`);
      err.status = res.status;
      // Don't retry on auth errors or client errors
      if (res.status === 401 || res.status === 403 || res.status === 400 || res.status === 404) {
        throw err;
      }
      // Retry once on 5xx server errors (transient failures)
      if (_retries > 0 && res.status >= 500) {
        await new Promise(r => setTimeout(r, 800));
        return apiFetch(path, options, _retries - 1);
      }
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch (e) {
    clearTimeout(timeoutId);
    if (e.name === "AbortError") {
      throw new Error("Request timed out. Please check your connection and try again.");
    }
    // Retry once on network failures (offline, DNS, etc.)
    if (_retries > 0 && (e.name === "TypeError" || e.message?.includes("Failed to fetch"))) {
      await new Promise(r => setTimeout(r, 1000));
      return apiFetch(path, options, _retries - 1);
    }
    console.error("API Error:", path, e);
    throw e;
  }
}

const get   = (path)       => apiFetch(path);
const post  = (path, body) => apiFetch(path, { method: "POST",   body: JSON.stringify(body) });
const put   = (path, body) => apiFetch(path, { method: "PUT",    body: JSON.stringify(body) });
const patch = (path, body) => apiFetch(path, { method: "PATCH",  body: JSON.stringify(body) });
const del   = (path)       => apiFetch(path, { method: "DELETE" });

/* ============================================================
   TOAST SYSTEM
   ============================================================ */
function toast(msg, type = "info", duration = 4000) {
  const icons = { success: "[OK]", error: "[X]", warning: "[!]", info: "[i]" };
  const container = document.getElementById("toast-container");
  const el2 = document.createElement("div");
  el2.className = `toast ${type}`;
  el2.innerHTML = `<span class="toast-icon">${icons[type]}</span><span>${msg}</span>`;
  container.appendChild(el2);
  setTimeout(() => {
    el2.classList.add("toast-fade");
    setTimeout(() => el2.remove(), 300);
  }, duration);
}

/* ============================================================
   UTILITY
   ============================================================ */
function fmt(n, decimals = 2) {
  if (n == null || isNaN(n)) return "-";
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
function fmtMoney(n)  { return isPricingHidden() ? "-" : (n != null ? `$${fmt(n)}` : "-"); }
function fmtPct(n)    { return isMarginHidden() ? "-" : (n != null ? `${fmt(n)}%` : "-"); }
function marginColor(pct, floor = 30, yellow = 3) {
  if (isMarginHidden()) return "";
  if (pct == null) return "";
  if (pct < floor) return "red";
  if (pct < floor + yellow) return "amber";
  return "green";
}
function timeSince(dateStr) {
  if (!dateStr) return "";
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins  = Math.floor(diff / 60000);
  const hours = Math.floor(mins / 60);
  const days  = Math.floor(hours / 24);
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (mins > 0) return `${mins}m ago`;
  return "just now";
}
function statusLabel(s) {
  const map = {
    draft: "Draft", pending_approval: "Pending", approved: "Approved",
    completed: "Completed", denied: "Denied",
  };
  return map[s] || s;
}
function openingTypeLabel(t) {
  const map = {
    single_hung: "Single Hung", double_hung: "Double Hung", casement: "Casement",
    sliding_glass_door: "Sliding Glass Door", fixed: "Fixed Picture",
    entry_door: "Entry Door", french_door: "French Door",
    horizontal_roller: "Horizontal Roller", bifold_door: "Bifold Door",
  };
  return map[t] || t;
}
function floorLabel(n) {
  const map = { 1: "1st Floor", 2: "2nd Floor", 3: "3rd Floor", 4: "4th Floor+" };
  return map[n] || `Floor ${n}`;
}
function getRepFloor() {
  if (!STATE.governance) return { floor: 30, yellow: 3 };
  const tier = STATE.currentUser.tier || "standard";
  const g = STATE.governance.find(x => x.tier === tier);
  return { floor: g ? g.margin_floor : 30, yellow: g ? g.yellow_threshold : 3 };
}
function lineBadge(line) {
  const map = {
    prestige: `<span style="background:rgba(99,102,241,0.2);color:#818cf8;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;font-family:var(--font-mono);letter-spacing:.05em;">PRESTIGE</span>`,
    elite:    `<span style="background:rgba(245,158,11,0.2);color:#f59e0b;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;font-family:var(--font-mono);letter-spacing:.05em;">ELITE</span>`,
    multimax: `<span style="background:rgba(16,185,129,0.2);color:#10b981;font-size:10px;font-weight:600;padding:2px 6px;border-radius:3px;font-family:var(--font-mono);letter-spacing:.05em;">MULTIMAX</span>`,
  };
  const key = (line || "").toLowerCase();
  return map[key] || `<span style="background:var(--bg-elevated);color:var(--text-muted);font-size:10px;padding:2px 6px;border-radius:3px;">${esc(line || "-")}</span>`;
}
function leadTimeColor(weeks) {
  if (!weeks) return "var(--text-muted)";
  if (weeks <= 4) return "var(--green)";
  if (weeks <= 6) return "var(--amber)";
  return "var(--red)";
}
function el(id)    { return document.getElementById(id); }
function qs(sel)   { return document.querySelector(sel); }
function qsa(sel)  { return Array.from(document.querySelectorAll(sel)); }
function esc(str) {
  if (str == null) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function sanitizeUiText(value) {
  if (value == null) return "";
  return String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safePreviewText(value, maxLength = 280) {
  const cleaned = sanitizeUiText(value);
  if (!cleaned) return "";
  if (cleaned.length <= maxLength) return cleaned;
  return `${cleaned.slice(0, Math.max(0, maxLength - 3))}...`;
}

function fmtDateTime(value) {
  if (!value) return "-";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return "-";
  return dt.toLocaleString();
}

function humanizeKey(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function compareTextValues(a, b) {
  return sanitizeUiText(a).localeCompare(sanitizeUiText(b), undefined, { sensitivity: "base" });
}

function compareNumberValues(a, b, direction = "desc") {
  const aNum = Number(a);
  const bNum = Number(b);
  const aValid = Number.isFinite(aNum);
  const bValid = Number.isFinite(bNum);
  if (!aValid && !bValid) return 0;
  if (!aValid) return 1;
  if (!bValid) return -1;
  return direction === "asc" ? aNum - bNum : bNum - aNum;
}

function sortDashboardQuotes(quotes, sortBy = "updated_desc") {
  const ordered = [...(quotes || [])];
  const statusOrder = { draft: 0, pending_approval: 1, approved: 2, completed: 3, denied: 4 };

  ordered.sort((a, b) => {
    switch (sortBy) {
      case "customer_name_asc":
        return compareTextValues(a.customer_name, b.customer_name) || compareTextValues(a.job_address, b.job_address);
      case "rep_name_asc":
        return compareTextValues(a.rep_name, b.rep_name) || compareTextValues(a.customer_name, b.customer_name);
      case "status_asc":
        return (statusOrder[a.status] ?? 99) - (statusOrder[b.status] ?? 99) || compareTextValues(a.customer_name, b.customer_name);
      case "margin_desc":
        return compareNumberValues(a.margin_pct, b.margin_pct, "desc") || compareTextValues(a.customer_name, b.customer_name);
      case "total_cost_desc":
        return compareNumberValues(a.total_cost, b.total_cost, "desc") || compareTextValues(a.customer_name, b.customer_name);
      case "total_price_desc":
        return compareNumberValues(a.total_price, b.total_price, "desc") || compareTextValues(a.customer_name, b.customer_name);
      case "updated_desc":
      default:
        return compareNumberValues(new Date(a.updated_at).getTime(), new Date(b.updated_at).getTime(), "desc");
    }
  });

  return ordered;
}

function buildAuditDetailsPreview(details) {
  if (!details) return "";
  try {
    const parsed = typeof details === "string" ? JSON.parse(details) : details;
    if (parsed && typeof parsed === "object") {
      const preview = Object.entries(parsed)
        .slice(0, 4)
        .map(([key, value]) => `${humanizeKey(key)}: ${sanitizeUiText(typeof value === "object" ? JSON.stringify(value) : value)}`)
        .join(" | ");
      return safePreviewText(preview, 220);
    }
  } catch {}
  return safePreviewText(details, 220);
}

function formatBytes(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function normalizeSettingValue(value) {
  if (value == null) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  const raw = String(value).trim();
  if (!raw) return "";
  const lower = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lower)) return true;
  if (["0", "false", "no", "off"].includes(lower)) return false;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

function normalizeGlobalSettings(payload) {
  if (!payload) return {};
  const out = {};
  if (Array.isArray(payload)) {
    payload.forEach((row) => {
      const key = row?.setting_key || row?.key;
      if (!key) return;
      out[key] = normalizeSettingValue(row?.setting_value ?? row?.value);
    });
    return out;
  }
  Object.entries(payload).forEach(([key, value]) => {
    out[key] = normalizeSettingValue(value);
  });
  return out;
}

function settingBool(key, fallback = false) {
  const v = STATE.globalSettings?.[key];
  if (v == null) return fallback;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  const s = String(v).toLowerCase().trim();
  return ["1", "true", "yes", "on"].includes(s);
}

function isHvhzOnlyMode(settings = null) {
  const source = settings || STATE.globalSettings || {};
  const raw = source?.hvhz_only_mode;
  if (raw == null || raw === "") return true;
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "number") return raw !== 0;
  const val = String(raw).toLowerCase().trim();
  return ["1", "true", "yes", "on"].includes(val);
}

function resolveRequiredZone() {
  if (isHvhzOnlyMode()) return "HVHZ";
  return String(STATE.currentQuote?.required_zone || STATE.globalSettings?.default_zone || "HVHZ").toUpperCase();
}

function getUiVisibility() {
  const hideEverything = settingBool("ui_hide_everything", false);
  const hidePricing = hideEverything || settingBool("ui_hide_pricing", false);
  const hideMargin = hideEverything || settingBool("ui_hide_margin", false);
  return { hideEverything, hidePricing, hideMargin };
}

function isPricingHidden() {
  return getUiVisibility().hidePricing;
}

function isMarginHidden() {
  return getUiVisibility().hideMargin;
}

function applyUiVisibility() {
  const body = document.body;
  if (!body) return;
  const vis = getUiVisibility();
  body.classList.toggle("ui-hide-pricing", vis.hidePricing);
  body.classList.toggle("ui-hide-margin", vis.hideMargin);
  body.classList.toggle("ui-hide-everything", vis.hideEverything);
}

/* ============================================================
   ANIMATED COUNTERS
   ============================================================ */
function animateCounter(element, target, prefix = '', suffix = '', duration = 800) {
  if (!element) return;
  const isFloat = String(target).includes('.');
  const start = 0;
  const startTime = performance.now();
  function update(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    const current = start + (target - start) * eased;
    element.textContent = prefix + (isFloat ? current.toFixed(2) : Math.round(current).toLocaleString()) + suffix;
    if (progress < 1) requestAnimationFrame(update);
  }
  requestAnimationFrame(update);
}

/* ============================================================
   INIT
   ============================================================ */
document.addEventListener("DOMContentLoaded", () => {
  initMobileLiteMode();
  initTheme();
  setupModeToggle();
  setupUserSelector();
  setupAdminSidebar();
  setupModalClose();
  loadInitialData();
  handleHashChange();
  window.addEventListener("hashchange", handleHashChange);
  document.getElementById('mobile-lite-toggle')?.addEventListener('click', toggleMobileLiteMode);
  document.getElementById('theme-toggle')?.addEventListener('click', toggleTheme);
  document.addEventListener("visibilitychange", () => {
    if (!activeHubQuoteId) return;
    if (document.hidden) {
      if (hubPollInterval) {
        clearInterval(hubPollInterval);
        hubPollInterval = null;
      }
      return;
    }
    void loadHubMessages(activeHubQuoteId);
    startHubPolling(activeHubQuoteId);
  });
  initScrollAnimations();
  enableOpeningDragDrop();
});

// loadInitialData is defined later in the file (auth-aware version with /api/me).

function finishBoot() {
  if (!document.body.classList.contains("booting")) return;
  const remaining = Math.max(0, BOOT_SPLASH_MIN_MS - (Date.now() - _bootSplashStartedAt));
  clearTimeout(_bootReleaseTimer);
  _bootReleaseTimer = setTimeout(() => {
    document.body.classList.remove("booting");
  }, remaining);
}

function _isUiSurfaceVisible(node) {
  if (!node || node.classList?.contains("hidden")) return false;
  const styles = window.getComputedStyle(node);
  return styles.display !== "none" && styles.visibility !== "hidden";
}

function _describeFieldReplayContext(hash) {
  if (!hash || hash === "field-home") return null;
  if (hash === "field-new-quote") {
    return {
      title: "Resume new quote draft",
      detail: "Everything in the field quote form stays parked exactly where it is.",
    };
  }
  if (hash === "field-chats") {
    return {
      title: "Resume field chat inbox",
      detail: "Your live field chat screen will still be open when the replay ends.",
    };
  }
  if (hash.startsWith("field-quote/")) {
    return {
      title: "Return to the current quote",
      detail: "The open quote and its pricing state stay loaded underneath the replay.",
    };
  }
  if (hash.startsWith("field-add-opening/")) {
    return {
      title: "Resume the add opening flow",
      detail: "Your current opening setup stays in place so you can keep building.",
    };
  }
  if (hash.startsWith("field-assembly-builder/")) {
    return {
      title: "Resume the assembly builder",
      detail: "Your multipart layout and panel selections stay untouched.",
    };
  }
  if (hash.startsWith("field-config-opening/")) {
    return {
      title: "Resume opening configuration",
      detail: "Dimensions, product choices, and pricing inputs stay right where you left them.",
    };
  }
  if (hash.startsWith("field-validate-opening/")) {
    return {
      title: "Resume DP validation",
      detail: "Your validation step and current opening data stay loaded for the return trip.",
    };
  }
  if (hash.startsWith("field-approval/")) {
    return {
      title: "Resume the approval request",
      detail: "The current approval screen stays ready to continue after the replay.",
    };
  }
  if (hash.startsWith("field-proposal/")) {
    return {
      title: "Resume proposal preview",
      detail: "Your proposal preview stays open and ready to continue.",
    };
  }
  return {
    title: "Resume your current field screen",
    detail: "The current field workflow stays in place while the loading animation replays.",
  };
}

function _captureLogoReplayContext() {
  const explicitSurfaces = [
    { node: el("leads-drawer"), title: "Resume the open lead", detail: "The lead drawer, notes, and activity feed stay open underneath the replay." },
    { node: el("quote-modal"), title: "Resume quote review", detail: "Your quote detail modal stays open and ready when the replay ends." },
    { node: el("customer-view-overlay"), title: "Resume customer view", detail: "The customer-facing view stays exactly where it was." },
    { node: el("library-browser-modal"), title: "Resume product library browser", detail: "The library browser stays open so you can keep working right away." },
    { node: el("permissions-modal"), title: "Resume permissions editing", detail: "Your open permissions changes stay parked under the replay." },
    { node: el("password-modal"), title: "Resume password update", detail: "The password form stays open exactly as it is." },
    { node: el("demo-modal-wrap"), title: "Resume the demo request form", detail: "The current marketing form stays filled in underneath the replay." },
    { node: el("video-modal-wrap"), title: "Resume the video view", detail: "The current marketing media screen stays open for the return trip." },
  ];

  for (const surface of explicitSurfaces) {
    if (_isUiSurfaceVisible(surface.node)) return surface;
  }

  if (el("job-hub")?.classList.contains("active")) {
    return {
      title: "Resume the job hub",
      detail: "Your active job conversation and file panel stay right where they are.",
    };
  }

  if (_isUiSurfaceVisible(el("ai-panel-overlay")) || !el("ai-assistant-panel")?.classList.contains("hidden")) {
    return {
      title: "Resume the AI assistant",
      detail: "The AI panel stays open so you can jump right back into the same conversation.",
    };
  }

  const genericModal = qsa(".modal-overlay, .pa-modal-overlay").find((node) => {
    if (node.id === "logo-replay-prompt") return false;
    return _isUiSurfaceVisible(node);
  });
  if (genericModal) {
    return {
      title: "Resume the open workspace window",
      detail: "Your current dialog stays in place and will still be open when the replay ends.",
    };
  }

  if (STATE.mode === "field") {
    return _describeFieldReplayContext(window.location.hash.slice(1) || "field-home");
  }

  return null;
}

function openLogoReplayPrompt(context) {
  el("logo-replay-message") && (el("logo-replay-message").textContent = "We will replay the WindowCalc startup animation for a few seconds and then drop you right back into this workspace.");
  const resume = el("logo-replay-resume");
  if (resume && context) {
    resume.innerHTML = `<strong>Resume:</strong> ${esc(context.title)}<br>${esc(context.detail)}`;
    resume.classList.remove("hidden");
  }
  el("logo-replay-prompt")?.classList.remove("hidden");
}

function cancelLogoReplay() {
  el("logo-replay-prompt")?.classList.add("hidden");
  el("logo-replay-resume")?.classList.add("hidden");
}

function startLogoReplay() {
  cancelLogoReplay();
  clearTimeout(_logoReplayTimer);
  document.body.classList.remove("logo-replay-active");
  void document.body.offsetWidth;
  document.body.classList.add("logo-replay-active");
  _logoReplayTimer = setTimeout(() => {
    document.body.classList.remove("logo-replay-active");
  }, LOGO_REPLAY_DURATION_MS);
}

function confirmLogoReplay() {
  startLogoReplay();
}

function handleLogoReplayTrigger() {
  if (document.body.classList.contains("booting") || document.body.classList.contains("logo-replay-active")) return false;
  const context = _captureLogoReplayContext();
  if (context) {
    openLogoReplayPrompt(context);
  } else {
    startLogoReplay();
  }
  return false;
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && _isUiSurfaceVisible(el("logo-replay-prompt"))) {
    cancelLogoReplay();
  }
});

function setApiStatus(status) {
  const dot   = el("api-status-dot");
  const label = el("api-status-label");
  if (!dot || !label) return;
  dot.className   = `status-dot ${status === "connected" ? "connected" : status === "error" ? "error" : ""}`;
  label.textContent = status.toUpperCase();
}

/* ============================================================
   MODE TOGGLE
   ============================================================ */
function setupModeToggle() {
  qsa(".mode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      switchMode(mode);
    });
  });
}

function switchMode(mode) {
  STATE.mode = mode;
  qsa(".mode-btn").forEach(b => b.classList.toggle("active", b.dataset.mode === mode));
  const adminHub = el("admin-hub");
  const fieldApp = el("field-app");
  if (mode === "admin") {
    adminHub.classList.remove("hidden");
    fieldApp.classList.add("hidden");
    loadAdminDashboard();
    loadApprovalBadge();
  } else {
    adminHub.classList.add("hidden");
    fieldApp.classList.remove("hidden");
    window.location.hash = "field-home";
    handleHashChange();
  }
}

/* ============================================================
   USER SELECTOR
   ============================================================ */
function setupUserSelector() {
  const sel = el("user-selector");
  if (!sel) return;
  sel.addEventListener("change", () => {
    const opt = sel.options[sel.selectedIndex];
    STATE.currentUser = {
      id:   opt.value,
      role: opt.dataset.role,
      name: opt.dataset.name,
      tier: opt.value === "u-rep-003" ? "junior" : (opt.value === "u-rep-002" ? "standard" : "senior"),
    };
    if (STATE.mode === "admin") {
      loadAdminDashboard();
    } else {
      handleHashChange();
    }
  });
}

/* ============================================================
   ADMIN SIDEBAR
   ============================================================ */
function setupAdminSidebar() {
  qsa(".sidebar-item").forEach(item => {
    item.addEventListener("click", () => {
      const tab = item.dataset.tab;
      switchAdminTab(tab);
    });
  });
}

// switchAdminTab is defined later in the file (auth/perm-aware version).

/* ============================================================
   ADMIN: DASHBOARD
   ============================================================ */
function canViewOnboardingChecklist() {
  const role = (STATE.currentUser?.role || "").toLowerCase();
  return role === "owner" || role === "manager";
}

async function refreshOnboardingStatus() {
  if (!canViewOnboardingChecklist()) {
    STATE.onboardingStatus = null;
    return null;
  }
  try {
    const status = await get("/onboarding");
    STATE.onboardingStatus = status || null;
    return STATE.onboardingStatus;
  } catch (_err) {
    STATE.onboardingStatus = null;
    return null;
  }
}

function handleOnboardingStep(stepKey) {
  switch (stepKey) {
    case "catalog_loaded":
      switchMode("admin");
      switchAdminTab("products");
      break;
    case "pricing_points":
    case "governance_reviewed":
      switchMode("admin");
      switchAdminTab("governance");
      break;
    case "users_invited":
      switchMode("admin");
      switchAdminTab("users");
      break;
    case "test_quote":
      if (hasPerm("can_access_field_app")) {
        switchMode("field");
        window.location.hash = "field-new-quote";
        handleHashChange();
      } else {
        switchMode("admin");
        switchAdminTab("dashboard");
        toast("Use the Field App to create your first quote.", "warning");
      }
      break;
    case "company_profile":
    default:
      switchMode("admin");
      switchAdminTab("dashboard");
      toast("Company profile details are handled during company setup. If anything is missing, ask a sysop to update it.", "warning");
      break;
    case "ai_pricing_studio":
      switchMode("admin");
      if (typeof openAIPricingStudio === "function") {
        openAIPricingStudio();
      } else {
        switchAdminTab("products");
        toast("Enable the AI Pricing Studio feature flag first.", "info");
      }
      break;
    case "pricing_intelligence":
      switchMode("admin");
      switchAdminTab("pricing-intelligence");
      break;
  }
}

async function dismissOnboardingBanner() {
  try {
    await post("/onboarding/dismiss", {});
    if (STATE.onboardingStatus) STATE.onboardingStatus.state = "complete";
    renderOnboardingBanner();
    toast("Onboarding checklist dismissed.", "success");
  } catch (err) {
    toast(parseErrorMessage(err, "Unable to dismiss onboarding."), "error");
  }
}

function renderOnboardingBanner() {
  const host = el("dashboard-onboarding-banner");
  if (!host) return;

  const status = STATE.onboardingStatus;
  if (!canViewOnboardingChecklist() || !status || status.state === "complete" || status.all_done) {
    host.innerHTML = "";
    return;
  }

  const completeCount = Number(status.complete_count || 0);
  const totalCount = Number(status.total_count || 0) || 6;
  const percent = Math.max(0, Math.min(100, Math.round((completeCount / totalCount) * 100)));

  host.innerHTML = `
    <div class="onboarding-banner">
      <div class="onboarding-banner-head">
        <div>
          <div class="onboarding-banner-eyebrow">New Company Onboarding</div>
          <div class="onboarding-banner-title">${completeCount} of ${totalCount} steps complete</div>
          <div class="onboarding-banner-sub">Finish the checklist below to get your company fully configured inside WindowCalc.</div>
        </div>
        <button class="btn btn-ghost btn-sm" id="onboarding-dismiss-btn" type="button">Dismiss</button>
      </div>
      <div class="onboarding-progress">
        <div class="onboarding-progress-fill" style="width:${percent}%"></div>
      </div>
      <div class="onboarding-step-list">
        ${(status.steps || []).map((step) => `
          <div class="onboarding-step-item ${step.done ? "done" : "todo"}">
            <div class="onboarding-step-copy">
              <span class="onboarding-step-mark">${step.done ? "OK" : "TODO"}</span>
              <span>${esc(step.label)}</span>
            </div>
            ${step.done
              ? '<span class="onboarding-step-complete">Complete</span>'
              : `<button class="btn btn-ghost btn-sm onboarding-step-action" type="button" data-onboarding-step="${esc(step.key)}">Open</button>`}
          </div>
        `).join("")}
      </div>
    </div>
  `;

  el("onboarding-dismiss-btn")?.addEventListener("click", dismissOnboardingBanner);
  qsa(".onboarding-step-action").forEach((button) => {
    button.addEventListener("click", () => handleOnboardingStep(button.dataset.onboardingStep || ""));
  });
}

async function loadAdminDashboard() {
  // Auth guards — never spin or show "?" when session/tenant is missing
  if (!STATE.currentUser) return;
  if (!STATE.currentTenant) {
    enterNoTenantState();
    return;
  }
  try {
    // Section 1B: hide margin sort options if user can't view margins
    const canViewMargins = hasPerm("can_view_margins");
    document.querySelectorAll(".margin-only-option").forEach(opt => {
      opt.style.display = canViewMargins ? "" : "none";
    });

    const sortBy  = el("dashboard-sort-by")?.value  || "updated_at";
    const sortDir = el("dashboard-sort-dir")?.value || "desc";
    const status  = el("dashboard-filter-status")?.value || "";
    const repId   = el("dashboard-filter-rep")?.value || "";

    let quotesUrl = `/quotes?sort_by=${sortBy}&sort_dir=${sortDir}`;
    if (status) quotesUrl += `&status=${encodeURIComponent(status)}`;
    if (repId)  quotesUrl += `&rep_id=${encodeURIComponent(repId)}`;

    const [stats, quotes, users, onboarding] = await Promise.all([
      get("/stats"),
      get(quotesUrl),
      get("/users"),
      refreshOnboardingStatus(),
    ]);

    if (onboarding) STATE.onboardingStatus = onboarding;
    renderOnboardingBanner();

    animateCounter(el("stat-active-quotes"), stats.active_quotes ?? 0);
    animateCounter(el("stat-pending-approvals"), stats.pending_approvals ?? 0);
    animateCounter(el("stat-avg-margin"), stats.avg_margin ?? 0, '', '%');
    animateCounter(el("stat-total-revenue"), stats.total_revenue ?? 0, '$', '', 1000);
    el("stat-active-quotes-sub").textContent = `${stats.total_quotes ?? 0} total quotes`;
    el("stat-pending-approvals-sub").textContent = "require decision";
    el("stat-avg-margin-sub").textContent    = "gross margin across completed jobs";
    el("stat-total-revenue-sub").textContent = "open pipeline";

    STATE.pendingApprovalCount = stats.pending_approvals ?? 0;
    updateApprovalBadge(STATE.pendingApprovalCount);
    STATE.dashboardQuotes = quotes || [];

    const repFilter = el("dashboard-filter-rep");
    if (repFilter && repFilter.children.length <= 1) {
      (users || []).filter(u => u.role === "rep").forEach(u => {
        const opt = document.createElement("option");
        opt.value = u.id;
        opt.textContent = u.name;
        repFilter.appendChild(opt);
      });
    }

    renderQuoteFeed(STATE.dashboardQuotes);

    // All filter/sort changes re-fetch from server
    const reloadDash = () => loadAdminDashboard();
    el("dashboard-filter-status").onchange = reloadDash;
    el("dashboard-filter-rep").onchange    = reloadDash;
    el("dashboard-sort-by").onchange       = reloadDash;
    el("dashboard-sort-dir").onchange      = reloadDash;
    el("refresh-dashboard").onclick        = loadAdminDashboard;
  } catch (e) {
    handleProtectedLoadFailure(e, "dashboard");
  }
}

function filterQuoteFeed(quotes) {
  // Legacy client-side filter kept for compatibility — dashboard now uses server sort
  const status = el("dashboard-filter-status")?.value || "";
  const repId  = el("dashboard-filter-rep")?.value || "";
  let filtered = [...(quotes || [])];
  if (status) filtered = filtered.filter(q => q.status === status);
  if (repId)  filtered = filtered.filter(q => q.rep_id === repId);
  renderQuoteFeed(filtered);
}

function renderQuoteFeed(quotes) {
  const feed = el("quote-feed");
  if (!quotes.length) {
    feed.innerHTML = `
      <div class="empty-state empty-state-cta">
        <div class="empty-icon">📋</div>
        <div class="empty-state-title">No quotes yet</div>
        <div class="empty-state-sub">Create your first quote to get started.</div>
        <button class="btn btn-primary btn-sm" onclick="switchMode('field');setTimeout(()=>navigateTo('field-new-quote'),100)">
          Create Your First Quote
        </button>
      </div>`;
    return;
  }
  const govData = getRepFloor();
  feed.innerHTML = `
    <div class="feed-header-row">
      <div class="feed-col-label">Customer / Address</div>
      <div class="feed-col-label">Rep</div>
      <div class="feed-col-label">Status</div>
      <div class="feed-col-label">Updated</div>
      <div class="feed-col-label">Gross Margin</div>
      <div class="feed-col-label">Total</div>
      <div class="feed-col-label">Action</div>
    </div>
  ` + quotes.map(q => {
    const mc = marginColor(q.margin_pct, govData.floor, govData.yellow);
    return `
      <div class="quote-feed-row" data-id="${q.id}" onclick="openQuoteModal('${q.id}')">
        <div>
          <div class="qf-customer">${esc(q.customer_name)}</div>
          <div class="qf-address">${esc(q.job_address || "—")}</div>
        </div>
        <div class="qf-rep">${esc(q.rep_name || "—")}</div>
        <div><span class="badge-status ${q.status}">${statusLabel(q.status)}</span></div>
        <div class="qf-time">${timeSince(q.updated_at)}</div>
        <div class="qf-margin">
          <div class="margin-dot ${mc}"></div>
          <span class="${mc}">${fmtPct(q.margin_pct)}</span>
        </div>
        <div class="qf-price">${fmtMoney(q.total_price)}</div>
        <div><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openQuoteModal('${q.id}')">View</button></div>
      </div>`;
  }).join("");
}

/* ============================================================
   ADMIN: QUOTE DETAIL MODAL
   ============================================================ */
async function openQuoteModal(quoteId) {
  const modal = el("quote-modal");
  const body  = el("modal-body");
  modal.classList.remove("hidden");
  body.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading quote…</span></div>`;

  try {
    const quote = await get(`/quotes/${quoteId}`);
    const govData = getRepFloor();
    const mc = marginColor(quote.margin_pct, govData.floor, govData.yellow);

    el("modal-quote-title").textContent = `Quote — ${quote.customer_name}`;

    body.innerHTML = `
      <div class="modal-quote-meta">
        <div class="modal-meta-item">
          <div class="modal-meta-label">Customer</div>
          <div class="modal-meta-value">${esc(quote.customer_name)}</div>
          ${quote.customer_phone ? `<div style="font-size:12px;color:var(--text-muted);margin-top:3px;">${esc(quote.customer_phone)}</div>` : ""}
        </div>
        <div class="modal-meta-item">
          <div class="modal-meta-label">Job Address</div>
          <div class="modal-meta-value" style="font-size:13px;">${esc(quote.job_address || "—")}</div>
          ${(quote.maps_verified || quote.property_verified) ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">
            ${quote.maps_verified ? '<span class="badge-verified maps-verified" title="Address confirmed via Google Maps">📍 Maps Verified</span>' : ''}
            ${quote.property_verified ? '<span class="badge-verified property-verified" title="Property Appraiser data confirmed">✓ PA Verified</span>' : ''}
          </div>` : ''}
        </div>
        <div class="modal-meta-item">
          <div class="modal-meta-label">Rep</div>
          <div class="modal-meta-value">${esc(quote.rep_name || "—")}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:3px;">${esc(quote.rep_tier || "")}</div>
        </div>
        <div class="modal-meta-item">
          <div class="modal-meta-label">Status</div>
          <div class="modal-meta-value" style="margin-top:4px;"><span class="badge-status ${quote.status}">${statusLabel(quote.status)}</span></div>
        </div>
        <div class="modal-meta-item">
          <div class="modal-meta-label">Gross Margin %</div>
          <div class="modal-meta-value mono ${mc}">${fmtPct(quote.margin_pct)}</div>
          <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);margin-top:2px;">$${fmt(quote.margin_dollars)}</div>
          ${hasPerm("can_view_markup") && quote.markup_pct != null ? `<div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);margin-top:1px;">Markup: ${fmt(quote.markup_pct)}%</div>` : ""}
        </div>
        <div class="modal-meta-item">
          <div class="modal-meta-label">Total Price</div>
          <div class="modal-meta-value mono green" style="font-size:20px;">${fmtMoney(quote.total_price)}</div>
        </div>
      </div>
      <div class="modal-openings-title">${(quote.openings || []).length} Openings</div>
      ${(quote.openings || []).map((op, i) => `
        <div class="modal-opening-row">
          <span class="modal-opening-num">#${op.opening_number || i+1}</span>
          <div class="modal-opening-desc">
            <strong>${openingTypeLabel(op.opening_type)}</strong>
            <span style="color:var(--text-muted);"> · ${op.width}"×${op.height}" · ${floorLabel(op.floor_level)} · ${esc(op.product_name || "—")}</span>
            ${op.glass_name ? `<span style="color:var(--text-muted);"> · ${esc(op.glass_name)}</span>` : ""}
            ${op.frame_name ? `<span style="color:var(--text-muted);"> · ${esc(op.frame_name)}</span>` : ""}
          </div>
          <span class="badge-status ${op.noa_status}">${op.noa_status === "passed" ? "NOA ✓" : op.noa_status === "failed" ? "NOA ✗" : "NOA?"}</span>
          <span class="modal-opening-price">${fmtMoney(op.sell_price)}</span>
        </div>
      `).join("")}
      ${(quote.openings || []).length === 0 ? `<div class="empty-state small">No openings added yet.</div>` : ""}
      ${quote.notes ? `<div style="margin-top:16px;padding:12px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;font-size:13px;color:var(--text-secondary);">
        <span style="font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);display:block;margin-bottom:4px;">Notes</span>
        ${esc(quote.notes)}
      </div>` : ""}
      <div style="margin-top:16px;padding:12px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;display:flex;gap:8px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:8px;">Share Proposal</div>
          <div id="share-link-section-${quote.id}">
            <button class="btn btn-ghost btn-sm" onclick="getShareLink('${quote.id}')">🔗 Get Shareable Link</button>
          </div>
        </div>
        ${hasPerm("can_edit_quotes") ? `<button class="btn btn-secondary btn-sm" onclick="showCustomerView('${quote.id}')" style="white-space:nowrap;">👁 Customer View</button>` : ""}
      </div>
    `;
  } catch (e) {
    body.innerHTML = `<div class="empty-state">Failed to load quote details.</div>`;
    toast("Error loading quote.", "error");
  }
}

function setupModalClose() {
  el("modal-close-btn").onclick = () => el("quote-modal").classList.add("hidden");
  el("quote-modal").addEventListener("click", e => {
    if (e.target === el("quote-modal")) el("quote-modal").classList.add("hidden");
  });
}

/* ============================================================
   ADMIN: APPROVAL QUEUE
   ============================================================ */
async function loadApprovalBadge() {
  try {
    const data = await get("/approvals?status=pending");
    updateApprovalBadge((data || []).length);
  } catch {}
  loadLeadsBadge();
  _syncVersionLabel();
}

function _syncVersionLabel() {
  // Keep sidebar version in sync with server APP_VERSION
  fetch("/api/health").then(r => r.json()).then(d => {
    const v = d.app_version || "Alpha 9.4d";
    const lbl = el("sidebar-version-label");
    if (lbl) lbl.textContent = v;
  }).catch(() => {});
}
function updateApprovalBadge(count) {
  const badge = el("approval-badge");
  if (!badge) return;
  badge.textContent = count > 0 ? count : "";
}

async function loadApprovalQueue() {
  el("refresh-approvals").onclick = loadApprovalQueue;
  const pendingWrap = el("approval-queue-pending");
  const historyWrap = el("approval-queue-history");
  pendingWrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading...</span></div>`;
  historyWrap.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;

  try {
    const [pending, all] = await Promise.all([
      get("/approvals?status=pending"),
      get("/approvals"),
    ]);
    const history = (all || []).filter(a => a.status !== "pending");

    if (!(pending || []).length) {
      pendingWrap.innerHTML = `<div class="empty-state"><div class="empty-icon">OK</div>No pending approvals</div>`;
    } else {
      pendingWrap.innerHTML = "";
      pending.forEach(a => pendingWrap.appendChild(buildApprovalCard(a, true)));
    }

    if (!history.length) {
      historyWrap.innerHTML = `<div class="empty-state small">No recent decisions.</div>`;
    } else {
      historyWrap.innerHTML = history.slice(0, 20).map(a => `
        <div class="approval-history-card">
          <div class="approval-history-info">
            <strong>${esc(a.customer_name || "-")}</strong> | ${esc(a.rep_name || "-")}
            <span style="color:var(--text-muted);margin-left:8px;">${timeSince(a.decided_at || a.created_at)}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px;">
            ${a.owner_note ? `<span style="font-size:12px;color:var(--text-muted);font-style:italic;">"${esc(safePreviewText(a.owner_note, 180))}"</span>` : ""}
            <span class="badge-status ${a.status === "approved" ? "approved" : "denied"}">${a.status === "approved" ? "APPROVED" : "DENIED"}</span>
          </div>
        </div>
      `).join("");
    }

    updateApprovalBadge((pending || []).length);
  } catch (e) {
    pendingWrap.innerHTML = `<div class="empty-state">Failed to load approvals.</div>`;
  }
}

function buildApprovalCard(a, isPending) {
  const div = document.createElement("div");
  div.className = "approval-card";
  const repNotePreview = safePreviewText(a.rep_note, 320);
  div.innerHTML = `
    <div class="approval-card-header">
      <div class="approval-info">
        <div class="approval-customer">${esc(a.customer_name || "-")}</div>
        <div class="approval-address">${esc(a.job_address || "-")}</div>
        <div class="approval-rep-row">
          <span class="badge-status draft" style="font-size:10px;">${esc(a.rep_name || "-")}</span>
          <span style="color:var(--text-muted);">|</span>
          <span>${timeSince(a.created_at)}</span>
        </div>
      </div>
      <div class="approval-meta">
        <div class="approval-total">${fmtMoney(a.quote_total)}</div>
        <div class="approval-margin-detail">
          <span>Current: <span class="red mono">${fmtPct(a.current_margin)}</span></span>
          <span>Floor: <span class="mono" style="color:var(--text-muted)">${fmtPct(a.margin_floor)}</span></span>
        </div>
      </div>
    </div>
    <div class="approval-card-body">
      ${repNotePreview ? `<div class="approval-note">"${esc(repNotePreview)}"</div>` : ""}
      ${isPending ? `
        <div class="approval-owner-note-wrap">
          <div class="approval-owner-note-label">Owner Note (optional)</div>
          <textarea class="form-input owner-note-input" placeholder="Add a note..." rows="2" id="owner-note-${a.id}"></textarea>
        </div>
        <div class="approval-actions">
          <button class="btn btn-primary" onclick="decideApproval('${a.id}','approve')">APPROVE</button>
          <button class="btn btn-danger"  onclick="decideApproval('${a.id}','deny')">DENY</button>
        </div>
      ` : ""}
    </div>
  `;
  return div;
}

/* ============================================================
   CONFETTI CELEBRATION
   ============================================================ */
function startHubPolling(quoteId) {
  if (hubPollInterval) {
    clearInterval(hubPollInterval);
    hubPollInterval = null;
  }
  if (!quoteId || document.hidden) return;
  const intervalMs = document.body.classList.contains("mobile-lite") ? 7000 : 4000;
  hubPollInterval = setInterval(() => {
    if (!document.hidden) {
      void loadHubMessages(quoteId);
    }
  }, intervalMs);
}

async function ensureConfetti() {
  if (SHOULD_LIMIT_MOTION) return null;
  if (typeof window.confetti === "function") return window.confetti;
  if (!confettiLoader) {
    confettiLoader = new Promise((resolve) => {
      const script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/canvas-confetti@1.9.3/dist/confetti.browser.min.js";
      script.async = true;
      script.onload = () => resolve(window.confetti || null);
      script.onerror = () => resolve(null);
      document.head.appendChild(script);
    });
  }
  return confettiLoader;
}

async function launchConfetti() {
  const burst = await ensureConfetti();
  if (typeof burst !== "function") return;
  burst({ particleCount: 100, spread: 70, origin: { y: 0.6 }, colors: ["#10b981", "#f59e0b", "#3b82f6", "#ef4444", "#8b5cf6"] });
  setTimeout(() => burst({ particleCount: 50, angle: 60, spread: 55, origin: { x: 0 } }), 180);
  setTimeout(() => burst({ particleCount: 50, angle: 120, spread: 55, origin: { x: 1 } }), 360);
}

async function decideApproval(approvalId, action) {
  const noteEl     = el(`owner-note-${approvalId}`);
  const owner_note = noteEl ? noteEl.value.trim() : "";
  try {
    await put(`/approvals/${approvalId}`, { action, owner_note });
    toast(action === "approve" ? "Approval granted." : "Request denied.", action === "approve" ? "success" : "warning");
    if (action === "approve") void launchConfetti();
    loadApprovalQueue();
    loadApprovalBadge();
  } catch (e) {
    toast("Failed to process decision.", "error");
  }
}

/* ============================================================
   ADMIN: PRODUCTS — FULL CRUD
   ============================================================ */
async function loadProducts() {
  ensureProductSubsections();
  const wrap = el("products-table-wrap");
  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading...</span></div>`;

  // Section 5A: show AI Pricing Studio button for owners/managers with right perms + feature flag
  _syncAIStudioButton();

  try {
    const [products, glass, colors, complexity, consumables, templates, pricePoints] = await Promise.all([
      get("/products"),
      get("/glass-options"),
      get("/frame-colors"),
      get("/complexity-items"),
      get("/consumables").catch(() => []),
      get("/assembly-templates").catch(() => []),
      get("/product-price-points").catch(() => []),
    ]);
    STATE.products         = products    || [];
    STATE.glassOptions     = glass       || [];
    STATE.frameColors      = colors      || [];
    STATE.complexityItems  = complexity  || [];
    STATE.consumables      = consumables || [];
    STATE.assemblyTemplates = templates  || [];
    STATE.productPricePoints = pricePoints || [];

    renderProductsTable(STATE.products);
    renderGlassOptions(STATE.glassOptions);
    renderFrameColors(STATE.frameColors);
    renderComplexityItems(STATE.complexityItems);
    renderConsumables(STATE.consumables);
    renderAssemblyTemplates(STATE.assemblyTemplates);
    setupSubsectionTabs();
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state">Failed to load products.</div>`;
    toast("Error loading products.", "error");
  }
}

const PRODUCT_SIZE_BANDS = [
  { key: "compact", label: "Band A - Compact (up to 12 sq ft)", maxArea: 12 },
  { key: "standard", label: "Band B - Standard (12.1 to 20 sq ft)", maxArea: 20 },
  { key: "large", label: "Band C - Large (20.1 to 30 sq ft)", maxArea: 30 },
  { key: "oversize", label: "Band D - Oversize (30+ sq ft)", maxArea: Number.POSITIVE_INFINITY },
];

function productLineKey(line) {
  return String(line || "").trim().toLowerCase();
}

function productLineSortIndex(line) {
  const key = productLineKey(line);
  if (key === "prestige") return 1;
  if (key === "elite") return 2;
  if (key === "multimax") return 3;
  return 99;
}

function formatLineLabel(line) {
  if (!line) return "Other";
  return String(line)
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function pointAreaSqFt(point) {
  return (_safeNumber(point?.width) * _safeNumber(point?.height)) / 144;
}

function _safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function currentCatalogManufacturers() {
  return Array.from(new Set((STATE.products || [])
    .map((product) => sanitizeUiText(product?.manufacturer || ""))
    .filter(Boolean)));
}

function currentCatalogLabel() {
  const manufacturers = currentCatalogManufacturers();
  if (!manufacturers.length) return "Current Catalog";
  return manufacturers.join(" / ");
}

function getProductSizeBand(point) {
  const area = pointAreaSqFt(point);
  for (const band of PRODUCT_SIZE_BANDS) {
    if (area <= band.maxArea) return band;
  }
  return PRODUCT_SIZE_BANDS[PRODUCT_SIZE_BANDS.length - 1];
}

function renderProductSizeBands(points) {
  const grouped = {};
  PRODUCT_SIZE_BANDS.forEach((band) => {
    grouped[band.key] = { ...band, points: [] };
  });

  (points || []).forEach((point) => {
    const normalized = {
      width: _safeNumber(point?.width),
      height: _safeNumber(point?.height),
      price: _safeNumber(point?.price),
    };
    const band = getProductSizeBand(normalized);
    grouped[band.key].points.push(normalized);
  });

  PRODUCT_SIZE_BANDS.forEach((band) => {
    grouped[band.key].points.sort((a, b) => (a.width - b.width) || (a.height - b.height));
  });

  return PRODUCT_SIZE_BANDS.map((band, idx) => {
    const entries = grouped[band.key].points;
    const countLabel = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
    if (!entries.length) {
      return `
        <details class="product-size-band" ${idx === 0 ? "open" : ""}>
          <summary>
            <span>${esc(band.label)}</span>
            <span class="product-size-band-count">${countLabel}</span>
          </summary>
          <div class="product-size-band-empty">
            No pricing entries yet for this measurement category.
          </div>
        </details>
      `;
    }
    return `
      <details class="product-size-band" ${idx === 0 ? "open" : ""}>
        <summary>
          <span>${esc(band.label)}</span>
          <span class="product-size-band-count">${countLabel}</span>
        </summary>
        <div class="product-size-table-wrap">
          <table class="product-size-table">
            <thead>
              <tr>
                <th>Size (W x H)</th>
                <th>Area</th>
                <th>Price</th>
              </tr>
            </thead>
            <tbody>
              ${entries.map((entry) => `
                <tr>
                  <td class="mono">${fmt(entry.width, 0)} in x ${fmt(entry.height, 0)} in</td>
                  <td>${fmt(pointAreaSqFt(entry), 1)} sq ft</td>
                  <td class="mono">${fmtMoney(entry.price)}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </details>
    `;
  }).join("");
}

function renderProductsTable(products, filterLine, search) {
  const wrap = el("products-table-wrap");
  if (!wrap) return;

  const selectedLine = (filterLine || "all").toLowerCase();
  const query = sanitizeUiText(search || "").toLowerCase();

  const filtered = (products || []).filter((product) => {
    const lineKey = productLineKey(product.product_line || product.series || "other");
    if (selectedLine !== "all" && lineKey !== selectedLine) return false;
    if (!query) return true;
    return (
      String(product.name || "").toLowerCase().includes(query) ||
      String(product.model_number || "").toLowerCase().includes(query) ||
      String(product.type || "").toLowerCase().includes(query) ||
      String(product.manufacturer || "").toLowerCase().includes(query)
    );
  });

  const uniqueLines = Array.from(new Set((products || []).map((product) => productLineKey(product.product_line || product.series || "other"))));
  uniqueLines.sort((a, b) => {
    const byOrder = productLineSortIndex(a) - productLineSortIndex(b);
    if (byOrder !== 0) return byOrder;
    return a.localeCompare(b);
  });

  const lineOptions = uniqueLines.map((lineKey) => `
    <option value="${esc(lineKey)}" ${lineKey === selectedLine ? "selected" : ""}>${esc(formatLineLabel(lineKey))}</option>
  `).join("");

  const pointsByProduct = {};
  (STATE.productPricePoints || []).forEach((point) => {
    if (!point?.product_id) return;
    if (!pointsByProduct[point.product_id]) pointsByProduct[point.product_id] = [];
    pointsByProduct[point.product_id].push(point);
  });

  const groupedByLine = {};
  filtered.forEach((product) => {
    const line = product.product_line || product.series || "Other";
    if (!groupedByLine[line]) groupedByLine[line] = [];
    groupedByLine[line].push(product);
  });

  const lineSections = Object.entries(groupedByLine)
    .sort((a, b) => {
      const byOrder = productLineSortIndex(a[0]) - productLineSortIndex(b[0]);
      if (byOrder !== 0) return byOrder;
      return String(a[0]).localeCompare(String(b[0]));
    })
    .map(([line, items]) => {
      const groupedByType = {};
      items.forEach((product) => {
        const typeLabel = openingTypeLabel(product.type || "other");
        if (!groupedByType[typeLabel]) groupedByType[typeLabel] = [];
        groupedByType[typeLabel].push(product);
      });

      const typeSections = Object.entries(groupedByType)
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([typeLabel, productsInType]) => `
          <div class="product-type-block">
            <div class="product-type-title">${esc(typeLabel)}</div>
            <div class="product-family-grid">
              ${productsInType.map((product) => {
                const pricePoints = pointsByProduct[product.id] || [];
                const maxSize = (product.max_width && product.max_height)
                  ? `${fmt(product.max_width, 0)} in x ${fmt(product.max_height, 0)} in`
                  : "-";
                const leadTime = product.lead_time_weeks ? `${fmt(product.lead_time_weeks, 0)} weeks` : "-";
                const dpLabel = product.dp_positive ? `+${fmt(product.dp_positive, 0)} psf` : "-";
                return `
                  <details class="product-family-card">
                    <summary class="product-family-summary">
                      <div class="product-family-head">
                        <div class="product-family-name">${esc(product.name || "Unnamed Product")}</div>
                        <div class="product-family-model">${esc(product.manufacturer || "Manufacturer n/a")} | Model: ${esc(product.model_number || "n/a")}</div>
                      </div>
                      <div class="product-family-meta">
                        <span class="product-family-badge">${pricePoints.length} pricing points</span>
                        ${lineBadge(product.product_line || product.series)}
                      </div>
                    </summary>
                    <div class="product-family-body">
                      <div class="product-spec-grid">
                        <div class="product-spec"><span>Base Cost</span><strong class="mono">${fmtMoney(product.base_cost)}</strong></div>
                        <div class="product-spec"><span>Size Multiplier</span><strong class="mono">${fmt(_safeNumber(product.size_multiplier_per_sqft), 2)} / sq ft</strong></div>
                        <div class="product-spec"><span>Max Size</span><strong>${esc(maxSize)}</strong></div>
                        <div class="product-spec"><span>DP Rating</span><strong>${esc(dpLabel)}</strong></div>
                        <div class="product-spec"><span>Lead Time</span><strong>${esc(leadTime)}</strong></div>
                      </div>
                      <div class="product-pricing-section">
                        <div class="product-pricing-title">Measurement Categories and Pricing Bands</div>
                        ${renderProductSizeBands(pricePoints)}
                      </div>
                      <div class="product-card-actions">
                        <button class="btn btn-ghost btn-sm" onclick="openProductModal('${product.id}')">Edit Product</button>
                        <button class="btn btn-danger btn-sm" onclick="confirmDeleteProduct('${product.id}','${esc(product.name || "product")}')">Delete</button>
                      </div>
                    </div>
                  </details>
                `;
              }).join("")}
            </div>
          </div>
        `).join("");

      return `
        <details class="product-line-group" open>
          <summary class="product-line-summary">
            <div style="display:flex;align-items:center;gap:8px;">
              ${lineBadge(line)}
              <span>${esc(formatLineLabel(line))}</span>
            </div>
            <span class="product-line-count">${items.length} products</span>
          </summary>
          <div class="product-line-body">
            ${typeSections}
          </div>
        </details>
      `;
    })
    .join("");

  wrap.innerHTML = `
    <div class="product-toolbar">
      <div class="product-toolbar-left">
        <select class="filter-select" id="product-line-filter">
          <option value="all" ${selectedLine === "all" ? "selected" : ""}>All Product Lines</option>
          ${lineOptions}
        </select>
        <input
          type="search"
          class="form-input"
          id="product-search"
          placeholder="Search name or model..."
          value="${esc(search || "")}"
          style="width:220px;height:32px;padding:0 10px;font-size:13px;"
        />
      </div>
      <div class="product-toolbar-actions">
        <button class="btn btn-ghost btn-sm" type="button" onclick="openProductImportModal()">Import CSV</button>
        <button class="btn btn-primary btn-sm" type="button" onclick="openProductModal(null)">+ Add Product</button>
      </div>
    </div>
    ${filtered.length
      ? `<div class="product-catalog">${lineSections}</div>`
      : (STATE.products.length === 0
          ? `<div class="empty-state empty-state-cta">
               <div class="empty-icon">📦</div>
               <div class="empty-state-title">No products in your catalog</div>
               <div class="empty-state-sub">Add your first impact window or door product to start quoting.</div>
               <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;">
                 <button class="btn btn-primary btn-sm" onclick="openProductModal(null)">+ Add Product</button>
                 <button class="btn btn-ghost btn-sm" onclick="openProductImportModal()">Import CSV</button>
               </div>
             </div>`
          : `<div class="empty-state empty-state-cta">
               <div class="empty-icon">🔍</div>
               <div class="empty-state-title">No products match your filter</div>
               <div class="empty-state-sub">Try a different product line or clear the search.</div>
               <button class="btn btn-ghost btn-sm" onclick="renderProductsTable(STATE.products,'all','')">Clear Filter</button>
             </div>`)
    }
  `;
  bindProductTableControls();
}

function bindProductTableControls() {
  const lineFilter = el("product-line-filter");
  const searchBox = el("product-search");
  if (lineFilter) {
    lineFilter.onchange = () => renderProductsTable(STATE.products, lineFilter.value, searchBox?.value || "");
  }
  if (searchBox) {
    searchBox.oninput = () => renderProductsTable(STATE.products, lineFilter?.value || "all", searchBox.value);
  }
}

function productImportPreviewHtml(result) {
  if (!result) {
    return `<div class="product-import-empty">Preview the CSV to validate headers and rows before importing.</div>`;
  }

  const previewRows = result.preview || [];
  const errorRows = result.error_rows || [];
  return `
    <div class="product-import-stats">
      <div class="product-import-stat">
        <span>Valid Rows</span>
        <strong>${Number(result.valid_count || 0)}</strong>
      </div>
      <div class="product-import-stat">
        <span>Issues Found</span>
        <strong>${Number(errorRows.length || 0)}</strong>
      </div>
    </div>
    <div class="product-import-preview-shell">
      <div>
        <div class="product-import-preview-title">Preview</div>
        ${previewRows.length ? `
          <div class="data-table-wrap">
            <table class="product-import-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Model</th>
                  <th>Line</th>
                  <th>Type</th>
                  <th>Base Cost</th>
                </tr>
              </thead>
              <tbody>
                ${previewRows.map((row) => `
                  <tr>
                    <td>${esc(row.name)}</td>
                    <td class="mono">${esc(row.model_number)}</td>
                    <td>${esc(row.product_line)}</td>
                    <td>${esc(openingTypeLabel(row.type))}</td>
                    <td class="mono">${fmtMoney(row.base_cost)}</td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        ` : `<div class="product-import-empty">No valid rows found yet.</div>`}
      </div>
      <div>
        <div class="product-import-preview-title">Validation Notes</div>
        ${errorRows.length ? `
          <div class="product-import-error-list">
            ${errorRows.slice(0, 8).map((row) => `
              <div class="product-import-error-item">
                <strong>Row ${Number(row.row || 0)}</strong>
                <span>${esc(row.error || "Invalid row")}</span>
              </div>
            `).join("")}
            ${errorRows.length > 8 ? `<div class="product-import-empty">${errorRows.length - 8} more issue(s) hidden in preview.</div>` : ""}
          </div>
        ` : `<div class="product-import-empty">No validation issues found in the dry run.</div>`}
      </div>
    </div>
  `;
}

function closeProductImportModal() {
  STATE.productImportPreview = null;
  el("product-import-modal-overlay")?.remove();
}

function openProductImportModal() {
  STATE.productImportPreview = null;
  closeProductImportModal();

  const overlay = document.createElement("div");
  overlay.id = "product-import-modal-overlay";
  overlay.className = "modal-overlay";
  overlay.innerHTML = `
    <div class="modal-panel product-import-modal">
      <div class="modal-header">
        <h2 class="modal-title">Import Product Catalog CSV</h2>
        <button class="modal-close" type="button" onclick="closeProductImportModal()">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
        </button>
      </div>
      <div class="modal-body product-import-body">
        <div class="product-import-note">
          Expected headers: <span class="mono">name, model_number, product_line, manufacturer, type, base_cost, min_width, max_width, min_height, max_height</span>
        </div>
        <div class="form-group">
          <label class="form-label">CSV File</label>
          <input id="product-import-file" class="form-input" type="file" accept=".csv,text/csv" />
        </div>
        <div id="product-import-status" class="product-import-status">Choose a CSV file, then run a dry-run preview.</div>
        <div id="product-import-preview-wrap" class="product-import-preview-wrap">
          ${productImportPreviewHtml(null)}
        </div>
        <div class="product-import-actions">
          <button class="btn btn-ghost" type="button" id="product-import-preview-btn">Preview Import</button>
          <button class="btn btn-primary" type="button" id="product-import-confirm-btn" disabled>Confirm Import</button>
          <button class="btn btn-ghost" type="button" onclick="closeProductImportModal()">Cancel</button>
        </div>
      </div>
    </div>
  `;

  document.body.appendChild(overlay);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) closeProductImportModal();
  });

  el("product-import-file")?.addEventListener("change", () => {
    STATE.productImportPreview = null;
    if (el("product-import-confirm-btn")) el("product-import-confirm-btn").disabled = true;
    if (el("product-import-preview-wrap")) {
      el("product-import-preview-wrap").innerHTML = productImportPreviewHtml(null);
    }
    const file = el("product-import-file")?.files?.[0];
    if (el("product-import-status")) {
      el("product-import-status").textContent = file
        ? `${file.name} selected. Run Preview Import to validate rows.`
        : "Choose a CSV file, then run a dry-run preview.";
    }
  });

  el("product-import-preview-btn")?.addEventListener("click", previewProductImport);
  el("product-import-confirm-btn")?.addEventListener("click", confirmProductImport);
}

async function previewProductImport() {
  const file = el("product-import-file")?.files?.[0];
  if (!file) {
    toast("Choose a CSV file first.", "warning");
    return;
  }

  const previewBtn = el("product-import-preview-btn");
  const confirmBtn = el("product-import-confirm-btn");
  if (previewBtn) {
    previewBtn.disabled = true;
    previewBtn.textContent = "Previewing...";
  }
  if (confirmBtn) confirmBtn.disabled = true;
  if (el("product-import-status")) el("product-import-status").textContent = "Validating CSV rows...";

  try {
    const formData = new FormData();
    formData.append("file", file);
    const result = await apiFetch("/products/import?dry_run=1", { method: "POST", body: formData });
    STATE.productImportPreview = result || null;
    if (el("product-import-preview-wrap")) {
      el("product-import-preview-wrap").innerHTML = productImportPreviewHtml(result);
    }
    if (confirmBtn) confirmBtn.disabled = !(Number(result?.valid_count || 0) > 0);
    if (el("product-import-status")) {
      el("product-import-status").textContent = `Dry run complete. ${Number(result?.valid_count || 0)} valid row(s) ready for import.`;
    }
  } catch (error) {
    STATE.productImportPreview = null;
    if (el("product-import-preview-wrap")) {
      el("product-import-preview-wrap").innerHTML = productImportPreviewHtml(null);
    }
    if (el("product-import-status")) {
      el("product-import-status").textContent = parseErrorMessage(error, "Unable to preview this CSV.");
    }
    toast(parseErrorMessage(error, "Unable to preview this CSV."), "error");
  } finally {
    if (previewBtn) {
      previewBtn.disabled = false;
      previewBtn.textContent = "Preview Import";
    }
  }
}

async function confirmProductImport() {
  const file = el("product-import-file")?.files?.[0];
  if (!file) {
    toast("Choose a CSV file first.", "warning");
    return;
  }
  if (!STATE.productImportPreview || Number(STATE.productImportPreview.valid_count || 0) <= 0) {
    toast("Run Preview Import before confirming.", "warning");
    return;
  }

  const confirmBtn = el("product-import-confirm-btn");
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Importing...";
  }
  if (el("product-import-status")) el("product-import-status").textContent = "Importing valid rows...";

  try {
    const formData = new FormData();
    formData.append("file", file);
    const result = await apiFetch("/products/import", { method: "POST", body: formData });
    toast(`Imported ${Number(result?.imported || 0)} product(s). ${Number(result?.skipped || 0)} skipped.`, "success");
    closeProductImportModal();
    await loadProducts();
  } catch (error) {
    if (el("product-import-status")) {
      el("product-import-status").textContent = parseErrorMessage(error, "Import failed.");
    }
    toast(parseErrorMessage(error, "Import failed."), "error");
  } finally {
    if (confirmBtn) {
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm Import";
    }
  }
}

function confirmDeleteProduct(id, name) {
  if (!confirm(`Delete product "${name}"? This cannot be undone.`)) return;
  del(`/products/${id}`)
    .then(() => {
      toast("Product deleted.", "success");
      loadProducts();
    })
    .catch(() => toast("Failed to delete product.", "error"));
}

/* ---- Product Add/Edit Modal ---- */
function openProductModal(productId) {
  const product = productId ? STATE.products.find(p => p.id === productId) : null;
  const title = product ? `Edit: ${product.name}` : "Add New Product";

  // Create modal overlay
  let overlay = el("product-modal-overlay");
  if (overlay) overlay.remove();
  overlay = document.createElement("div");
  overlay.id = "product-modal-overlay";
  overlay.className = "modal-overlay";
  overlay.style.cssText = "z-index:1100;";
  overlay.innerHTML = `
    <div class="modal-panel" style="max-width:680px;max-height:90vh;overflow-y:auto;">
      <div class="modal-header">
        <h2 class="modal-title">${esc(title)}</h2>
        <button class="modal-close" onclick="closeProductModal()">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
        </button>
      </div>
      <div class="modal-body" style="padding:20px;">
        <div class="form-card">
          <div class="form-card-title">Basic Info</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Model Number</label>
              <input type="text" id="pm-model" class="form-input" value="${esc(product?.model_number || "")}" placeholder="e.g. PRS-36-SH" />
            </div>
            <div class="form-group">
              <label class="form-label">Product Name <span class="required">*</span></label>
              <input type="text" id="pm-name" class="form-input" value="${esc(product?.name || "")}" placeholder="e.g. Prestige Single Hung" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Manufacturer</label>
              <input type="text" id="pm-manufacturer" class="form-input" value="${esc(product?.manufacturer || "ESWindows")}" placeholder="e.g. PGT Windows + Doors" />
            </div>
            <div class="form-group">
              <label class="form-label">Product Line</label>
              <select id="pm-line" class="form-input">
                <option value="Prestige" ${productLineKey(product?.product_line || product?.series || "") === "prestige" ? "selected" : ""}>Prestige</option>
                <option value="Elite" ${productLineKey(product?.product_line || product?.series || "") === "elite" ? "selected" : ""}>Elite</option>
                <option value="Multimax" ${productLineKey(product?.product_line || product?.series || "") === "multimax" ? "selected" : ""}>Multimax</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label">Opening Type</label>
              <select id="pm-type" class="form-input">
                ${[
                  ["single_hung","Single Hung"],["double_hung","Double Hung"],["casement","Casement"],
                  ["sliding_glass_door","Sliding Glass Door"],["fixed","Fixed Picture"],
                  ["entry_door","Entry Door"],["french_door","French Door"],
                  ["horizontal_roller","Horizontal Roller"],["bifold_door","Bifold Door"],
                ].map(([v,l]) => `<option value="${v}" ${product?.type === v ? "selected" : ""}>${l}</option>`).join("")}
              </select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Base Cost ($)</label>
              <input type="number" id="pm-base-cost" class="form-input" value="${product?.base_cost || ""}" min="0" step="0.01" />
            </div>
            <div class="form-group">
              <label class="form-label">Size Multiplier ($/sqft)</label>
              <input type="number" id="pm-size-mult" class="form-input" value="${product?.size_multiplier_per_sqft || ""}" min="0" step="0.01" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Lead Time (weeks)</label>
              <input type="number" id="pm-lead-time" class="form-input" value="${product?.lead_time_weeks || ""}" min="0" max="52" step="1" />
            </div>
            <div class="form-group">
              <label class="form-label">Frame Depth (in)</label>
              <input type="number" id="pm-frame-depth" class="form-input" value="${product?.frame_depth || ""}" min="0" step="0.25" />
            </div>
          </div>
        </div>

        <div class="form-card">
          <div class="form-card-title">Size Limits</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Min Width (in)</label>
              <input type="number" id="pm-min-w" class="form-input" value="${product?.min_width || ""}" />
            </div>
            <div class="form-group">
              <label class="form-label">Max Width (in)</label>
              <input type="number" id="pm-max-w" class="form-input" value="${product?.max_width || ""}" />
            </div>
            <div class="form-group">
              <label class="form-label">Min Height (in)</label>
              <input type="number" id="pm-min-h" class="form-input" value="${product?.min_height || ""}" />
            </div>
            <div class="form-group">
              <label class="form-label">Max Height (in)</label>
              <input type="number" id="pm-max-h" class="form-input" value="${product?.max_height || ""}" />
            </div>
          </div>
        </div>

        <div class="form-card">
          <div class="form-card-title">DP Rating</div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">DP Positive (psf)</label>
              <input type="number" id="pm-dp-pos" class="form-input" value="${product?.dp_positive || ""}" step="5" />
            </div>
            <div class="form-group">
              <label class="form-label">DP Negative (psf)</label>
              <input type="number" id="pm-dp-neg" class="form-input" value="${product?.dp_negative || ""}" step="5" />
            </div>
            <div class="form-group">
              <label class="form-label">Max Sqft for DP</label>
              <input type="number" id="pm-dp-sqft" class="form-input" value="${product?.dp_max_sqft || ""}" step="1" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">Max Story Height</label>
              <input type="number" id="pm-max-story" class="form-input" value="${product?.max_story || ""}" min="1" max="20" />
            </div>
            <div class="form-group">
              <label class="form-label">Missile Rating</label>
              <input type="text" id="pm-missile" class="form-input" value="${esc(product?.missile_rating || "")}" placeholder="e.g. Large Missile" />
            </div>
            <div class="form-group">
              <label class="form-label">NOA Number</label>
              <input type="text" id="pm-noa" class="form-input" value="${esc(product?.noa_number || "")}" />
            </div>
          </div>
          <div class="form-row">
            <div class="form-group" style="align-items:center;display:flex;gap:8px;padding-top:20px;">
              <input type="checkbox" id="pm-hvhz" ${product?.hvhz ? "checked" : ""} style="width:16px;height:16px;" />
              <label class="form-label" for="pm-hvhz" style="margin:0;">HVHZ Certified</label>
            </div>
          </div>
        </div>

        <div id="pm-errors" style="color:var(--red);font-size:13px;padding:0 0 8px;"></div>
        <div style="display:flex;gap:10px;">
          <button class="btn btn-primary" style="flex:1;" onclick="saveProduct('${productId || ""}')">
            ${product ? "Save Changes" : "Add Product"}
          </button>
          <button class="btn btn-ghost" onclick="closeProductModal()">Cancel</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeProductModal(); });
}

function closeProductModal() {
  const overlay = el("product-modal-overlay");
  if (overlay) overlay.remove();
}

async function saveProduct(productId) {
  const nameVal = el("pm-name").value.trim();
  if (!nameVal) { el("pm-errors").textContent = "Product name is required."; return; }

  const body = {
    model_number:           el("pm-model").value.trim(),
    name:                   nameVal,
    manufacturer:           el("pm-manufacturer").value.trim() || "ESWindows",
    product_line:           el("pm-line").value,
    series:                 el("pm-line").value,
    type:                   el("pm-type").value,
    base_cost:              parseFloat(el("pm-base-cost").value) || 0,
    size_multiplier_per_sqft: parseFloat(el("pm-size-mult").value) || 0,
    lead_time_weeks:        parseInt(el("pm-lead-time").value) || null,
    frame_depth:            parseFloat(el("pm-frame-depth").value) || null,
    min_width:              parseFloat(el("pm-min-w").value) || null,
    max_width:              parseFloat(el("pm-max-w").value) || null,
    min_height:             parseFloat(el("pm-min-h").value) || null,
    max_height:             parseFloat(el("pm-max-h").value) || null,
    dp_positive:            parseFloat(el("pm-dp-pos").value) || null,
    dp_negative:            parseFloat(el("pm-dp-neg").value) || null,
    dp_max_sqft:            parseFloat(el("pm-dp-sqft").value) || null,
    max_story:              parseInt(el("pm-max-story").value) || null,
    missile_rating:         el("pm-missile").value.trim(),
    noa_number:             el("pm-noa").value.trim(),
    hvhz:                   el("pm-hvhz").checked,
    tenant_id:              TENANT_ID,
  };

  try {
    if (productId) {
      await put(`/products/${productId}`, body);
      toast("Product updated.", "success");
    } else {
      await post("/products", body);
      toast("Product added.", "success");
    }
    closeProductModal();
    loadProducts();
  } catch (e) {
    el("pm-errors").textContent = "Failed to save product. Please try again.";
  }
}

/* ---- Glass Options ---- */
function renderGlassOptions(glass) {
  const wrap = el("subsection-glass");
  if (!wrap) return;
  wrap.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
      <button class="btn btn-primary btn-sm" onclick="openGlassModal(null)">+ Add Glass Option</button>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Cost Adder</th><th>Actions</th></tr></thead>
      <tbody>${glass.map(g => `<tr>
        <td class="td-primary">${esc(g.name)}</td>
        <td class="mono">${g.cost_adder === 0 ? "Included" : `+${fmtMoney(g.cost_adder)}`}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" onclick="openGlassModal('${g.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="confirmDeleteGlass('${g.id}','${esc(g.name)}')">Del</button>
          </div>
        </td>
      </tr>`).join("")}</tbody>
    </table>`;
}

function openGlassModal(glassId) {
  const glass = glassId ? STATE.glassOptions.find(g => g.id === glassId) : null;
  showSimpleModal(
    glassId ? `Edit Glass Option` : `Add Glass Option`,
    `<div class="form-group"><label class="form-label">Name</label><input type="text" id="gm-name" class="form-input" value="${esc(glass?.name || "")}" /></div>
     <div class="form-group"><label class="form-label">Cost Adder ($)</label><input type="number" id="gm-cost" class="form-input" value="${glass?.cost_adder ?? 0}" step="0.01" /></div>`,
    async () => {
      const body = { name: el("gm-name").value.trim(), cost_adder: parseFloat(el("gm-cost").value) || 0 };
      if (!body.name) { toast("Name required.", "warning"); return; }
      try {
        if (glassId) await put(`/glass-options/${glassId}`, body);
        else await post("/glass-options", body);
        toast(glassId ? "Glass option updated." : "Glass option added.", "success");
        closeSimpleModal();
        const glass2 = await get("/glass-options");
        STATE.glassOptions = glass2 || [];
        renderGlassOptions(STATE.glassOptions);
      } catch { toast("Failed to save.", "error"); }
    }
  );
}

function confirmDeleteGlass(id, name) {
  if (!confirm(`Delete glass option "${name}"?`)) return;
  del(`/glass-options/${id}`)
    .then(async () => {
      toast("Deleted.", "success");
      STATE.glassOptions = await get("/glass-options");
      renderGlassOptions(STATE.glassOptions);
    })
    .catch(() => toast("Failed to delete.", "error"));
}

/* ---- Frame Colors ---- */
function renderFrameColors(colors) {
  const wrap = el("subsection-colors");
  if (!wrap) return;
  wrap.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
      <button class="btn btn-primary btn-sm" onclick="openColorModal(null)">+ Add Frame Color</button>
    </div>
    <table>
      <thead><tr><th>Name</th><th>Cost Adder</th><th>Lead Time Override</th><th>Actions</th></tr></thead>
      <tbody>${colors.map(c => `<tr>
        <td class="td-primary">${esc(c.name)}</td>
        <td class="mono">${c.cost_adder === 0 ? "Included" : `+${fmtMoney(c.cost_adder)}`}</td>
        <td style="font-size:12px;color:var(--text-muted);">${c.lead_time_override_weeks ? `+${c.lead_time_override_weeks} wk` : "—"}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" onclick="openColorModal('${c.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="confirmDeleteColor('${c.id}','${esc(c.name)}')">Del</button>
          </div>
        </td>
      </tr>`).join("")}</tbody>
    </table>`;
}

function openColorModal(colorId) {
  const color = colorId ? STATE.frameColors.find(c => c.id === colorId) : null;
  showSimpleModal(
    colorId ? "Edit Frame Color" : "Add Frame Color",
    `<div class="form-group"><label class="form-label">Name</label><input type="text" id="cm-name" class="form-input" value="${esc(color?.name || "")}" /></div>
     <div class="form-row">
       <div class="form-group"><label class="form-label">Cost Adder ($)</label><input type="number" id="cm-cost" class="form-input" value="${color?.cost_adder ?? 0}" step="0.01" /></div>
       <div class="form-group"><label class="form-label">Lead Time Override (weeks)</label><input type="number" id="cm-lead" class="form-input" value="${color?.lead_time_override_weeks ?? ""}" min="0" /></div>
     </div>`,
    async () => {
      const body = {
        name: el("cm-name").value.trim(),
        cost_adder: parseFloat(el("cm-cost").value) || 0,
        lead_time_override_weeks: parseInt(el("cm-lead").value) || null,
      };
      if (!body.name) { toast("Name required.", "warning"); return; }
      try {
        if (colorId) await put(`/frame-colors/${colorId}`, body);
        else await post("/frame-colors", body);
        toast("Saved.", "success");
        closeSimpleModal();
        const colors2 = await get("/frame-colors");
        STATE.frameColors = colors2 || [];
        renderFrameColors(STATE.frameColors);
      } catch { toast("Failed to save.", "error"); }
    }
  );
}

function confirmDeleteColor(id, name) {
  if (!confirm(`Delete frame color "${name}"?`)) return;
  del(`/frame-colors/${id}`)
    .then(async () => {
      toast("Deleted.", "success");
      STATE.frameColors = await get("/frame-colors");
      renderFrameColors(STATE.frameColors);
    })
    .catch(() => toast("Failed to delete.", "error"));
}

/* ---- Complexity Items ---- */
function renderComplexityItems(items) {
  const wrap = el("subsection-complexity");
  if (!wrap) return;
  wrap.innerHTML = `
    <table>
      <thead><tr><th>Name</th><th>Cost</th></tr></thead>
      <tbody>${items.map(c => `<tr>
        <td class="td-primary">${esc(c.name)}</td>
        <td class="mono">${fmtMoney(c.cost)}</td>
      </tr>`).join("")}</tbody>
    </table>`;
}

/* ---- Consumables ---- */
function renderConsumables(items) {
  const wrap = el("subsection-consumables");
  if (!wrap) return;
  wrap.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
      <button class="btn btn-primary btn-sm" onclick="openConsumableModal(null)">+ Add Consumable</button>
    </div>
    ${items.length === 0 ? `<div class="empty-state small">No consumables configured.</div>` : `
    <table>
      <thead><tr><th>Name</th><th>Unit Cost</th><th>Unit</th><th>Wall Type Filter</th><th>Actions</th></tr></thead>
      <tbody>${items.map(c => `<tr>
        <td class="td-primary">${esc(c.name)}</td>
        <td class="mono">${fmtMoney(c.unit_cost)}</td>
        <td style="font-size:12px;">${esc(c.unit || "per_opening")}</td>
        <td style="font-size:12px;color:var(--text-muted);">${esc(c.wall_type_filter || "All")}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" onclick="openConsumableModal('${c.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="confirmDeleteConsumable('${c.id}','${esc(c.name)}')">Del</button>
          </div>
        </td>
      </tr>`).join("")}</tbody>
    </table>`}`;
}

function openConsumableModal(consumableId) {
  const item = consumableId ? STATE.consumables.find(c => c.id === consumableId) : null;
  showSimpleModal(
    consumableId ? "Edit Consumable" : "Add Consumable",
    `<div class="form-group"><label class="form-label">Name</label><input type="text" id="conm-name" class="form-input" value="${esc(item?.name || "")}" /></div>
     <div class="form-row">
       <div class="form-group"><label class="form-label">Unit Cost ($)</label><input type="number" id="conm-cost" class="form-input" value="${item?.unit_cost ?? ""}" step="0.01" min="0" /></div>
       <div class="form-group"><label class="form-label">Unit</label>
         <select id="conm-unit" class="form-input">
           <option value="per_opening" ${item?.unit === "per_opening" ? "selected" : ""}>Per Opening</option>
           <option value="per_job"     ${item?.unit === "per_job"     ? "selected" : ""}>Per Job</option>
         </select>
       </div>
     </div>
     <div class="form-group"><label class="form-label">Wall Type Filter</label>
       <select id="conm-wall" class="form-input">
         <option value=""         ${!item?.wall_type_filter ? "selected" : ""}>All Wall Types</option>
         <option value="cbs"      ${item?.wall_type_filter === "cbs"      ? "selected" : ""}>CBS</option>
         <option value="frame"    ${item?.wall_type_filter === "frame"    ? "selected" : ""}>Frame</option>
         <option value="concrete" ${item?.wall_type_filter === "concrete" ? "selected" : ""}>Concrete</option>
       </select>
     </div>`,
    async () => {
      const body = {
        name: el("conm-name").value.trim(),
        unit_cost: parseFloat(el("conm-cost").value) || 0,
        unit: el("conm-unit").value,
        wall_type_filter: el("conm-wall").value || null,
      };
      if (!body.name) { toast("Name required.", "warning"); return; }
      try {
        if (consumableId) await put(`/consumables/${consumableId}`, body);
        else await post("/consumables", body);
        toast("Saved.", "success");
        closeSimpleModal();
        STATE.consumables = await get("/consumables").catch(() => []);
        renderConsumables(STATE.consumables);
      } catch { toast("Failed to save.", "error"); }
    }
  );
}

function confirmDeleteConsumable(id, name) {
  if (!confirm(`Delete consumable "${name}"?`)) return;
  del(`/consumables/${id}`)
    .then(async () => {
      toast("Deleted.", "success");
      STATE.consumables = await get("/consumables").catch(() => []);
      renderConsumables(STATE.consumables);
    })
    .catch(() => toast("Failed to delete.", "error"));
}

/* ---- Assembly Templates ---- */
function renderAssemblyTemplates(templates) {
  const wrap = el("subsection-assembly");
  if (!wrap) return;
  wrap.innerHTML = `
    <div style="display:flex;justify-content:flex-end;margin-bottom:10px;">
      <button class="btn btn-primary btn-sm" onclick="openTemplateModal(null)">+ Add Template</button>
    </div>
    ${templates.length === 0 ? `<div class="empty-state small">No assembly templates configured.</div>` : `
    <table>
      <thead><tr><th>Name</th><th>Layout</th><th>Panel Count</th><th>Default Types</th><th>Actions</th></tr></thead>
      <tbody>${templates.map(t => `<tr>
        <td class="td-primary">${esc(t.name)}</td>
        <td style="font-family:var(--font-mono);font-size:12px;">${esc(t.layout_type || "—")}</td>
        <td class="mono">${t.panel_count || "—"}</td>
        <td style="font-size:12px;color:var(--text-muted);">${esc((t.default_types || []).join(", ") || "—")}</td>
        <td>
          <div style="display:flex;gap:6px;">
            <button class="btn btn-ghost btn-sm" onclick="openTemplateModal('${t.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="confirmDeleteTemplate('${t.id}','${esc(t.name)}')">Del</button>
          </div>
        </td>
      </tr>`).join("")}</tbody>
    </table>`}`;
}

function openTemplateModal(templateId) {
  const tmpl = templateId ? STATE.assemblyTemplates.find(t => t.id === templateId) : null;
  const defaultTypesStr = tmpl?.default_types ? tmpl.default_types.join(", ") : "";
  showSimpleModal(
    templateId ? "Edit Assembly Template" : "Add Assembly Template",
    `<div class="form-group"><label class="form-label">Name</label><input type="text" id="tm-name" class="form-input" value="${esc(tmpl?.name || "")}" /></div>
     <div class="form-row">
       <div class="form-group"><label class="form-label">Layout Type</label>
         <select id="tm-layout" class="form-input">
           <option value="2-wide"  ${tmpl?.layout_type === "2-wide"  ? "selected" : ""}>2-Wide</option>
           <option value="3-wide"  ${tmpl?.layout_type === "3-wide"  ? "selected" : ""}>3-Wide</option>
           <option value="2x2"     ${tmpl?.layout_type === "2x2"     ? "selected" : ""}>2×2 Grid</option>
           <option value="custom"  ${tmpl?.layout_type === "custom"  ? "selected" : ""}>Custom</option>
         </select>
       </div>
       <div class="form-group"><label class="form-label">Panel Count</label><input type="number" id="tm-panels" class="form-input" value="${tmpl?.panel_count || 2}" min="2" max="9" /></div>
     </div>
     <div class="form-group"><label class="form-label">Default Types (comma-separated)</label><input type="text" id="tm-types" class="form-input" value="${esc(defaultTypesStr)}" placeholder="e.g. fixed, single_hung, fixed" /></div>`,
    async () => {
      const typesStr = el("tm-types").value;
      const body = {
        name: el("tm-name").value.trim(),
        layout_type: el("tm-layout").value,
        panel_count: parseInt(el("tm-panels").value) || 2,
        default_types: typesStr ? typesStr.split(",").map(s => s.trim()).filter(Boolean) : [],
      };
      if (!body.name) { toast("Name required.", "warning"); return; }
      try {
        if (templateId) await put(`/assembly-templates/${templateId}`, body);
        else await post("/assembly-templates", body);
        toast("Saved.", "success");
        closeSimpleModal();
        STATE.assemblyTemplates = await get("/assembly-templates").catch(() => []);
        renderAssemblyTemplates(STATE.assemblyTemplates);
      } catch { toast("Failed to save.", "error"); }
    }
  );
}

function confirmDeleteTemplate(id, name) {
  if (!confirm(`Delete template "${name}"?`)) return;
  del(`/assembly-templates/${id}`)
    .then(async () => {
      toast("Deleted.", "success");
      STATE.assemblyTemplates = await get("/assembly-templates").catch(() => []);
      renderAssemblyTemplates(STATE.assemblyTemplates);
    })
    .catch(() => toast("Failed to delete.", "error"));
}

/* ---- Simple Reusable Modal ---- */
function showSimpleModal(title, bodyHtml, onSave) {
  let overlay = el("simple-modal-overlay");
  if (overlay) overlay.remove();
  overlay = document.createElement("div");
  overlay.id = "simple-modal-overlay";
  overlay.className = "modal-overlay";
  overlay.style.cssText = "z-index:1200;";
  overlay.innerHTML = `
    <div class="modal-panel" style="max-width:500px;">
      <div class="modal-header">
        <h2 class="modal-title">${esc(title)}</h2>
        <button class="modal-close" onclick="closeSimpleModal()">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
        </button>
      </div>
      <div class="modal-body" style="padding:20px;">
        ${bodyHtml}
        <div style="display:flex;gap:10px;margin-top:16px;">
          <button class="btn btn-primary" style="flex:1;" id="simple-modal-save">Save</button>
          <button class="btn btn-ghost" onclick="closeSimpleModal()">Cancel</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  overlay.addEventListener("click", e => { if (e.target === overlay) closeSimpleModal(); });
  el("simple-modal-save").onclick = onSave;
}

function closeSimpleModal() {
  const overlay = el("simple-modal-overlay");
  if (overlay) overlay.remove();
}

/* ---- Subsection Tabs ---- */
function setupSubsectionTabs() {
  qsa(".subsection-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      qsa(".subsection-tab").forEach(t => t.classList.toggle("active", t === tab));
      qsa(".subsection-content").forEach(c => c.classList.toggle("active", c.id === `subsection-${tab.dataset.subsection}`));
    });
  });
}

function governanceOverrideTypeLabel(type) {
  const labels = {
    margin_floor: "Margin Floor",
    max_discount: "Max Discount",
    yellow_threshold: "Yellow Threshold",
  };
  return labels[type] || humanizeKey(type);
}

function governanceOverrideValueLabel(type, value) {
  const safeValue = _safeNumber(value);
  if (type === "max_discount" || type === "margin_floor" || type === "yellow_threshold") {
    return `${fmt(safeValue, 2)}%`;
  }
  return fmt(safeValue, 2);
}

function governanceOverrideExpiryLabel(value) {
  if (!value) return "Permanent";
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return sanitizeUiText(value);
  return dt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function canEditGovernanceOverrides() {
  const role = (STATE.currentUser?.role || "").toLowerCase();
  return role === "owner" || role === "sysop";
}

function eligibleGovernanceOverrideUsers() {
  return (STATE.users || [])
    .filter((user) => {
      const role = (user.role || "").toLowerCase();
      return role !== "sysop" && role !== "viewer" && Number(user.active ?? 1) !== 0;
    })
    .sort((a, b) => compareTextValues(a.name || a.email || a.id, b.name || b.email || b.id));
}

/* ============================================================
   ADMIN: GOVERNANCE
   ============================================================ */
async function loadGovernance() {
  const wrap = el("governance-content");
  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  el("save-governance").onclick = saveGovernance;

  try {
    const shouldLoadUsers = canEditGovernanceOverrides() || hasPerm("can_manage_users");
    const [gov, floorLabor, territory, globalSettings, overrides, users] = await Promise.all([
      get("/governance"),
      get("/floor-labor"),
      get("/territory-multipliers"),
      get("/global-settings").catch(() => ({})),
      get("/governance/overrides").catch(() => []),
      shouldLoadUsers ? ensureUsersLoaded(false) : Promise.resolve(STATE.users || []),
    ]);
    STATE.governance     = gov || [];
    STATE.globalSettings = normalizeGlobalSettings(globalSettings || {});
    STATE.governanceOverrides = overrides || [];
    if (Array.isArray(users) && users.length) STATE.users = users;
    applyUiVisibility();
    renderGovernance(gov || [], floorLabor || [], territory || [], STATE.globalSettings, STATE.governanceOverrides);
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state">Failed to load settings.</div>`;
    toast("Error loading governance.", "error");
  }
}

function renderGovernance(gov, floorLabor, territory, globalSettings, overrides = []) {
  const wrap = el("governance-content");
  const tiers = [
    { key: "junior", label: "Junior Rep", color: "var(--red)" },
    { key: "standard", label: "Standard Rep", color: "var(--amber)" },
    { key: "senior", label: "Senior Rep", color: "var(--green)" },
  ];
  const gs = globalSettings || {};
  const catalogLabel = currentCatalogLabel();
  const boolVal = (v) => v === true || v === 1 || String(v || "").toLowerCase() === "true" || String(v || "") === "1";
  const hvhzOnlyMode = isHvhzOnlyMode(gs);
  const canEditOverrides = canEditGovernanceOverrides();

  wrap.innerHTML = `
    <div class="gov-grid">
      <div class="gov-card">
        <div class="gov-card-title">Margin Floors by Tier</div>
        ${tiers.map(tier => {
          const g = gov.find(x => x.tier === tier.key) || {};
          return `
            <div class="gov-row">
              <div class="gov-row-label">
                <span style="color:${tier.color}">${tier.label}</span>
                <small>Minimum margin before approval required</small>
              </div>
              <input type="number" class="form-input gov-input" id="gov-floor-${tier.key}"
                value="${g.margin_floor || 30}" min="0" max="100" step="0.5" />
            </div>`;
        }).join("")}
      </div>

      <div class="gov-card">
        <div class="gov-card-title">Thresholds</div>
        ${tiers.map(tier => {
          const g = gov.find(x => x.tier === tier.key) || {};
          return `
            <div class="gov-row">
              <div class="gov-row-label">
                <span style="color:${tier.color}">${tier.label} Yellow Zone</span>
                <small>% above floor to trigger yellow warning</small>
              </div>
              <input type="number" class="form-input gov-input" id="gov-yellow-${tier.key}"
                value="${g.yellow_threshold || 3}" min="0" max="20" step="0.5" />
            </div>
            <div class="gov-row">
              <div class="gov-row-label">
                <span style="color:${tier.color}">${tier.label} Max Discount (%)</span>
                <small>Driveway discount above this requires approval</small>
              </div>
              <input type="number" class="form-input gov-input" id="gov-discount-${tier.key}"
                value="${g.max_discount_pct || 5}" min="0" max="60" step="0.25" />
            </div>`;
        }).join("")}
        <div class="gov-row">
          <div class="gov-row-label">
            <span>DP / NOA Review Policy</span>
            <small>DP and NOA issues are recorded as red flags for later correction and review. They do not block saving quotes or openings.</small>
          </div>
        </div>
      </div>

      <div class="gov-card">
        <div class="gov-card-title">Floor Labor Adders</div>
        ${floorLabor.map(fl => `
          <div class="gov-row">
            <div class="gov-row-label">
              ${floorLabel(fl.floor_level)}
              <small>Per-opening labor adder</small>
            </div>
            <input type="number" class="form-input gov-input" id="gov-labor-${fl.floor_level}"
              data-floor="${fl.floor_level}" data-id="${fl.id}"
              value="${fl.labor_adder || 0}" min="0" step="50" />
          </div>
        `).join("")}
      </div>

      <div class="gov-card">
        <div class="gov-card-title">Territory Multipliers</div>
        ${territory.length ? territory.map(t => `
          <div class="gov-row">
            <div class="gov-row-label">ZIP ${esc(t.zip_code)}</div>
            <input type="number" class="form-input gov-input" id="gov-zip-${t.id}"
              value="${t.multiplier}" min="0.5" max="3.0" step="0.05" />
          </div>
        `).join("") : `<div style="padding:16px;font-size:13px;color:var(--text-muted);">No territory multipliers configured.</div>`}
      </div>

      <div class="gov-card" style="grid-column:span 2;">
        <div class="gov-card-title">Global Settings</div>
        <div class="gov-row">
          <div class="gov-row-label">
            <span>Global Multiplier</span>
            <small>Applied to all product costs across the board (1.00 = no adjustment)</small>
          </div>
          <input type="number" class="form-input gov-input" id="gov-global-multiplier"
            value="${gs.global_multiplier || 1.00}" min="0.5" max="3.0" step="0.01" />
        </div>
        <div class="gov-row">
          <div class="gov-row-label">
            <span>Default Markup</span>
            <small>Default price markup multiplier for all reps</small>
          </div>
          <input type="number" class="form-input gov-input" id="gov-default-markup"
            value="${gs.default_markup || 1.75}" min="1.0" max="5.0" step="0.05" />
        </div>
        <div class="gov-row">
          <div class="gov-row-label">
            <span>Mull Bar Cost ($)</span>
            <small>Cost per mull bar for multipart assemblies</small>
          </div>
          <input type="number" class="form-input gov-input" id="gov-mull-cost"
            value="${gs.mull_bar_cost || 0}" min="0" step="5" />
        </div>
        <div class="gov-row">
          <div class="gov-row-label">
            <span>Reinforcement Cost ($)</span>
            <small>Per-opening reinforcement cost</small>
          </div>
          <input type="number" class="form-input gov-input" id="gov-reinf-cost"
            value="${gs.reinforcement_cost || 0}" min="0" step="5" />
        </div>
        <div class="gov-row">
          <div class="gov-row-label">
            <span>Assembly Labor ($)</span>
            <small>Labor cost for multipart assembly setups</small>
          </div>
          <input type="number" class="form-input gov-input" id="gov-assembly-labor"
            value="${gs.assembly_labor || 0}" min="0" step="25" />
        </div>
        <div class="gov-row">
          <div class="gov-row-label">
            <span>Default Zone</span>
            <small>${hvhzOnlyMode ? "HVHZ-only mode is active. Zone is locked to HVHZ." : "Used by NOA/DP check in the quote flow"}</small>
          </div>
          <select class="form-input gov-input" id="gov-default-zone" ${hvhzOnlyMode ? "disabled" : ""}>
            <option value="HVHZ" ${hvhzOnlyMode || String(gs.default_zone || "HVHZ").toUpperCase() === "HVHZ" ? "selected" : ""}>HVHZ</option>
            ${hvhzOnlyMode ? "" : `<option value="COASTAL" ${String(gs.default_zone || "HVHZ").toUpperCase() === "COASTAL" ? "selected" : ""}>COASTAL</option>
            <option value="INLAND" ${String(gs.default_zone || "HVHZ").toUpperCase() === "INLAND" ? "selected" : ""}>INLAND</option>`}
          </select>
        </div>
        <div class="gov-row gov-toggle-row">
          <label class="gov-toggle-label" for="gov-hide-pricing">Hide Pricing Values</label>
          <input type="checkbox" id="gov-hide-pricing" ${boolVal(gs.ui_hide_pricing) ? "checked" : ""} />
        </div>
        <div class="gov-row gov-toggle-row">
          <label class="gov-toggle-label" for="gov-hide-margin">Hide Margin Values</label>
          <input type="checkbox" id="gov-hide-margin" ${boolVal(gs.ui_hide_margin) ? "checked" : ""} />
        </div>
        <div class="gov-row gov-toggle-row">
          <label class="gov-toggle-label" for="gov-hide-everything">Hide Pricing + Margin Everywhere</label>
          <input type="checkbox" id="gov-hide-everything" ${boolVal(gs.ui_hide_everything) ? "checked" : ""} />
        </div>
      </div>

      <div class="gov-card full-width">
        <div class="gov-card-header-line">
          <div>
            <div class="gov-card-title">Rep Overrides</div>
            <div class="gov-card-subtitle">Temporary per-user exceptions for margin floor, discount ceiling, or yellow warning threshold.</div>
          </div>
          ${canEditOverrides ? `<button class="btn btn-primary btn-sm" type="button" id="gov-add-override-btn">Add Override</button>` : `<span class="badge-soft">View Only</span>`}
        </div>
        ${(overrides || []).length ? `
          <div class="data-table-wrap">
            <table class="gov-override-table">
              <thead>
                <tr>
                  <th>Rep Name</th>
                  <th>Override Type</th>
                  <th>Value</th>
                  <th>Expires</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${(overrides || []).map((override) => `
                  <tr>
                    <td>
                      <div class="td-primary">${esc(override.user_name || override.user_id || "User")}</div>
                      <div class="tenant-directory-id">${esc((override.user_role || "rep").toUpperCase())}</div>
                    </td>
                    <td>${esc(governanceOverrideTypeLabel(override.override_type))}</td>
                    <td class="mono">${esc(governanceOverrideValueLabel(override.override_type, override.override_value))}</td>
                    <td>${esc(governanceOverrideExpiryLabel(override.expires_at))}</td>
                    <td>
                      ${canEditOverrides
                        ? `<button class="btn btn-danger btn-sm" type="button" onclick="revokeGovernanceOverride('${esc(override.id)}')">Revoke</button>`
                        : `<span class="tenant-directory-id">Owner only</span>`}
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        ` : `<div class="gov-empty-state">No active overrides for this company.</div>`}
      </div>

      <div class="gov-card" style="grid-column:span 2;">
        <div class="gov-card-title">${esc(catalogLabel)} Size Pricing Points</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
          Enter CSV rows as width,height,price so all measurements are priced from the database.
        </div>
        <div class="gov-row">
          <div class="gov-row-label">
            <span>Product</span>
            <small>Only products from the current tenant catalog appear here.</small>
          </div>
          <select class="form-input gov-input" id="pp-product-select">
            ${STATE.products.map(p => `<option value="${p.id}">${esc(p.manufacturer || "Catalog")} | ${esc(p.name)} (${esc(p.model_number || "n/a")})</option>`).join("")}
          </select>
        </div>
        <div class="gov-row" style="display:block;">
          <textarea id="pp-csv-input" class="form-input" style="width:100%;min-height:180px;font-family:var(--font-mono);" placeholder="width,height,price&#10;36,60,1042&#10;48,60,1188"></textarea>
          <div id="pp-csv-status" style="margin-top:8px;font-size:12px;color:var(--text-muted);"></div>
        </div>
        <div style="display:flex;justify-content:flex-end;gap:8px;">
          <button class="btn btn-ghost btn-sm" id="pp-load-btn">Load Points</button>
          <button class="btn btn-primary btn-sm" id="pp-save-btn">Save Points</button>
        </div>
      </div>
    </div>
  `;

  el("pp-load-btn")?.addEventListener("click", loadPricePointsForSelectedProduct);
  el("pp-save-btn")?.addEventListener("click", savePricePointsForSelectedProduct);
  el("pp-product-select")?.addEventListener("change", loadPricePointsForSelectedProduct);
  el("gov-add-override-btn")?.addEventListener("click", openGovernanceOverrideModal);
  if (el("pp-product-select") && STATE.products.length) {
    if (!el("pp-product-select").value) el("pp-product-select").value = STATE.products[0].id;
    loadPricePointsForSelectedProduct();
  }
}

function parsePricePointCsv(csvText) {
  const lines = (csvText || "").split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  const rows = [];
  lines.forEach((line, idx) => {
    if (idx === 0 && /width\s*,\s*height\s*,\s*price/i.test(line)) return;
    const parts = line.split(",").map(x => x.trim());
    if (parts.length < 3) return;
    const width = Number(parts[0]);
    const height = Number(parts[1]);
    const price = Number(parts[2]);
    if (!Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(price)) return;
    if (width <= 0 || height <= 0 || price < 0) return;
    rows.push({ width, height, price });
  });
  return rows;
}

function buildPricePointCsv(rows) {
  const ordered = [...(rows || [])].sort((a, b) => (a.width - b.width) || (a.height - b.height));
  return ["width,height,price", ...ordered.map(r => `${r.width},${r.height},${r.price}`)].join("\n");
}

async function loadPricePointsForSelectedProduct() {
  const productId = el("pp-product-select")?.value;
  const statusEl = el("pp-csv-status");
  const textEl = el("pp-csv-input");
  if (!productId) return;
  if (statusEl) statusEl.textContent = "Loading points...";
  try {
    const points = await get(`/product-price-points?product_id=${encodeURIComponent(productId)}`);
    if (textEl) textEl.value = buildPricePointCsv(points || []);
    if (statusEl) statusEl.textContent = `${(points || []).length} point(s) loaded.`;
  } catch (e) {
    if (statusEl) statusEl.textContent = "Failed to load points.";
    toast("Unable to load size pricing points.", "error");
  }
}

async function savePricePointsForSelectedProduct() {
  const productId = el("pp-product-select")?.value;
  const csv = el("pp-csv-input")?.value || "";
  if (!productId) {
    toast("Select a product first.", "warning");
    return;
  }
  const points = parsePricePointCsv(csv);
  if (!points.length) {
    toast("Add at least one valid width,height,price row.", "warning");
    return;
  }
  try {
    await post("/product-price-points", { product_id: productId, points });
    toast(`Saved ${points.length} pricing point(s).`, "success");
    if (el("pp-csv-status")) el("pp-csv-status").textContent = `${points.length} point(s) saved.`;
    await loadPricePointsForSelectedProduct();
  } catch (e) {
    toast("Failed to save size pricing points.", "error");
  }
}

async function saveGovernance() {
  const btn = el("save-governance");
  btn.disabled = true;
  btn.textContent = "Saving...";
  try {
    const tiers = ["junior", "standard", "senior"];
    const updates = tiers.map(tier => ({
      tier,
      margin_floor: parseFloat(el(`gov-floor-${tier}`)?.value || 30),
      yellow_threshold: parseFloat(el(`gov-yellow-${tier}`)?.value || 3),
      max_discount_pct: parseFloat(el(`gov-discount-${tier}`)?.value || 5),
      discount_approval_required: 1,
    }));
    await put("/governance", {
      settings: updates,
    });

    const laborItems = qsa('input[id^="gov-labor-"]').map(input => ({
      id: input.dataset.id,
      labor_adder: parseFloat(input.value || 0),
    })).filter(x => x.id);
    if (laborItems.length) {
      await put("/floor-labor", { items: laborItems }).catch(() => {});
    }

    const globalSettingsBody = {
      global_multiplier: parseFloat(el("gov-global-multiplier")?.value || 1.0),
      default_markup: parseFloat(el("gov-default-markup")?.value || 1.75),
      mull_bar_cost: parseFloat(el("gov-mull-cost")?.value || 0),
      reinforcement_cost: parseFloat(el("gov-reinf-cost")?.value || 0),
      assembly_labor: parseFloat(el("gov-assembly-labor")?.value || 0),
      default_zone: isHvhzOnlyMode() ? "HVHZ" : String(el("gov-default-zone")?.value || "HVHZ").toUpperCase(),
      hvhz_only_mode: isHvhzOnlyMode() ? 1 : 0,
      ui_hide_pricing: el("gov-hide-pricing")?.checked ? 1 : 0,
      ui_hide_margin: el("gov-hide-margin")?.checked ? 1 : 0,
      ui_hide_everything: el("gov-hide-everything")?.checked ? 1 : 0,
    };
    await put("/global-settings", globalSettingsBody).catch(() => {});

    toast("Governance settings saved.", "success");
    await loadGovernance();
  } catch (e) {
    toast("Failed to save governance.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Save Changes";
  }
}

function openGovernanceOverrideModal() {
  const users = eligibleGovernanceOverrideUsers();
  if (!users.length) {
    toast("No eligible users are available for overrides in this company.", "warning");
    return;
  }

  showSimpleModal(
    "Add Rep Override",
    `
      <div class="form-group">
        <label class="form-label">Rep</label>
        <select id="gov-override-user" class="form-input">
          ${users.map((user) => `<option value="${esc(user.id)}">${esc(user.name || user.email || user.id)} | ${esc((user.role || "rep").toUpperCase())}</option>`).join("")}
        </select>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label class="form-label">Override Type</label>
          <select id="gov-override-type" class="form-input">
            <option value="max_discount">Max Discount</option>
            <option value="margin_floor">Margin Floor</option>
            <option value="yellow_threshold">Yellow Threshold</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">Value</label>
          <input id="gov-override-value" class="form-input" type="number" min="0" step="0.25" placeholder="12.5" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Expiry Date (optional)</label>
        <input id="gov-override-expiry" class="form-input" type="date" />
      </div>
    `,
    async () => {
      const userId = el("gov-override-user")?.value || "";
      const overrideType = el("gov-override-type")?.value || "";
      const value = Number(el("gov-override-value")?.value || "");
      const expiresAt = el("gov-override-expiry")?.value || null;

      if (!userId) {
        toast("Choose a rep first.", "warning");
        return;
      }
      if (!Number.isFinite(value) || value < 0) {
        toast("Enter a valid override value.", "warning");
        return;
      }

      try {
        await post("/governance/overrides", {
          user_id: userId,
          override_type: overrideType,
          override_value: value,
          expires_at: expiresAt,
        });
        closeSimpleModal();
        toast("Override added.", "success");
        await loadGovernance();
      } catch (error) {
        toast(parseErrorMessage(error, "Unable to add override."), "error");
      }
    }
  );

  if (el("simple-modal-save")) el("simple-modal-save").textContent = "Create Override";
}

async function revokeGovernanceOverride(overrideId) {
  const current = (STATE.governanceOverrides || []).find((item) => item.id === overrideId);
  const label = current?.user_name || current?.user_id || "this user";
  if (!confirm(`Revoke the active override for ${label}?`)) return;
  try {
    await del(`/governance/overrides/${overrideId}`);
    toast("Override revoked.", "success");
    await loadGovernance();
  } catch (error) {
    toast(parseErrorMessage(error, "Unable to revoke override."), "error");
  }
}

/* ============================================================
   ADMIN: AUDIT LOG
   ============================================================ */
async function loadAuditLog() {
  const wrap = el("audit-log-content");
  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  el("audit-filter-type").onchange = loadAuditLog;

  const filter = el("audit-filter-type").value;
  try {
    const rows = await get(`/audit-log?limit=100${filter ? `&event_type=${filter}` : ""}`);
    if (!(rows || []).length) {
      wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div>No audit events found</div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="audit-table-wrap">
        <table>
          <thead><tr>
            <th>Timestamp</th><th>Event Type</th><th>User</th><th>Entity</th><th>Details</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td class="mono" style="white-space:nowrap;font-size:11px;color:var(--text-muted);">
                ${new Date(r.created_at).toLocaleString()}
              </td>
              <td><span class="event-type-badge event-${r.event_type}">${r.event_type.replace(/_/g," ")}</span></td>
              <td style="font-size:13px;">${esc(r.user_name || "—")}</td>
              <td style="font-size:12px;color:var(--text-muted);">${esc(r.entity_type || "—")} ${esc(r.entity_id ? `#${r.entity_id.slice(-6)}` : "")}</td>
              <td style="font-size:12px;color:var(--text-secondary);">${esc(r.details || "—")}</td>
            </tr>`).join("")}
          </tbody>
        </table>
      </div>
    `;
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state">Failed to load audit log.</div>`;
    toast("Error loading audit log.", "error");
  }
}

/* ============================================================
   ADMIN: REPORTS
   ============================================================ */
function canAccessReports() {
  const role = (STATE.currentUser?.role || "").toLowerCase();
  return ["manager", "owner", "sysop"].includes(role);
}

function reportSectionIds(key) {
  return {
    from: `report-${key}-from`,
    to: `report-${key}-to`,
    rep: `report-${key}-rep`,
  };
}

function buildReportQueryString(key) {
  const ids = reportSectionIds(key);
  const params = new URLSearchParams();
  const from = el(ids.from)?.value || "";
  const to = el(ids.to)?.value || "";
  const repId = el(ids.rep)?.value || "";
  if (from) params.set("from_date", from);
  if (to) params.set("to_date", to);
  if (repId) params.set("rep_id", repId);
  const query = params.toString();
  return query ? `?${query}` : "";
}

function reportLoadingMarkup(label) {
  return `<div class="loading-state"><div class="spinner"></div><span>${esc(label)}</span></div>`;
}

function renderReportStatCards(containerId, cards) {
  const wrap = el(containerId);
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="stats-grid reports-stat-grid">
      ${cards.map((card) => `
        <div class="stat-card">
          <div class="stat-label">${esc(card.label)}</div>
          <div class="stat-value mono ${esc(card.tone || "")}">${esc(card.value)}</div>
          <div class="stat-sub">${esc(card.sub || "")}</div>
        </div>
      `).join("")}
    </div>
  `;
}

function renderReportBreakdown(containerId, rows, columns) {
  const wrap = el(containerId);
  if (!wrap) return;
  if (!(rows || []).length) {
    wrap.innerHTML = `<div class="empty-state small">No rep-level activity for this filter.</div>`;
    return;
  }
  wrap.innerHTML = `
    <div class="report-breakdown-list">
      ${rows.map((row) => `
        <div class="report-breakdown-row">
          <div class="report-breakdown-name">${esc(row.rep_name || row.rep_id || "Unknown Rep")}</div>
          ${columns.map((col) => `
            <div class="report-breakdown-metric">
              <div class="report-breakdown-value">${esc(col.formatter(row[col.key], row))}</div>
              <div class="report-breakdown-label">${esc(col.label)}</div>
            </div>
          `).join("")}
        </div>
      `).join("")}
    </div>
  `;
}

async function ensureUsersLoaded(force = false) {
  if (!force && (STATE.users || []).length) return STATE.users;
  try {
    STATE.users = await get("/users");
  } catch {
    STATE.users = [];
  }
  return STATE.users;
}

async function ensureReportUsers() {
  return ensureUsersLoaded(false);
}

function populateReportRepFilters() {
  const repOptions = (STATE.users || [])
    .filter((user) => (user.role || "").toLowerCase() === "rep")
    .sort((a, b) => compareTextValues(a.name, b.name));

  ["pipeline", "margins", "approvals", "trend"].forEach((key) => {
    const select = el(reportSectionIds(key).rep);
    if (!select) return;
    const current = select.value || "";
    select.innerHTML = `
      <option value="">All Reps</option>
      ${repOptions.map((user) => `<option value="${esc(user.id)}">${esc(user.name || user.email || user.id)}</option>`).join("")}
    `;
    select.value = repOptions.some((user) => user.id === current) ? current : "";
  });
}

function bindReportFilterHandlers() {
  const bindings = {
    pipeline: loadPipelineReport,
    margins: loadMarginsReport,
    approvals: loadApprovalReport,
  };

  Object.entries(bindings).forEach(([key, loader]) => {
    const ids = reportSectionIds(key);
    [ids.from, ids.to, ids.rep].forEach((id) => {
      const node = el(id);
      if (!node) return;
      node.onchange = () => loader();
    });
  });

  // Trend and rep-performance use their own apply buttons (wired inline in HTML)
  // but also bind date change for convenience
  ["report-trend-from","report-trend-to"].forEach(id => {
    const node = el(id); if (node) node.onchange = loadMarginTrendReport;
  });
  ["report-rep-from","report-rep-to"].forEach(id => {
    const node = el(id); if (node) node.onchange = loadRepPerformanceReport;
  });

  if (el("refresh-reports")) {
    el("refresh-reports").onclick = () => loadReportsTab();
  }
}

function destroyReportsMarginChart() {
  if (reportsMarginChart) {
    reportsMarginChart.destroy();
    reportsMarginChart = null;
  }
}

function renderMarginChart(rows) {
  const canvas = el("reports-margin-chart");
  const empty = el("reports-margin-chart-empty");
  if (!canvas || !empty) return;

  destroyReportsMarginChart();

  if (!window.Chart) {
    canvas.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.textContent = "Chart library failed to load for this page.";
    return;
  }

  const dataRows = (rows || []).filter((row) => Number(row.quote_count || 0) > 0);
  if (!dataRows.length) {
    canvas.classList.add("hidden");
    empty.classList.remove("hidden");
    empty.textContent = "No rep margin data yet for this filter.";
    return;
  }

  canvas.classList.remove("hidden");
  empty.classList.add("hidden");
  empty.textContent = "";

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue("--green").trim() || "#10b981";
  const accentSoft = `${accent}cc`;
  const grid = styles.getPropertyValue("--border").trim() || "rgba(100,116,139,0.25)";
  const tick = styles.getPropertyValue("--text-muted").trim() || "#64748b";

  reportsMarginChart = new window.Chart(canvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: dataRows.map((row) => row.rep_name || row.rep_id || "Rep"),
      datasets: [
        {
          label: "Avg Margin %",
          data: dataRows.map((row) => Number(row.avg_margin_pct || 0)),
          backgroundColor: accentSoft,
          borderColor: accent,
          borderWidth: 1,
          borderRadius: 10,
          maxBarThickness: 54,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
      },
      scales: {
        y: {
          beginAtZero: true,
          ticks: {
            color: tick,
            callback: (value) => `${value}%`,
          },
          grid: { color: grid },
        },
        x: {
          ticks: { color: tick },
          grid: { display: false },
        },
      },
    },
  });
}

async function loadPipelineReport() {
  const wrap = el("report-pipeline-summary");
  if (!wrap) return;
  wrap.innerHTML = reportLoadingMarkup("Loading pipeline report...");
  try {
    const data = await get(`/reports/pipeline${buildReportQueryString("pipeline")}`);
    renderReportStatCards("report-pipeline-summary", [
      { label: "Total Quotes", value: fmt(data.total_quotes || 0, 0), sub: "All quotes in period" },
      { label: "Open Pipeline", value: fmtMoney(data.total_pipeline_value || 0), tone: "green", sub: "Combined quote value" },
      // Revenue recognition stages — maps directly to a P&L
      { label: "Draft", value: fmt(data.by_status?.draft?.count || 0, 0),
        sub: `${fmtMoney(data.by_status?.draft?.total_price || 0)} · Unbooked / not yet committed` },
      { label: "Pending Approval", value: fmt(data.by_status?.pending_approval?.count || 0, 0), tone: "amber",
        sub: `${fmtMoney(data.by_status?.pending_approval?.total_price || 0)} · Awaiting authorization` },
      { label: "Approved — Committed", value: fmt(data.by_status?.approved?.count || 0, 0),
        sub: `${fmtMoney(data.by_status?.approved?.total_price || 0)} · Bookable when job starts` },
      { label: "Completed — Earned", value: fmt(data.by_status?.completed?.count || 0, 0), tone: "green",
        sub: `${fmtMoney(data.by_status?.completed?.total_price || 0)} · Invoice-ready revenue` },
      { label: "Denied", value: fmt(data.by_status?.denied?.count || 0, 0),
        sub: `${fmtMoney(data.by_status?.denied?.total_price || 0)} · Lost / no revenue` },
    ]);
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">Failed to load pipeline report.</div>`;
    toast(parseErrorMessage(err, "Failed to load pipeline report."), "error");
  }
}

async function loadMarginsReport() {
  const wrap = el("report-margins-summary");
  if (!wrap) return;
  wrap.innerHTML = reportLoadingMarkup("Loading margin report...");
  try {
    const data = await get(`/reports/margins${buildReportQueryString("margins")}`);
    renderReportStatCards("report-margins-summary", [
      { label: "Avg Gross Margin", value: `${fmt(data.avg_margin_pct || 0)}%`, sub: "Gross margin across filtered quotes" },
      { label: "Completed Revenue", value: fmtMoney(data.completed_revenue || 0), tone: "green", sub: `${fmt(data.completed_count || 0, 0)} completed jobs` },
      { label: "Below Floor", value: fmt(data.below_floor_count || 0, 0), tone: "amber", sub: "Quotes under tier floor" },
      { label: "Reps Tracked", value: fmt((data.by_rep || []).length, 0), sub: "Users with quote activity" },
    ]);
    renderMarginChart(data.by_rep || []);
  } catch (err) {
    destroyReportsMarginChart();
    el("reports-margin-chart")?.classList.add("hidden");
    if (el("reports-margin-chart-empty")) {
      el("reports-margin-chart-empty").classList.remove("hidden");
      el("reports-margin-chart-empty").textContent = "Failed to load margin chart.";
    }
    wrap.innerHTML = `<div class="empty-state">Failed to load margin report.</div>`;
    toast(parseErrorMessage(err, "Failed to load margin report."), "error");
  }
}

async function loadApprovalReport() {
  const wrap = el("report-approvals-summary");
  const breakdown = el("report-approvals-breakdown");
  if (!wrap || !breakdown) return;
  wrap.innerHTML = reportLoadingMarkup("Loading approval report...");
  breakdown.innerHTML = "";
  try {
    const data = await get(`/reports/approvals${buildReportQueryString("approvals")}`);
    renderReportStatCards("report-approvals-summary", [
      { label: "Total Requests", value: fmt(data.total_requests || 0, 0), sub: "Approval requests in period" },
      { label: "Approved", value: fmt(data.approved_count || 0, 0), tone: "green", sub: "Approved by manager or owner" },
      { label: "Denied", value: fmt(data.denied_count || 0, 0), tone: "amber", sub: "Denied requests" },
      { label: "Pending", value: fmt(data.pending_count || 0, 0), sub: "Still awaiting review" },
      { label: "Avg Requested Gross Margin", value: `${fmt(data.avg_margin_requested || 0)}%`, sub: "Target margin at time of request" },
    ]);
    renderReportBreakdown("report-approvals-breakdown", data.by_rep || [], [
      { key: "requests", label: "Requests", formatter: (value) => fmt(value || 0, 0) },
      { key: "approved", label: "Approved", formatter: (value) => fmt(value || 0, 0) },
      { key: "denied", label: "Denied", formatter: (value) => fmt(value || 0, 0) },
    ]);
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">Failed to load approval report.</div>`;
    breakdown.innerHTML = "";
    toast(parseErrorMessage(err, "Failed to load approval report."), "error");
  }
}

async function loadReportsTab() {
  if (!STATE.currentUser) return;
  if (!STATE.currentTenant) {
    enterNoTenantState();
    return;
  }
  if (!canAccessReports()) {
    if (el("report-pipeline-summary")) el("report-pipeline-summary").innerHTML = `<div class="empty-state">No permission to view reports.</div>`;
    if (el("report-margins-summary")) el("report-margins-summary").innerHTML = "";
    if (el("report-approvals-summary")) el("report-approvals-summary").innerHTML = "";
    if (el("report-approvals-breakdown")) el("report-approvals-breakdown").innerHTML = "";
    if (el("report-trend-summary")) el("report-trend-summary").innerHTML = "";
    if (el("report-rep-summary")) el("report-rep-summary").innerHTML = "";
    destroyReportsMarginChart();
    return;
  }

  await ensureReportUsers();
  populateReportRepFilters();
  bindReportFilterHandlers();

  await Promise.all([
    loadPipelineReport(),
    loadMarginsReport(),
    loadApprovalReport(),
    loadMarginTrendReport(),
    loadRepPerformanceReport(),
  ]);
}

/* ============================================================
   HASH ROUTING — FIELD APP
   ============================================================ */

/* ============================================================
   ADMIN: CHAT THREADS
   ============================================================ */
function canUseChatInbox() {
  return hasPerm("can_view_all_quotes") || hasPerm("can_edit_quotes");
}

function renderChatThreadsMarkup(threads, options = {}) {
  const adminMode = options.adminMode !== false;
  return `
    <div class="chat-thread-list">
      ${(threads || []).map((thread) => {
        const openQuoteAction = adminMode
          ? `openQuoteModal('${thread.quote_id}')`
          : `window.location.hash='field-quote/${thread.quote_id}'`;
        return `
          <article class="chat-thread-card">
            <div class="chat-thread-top">
              <div>
                <div class="chat-thread-title">${esc(thread.customer_name || "Untitled Job")}</div>
                <div class="chat-thread-meta">
                  <span>${esc(thread.job_address || "No address")}</span>
                  <span>Rep: ${esc(thread.rep_name || "-")}</span>
                  <span>Status: ${esc(statusLabel(thread.status || "draft"))}</span>
                </div>
              </div>
              <div class="chat-thread-stats">
                <span class="chat-thread-pill">${Number(thread.message_count || 0)} msgs</span>
                <span class="chat-thread-pill">${Number(thread.attachment_count || 0)} media</span>
                <span class="chat-thread-pill">${esc(timeSince(thread.last_message_at))}</span>
              </div>
            </div>
            <div class="chat-thread-preview">${esc(thread.last_message_preview || "No preview available")}</div>
            <div class="chat-thread-footer">
              <div class="chat-thread-meta">
                <span>Last by ${esc(thread.last_message_user_name || "Team")}</span>
                <span>Quote ${esc(thread.quote_id || "")}</span>
              </div>
              <div class="chat-thread-actions">
                <button class="btn btn-ghost btn-sm" onclick="${openQuoteAction}">Open Quote</button>
                <button class="btn btn-primary btn-sm" onclick="openJobHub('${thread.quote_id}')">Open Chat</button>
              </div>
            </div>
          </article>
        `;
      }).join("")}
    </div>`;
}

async function loadChatThreadsTab() {
  const wrap = el("chat-threads-content");
  if (!wrap) return;
  if (!canUseChatInbox()) {
    wrap.innerHTML = `<div class="empty-state">Chat inbox access is not enabled for this account.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading job chats...</span></div>`;

  try {
    const threads = await get("/chat-threads");
    if (!(threads || []).length) {
      wrap.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">CHAT</div>
          No job conversations yet.
        </div>`;
      return;
    }

    wrap.innerHTML = renderChatThreadsMarkup(threads, { adminMode: true });
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">${esc(parseErrorMessage(err, "Failed to load job chats."))}</div>`;
  }
}

async function renderFieldChatInbox(container) {
  container.innerHTML = `<div class="field-screen">
    <div class="section-header">
      <div>
        <h2 class="section-title">Chat Inbox</h2>
        <div class="section-subtitle">Active job conversations you can access right now.</div>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" onclick="window.location.hash='field-home'">Back</button>
    </div>
    <div id="field-chat-list"><div class="loading-state"><div class="spinner"></div><span>Loading job chats...</span></div></div>
  </div>`;

  if (!canUseChatInbox()) {
    el("field-chat-list").innerHTML = `<div class="empty-state">Chat inbox access is not enabled for this account.</div>`;
    return;
  }

  try {
    const threads = await get("/chat-threads");
    el("field-chat-list").innerHTML = (threads || []).length
      ? renderChatThreadsMarkup(threads, { adminMode: false })
      : `<div class="empty-state"><div class="empty-icon">CHAT</div>No active chats on your jobs yet.</div>`;
  } catch (err) {
    el("field-chat-list").innerHTML = `<div class="empty-state">${esc(parseErrorMessage(err, "Failed to load job chats."))}</div>`;
  }
}

function handleHashChange() {
  if (STATE.mode !== "field") return;
  const hash = window.location.hash.slice(1) || "field-home";
  routeFieldApp(hash);
}

function routeFieldApp(hash) {
  const container = el("field-screen-container");
  const ribbon    = el("margin-ribbon");
  closeJobHub();

  if (hash === "field-home" || !hash) {
    ribbon.classList.add("hidden");
    renderFieldHome(container);
  } else if (hash === "field-new-quote") {
    ribbon.classList.add("hidden");
    renderNewQuoteForm(container);
  } else if (hash === "field-chats") {
    ribbon.classList.add("hidden");
    renderFieldChatInbox(container);
  } else if (hash.startsWith("field-quote/")) {
    const qid = hash.split("/")[1];
    renderQuoteDetail(container, qid);
  } else if (hash.startsWith("field-add-opening/")) {
    const qid = hash.split("/")[1];
    const ob = STATE.openingBuilder;
    ob.quoteId        = qid;
    ob.step           = 1;
    ob.openingMode    = "single";
    ob.openingType    = null;
    ob.width          = null;
    ob.height         = null;
    ob.floorLevel     = 1;
    ob.wallType       = "cbs";
    ob.productId      = null;
    ob.glassOptionId  = null;
    ob.frameColorId   = null;
    ob.complexityIds  = [];
    ob.liveCalc       = null;
    ob.drivewayDiscountPct = 0;
    ob.requestedSellPrice = null;
    ob.panels         = [];
    ob.assemblyTemplate = null;
    ob.panelCount     = 2;
    ob.layoutType     = "2-wide";
    ob.currentPanelIndex = 0;
    renderOpeningStep1(container);
  } else if (hash.startsWith("field-assembly-builder/")) {
    renderAssemblyBuilderStep(container);
  } else if (hash.startsWith("field-config-opening/")) {
    renderOpeningStep2(container);
  } else if (hash.startsWith("field-validate-opening/")) {
    renderOpeningStep3(container);
  } else if (hash.startsWith("field-approval/")) {
    const qid = hash.split("/")[1];
    renderApprovalRequest(container, qid);
  } else if (hash.startsWith("field-proposal/")) {
    const qid = hash.split("/")[1];
    renderProposal(container, qid);
  }
}

/* ============================================================
   FIELD: HOME
   ============================================================ */
async function renderFieldHome(container) {
  container.innerHTML = `<div class="field-screen">
    <div class="field-hero">
      <div>
        <div class="field-rep-name" id="field-rep-name">Loading…</div>
        <div class="field-rep-role" id="field-rep-role"></div>
      </div>
      <div class="field-sync-indicator">
        <div class="spinner" style="width:12px;height:12px;border-width:1.5px;"></div>
        <span id="field-sync-text">Syncing…</span>
      </div>
    </div>
    <button class="new-quote-btn" onclick="window.location.hash='field-new-quote'">
      <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z" clip-rule="evenodd"/></svg>
      New Quote
    </button>
    <div class="section-header"><h2 class="section-title">Your Active Quotes</h2></div>
    <div id="field-quote-list"><div class="loading-state"><div class="spinner"></div></div></div>
    <div class="week-summary" id="field-week-summary"></div>
  </div>`;

  el("field-rep-name").textContent = STATE.currentUser.name;
  el("field-rep-role").textContent = `${STATE.currentUser.role.charAt(0).toUpperCase() + STATE.currentUser.role.slice(1)} · ${STATE.currentUser.tier || "standard"} tier`;

  try {
    const quotes  = await get(`/quotes?rep_id=${STATE.currentUser.id}`);
    const active  = (quotes || []).filter(q => q.status !== "completed");
    const week    = (quotes || []).filter(q => {
      const d = new Date(q.updated_at);
      return q.status === "completed" && (Date.now() - d) < 7 * 86400000;
    });

    el("field-sync-text").textContent = "Live";
    qs("#field-app .spinner")?.remove();

    const listEl = el("field-quote-list");
    if (!active.length) {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">📋</div>No active quotes. Tap + New Quote to start.</div>`;
    } else {
      listEl.innerHTML = active.map(q => buildFieldQuoteCard(q)).join("");
      listEl.querySelectorAll(".field-quote-card").forEach(card => {
        card.addEventListener("click", () => {
          window.location.hash = `field-quote/${card.dataset.id}`;
        });
      });
    }
    el("field-week-summary").innerHTML = `Completed this week: <span>${week.length}</span>`;
  } catch (e) {
    el("field-quote-list").innerHTML = `<div class="empty-state">Failed to load quotes.</div>`;
    toast("Error loading quotes.", "error");
  }
}

function buildFieldQuoteCard(q) {
  const govData = getRepFloor();
  const mc = marginColor(q.margin_pct, govData.floor, govData.yellow);
  return `
    <div class="field-quote-card" data-id="${q.id}">
      <div class="fqc-header">
        <div>
          <div class="fqc-customer">${esc(q.customer_name)}</div>
          <div class="fqc-address">${esc(q.job_address || "—")}</div>
        </div>
        <div class="fqc-right">
          <span class="fqc-price">${fmtMoney(q.total_price)}</span>
          <span class="badge-status ${q.status}">${statusLabel(q.status)}</span>
        </div>
      </div>
      <div class="fqc-footer">
        <span class="fqc-openings">${q.opening_count || 0} opening${q.opening_count !== 1 ? "s" : ""}</span>
        <div class="fqc-margin">
          <div class="margin-dot ${mc}"></div>
          <span class="${mc}">${fmtPct(q.margin_pct)}</span>
        </div>
        <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${timeSince(q.updated_at)}</span>
      </div>
    </div>`;
}

/* ============================================================
   FIELD MODE TOGGLE — SUNLIGHT / HIGH-CONTRAST MODE (Alpha 9.4e)
   Applies body.field-mode for outdoor use. Persisted in localStorage.
   ============================================================ */

function toggleFieldMode() {
  const active = document.body.classList.toggle("field-mode");
  try { localStorage.setItem("wc_field_mode", active ? "1" : "0"); } catch (_) {}
  // Update all toggle button icons on the page
  document.querySelectorAll(".field-mode-toggle").forEach(btn => {
    btn.setAttribute("title", active ? "Exit Sunlight Mode" : "Sunlight Mode");
    btn.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function _initFieldMode() {
  try {
    if (localStorage.getItem("wc_field_mode") === "1") {
      document.body.classList.add("field-mode");
    }
  } catch (_) {}
}

// Initialize on load
_initFieldMode();

/* ============================================================
   FIELD: NEW QUOTE FORM
   ============================================================ */

function renderNewQuoteForm(container) {
  container.innerHTML = `
    <div class="field-screen">
      <div class="field-screen-header">
        <button class="back-btn" onclick="window.location.hash='field-home'">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <h2 class="field-screen-title">New Quote</h2>
      </div>

      <div class="form-card">
        <div class="form-card-title">Customer Information</div>
        <div class="form-group">
          <label class="form-label">Customer Name <span class="required">*</span></label>
          <input type="text" id="nq-name" class="form-input" placeholder="Full name" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">Phone <span class="required">*</span></label>
          <input type="tel" id="nq-phone" class="form-input" placeholder="(555) 000-0000" />
        </div>
        <div class="form-group">
          <label class="form-label">Email</label>
          <input type="email" id="nq-email" class="form-input" placeholder="Optional" />
        </div>
      </div>

      <div class="form-card">
        <div class="form-card-title">Job Site</div>
        <div class="form-group" style="position:relative;">
          <label class="form-label">
            Job Address <span class="required">*</span>
            <span id="nq-maps-badge" class="maps-verify-badge hidden">Verified</span>
          </label>
          <input type="text" id="nq-address" class="form-input" placeholder="Start typing address..." autocomplete="off" />
          <div id="nq-autocomplete-list" class="autocomplete-dropdown hidden"></div>
          <div id="nq-maps-bypass" class="maps-bypass-link hidden">
            <a href="#" onclick="bypassMapsVerify(event)">Enter address manually instead</a>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">ZIP Code</label>
            <input type="text" id="nq-zip" class="form-input" placeholder="33301" maxlength="5" />
          </div>
        </div>

        <div class="form-group" style="margin-top:4px;">
          <button class="btn-pa-search" id="nq-pa-btn" type="button" onclick="lookupPropertyAppraiser()" disabled>
            <span class="pa-btn-icon">PA</span>
            <span class="pa-btn-label">
              <span id="nq-pa-btn-text">Search Property Records</span>
              <span class="pa-btn-sub" id="nq-pa-btn-sub">Enter address first</span>
            </span>
          </button>
        </div>
        <div id="nq-pa-preview" class="pa-preview hidden"></div>

        <div class="form-group">
          <label class="form-label">Notes</label>
          <textarea id="nq-notes" class="form-input" placeholder="Any special instructions..."></textarea>
        </div>
      </div>

      <div id="nq-errors" style="color:var(--red);font-size:13px;padding:0 0 12px;"></div>
      <button class="btn btn-primary btn-full btn-lg" id="start-quote-btn">
        Start Adding Openings
      </button>
    </div>

    <div id="pa-modal-overlay" class="pa-modal-overlay hidden" onclick="closePAModal()"></div>
    <div id="pa-modal" class="pa-modal hidden">
      <div class="pa-modal-header">
        <div>
          <div class="pa-modal-title" id="pa-modal-county"></div>
          <div class="pa-modal-folio" id="pa-modal-folio"></div>
        </div>
        <button class="pa-modal-close" type="button" onclick="closePAModal()">x</button>
      </div>
      <div class="pa-modal-body" id="pa-modal-body"></div>
      <div class="pa-modal-footer">
        <div id="pa-name-mismatch-alert" class="pa-mismatch-alert hidden">
          Warning: Property owner name does not match customer name entered
        </div>
        <div class="pa-modal-actions">
          <button class="btn btn-secondary" id="pa-autofill-btn" type="button" onclick="autoFillFromPA()">Auto-fill Name</button>
          <button class="btn btn-primary" type="button" onclick="closePAModal()">Done</button>
        </div>
      </div>
    </div>`;

  el("start-quote-btn").onclick = createNewQuote;

  window._nqPA = {
    mapsVerified: false,
    mapsPlaceId: null,
    mapsFormatted: null,
    paData: null,
    sessionToken: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : Math.random().toString(36),
    acTimer: null,
  };

  _nqInitAutocomplete();
  _nqInitPAWatch();
}

function _nqResetPropertySelection() {
  const btn = el("nq-pa-btn");
  window._nqPA.paData = null;
  if (btn) {
    btn.onclick = lookupPropertyAppraiser;
    btn.classList.remove("pa-btn-confirmed", "pa-btn-notfound", "pa-btn-loading");
  }
  el("nq-pa-preview")?.classList.add("hidden");
}

function _nqInitAutocomplete() {
  const inp = el("nq-address");
  if (!inp) return;
  inp.addEventListener("input", () => {
    const val = inp.value.trim();
    window._nqPA.mapsVerified = false;
    el("nq-maps-badge")?.classList.add("hidden");
    inp.classList.remove("input-verified");
    _nqResetPropertySelection();
    clearTimeout(window._nqPA.acTimer);
    const list = el("nq-autocomplete-list");
    if (val.length < 4) {
      list?.classList.add("hidden");
      _nqUpdatePABtn();
      return;
    }
    window._nqPA.acTimer = setTimeout(async () => {
      try {
        const res = await get(`/maps/autocomplete?input=${encodeURIComponent(val)}&sessiontoken=${window._nqPA.sessionToken}`);
        _nqRenderAC(res.predictions || []);
      } catch (_) {
        el("nq-autocomplete-list")?.classList.add("hidden");
      }
    }, 280);
    _nqUpdatePABtn();
  });
  document.addEventListener("click", (e) => {
    if (!e.target.closest("#nq-address") && !e.target.closest("#nq-autocomplete-list")) {
      el("nq-autocomplete-list")?.classList.add("hidden");
    }
  });
}


function _nqRenderAC(predictions) {
  const list = el("nq-autocomplete-list");
  if (!list) return;
  if (!predictions.length) {
    list.classList.add("hidden");
    return;
  }
  list.innerHTML = predictions.map((p) => {
    const desc = p.description || "";
    const main = esc(p.structured?.main_text || desc);
    const sub = esc(p.structured?.secondary_text || "");
    const safeDesc = JSON.stringify(desc);
    const safePid = JSON.stringify(p.place_id || "");
    return `<div class="autocomplete-item" onclick='_nqSelectAddress(${safeDesc}, ${safePid})'>
      <span class="ac-main">${main}</span>${sub ? `<span class="ac-sub">${sub}</span>` : ""}
    </div>`;
  }).join("");
  list.classList.remove("hidden");
  el("nq-maps-bypass")?.classList.remove("hidden");
}

async function _nqSelectAddress(description, placeId) {
  const inp = el("nq-address");
  if (inp) inp.value = description;
  el("nq-autocomplete-list")?.classList.add("hidden");
  el("nq-maps-bypass")?.classList.add("hidden");
  try {
    const geo = await get(`/maps/geocode?address=${encodeURIComponent(description)}`);
    if (geo.found) {
      window._nqPA.mapsVerified = true;
      window._nqPA.mapsPlaceId = placeId || geo.place_id;
      window._nqPA.mapsFormatted = geo.formatted_address;
      if (geo.zip_code) el("nq-zip").value = geo.zip_code;
      const badge = el("nq-maps-badge");
      if (badge) {
        badge.textContent = "Verified";
        badge.classList.remove("hidden");
      }
      inp?.classList.add("input-verified");
    }
  } catch (_) {
    // Allow manual continuation when Maps verification is unavailable.
  }
  _nqUpdatePABtn();
}

function bypassMapsVerify(e) {
  e.preventDefault();
  window._nqPA.mapsVerified = true;
  const badge = el("nq-maps-badge");
  if (badge) {
    badge.textContent = "Manual";
    badge.classList.remove("hidden");
  }
  el("nq-maps-bypass")?.classList.add("hidden");
  el("nq-autocomplete-list")?.classList.add("hidden");
  _nqUpdatePABtn();
}

function _nqInitPAWatch() {
  el("nq-address")?.addEventListener("input", _nqUpdatePABtn);
  el("nq-zip")?.addEventListener("input", _nqUpdatePABtn);
}

function _nqUpdatePABtn() {
  const addr = el("nq-address")?.value.trim() || "";
  const zip = el("nq-zip")?.value.trim() || "";
  const btn = el("nq-pa-btn");
  const sub = el("nq-pa-btn-sub");
  if (!btn) return;
  if (addr.length > 6) {
    btn.disabled = false;
    btn.classList.add("pa-btn-ready");
    if (sub) sub.textContent = zip ? `ZIP ${zip} | Click to search` : "Click to search county records";
  } else {
    btn.disabled = true;
    btn.classList.remove("pa-btn-ready");
    if (sub) sub.textContent = "Enter address first";
  }
}

async function lookupPropertyAppraiser() {
  const address = el("nq-address")?.value.trim();
  const zip = el("nq-zip")?.value.trim();
  const btn = el("nq-pa-btn");
  const btnText = el("nq-pa-btn-text");
  if (!address || !btn) return;
  btn.disabled = true;
  btn.classList.remove("pa-btn-ready", "pa-btn-confirmed", "pa-btn-notfound");
  btn.classList.add("pa-btn-loading");
  if (btnText) btnText.textContent = "Searching...";
  try {
    const result = await get(`/property/lookup?address=${encodeURIComponent(address)}&zip=${encodeURIComponent(zip || "")}`);
    btn.classList.remove("pa-btn-loading");
    btn.disabled = false;
    btn.onclick = lookupPropertyAppraiser;
    if (!result.found) {
      btn.classList.add("pa-btn-notfound");
      if (btnText) btnText.textContent = "No Record Found";
      const sub = el("nq-pa-btn-sub");
      if (sub) sub.textContent = result.message || "Try a more specific address";
      toast("No property record found - you can continue manually.", "warning");
      return;
    }
    window._nqPA.paData = result;
    btn.classList.add("pa-btn-confirmed");
    if (btnText) btnText.textContent = "Property Found";
    const sub = el("nq-pa-btn-sub");
    if (sub) sub.textContent = `${result.county} County | Folio ${result.folio || "-"} | Tap to view`;
    btn.onclick = openPAModal;
    _nqShowPAPreview(result);
    openPAModal();
  } catch (_err) {
    btn.classList.remove("pa-btn-loading");
    btn.classList.add("pa-btn-notfound");
    btn.disabled = false;
    btn.onclick = lookupPropertyAppraiser;
    if (btnText) btnText.textContent = "Lookup Failed";
    toast("Property lookup failed. Continue manually.", "error");
  }
}

function _nqShowPAPreview(d) {
  const p = el("nq-pa-preview");
  if (!p) return;
  p.classList.remove("hidden");
  const sqft = d.living_sqft ? `${Math.round(d.living_sqft).toLocaleString()} sqft` : "-";
  p.innerHTML = `
    <div class="pa-preview-row"><span class="pa-preview-label">Owner</span><span class="pa-preview-value">${esc(d.owner_name || "-")}</span></div>
    <div class="pa-preview-row"><span class="pa-preview-label">Folio</span><span class="pa-preview-value pa-mono">${esc(d.folio || "-")}</span></div>
    <div class="pa-preview-row"><span class="pa-preview-label">Built / Sqft</span><span class="pa-preview-value">${d.year_built || "?"} | ${sqft}</span></div>`;
}

function openPAModal() {
  const d = window._nqPA?.paData;
  if (!d) return;
  el("pa-modal-county").textContent = `${d.county || "County"} Property Appraiser`;
  el("pa-modal-folio").textContent = d.folio ? `Folio: ${d.folio}` : "";
  const sqft = d.living_sqft ? `${Math.round(d.living_sqft).toLocaleString()} sqft` : "-";
  const body = el("pa-modal-body");
  if (body) {
    body.innerHTML = `
      <div class="pa-detail-grid">
        <div class="pa-detail-item pa-detail-full">
          <div class="pa-detail-label">Registered Owner</div>
          <div class="pa-detail-value">${esc(d.owner_name || "Not found")}</div>
        </div>
        <div class="pa-detail-item">
          <div class="pa-detail-label">Folio Number</div>
          <div class="pa-detail-value pa-mono">${esc(d.folio || "-")}</div>
        </div>
        <div class="pa-detail-item">
          <div class="pa-detail-label">Year Built</div>
          <div class="pa-detail-value">${d.year_built || "-"}</div>
        </div>
        <div class="pa-detail-item">
          <div class="pa-detail-label">Living Area</div>
          <div class="pa-detail-value">${sqft}</div>
        </div>
        <div class="pa-detail-item">
          <div class="pa-detail-label">Bed / Bath</div>
          <div class="pa-detail-value">${d.bedrooms ?? "-"} bd | ${d.bathrooms ?? "-"} ba</div>
        </div>
        <div class="pa-detail-item">
          <div class="pa-detail-label">County</div>
          <div class="pa-detail-value">${esc(d.county || "-")}</div>
        </div>
        <div class="pa-detail-item pa-detail-full">
          <div class="pa-detail-label">Property Address</div>
          <div class="pa-detail-value">${esc([d.address, d.city].filter(Boolean).join(", "))}</div>
        </div>
      </div>`;
  }

  const custName = (el("nq-name")?.value || "").trim().toUpperCase();
  const ownerName = (d.owner_name || "").toUpperCase();
  const mismatch = el("pa-name-mismatch-alert");
  const autofill = el("pa-autofill-btn");
  if (mismatch) {
    const hasBoth = custName && ownerName;
    const diff = hasBoth
      && !ownerName.split(" ").some((word) => word.length > 2 && custName.includes(word))
      && !custName.split(" ").some((word) => word.length > 2 && ownerName.includes(word));
    mismatch.classList.toggle("hidden", !diff);
  }
  if (autofill) autofill.classList.toggle("hidden", !ownerName);
  el("pa-modal")?.classList.remove("hidden");
  el("pa-modal-overlay")?.classList.remove("hidden");
}

function closePAModal() {
  el("pa-modal")?.classList.add("hidden");
  el("pa-modal-overlay")?.classList.add("hidden");
}

function autoFillFromPA() {
  const d = window._nqPA?.paData;
  if (!d?.owner_name) return;
  const inp = el("nq-name");
  if (inp) inp.value = d.owner_name.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  closePAModal();
  toast("Customer name filled from property records", "success");
}

async function createNewQuote() {
  const name = el("nq-name").value.trim();
  const phone = el("nq-phone").value.trim();
  const address = el("nq-address").value.trim();
  const errors = [];
  if (!name) errors.push("Customer name is required.");
  if (!phone) errors.push("Phone number is required.");
  if (!address) errors.push("Job address is required.");
  if (errors.length) {
    el("nq-errors").innerHTML = errors.join("<br>");
    return;
  }
  el("nq-errors").textContent = "";
  const btn = el("start-quote-btn");
  btn.disabled = true;
  btn.textContent = "Creating...";

  const s = window._nqPA || {};
  try {
    const quote = await post("/quotes", {
      rep_id: STATE.currentUser.id,
      customer_name: name,
      customer_phone: phone,
      customer_email: el("nq-email").value.trim(),
      job_address: s.mapsFormatted || address,
      job_zip: el("nq-zip").value.trim(),
      notes: el("nq-notes").value.trim(),
      required_zone: resolveRequiredZone(),
    });
    if (s.paData || s.mapsPlaceId) {
      const pd = s.paData || {};
      try {
        await apiFetch(`/quotes/${quote.id}/property`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            folio_number: pd.folio || null,
            pa_owner_name: pd.owner_name || null,
            pa_year_built: pd.year_built || null,
            pa_living_sqft: pd.living_sqft || null,
            pa_bedrooms: pd.bedrooms || null,
            pa_bathrooms: pd.bathrooms || null,
            pa_data_json: s.paData ? JSON.stringify(s.paData) : null,
            maps_place_id: s.mapsPlaceId || null,
            maps_formatted_address: s.mapsFormatted || null,
          }),
        });
      } catch (_err) {
        // Property enrichment should not block quote creation.
      }
    }
    STATE.currentQuote = quote;
    toast("Quote created!", "success");
    window.location.hash = `field-quote/${quote.id}`;
  } catch (e) {
    const msg = parseErrorMessage(e, "Failed to create quote.");
    el("nq-errors").textContent = msg;
    toast(msg, "error");
    btn.disabled = false;
    btn.textContent = "Start Adding Openings";
  }
}

async function renderQuoteDetail(container, quoteId) {
  container.innerHTML = `<div class="loading-state" style="min-height:50vh;"><div class="spinner"></div></div>`;
  try {
    const quote = await get(`/quotes/${quoteId}`);
    STATE.currentQuote = quote;
    STATE.currentQuoteId = quoteId;
    updateMarginRibbon(quote);
    renderOpeningList(container, quote);
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Failed to load quote.</div>`;
    toast("Error loading quote.", "error");
  }
}

function getHubSelectedChannel() {
  return el("hub-channel-select")?.value || "in_app";
}

function setHubContext(quote) {
  const customerPhone = quote?.customer_phone || "";
  const twilioEnabled = Boolean(STATE.system?.twilio_enabled);
  const smsAvailable = Boolean(customerPhone && twilioEnabled && hasPerm("can_edit_quotes"));
  let smsReason = "";
  if (!customerPhone) smsReason = "Add a customer phone number to enable texting.";
  else if (!twilioEnabled) smsReason = "SMS/MMS is not configured on this deployment.";
  else if (!hasPerm("can_edit_quotes")) smsReason = "This account cannot send customer texts.";

  STATE.hubContext = {
    quoteId: quote?.id || activeHubQuoteId || null,
    customerName: quote?.customer_name || "Customer",
    customerPhone,
    smsAvailable,
    smsReason,
  };
  updateHubComposerMode();
}

function updateHubComposerMode() {
  const select = el("hub-channel-select");
  const hint = el("hub-channel-hint");
  const input = el("hub-input");
  const sendBtn = el("hub-send-btn");
  const meta = el("hub-quote-meta");
  const attachment = el("hub-attachment-input")?.files?.[0] || null;
  const ctx = STATE.hubContext || {};
  if (select) {
    const smsOption = select.querySelector('option[value="sms"]');
    if (smsOption) smsOption.disabled = !ctx.smsAvailable;
    if (select.value === "sms" && !ctx.smsAvailable) select.value = "in_app";
  }

  const mode = getHubSelectedChannel();
  if (input) {
    input.placeholder = mode === "sms"
      ? (ctx.smsAvailable ? `Text ${ctx.customerName || "customer"}...` : "Texting unavailable for this quote")
      : "Add an internal note...";
  }
  if (sendBtn) {
    sendBtn.textContent = mode === "sms"
      ? (attachment ? "Send MMS" : "Send SMS")
      : "Send Note";
  }
  if (hint) {
    hint.textContent = mode === "sms"
      ? (ctx.smsAvailable
        ? "Customer replies will flow back into this Job Hub thread."
        : (ctx.smsReason || "Texting is unavailable for this quote."))
      : "Internal notes stay inside WindowCalc for your team.";
  }
  if (meta) {
    const parts = [];
    if (ctx.customerName) parts.push(ctx.customerName);
    if (ctx.customerPhone) parts.push(ctx.customerPhone);
    parts.push(ctx.smsAvailable ? "SMS/MMS ready" : (ctx.smsReason || "Internal notes only"));
    meta.textContent = parts.filter(Boolean).join(" • ");
  }
}

function handleHubChannelChange() {
  updateHubComposerMode();
  // Section 8B: show templates button when SMS channel is selected
  const channel = el("hub-channel-select")?.value;
  const templatesRow = el("hub-sms-templates-row");
  if (templatesRow) {
    templatesRow.classList.toggle("hidden", channel !== "sms");
  }
  // Hide templates popover on channel switch
  el("templates-popover")?.classList.add("hidden");
}

function closeJobHub() {
  activeHubQuoteId = null;
  const hub = el("job-hub");
  const overlay = el("job-hub-overlay");
  if (hub) hub.classList.remove("active");
  if (overlay) overlay.classList.add("hidden");
  if (hubPollInterval) {
    clearInterval(hubPollInterval);
    hubPollInterval = null;
  }
  const select = el("hub-channel-select");
  if (select) select.value = "in_app";
  STATE.hubContext = { quoteId: null, customerName: "", customerPhone: "", smsAvailable: false, smsReason: "" };
  resetHubComposer();
}

function triggerHubAttachmentPicker() {
  el("hub-attachment-input")?.click();
}

function handleHubAttachmentChange(event) {
  const file = event?.target?.files?.[0];
  const preview = el("hub-attachment-preview");
  if (!preview) return;

  if (hubAttachmentPreviewUrl) {
    URL.revokeObjectURL(hubAttachmentPreviewUrl);
    hubAttachmentPreviewUrl = null;
  }

  if (!file) {
    preview.classList.add("hidden");
    preview.innerHTML = "";
    return;
  }

  const isImage = (file.type || "").startsWith("image/");
  const isVideo = (file.type || "").startsWith("video/");
  if (!isImage && !isVideo) {
    toast("Only image and video attachments are supported.", "warning");
    resetHubComposer(false);
    return;
  }

  hubAttachmentPreviewUrl = URL.createObjectURL(file);
  preview.classList.remove("hidden");
  preview.innerHTML = `
    <div class="hub-attachment-card">
      <div class="hub-attachment-thumb">
        ${isImage
          ? `<img src="${hubAttachmentPreviewUrl}" alt="${esc(file.name)}" />`
          : `<video src="${hubAttachmentPreviewUrl}" muted playsinline preload="metadata"></video>`}
      </div>
      <div class="hub-attachment-copy">
        <div class="hub-attachment-name">${esc(file.name)}</div>
        <div class="hub-attachment-meta">${esc(file.type || (isImage ? "image" : "video"))}${file.size ? ` | ${esc(formatBytes(file.size))}` : ""}</div>
      </div>
      <button class="btn btn-ghost btn-sm" type="button" onclick="resetHubComposer(false)">Remove</button>
    </div>
  `;
  updateHubComposerMode();
}

function resetHubComposer(clearMessage = true) {
  const input = el("hub-input");
  const fileInput = el("hub-attachment-input");
  const preview = el("hub-attachment-preview");
  const sendBtn = el("hub-send-btn");

  if (clearMessage && input) input.value = "";
  if (fileInput) fileInput.value = "";
  if (preview) {
    preview.classList.add("hidden");
    preview.innerHTML = "";
  }
  if (hubAttachmentPreviewUrl) {
    URL.revokeObjectURL(hubAttachmentPreviewUrl);
    hubAttachmentPreviewUrl = null;
  }
  if (sendBtn) {
    sendBtn.disabled = false;
  }
  updateHubComposerMode();
}

function renderHubAttachment(msg) {
  if (!msg?.attachment_url) return "";
  const url = esc(msg.attachment_url);
  const name = esc(msg.attachment_name || "attachment");
  const meta = [msg.attachment_kind ? humanizeKey(msg.attachment_kind) : "", formatBytes(msg.attachment_size)].filter(Boolean).join(" | ");

  if (msg.attachment_kind === "image") {
    return `
      <img class="message-attachment-image" src="${url}" alt="${name}" loading="lazy"
           onclick="openLightbox('${url}')" title="Click to expand" />
      <div class="hub-attachment-caption">${name}${meta ? ` <span>${esc(meta)}</span>` : ""}</div>
    `;
  }

  if (msg.attachment_kind === "video") {
    return `
      <video class="message-attachment-video" controls preload="metadata">
        <source src="${url}" type="${esc(msg.attachment_mime || "video/mp4")}" />
      </video>
      <div class="hub-attachment-caption">${name}${meta ? ` <span>${esc(meta)}</span>` : ""}</div>
    `;
  }

  // Generic file download card
  const ext = (msg.attachment_name || "").split(".").pop().toUpperCase() || "FILE";
  return `
    <a class="message-attachment-file" href="${url}" target="_blank" rel="noopener noreferrer" download>
      <span style="font-size:20px;">📄</span>
      <span>
        <div style="font-weight:600;">${name}</div>
        <div style="font-size:11px;color:var(--text-secondary)">${ext}${meta ? " · " + esc(meta) : ""}</div>
      </span>
    </a>
  `;
}

function renderHubMessageBadges(msg) {
  const badges = [];
  if (msg.delivery_channel === "sms") badges.push({ label: msg.attachment_url ? "MMS" : "SMS", tone: "sms" });
  else badges.push({ label: "Internal", tone: "internal" });
  if (msg.is_customer_message) badges.push({ label: "Customer", tone: "customer" });
  else if (msg.delivery_channel === "sms") badges.push({ label: "Outbound", tone: "outbound" });
  if (msg.delivery_channel === "sms" && msg.external_status) {
    badges.push({ label: humanizeKey(msg.external_status), tone: "status" });
  }
  return badges.map((badge) => `<span class="hub-badge ${badge.tone}">${esc(badge.label)}</span>`).join("");
}

function renderHubMessages(messages) {
  const list = el("hub-messages-list");
  if (!list) return;
  if (!messages.length) {
    list.innerHTML = '<div class="hub-empty">No team notes yet. Start the thread.</div>';
    return;
  }
  list.innerHTML = messages.map((msg) => `
    <div class="chat-bubble ${msg.user_id === STATE.currentUser?.id ? "mine" : ""} ${msg.is_customer_message ? "customer" : ""} ${msg.delivery_channel === "sms" ? "sms" : "internal"}"
         data-msg-id="${esc(msg.id)}" data-quote-id="${esc(msg.quote_id || STATE.currentQuoteId || "")}">
      <div class="hub-message-meta-row">
        <div class="hub-message-meta">${esc(msg.is_customer_message ? (STATE.hubContext?.customerName || msg.user_name || "Customer") : (msg.user_name || "Team"))} - ${new Date(msg.created_at).toLocaleString()}</div>
        <div class="hub-message-badges">${renderHubMessageBadges(msg)}</div>
      </div>
      ${msg.content ? `<div class="hub-message-text">${esc(msg.content || "")}</div>` : ""}
      ${renderHubAttachment(msg)}
      ${msg.external_error ? `<div class="hub-message-error">${esc(msg.external_error)}</div>` : ""}
    </div>
  `).join("");
  list.scrollTop = list.scrollHeight;

  // Section 8A: mark messages read when they enter viewport
  if ("IntersectionObserver" in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        const bubble = entry.target;
        const mid = bubble.dataset.msgId;
        const qid = bubble.dataset.quoteId;
        if (!mid || !qid) return;
        observer.unobserve(bubble);
        apiFetch(`/quotes/${qid}/messages/${mid}/read`, { method: "POST" }).catch(() => {});
      });
    }, { threshold: 0.5 });
    list.querySelectorAll(".chat-bubble[data-msg-id]").forEach(b => observer.observe(b));
  }
}

async function loadHubMessages(quoteId) {
  if (!quoteId) return;
  try {
    const messages = await get(`/quotes/${quoteId}/messages`);
    renderHubMessages(Array.isArray(messages) ? messages : []);
  } catch (e) {
    toast(parseErrorMessage(e, "Failed to load Job Hub messages."), "error");
  }
}

async function openJobHub(quoteId) {
  if (!quoteId) return;
  STATE.currentQuoteId = quoteId;
  activeHubQuoteId = quoteId;
  const hub = el("job-hub");
  const overlay = el("job-hub-overlay");
  if (overlay) overlay.classList.remove("hidden");
  if (hub) hub.classList.add("active");
  resetHubComposer();

  // Section 7B: show AI button when viewing a quote
  const aiBtn = el("hub-ai-btn");
  if (aiBtn) aiBtn.style.display = "";

  // Reset to messages tab
  switchHubTab("messages");

  const quote = (STATE.currentQuote?.id === quoteId)
    ? STATE.currentQuote
    : await get(`/quotes/${quoteId}`).catch(() => null);
  setHubContext(quote || { id: quoteId });
  await loadHubMessages(quoteId);
  loadQuoteFiles(quoteId);
  startHubPolling(quoteId);
}

async function sendHubMessage() {
  const input = el("hub-input");
  const fileInput = el("hub-attachment-input");
  const sendBtn = el("hub-send-btn");
  const content = (input?.value || "").trim();
  const attachment = fileInput?.files?.[0] || null;
  if ((!content && !attachment) || !STATE.currentQuoteId) return;
  const channel = getHubSelectedChannel();
  if (channel === "sms" && !STATE.hubContext?.smsAvailable) {
    toast(STATE.hubContext?.smsReason || "Texting is unavailable for this quote.", "warning");
    return;
  }
  try {
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.textContent = "Sending...";
    }
    const endpoint = channel === "sms"
      ? `/quotes/${STATE.currentQuoteId}/sms-messages`
      : `/quotes/${STATE.currentQuoteId}/messages`;
    if (attachment) {
      const formData = new FormData();
      formData.append("content", content);
      formData.append("attachment", attachment);
      await apiFetch(endpoint, { method: "POST", body: formData });
    } else {
      await post(endpoint, { content });
    }
    resetHubComposer();
    await loadHubMessages(STATE.currentQuoteId);
  } catch (e) {
    toast(parseErrorMessage(e, "Failed to send Job Hub message."), "error");
    await loadHubMessages(STATE.currentQuoteId).catch(() => {});
    if (sendBtn) {
      sendBtn.disabled = false;
      updateHubComposerMode();
    }
  }
}

function updateMarginRibbon(quote) {
  const ribbon = el("margin-ribbon");
  if (!ribbon) return;
  if (!quote || isMarginHidden()) {
    ribbon.classList.add("hidden");
    return;
  }
  const govData = getRepFloor();
  const mc = marginColor(quote.margin_pct, govData.floor, govData.yellow) || "green";
  ribbon.classList.remove("hidden", "green-ribbon", "amber-ribbon", "red-ribbon");
  ribbon.classList.add(`${mc}-ribbon`);
  ribbon.querySelector(".ribbon-margin-pct").textContent = fmtPct(quote.margin_pct);
  ribbon.querySelector(".ribbon-total").textContent = fmtMoney(quote.total_price);
  el("ribbon-customer").textContent = quote.customer_name || "";

  // Tier 4-D: Headroom indicator
  if (window._priceBounds && window._priceBounds.quote_id === quote.id) {
    const floorTotal = window._priceBounds.openings.reduce((s,o) => s + o.floor_sell_price, 0);
    const headroom = quote.total_price - floorTotal;
    const el_h = el("ribbon-headroom");
    if (el_h) {
      el_h.textContent = headroom > 0 ? `$${fmt(headroom)} play left` : "At floor";
      el_h.className = `ribbon-headroom ${headroom <= 0 ? "at-floor" : headroom < 200 ? "low" : "ok"}`;
    }
  }
}

function renderOpeningList(container, quote) {
  const govData  = getRepFloor();
  const mc       = marginColor(quote.margin_pct, govData.floor, govData.yellow);
  const isRed    = mc === "red";
  const openings = quote.openings || [];
  const canRequestApproval = isRed && openings.length > 0;

  container.innerHTML = `
    <div class="field-screen" style="padding-bottom:100px;">
      <div class="field-screen-header">
        <button class="back-btn" onclick="window.location.hash='field-home'">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="field-screen-header-meta">
          <h2 class="field-screen-title">${esc(quote.customer_name)}</h2>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${esc(quote.job_address || "")}</div>
          ${(quote.maps_verified || quote.property_verified) ? `<div style="margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;">
            ${quote.maps_verified ? '<span class="badge-verified maps-verified">📍 Verified</span>' : ''}
            ${quote.property_verified ? '<span class="badge-verified property-verified">✓ PA Data</span>' : ''}
          </div>` : ''}
        </div>
        <button class="btn btn-ghost btn-sm field-hub-btn" type="button" onclick="openJobHub('${quote.id}')">Job Hub</button>
      </div>

      ${openings.length > 0 ? `
        <div class="bulk-price-bar" id="bulk-price-bar-${quote.id}">
          <span class="bulk-label">Adjust all:</span>
          <button class="bulk-btn" onclick="bulkAdjustQuote('${quote.id}', -5)">−5%</button>
          <button class="bulk-btn" onclick="bulkAdjustQuote('${quote.id}', -2)">−2%</button>
          <button class="bulk-btn" onclick="bulkAdjustQuote('${quote.id}', 0)">Reset</button>
          <button class="bulk-btn" onclick="bulkAdjustQuote('${quote.id}', 2)">+2%</button>
          <button class="bulk-btn neutral" onclick="showBulkCustomInput('${quote.id}')">Custom</button>
        </div>
      ` : ''}

      <div id="opening-list">
        ${openings.length === 0 ? `
          <div class="empty-state" style="padding:40px 20px;">
            <div class="empty-icon">🪟</div>
            No openings yet. Tap + to add the first opening.
          </div>` :
          openings.map(op => `
            <div class="opening-card">
              <div class="opening-num">#${op.opening_number}</div>
              <div class="opening-info">
                <div class="opening-type">${openingTypeLabel(op.opening_type)}${op.opening_mode === "multipart" ? ' <span style="font-size:10px;background:rgba(99,102,241,0.2);color:#818cf8;padding:1px 5px;border-radius:3px;margin-left:4px;">ASSEMBLY</span>' : ""}</div>
                <div class="opening-dims">${op.width}" × ${op.height}" · ${floorLabel(op.floor_level)}</div>
                <div class="opening-product">${esc(op.product_name || "—")}${op.glass_name ? ` · ${esc(op.glass_name)}` : ""}${op.frame_name ? ` · ${esc(op.frame_name)}` : ""}</div>
              </div>
              <div class="opening-right">
                <span class="opening-price">${fmtMoney(op.sell_price)}</span>
                <span class="badge-status ${op.noa_status}">${op.noa_status === "passed" ? "DP ✓" : op.noa_status === "failed" ? "DP ✗" : "Pending"}</span>
              </div>
              <button class="opening-delete" onclick="deleteOpening('${op.id}','${quote.id}')" title="Remove opening">✕</button>
              <div class="opening-price-control">
                <div class="price-control-row">
                  <span class="price-control-label">Price</span>
                  <span class="price-control-value" id="opc-val-${op.id}">${fmtMoney(op.sell_price)}</span>
                </div>
                <div class="price-action-buttons" id="opc-actions-${op.id}" data-opening-id="${op.id}" data-quote-id="${quote.id}">
                  <button type="button" class="price-action-btn" id="opc-dec5-${op.id}" onclick="adjustOpeningPricePct('${quote.id}', '${op.id}', -5)">-5%</button>
                  <button type="button" class="price-action-btn" id="opc-dec2-${op.id}" onclick="adjustOpeningPricePct('${quote.id}', '${op.id}', -2)">-2%</button>
                  <button type="button" class="price-action-btn neutral" id="opc-reset-${op.id}" onclick="adjustOpeningPricePct('${quote.id}', '${op.id}', 0)">Reset</button>
                  <button type="button" class="price-action-btn" id="opc-inc2-${op.id}" onclick="adjustOpeningPricePct('${quote.id}', '${op.id}', 2)">+2%</button>
                  <button type="button" class="price-action-btn" id="opc-inc5-${op.id}" onclick="adjustOpeningPricePct('${quote.id}', '${op.id}', 5)">+5%</button>
                </div>
                <div class="price-control-meta" id="opc-meta-${op.id}">Discount -- | Margin --</div>
                <div class="price-control-limits">
                  <span class="price-limit-floor" id="opc-floor-${op.id}">Floor --</span>
                  <span class="price-limit-ceiling" id="opc-ceil-${op.id}">Full --</span>
                </div>
              </div>
            </div>
          `).join("")
        }
      </div>
    </div>

    <!-- FAB -->
    <button class="add-opening-fab" onclick="window.location.hash='field-add-opening/${quote.id}'" title="Add Opening">+</button>

    <!-- Bottom bar -->
    <div class="field-bottom-bar">
      ${canRequestApproval ? `
        <button class="btn btn-danger btn-full" onclick="window.location.hash='field-approval/${quote.id}'">
          ⚠ Request Approval
        </button>
        <button class="btn btn-ghost btn-full locked-btn" disabled>Generate Proposal</button>
      ` : `
        <button class="btn btn-ghost btn-full" onclick="window.location.hash='field-home'">< Back</button>
        <button class="btn btn-secondary btn-full ${openings.length === 0 ? "locked-btn" : ""}"
          id="gen-narrative-btn-${quote.id}"
          ${openings.length === 0 ? "disabled" : ""}
          onclick="generateQuoteNarrative('${quote.id}')">
          ✨ Generate Summary
        </button>
        <button class="btn btn-primary btn-full ${openings.length === 0 ? "locked-btn" : ""}"
          ${openings.length === 0 ? "disabled" : ""}
          onclick="window.location.hash='field-proposal/${quote.id}'">
          Generate Proposal
        </button>
      `}
    </div>
  `;

  // Initialize per-opening price controls after rendering
  if (openings.length > 0) {
    _initPriceControls(quote);
  }
}

async function deleteOpening(openingId, quoteId) {
  if (!confirm("Remove this opening?")) return;
  try {
    await del(`/openings/${openingId}`);
    toast("Opening removed.", "success");
    const quote = await get(`/quotes/${quoteId}`);
    STATE.currentQuote = quote;
    updateMarginRibbon(quote);
    renderOpeningList(el("field-screen-container"), quote);
  } catch (e) {
    toast("Failed to remove opening.", "error");
  }
}

/* ============================================================
   TIER 4-A: PRICE SLIDER — PER-OPENING PRICE CONTROLS
   ============================================================ */

window._priceBounds = null;
window._priceBoundsByOpening = {};
window._priceCommitLocks = {};
window._bulkAdjustLocks = {};

function _clampPrice(value, minSell, maxSell) {
  if (!Number.isFinite(value)) return minSell;
  return Math.max(minSell, Math.min(maxSell, value));
}

function _safePriceFloat(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function _findQuoteOpening(openingId) {
  const quote = STATE.currentQuote || {};
  return (quote.openings || []).find((op) => String(op.id) === String(openingId)) || null;
}

function _normalizeOpeningPriceState(opening, bounds, prevState = null) {
  const fallbackSell = _safePriceFloat(opening?.sell_price, _safePriceFloat(prevState?.currentSell, 0));
  let minSell = _safePriceFloat(bounds?.min_sell_price, _safePriceFloat(prevState?.minSell, fallbackSell));
  let baselineSell = _safePriceFloat(
    bounds?.baseline_sell_price,
    _safePriceFloat(opening?.baseline_sell_price, _safePriceFloat(prevState?.baselineSell, fallbackSell))
  );
  let floorSell = _safePriceFloat(bounds?.floor_sell_price, _safePriceFloat(prevState?.floorSell, minSell));

  if (baselineSell < minSell) baselineSell = minSell;
  if (floorSell < minSell) floorSell = minSell;

  const currentSell = _clampPrice(
    _safePriceFloat(opening?.sell_price, _safePriceFloat(prevState?.currentSell, baselineSell)),
    minSell,
    baselineSell
  );

  return {
    openingId: String(opening?.id || prevState?.openingId || ""),
    minSell,
    baselineSell,
    floorSell,
    totalCost: _safePriceFloat(opening?.total_cost, _safePriceFloat(prevState?.totalCost, 0)),
    currentSell,
    saving: false,
  };
}

function _syncOpeningPriceControlDisplay(state) {
  if (!state || !state.openingId) return;
  const openingId = state.openingId;
  const currentSell = _clampPrice(state.currentSell, state.minSell, state.baselineSell);
  state.currentSell = currentSell;

  const valueEl = el(`opc-val-${openingId}`);
  if (valueEl) valueEl.textContent = fmtMoney(currentSell);

  const discountPct = state.baselineSell > 0 ? Math.max(0, (1 - currentSell / state.baselineSell) * 100) : 0;
  const marginPct = currentSell > 0 ? ((currentSell - state.totalCost) / currentSell) * 100 : 0;
  const govData = getRepFloor();
  const marginCls = marginColor(marginPct, govData.floor, govData.yellow);
  const isLocked = (state.baselineSell - state.minSell) <= 0.009;

  const metaEl = el(`opc-meta-${openingId}`);
  if (metaEl) {
    metaEl.className = `price-control-meta ${marginCls || ""}`.trim();
    metaEl.textContent = `Discount ${fmt(discountPct, 2)}% | Margin ${fmt(marginPct, 1)}%${isLocked ? " | At floor" : ""}`;
  }

  const floorEl = el(`opc-floor-${openingId}`);
  if (floorEl) floorEl.textContent = `Floor ${fmtMoney(state.floorSell)}`;

  const ceilEl = el(`opc-ceil-${openingId}`);
  if (ceilEl) ceilEl.textContent = `Full ${fmtMoney(state.baselineSell)}`;

  const atMin = currentSell <= (state.minSell + 0.009);
  const atMax = currentSell >= (state.baselineSell - 0.009);
  const atBaseline = Math.abs(currentSell - state.baselineSell) <= 0.009;
  const isSaving = Boolean(state.saving);

  const dec5 = el(`opc-dec5-${openingId}`);
  const dec2 = el(`opc-dec2-${openingId}`);
  const reset = el(`opc-reset-${openingId}`);
  const inc2 = el(`opc-inc2-${openingId}`);
  const inc5 = el(`opc-inc5-${openingId}`);

  if (dec5) dec5.disabled = isSaving || isLocked || atMin;
  if (dec2) dec2.disabled = isSaving || isLocked || atMin;
  if (reset) reset.disabled = isSaving || isLocked || atBaseline;
  if (inc2) inc2.disabled = isSaving || isLocked || atMax;
  if (inc5) inc5.disabled = isSaving || isLocked || atMax;

  const actionsEl = el(`opc-actions-${openingId}`);
  if (actionsEl) actionsEl.classList.toggle("saving", isSaving);
}

async function _initPriceControls(quote) {
  if (!quote || !quote.id) return;
  const openings = quote.openings || [];
  if (openings.length === 0) {
    window._priceBoundsByOpening = {};
    return;
  }

  const prevStates = window._priceBoundsByOpening || {};
  try {
    const bounds = await get(`/quotes/${quote.id}/price-bounds`);
    window._priceBounds = bounds;
    const boundsByOpening = {};
    for (const row of (bounds.openings || [])) {
      boundsByOpening[String(row.opening_id)] = row;
    }

    const nextStates = {};
    for (const opening of openings) {
      const openingId = String(opening.id);
      const state = _normalizeOpeningPriceState(opening, boundsByOpening[openingId], prevStates[openingId]);
      nextStates[openingId] = state;
      _syncOpeningPriceControlDisplay(state);
    }
    window._priceBoundsByOpening = nextStates;
  } catch (e) {
    app.logger.warn(`[_initPriceControls] ${e}`);
    const fallbackStates = {};
    for (const opening of openings) {
      const fallbackBounds = {
        baseline_sell_price: _safePriceFloat(opening?.baseline_sell_price, _safePriceFloat(opening?.sell_price, 0)),
        min_sell_price: _safePriceFloat(opening?.sell_price, 0),
        floor_sell_price: _safePriceFloat(opening?.sell_price, 0),
      };
      const openingId = String(opening.id);
      const state = _normalizeOpeningPriceState(opening, fallbackBounds, prevStates[openingId]);
      fallbackStates[openingId] = state;
      _syncOpeningPriceControlDisplay(state);
    }
    window._priceBoundsByOpening = fallbackStates;
  }
}

function _setOpeningControlSaving(openingId, saving) {
  const key = String(openingId);
  const state = window._priceBoundsByOpening?.[key];
  if (!state) return;
  state.saving = Boolean(saving);
  _syncOpeningPriceControlDisplay(state);
}

function _resolveAdjustedSell(currentSell, pctDelta, minSell, baselineSell) {
  if (pctDelta === 0) return baselineSell;
  return _clampPrice(currentSell * (1 + (pctDelta / 100)), minSell, baselineSell);
}

async function adjustOpeningPricePct(quoteId, openingId, pctDelta) {
  const key = String(openingId);
  if (window._priceCommitLocks[key]) return;

  let state = window._priceBoundsByOpening?.[key];
  let opening = _findQuoteOpening(key);
  if (!state || !opening) {
    await _initPriceControls(STATE.currentQuote);
    state = window._priceBoundsByOpening?.[key];
    opening = _findQuoteOpening(key);
  }
  if (!state || !opening) {
    toast("Price controls unavailable. Refresh and try again.", "error");
    return;
  }

  const currentSell = _clampPrice(
    _safePriceFloat(opening.sell_price, state.currentSell),
    state.minSell,
    state.baselineSell
  );
  const nextSell = Number(
    _resolveAdjustedSell(currentSell, Number(pctDelta), state.minSell, state.baselineSell).toFixed(2)
  );
  // For Reset (pctDelta===0) always let the PATCH through so it actually resets even
  // if currentSell already equals baseline (e.g. stale UI state after a prior save).
  // For +/- buttons skip if the clamp produced no real change (already at floor/ceiling).
  if (Number(pctDelta) !== 0 && Math.abs(nextSell - currentSell) < 0.009) {
    _syncOpeningPriceControlDisplay(state);
    return;
  }

  const previousSell = state.currentSell;
  state.currentSell = nextSell;
  try {
    window._priceCommitLocks[key] = true;
    _setOpeningControlSaving(key, true);

    await patch(`/openings/${key}`, { sell_price: nextSell });

    const valEl = el(`opc-val-${key}`);
    if (valEl) {
      valEl.classList.add("saved");
      setTimeout(() => valEl.classList.remove("saved"), 1500);
    }

    const quote = await get(`/quotes/${quoteId}`);
    STATE.currentQuote = quote;
    updateMarginRibbon(quote);
    renderOpeningList(el("field-screen-container"), quote);
  } catch (e) {
    state.currentSell = previousSell;
    _syncOpeningPriceControlDisplay(state);
    toast(`Failed to update price: ${e.message}`, "error");
  } finally {
    delete window._priceCommitLocks[key];
    _setOpeningControlSaving(key, false);
  }
}

/* ============================================================
   TIER 4-B: BULK PRICE ADJUSTMENT
   ============================================================ */

function _setBulkAdjustDisabled(quoteId, disabled) {
  const bar = el(`bulk-price-bar-${quoteId}`);
  if (!bar) return;
  const buttons = bar.querySelectorAll("button.bulk-btn");
  buttons.forEach((btn) => {
    btn.disabled = Boolean(disabled);
  });
}

async function bulkAdjustQuote(quoteId, pct) {
  const key = String(quoteId);
  if (window._bulkAdjustLocks[key]) return;
  try {
    window._bulkAdjustLocks[key] = true;
    _setBulkAdjustDisabled(quoteId, true);

    let body = {};
    if (pct === 0) {
      body = { reset: true };
    } else {
      body = { adjustment_pct: pct };
    }

    await post(`/quotes/${quoteId}/bulk-adjust`, body);
    toast(`Quote ${pct === 0 ? "reset" : `adjusted ${pct > 0 ? "+" : ""}${pct}%`}.`, "success");

    // Refresh quote
    const quote = await get(`/quotes/${quoteId}`);
    STATE.currentQuote = quote;
    updateMarginRibbon(quote);
    renderOpeningList(el("field-screen-container"), quote);
  } catch (e) {
    const msg = (e && e.message ? String(e.message) : "Unknown error").replace(/^API \d+:\s*/i, "");
    toast(`Bulk adjust failed: ${msg}`, "error");
  } finally {
    delete window._bulkAdjustLocks[key];
    _setBulkAdjustDisabled(quoteId, false);
  }
}

function showBulkCustomInput(quoteId) {
  const input = prompt("Enter adjustment percentage (e.g., -5 or +3):");
  if (input !== null && input.trim()) {
    const pct = parseFloat(input);
    if (!isNaN(pct)) {
      bulkAdjustQuote(quoteId, pct);
    } else {
      toast("Invalid percentage", "error");
    }
  }
}

/* ============================================================
   TIER 4-E: AI QUOTE NARRATIVE GENERATOR
   ============================================================ */

async function generateQuoteNarrative(quoteId) {
  const btn = el(`gen-narrative-btn-${quoteId}`);
  if (!btn) return;

  btn.disabled = true;
  btn.textContent = "⏳ Generating...";

  try {
    const result = await post(`/quotes/${quoteId}/generate-narrative`, {});
    showNarrativeModal(result.narrative);
    btn.textContent = "✨ Generate Summary";
  } catch (e) {
    toast(`Generation failed: ${e.message}`, "error");
    btn.textContent = "✨ Generate Summary";
  } finally {
    btn.disabled = false;
  }
}

function showNarrativeModal(narrative) {
  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-panel" style="max-width:500px;">
      <h3 style="margin-top:0;">Customer Quote Summary</h3>
      <p style="white-space:pre-wrap; line-height:1.6; font-size:14px; color:var(--text-secondary);">${esc(narrative)}</p>
      <div style="display:flex;gap:8px;margin-top:16px;">
        <button class="btn btn-primary" onclick="copyNarrativeToClipboard('${esc(narrative)}'); this.closest('.modal-overlay').remove();">Copy to Clipboard</button>
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove();">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

function copyNarrativeToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    toast("Copied to clipboard!", "success");
  }).catch(() => {
    toast("Copy failed", "error");
  });
}

/* ============================================================
   FIELD: OPENING BUILDER — STEP 1 (MEASURE) ENHANCED
   ============================================================ */
function renderOpeningStep1(container) {
  const types = [
    { value: "single_hung",        label: "Single Hung" },
    { value: "double_hung",        label: "Double Hung" },
    { value: "casement",           label: "Casement" },
    { value: "sliding_glass_door", label: "Sliding Glass Door" },
    { value: "fixed",              label: "Fixed Picture" },
    { value: "entry_door",         label: "Entry Door" },
    { value: "french_door",        label: "French Door" },
    { value: "horizontal_roller",  label: "Horizontal Roller" },
    { value: "bifold_door",        label: "Bifold Door" },
  ];
  const ob = STATE.openingBuilder;

  container.innerHTML = `
    <div class="field-screen" style="padding-bottom:80px;">
      <div class="field-screen-header">
        <button class="back-btn" onclick="window.location.hash='field-quote/${ob.quoteId}'">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <h2 class="field-screen-title">Add Opening</h2>
      </div>

      ${buildStepProgress(1)}

      <div class="photo-placeholder" onclick="toast('Photo capture coming in v3.0','info')">
        <div class="photo-icon">📷</div>
        <div class="photo-label">Tap to capture photo (optional)</div>
      </div>

      <div class="form-card">
        <div class="form-card-title">Opening Type</div>
        <div class="form-group">
          <select id="step1-type" class="form-input" style="width:100%;">
            <option value="">Select type…</option>
            ${types.map(t => `<option value="${t.value}" ${ob.openingType === t.value ? "selected" : ""}>${t.label}</option>`).join("")}
          </select>
        </div>
      </div>

      <div class="form-card">
        <div class="form-card-title">Dimensions</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Width (inches) <span class="required">*</span></label>
            <input type="number" id="step1-width" class="form-input"
              placeholder="e.g. 36" min="1" max="1000"
              value="${ob.width || ""}" />
            <div class="form-hint">Any size in inches (1–1000)</div>
          </div>
          <div class="form-group">
            <label class="form-label">Height (inches) <span class="required">*</span></label>
            <input type="number" id="step1-height" class="form-input"
              placeholder="e.g. 60" min="1" max="1000"
              value="${ob.height || ""}" />
            <div class="form-hint">Any size in inches (1–1000)</div>
          </div>
        </div>
      </div>

      <div class="form-card">
        <div class="form-card-title">Wall Type</div>
        <div class="floor-selector" style="grid-template-columns:repeat(3,1fr);">
          ${[
            { v: "cbs",      l: "CBS" },
            { v: "frame",    l: "Frame" },
            { v: "concrete", l: "Concrete" },
          ].map(w => `
            <input type="radio" name="wall-type" id="wall-${w.v}" class="floor-radio" value="${w.v}"
              ${(ob.wallType || "cbs") === w.v ? "checked" : ""} />
            <label class="floor-label" for="wall-${w.v}">${w.l}</label>
          `).join("")}
        </div>
      </div>

      <div class="form-card">
        <div class="form-card-title">Floor Level</div>
        <div class="floor-selector">
          ${[1,2,3,4].map(f => `
            <input type="radio" name="floor-level" id="floor-${f}" class="floor-radio" value="${f}"
              ${ob.floorLevel === f ? "checked" : ""} />
            <label class="floor-label" for="floor-${f}">${floorLabel(f)}</label>
          `).join("")}
        </div>
      </div>

      <div id="step1-errors" style="color:var(--red);font-size:13px;padding:4px 0 12px;"></div>

      <div style="display:flex;gap:10px;">
        <button class="btn btn-primary btn-full btn-lg" id="step1-next-single">
          Single Opening →
        </button>
        <button class="btn btn-ghost btn-full btn-lg" id="step1-next-multi">
          Multipart →
        </button>
      </div>
    </div>`;

  el("step1-next-single").onclick = () => validateStep1("single");
  el("step1-next-multi").onclick  = () => validateStep1("multipart");
}

function validateStep1(mode) {
  const type   = el("step1-type").value;
  const width  = parseFloat(el("step1-width").value);
  const height = parseFloat(el("step1-height").value);
  const floor  = parseInt(document.querySelector('input[name="floor-level"]:checked')?.value || 1);
  const wall   = document.querySelector('input[name="wall-type"]:checked')?.value || "cbs";
  const errors = [];
  if (!type)                                         errors.push("Select an opening type.");
  if (isNaN(width)  || width <= 0 || width  > 1000) errors.push("Width must be between 1 and 1000 inches.");
  if (isNaN(height) || height <= 0 || height > 1000) errors.push("Height must be between 1 and 1000 inches.");
  if (errors.length) { el("step1-errors").innerHTML = errors.join("<br>"); return; }

  const ob = STATE.openingBuilder;
  ob.openingType  = type;
  ob.width        = width;
  ob.height       = height;
  ob.floorLevel   = floor;
  ob.wallType     = wall;
  ob.openingMode  = mode;

  if (mode === "multipart") {
    window.location.hash = `field-assembly-builder/${ob.quoteId}`;
  } else {
    window.location.hash = `field-config-opening/${ob.quoteId}`;
  }
}

function buildStepProgress(current, extra) {
  const steps = extra ? [
    { n: 1, label: "Measure" },
    { n: 1.5, label: "Assembly" },
    { n: 2, label: "Configure" },
    { n: 3, label: "Validate" },
  ] : [
    { n: 1, label: "Measure" },
    { n: 2, label: "Configure" },
    { n: 3, label: "Validate" },
  ];
  return `
    <div class="step-progress">
      ${steps.map((s, i) => `
        ${i > 0 ? `<div class="step-connector ${s.n < current ? "done" : ""}"></div>` : ""}
        <div style="display:flex;flex-direction:column;align-items:center;">
          <div class="step-dot ${s.n === current ? "active" : s.n < current ? "done" : "future"}">
            ${s.n < current ? "✓" : (s.n === 1.5 ? "★" : s.n)}
          </div>
          <div class="step-label">${s.label}</div>
        </div>
      `).join("")}
    </div>`;
}

/* ============================================================
   FIELD: STEP 1.5 — ASSEMBLY BUILDER
   ============================================================ */
function renderAssemblyBuilderStep(container) {
  const ob = STATE.openingBuilder;
  const totalW = ob.width;
  const totalH = ob.height;

  const layoutOptions = [
    { value: "2-wide", label: "2-Wide", icon: "[ ][ ]", count: 2 },
    { value: "3-wide", label: "3-Wide", icon: "[ ][ ][ ]", count: 3 },
    { value: "2x2",    label: "2x2 Grid", icon: "[ ][ ]\n[ ][ ]", count: 4 },
  ];

  const currentLayout = ob.layoutType || "2-wide";
  const currentCount  = ob.panelCount || 2;

  container.innerHTML = `
    <div class="field-screen" style="padding-bottom:80px;">
      <div class="field-screen-header">
        <button class="back-btn" onclick="window.location.hash='field-add-opening/${ob.quoteId}'">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <h2 class="field-screen-title">Assembly Builder</h2>
      </div>

      ${buildStepProgress(1.5, true)}

      <div class="form-card">
        <div class="form-card-title">Opening Dimensions</div>
        <div style="display:flex;gap:16px;align-items:center;padding:8px 0;">
          <div style="text-align:center;">
            <div style="font-family:var(--font-mono);font-size:22px;color:var(--text-primary);font-weight:600;">${totalW}"</div>
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">Width</div>
          </div>
          <div style="font-size:20px;color:var(--text-muted);">×</div>
          <div style="text-align:center;">
            <div style="font-family:var(--font-mono);font-size:22px;color:var(--text-primary);font-weight:600;">${totalH}"</div>
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:.05em;">Height</div>
          </div>
          <div style="margin-left:auto;font-size:12px;color:var(--text-muted);">
            ${fmt(totalW * totalH / 144, 2)} sqft
          </div>
        </div>
      </div>

      ${STATE.assemblyTemplates.length > 0 ? `
      <div class="form-card">
        <div class="form-card-title">Templates</div>
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px;">
          ${STATE.assemblyTemplates.map(t => `
            <div class="option-item ${ob.assemblyTemplate === t.id ? "selected" : ""}"
              onclick="selectAssemblyTemplate('${t.id}','${t.layout_type}',${t.panel_count})"
              style="flex-direction:column;align-items:flex-start;padding:10px 12px;cursor:pointer;">
              <div style="font-weight:600;font-size:13px;">${esc(t.name)}</div>
              <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${t.panel_count} panels · ${esc(t.layout_type)}</div>
            </div>
          `).join("")}
        </div>
      </div>
      ` : ""}

      <div class="form-card">
        <div class="form-card-title">Layout</div>
        <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;">
          ${layoutOptions.map(lo => `
            <div class="option-item ${currentLayout === lo.value ? "selected" : ""}"
              onclick="selectAssemblyLayout('${lo.value}',${lo.count})"
              style="flex-direction:column;align-items:center;cursor:pointer;padding:10px 8px;">
              <pre style="font-family:var(--font-mono);font-size:9px;margin:0 0 4px;color:var(--text-secondary);line-height:1.3;">${lo.icon}</pre>
              <div style="font-size:12px;font-weight:600;">${lo.label}</div>
            </div>
          `).join("")}
        </div>
        <div style="display:flex;align-items:center;gap:10px;">
          <label class="form-label" style="margin:0;white-space:nowrap;">Custom panel count:</label>
          <input type="number" id="assembly-panel-count" class="form-input"
            value="${currentCount}" min="2" max="9" style="width:80px;" />
        </div>
      </div>

      <!-- Visual Diagram -->
      <div class="form-card">
        <div class="form-card-title">Assembly Preview</div>
        <div id="assembly-diagram" style="overflow-x:auto;"></div>
        <div id="assembly-mull-info" style="margin-top:8px;font-size:12px;color:var(--text-muted);"></div>
      </div>

      <button class="btn btn-primary btn-full btn-lg" id="assembly-next-btn">
        Configure Panels →
      </button>
    </div>`;

  el("assembly-panel-count").onchange = () => {
    const count = parseInt(el("assembly-panel-count").value) || 2;
    STATE.openingBuilder.panelCount = count;
    updateAssemblyDiagram();
  };
  el("assembly-next-btn").onclick = proceedFromAssemblyBuilder;

  updateAssemblyDiagram();
}

function selectAssemblyTemplate(id, layoutType, panelCount) {
  const ob = STATE.openingBuilder;
  ob.assemblyTemplate = id;
  ob.layoutType       = layoutType;
  ob.panelCount       = panelCount;
  el("assembly-panel-count").value = panelCount;
  document.querySelectorAll(".option-item[onclick^='selectAssemblyTemplate']").forEach(e2 => {
    e2.classList.toggle("selected", e2.getAttribute("onclick").includes(`'${id}'`));
  });
  updateAssemblyDiagram();
}

function selectAssemblyLayout(layoutType, count) {
  const ob = STATE.openingBuilder;
  ob.layoutType   = layoutType;
  ob.panelCount   = count;
  ob.assemblyTemplate = null;
  el("assembly-panel-count").value = count;
  document.querySelectorAll(".option-item[onclick^='selectAssemblyLayout']").forEach(e2 => {
    e2.classList.toggle("selected", e2.getAttribute("onclick").includes(`'${layoutType}'`));
  });
  updateAssemblyDiagram();
}

function updateAssemblyDiagram() {
  const ob      = STATE.openingBuilder;
  const panelCount = ob.panelCount || 2;
  const totalW  = ob.width || 0;
  const totalH  = ob.height || 0;
  const mullAllowance = 1.5; // 1.5" per mull bar
  const mullCount = panelCount - 1;
  const usableW = totalW - (mullCount * mullAllowance);
  const panelW  = usableW / panelCount;

  const diagramEl   = el("assembly-diagram");
  const mullInfoEl  = el("assembly-mull-info");
  if (!diagramEl) return;

  // Build visual diagram
  const is2x2 = ob.layoutType === "2x2";
  const rows   = is2x2 ? 2 : 1;
  const cols   = is2x2 ? 2 : panelCount;
  let diagramHtml = `
    <div style="display:inline-flex;flex-direction:column;gap:0;border:1px solid var(--border);border-radius:4px;overflow:hidden;">
  `;
  for (let r = 0; r < rows; r++) {
    diagramHtml += `<div style="display:flex;gap:0;">`;
    for (let c = 0; c < cols; c++) {
      const panelIdx = r * cols + c;
      const panel    = ob.panels[panelIdx] || {};
      const isLast   = c === cols - 1;
      const isLastRow = r === rows - 1;
      diagramHtml += `
        <div onclick="setPanelType(${panelIdx})" style="
          min-width:80px;padding:10px 8px;
          background:${panel.productType ? "rgba(16,185,129,0.1)" : "var(--bg-elevated)"};
          border-right:${isLast ? "none" : "1px solid var(--border)"};
          border-bottom:${isLastRow ? "none" : "1px solid var(--border)"};
          text-align:center;cursor:pointer;
          transition:background 0.2s;
        ">
          <div style="font-size:11px;font-weight:600;color:var(--text-muted);margin-bottom:4px;">P${panelIdx+1}</div>
          <div style="font-family:var(--font-mono);font-size:10px;color:var(--text-secondary);">${fmt(panelW, 1)}"</div>
          <div style="font-size:10px;color:${panel.productType ? "var(--green)" : "var(--text-muted)"};margin-top:4px;">
            ${panel.productType ? openingTypeLabel(panel.productType) : "Tap to set"}
          </div>
        </div>
        ${c < cols - 1 ? `<div style="width:4px;background:var(--bg-elevated);border-left:1px solid var(--border);border-right:1px solid var(--border);" title="Mull bar"></div>` : ""}
      `;
    }
    diagramHtml += `</div>`;
  }
  diagramHtml += `</div>`;
  diagramEl.innerHTML = diagramHtml;

  const gs = STATE.globalSettings || {};
  const mullBarCost   = gs.mull_bar_cost || 0;
  const mullTotalCost = mullCount * mullBarCost;
  mullInfoEl.innerHTML = `
    ${mullCount} mull bar${mullCount !== 1 ? "s" : ""} required · ${fmt(panelW, 1)}" per panel ·
    Mull bar cost: ${fmtMoney(mullTotalCost)}
    ${gs.assembly_labor ? ` · Assembly labor: ${fmtMoney(gs.assembly_labor)}` : ""}
  `;
}

function setPanelType(panelIdx) {
  const types = [
    { value: "single_hung",        label: "Single Hung" },
    { value: "double_hung",        label: "Double Hung" },
    { value: "casement",           label: "Casement" },
    { value: "sliding_glass_door", label: "Sliding Glass Door" },
    { value: "fixed",              label: "Fixed Picture" },
    { value: "entry_door",         label: "Entry Door" },
    { value: "french_door",        label: "French Door" },
    { value: "horizontal_roller",  label: "Horizontal Roller" },
    { value: "bifold_door",        label: "Bifold Door" },
  ];
  showSimpleModal(
    `Set Panel ${panelIdx + 1} Type`,
    `<div class="option-list">
      ${types.map(t => `
        <div class="option-item" onclick="confirmPanelType(${panelIdx},'${t.value}')" style="cursor:pointer;">
          <div class="option-item-left">
            <div class="option-radio-indicator"></div>
            <div class="option-name">${t.label}</div>
          </div>
        </div>
      `).join("")}
    </div>`,
    () => closeSimpleModal()
  );
  // Hide save button since selection triggers immediately
  setTimeout(() => {
    const saveBtn = el("simple-modal-save");
    if (saveBtn) saveBtn.style.display = "none";
  }, 50);
}

function confirmPanelType(panelIdx, typeValue) {
  const ob = STATE.openingBuilder;
  if (!ob.panels[panelIdx]) ob.panels[panelIdx] = {};
  ob.panels[panelIdx].productType = typeValue;
  closeSimpleModal();
  updateAssemblyDiagram();
}

function proceedFromAssemblyBuilder() {
  const ob = STATE.openingBuilder;
  const panelCount = ob.panelCount || 2;
  const totalW  = ob.width || 0;
  const totalH  = ob.height || 0;
  const mullAllowance = 1.5;
  const mullCount = panelCount - 1;
  const panelW  = (totalW - mullCount * mullAllowance) / panelCount;

  // Initialize panels array
  if (ob.panels.length < panelCount) {
    for (let i = ob.panels.length; i < panelCount; i++) {
      ob.panels.push({ productType: ob.openingType, width: panelW, height: totalH });
    }
  }
  // Set dimensions for all panels
  ob.panels.forEach((p, i) => {
    if (i < panelCount) {
      p.width  = panelW;
      p.height = totalH;
      if (!p.productType) p.productType = ob.openingType;
    }
  });
  ob.panels = ob.panels.slice(0, panelCount);
  ob.currentPanelIndex = 0;
  window.location.hash = `field-config-opening/${ob.quoteId}`;
}

/* ============================================================
   FIELD: OPENING BUILDER — STEP 2 (CONFIGURE) ENHANCED
   ============================================================ */
async function renderOpeningStep2(container) {
  container.innerHTML = `<div class="loading-state" style="min-height:50vh;"><div class="spinner"></div></div>`;

  const ob = STATE.openingBuilder;
  const isMultipart = ob.openingMode === "multipart";
  const currentPanel = isMultipart ? (ob.panels[ob.currentPanelIndex] || {}) : null;
  const filterType   = isMultipart ? (currentPanel.productType || ob.openingType) : ob.openingType;
  const hvhzOnlyMode = isHvhzOnlyMode();

  const filteredProducts = STATE.products.filter((p) => {
    const matchesType = p.type === filterType;
    const matchesZonePolicy = !hvhzOnlyMode || Boolean(p.hvhz);
    return matchesType && matchesZonePolicy;
  });
  if (!ob.productId && filteredProducts.length > 0) ob.productId = filteredProducts[0].id;
  if (!ob.glassOptionId && STATE.glassOptions.length > 0) ob.glassOptionId = STATE.glassOptions[0].id;
  if (!ob.frameColorId  && STATE.frameColors.length > 0)  ob.frameColorId  = STATE.frameColors[0].id;

  // For multipart, init panel config
  if (isMultipart && currentPanel) {
    if (!currentPanel.productId && filteredProducts.length > 0) currentPanel.productId = filteredProducts[0].id;
    if (!currentPanel.glassOptionId && STATE.glassOptions.length > 0) currentPanel.glassOptionId = STATE.glassOptions[0].id;
    if (!currentPanel.frameColorId  && STATE.frameColors.length > 0)  currentPanel.frameColorId  = STATE.frameColors[0].id;
    ob.productId     = currentPanel.productId;
    ob.glassOptionId = currentPanel.glassOptionId;
    ob.frameColorId  = currentPanel.frameColorId;
  }

  await runLiveCalc();

  // Fetch lead time
  let leadTimeData = null;
  if (ob.productId) {
    leadTimeData = await get(`/lead-time?product_id=${ob.productId}&frame_color_id=${ob.frameColorId || ""}`).catch(() => null);
  }

  // Group products by line
  const lineGroups = {};
  filteredProducts.forEach(p => {
    const line = p.product_line || p.series || "Other";
    if (!lineGroups[line]) lineGroups[line] = [];
    lineGroups[line].push(p);
  });

  const panelHeader = isMultipart ? `
    <div style="background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.3);border-radius:6px;padding:10px 14px;margin-bottom:12px;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:#818cf8;font-weight:600;">Configuring Panel ${ob.currentPanelIndex + 1} of ${ob.panelCount || ob.panels.length}</div>
        <div style="font-size:13px;color:var(--text-primary);margin-top:2px;">${openingTypeLabel(currentPanel.productType || ob.openingType)} · ${fmt(currentPanel.width || ob.width, 1)}" × ${fmt(currentPanel.height || ob.height, 1)}"</div>
      </div>
      ${ob.currentPanelIndex > 0 ? `<button class="btn btn-ghost btn-sm" onclick="prevPanel()">< Prev</button>` : ""}
    </div>
  ` : "";

  const ltWeeks = leadTimeData?.estimated_weeks || null;
  const ltColor = leadTimeColor(ltWeeks);
  const govData = getRepFloor();
  const liveMarginClass = ob.liveCalc ? marginColor(ob.liveCalc.margin_pct, govData.floor, govData.yellow) : "";

  container.innerHTML = `
    <div class="field-screen" style="padding-bottom:80px;">
      <div class="field-screen-header">
        <button class="back-btn" onclick="${isMultipart ? `window.location.hash='field-assembly-builder/${ob.quoteId}'` : `window.location.hash='field-add-opening/${ob.quoteId}'`}">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <h2 class="field-screen-title">${isMultipart ? "Configure Panels" : "Configure Opening"}</h2>
      </div>

      ${buildStepProgress(2, isMultipart)}
      ${panelHeader}

      <div id="mini-ribbon-wrap">${buildMiniRibbon()}</div>

      <div class="form-card" style="margin-top:10px;">
        <div class="form-card-title">Pricing Controls</div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label">Driveway Discount (%)</label>
            <input type="number" id="discount-pct-input" class="form-input" min="0" max="90" step="0.25"
              value="${ob.drivewayDiscountPct || 0}" oninput="onPricingControlInput('discount')" />
          </div>
          <div class="form-group">
            <label class="form-label">Target Sell Price ($)</label>
            <input type="number" id="target-sell-input" class="form-input" min="0" step="1"
              value="${ob.requestedSellPrice != null ? ob.requestedSellPrice : ''}" oninput="onPricingControlInput('target')" />
          </div>
        </div>
        <div class="form-hint">If target sell price is entered, it overrides discount percent.</div>
        <div id="live-margin-indicator" class="live-margin-indicator ${liveMarginClass}">
          <span>Live Margin</span>
          <strong>${ob.liveCalc ? fmtPct(ob.liveCalc.margin_pct) : '—'}</strong>
        </div>
      </div>


      <!-- Product Series grouped by line -->
      <div class="option-group">
        <div class="option-group-title">Product Series</div>
        ${hvhzOnlyMode ? `<div class="form-hint" style="margin-bottom:6px;">HVHZ-only mode: non-HVHZ products are hidden.</div>` : ""}
        <div class="option-list" id="product-options">
          ${filteredProducts.length ? Object.entries(lineGroups).map(([line, prods]) => `
            <div style="padding:4px 12px;font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--text-muted);background:var(--bg-elevated);border-bottom:1px solid var(--border);">
              ${lineBadge(line)}
            </div>
            ${prods.map(p => `
              <div class="option-item ${ob.productId === p.id ? "selected" : ""}"
                data-type="product" data-id="${p.id}" onclick="selectOption('product','${p.id}')">
                <div class="option-item-left">
                  <div class="option-radio-indicator"></div>
                  <div>
                    <div class="option-name">${esc(p.name)}</div>
                    <div style="font-size:10px;color:var(--text-muted);margin-top:1px;">
                      ${p.model_number ? `${esc(p.model_number)} · ` : ""}${p.lead_time_weeks ? `${p.lead_time_weeks} wk lead time` : ""}
                    </div>
                  </div>
                </div>
                <div class="option-price">${fmtMoney(p.base_cost)}</div>
              </div>`).join("")}
          `).join("") :
          `<div style="padding:12px;color:var(--text-muted);font-size:13px;">${hvhzOnlyMode ? "No HVHZ-certified products are available for this opening type." : "No products for this opening type."}</div>`}
        </div>
      </div>

      ${ltWeeks ? `
        <div style="padding:10px 14px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
          <span style="font-size:13px;color:var(--text-secondary);">Est. Lead Time</span>
          <span id="lead-time-badge" style="font-weight:600;font-size:13px;color:${ltColor};">${leadTimeData?.display || `${ltWeeks} wks`}</span>
        </div>
      ` : `<div id="lead-time-badge-wrap" style="height:0;overflow:hidden;"></div>`}

      <!-- Glass Type -->
      <div class="option-group">
        <div class="option-group-title">Glass Type</div>
        <div class="option-list" id="glass-options">
          ${STATE.glassOptions.map(g => `
            <div class="option-item ${ob.glassOptionId === g.id ? "selected" : ""}"
              data-type="glass" data-id="${g.id}" onclick="selectOption('glass','${g.id}')">
              <div class="option-item-left">
                <div class="option-radio-indicator"></div>
                <div class="option-name">${esc(g.name)}</div>
              </div>
              <div class="option-price">${g.cost_adder === 0 ? "Included" : `+${fmtMoney(g.cost_adder)}`}</div>
            </div>`).join("")}
        </div>
      </div>

      <!-- Frame Color -->
      <div class="option-group">
        <div class="option-group-title">Frame Color</div>
        <div class="option-list" id="color-options">
          ${STATE.frameColors.map(c => `
            <div class="option-item ${ob.frameColorId === c.id ? "selected" : ""}"
              data-type="color" data-id="${c.id}" onclick="selectOption('color','${c.id}')">
              <div class="option-item-left">
                <div class="option-radio-indicator"></div>
                <div>
                  <div class="option-name">${esc(c.name)}</div>
                  ${c.lead_time_override_weeks ? `<div style="font-size:10px;color:var(--amber);">+${c.lead_time_override_weeks} wk lead time</div>` : ""}
                </div>
              </div>
              <div class="option-price">${c.cost_adder === 0 ? "Included" : `+${fmtMoney(c.cost_adder)}`}</div>
            </div>`).join("")}
        </div>
      </div>

      <!-- Complexity -->
      <div class="option-group">
        <div class="option-group-title">Install Complexity (Optional)</div>
        <div class="option-list" id="complexity-options">
          ${STATE.complexityItems.map(cx => `
            <div class="option-item ${ob.complexityIds.includes(cx.id) ? "checked" : ""}"
              data-type="complexity" data-id="${cx.id}" onclick="toggleComplexity('${cx.id}')">
              <div class="option-item-left">
                <div class="option-check-indicator"></div>
                <div class="option-name">${esc(cx.name)}</div>
              </div>
              <div class="option-price">+${fmtMoney(cx.cost)}</div>
            </div>`).join("")}
        </div>
      </div>

      <button class="btn btn-primary btn-full btn-lg" onclick="goToValidate()">
        ${isMultipart && ob.currentPanelIndex < (ob.panelCount || ob.panels.length) - 1 ? "Next Panel →" : "Next: Validate →"}
      </button>
    </div>`;
}

function prevPanel() {
  const ob = STATE.openingBuilder;
  if (ob.currentPanelIndex > 0) {
    savePanelConfig();
    ob.currentPanelIndex--;
    loadPanelConfig();
    renderOpeningStep2(el("field-screen-container"));
  }
}

function savePanelConfig() {
  const ob = STATE.openingBuilder;
  if (ob.openingMode === "multipart" && ob.panels[ob.currentPanelIndex]) {
    ob.panels[ob.currentPanelIndex].productId     = ob.productId;
    ob.panels[ob.currentPanelIndex].glassOptionId = ob.glassOptionId;
    ob.panels[ob.currentPanelIndex].frameColorId  = ob.frameColorId;
  }
}

function loadPanelConfig() {
  const ob = STATE.openingBuilder;
  if (ob.openingMode === "multipart" && ob.panels[ob.currentPanelIndex]) {
    const p = ob.panels[ob.currentPanelIndex];
    ob.productId     = p.productId     || null;
    ob.glassOptionId = p.glassOptionId || null;
    ob.frameColorId  = p.frameColorId  || null;
  }
}

async function selectOption(type, id) {
  const ob = STATE.openingBuilder;
  if (type === "product") ob.productId     = id;
  if (type === "glass")   ob.glassOptionId = id;
  if (type === "color")   ob.frameColorId  = id;

  document.querySelectorAll(`[data-type="${type}"]`).forEach(e2 => {
    e2.classList.toggle("selected", e2.dataset.id === id);
  });

  await runLiveCalc();
  const miniWrap = el("mini-ribbon-wrap");
  if (miniWrap) miniWrap.innerHTML = buildMiniRibbon();

  // Update lead time if product or color changed
  if (type === "product" || type === "color") {
    updateLeadTimeDisplay();
  }
}

async function updateLeadTimeDisplay() {
  const ob = STATE.openingBuilder;
  if (!ob.productId) return;
  try {
    const ltData = await get(`/lead-time?product_id=${ob.productId}&frame_color_id=${ob.frameColorId || ""}`).catch(() => null);
    const badge = el("lead-time-badge") || el("lead-time-badge-wrap");
    if (badge && ltData?.estimated_weeks) {
      const ltColor = leadTimeColor(ltData.estimated_weeks);
      if (badge.id === "lead-time-badge") {
        badge.textContent = ltData.display || `${ltData.estimated_weeks} wks`;
        badge.style.color = ltColor;
      }
    }
  } catch {}
}

async function toggleComplexity(id) {
  const ob  = STATE.openingBuilder;
  const idx = ob.complexityIds.indexOf(id);
  if (idx >= 0) ob.complexityIds.splice(idx, 1);
  else ob.complexityIds.push(id);

  const e2 = document.querySelector(`[data-type="complexity"][data-id="${id}"]`);
  if (e2) e2.classList.toggle("checked", ob.complexityIds.includes(id));

  await runLiveCalc();
  const miniWrap = el("mini-ribbon-wrap");
  if (miniWrap) miniWrap.innerHTML = buildMiniRibbon();
}

async function runLiveCalc() {
  const ob = STATE.openingBuilder;
  const requiredZone = resolveRequiredZone();
  if (!ob.productId || !ob.quoteId) return;
  try {
    const result = await post("/calculate", {
      quote_id:        ob.quoteId,
      product_id:      ob.productId,
      width:           ob.width,
      height:          ob.height,
      floor_level:     ob.floorLevel,
      glass_option_id: ob.glassOptionId,
      frame_color_id:  ob.frameColorId,
      complexity_ids:  ob.complexityIds,
      zip_code:        STATE.currentQuote?.job_zip || "",
      rep_id:          STATE.currentUser.id,
      wall_type:       ob.wallType || "cbs",
      required_zone:   requiredZone,
      hvhz:            requiredZone === "HVHZ",
      driveway_discount_pct: ob.drivewayDiscountPct || 0,
      requested_sell_price: ob.requestedSellPrice != null ? Number(ob.requestedSellPrice) : null,
    });
    ob.liveCalc = result;
    if (result?.discount_pct != null) {
      ob.drivewayDiscountPct = Number(result.discount_pct) || 0;
    }
  } catch (e) {
    console.warn("Calc error:", e);
  }
}

function buildMiniRibbon() {
  const calc = STATE.openingBuilder.liveCalc;
  const govData = getRepFloor();
  const quoteMarginPct = STATE.currentQuote?.margin_pct ?? null;
  const mc = marginColor(quoteMarginPct, govData.floor, govData.yellow) || "green";
  const vis = getUiVisibility();
  const parts = [];

  if (!vis.hidePricing) {
    parts.push(`
      <div class="mini-ribbon-item">
        <div class="mini-ribbon-label">This Opening</div>
        <div class="mini-ribbon-value" style="color:var(--text-primary);">${calc ? fmtMoney(calc.sell_price) : "—"}</div>
      </div>
    `);
  }

  if (!vis.hideMargin) {
    parts.push(`
      <div class="mini-ribbon-item">
        <div class="mini-ribbon-label">Gross Margin %</div>
        <div class="mini-ribbon-value ${calc ? marginColor(calc.margin_pct, govData.floor, govData.yellow) : ""}">${calc ? fmtPct(calc.margin_pct) : "—"}</div>
      </div>
    `);
    if (hasPerm("can_view_markup") && calc?.markup_pct != null) {
      parts.push(`
        <div class="mini-ribbon-item">
          <div class="mini-ribbon-label">Markup %</div>
          <div class="mini-ribbon-value" style="color:var(--text-secondary);">${fmt(calc.markup_pct)}%</div>
        </div>
      `);
    }
    parts.push(`
      <div class="mini-ribbon-item">
        <div class="mini-ribbon-label">Quote Margin</div>
        <div class="mini-ribbon-value ${mc}">${quoteMarginPct != null ? fmtPct(quoteMarginPct) : "—"}</div>
      </div>
    `);
  }

  if (!parts.length) return "";

  return `<div class="mini-ribbon ${mc}-ribbon">${parts.join('<div class="divider"></div>')}</div>`;
}

async function onPricingControlInput(mode) {
  const ob = STATE.openingBuilder;
  const discountInput = el("discount-pct-input");
  const targetInput = el("target-sell-input");

  if (mode === "discount") {
    ob.drivewayDiscountPct = Math.max(0, Math.min(90, parseFloat(discountInput?.value || 0) || 0));
    ob.requestedSellPrice = null;
    if (targetInput) targetInput.value = "";
  } else {
    const targetValue = parseFloat(targetInput?.value || "");
    ob.requestedSellPrice = Number.isFinite(targetValue) && targetValue > 0 ? targetValue : null;
  }

  await runLiveCalc();
  const miniWrap = el("mini-ribbon-wrap");
  if (miniWrap) miniWrap.innerHTML = buildMiniRibbon();

  if (discountInput && ob.liveCalc?.discount_pct != null && mode !== "target") {
    discountInput.value = Number(ob.liveCalc.discount_pct).toFixed(2);
  }

  const liveInd = el("live-margin-indicator");
  if (liveInd && ob.liveCalc) {
    const govData = getRepFloor();
    const cls = marginColor(ob.liveCalc.margin_pct, govData.floor, govData.yellow);
    liveInd.className = `live-margin-indicator ${cls}`;
    liveInd.innerHTML = `<span>Live Margin</span><strong>${fmtPct(ob.liveCalc.margin_pct)}</strong>`;
  }
}

function goToValidate() {
  if (!STATE.openingBuilder.productId) {
    toast("Please select a product first.", "warning");
    return;
  }
  const ob = STATE.openingBuilder;
  // Save current panel config if multipart
  if (ob.openingMode === "multipart") {
    savePanelConfig();
    // If not on last panel, advance to next
    if (ob.currentPanelIndex < (ob.panelCount || ob.panels.length) - 1) {
      ob.currentPanelIndex++;
      loadPanelConfig();
      renderOpeningStep2(el("field-screen-container"));
      return;
    }
  }
  window.location.hash = `field-validate-opening/${ob.quoteId}`;
}

/* ============================================================
   FIELD: OPENING BUILDER — STEP 3: VALIDATE (DP) ENHANCED
   ============================================================ */
async function renderOpeningStep3(container) {
  container.innerHTML = `<div class="loading-state" style="min-height:50vh;"><div class="spinner"></div><span>Validating DP compliance…</span></div>`;

  const ob = STATE.openingBuilder;
  const isMultipart = ob.openingMode === "multipart";
  const requiredZone = resolveRequiredZone();
  const hvhzRequired = requiredZone === "HVHZ";

  try {
    // Use validate-dp endpoint
    let dpResult;
    if (isMultipart && ob.panels.length > 0) {
      // Validate each panel
      dpResult = await post("/validate-dp", {
        product_id:  ob.panels[0].productId || ob.productId,
        width:       ob.panels[0].width || ob.width,
        height:      ob.panels[0].height || ob.height,
        floor_level: ob.floorLevel,
        hvhz:        hvhzRequired,
        required_zone: requiredZone,
        opening_mode: "multipart",
        panels: ob.panels.map(p => ({
          product_id:  p.productId,
          width:       p.width,
          height:      p.height,
          glass_option_id: p.glassOptionId,
          frame_color_id:  p.frameColorId,
        })),
      }).catch(() => post("/validate-noa", {
        product_id:  ob.productId,
        floor_level: ob.floorLevel,
        hvhz:        hvhzRequired,
        required_zone: requiredZone,
      }));
    } else {
      dpResult = await post("/validate-dp", {
        product_id:  ob.productId,
        width:       ob.width,
        height:      ob.height,
        floor_level: ob.floorLevel,
        hvhz:        hvhzRequired,
        required_zone: requiredZone,
      }).catch(() => post("/validate-noa", {
        product_id:  ob.productId,
        floor_level: ob.floorLevel,
        hvhz:        hvhzRequired,
        required_zone: requiredZone,
      }));
    }

    const calc    = ob.liveCalc;
    const product = STATE.products.find(p => p.id === ob.productId);
    const glass   = STATE.glassOptions.find(g => g.id === ob.glassOptionId);
    const frame   = STATE.frameColors.find(c => c.id === ob.frameColorId);
    const cx      = STATE.complexityItems.filter(c => ob.complexityIds.includes(c.id));
    const dpStatus = String(dpResult.status || "warning").toLowerCase();
    const passed  = dpStatus === "passed";
    const govData = getRepFloor();
    const gs      = STATE.globalSettings || {};

    // Build consumables info
    const wallType = ob.wallType || "cbs";
    const applicableConsumables = STATE.consumables.filter(c => !c.wall_type_filter || c.wall_type_filter === wallType);
    const consumableTotal = applicableConsumables.reduce((sum, c) => sum + (c.unit_cost || 0), 0);

    // Build multipart summary
    const mullCount     = isMultipart ? ((ob.panelCount || ob.panels.length) - 1) : 0;
    const mullBarCost   = gs.mull_bar_cost || 0;
    const mullTotal     = mullCount * mullBarCost;
    const assemblyCost  = gs.assembly_labor || 0;
    const reinforcement = gs.reinforcement_cost || 0;

    // Panel validations for multipart
    let panelValidations = [];
    if (isMultipart && ob.panels.length > 0) {
      panelValidations = await Promise.all(ob.panels.map((panel, i) =>
        post("/validate-dp", {
          product_id:  panel.productId || ob.productId,
          width:       panel.width || ob.width,
          height:      panel.height || ob.height,
          floor_level: ob.floorLevel,
          hvhz:        hvhzRequired,
          required_zone: requiredZone,
        }).catch(() => ({ status: "passed", panel_index: i }))
      ));
    }
    const allPanelsPassed = panelValidations.every(v => (v.status || "passed") === "passed");
    const finalPassed = passed && (!isMultipart || allPanelsPassed);
    const redFlag = !finalPassed;

    container.innerHTML = `
      <div class="field-screen" style="padding-bottom:80px;">
        <div class="field-screen-header">
          <button class="back-btn" onclick="window.location.hash='field-config-opening/${ob.quoteId}'">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <h2 class="field-screen-title">Validate DP</h2>
        </div>

        ${buildStepProgress(3, isMultipart)}

        <!-- DP Result Card -->
        <div class="noa-result-card" style="border:1px solid ${finalPassed ? "rgba(16,185,129,0.3)" : "rgba(239,68,68,0.3)"};">
          <div class="noa-result-header">
            <div class="noa-status-icon ${finalPassed ? "pass" : "fail"}">
              ${finalPassed ? "✓" : "!"}
            </div>
            <div>
              <div class="noa-status-title" style="color:${finalPassed ? "var(--green)" : "var(--red)"}">
                ${finalPassed ? "DP Compliance Passed" : "NOA / DP Red Flag"}
              </div>
              <div class="noa-status-subtitle">
                ${finalPassed ? `NOA ${dpResult.noa_number || "(see product data)"}` : `${dpResult.failure_reason || dpResult.reason || "Design pressure mismatch"}. Quote can still be saved.`}
              </div>
            </div>
          </div>
          ${finalPassed ? `
            <div class="noa-result-details">
              <div class="noa-detail-item">
                <div class="noa-detail-label">DP Rating (+)</div>
                <div class="noa-detail-value">${dpResult.dp_positive ?? product?.dp_positive ?? "—"} psf</div>
              </div>
              <div class="noa-detail-item">
                <div class="noa-detail-label">DP Rating (–)</div>
                <div class="noa-detail-value">${dpResult.dp_negative ?? product?.dp_negative ?? "—"} psf</div>
              </div>
              <div class="noa-detail-item">
                <div class="noa-detail-label">Max Story</div>
                <div class="noa-detail-value">${dpResult.max_story_height ?? product?.max_story ?? "—"}</div>
              </div>
              <div class="noa-detail-item">
                <div class="noa-detail-label">HVHZ</div>
                <div class="noa-detail-value" style="color:${dpResult.hvhz_certified ? "var(--green)" : "var(--amber)"}">
                  ${dpResult.hvhz_certified !== false ? "Yes ✓" : "No"}
                </div>
              </div>
              ${dpResult.noa_number ? `
              <div class="noa-detail-item">
                <div class="noa-detail-label">NOA Number</div>
                <div class="noa-detail-value">${esc(dpResult.noa_number)}</div>
              </div>` : ""}
              ${dpResult.missile_rating ? `
              <div class="noa-detail-item">
                <div class="noa-detail-label">Missile Rating</div>
                <div class="noa-detail-value">${esc(dpResult.missile_rating)}</div>
              </div>` : ""}
            </div>` : `
            <div style="padding:16px 20px;color:var(--red);font-size:13px;">
              Red flag only: this opening can still be saved and sent for review.
            </div>`}
        </div>

        ${isMultipart && panelValidations.length > 0 ? `
        <div class="form-card">
          <div class="form-card-title">Panel Validation</div>
          ${panelValidations.map((v, i) => {
            const pPassed = v.status === "passed";
            return `
              <div class="gov-row">
                <span class="gov-row-label">Panel ${i+1}</span>
                <span style="font-size:13px;color:${pPassed ? "var(--green)" : "var(--red)"};">${pPassed ? "✓ Passed" : "✕ Failed"}</span>
              </div>`;
          }).join("")}
        </div>
        ` : ""}

        <!-- Opening Summary -->
        <div class="form-card">
          <div class="form-card-title">Opening Summary</div>
          <div class="gov-row"><span class="gov-row-label">Type</span><span class="mono" style="font-size:13px;">${openingTypeLabel(ob.openingType)}${isMultipart ? " (Assembly)" : ""}</span></div>
          <div class="gov-row"><span class="gov-row-label">Dimensions</span><span class="mono" style="font-size:13px;">${ob.width}" × ${ob.height}"</span></div>
          <div class="gov-row"><span class="gov-row-label">Floor</span><span class="mono" style="font-size:13px;">${floorLabel(ob.floorLevel)}</span></div>
          <div class="gov-row"><span class="gov-row-label">Wall Type</span><span style="font-size:13px;text-transform:uppercase;">${esc(ob.wallType || "CBS")}</span></div>
          ${!isMultipart ? `
          <div class="gov-row"><span class="gov-row-label">Product</span><span style="font-size:13px;">${esc(product?.name || "—")}</span></div>
          <div class="gov-row"><span class="gov-row-label">Glass</span><span style="font-size:13px;">${esc(glass?.name || "—")}</span></div>
          <div class="gov-row"><span class="gov-row-label">Frame</span><span style="font-size:13px;">${esc(frame?.name || "—")}</span></div>
          ${cx.length ? `<div class="gov-row"><span class="gov-row-label">Add-ons</span><span style="font-size:12px;color:var(--text-secondary);">${cx.map(c => esc(c.name)).join(", ")}</span></div>` : ""}
          ` : ob.panels.map((p, i) => {
            const pProd = STATE.products.find(x => x.id === p.productId);
            return `<div class="gov-row"><span class="gov-row-label">Panel ${i+1}</span><span style="font-size:12px;">${esc(pProd?.name || openingTypeLabel(p.productType || "—"))} · ${fmt(p.width, 1)}" × ${fmt(p.height, 1)}"</span></div>`;
          }).join("")}
        </div>

        <!-- Price Breakdown (with consumables) -->
        ${calc ? `
          <div class="price-breakdown">
            <div class="price-row">
              <span class="price-row-label">Opening Price</span>
              <span class="price-row-value">${fmtMoney(calc.sell_price)}</span>
            </div>
            ${hasPerm("can_view_cost_breakdown") ? `
            <div class="price-row">
              <span class="price-row-label">Opening Cost</span>
              <span class="price-row-value">${fmtMoney(calc.total_cost)}</span>
            </div>` : ""}
            ${isMultipart ? `
            <div class="price-row">
              <span class="price-row-label">Mull Bars (${mullCount})</span>
              <span class="price-row-value">${fmtMoney(mullTotal)}</span>
            </div>
            ${assemblyCost ? `<div class="price-row"><span class="price-row-label">Assembly Labor</span><span class="price-row-value">${fmtMoney(assemblyCost)}</span></div>` : ""}
            ${reinforcement ? `<div class="price-row"><span class="price-row-label">Reinforcement</span><span class="price-row-value">${fmtMoney(reinforcement)}</span></div>` : ""}
            ` : ""}
            ${consumableTotal > 0 ? `
            <div class="price-row" id="consumables-row" style="cursor:pointer;" onclick="toggleConsumablesDetail()">
              <span class="price-row-label">Materials &amp; Consumables ▸</span>
              <span class="price-row-value">${fmtMoney(consumableTotal)}</span>
            </div>
            <div id="consumables-detail" style="display:none;padding:8px 14px;background:var(--bg-elevated);border-radius:4px;margin:0 0 4px;">
              ${applicableConsumables.map(c => `
                <div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0;">
                  <span style="color:var(--text-secondary);">${esc(c.name)} <span style="color:var(--text-muted);">(${esc(c.unit || "per_opening")})</span></span>
                  <span class="mono">${fmtMoney(c.unit_cost)}</span>
                </div>
              `).join("")}
            </div>
            ` : ""}
            <div class="price-row total-row">
              <span class="price-row-label">Gross Margin %</span>
              <span class="price-row-value">${fmtPct(calc.margin_pct)}</span>
            </div>
            ${hasPerm("can_view_markup") ? `
            <div class="price-row" style="opacity:0.75;">
              <span class="price-row-label">Markup % (cost-plus)</span>
              <span class="price-row-value">${calc.markup_pct != null ? fmt(calc.markup_pct) + "%" : "—"}</span>
            </div>` : ""}
            ${hasPerm("can_view_cost_breakdown") && calc.breakdown ? `
            <details class="cost-breakdown-details">
              <summary class="cost-breakdown-toggle">Cost Breakdown ▸</summary>
              <div class="cost-breakdown-grid">
                <span>Base Cost</span><span class="mono">${fmtMoney(calc.breakdown.base_cost)}</span>
                ${calc.breakdown.floor_labor ? `<span>Floor Labor</span><span class="mono">${fmtMoney(calc.breakdown.floor_labor)}</span>` : ""}
                ${calc.breakdown.glass_adder ? `<span>Glass Upgrade</span><span class="mono">${fmtMoney(calc.breakdown.glass_adder)}</span>` : ""}
                ${calc.breakdown.frame_adder ? `<span>Frame Color</span><span class="mono">${fmtMoney(calc.breakdown.frame_adder)}</span>` : ""}
                ${calc.breakdown.complexity_adder ? `<span>Complexity</span><span class="mono">${fmtMoney(calc.breakdown.complexity_adder)}</span>` : ""}
                ${calc.breakdown.territory_multiplier && calc.breakdown.territory_multiplier !== 1 ? `<span>Territory ×</span><span class="mono">${fmt(calc.breakdown.territory_multiplier, 3)}</span>` : ""}
                ${calc.breakdown.global_multiplier && calc.breakdown.global_multiplier !== 1 ? `<span>Global ×</span><span class="mono">${fmt(calc.breakdown.global_multiplier, 3)}</span>` : ""}
                <span>Default Markup ×</span><span class="mono">${fmt(calc.breakdown.default_markup, 3)}</span>
              </div>
            </details>` : ""}
          </div>` : ""}

        <button class="btn btn-primary btn-full btn-lg" id="save-opening-btn">
          ${redFlag ? "Save Opening (Red Flag)" : "Save Opening ✓"}
        </button>
      </div>`;

    el("save-opening-btn").onclick = () => saveOpening(dpResult);

  } catch (e) {
    container.innerHTML = `<div class="empty-state">DP validation failed. Please try again.</div>`;
    toast("Error validating DP.", "error");
  }
}

function toggleConsumablesDetail() {
  const detail = el("consumables-detail");
  if (!detail) return;
  detail.style.display = detail.style.display === "none" ? "block" : "none";
}

async function saveOpening(dpResult) {
  const ob  = STATE.openingBuilder;
  const btn = el("save-opening-btn");
  const requiredZone = resolveRequiredZone();
  btn.disabled    = true;
  btn.textContent = "Saving…";

  try {
    const body = {
      quote_id:        ob.quoteId,
      opening_type:    ob.openingType,
      width:           ob.width,
      height:          ob.height,
      floor_level:     ob.floorLevel,
      wall_type:       ob.wallType || "cbs",
      product_id:      ob.productId,
      glass_option_id: ob.glassOptionId,
      frame_color_id:  ob.frameColorId,
      complexity_ids:  ob.complexityIds,
      zip_code:        STATE.currentQuote?.job_zip || "",
      opening_mode:    ob.openingMode,
      driveway_discount_pct: ob.drivewayDiscountPct || 0,
      requested_sell_price: ob.requestedSellPrice != null ? Number(ob.requestedSellPrice) : null,
      required_zone:   requiredZone,
      hvhz:            requiredZone === "HVHZ",
    };

    if (ob.openingMode === "multipart") {
      body.panels = ob.panels.map(p => ({
        product_id:      p.productId,
        glass_option_id: p.glassOptionId,
        frame_color_id:  p.frameColorId,
        width:           p.width,
        height:          p.height,
        product_type:    p.productType,
      }));
      body.panel_count = ob.panelCount || ob.panels.length;
      body.layout_type = ob.layoutType;
    }

    await post("/openings", body);
    if (dpResult?.status && dpResult.status !== "passed") {
      toast("NOA/DP red flag recorded (warning only).", "warning", 4500);
    }
    toast("Opening saved!", "success");
    const quote = await get(`/quotes/${ob.quoteId}`);
    STATE.currentQuote = quote;
    updateMarginRibbon(quote);
    window.location.hash = `field-quote/${ob.quoteId}`;
  } catch (e) {
    toast(parseErrorMessage(e, "Failed to save opening."), "error");
    btn.disabled    = false;
    btn.textContent = "Save Opening";
  }
}

/* ============================================================
   FIELD: APPROVAL REQUEST
   ============================================================ */
async function renderApprovalRequest(container, quoteId) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const quote = await get(`/quotes/${quoteId}`);
    const govData = getRepFloor();
    updateMarginRibbon(quote);

    const approvals = await get("/approvals?status=pending");
    const existing  = (approvals || []).find(a => a.quote_id === quoteId);

    if (existing) {
      renderApprovalPending(container, quoteId);
      return;
    }

    container.innerHTML = `
      <div class="field-screen" style="padding-bottom:80px;">
        <div class="field-screen-header">
          <button class="back-btn" onclick="window.location.hash='field-quote/${quoteId}'">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <h2 class="field-screen-title">Request Approval</h2>
        </div>

        <div class="approval-request-card">
          <div class="approval-request-icon">!</div>
          <div>
            <div class="approval-request-title">Margin Below Floor</div>
            <div class="approval-request-sub">
              Current margin is <strong class="red">${fmtPct(quote.margin_pct)}</strong>.
              Your floor is <strong>${fmtPct(govData.floor)}</strong>.
              Owner approval required to proceed.
            </div>
          </div>
        </div>

        <div class="form-card">
          <div class="form-card-title">Quote Summary</div>
          <div class="gov-row"><span class="gov-row-label">Customer</span><span>${esc(quote.customer_name)}</span></div>
          <div class="gov-row"><span class="gov-row-label">Address</span><span style="font-size:12px;">${esc(quote.job_address || "-")}</span></div>
          <div class="gov-row"><span class="gov-row-label">Total Price</span><span class="mono green">${fmtMoney(quote.total_price)}</span></div>
          <div class="gov-row"><span class="gov-row-label">Current Margin</span><span class="mono red">${fmtPct(quote.margin_pct)}</span></div>
          <div class="gov-row"><span class="gov-row-label">Margin Floor</span><span class="mono">${fmtPct(govData.floor)}</span></div>
        </div>

        <div class="form-card">
          <div class="form-card-title">Reason for Request</div>
          <div class="form-group">
            <label class="form-label">Explain why this discount is justified <span class="required">*</span></label>
            <textarea id="approval-reason" class="form-input" rows="4"
              placeholder="e.g., Competitive market situation, referral customer, large job volume..."></textarea>
          </div>
        </div>

        <div id="approval-request-error" style="color:var(--red);font-size:13px;padding:0 0 12px;"></div>
        <button class="btn btn-amber btn-full btn-lg" id="send-approval-btn">
          Send Approval Request
        </button>
      </div>`;

    el("send-approval-btn").onclick = () => sendApprovalRequest(quoteId, quote);
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Error loading quote.</div>`;
    toast("Error loading quote.", "error");
  }
}

async function sendApprovalRequest(quoteId, quote) {
  const reason = el("approval-reason").value.trim();
  if (!reason) { el("approval-request-error").textContent = "Please provide a reason."; return; }
  const btn = el("send-approval-btn");
  btn.disabled = true; btn.textContent = "Sending...";
  try {
    await post("/approvals", {
      quote_id:       quoteId,
      rep_id:         STATE.currentUser.id,
      current_margin: STATE.currentQuote?.margin_pct || 0,
      rep_note:       reason,
    });
    toast("Approval request sent!", "success");
    renderApprovalPending(el("field-screen-container"), quoteId);
  } catch (e) {
    toast("Failed to send approval request.", "error");
    btn.disabled = false; btn.textContent = "Send Approval Request";
  }
}

function renderApprovalPending(container, quoteId) {
  const ribbon = el("margin-ribbon");
  ribbon.classList.remove("hidden");
  container.innerHTML = `
    <div class="field-screen">
      <div class="field-screen-header">
        <button class="back-btn" onclick="window.location.hash='field-quote/${quoteId}'">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <h2 class="field-screen-title">Approval Pending</h2>
      </div>
      <div class="pending-state">
        <div class="pending-icon">...</div>
        <div class="pending-title">Waiting for Owner Response</div>
        <div class="pending-sub">Your approval request has been submitted.<br>${esc(currentTenantName())} will route it to an owner or manager shortly.</div>
        <button class="btn btn-ghost" style="margin-top:16px;" onclick="window.location.hash='field-quote/${quoteId}'">
          < Back to Quote
        </button>
      </div>
    </div>`;
}

/* ============================================================
   FIELD: PROPOSAL PREVIEW
   ============================================================ */
function proposalSnapshotPrintUrl(quoteId, snapshotId, token = "") {
  const quotePart = encodeURIComponent(quoteId);
  const snapshotPart = encodeURIComponent(snapshotId);
  const query = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${API}/quotes/${quotePart}/proposal/snapshot/${snapshotPart}/print${query}`;
}

function explainProposalActionError(error, fallback) {
  const message = String(error?.message || "");
  if (message.includes("Only managers or owners")) {
    return "Managers or owners can generate customer share links.";
  }
  if (message.includes("Add at least one opening")) {
    return "Add at least one opening before generating a proposal.";
  }
  if (message.includes("403")) {
    return "You do not have permission to complete that proposal action.";
  }
  return fallback;
}

async function copyTextToClipboard(value) {
  const text = String(value || "").trim();
  if (!text) return;

  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const input = document.createElement("textarea");
  input.value = text;
  input.setAttribute("readonly", "readonly");
  input.style.position = "absolute";
  input.style.left = "-9999px";
  document.body.appendChild(input);
  input.select();
  document.execCommand("copy");
  input.remove();
}

async function createProposalSnapshot(quoteId) {
  return post(`/quotes/${quoteId}/proposal/snapshot`, {});
}

function showProposalShareModal(shareUrl, expiresAt) {
  const expiryLabel = expiresAt
    ? new Date(expiresAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })
    : "7 days";

  showSimpleModal(
    "Proposal Link Ready",
    `
      <div style="display:grid;gap:12px;">
        <div style="font-size:13px;color:var(--text-secondary);">
          Send this link to your customer. It opens a branded proposal page with pricing frozen to this snapshot.
        </div>
        <input
          id="proposal-share-url"
          class="form-input"
          type="text"
          readonly
          value="${esc(shareUrl)}"
          style="font-size:12px;"
        />
        <div style="display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--text-secondary);flex-wrap:wrap;gap:6px;">
          <span>🔒 Expires: <strong>${esc(expiryLabel)}</strong></span>
          <a class="btn btn-ghost btn-sm" href="${esc(shareUrl)}" target="_blank" rel="noopener" style="font-size:11px;">Preview →</a>
        </div>
      </div>
    `,
    async () => {
      try {
        await copyTextToClipboard(shareUrl);
        toast("Share link copied.", "success");
        closeSimpleModal();
      } catch {
        toast("Failed to copy link.", "error");
      }
    }
  );

  const saveBtn = el("simple-modal-save");
  if (saveBtn) saveBtn.textContent = "Copy Link";
}

async function openProposalPrintPreview(quoteId) {
  let printWindow = null;
  try {
    printWindow = window.open("", "_blank", "noopener");
    const snapshot = await createProposalSnapshot(quoteId);
    const printUrl = proposalSnapshotPrintUrl(quoteId, snapshot.snapshot_id);
    if (printWindow) {
      printWindow.location = printUrl;
      if (typeof printWindow.focus === "function") printWindow.focus();
    } else {
      window.open(printUrl, "_blank", "noopener");
    }
  } catch (error) {
    if (printWindow && !printWindow.closed) printWindow.close();
    toast(explainProposalActionError(error, "Failed to generate proposal PDF."), "error");
  }
}

async function generateAndShareProposal(quoteId) {
  const role = (STATE.currentUser?.role || "").toLowerCase();
  if (!["manager", "owner", "sysop"].includes(role)) {
    toast("Managers or owners can generate customer share links.", "info");
    return;
  }

  try {
    // Single-call convenience endpoint: creates snapshot + share in one shot
    const result = await get(`/quotes/${quoteId}/proposal-view-token`);
    showProposalShareModal(result.url, result.expires_at);
    toast("Proposal link ready.", "success");
  } catch (error) {
    toast(explainProposalActionError(error, "Failed to generate share link."), "error");
  }
}

async function renderProposal(container, quoteId) {
  container.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  try {
    const quote = await get(`/quotes/${quoteId}`);
    const tenant = STATE.currentTenant || {};
    const govData = getRepFloor();
    updateMarginRibbon(quote);

    const validUntil = new Date(Date.now() + 30 * 86400000);
    const openings   = quote.openings || [];

    // Compute consumables total for proposal
    const wallType   = STATE.openingBuilder.wallType || "cbs";
    const appConsumables = STATE.consumables.filter(c => !c.wall_type_filter || c.wall_type_filter === wallType);
    const consumableTotal = appConsumables.reduce((sum, c) => {
      if (c.unit === "per_job") return sum + (c.unit_cost || 0);
      return sum + (c.unit_cost || 0) * openings.length;
    }, 0);

    container.innerHTML = `
      <div class="field-screen" style="padding-bottom:100px;">
        <div class="field-screen-header">
          <button class="back-btn" onclick="window.location.hash='field-quote/${quoteId}'">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M10 3L5 8l5 5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
          <h2 class="field-screen-title">Proposal Preview</h2>
        </div>

        <div class="proposal-wrapper">
          <div class="proposal-header-band">
            <div class="proposal-company-name">${esc((tenant.name || "WindowCalc").toUpperCase())}</div>
            <div class="proposal-license">${tenant.license_number ? `License #${esc(tenant.license_number)}` : "Impact Windows and Doors Estimate"}</div>
            <div class="proposal-contact">
              ${tenant.phone ? `<div class="proposal-contact-item">Phone: ${esc(tenant.phone)}</div>` : ""}
              ${tenant.email ? `<div class="proposal-contact-item">Email: ${esc(tenant.email)}</div>` : ""}
              ${tenant.address ? `<div class="proposal-contact-item">Address: ${esc(tenant.address)}</div>` : ""}
            </div>
          </div>
          <div class="proposal-body">
            <div class="proposal-meta-grid">
              <div>
                <div class="proposal-meta-section-title">Prepared For</div>
                <div class="proposal-meta-value">${esc(quote.customer_name)}</div>
                ${quote.customer_phone ? `<div class="proposal-meta-sub">${esc(quote.customer_phone)}</div>` : ""}
                ${quote.customer_email ? `<div class="proposal-meta-sub">${esc(quote.customer_email)}</div>` : ""}
              </div>
              <div>
                <div class="proposal-meta-section-title">Job Site</div>
                <div class="proposal-meta-value" style="font-size:14px;">${esc(quote.job_address || "-")}</div>
                <div class="proposal-meta-sub">Date: ${new Date().toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}</div>
                <div class="proposal-meta-sub">Rep: ${esc(quote.rep_name || STATE.currentUser.name)}</div>
              </div>
            </div>

            <div class="proposal-openings-title">${openings.length} Opening${openings.length !== 1 ? "s" : ""} Included</div>
            ${openings.map((op, i) => `
              <div class="proposal-opening-item">
                <div class="proposal-opening-header">
                  <div>
                    <div class="proposal-opening-num">OPENING #${op.opening_number || i+1}</div>
                    <div class="proposal-opening-type">${openingTypeLabel(op.opening_type)}${op.opening_mode === "multipart" ? " — Assembly" : ""}</div>
                  </div>
                  <div class="proposal-opening-price">${fmtMoney(op.sell_price)}</div>
                </div>
                <div class="proposal-opening-specs">
                  <div class="proposal-spec">Dimensions: <span>${op.width}" × ${op.height}"</span></div>
                  <div class="proposal-spec">Floor: <span>${floorLabel(op.floor_level)}</span></div>
                  ${op.product_name ? `<div class="proposal-spec">Product: <span>${esc(op.product_name)}</span></div>` : ""}
                  ${op.glass_name ? `<div class="proposal-spec">Glass: <span>${esc(op.glass_name)}</span></div>` : ""}
                  ${op.frame_name ? `<div class="proposal-spec">Frame: <span>${esc(op.frame_name)}</span></div>` : ""}
                </div>
                ${op.noa_number ? `<div class="proposal-noa">NOA Ref: ${esc(op.noa_number)}</div>` : ""}
              </div>
            `).join("")}

            ${consumableTotal > 0 ? `
              <div style="margin:16px 0;padding:12px 16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
                  <span style="font-size:13px;font-weight:600;color:var(--text-secondary);">Materials &amp; Consumables</span>
                  <span style="font-family:var(--font-mono);font-size:14px;">${fmtMoney(consumableTotal)}</span>
                </div>
                ${appConsumables.map(c => `
                  <div style="display:flex;justify-content:space-between;font-size:11px;padding:2px 0;color:var(--text-muted);">
                    <span>${esc(c.name)}</span>
                    <span>${fmtMoney(c.unit_cost)} / ${esc(c.unit || "opening")}</span>
                  </div>
                `).join("")}
              </div>
            ` : ""}

            <div class="proposal-total-band">
              <div>
                <div class="proposal-total-label">Total Project Investment</div>
                <div class="proposal-valid">Valid until ${validUntil.toLocaleDateString("en-US",{month:"long",day:"numeric",year:"numeric"})}</div>
              </div>
              <div style="text-align:right;">
                <div class="proposal-total-price">${fmtMoney(quote.total_price)}</div>
              </div>
            </div>

            <div class="proposal-signature">
              <div>
                <div class="signature-line"></div>
                <div class="signature-label">Customer Signature</div>
              </div>
              <div>
                <div class="signature-line"></div>
                <div class="signature-label">Date Accepted</div>
              </div>
            </div>
          </div>
        </div>

        <div class="field-bottom-bar">
          <button class="btn btn-ghost btn-full" onclick="openProposalPrintPreview('${quote.id}')">
            Print / Save PDF
          </button>
          <button class="btn btn-primary btn-full" onclick="generateAndShareProposal('${quote.id}')">
            Generate & Share
          </button>
        </div>
      </div>`;
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Failed to load proposal.</div>`;
    toast("Error generating proposal.", "error");
  }
}

/* ============================================================
   INDEX.HTML PATCH: Add subsection tabs for consumables and assembly
   (Dynamically injected on products tab load)
   ============================================================ */
function ensureProductSubsections() {
  const subsectionTabs = qs(".subsection-tabs");
  if (!subsectionTabs) return;

  // Add consumables tab if not present
  if (!qs('[data-subsection="consumables"]')) {
    const cTab = document.createElement("button");
    cTab.className = "subsection-tab";
    cTab.dataset.subsection = "consumables";
    cTab.textContent = "Consumables";
    subsectionTabs.appendChild(cTab);
  }
  // Add assembly templates tab if not present
  if (!qs('[data-subsection="assembly"]')) {
    const aTab = document.createElement("button");
    aTab.className = "subsection-tab";
    aTab.dataset.subsection = "assembly";
    aTab.textContent = "Assembly Templates";
    subsectionTabs.appendChild(aTab);
  }

  const productSubSection = qs(".product-sub-section");
  if (!productSubSection) return;

  // Add consumables content panel if not present
  if (!el("subsection-consumables")) {
    const cContent = document.createElement("div");
    cContent.id = "subsection-consumables";
    cContent.className = "subsection-content";
    productSubSection.appendChild(cContent);
  }
  // Add assembly templates content panel if not present
  if (!el("subsection-assembly")) {
    const aContent = document.createElement("div");
    aContent.id = "subsection-assembly";
    aContent.className = "subsection-content";
    productSubSection.appendChild(aContent);
  }
}

// ensureProductSubsections() is called inside loadProducts() directly

/* ============================================================
   REFRESH HELPER
   ============================================================ */
function refreshCurrentView() {
  if (STATE.mode === 'admin') {
    const activeTab = document.querySelector('.sidebar-item.active')?.dataset.tab;
    if (activeTab === 'dashboard') loadAdminDashboard();
    else if (activeTab === 'reports') loadReportsTab();
    else if (activeTab === 'products') loadProducts();
    else if (activeTab === 'approvals') loadApprovalQueue();
    else if (activeTab === 'chats') loadChatThreadsTab();
    else if (activeTab === 'governance') loadGovernance();
    else if (activeTab === 'users') loadUsersTab();
    else if (activeTab === 'system') loadSystemConsole();
    else if (activeTab === 'audit') loadAuditLog();
  }
  toast('Refreshed', 'info', 1500);
}

/* ============================================================
   MOBILE BOTTOM NAV
   ============================================================ */
function mobileNavTo(tab) {
  if (tab === 'field') {
    switchMode('field');
  } else {
    switchMode('admin');
    switchAdminTab(tab);
  }
  // Update active state
  document.querySelectorAll('.bottom-nav-item').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tab || (tab === 'field' && btn.classList.contains('fab-main')));
  });
}

/* ============================================================
   DRAG AND DROP OPENINGS
   ============================================================ */
function enableOpeningDragDrop() {
  const container = document.getElementById('field-screen-container');
  if (!container) return;

  let draggedEl = null;

  container.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.opening-card');
    if (!card) return;
    draggedEl = card;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  });

  container.addEventListener('dragover', (e) => {
    e.preventDefault();
    const card = e.target.closest('.opening-card');
    if (card && card !== draggedEl) {
      card.classList.add('drag-over');
    }
  });

  container.addEventListener('dragleave', (e) => {
    const card = e.target.closest('.opening-card');
    if (card) card.classList.remove('drag-over');
  });

  container.addEventListener('drop', (e) => {
    e.preventDefault();
    const card = e.target.closest('.opening-card');
    if (card && card !== draggedEl) {
      card.classList.remove('drag-over');
      // Reorder would need API support — for now visual swap
      toast('Opening reordered', 'success', 1500);
    }
  });

  container.addEventListener('dragend', () => {
    if (draggedEl) draggedEl.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el2 => el2.classList.remove('drag-over'));
  });
}

/* ============================================================
   SCROLL ANIMATIONS
   ============================================================ */
function initScrollAnimations() {
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('visible');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' });

  document.querySelectorAll('.fade-in-up, .observe').forEach(el2 => observer.observe(el2));
}

/* ============================================================
   SPARKLINE RENDERING
   ============================================================ */
function renderSparkline(containerId, data, color = 'var(--green)') {
  const container = document.getElementById(containerId);
  if (!container) return;
  const wrap = document.createElement('div');
  wrap.className = 'sparkline-wrap';
  const max = Math.max(...data);
  const min = Math.min(...data);
  const range = max - min || 1;
  const w = 80, h = 24;
  const points = data.map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`).join(' ');
  wrap.innerHTML = `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline points="${points}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  container.appendChild(wrap);
}

/* ============================================================
   KEYBOARD SHORTCUTS
   ============================================================ */
document.addEventListener('keydown', (e) => {
  // Don't fire when typing in inputs
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
  if (e.target.isContentEditable) return;

  const key = e.key.toLowerCase();

  // Command palette: Cmd+K or Ctrl+K
  if ((e.metaKey || e.ctrlKey) && key === 'k') {
    e.preventDefault();
    toggleCommandPalette();
    return;
  }

  // ? shows shortcuts
  if (key === '?' || (e.shiftKey && key === '/')) {
    e.preventDefault();
    toggleShortcutOverlay();
    return;
  }

  // Escape closes modals
  if (key === 'escape') {
    closeAllOverlays();
    return;
  }

  // Navigation shortcuts (admin mode only)
  if (STATE.mode === 'admin') {
    const tabMap = { d: 'dashboard', o: 'reports', p: 'products', a: 'approvals', c: 'chats', g: 'governance', l: 'audit', u: 'users' };
    if (tabMap[key]) {
      e.preventDefault();
      switchAdminTab(tabMap[key]);
      return;
    }
  }

  // T = toggle theme
  if (key === 't') { toggleTheme(); return; }
  // F = field mode
  if (key === 'f') { switchMode('field'); return; }
  // N = new quote (field mode)
  if (key === 'n' && STATE.mode === 'field') { navigateTo('field-new-quote'); return; }
  // R = refresh
  if (key === 'r') { e.preventDefault(); refreshCurrentView(); return; }
});

function toggleShortcutOverlay() {
  const overlay = document.getElementById('shortcut-overlay');
  if (overlay) overlay.classList.toggle('hidden');
}

function toggleCommandPalette() {
  const palette = document.getElementById('command-palette');
  if (!palette) return;
  const isHidden = palette.classList.contains('hidden');
  palette.classList.toggle('hidden');
  if (isHidden) {
    const input = document.getElementById('palette-search');
    if (input) { input.value = ''; input.focus(); }
    renderPaletteResults('');
  }
}

function closeAllOverlays() {
  document.getElementById('shortcut-overlay')?.classList.add('hidden');
  document.getElementById('command-palette')?.classList.add('hidden');
  document.getElementById('quote-modal')?.classList.add('hidden');
  document.getElementById('product-modal-overlay')?.remove();
}

function renderPaletteResults(query) {
  const results = document.getElementById('palette-results');
  if (!results) return;

  const commands = [
    { label: 'Go to Dashboard', action: () => { switchMode('admin'); switchAdminTab('dashboard'); }, icon: 'DB' },
    { label: 'Go to Reports', action: () => { switchMode('admin'); switchAdminTab('reports'); }, icon: 'RP' },
    { label: 'Go to Products', action: () => { switchMode('admin'); switchAdminTab('products'); }, icon: 'PR' },
    { label: 'Go to Approvals', action: () => { switchMode('admin'); switchAdminTab('approvals'); }, icon: 'AP' },
    { label: 'Go to Governance', action: () => { switchMode('admin'); switchAdminTab('governance'); }, icon: 'GV' },
    { label: 'Go to Audit Log', action: () => { switchMode('admin'); switchAdminTab('audit'); }, icon: 'AU' },
    { label: 'Switch to Field App', action: () => switchMode('field'), icon: 'FD' },
    { label: 'New Quote', action: () => { switchMode('field'); setTimeout(() => navigateTo('field-new-quote'), 100); }, icon: 'NQ' },
    { label: 'Toggle Theme', action: () => toggleTheme(), icon: 'TH' },
    { label: 'Refresh Data', action: () => refreshCurrentView(), icon: 'RF' },
    { label: 'Keyboard Shortcuts', action: () => toggleShortcutOverlay(), icon: 'KB' },
  ];

  const q = query.toLowerCase();
  const filtered = q ? commands.filter(c => c.label.toLowerCase().includes(q)) : commands;

  results.innerHTML = filtered.map((c, i) => `
    <div class="palette-result ${i === 0 ? 'active' : ''}" data-index="${i}" onclick="executePaletteCommand(${i})">
      <span style="margin-right:8px;">${c.icon}</span> ${c.label}
    </div>
  `).join('') || '<div class="palette-result" style="color:var(--text-muted);cursor:default;">No results</div>';

  // Store for keyboard nav
  window._paletteCommands = filtered;
  window._paletteIndex = 0;
}

function executePaletteCommand(index) {
  const cmd = window._paletteCommands?.[index];
  if (cmd) {
    document.getElementById('command-palette')?.classList.add('hidden');
    cmd.action();
  }
}

// Command palette search + keyboard nav
document.addEventListener('DOMContentLoaded', () => {
  const paletteSearch = document.getElementById('palette-search');
  if (paletteSearch) {
    paletteSearch.addEventListener('input', (e) => renderPaletteResults(e.target.value));
    paletteSearch.addEventListener('keydown', (e) => {
      const items = document.querySelectorAll('.palette-result');
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        window._paletteIndex = Math.min((window._paletteIndex || 0) + 1, items.length - 1);
        items.forEach((r, i) => r.classList.toggle('active', i === window._paletteIndex));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        window._paletteIndex = Math.max((window._paletteIndex || 0) - 1, 0);
        items.forEach((r, i) => r.classList.toggle('active', i === window._paletteIndex));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        executePaletteCommand(window._paletteIndex || 0);
      }
    });
  }

  // Click outside to close command palette
  document.getElementById('command-palette')?.addEventListener('click', (e) => {
    if (e.target.id === 'command-palette') e.target.classList.add('hidden');
  });
});

/* ============================================================
   ENTERPRISE AUTH + RBAC OVERRIDES (2026)
   ============================================================ */

const ENTERPRISE_PERMISSION_KEYS = [
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
  "can_view_cost_breakdown",
  "can_view_markup",
  "can_view_leads",
  "can_manage_leads",
  "can_export_leads",
];

const ROLE_DEFAULTS = {
  sysop: Object.fromEntries(ENTERPRISE_PERMISSION_KEYS.map((k) => [k, true])),
  owner: {
    can_access_admin_hub: true,
    can_access_field_app: true,
    can_view_dashboard: true,
    can_view_products: true,
    can_manage_products: true,
    can_view_governance: true,
    can_manage_governance: true,
    can_view_approvals: true,
    can_decide_approvals: true,
    can_view_audit_log: true,
    can_view_all_quotes: true,
    can_create_quotes: true,
    can_edit_quotes: true,
    can_delete_openings: true,
    can_submit_approval_requests: true,
    can_view_margins: true,
    can_set_discounts: true,
    can_manage_users: true,
    can_reset_passwords: true,
    can_manage_feature_flags: true,
    can_use_impersonation: true,
    can_view_cost_breakdown: true,
    can_view_markup: true,
  },
  manager: {
    can_access_admin_hub: true,
    can_access_field_app: true,
    can_view_dashboard: true,
    can_view_products: true,
    can_manage_products: true,
    can_view_governance: true,
    can_manage_governance: false,
    can_view_approvals: true,
    can_decide_approvals: true,
    can_view_audit_log: true,
    can_view_all_quotes: true,
    can_create_quotes: true,
    can_edit_quotes: true,
    can_delete_openings: true,
    can_submit_approval_requests: true,
    can_view_margins: true,
    can_set_discounts: true,
    can_manage_users: true,
    can_reset_passwords: true,
    can_manage_feature_flags: false,
    can_use_impersonation: true,
    can_view_cost_breakdown: true,
    can_view_markup: true,
  },
  rep: {
    can_access_admin_hub: false,
    can_access_field_app: true,
    can_view_dashboard: false,
    can_view_products: true,
    can_manage_products: false,
    can_view_governance: false,
    can_manage_governance: false,
    can_view_approvals: true,
    can_decide_approvals: false,
    can_view_audit_log: false,
    can_view_all_quotes: false,
    can_create_quotes: true,
    can_edit_quotes: true,
    can_delete_openings: true,
    can_submit_approval_requests: true,
    can_view_margins: true,
    can_set_discounts: true,
    can_manage_users: false,
    can_reset_passwords: false,
    can_manage_feature_flags: false,
    can_use_impersonation: false,
    can_view_cost_breakdown: false,
    can_view_markup: false,
  },
  viewer: {
    can_access_admin_hub: false,
    can_access_field_app: true,
    can_view_dashboard: false,
    can_view_products: true,
    can_manage_products: false,
    can_view_governance: false,
    can_manage_governance: false,
    can_view_approvals: false,
    can_decide_approvals: false,
    can_view_audit_log: false,
    can_view_all_quotes: false,
    can_create_quotes: false,
    can_edit_quotes: false,
    can_delete_openings: false,
    can_submit_approval_requests: false,
    can_view_margins: false,
    can_set_discounts: false,
    can_manage_users: false,
    can_reset_passwords: false,
    can_manage_feature_flags: false,
    can_use_impersonation: false,
    can_view_cost_breakdown: false,
    can_view_markup: false,
  },
};

const PERMISSION_LABELS = {
  can_access_admin_hub: "Access Admin Hub",
  can_access_field_app: "Access Field App",
  can_view_dashboard: "View Dashboard",
  can_view_products: "View Products",
  can_manage_products: "Manage Products",
  can_view_governance: "View Governance",
  can_manage_governance: "Manage Governance",
  can_view_approvals: "View Approvals",
  can_decide_approvals: "Decide Approvals",
  can_view_audit_log: "View Audit Log",
  can_view_all_quotes: "View All Quotes",
  can_create_quotes: "Create Quotes",
  can_edit_quotes: "Edit Quotes",
  can_delete_openings: "Delete Openings",
  can_submit_approval_requests: "Submit Approval Requests",
  can_view_margins: "View Gross Margin %",
  can_set_discounts: "Set Discounts",
  can_manage_users: "Manage Users",
  can_reset_passwords: "Reset Passwords",
  can_manage_feature_flags: "Manage Feature Flags",
  can_use_impersonation: "Use Impersonation",
  can_view_cost_breakdown: "View Cost Breakdown",
  can_view_markup: "View Markup % (Cost-Plus)",
  can_view_leads: "View Lead Tracker",
  can_manage_leads: "Manage Leads (status, notes, tags)",
  can_export_leads: "Export Leads CSV",
};

STATE.currentUser = null;
STATE.auth = { ready: false, impersonatedBy: null, impersonator: null, switchingTenant: false };
STATE.selectedUserPermTarget = null;

function roleClass(role) {
  const r = String(role || "viewer").toLowerCase();
  return `role-${["sysop", "owner", "manager", "rep", "viewer"].includes(r) ? r : "viewer"}`;
}

function hasPerm(key) {
  const user = STATE.currentUser;
  if (!user) return false;
  if ((user.role || "").toLowerCase() === "sysop") return true;
  return !!(user.permissions && user.permissions[key]);
}

function currentTenantName() {
  return STATE.currentTenant?.name || STATE.currentUser?.tenant_id || "WindowCalc";
}

function clearLoginTenantChoices() {
  STATE.loginTenantChoices = [];
  const wrap = el("login-tenant-options");
  if (wrap) {
    wrap.innerHTML = "";
    wrap.classList.add("hidden");
  }
}

function renderLoginTenantChoices(message, tenants) {
  const wrap = el("login-tenant-options");
  STATE.loginTenantChoices = Array.isArray(tenants) ? tenants : [];
  if (!wrap || !STATE.loginTenantChoices.length) {
    clearLoginTenantChoices();
    return;
  }
  wrap.classList.remove("hidden");
  wrap.innerHTML = `
    <div class="login-tenant-intro">${esc(message || "Choose a company to continue.")}</div>
    <div class="login-tenant-list">
      ${STATE.loginTenantChoices.map((tenant) => `
        <button class="login-tenant-choice" type="button" data-tenant-id="${esc(tenant.id || "")}">
          <span class="login-tenant-choice-name">${esc(tenant.name || tenant.id || "Company")}</span>
          <span class="login-tenant-choice-meta">${esc((tenant.role || "user").toUpperCase())} | ${esc(tenant.id || "")}</span>
        </button>
      `).join("")}
    </div>
  `;
  qsa("#login-tenant-options .login-tenant-choice").forEach((button) => {
    button.addEventListener("click", () => {
      if (el("login-tenant")) el("login-tenant").value = button.dataset.tenantId || "";
      if (el("login-error")) el("login-error").textContent = "";
      el("login-form")?.requestSubmit();
    });
  });
}

function syncTenantUi() {
  const tenant = STATE.currentTenant || {};
  const companyName = tenant.name || STATE.currentUser?.tenant_id || "No Company Selected";
  if (el("session-company-name")) el("session-company-name").textContent = companyName;
  if (el("sidebar-tenant-name")) el("sidebar-tenant-name").textContent = companyName;

  const select = el("tenant-switcher");
  const wrap = el("tenant-switcher-wrap");
  const tenants = Array.isArray(STATE.availableTenants) ? STATE.availableTenants : [];
  if (select && wrap) {
    if (tenants.length > 1 && !STATE.auth?.impersonatedBy) {
      select.innerHTML = tenants
        .map((item) => `<option value="${esc(item.id || "")}">${esc(item.name || item.id || "Company")} | ${esc(item.role || "user")}</option>`)
        .join("");
      select.value = tenant.id || STATE.currentUser?.tenant_id || "";
      select.disabled = !!STATE.auth?.switchingTenant;
      wrap.classList.remove("hidden");
    } else {
      wrap.classList.add("hidden");
      select.innerHTML = "";
    }
  }

  document.title = `${companyName} | WindowCalc`;
}

// Core auth shell logic — called by showAuthShell/hideAuthShell wrappers below.
// Not called directly anywhere else; use showAuthShell() and hideAuthShell().
function _coreShowAuthShell(errorMessage = "") {
  document.body.classList.add("auth-required");
  el("auth-shell")?.classList.remove("hidden");
  if (el("login-error")) el("login-error").textContent = errorMessage || "";
  if (el("impersonation-banner")) el("impersonation-banner").classList.add("hidden");
  STATE.currentTenant = null;
  STATE.availableTenants = [];
  syncTenantUi();
  setApiStatus("error");
}

function _coreHideAuthShell() {
  document.body.classList.remove("auth-required");
  el("auth-shell")?.classList.add("hidden");
  clearLoginTenantChoices();
}

function applyPermissions() {
  const user = STATE.currentUser;
  if (!user) return;

  const roleBadge = el("session-role-badge");
  if (roleBadge) {
    roleBadge.textContent = user.role || "viewer";
    roleBadge.className = `role-badge ${roleClass(user.role)}`;
  }
  if (el("session-user-name")) el("session-user-name").textContent = user.name || user.email || "User";

  const adminBtn = el("btn-mode-admin");
  const fieldBtn = el("btn-mode-field");
  if (adminBtn) adminBtn.style.display = hasPerm("can_access_admin_hub") ? "" : "none";
  if (fieldBtn) fieldBtn.style.display = hasPerm("can_access_field_app") ? "" : "none";

  const tabPerm = {
    dashboard: hasPerm("can_view_dashboard"),
    reports: canAccessReports(),
    approvals: hasPerm("can_view_approvals"),
    chats: hasPerm("can_access_admin_hub") && canUseChatInbox(),
    products: hasPerm("can_view_products"),
    governance: hasPerm("can_view_governance"),
    audit: hasPerm("can_view_audit_log"),
    users: hasPerm("can_manage_users"),
    system: (user.role || "").toLowerCase() === "sysop",
  };

  Object.entries(tabPerm).forEach(([tab, allowed]) => {
    qsa(`.sidebar-item[data-tab="${tab}"], .bottom-nav-item[data-tab="${tab}"]`).forEach((btn) => {
      btn.style.display = allowed ? "" : "none";
    });
  });

  document.body.classList.toggle("ui-hide-margin", !hasPerm("can_view_margins"));
  document.body.classList.toggle("perm-products-readonly", !hasPerm("can_manage_products"));
  document.body.classList.toggle("perm-governance-readonly", !hasPerm("can_manage_governance"));

  if (el("save-governance")) {
    el("save-governance").style.display = hasPerm("can_manage_governance") ? "" : "none";
  }

  syncImpersonationBanner();
  syncTenantUi();
  applyUiVisibility();
  _syncPISidebarButton();
  _syncLeadsSidebarButton();
  _syncMasterLibrarySidebarButton();
}

function syncImpersonationBanner() {
  const banner = el("impersonation-banner");
  const label = el("impersonation-label");
  if (!banner || !label) return;

  const active = !!STATE.auth?.impersonatedBy;
  banner.classList.toggle("hidden", !active);
  if (!active) return;

  const currentName = STATE.currentUser?.name || STATE.currentUser?.email || "selected user";
  const originalName = STATE.auth?.impersonator?.name || "your account";
  label.textContent = `Viewing as ${currentName}. Return to ${originalName} when finished.`;
}

function switchToFieldApp() {
  if (!hasPerm("can_access_field_app")) return;
  STATE.mode = "field";
  qsa(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === "field"));
  el("admin-hub")?.classList.add("hidden");
  el("field-app")?.classList.remove("hidden");
  if (!window.location.hash || window.location.hash === "#") window.location.hash = "field-home";
  handleHashChange();
}

function switchToAdminHub() {
  if (!hasPerm("can_access_admin_hub")) return;
  STATE.mode = "admin";
  qsa(".mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.mode === "admin"));
  el("admin-hub")?.classList.remove("hidden");
  el("field-app")?.classList.add("hidden");
  switchAdminTab(firstAllowedAdminTab());
}

function firstAllowedAdminTab() {
  const order = ["dashboard", "reports", "chats", "approvals", "products", "governance", "users", "audit", "system"];
  return order.find((t) => {
    const node = qs(`.sidebar-item[data-tab="${t}"]`);
    return node && node.style.display !== "none";
  }) || "dashboard";
}
async function apiFetch(path, options = {}) {
  const url = `${API}${path}`;
  const isJsonBody = options.body != null && !(options.body instanceof FormData);
  const headers = {
    ...(isJsonBody ? { "Content-Type": "application/json" } : {}),
    ...(options.headers || {}),
  };

  const res = await fetch(url, {
    credentials: "include",
    ...options,
    headers,
  });

  const raw = await res.text().catch(() => "");
  let payload = {};
  if (raw) {
    try { payload = JSON.parse(raw); } catch { payload = { message: raw }; }
  }

  if (!res.ok) {
    const msg = payload.error || payload.message || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.payload = payload;

    if (res.status === 401 && path !== "/login") {
      enterUnauthenticatedState("Session expired. Please sign in again.");
    }

    throw err;
  }

  return payload;
}

function parseErrorMessage(error, fallback = "Request failed") {
  if (!error) return fallback;
  if (typeof error === "string") return error;
  return error.payload?.message || error.payload?.error || error.message || fallback;
}

function setupUserSelector() {
  if (window.__sessionUiBound) return;
  window.__sessionUiBound = true;

  el("logout-btn")?.addEventListener("click", async () => {
    try { await post("/logout", {}); } catch {}
    STATE.currentUser = null;
    STATE.currentTenant = null;
    STATE.availableTenants = [];
    STATE.auth.impersonatedBy = null;
    STATE.auth.impersonator = null;
    showAuthShell("You have been signed out.");
  });

  el("change-password-btn")?.addEventListener("click", () => {
    el("password-modal")?.classList.remove("hidden");
    if (el("cp-error")) el("cp-error").textContent = "";
  });

  el("cp-cancel-btn")?.addEventListener("click", closePasswordModal);
  el("password-modal-close")?.addEventListener("click", closePasswordModal);
  el("cp-save-btn")?.addEventListener("click", savePasswordChange);
  el("impersonation-return-btn")?.addEventListener("click", revertImpersonation);
  el("tenant-switcher")?.addEventListener("change", async (event) => {
    const nextTenantId = event.target?.value || "";
    if (!nextTenantId || nextTenantId === STATE.currentTenant?.id) return;
    await switchTenantContext(nextTenantId);
  });
  el("login-tenant")?.addEventListener("input", () => clearLoginTenantChoices());

  const loginForm = el("login-form");
  loginForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = (el("login-email")?.value || "").trim();
    const password = el("login-password")?.value || "";
    const tenant = (el("login-tenant")?.value || "").trim();

    if (!email || !password) {
      if (el("login-error")) el("login-error").textContent = "Email and password are required.";
      return;
    }

    const submitBtn = el("login-submit");
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = "Signing In...";
    }

    try {
      await post("/login", { email, password, ...(tenant ? { tenant_id: tenant } : {}) });
      if (el("login-password")) el("login-password").value = "";
      if (el("login-error")) el("login-error").textContent = "";
      clearLoginTenantChoices();
      await loadInitialData();
    } catch (err) {
      if (err?.payload?.error === "tenant_selection_required") {
        if (el("login-error")) el("login-error").textContent = err.payload.message || "Choose a company to continue.";
        renderLoginTenantChoices(err.payload.message, err.payload.tenants || []);
      } else {
        clearLoginTenantChoices();
        if (el("login-error")) el("login-error").textContent = err.message || "Login failed";
      }
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Sign In";
      }
    }
  });

  el("perms-modal-close")?.addEventListener("click", closePermsModal);
  el("perms-cancel-btn")?.addEventListener("click", closePermsModal);
  el("perms-save-btn")?.addEventListener("click", savePermissions);
}

async function switchTenantContext(tenantId) {
  if (!tenantId) return;
  STATE.auth.switchingTenant = true;
  syncTenantUi();
  try {
    await post("/session/switch-tenant", { tenant_id: tenantId });
    toast("Company switched.", "success");
    await loadInitialData();
  } catch (err) {
    toast(parseErrorMessage(err, "Unable to switch company."), "error");
  } finally {
    STATE.auth.switchingTenant = false;
    syncTenantUi();
  }
}

function closePasswordModal() {
  el("password-modal")?.classList.add("hidden");
  ["cp-current", "cp-next", "cp-confirm"].forEach((id) => {
    if (el(id)) el(id).value = "";
  });
  if (el("cp-error")) el("cp-error").textContent = "";
}

async function savePasswordChange() {
  const currentPassword = el("cp-current")?.value || "";
  const newPassword = el("cp-next")?.value || "";
  const confirm = el("cp-confirm")?.value || "";

  if (newPassword.length < 8) {
    if (el("cp-error")) el("cp-error").textContent = "New password must be at least 8 characters.";
    return;
  }
  if (newPassword !== confirm) {
    if (el("cp-error")) el("cp-error").textContent = "Password confirmation does not match.";
    return;
  }

  try {
    await post("/change-password", { current_password: currentPassword, new_password: newPassword });
    toast("Password updated.", "success");
    closePasswordModal();
  } catch (err) {
    if (el("cp-error")) el("cp-error").textContent = err.message || "Unable to change password.";
  }
}

function countEnabledPermissions(permissions) {
  return ENTERPRISE_PERMISSION_KEYS.filter((k) => !!permissions?.[k]).length;
}

function defaultPermsForRole(role) {
  return ROLE_DEFAULTS[(role || "rep").toLowerCase()] || ROLE_DEFAULTS.rep;
}

async function loadInitialData() {
  setupUserSelector();
  setApiStatus("connecting");

  try {
    const me = await get("/me");
    if (!me?.user) {
      showAuthShell("Please sign in.");
      return;
    }

    STATE.currentUser = me.user;
    STATE.currentTenant = me.tenant || null;
    STATE.availableTenants = me.available_tenants || (me.tenant ? [me.tenant] : []);
    STATE.auth.impersonatedBy = me.impersonated_by || null;
    STATE.auth.impersonator = me.impersonator || null;
    hideAuthShell();
    applyPermissions();

    const canViewProducts = hasPerm("can_view_products");
    const canManageUsers = hasPerm("can_manage_users");
    const canViewGov = hasPerm("can_view_governance");

    const [products, glass, colors, complexity, users, gov, consumables, templates, globalSettings, dpRatings, system] = await Promise.all([
      canViewProducts ? get("/products").catch(() => []) : Promise.resolve([]),
      canViewProducts ? get("/glass-options").catch(() => []) : Promise.resolve([]),
      canViewProducts ? get("/frame-colors").catch(() => []) : Promise.resolve([]),
      canViewProducts ? get("/complexity-items").catch(() => []) : Promise.resolve([]),
      canManageUsers ? get("/users").catch(() => []) : Promise.resolve([]),
      canViewGov ? get("/governance").catch(() => []) : Promise.resolve([]),
      get("/consumables").catch(() => []),
      get("/assembly-templates").catch(() => []),
      canViewGov ? get("/global-settings").catch(() => ({})) : Promise.resolve({}),
      get("/dp-ratings").catch(() => []),
      get("/health").catch(() => ({})),
    ]);

    STATE.products = products || [];
    STATE.glassOptions = glass || [];
    STATE.frameColors = colors || [];
    STATE.complexityItems = complexity || [];
    STATE.users = users || [];
    STATE.governance = gov || [];
    STATE.consumables = consumables || [];
    STATE.assemblyTemplates = templates || [];
    STATE.globalSettings = normalizeGlobalSettings(globalSettings || {});
    STATE.dpRatings = dpRatings || [];
    STATE.system = system || {};

    applyUiVisibility();
    setApiStatus("connected");

    if (hasPerm("can_access_admin_hub")) switchToAdminHub();
    else if (hasPerm("can_access_field_app")) switchToFieldApp();
    else showAuthShell("No app access has been granted for this account.");

    STATE.auth.ready = true;
  } catch (err) {
    showAuthShell(parseErrorMessage(err, "Sign in required."));
  }
}

function switchMode(mode) {
  if (mode === "admin" && !hasPerm("can_access_admin_hub")) {
    toast("No access to Admin Hub.", "warning");
    return;
  }
  if (mode === "field" && !hasPerm("can_access_field_app")) {
    toast("No access to Field App.", "warning");
    return;
  }

  if (mode === "admin") switchToAdminHub();
  else switchToFieldApp();
}

function switchAdminTab(tab) {
  const tabPermMap = {
    dashboard: "can_view_dashboard",
    reports: null,
    approvals: "can_view_approvals",
    chats: null,
    products: "can_view_products",
    governance: "can_view_governance",
    audit: "can_view_audit_log",
    users: "can_manage_users",
    system: "can_manage_feature_flags",
  };

  if (tab === "system" && (STATE.currentUser?.role || "") !== "sysop") {
    toast("System Console is restricted to sysop.", "warning");
    return;
  }
  if (tab === "reports" && !canAccessReports()) {
    const fallback = firstAllowedAdminTab();
    if (fallback && fallback !== tab) switchAdminTab(fallback);
    else toast("Reports are available to owners and managers.", "warning");
    return;
  }
  if (tab === "chats" && !canUseChatInbox()) {
    const fallback = firstAllowedAdminTab();
    if (fallback && fallback !== tab) switchAdminTab(fallback);
    return;
  }

  const required = tabPermMap[tab];
  if (required && !hasPerm(required)) {
    const fallback = firstAllowedAdminTab();
    if (fallback && fallback !== tab) switchAdminTab(fallback);
    return;
  }

  qsa(".sidebar-item").forEach((i) => i.classList.toggle("active", i.dataset.tab === tab));
  qsa(".admin-tab").forEach((t) => t.classList.toggle("active", t.id === `tab-${tab}`));

  switch (tab) {
    case "dashboard": loadAdminDashboard(); break;
    case "reports": loadReportsTab(); break;
    case "pipeline": renderPipelineView(el("pipeline-board-container")); break;
    case "approvals": loadApprovalQueue(); break;
    case "chats": loadChatThreadsTab(); break;
    case "products": loadProducts(); break;
    case "governance": loadGovernance(); break;
    case "audit": loadAuditLog(); break;
    case "users": loadUsersTab(); break;
    case "system": loadSystemConsole(); break;
    case "leads": loadLeadsTab(); break;
    case "master-library": loadMasterLibrary(); break;
    case "pricing-intelligence": openPricingIntelligencePanel(); break;
    default: loadAdminDashboard(); break;
  }
}
function renderQuoteFeed(quotes) {
  const feed = el("quote-feed");
  if (!feed) return;

  const canAllQuotes = hasPerm("can_view_all_quotes");
  const canViewMargins = hasPerm("can_view_margins");
  const filtered = canAllQuotes ? (quotes || []) : (quotes || []).filter((q) => q.rep_id === STATE.currentUser?.id);

  if (!filtered.length) {
    feed.innerHTML = `<div class="empty-state"><div class="empty-icon">List</div>No quotes found</div>`;
    return;
  }

  const govData = getRepFloor();
  feed.innerHTML = `
    <div class="feed-header-row">
      <div class="feed-col-label">Customer / Address</div>
      <div class="feed-col-label">Rep</div>
      <div class="feed-col-label">Status</div>
      <div class="feed-col-label">Updated</div>
      ${canViewMargins ? '<div class="feed-col-label">Margin</div>' : ''}
      <div class="feed-col-label">Total</div>
      <div class="feed-col-label">Action</div>
    </div>
  ` + filtered.map((q) => {
    const mc = marginColor(q.margin_pct, govData.floor, govData.yellow);
    return `
      <div class="quote-feed-row" data-id="${q.id}" onclick="openQuoteModal('${q.id}')">
        <div>
          <div class="qf-customer">${esc(q.customer_name)}</div>
          <div class="qf-address">${esc(q.job_address || "-")}</div>
        </div>
        <div class="qf-rep">${esc(q.rep_name || "-")}</div>
        <div><span class="badge-status ${q.status}">${statusLabel(q.status)}</span></div>
        <div class="qf-time">${timeSince(q.updated_at)}</div>
        ${canViewMargins ? `<div class="qf-margin"><div class="margin-dot ${mc}"></div><span class="${mc}">${fmtPct(q.margin_pct)}</span></div>` : ''}
        <div class="qf-price">${fmtMoney(q.total_price)}</div>
        <div><button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openQuoteModal('${q.id}')">${hasPerm("can_edit_quotes") ? "View" : "View Only"}</button></div>
      </div>`;
  }).join("");
}

async function renderFieldHome(container) {
  const fieldModeActive = document.body.classList.contains("field-mode");
  container.innerHTML = `<div class="field-screen">
    <div class="field-hero">
      <div>
        <div class="field-rep-name" id="field-rep-name">Loading...</div>
        <div class="field-rep-role" id="field-rep-role"></div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
        <button class="field-mode-toggle" onclick="toggleFieldMode()"
          title="${fieldModeActive ? 'Exit Sunlight Mode' : 'Sunlight Mode'}"
          aria-pressed="${fieldModeActive ? 'true' : 'false'}">☀️</button>
        <div class="field-sync-indicator">
          <div class="spinner" style="width:12px;height:12px;border-width:1.5px;"></div>
          <span id="field-sync-text">Syncing...</span>
        </div>
      </div>
    </div>
    ${(hasPerm("can_create_quotes") ? '<button class="new-quote-btn" onclick="window.location.hash=\'field-new-quote\'">+ New Quote</button>' : '<div class="viewer-banner">Viewer mode is enabled. Quote creation is disabled.</div>')}
    <div class="section-header"><h2 class="section-title">Your Active Quotes</h2></div>
    <div id="field-quote-list"><div class="loading-state"><div class="spinner"></div></div></div>
    <div class="week-summary" id="field-week-summary"></div>
  </div>`;

  if (el("field-rep-name")) el("field-rep-name").textContent = STATE.currentUser?.name || "User";
  if (el("field-rep-role")) {
    const role = STATE.currentUser?.role || "viewer";
    const tier = STATE.currentUser?.tier || "standard";
    el("field-rep-role").textContent = `${role.charAt(0).toUpperCase() + role.slice(1)} - ${tier} tier`;
  }

  try {
    const query = hasPerm("can_view_all_quotes") ? "" : `?rep_id=${encodeURIComponent(STATE.currentUser?.id || "")}`;
    const quotes = await get(`/quotes${query}`);
    const active = (quotes || []).filter((q) => q.status !== "completed");
    const week = (quotes || []).filter((q) => {
      const d = new Date(q.updated_at);
      return q.status === "completed" && (Date.now() - d) < 7 * 86400000;
    });

    if (el("field-sync-text")) el("field-sync-text").textContent = "Live";
    qs("#field-app .spinner")?.remove();

    const listEl = el("field-quote-list");
    if (!active.length) {
      listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">List</div>No active quotes.</div>`;
    } else {
      listEl.innerHTML = active.map((q) => buildFieldQuoteCard(q)).join("");
      listEl.querySelectorAll(".field-quote-card").forEach((card) => {
        card.addEventListener("click", () => {
          window.location.hash = `field-quote/${card.dataset.id}`;
        });
      });
    }

    if (el("field-week-summary")) el("field-week-summary").innerHTML = `Completed this week: <span>${week.length}</span>`;
  } catch {
    el("field-quote-list").innerHTML = `<div class="empty-state">Failed to load quotes.</div>`;
  }
}

function buildFieldQuoteCard(q) {
  const govData = getRepFloor();
  const mc = marginColor(q.margin_pct, govData.floor, govData.yellow);
  const showMargin = hasPerm("can_view_margins");

  return `
    <div class="field-quote-card" data-id="${q.id}">
      <div class="fqc-header">
        <div>
          <div class="fqc-customer">${esc(q.customer_name)}</div>
          <div class="fqc-address">${esc(q.job_address || "-")}</div>
        </div>
        <div class="fqc-right">
          <span class="fqc-price">${fmtMoney(q.total_price)}</span>
          <span class="badge-status ${q.status}">${statusLabel(q.status)}</span>
        </div>
      </div>
      <div class="fqc-footer">
        <span class="fqc-openings">${q.opening_count || 0} opening${q.opening_count !== 1 ? "s" : ""}</span>
        ${showMargin ? `<div class="fqc-margin"><div class="margin-dot ${mc}"></div><span class="${mc}">${fmtPct(q.margin_pct)}</span></div>` : ""}
        <span style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);">${timeSince(q.updated_at)}</span>
      </div>
    </div>`;
}

async function loadUsersTab() {
  const wrap = el("users-tab-content");
  if (!wrap) return;
  if (!hasPerm("can_manage_users")) {
    wrap.innerHTML = `<div class="empty-state">No permission to manage users.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading users...</span></div>`;

  try {
    const users = await get("/users");
    STATE.users = users || [];

    wrap.innerHTML = `
      <div class="user-table-wrap">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Perms</th><th>Status</th><th>Actions</th></tr></thead>
          <tbody>
            ${(STATE.users || []).map((u) => {
              const enabled = countEnabledPermissions(u.permissions || {});
              const canImpersonate = hasPerm("can_use_impersonation") && u.active && u.id !== STATE.currentUser?.id;
              return `<tr class="user-table-row-clickable" onclick="openUserProfile('${u.id}')">
                <td>
                  <div class="user-cell-primary">${esc(u.name || "")}</div>
                  <div class="user-cell-sub">${esc(humanizeKey(u.tier || "standard"))} tier</div>
                </td>
                <td class="mono" style="font-size:11px;">${esc(u.email || "")}</td>
                <td><span class="role-badge ${roleClass(u.role)}">${esc(u.role || "viewer")}</span></td>
                <td><span class="user-perm-summary">${enabled} / ${ENTERPRISE_PERMISSION_KEYS.length} enabled</span></td>
                <td>${u.active ? '<span class="green">Active</span>' : '<span class="red">Inactive</span>'}</td>
                <td><div style="display:flex;gap:6px;flex-wrap:wrap;">
                  <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openUserProfile('${u.id}')">View</button>
                  ${canImpersonate ? `<button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();beginImpersonation('${u.id}')">Log In As</button>` : ""}
                  <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openUserEditor('${u.id}')">Edit</button>
                  <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openPermsModal('${u.id}')">Edit Perms</button>
                  <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();resetUserPassword('${u.id}')">Reset PW</button>
                </div></td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>`;

    el("add-user-btn")?.addEventListener("click", () => openUserEditor());
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">${esc(parseErrorMessage(err, "Failed to load users."))}</div>`;
  }
}

const USER_PERMISSION_BUNDLES = {
  role_default: {
    label: "Role Default",
    description: "Uses the standard access template for the selected role.",
    overrides: {},
  },
  sales_fast: {
    label: "Sales Fast Track",
    description: "Quote intake, pricing, and customer follow-up without extra admin tools.",
    overrides: {
      can_access_field_app: true,
      can_view_products: true,
      can_view_approvals: true,
      can_create_quotes: true,
      can_edit_quotes: true,
      can_delete_openings: true,
      can_submit_approval_requests: true,
      can_view_margins: true,
      can_set_discounts: true,
    },
  },
  ops_manager: {
    label: "Operations Manager",
    description: "Admin hub, approvals, product access, and team controls for daily operations.",
    overrides: {
      can_access_admin_hub: true,
      can_access_field_app: true,
      can_view_dashboard: true,
      can_view_products: true,
      can_manage_products: true,
      can_view_approvals: true,
      can_decide_approvals: true,
      can_view_audit_log: true,
      can_view_all_quotes: true,
      can_create_quotes: true,
      can_edit_quotes: true,
      can_delete_openings: true,
      can_submit_approval_requests: true,
      can_view_margins: true,
      can_set_discounts: true,
      can_manage_users: true,
      can_reset_passwords: true,
    },
  },
  readonly_admin: {
    label: "Read-Only Admin",
    description: "Dashboard and reporting visibility without edit rights.",
    overrides: {
      can_access_admin_hub: true,
      can_view_dashboard: true,
      can_view_products: true,
      can_view_approvals: true,
      can_view_audit_log: true,
      can_view_all_quotes: true,
    },
  },
  custom: {
    label: "Custom Controls",
    description: "Keep the exact permission switches below.",
    overrides: null,
  },
};

function buildPermissionBundle(role, bundleKey, existingPermissions = null) {
  const normalizedRole = (role || "rep").toLowerCase();
  if (normalizedRole === "sysop") {
    return Object.fromEntries(ENTERPRISE_PERMISSION_KEYS.map((key) => [key, true]));
  }

  const base = { ...defaultPermsForRole(normalizedRole) };
  const bundle = USER_PERMISSION_BUNDLES[bundleKey] || USER_PERMISSION_BUNDLES.role_default;
  if (bundle.overrides == null) {
    return { ...(existingPermissions || base) };
  }
  Object.entries(bundle.overrides || {}).forEach(([key, value]) => {
    if (Object.prototype.hasOwnProperty.call(base, key)) base[key] = !!value;
  });
  return base;
}

function buildUserAccessPreview(role, permissions) {
  const normalizedRole = (role || "rep").toLowerCase();
  const perms = permissions || defaultPermsForRole(normalizedRole);
  const modules = [];
  if (perms.can_access_field_app) modules.push("Field quoting and site intake");
  if (perms.can_access_admin_hub) modules.push("Admin hub and operations views");
  if (perms.can_view_products) modules.push("Product catalog and option lookup");
  if (perms.can_manage_users) modules.push("User setup and password resets");
  if (perms.can_view_governance || perms.can_manage_governance) modules.push("Governance and pricing controls");
  if (perms.can_view_audit_log) modules.push("Audit log visibility");

  return [
    modules[0] || "Basic company access only",
    perms.can_view_all_quotes ? "Can view every company quote" : "Sees assigned quotes only",
    perms.can_decide_approvals ? "Can approve pricing exceptions" : "Cannot approve pricing exceptions",
    perms.can_view_margins ? "Margins and cost visibility enabled" : "Margins hidden",
    perms.can_reset_passwords ? "Can reset teammate passwords" : "Password resets disabled",
  ];
}

function openUserEditor(uid = null) {
  const existing = uid ? (STATE.users || []).find((u) => u.id === uid) : null;
  const availableRoles = (STATE.currentUser?.role || "").toLowerCase() === "sysop"
    ? ["sysop", "owner", "manager", "rep", "viewer"]
    : ["owner", "manager", "rep", "viewer"];
  const roleMeta = {
    sysop: "Full cross-company access, reserved for platform operators.",
    owner: "Runs the company, sees margins, and controls approvals and settings.",
    manager: "Handles operations, teams, approvals, and day-to-day admin work.",
    rep: "Builds quotes, works active jobs, and requests approvals when needed.",
    viewer: "Read-only visibility for office staff or external stakeholders.",
  };
  const initialRole = existing?.role || "rep";
  const initialPermissions = { ...buildPermissionBundle(initialRole, "role_default", existing?.permissions || null), ...(existing?.permissions || {}) };
  const title = existing ? `Edit User: ${existing.name}` : "Add User";

  showSimpleModal(
    title,
    `
      <div class="user-onboarding-shell">
        <div class="user-onboarding-hero">
          <h3>${existing ? "Refine this teammate's access" : "Add a teammate with the right controls from the start"}</h3>
          <p>Choose the role, apply a permission bundle, and verify exactly what this person can see inside ${esc(currentTenantName())} before you save.</p>
          <div class="company-context-chip">Company: ${esc(currentTenantName())}</div>
        </div>

        <div class="user-onboarding-grid">
          <div>
            <div class="form-row">
              <div class="form-group"><label class="form-label">Name</label><input id="uo-name" class="form-input" value="${esc(existing?.name || "")}" /></div>
              <div class="form-group"><label class="form-label">Email</label><input id="uo-email" class="form-input" value="${esc(existing?.email || "")}" /></div>
            </div>
            <div class="form-row">
              <div class="form-group"><label class="form-label">Role</label>
                <select id="uo-role" class="form-input">${availableRoles.map((role) => `<option value="${role}" ${initialRole === role ? "selected" : ""}>${role}</option>`).join("")}</select>
              </div>
              <div class="form-group"><label class="form-label">Tier</label>
                <select id="uo-tier" class="form-input">${["junior", "standard", "senior"].map((tier) => `<option value="${tier}" ${(existing?.tier || "standard") === tier ? "selected" : ""}>${tier}</option>`).join("")}</select>
              </div>
            </div>
            ${existing ? "" : '<div class="form-group"><label class="form-label">Temporary Password</label><input id="uo-password" class="form-input" placeholder="Leave blank to generate one" /></div>'}

            <div class="role-preset-grid" id="uo-role-card-grid">
              ${availableRoles.map((role) => `
                <button type="button" class="role-preset-card ${initialRole === role ? "is-active" : ""}" data-role-value="${role}">
                  <strong>${role}</strong>
                  <span>${esc(roleMeta[role] || "Company access role")}</span>
                </button>
              `).join("")}
            </div>

            <div class="permission-bundle-select">
              <label class="form-label" for="uo-bundle">Access Bundle</label>
              <select id="uo-bundle" class="form-input">
                ${Object.entries(USER_PERMISSION_BUNDLES).map(([key, item]) => `<option value="${key}" ${key === "role_default" ? "selected" : ""}>${item.label}</option>`).join("")}
              </select>
            </div>

            <label class="permission-quick-toggle">
              <span>Keep custom control overrides</span>
              <input id="uo-custom-controls" type="checkbox" ${existing ? "checked" : ""} />
            </label>

            <div id="uo-permission-grid" class="permission-grid-compact"></div>
          </div>

          <div class="onboarding-preview-card">
            <h4>Access Preview</h4>
            <div id="uo-preview-role" class="role-badge ${roleClass(initialRole)}">${esc(initialRole)}</div>
            <div id="uo-preview-count" class="user-perm-summary">${countEnabledPermissions(initialPermissions)} / ${ENTERPRISE_PERMISSION_KEYS.length} permissions enabled</div>
            <ul id="uo-preview-list" class="onboarding-preview-list"></ul>
          </div>
        </div>
      </div>
    `,
    async () => {
      const body = {
        name: el("uo-name")?.value?.trim() || "",
        email: el("uo-email")?.value?.trim() || "",
        role: el("uo-role")?.value || "rep",
        tier: el("uo-tier")?.value || "standard",
        permissions: workingPermissions,
      };
      if (!existing) body.password = el("uo-password")?.value || undefined;

      if (!body.name || !body.email) {
        toast("Name and email are required.", "warning");
        return;
      }

      try {
        if (existing) {
          await put(`/users/${existing.id}`, body);
          toast("User updated.", "success");
        } else {
          const out = await post("/users", body);
          toast(`User created. Temp password: ${out.temporary_password || ""}`, "success", 7000);
        }
        closeSimpleModal();
        await loadUsersTab();
      } catch (err) {
        toast(parseErrorMessage(err, "User save failed."), "error");
      }
    }
  );

  const modalPanel = qs("#simple-modal-overlay .modal-panel");
  if (modalPanel) {
    modalPanel.style.maxWidth = "980px";
    modalPanel.style.width = "min(980px, calc(100vw - 32px))";
  }

  let workingPermissions = { ...initialPermissions };
  const grid = el("uo-permission-grid");
  const bundleSelect = el("uo-bundle");
  const roleSelect = el("uo-role");
  const customToggle = el("uo-custom-controls");

  const syncRoleCards = () => {
    qsa("#uo-role-card-grid .role-preset-card").forEach((button) => {
      button.classList.toggle("is-active", button.dataset.roleValue === (roleSelect?.value || "rep"));
    });
  };

  const syncPreview = () => {
    const role = roleSelect?.value || "rep";
    const previewRole = el("uo-preview-role");
    if (previewRole) {
      previewRole.textContent = role;
      previewRole.className = `role-badge ${roleClass(role)}`;
    }
    if (el("uo-preview-count")) {
      el("uo-preview-count").textContent = `${countEnabledPermissions(workingPermissions)} / ${ENTERPRISE_PERMISSION_KEYS.length} permissions enabled`;
    }
    const previewList = el("uo-preview-list");
    if (previewList) {
      previewList.innerHTML = buildUserAccessPreview(role, workingPermissions)
        .map((line) => `<li>${esc(line)}</li>`)
        .join("");
    }
  };

  const renderPermissionGrid = () => {
    if (!grid) return;
    grid.innerHTML = ENTERPRISE_PERMISSION_KEYS.map((key) => `
      <label class="perm-item ${workingPermissions[key] ? "" : "overridden"}">
        <span>${esc(PERMISSION_LABELS[key] || key)}</span>
        <input type="checkbox" data-onboarding-perm="${key}" ${workingPermissions[key] ? "checked" : ""} ${customToggle?.checked ? "" : "disabled"} />
      </label>
    `).join("");
    qsa("#uo-permission-grid input[data-onboarding-perm]").forEach((input) => {
      input.addEventListener("change", () => {
        workingPermissions[input.dataset.onboardingPerm] = !!input.checked;
        syncPreview();
      });
    });
    syncPreview();
  };

  const resetPermissionsFromPreset = () => {
    if (customToggle?.checked) return;
    workingPermissions = buildPermissionBundle(roleSelect?.value || "rep", bundleSelect?.value || "role_default", existing?.permissions || initialPermissions);
    renderPermissionGrid();
  };

  qsa("#uo-role-card-grid .role-preset-card").forEach((button) => {
    button.addEventListener("click", () => {
      if (roleSelect) roleSelect.value = button.dataset.roleValue || "rep";
      syncRoleCards();
      resetPermissionsFromPreset();
      syncPreview();
    });
  });
  roleSelect?.addEventListener("change", () => {
    syncRoleCards();
    resetPermissionsFromPreset();
    syncPreview();
  });
  bundleSelect?.addEventListener("change", () => {
    if ((bundleSelect.value || "") === "custom" && customToggle) customToggle.checked = true;
    resetPermissionsFromPreset();
    renderPermissionGrid();
  });
  customToggle?.addEventListener("change", () => {
    if (!customToggle.checked) {
      workingPermissions = buildPermissionBundle(roleSelect?.value || "rep", bundleSelect?.value || "role_default", existing?.permissions || initialPermissions);
    }
    renderPermissionGrid();
  });

  syncRoleCards();
  renderPermissionGrid();
}

function openPermsModal(uid) {
  const user = (STATE.users || []).find((u) => u.id === uid);
  if (!user) return;

  STATE.selectedUserPermTarget = user;
  el("permissions-modal")?.classList.remove("hidden");
  if (el("perms-modal-title")) el("perms-modal-title").textContent = `Edit Permissions - ${user.name}`;
  if (el("perms-role-bar")) el("perms-role-bar").innerHTML = `Role: <span class="role-badge ${roleClass(user.role)}">${esc(user.role)}</span> • ${esc(user.email || "")}`;

  const defaults = defaultPermsForRole(user.role);
  const current = user.permissions || {};
  const grid = el("permissions-grid");
  if (!grid) return;

  grid.innerHTML = ENTERPRISE_PERMISSION_KEYS.map((key) => {
    const checked = !!current[key];
    const overridden = !!defaults && checked !== !!defaults[key];
    return `<label class="perm-item ${overridden ? "overridden" : ""}"><span>${esc(PERMISSION_LABELS[key] || key)}</span><input type="checkbox" data-perm-key="${key}" ${checked ? "checked" : ""} /></label>`;
  }).join("");
}

function closePermsModal() {
  el("permissions-modal")?.classList.add("hidden");
  STATE.selectedUserPermTarget = null;
}

async function savePermissions() {
  const user = STATE.selectedUserPermTarget;
  if (!user) return;

  const permissions = {};
  qsa("#permissions-grid input[data-perm-key]").forEach((input) => {
    permissions[input.dataset.permKey] = !!input.checked;
  });

  try {
    await put(`/users/${user.id}/permissions`, { permissions });
    toast("Permissions updated.", "success");
    closePermsModal();
    await loadUsersTab();
  } catch (err) {
    toast(parseErrorMessage(err, "Failed to save permissions."), "error");
  }
}

async function resetUserPassword(uid) {
  if (!confirm("Reset this user's password to a temporary value?")) return;
  try {
    const out = await post(`/users/${uid}/reset-password`, {});
    toast(`Temporary password: ${out.temporary_password || ""}`, "success", 7000);
  } catch (err) {
    toast(parseErrorMessage(err, "Password reset failed."), "error");
  }
}

async function openUserProfile(uid) {
  const user = (STATE.users || []).find((item) => item.id === uid);
  if (!user) return;

  STATE.selectedUserProfile = { user, quotes: [], approvals: [], activity: [], loading: true };
  STATE.selectedUserProfileTab = "overview";
  renderUserProfileModal();

  try {
    const [quotes, approvals, activity] = await Promise.all([
      get(`/quotes?rep_id=${encodeURIComponent(uid)}`).catch(() => []),
      get(`/approvals?rep_id=${encodeURIComponent(uid)}`).catch(() => []),
      hasPerm("can_view_audit_log")
        ? get(`/audit-log?limit=40&user_id=${encodeURIComponent(uid)}`).catch(() => [])
        : Promise.resolve([]),
    ]);

    STATE.selectedUserProfile = {
      user,
      quotes: sortDashboardQuotes(quotes || [], "updated_desc"),
      approvals: approvals || [],
      activity: activity || [],
      loading: false,
    };
    renderUserProfileModal();
  } catch (err) {
    STATE.selectedUserProfile = { user, quotes: [], approvals: [], activity: [], loading: false, error: parseErrorMessage(err, "Failed to load user profile.") };
    renderUserProfileModal();
  }
}

function closeUserProfileModal() {
  const overlay = el("user-profile-overlay");
  if (overlay) overlay.remove();
  STATE.selectedUserProfile = null;
  STATE.selectedUserProfileTab = "overview";
}

function switchUserProfileTab(tab) {
  STATE.selectedUserProfileTab = tab;
  renderUserProfileModal();
}

function renderUserProfileModal() {
  const profile = STATE.selectedUserProfile;
  if (!profile) return;

  let overlay = el("user-profile-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = "user-profile-overlay";
    overlay.className = "modal-overlay";
    overlay.style.zIndex = "1500";
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeUserProfileModal();
    });
    document.body.appendChild(overlay);
  }

  const user = profile.user || {};
  const quotes = profile.quotes || [];
  const approvals = profile.approvals || [];
  const activity = profile.activity || [];
  const canImpersonate = hasPerm("can_use_impersonation") && user.active && user.id !== STATE.currentUser?.id;

  const quoteTotals = quotes.reduce((acc, quote) => {
    acc.total += Number(quote.total_price) || 0;
    acc.cost += Number(quote.total_cost) || 0;
    if (Number.isFinite(Number(quote.margin_pct))) {
      acc.marginSum += Number(quote.margin_pct);
      acc.marginCount += 1;
    }
    acc.statuses[quote.status] = (acc.statuses[quote.status] || 0) + 1;
    return acc;
  }, { total: 0, cost: 0, marginSum: 0, marginCount: 0, statuses: {} });

  const approvalCounts = approvals.reduce((acc, item) => {
    acc[item.status] = (acc[item.status] || 0) + 1;
    return acc;
  }, {});

  const summaryCards = [
    { label: "Quotes", value: quotes.length, sub: `${quoteTotals.statuses.draft || 0} draft | ${quoteTotals.statuses.pending_approval || 0} pending` },
    { label: "Pipeline", value: fmtMoney(quoteTotals.total), sub: `${quoteTotals.statuses.completed || 0} completed jobs` },
    { label: "Total Cost", value: fmtMoney(quoteTotals.cost), sub: hasPerm("can_view_margins") ? "Internal job cost" : "Hidden by permissions" },
    { label: "Avg Margin", value: hasPerm("can_view_margins") && quoteTotals.marginCount ? fmtPct(quoteTotals.marginSum / quoteTotals.marginCount) : "-", sub: `${approvalCounts.pending || 0} open approval requests` },
    { label: "Approvals", value: approvalCounts.approved || 0, sub: `${approvalCounts.denied || 0} denied` },
    { label: "Activity", value: activity.length, sub: "Recent audit trail events" },
  ];

  overlay.innerHTML = `
    <div class="modal-panel user-profile-panel">
      <div class="modal-header">
        <h2 class="modal-title">User Snapshot</h2>
        <button class="modal-close" onclick="closeUserProfileModal()">
          <svg width="20" height="20" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clip-rule="evenodd"/></svg>
        </button>
      </div>
      <div class="user-profile-header">
        <div>
          <div class="user-profile-kicker">Rep / User Detail</div>
          <div class="user-profile-name">${esc(user.name || "User")}</div>
          <div class="user-profile-meta">
            <span class="mono">${esc(user.email || "")}</span>
            <span><span class="role-badge ${roleClass(user.role)}">${esc(user.role || "viewer")}</span></span>
            <span>${user.active ? "Active" : "Inactive"}</span>
            <span>${esc(humanizeKey(user.tier || "standard"))} tier</span>
            <span>Created ${fmtDateTime(user.created_at)}</span>
          </div>
        </div>
        <div class="user-profile-actions">
          ${canImpersonate ? `<button class="btn btn-primary btn-sm" onclick="beginImpersonation('${user.id}')">Temporary Log In As</button>` : ""}
          <button class="btn btn-ghost btn-sm" onclick="closeUserProfileModal();openUserEditor('${user.id}')">Edit User</button>
          <button class="btn btn-ghost btn-sm" onclick="openPermsModal('${user.id}')">Permissions</button>
          <button class="btn btn-ghost btn-sm" onclick="resetUserPassword('${user.id}')">Reset Password</button>
        </div>
      </div>
      <div class="user-profile-tabs">
        ${[
          ["overview", "Overview"],
          ["quotes", "Quotes"],
          ["approvals", "Approvals"],
          ["activity", "Activity"],
        ].map(([key, label]) => `<button class="user-profile-tab ${STATE.selectedUserProfileTab === key ? "active" : ""}" onclick="switchUserProfileTab('${key}')">${label}</button>`).join("")}
      </div>
      <div class="modal-body user-profile-body">
        ${profile.loading ? `<div class="loading-state"><div class="spinner"></div><span>Loading user details...</span></div>` : profile.error ? `<div class="user-profile-empty">${esc(profile.error)}</div>` : renderUserProfileTabContent(user, quotes, approvals, activity, summaryCards)}
      </div>
    </div>
  `;
}

function renderUserProfileTabContent(user, quotes, approvals, activity, summaryCards) {
  if (STATE.selectedUserProfileTab === "quotes") {
    if (!quotes.length) return `<div class="user-profile-empty">No quotes found for this user.</div>`;
    return `
      <div class="user-profile-section">
        <div class="user-profile-section-header">
          <div class="user-profile-section-title">Quotes And Jobs</div>
          <div class="user-cell-sub">${quotes.length} records</div>
        </div>
        <div class="user-profile-list">
          ${quotes.map((quote) => {
            const marginCls = marginColor(quote.margin_pct, getRepFloor().floor, getRepFloor().yellow);
            return `
              <div class="user-profile-list-item quote-link" onclick="openQuoteModal('${quote.id}')">
                <div class="user-profile-list-top">
                  <div>
                    <div class="user-profile-list-title">${esc(quote.customer_name || "Untitled Quote")}</div>
                    <div class="user-profile-list-subtitle">${esc(quote.job_address || "-")}</div>
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                    <span class="badge-status ${quote.status}">${statusLabel(quote.status)}</span>
                    <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openQuoteModal('${quote.id}')">Open Quote</button>
                  </div>
                </div>
                <div class="user-profile-meta-row">
                  <span>Updated ${timeSince(quote.updated_at)}</span>
                  <span>Total ${fmtMoney(quote.total_price)}</span>
                  <span>Cost ${fmtMoney(quote.total_cost)}</span>
                  <span class="${marginCls}">Margin ${fmtPct(quote.margin_pct)}</span>
                  <span>${quote.opening_count || 0} openings</span>
                </div>
              </div>
            `;
          }).join("")}
        </div>
      </div>
    `;
  }

  if (STATE.selectedUserProfileTab === "approvals") {
    if (!approvals.length) return `<div class="user-profile-empty">No approval requests or denials for this user.</div>`;
    return `
      <div class="user-profile-section">
        <div class="user-profile-section-header">
          <div class="user-profile-section-title">Requests, Approvals, And Denials</div>
          <div class="user-cell-sub">${approvals.length} records</div>
        </div>
        <div class="user-profile-list">
          ${approvals.map((approval) => `
            <div class="user-profile-list-item quote-link" onclick="openQuoteModal('${approval.quote_id}')">
              <div class="user-profile-list-top">
                <div>
                  <div class="user-profile-list-title">${esc(approval.customer_name || "Approval Request")}</div>
                  <div class="user-profile-list-subtitle">${esc(approval.job_address || "-")}</div>
                </div>
                <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                  <span class="badge-status ${approval.status === "pending" ? "pending_approval" : approval.status}">${humanizeKey(approval.status)}</span>
                  <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();openQuoteModal('${approval.quote_id}')">Open Quote</button>
                </div>
              </div>
              <div class="user-profile-meta-row">
                <span>Requested ${fmtDateTime(approval.created_at)}</span>
                <span>Total ${fmtMoney(approval.quote_total ?? approval.total_price)}</span>
                <span>Current ${fmtPct(approval.current_margin)}</span>
                <span>Floor ${fmtPct(approval.margin_floor)}</span>
              </div>
              ${approval.rep_note ? `<div class="user-profile-note"><strong>Rep note:</strong> ${esc(safePreviewText(approval.rep_note, 240))}</div>` : ""}
              ${approval.owner_note ? `<div class="user-profile-note"><strong>Owner note:</strong> ${esc(safePreviewText(approval.owner_note, 240))}</div>` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  if (STATE.selectedUserProfileTab === "activity") {
    if (!activity.length) return `<div class="user-profile-empty">No recent activity available for this user.</div>`;
    return `
      <div class="user-profile-section">
        <div class="user-profile-section-header">
          <div class="user-profile-section-title">Recent Activity</div>
          <div class="user-cell-sub">${activity.length} events</div>
        </div>
        <div class="user-profile-list">
          ${activity.map((entry) => `
            <div class="user-profile-list-item">
              <div class="user-profile-list-top">
                <div>
                  <div class="user-profile-list-title">${esc(humanizeKey(entry.event_type || "activity"))}</div>
                  <div class="user-profile-list-subtitle">${esc(entry.entity_type || "system")} ${entry.entity_id ? `- ${esc(entry.entity_id)}` : ""}</div>
                </div>
                <div class="user-cell-sub">${fmtDateTime(entry.created_at)}</div>
              </div>
              <div class="user-profile-meta-row">
                <span>Actor ${esc(entry.user_name || "System")}</span>
                <span>ID ${esc(entry.user_id || "-")}</span>
              </div>
              ${buildAuditDetailsPreview(entry.details) ? `<div class="user-activity-detail">${esc(buildAuditDetailsPreview(entry.details))}</div>` : ""}
            </div>
          `).join("")}
        </div>
      </div>
    `;
  }

  return `
    <div class="user-profile-section">
      <div class="user-profile-summary-grid">
        ${summaryCards.map((card) => `
          <div class="user-summary-card">
            <div class="user-summary-label">${esc(card.label)}</div>
            <div class="user-summary-value">${esc(String(card.value))}</div>
            <div class="user-summary-sub">${esc(card.sub)}</div>
          </div>
        `).join("")}
      </div>
    </div>
    <div class="user-profile-section">
      <div class="user-profile-section-header">
        <div class="user-profile-section-title">Latest Quotes</div>
        <button class="btn btn-ghost btn-sm" onclick="switchUserProfileTab('quotes')">See All Quotes</button>
      </div>
      ${quotes.length ? `
        <div class="user-profile-list">
          ${quotes.slice(0, 5).map((quote) => `
            <div class="user-profile-list-item quote-link" onclick="openQuoteModal('${quote.id}')">
              <div class="user-profile-list-top">
                <div>
                  <div class="user-profile-list-title">${esc(quote.customer_name || "Untitled Quote")}</div>
                  <div class="user-profile-list-subtitle">${esc(quote.job_address || "-")}</div>
                </div>
                <span class="badge-status ${quote.status}">${statusLabel(quote.status)}</span>
              </div>
              <div class="user-profile-meta-row">
                <span>Updated ${timeSince(quote.updated_at)}</span>
                <span>Total ${fmtMoney(quote.total_price)}</span>
                <span>Cost ${fmtMoney(quote.total_cost)}</span>
              </div>
            </div>
          `).join("")}
        </div>
      ` : `<div class="user-profile-empty">No quotes found for this user.</div>`}
    </div>
    <div class="user-profile-section">
      <div class="user-profile-section-header">
        <div class="user-profile-section-title">Approval Snapshot</div>
        <button class="btn btn-ghost btn-sm" onclick="switchUserProfileTab('approvals')">See All Requests</button>
      </div>
      ${approvals.length ? `
        <div class="user-profile-list">
          ${approvals.slice(0, 4).map((approval) => `
            <div class="user-profile-list-item quote-link" onclick="openQuoteModal('${approval.quote_id}')">
              <div class="user-profile-list-top">
                <div>
                  <div class="user-profile-list-title">${esc(approval.customer_name || "Approval Request")}</div>
                  <div class="user-profile-list-subtitle">${esc(approval.job_address || "-")}</div>
                </div>
                <span class="badge-status ${approval.status === "pending" ? "pending_approval" : approval.status}">${humanizeKey(approval.status)}</span>
              </div>
              <div class="user-profile-meta-row">
                <span>Requested ${fmtDateTime(approval.created_at)}</span>
                <span>Total ${fmtMoney(approval.quote_total ?? approval.total_price)}</span>
              </div>
            </div>
          `).join("")}
        </div>
      ` : `<div class="user-profile-empty">No approval requests yet.</div>`}
    </div>
  `;
}

async function beginImpersonation(uid) {
  const user = (STATE.users || []).find((item) => item.id === uid);
  if (!user) return;
  if (!confirm(`Temporarily log in as ${user.name}? You can return to your own session from the header banner.`)) return;

  try {
    await post("/system/impersonate", { user_id: uid, tenant_id: user.tenant_id });
    closeUserProfileModal();
    toast(`Now viewing the app as ${user.name}.`, "success");
    await loadInitialData();
  } catch (err) {
    toast(parseErrorMessage(err, "Unable to start impersonation."), "error");
  }
}

async function revertImpersonation() {
  try {
    await post("/system/impersonate/revert", {});
    toast("Returned to your original session.", "success");
    await loadInitialData();
  } catch (err) {
    toast(parseErrorMessage(err, "Unable to return to your session."), "error");
  }
}

async function _loadSystemConsole_v1() {
  const wrap = el("system-console-content");
  if (!wrap) return;

  const isSysop = (STATE.currentUser?.role || "") === "sysop";
  if (!isSysop) {
    wrap.innerHTML = `<div class="empty-state">System Console is sysop-only.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading system data...</span></div>`;

  try {
    const [tenants, flags] = await Promise.all([
      get("/system/tenants"),
      get("/feature-flags").catch(() => []),
    ]);

    wrap.innerHTML = `
      <div class="system-console-grid">
        <div class="system-card">
          <div class="system-card-title">Tenant Directory</div>
          <div style="display:grid;gap:8px;max-height:300px;overflow:auto;">
            ${(tenants || []).map((t) => `<div style="padding:8px;border:1px solid var(--border);border-radius:8px;"><div style="font-weight:700;">${esc(t.name || t.id)}</div><div style="font-size:11px;color:var(--text-muted);">${esc(t.id)}</div><div style="font-size:12px;margin-top:4px;color:var(--text-secondary);">${(Object.entries(t.user_counts || {}).map(([role, count]) => `${role}:${count}`).join(" • ")) || "No users"}</div></div>`).join("")}
          </div>
        </div>

        <div class="system-card">
          <div class="system-card-title">Feature Flags (Current Tenant)</div>
          <div style="display:grid;gap:8px;">
            ${(flags || []).map((f) => `<label style="display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border);border-radius:8px;padding:8px;"><span class="mono" style="font-size:11px;">${esc(f.flag_key)}</span><input type="checkbox" ${f.enabled ? "checked" : ""} onchange="toggleFeatureFlag('${esc(f.flag_key)}', this.checked)" /></label>`).join("") || '<div style="color:var(--text-muted);font-size:12px;">No feature flags.</div>'}
          </div>
        </div>

        <div class="system-card">
          <div class="system-card-title">Impersonation</div>
          <div class="form-group"><label class="form-label">Tenant ID</label><input id="imp-tenant" class="form-input" placeholder="t-demo-001" /></div>
          <div class="form-group"><label class="form-label">User ID</label><input id="imp-user" class="form-input" placeholder="u-rep-001" /></div>
          <button class="btn btn-primary btn-sm" onclick="runImpersonation()">Impersonate</button>
        </div>

        <div class="system-card">
          <div class="system-card-title">Session Context</div>
          <div style="font-size:12px;color:var(--text-secondary);display:grid;gap:6px;">
            <div><span class="mono">User:</span> ${esc(STATE.currentUser?.name || "")}</div>
            <div><span class="mono">Role:</span> ${esc(STATE.currentUser?.role || "")}</div>
            <div><span class="mono">Tenant:</span> ${esc(STATE.currentUser?.tenant_id || "")}</div>
          </div>
        </div>
      </div>`;

    el("refresh-system-btn")?.addEventListener("click", loadSystemConsole);
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">${esc(parseErrorMessage(err, "Failed to load system console."))}</div>`;
  }
}

async function toggleFeatureFlag(flagKey, enabled) {
  try {
    await put("/feature-flags", { flag_key: flagKey, enabled: !!enabled });
    toast("Feature flag updated.", "success");
  } catch (err) {
    toast(parseErrorMessage(err, "Feature flag update failed."), "error");
  }
}

async function runImpersonation() {
  const tenantId = (el("imp-tenant")?.value || "").trim();
  const userId = (el("imp-user")?.value || "").trim();
  if (!userId) {
    toast("User ID is required for impersonation.", "warning");
    return;
  }

  try {
    await post("/system/impersonate", { user_id: userId, ...(tenantId ? { tenant_id: tenantId } : {}) });
    toast("Impersonation started.", "success");
    await loadInitialData();
  } catch (err) {
    toast(parseErrorMessage(err, "Impersonation failed."), "error");
  }
}

function openTenantOnboarding() {
  showSimpleModal(
    "Create Company",
    `
      <div class="system-note-list" style="margin-bottom:14px;">
        <div class="system-note-item">Each company gets its own users, product catalog, governance settings, and quotes.</div>
        <div class="system-note-item">Start blank for a clean slate or clone the current company to move faster.</div>
      </div>
      <div class="form-group"><label class="form-label">Company Name</label><input id="tenant-name" class="form-input" placeholder="Gulf Coast Impact" /></div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Company ID (optional)</label><input id="tenant-id" class="form-input" placeholder="t-gulf-coast-impact" /></div>
        <div class="form-group"><label class="form-label">Catalog Setup</label>
          <select id="tenant-catalog-mode" class="form-input">
            <option value="blank">Blank Catalog</option>
            <option value="copy_current">Clone Current Catalog</option>
          </select>
        </div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Owner Name</label><input id="tenant-owner-name" class="form-input" placeholder="Jane Owner" /></div>
        <div class="form-group"><label class="form-label">Owner Email</label><input id="tenant-owner-email" class="form-input" placeholder="jane@company.com" /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Temporary Password</label><input id="tenant-owner-password" class="form-input" placeholder="Leave blank to generate one" /></div>
        <div class="form-group"><label class="form-label">Company Email</label><input id="tenant-company-email" class="form-input" placeholder="info@company.com" /></div>
      </div>
      <div class="form-row">
        <div class="form-group"><label class="form-label">Phone</label><input id="tenant-phone" class="form-input" placeholder="(954) 555-0100" /></div>
        <div class="form-group"><label class="form-label">License</label><input id="tenant-license" class="form-input" placeholder="CGC1234567" /></div>
      </div>
      <div class="form-group"><label class="form-label">Address</label><input id="tenant-address" class="form-input" placeholder="2500 S Andrews Ave, Fort Lauderdale, FL 33316" /></div>
    `,
    async () => {
      const body = {
        name: el("tenant-name")?.value?.trim() || "",
        tenant_id: el("tenant-id")?.value?.trim() || "",
        owner_name: el("tenant-owner-name")?.value?.trim() || "",
        owner_email: el("tenant-owner-email")?.value?.trim() || "",
        owner_password: el("tenant-owner-password")?.value || undefined,
        email: el("tenant-company-email")?.value?.trim() || "",
        phone: el("tenant-phone")?.value?.trim() || "",
        license_number: el("tenant-license")?.value?.trim() || "",
        address: el("tenant-address")?.value?.trim() || "",
        catalog_mode: el("tenant-catalog-mode")?.value || "blank",
      };

      try {
        const out = await post("/system/tenants", body);
        toast(`Company created. Owner temp password: ${out.owner_temporary_password || ""}`, "success", 8000);
        closeSimpleModal();
        await loadSystemConsole();
        if (out?.tenant?.id && confirm(`Switch into ${out.tenant.name || out.tenant.id} now?`)) {
          await switchTenantContext(out.tenant.id);
        }
      } catch (err) {
        toast(parseErrorMessage(err, "Unable to create company."), "error");
      }
    }
  );
}

const SYSTEM_CONSOLE_FLAG_KEYS = [
  "governance_v2026",
  "approval_loop",
  "system_console",
  "impersonation",
  "auth_required",
];

function systemOnboardingSummary(tenant) {
  const done = Number(tenant?.onboarding_complete_count || 0);
  const total = Number(tenant?.onboarding_total_count || 0) || 6;
  const doneLabel = `${done} / ${total}`;
  if (tenant?.onboarding_complete) return `${doneLabel} complete`;
  return done > 0 ? `${doneLabel} configured` : "Not started";
}

function systemOnboardingTone(tenant) {
  if (tenant?.onboarding_complete) return "green";
  return Number(tenant?.onboarding_complete_count || 0) > 0 ? "amber" : "slate";
}

function systemReadinessSummary(row) {
  const done = Number(row?.complete_count || 0);
  const total = Number(row?.total_count || 0) || 6;
  return `${done} / ${total} steps`;
}

function systemReadinessTone(row) {
  if (row?.all_done) return "green";
  return Number(row?.complete_count || 0) > 0 ? "amber" : "slate";
}

function systemReadinessBlockers(row) {
  const blockers = row?.blockers || [];
  return blockers.length ? blockers.join(" | ") : "Ready";
}

function systemLastActivityLabel(value) {
  return value ? fmtDateTime(value) : "No activity yet";
}

function renderSystemTenantHealthBody(health) {
  const onboarding = health?.onboarding || {};
  const blockers = onboarding.blockers || [];
  return `
    <div class="system-health-grid">
      <div class="system-health-item"><span>Users</span><strong>${Number(health?.user_count || 0)}</strong></div>
      <div class="system-health-item"><span>Products</span><strong>${Number(health?.product_count || 0)}</strong></div>
      <div class="system-health-item"><span>Open Quotes</span><strong>${Number(health?.active_quotes || 0)}</strong></div>
      <div class="system-health-item"><span>Pending Approvals</span><strong>${Number(health?.pending_approvals || 0)}</strong></div>
      <div class="system-health-item"><span>Last Activity</span><strong>${esc(systemLastActivityLabel(health?.last_quote_activity))}</strong></div>
      <div class="system-health-item"><span>Onboarding</span><strong>${health?.onboarding_complete ? "Complete" : "In Progress"}</strong></div>
      <div class="system-health-item"><span>Governance</span><strong>${health?.has_governance ? "Ready" : "Missing"}</strong></div>
      <div class="system-health-item"><span>Pricing Points</span><strong>${health?.has_pricing_points ? "Ready" : "Missing"}</strong></div>
      <div class="system-health-item"><span>Twilio</span><strong>${health?.twilio_enabled ? "Enabled" : "Off"}</strong></div>
      <div class="system-health-item"><span>Maps</span><strong>${health?.maps_enabled ? "Enabled" : "Off"}</strong></div>
    </div>
    <div class="system-health-block">
      <div class="system-health-title">Onboarding Progress</div>
      <div class="system-health-sub">${Number(onboarding.complete_count || 0)} of ${Number(onboarding.total_count || 0)} steps completed</div>
      ${(onboarding.steps || []).map((step) => `
        <div class="system-step-row">
          <span class="system-step-mark ${step.done ? "done" : "todo"}">${step.done ? "OK" : "TODO"}</span>
          <span>${esc(step.label)}</span>
        </div>
      `).join("")}
      ${blockers.length ? `<div class="system-health-blockers">Blockers: ${esc(blockers.join(" | "))}</div>` : ""}
    </div>
  `;
}

async function openSystemTenantHealth(tenantId, tenantName = "") {
  try {
    const tenant = (STATE.systemTenants || []).find((item) => item.id === tenantId);
    const resolvedName = tenantName || tenant?.name || tenantId;
    const health = await get(`/system/tenants/${encodeURIComponent(tenantId)}/health`);
    showSimpleModal(
      `Tenant Health: ${resolvedName}`,
      renderSystemTenantHealthBody(health),
      () => closeSimpleModal()
    );
    if (el("simple-modal-save")) el("simple-modal-save").textContent = "Close";
  } catch (err) {
    toast(parseErrorMessage(err, "Unable to load tenant health."), "error");
  }
}

function renderSystemTenantFlagsBody(tenantId, flags) {
  const flagMap = flags || {};
  const keys = Array.from(new Set([...SYSTEM_CONSOLE_FLAG_KEYS, ...Object.keys(flagMap || {})])).sort();
  if (!keys.length) {
    return `<div class="empty-state small">No feature flags are defined for this tenant yet.</div>`;
  }
  return `
    <div class="system-flag-list">
      ${keys.map((flagKey) => `
        <label class="system-flag-row">
          <span class="mono">${esc(flagKey)}</span>
          <input
            type="checkbox"
            ${flagMap[flagKey] ? "checked" : ""}
            onchange="saveSystemTenantFlag('${esc(tenantId)}', '${esc(flagKey)}', this.checked)"
          />
        </label>
      `).join("")}
    </div>
    <div class="system-health-sub">Changes save immediately for this tenant.</div>
  `;
}

async function openSystemTenantFlags(tenantId, tenantName = "") {
  try {
    const tenant = (STATE.systemTenants || []).find((item) => item.id === tenantId);
    const resolvedName = tenantName || tenant?.name || tenantId;
    const flags = await get(`/system/tenants/${encodeURIComponent(tenantId)}/flags`);
    showSimpleModal(
      `Feature Flags: ${resolvedName}`,
      renderSystemTenantFlagsBody(tenantId, flags),
      () => closeSimpleModal()
    );
    if (el("simple-modal-save")) el("simple-modal-save").textContent = "Done";
  } catch (err) {
    toast(parseErrorMessage(err, "Unable to load tenant feature flags."), "error");
  }
}

async function saveSystemTenantFlag(tenantId, flagKey, enabled) {
  try {
    await put(`/system/tenants/${encodeURIComponent(tenantId)}/flags`, { [flagKey]: !!enabled });
    toast(`Updated ${flagKey}.`, "success");
  } catch (err) {
    toast(parseErrorMessage(err, "Feature flag update failed."), "error");
  }
}

async function loadSystemConsole() {
  const wrap = el("system-console-content");
  if (!wrap) return;

  const isSysop = (STATE.currentUser?.role || "") === "sysop";
  if (!isSysop) {
    wrap.innerHTML = `<div class="empty-state">System Console is sysop-only.</div>`;
    return;
  }

  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading system data...</span></div>`;

  try {
    const [tenants, flags, readiness] = await Promise.all([
      get("/system/tenants"),
      get("/feature-flags").catch(() => []),
      get("/system/tenants/readiness").catch(() => []),
    ]);
    const currentTenantId = STATE.currentTenant?.id || STATE.currentUser?.tenant_id || "";
    STATE.systemTenants = tenants || [];

    wrap.innerHTML = `
      <div class="system-console-grid">
        <div class="system-card system-card-span-2">
          <div class="system-card-header">
            <div class="system-card-title">Company Directory</div>
            <button class="btn btn-primary btn-sm" id="create-company-btn" type="button">Add Company</button>
          </div>
          <div class="data-table-wrap system-tenant-table-wrap">
            <table class="system-tenant-table">
              <thead>
                <tr>
                  <th>Tenant Name</th>
                  <th>Users</th>
                  <th>Products</th>
                  <th>Open Quotes</th>
                  <th>Pending Approvals</th>
                  <th>Last Activity</th>
                  <th>Onboarding</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                ${(tenants || []).map((tenant) => `
                  <tr class="${tenant.id === currentTenantId ? "system-tenant-current" : ""}">
                    <td>
                      <div class="tenant-directory-name">${esc(tenant.name || tenant.id)}</div>
                      <div class="tenant-directory-id">${esc(tenant.id)}</div>
                    </td>
                    <td>${Number(tenant.user_count || Object.values(tenant.user_counts || {}).reduce((sum, count) => sum + Number(count || 0), 0))}</td>
                    <td>${Number(tenant.product_count || 0)}</td>
                    <td>${Number(tenant.open_quote_count || 0)}</td>
                    <td>${Number(tenant.pending_approval_count || 0)}</td>
                    <td>${esc(systemLastActivityLabel(tenant.last_quote_activity))}</td>
                    <td>
                      <span class="system-status-pill ${systemOnboardingTone(tenant)}">${esc(systemOnboardingSummary(tenant))}</span>
                    </td>
                    <td>
                      <div class="tenant-directory-actions">
                        ${tenant.id === currentTenantId
                          ? '<span class="badge-soft">Current</span>'
                          : `<button class="btn btn-ghost btn-sm" type="button" onclick="switchTenantContext('${esc(tenant.id)}')">Switch</button>`}
                        <button class="btn btn-ghost btn-sm" type="button" onclick="openSystemTenantHealth('${esc(tenant.id)}')">Health</button>
                        <button class="btn btn-ghost btn-sm" type="button" onclick="openSystemTenantFlags('${esc(tenant.id)}')">Flags</button>
                      </div>
                    </td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        </div>

        <div class="system-card system-card-span-2">
          <div class="system-card-title">Tenant Readiness</div>
          <div class="data-table-wrap system-tenant-table-wrap">
            <table class="system-tenant-table">
              <thead>
                <tr>
                  <th>Tenant Name</th>
                  <th>Steps Done</th>
                  <th>Blockers</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                ${(readiness || []).map((row) => `
                  <tr>
                    <td>
                      <div class="tenant-directory-name">${esc(row.tenant_name || row.tenant_id)}</div>
                      <div class="tenant-directory-id">${esc(row.tenant_id)}</div>
                    </td>
                    <td class="mono">${esc(systemReadinessSummary(row))}</td>
                    <td class="system-readiness-blockers">${esc(systemReadinessBlockers(row))}</td>
                    <td><span class="system-status-pill ${systemReadinessTone(row)}">${row.all_done ? "Ready" : "Needs Setup"}</span></td>
                    <td><button class="btn btn-ghost btn-sm" type="button" onclick="openSystemTenantHealth('${esc(row.tenant_id)}')">Health</button></td>
                  </tr>
                `).join("") || `<tr><td colspan="5"><div class="empty-state small">No readiness data available yet.</div></td></tr>`}
              </tbody>
            </table>
          </div>
        </div>

        <div class="system-card">
          <div class="system-card-title">Feature Flags (Current Company)</div>
          <div style="display:grid;gap:8px;">
            ${(flags || []).map((flag) => `<label style="display:flex;justify-content:space-between;align-items:center;border:1px solid var(--border);border-radius:8px;padding:8px;"><span class="mono" style="font-size:11px;">${esc(flag.flag_key)}</span><input type="checkbox" ${flag.enabled ? "checked" : ""} onchange="toggleFeatureFlag('${esc(flag.flag_key)}', this.checked)" /></label>`).join("") || '<div style="color:var(--text-muted);font-size:12px;">No feature flags.</div>'}
          </div>
        </div>

        <div class="system-card">
          <div class="system-card-title">Launch Checklist</div>
          <div class="system-note-list">
            <div class="system-note-item">Create the company shell with an owner account and decide whether to clone a starter catalog.</div>
            <div class="system-note-item">Switch into that company, add users with role presets, then finish products, governance, and address settings.</div>
            <div class="system-note-item">Use company switching to move across tenants without logging out or changing billing infrastructure.</div>
          </div>
        </div>

        <div class="system-card">
          <div class="system-card-title">Impersonation</div>
          <div class="form-group"><label class="form-label">Tenant ID</label><input id="imp-tenant" class="form-input" placeholder="t-sunshine-impact" /></div>
          <div class="form-group"><label class="form-label">User ID</label><input id="imp-user" class="form-input" placeholder="u-rep-001" /></div>
          <button class="btn btn-primary btn-sm" onclick="runImpersonation()">Impersonate</button>
        </div>

        <div class="system-card">
          <div class="system-card-title">Session Context</div>
          <div style="font-size:12px;color:var(--text-secondary);display:grid;gap:6px;">
            <div><span class="mono">User:</span> ${esc(STATE.currentUser?.name || "")}</div>
            <div><span class="mono">Role:</span> ${esc(STATE.currentUser?.role || "")}</div>
            <div><span class="mono">Company:</span> ${esc(currentTenantName())}</div>
            <div><span class="mono">Tenant ID:</span> ${esc(STATE.currentTenant?.id || STATE.currentUser?.tenant_id || "")}</div>
          </div>
        </div>

        <div class="system-card system-card-span-2">
          <div class="system-card-header">
            <div class="system-card-title">Demo Requests</div>
            <div style="display:flex;gap:8px;align-items:center;">
              <input type="date" id="sys-demo-from" class="form-input" style="width:130px;font-size:11px;" placeholder="From" />
              <input type="date" id="sys-demo-to"   class="form-input" style="width:130px;font-size:11px;" placeholder="To" />
              <button class="btn btn-ghost btn-sm" onclick="loadSystemDemoRequests()">Filter</button>
              <a id="sys-demo-export-btn" class="btn btn-ghost btn-sm" href="/api/system/demo-requests/export" target="_blank" download="demo_requests.csv">Export CSV</a>
            </div>
          </div>
          <div id="sys-demo-requests-table">
            <div class="loading-state"><div class="spinner"></div><span>Loading demo requests…</span></div>
          </div>
        </div>
      </div>`;

    el("create-company-btn")?.addEventListener("click", openTenantOnboarding);
    el("refresh-system-btn")?.addEventListener("click", loadSystemConsole);
    loadSystemDemoRequests();
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">${esc(parseErrorMessage(err, "Failed to load system console."))}</div>`;
  }
}

async function loadSystemDemoRequests() {
  const wrap = el("sys-demo-requests-table");
  if (!wrap) return;
  const from = el("sys-demo-from")?.value || "";
  const to   = el("sys-demo-to")?.value   || "";
  const exportBtn = el("sys-demo-export-btn");

  // Update export link with current filters
  if (exportBtn) {
    const ep = new URLSearchParams();
    if (from) ep.set("from_date", from);
    if (to)   ep.set("to_date",   to);
    exportBtn.href = `/api/system/demo-requests/export${ep.toString() ? "?" + ep : ""}`;
  }

  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>`;
  try {
    const params = new URLSearchParams({ limit: 100 });
    if (from) params.set("from_date", from);
    if (to)   params.set("to_date",   to);
    const data = await get(`/system/demo-requests?${params}`);
    const rows = data.items || [];
    if (!rows.length) {
      wrap.innerHTML = `<div class="empty-state small" style="padding:20px;">No demo requests yet. <span style="color:var(--text-secondary);">Submit the landing page form to test.</span></div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="data-table-wrap" style="margin-top:10px;">
        <table class="system-tenant-table">
          <thead><tr>
            <th>Name</th><th>Email</th><th>Company</th><th>Phone</th><th>Size</th><th>Source</th><th>Date</th>
          </tr></thead>
          <tbody>
            ${rows.map(r => `<tr>
              <td>${esc(r.name || "")}</td>
              <td class="mono" style="font-size:11px;">${esc(r.email || "")}</td>
              <td>${esc(r.company || "—")}</td>
              <td>${esc(r.phone || "—")}</td>
              <td>${esc(r.company_size || "—")}</td>
              <td><span class="badge-soft">${esc(r.source || "")}</span></td>
              <td class="mono" style="font-size:11px;">${esc((r.created_at || "").slice(0, 10))}</td>
            </tr>`).join("")}
          </tbody>
        </table>
        <div style="font-size:11px;color:var(--text-secondary);padding:8px 0;">Showing ${rows.length} of ${data.total || rows.length}</div>
      </div>`;
  } catch (e) {
    wrap.innerHTML = `<div class="empty-state small">${esc(parseErrorMessage(e, "Failed to load demo requests."))}</div>`;
  }
}

/* ============================================================
   ALPHA 9.2 ADDITIONS
   ============================================================ */

// ── Alias for user profile close (existing modal uses closeUserProfileModal)
function closeUserProfile() { closeUserProfileModal(); }

// ── Section 5C: Hub Tab Switcher ────────────────────────────
function switchHubTab(tab) {
  document.querySelectorAll(".hub-tab").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.hubtab === tab);
  });
  document.querySelectorAll(".hub-tab-content").forEach(pane => {
    const id = pane.id; // hub-tab-messages | hub-tab-files
    pane.classList.toggle("hidden", !id.endsWith(tab));
  });
}

// ── Section 5C: Quote Files ──────────────────────────────────
async function loadQuoteFiles(quoteId) {
  if (!quoteId) return;
  const list = el("hub-files-list");
  if (!list) return;
  try {
    const files = await get(`/quotes/${quoteId}/files`);
    renderQuoteFiles(files || [], quoteId);
  } catch (e) {
    if (list) list.innerHTML = `<div class="empty-state small">Unable to load files.</div>`;
  }
}

function renderQuoteFiles(files, quoteId) {
  const list = el("hub-files-list");
  if (!list) return;
  if (!files.length) {
    list.innerHTML = `<div class="empty-state small">No files uploaded yet.</div>`;
    return;
  }
  const iconMap = { image: "🖼️", pdf: "📄", video: "🎬", doc: "📝", spreadsheet: "📊" };
  list.innerHTML = files.map(f => {
    const icon = iconMap[f.file_category] || "📎";
    const sizeStr = f.file_size ? formatBytes(f.file_size) : "";
    const catLabel = f.file_category ? humanizeKey(f.file_category) : "General";
    return `
      <div class="file-item">
        <span class="file-icon">${icon}</span>
        <div class="file-meta">
          <div class="file-name" title="${esc(f.file_name)}">${esc(f.file_name)}</div>
          <div class="file-sub">${esc(catLabel)}${sizeStr ? " · " + esc(sizeStr) : ""} · ${timeSince(f.created_at)}</div>
        </div>
        <div class="file-actions">
          <button class="btn btn-ghost btn-sm" onclick="downloadQuoteFile('${esc(f.id)}','${esc(quoteId)}')">↓</button>
          ${hasPerm("can_manage_files") !== false
            ? `<button class="btn btn-ghost btn-sm" style="color:var(--red)" onclick="deleteQuoteFile('${esc(f.id)}','${esc(quoteId)}')">✕</button>`
            : ""}
        </div>
      </div>`;
  }).join("");
}

function triggerQuoteFilePicker() {
  el("hub-file-input")?.click();
}

async function handleQuoteFileUpload(event) {
  const file = event?.target?.files?.[0];
  if (!file || !STATE.currentQuoteId) return;
  const category = el("hub-file-category")?.value || "general";

  const progressWrap = el("hub-file-upload-progress");
  const bar = el("file-upload-bar");
  const label = el("file-upload-label");

  if (progressWrap) progressWrap.classList.remove("hidden");
  if (bar) bar.style.width = "10%";
  if (label) label.textContent = `Uploading ${file.name}…`;

  try {
    const fd = new FormData();
    fd.append("file", file);
    fd.append("file_category", category);

    // Simulate progress since fetch doesn't expose upload progress easily
    let pct = 10;
    const ticker = setInterval(() => {
      pct = Math.min(pct + 15, 85);
      if (bar) bar.style.width = pct + "%";
    }, 300);

    await apiFetch(`/quotes/${STATE.currentQuoteId}/files`, { method: "POST", body: fd });

    clearInterval(ticker);
    if (bar) bar.style.width = "100%";
    if (label) label.textContent = "Upload complete!";
    setTimeout(() => {
      if (progressWrap) progressWrap.classList.add("hidden");
      if (bar) bar.style.width = "0%";
    }, 1200);

    toast("File uploaded.", "success");
    loadQuoteFiles(STATE.currentQuoteId);
  } catch (err) {
    if (progressWrap) progressWrap.classList.add("hidden");
    toast(parseErrorMessage(err, "File upload failed."), "error");
  } finally {
    // Reset file input so same file can be re-selected
    if (event.target) event.target.value = "";
  }
}

async function downloadQuoteFile(fileId, quoteId) {
  try {
    const res = await apiFetch(`/quotes/${quoteId}/files/${fileId}`, { method: "GET" });
    // Backend returns signed URL redirect — open in new tab
    window.open(`${API}/quotes/${quoteId}/files/${fileId}`, "_blank", "noopener");
  } catch (e) {
    window.open(`${API}/quotes/${quoteId}/files/${fileId}`, "_blank", "noopener");
  }
}

async function deleteQuoteFile(fileId, quoteId) {
  if (!confirm("Remove this file from the quote?")) return;
  try {
    await apiFetch(`/quotes/${quoteId}/files/${fileId}`, { method: "DELETE" });
    toast("File removed.", "success");
    loadQuoteFiles(quoteId);
  } catch (err) {
    toast(parseErrorMessage(err, "Could not remove file."), "error");
  }
}

// ── Section 7B: AI Assistant Panel ──────────────────────────
const _aiHistory = []; // in-memory last 5 exchanges

function openAIPanel() {
  const panel = el("ai-assistant-panel");
  const overlay = el("ai-panel-overlay");
  if (!panel || !overlay) return;
  panel.classList.remove("hidden");
  overlay.classList.remove("hidden");
  el("ai-input")?.focus();
}

function closeAIPanel() {
  el("ai-assistant-panel")?.classList.add("hidden");
  el("ai-panel-overlay")?.classList.add("hidden");
}

async function sendAIMessage() {
  const input = el("ai-input");
  const msgBox = el("ai-messages");
  if (!input || !msgBox) return;
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  _appendAIMessage(msgBox, text, "user");

  const typingId = "ai-typing-" + Date.now();
  msgBox.insertAdjacentHTML("beforeend", `<div id="${typingId}" class="ai-msg ai-msg-typing">Thinking…</div>`);
  msgBox.scrollTop = msgBox.scrollHeight;

  // Build context for the request
  const context = el("ai-context-select")?.value || "general";
  const quoteId = STATE.currentQuoteId;
  const contextHint = context === "quote" && quoteId
    ? `Current quote ID: ${quoteId}. Customer: ${STATE.hubContext?.customerName || "unknown"}.`
    : context === "governance"
    ? "Topic: pricing governance rules for impact windows."
    : "";

  try {
    const payload = {
      question: text,
      context: context,
      context_hint: contextHint,
    };
    if (quoteId && context === "quote") payload.quote_id = quoteId;

    const res = await post(`/quotes/${quoteId || "na"}/ai-assist`, payload).catch(async () => {
      // Fallback if no quote context
      return post(`/quotes/none/ai-assist`, payload).catch(() => null);
    });

    document.getElementById(typingId)?.remove();
    const answer = res?.answer || res?.response || "I wasn't able to generate a response. Please try again.";
    _appendAIMessage(msgBox, answer, "assistant");

    // Keep last 5 exchanges in memory
    _aiHistory.push({ role: "user", content: text });
    _aiHistory.push({ role: "assistant", content: answer });
    while (_aiHistory.length > 10) _aiHistory.shift();
  } catch (err) {
    document.getElementById(typingId)?.remove();
    _appendAIMessage(msgBox, "Error: " + parseErrorMessage(err, "AI request failed."), "assistant");
  }
}

function _appendAIMessage(container, text, role) {
  const div = document.createElement("div");
  div.className = `ai-msg ai-msg-${role}`;
  div.textContent = text;
  container.appendChild(div);
  container.scrollTop = container.scrollHeight;
}

// ── Section 8B: SMS Message Templates ───────────────────────
let _messageTemplates = [];

async function loadMessageTemplates() {
  try {
    const templates = await get("/message-templates");
    _messageTemplates = templates || [];
  } catch (e) {
    _messageTemplates = [];
  }
}

function toggleTemplatesPopover() {
  const popover = el("templates-popover");
  if (!popover) return;
  const isHidden = popover.classList.contains("hidden");
  if (isHidden) {
    renderTemplatesPopover();
    popover.classList.remove("hidden");
    // Close on outside click
    setTimeout(() => {
      document.addEventListener("click", _closeTemplatesOnOutsideClick, { once: true });
    }, 50);
  } else {
    popover.classList.add("hidden");
  }
}

function _closeTemplatesOnOutsideClick(e) {
  const pop = el("templates-popover");
  if (pop && !pop.contains(e.target)) {
    pop.classList.add("hidden");
  }
}

function renderTemplatesPopover() {
  const popover = el("templates-popover");
  if (!popover) return;
  if (!_messageTemplates.length) {
    popover.innerHTML = `<div style="padding:12px;font-size:12px;color:var(--text-secondary)">No templates yet. Add them in Settings.</div>`;
    return;
  }
  popover.innerHTML = _messageTemplates.map(t => `
    <div class="template-item" onclick="insertTemplate('${esc(t.id)}')">
      <div class="template-item-name">${esc(t.name)}</div>
      <div class="template-item-preview">${esc(t.body)}</div>
    </div>
  `).join("");
}

function insertTemplate(templateId) {
  const t = _messageTemplates.find(x => x.id === templateId);
  if (!t) return;
  const input = el("hub-input");
  if (input) {
    input.value = t.body;
    input.focus();
  }
  el("templates-popover")?.classList.add("hidden");
}

// ── Section 8C: Lightbox ─────────────────────────────────────
function openLightbox(url) {
  const overlay = el("lightbox-overlay");
  const img = el("lightbox-img");
  if (!overlay || !img) return;
  img.src = url;
  overlay.classList.remove("hidden");
  document.addEventListener("keydown", _closeLightboxOnEsc);
}

function closeLightbox() {
  el("lightbox-overlay")?.classList.add("hidden");
  const img = el("lightbox-img");
  if (img) img.src = "";
  document.removeEventListener("keydown", _closeLightboxOnEsc);
}

function _closeLightboxOnEsc(e) {
  if (e.key === "Escape") closeLightbox();
}

// ── Section 6B: Service Worker Registration ──────────────────
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/static/sw.js")
      .then(reg => console.log("[WindowCalc] SW registered:", reg.scope))
      .catch(err => console.warn("[WindowCalc] SW registration failed:", err));
  });
}

// ── Bootstrap templates on init ─────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  // Load SMS templates after a short delay (non-blocking)
  setTimeout(() => loadMessageTemplates(), 2000);
  // Start unread message polling (Tier 6)
  startUnreadPolling();
});


/* ============================================================
   ALPHA 9.3 — AI PRICING STUDIO
   ============================================================ */

// ── State ────────────────────────────────────────────────────
const _aiStudio = {
  profiles: [],
  activeProfileId: null,
  activeProfile: null,
  activeEntries: [],
  selectedEntryIds: new Set(),
  featureFlagEnabled: null, // null = not yet fetched
  wizardStep: 1,
  wizardData: {},
};

// ── Feature Flag Gate ────────────────────────────────────────
async function _loadAIStudioFlag() {
  if (_aiStudio.featureFlagEnabled !== null) return _aiStudio.featureFlagEnabled;
  try {
    const flags = await get("/feature-flags").catch(() => []);
    const flag = (flags || []).find(f => f.flag_key === "ai_pricing_studio");
    _aiStudio.featureFlagEnabled = flag ? Boolean(flag.enabled) : false;
  } catch (_) {
    _aiStudio.featureFlagEnabled = false;
  }
  return _aiStudio.featureFlagEnabled;
}

function _canUseAIStudio() {
  const role = (STATE.currentUser?.role || "").toLowerCase();
  const hasProdPerm = hasPerm("can_manage_products") || hasPerm("can_manage_governance");
  return (role === "owner" || role === "sysop" || (role === "manager" && hasProdPerm));
}

async function _syncAIStudioButton() {
  const btn = el("ai-pricing-studio-btn");
  if (!btn) return;
  await _loadAIStudioFlag();
  const show = _canUseAIStudio() && _aiStudio.featureFlagEnabled;
  btn.style.display = show ? "" : "none";
}

// ── Open / Close ─────────────────────────────────────────────
async function openAIPricingStudio() {
  if (!_canUseAIStudio()) {
    toast("AI Pricing Studio requires owner or manager permissions.", "warning");
    return;
  }
  el("ai-studio-overlay")?.classList.remove("hidden");
  el("ai-studio-modal")?.classList.remove("hidden");
  await loadAIProfiles();
}

function closeAIPricingStudio() {
  el("ai-studio-overlay")?.classList.add("hidden");
  el("ai-studio-modal")?.classList.add("hidden");
}

// ── Section 5B: Profile List ─────────────────────────────────
async function loadAIProfiles() {
  const list = el("ai-studio-profile-list");
  if (!list) return;
  list.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading…</span></div>`;
  try {
    const profiles = await get("/ai-pricing/profiles");
    _aiStudio.profiles = profiles || [];
    renderAIProfileList();
    // Auto-select first
    if (_aiStudio.profiles.length && !_aiStudio.activeProfileId) {
      await selectAIProfile(_aiStudio.profiles[0].id);
    } else if (!_aiStudio.profiles.length) {
      el("ai-studio-detail").innerHTML = `
        <div class="empty-state" style="margin:auto;">
          <div class="empty-icon">✦</div>
          <div>No profiles yet.</div>
          <button class="btn btn-primary" style="margin-top:14px;" onclick="openNewProfileWizard()">Create Your First Profile</button>
        </div>`;
    }
  } catch (e) {
    list.innerHTML = `<div class="empty-state small">${esc(parseErrorMessage(e, "Failed to load profiles."))}</div>`;
  }
}

function renderAIProfileList() {
  const list = el("ai-studio-profile-list");
  if (!list) return;
  if (!_aiStudio.profiles.length) {
    list.innerHTML = `<div class="empty-state small" style="padding:16px;font-size:12px;">No profiles yet.</div>`;
    return;
  }
  list.innerHTML = _aiStudio.profiles.map(p => `
    <div class="ai-profile-item ${p.id === _aiStudio.activeProfileId ? "active" : ""}"
         onclick="selectAIProfile('${esc(p.id)}')">
      <div class="ai-profile-item-name">${esc(p.name)}</div>
      <div class="ai-profile-item-meta">
        <span class="ai-status-badge ai-status-${esc(p.status)}">${esc(p.status)}</span>
        &nbsp;${p.product_count || 0} products · ${timeSince(p.created_at)}
      </div>
      <div class="ai-profile-item-actions">
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();refineWithAI('${esc(p.id)}')">✦ Refine</button>
        <button class="btn btn-ghost btn-sm" onclick="event.stopPropagation();archiveAIProfile('${esc(p.id)}')">Archive</button>
      </div>
    </div>
  `).join("");
}

// ── Section 5B: Profile Detail ───────────────────────────────
async function selectAIProfile(pid) {
  _aiStudio.activeProfileId = pid;
  _aiStudio.selectedEntryIds.clear();
  renderAIProfileList(); // refresh active highlight
  const detail = el("ai-studio-detail");
  detail.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading profile…</span></div>`;
  try {
    const data = await get(`/ai-pricing/profiles/${pid}`);
    _aiStudio.activeProfile = data.profile;
    _aiStudio.activeEntries = data.entries || [];
    renderAIProfileDetail();
  } catch (e) {
    detail.innerHTML = `<div class="empty-state small">${esc(parseErrorMessage(e, "Failed to load profile."))}</div>`;
  }
}

function renderAIProfileDetail() {
  const p = _aiStudio.activeProfile;
  const entries = _aiStudio.activeEntries;
  const detail = el("ai-studio-detail");
  if (!p || !detail) return;

  const periodStart = p.note ? "" : "";
  const sampleEntry = entries[0];
  const dataStart = sampleEntry?.data_period_start || "—";
  const dataEnd   = sampleEntry?.data_period_end   || "—";
  const avgSample = entries.length
    ? Math.round(entries.reduce((s, e) => s + (e.sample_size || 0), 0) / entries.length)
    : 0;

  detail.innerHTML = `
    <div class="ai-studio-info-banner">
      ⚠ AI suggestions are advisory. Applying a profile will update your product pricing.
      Review low-sample or large-change products carefully before applying.
    </div>

    <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
      <div>
        <div style="font-size:16px;font-weight:700;color:var(--text-primary)">${esc(p.name)}</div>
        ${p.note ? `<div style="font-size:12px;color:var(--text-secondary);margin-top:3px;">${esc(p.note)}</div>` : ""}
      </div>
      <span class="ai-status-badge ai-status-${esc(p.status)}">${esc(p.status)}</span>
    </div>

    <div class="ai-studio-summary-row">
      <div class="ai-summary-card">
        <div class="ai-summary-card-label">Products</div>
        <div class="ai-summary-card-val">${entries.length}</div>
      </div>
      <div class="ai-summary-card">
        <div class="ai-summary-card-label">Avg Sample</div>
        <div class="ai-summary-card-val">${avgSample}</div>
      </div>
      <div class="ai-summary-card">
        <div class="ai-summary-card-label">Period Start</div>
        <div class="ai-summary-card-val" style="font-size:13px;">${esc(dataStart)}</div>
      </div>
      <div class="ai-summary-card">
        <div class="ai-summary-card-label">Period End</div>
        <div class="ai-summary-card-val" style="font-size:13px;">${esc(dataEnd)}</div>
      </div>
    </div>

    <div class="ai-studio-toolbar">
      <label style="font-size:12px;font-weight:600;color:var(--text-secondary);">
        <input type="checkbox" id="ai-select-all" onchange="toggleSelectAllEntries(this.checked)" />
        &nbsp;Select All
      </label>
      <button class="btn btn-primary btn-sm" onclick="applyAIPricing('selected_products')">Apply Selected</button>
      <button class="btn btn-ghost btn-sm" onclick="applyAIPricing('all_products')">Apply All Products</button>
      <button class="btn btn-ghost btn-sm" onclick="refineWithAI('${esc(p.id)}')">✦ Refine with AI</button>
      <button class="btn btn-ghost btn-sm" onclick="showTestSimulationModal('${esc(p.id)}')">📊 Test Impact</button>
    </div>

    ${entries.length ? `
    <div class="ai-entries-table-wrap">
      <table class="ai-entries-table">
        <thead>
          <tr>
            <th style="width:28px;"></th>
            <th>Product</th>
            <th>Line</th>
            <th>Sample</th>
            <th>Current Cost</th>
            <th>Avg Sell</th>
            <th>Avg Margin</th>
            <th>AI Markup %</th>
            <th>AI Sell Price</th>
            <th>Δ Price</th>
          </tr>
        </thead>
        <tbody>
          ${entries.map(e => {
            const currentEst = e.current_base_cost
              ? fmtMoney(e.current_base_cost)
              : "—";
            const delta = (e.ai_suggested_sell_price && e.avg_sell_price)
              ? e.ai_suggested_sell_price - e.avg_sell_price
              : null;
            const deltaClass = delta === null ? "ai-delta-neutral" : delta > 0 ? "ai-delta-positive" : "ai-delta-negative";
            const deltaStr = delta === null ? "—" : (delta > 0 ? "+" : "") + fmtMoney(delta);
            const flagLowSample = (e.sample_size || 0) < 5;
            return `<tr title="${flagLowSample ? "⚠ Low sample size — review carefully" : ""}">
              <td><input type="checkbox" class="ai-entry-cb" data-id="${esc(e.product_id)}"
                         onchange="toggleEntrySelection('${esc(e.product_id)}', this.checked)"
                         ${_aiStudio.selectedEntryIds.has(e.product_id) ? "checked" : ""} /></td>
              <td>${esc(e.product_name || e.product_id)}${flagLowSample ? " <span title='Low sample'>⚠</span>" : ""}</td>
              <td style="color:var(--text-secondary)">${esc(e.product_line || "—")}</td>
              <td class="mono">${e.sample_size || 0}</td>
              <td class="mono">${currentEst}</td>
              <td class="mono">${e.avg_sell_price ? fmtMoney(e.avg_sell_price) : "—"}</td>
              <td class="mono">${e.avg_margin_pct != null ? fmtPct(e.avg_margin_pct) : "—"}</td>
              <td class="mono">${e.ai_suggested_markup_pct != null ? fmtPct(e.ai_suggested_markup_pct) : "—"}</td>
              <td class="mono">${e.ai_suggested_sell_price ? fmtMoney(e.ai_suggested_sell_price) : "—"}</td>
              <td class="mono ${deltaClass}">${deltaStr}</td>
            </tr>`;
          }).join("")}
        </tbody>
      </table>
    </div>
    ` : `<div class="empty-state small">No entries in this profile. Try creating a new profile with a wider date range.</div>`}
  `;
}

function toggleSelectAllEntries(checked) {
  _aiStudio.selectedEntryIds.clear();
  if (checked) {
    _aiStudio.activeEntries.forEach(e => _aiStudio.selectedEntryIds.add(e.product_id));
  }
  document.querySelectorAll(".ai-entry-cb").forEach(cb => {
    cb.checked = checked;
  });
}

function toggleEntrySelection(productId, checked) {
  if (checked) {
    _aiStudio.selectedEntryIds.add(productId);
  } else {
    _aiStudio.selectedEntryIds.delete(productId);
    const selectAll = el("ai-select-all");
    if (selectAll) selectAll.checked = false;
  }
}

// ── Apply AI Pricing ─────────────────────────────────────────
async function applyAIPricing(scope) {
  const pid = _aiStudio.activeProfileId;
  if (!pid) return;

  const productIds = scope === "selected_products"
    ? [..._aiStudio.selectedEntryIds]
    : [];

  if (scope === "selected_products" && productIds.length === 0) {
    toast("Select at least one product to apply.", "warning");
    return;
  }

  const entryCount = scope === "all_products"
    ? _aiStudio.activeEntries.length
    : productIds.length;

  if (!confirm(`Apply AI pricing suggestions to ${entryCount} product(s)? This will update base costs in your product catalog.`)) return;

  try {
    const result = await post(`/ai-pricing/profiles/${pid}/apply`, {
      scope,
      product_ids: productIds,
    });
    toast(`✓ Updated ${result.updated_count} product(s). ${result.skipped_count} skipped.`, "success");
    // Refresh profile detail and reload products in background
    await selectAIProfile(pid);
    loadProducts().catch(() => {});
  } catch (e) {
    toast(parseErrorMessage(e, "Failed to apply AI pricing."), "error");
  }
}

// ── Refine with AI ───────────────────────────────────────────
async function refineWithAI(pid) {
  const profileId = pid || _aiStudio.activeProfileId;
  if (!profileId) return;
  toast("Running AI refinement…", "info");
  try {
    const result = await post(`/ai-pricing/profiles/${profileId}/refine-with-ai`, {});
    if (result.ok) {
      toast(result.mode === "stub"
        ? "Stub refinement applied (+1.5% markup nudge). Configure AI_PRICING_API_KEY for full refinement."
        : "AI refinement complete.", "success");
      if (_aiStudio.activeProfileId === profileId) await selectAIProfile(profileId);
    } else {
      toast("AI refinement not configured. Set AI_PRICING_API_URL + AI_PRICING_API_KEY to enable.", "warning");
    }
  } catch (e) {
    toast(parseErrorMessage(e, "Refinement failed."), "error");
  }
}

// ── Archive ──────────────────────────────────────────────────
async function archiveAIProfile(pid) {
  if (!confirm("Archive this profile? It will be hidden from the list.")) return;
  try {
    await apiFetch(`/ai-pricing/profiles/${pid}`, {
      method: "PATCH",
      body: JSON.stringify({ status: "archived" }),
    });
    toast("Profile archived.", "success");
    if (_aiStudio.activeProfileId === pid) {
      _aiStudio.activeProfileId = null;
      _aiStudio.activeProfile = null;
      _aiStudio.activeEntries = [];
    }
    await loadAIProfiles();
  } catch (e) {
    toast(parseErrorMessage(e, "Could not archive profile."), "error");
  }
}

// ── Test Simulation (Tier 4-F) ───────────────────────────────
async function showTestSimulationModal(pid) {
  const profileId = pid || _aiStudio.activeProfileId;
  if (!profileId) return;

  // Create modal
  const modal = document.createElement("div");
  modal.className = "modal-overlay";
  modal.innerHTML = `
    <div class="modal-panel" style="max-width:700px;">
      <h3 style="margin-top:0;">Test Profile Against Recent Quotes</h3>
      <div class="loading-state"><div class="spinner"></div><span>Simulating impact on 20 recent quotes…</span></div>
    </div>
  `;
  document.body.appendChild(modal);

  try {
    const result = await post(`/ai-pricing/profiles/${profileId}/test-simulation`, { sample_size: 20 });

    modal.innerHTML = `
      <div class="modal-panel" style="max-width:700px;">
        <h3 style="margin-top:0;">Simulation Results</h3>
        <div style="background:var(--bg-elevated);padding:12px;border-radius:6px;margin-bottom:16px;">
          <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;">
            <div>
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;">Quotes Tested</div>
              <div style="font-size:18px;font-weight:700;">${result.quotes_tested}</div>
            </div>
            <div>
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;">Avg Margin Δ</div>
              <div style="font-size:18px;font-weight:700;color:${result.avg_margin_delta_pct > 0 ? 'var(--green)' : 'var(--red)'}">${result.avg_margin_delta_pct > 0 ? '+' : ''}${result.avg_margin_delta_pct}%</div>
            </div>
            <div>
              <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;">Total Revenue Δ</div>
              <div style="font-size:18px;font-weight:700;color:${result.total_revenue_delta > 0 ? 'var(--green)' : 'var(--red)'}">${result.total_revenue_delta > 0 ? '+' : ''}${fmtMoney(result.total_revenue_delta)}</div>
            </div>
          </div>
        </div>

        ${result.sample && result.sample.length ? `
        <div style="max-height:400px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;margin-bottom:16px;">
          <table style="width:100%;font-size:12px;">
            <thead style="background:var(--bg-elevated);position:sticky;top:0;">
              <tr>
                <th style="padding:8px;text-align:left;border-bottom:1px solid var(--border);">Quote</th>
                <th style="padding:8px;text-align:right;border-bottom:1px solid var(--border);">Actual</th>
                <th style="padding:8px;text-align:right;border-bottom:1px solid var(--border);">Simulated</th>
                <th style="padding:8px;text-align:right;border-bottom:1px solid var(--border);">Δ</th>
                <th style="padding:8px;text-align:right;border-bottom:1px solid var(--border);">Margin Δ</th>
              </tr>
            </thead>
            <tbody>
              ${result.sample.map(s => `
              <tr style="border-bottom:1px solid var(--border);">
                <td style="padding:8px;">${esc(s.customer_name || s.quote_id.slice(0,8))}</td>
                <td style="padding:8px;text-align:right;font-family:var(--font-mono);">${fmtMoney(s.actual_total)}</td>
                <td style="padding:8px;text-align:right;font-family:var(--font-mono);">${fmtMoney(s.simulated_total)}</td>
                <td style="padding:8px;text-align:right;font-family:var(--font-mono);color:${s.delta > 0 ? 'var(--green)' : 'var(--red)'}">${s.delta > 0 ? '+' : ''}${fmtMoney(s.delta)}</td>
                <td style="padding:8px;text-align:right;font-family:var(--font-mono);color:${s.simulated_margin_pct > s.actual_margin_pct ? 'var(--green)' : 'var(--red)'}">${s.simulated_margin_pct - s.actual_margin_pct > 0 ? '+' : ''}${(s.simulated_margin_pct - s.actual_margin_pct).toFixed(1)}%</td>
              </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
        ` : ''}

        <div style="display:flex;gap:8px;margin-top:16px;">
          <button class="btn btn-primary" onclick="this.closest('.modal-overlay').remove();">Close</button>
        </div>
      </div>
    `;
  } catch (e) {
    modal.innerHTML = `
      <div class="modal-panel">
        <h3 style="margin-top:0;">Test Failed</h3>
        <p>${esc(parseErrorMessage(e, "Could not run simulation."))}</p>
        <button class="btn btn-ghost" onclick="this.closest('.modal-overlay').remove();">Close</button>
      </div>
    `;
  }

  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.remove();
  });
}

// ── Section 5C: New Profile Wizard ───────────────────────────
function openNewProfileWizard() {
  _aiStudio.wizardStep = 1;
  _aiStudio.wizardData = {
    name: "",
    note: "",
    from_date: new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10),
    to_date: new Date().toISOString().slice(0, 10),
    include_statuses: ["approved", "completed"],
    min_sample_size: 3,
  };
  el("ai-wizard-overlay")?.classList.remove("hidden");
  el("ai-wizard-modal")?.classList.remove("hidden");
  renderWizardStep();
}

function closeNewProfileWizard() {
  el("ai-wizard-overlay")?.classList.add("hidden");
  el("ai-wizard-modal")?.classList.add("hidden");
}

function renderWizardStep() {
  const body = el("ai-wizard-body");
  if (!body) return;
  const d = _aiStudio.wizardData;
  const step = _aiStudio.wizardStep;

  const stepIndicator = `
    <div class="wizard-step-indicator">
      <div class="wizard-step-dot ${step === 1 ? "active" : "done"}">1</div>
      <div class="wizard-step-line"></div>
      <div class="wizard-step-dot ${step === 2 ? "active" : step > 2 ? "done" : ""}">2</div>
      <div class="wizard-step-line"></div>
      <div class="wizard-step-dot ${step === 3 ? "active" : ""}">3</div>
    </div>`;

  if (step === 1) {
    body.innerHTML = `
      ${stepIndicator}
      <h3 style="font-size:14px;font-weight:700;margin-bottom:14px;">Step 1: Name &amp; Date Range</h3>
      <div class="form-group">
        <label class="form-label">Profile Name <span style="color:var(--red)">*</span></label>
        <input id="wiz-name" class="form-input" type="text" placeholder="e.g. Spring 2026 Pricing Draft"
               value="${esc(d.name)}" />
      </div>
      <div class="form-group">
        <label class="form-label">Note (optional)</label>
        <input id="wiz-note" class="form-input" type="text" placeholder="Brief description"
               value="${esc(d.note)}" />
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-group">
          <label class="form-label">From Date</label>
          <input id="wiz-from" class="form-input" type="date" value="${esc(d.from_date)}" />
        </div>
        <div class="form-group">
          <label class="form-label">To Date</label>
          <input id="wiz-to" class="form-input" type="date" value="${esc(d.to_date)}" />
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Include Statuses</label>
        <div style="display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;">
          ${["approved","completed","pending_approval","draft"].map(s => `
            <label style="display:flex;align-items:center;gap:6px;font-size:13px;">
              <input type="checkbox" value="${s}"
                     ${d.include_statuses.includes(s) ? "checked" : ""}
                     onchange="wizardToggleStatus('${s}', this.checked)" />
              ${humanizeKey(s)}
            </label>`).join("")}
        </div>
      </div>
      <div class="form-group">
        <label class="form-label">Min Openings Per Product</label>
        <input id="wiz-min-sample" class="form-input" type="number" min="1" max="100"
               value="${d.min_sample_size}" style="max-width:120px;" />
      </div>
      <div class="wizard-nav">
        <button class="btn btn-ghost" onclick="closeNewProfileWizard()">Cancel</button>
        <button class="btn btn-primary" onclick="wizardNext(1)">Next →</button>
      </div>`;
  } else if (step === 2) {
    body.innerHTML = `
      ${stepIndicator}
      <h3 style="font-size:14px;font-weight:700;margin-bottom:14px;">Step 2: Review Settings</h3>
      <div style="background:var(--surface-2);border:1px solid var(--border);border-radius:8px;padding:14px;font-size:13px;display:grid;gap:8px;">
        <div><strong>Name:</strong> ${esc(d.name)}</div>
        <div><strong>Period:</strong> ${esc(d.from_date)} → ${esc(d.to_date)}</div>
        <div><strong>Statuses:</strong> ${d.include_statuses.map(humanizeKey).join(", ")}</div>
        <div><strong>Min sample per product:</strong> ${d.min_sample_size}</div>
        ${d.note ? `<div><strong>Note:</strong> ${esc(d.note)}</div>` : ""}
      </div>
      <div class="ai-studio-info-banner" style="margin-top:12px;">
        WindowCalc will scan your historical quotes and openings to compute average sell prices and margins per product.
        Products with fewer than <strong>${d.min_sample_size}</strong> openings will be excluded.
      </div>
      <div class="wizard-nav">
        <button class="btn btn-ghost" onclick="_aiStudio.wizardStep=1;renderWizardStep()">← Back</button>
        <button class="btn btn-primary" onclick="wizardNext(2)">Create Profile →</button>
      </div>`;
  } else if (step === 3) {
    body.innerHTML = `
      ${stepIndicator}
      <div style="text-align:center;padding:24px 0;">
        <div style="font-size:32px;margin-bottom:12px;">✦</div>
        <div style="font-size:15px;font-weight:700;color:var(--text-primary);margin-bottom:8px;">Building Profile…</div>
        <div style="font-size:12px;color:var(--text-secondary);">Scanning historical data. This takes just a moment.</div>
        <div class="spinner" style="margin:20px auto;"></div>
      </div>`;
  }
}

function wizardToggleStatus(status, checked) {
  const d = _aiStudio.wizardData;
  if (checked && !d.include_statuses.includes(status)) {
    d.include_statuses.push(status);
  } else if (!checked) {
    d.include_statuses = d.include_statuses.filter(s => s !== status);
  }
}

async function wizardNext(fromStep) {
  if (fromStep === 1) {
    // Collect step 1 values
    const name = (el("wiz-name")?.value || "").trim();
    if (!name) { toast("Profile name is required.", "warning"); return; }
    _aiStudio.wizardData.name        = name;
    _aiStudio.wizardData.note        = (el("wiz-note")?.value || "").trim();
    _aiStudio.wizardData.from_date   = el("wiz-from")?.value || _aiStudio.wizardData.from_date;
    _aiStudio.wizardData.to_date     = el("wiz-to")?.value   || _aiStudio.wizardData.to_date;
    _aiStudio.wizardData.min_sample_size = parseInt(el("wiz-min-sample")?.value || "3", 10) || 3;
    if (!_aiStudio.wizardData.include_statuses.length) {
      toast("Select at least one quote status.", "warning"); return;
    }
    _aiStudio.wizardStep = 2;
    renderWizardStep();
  } else if (fromStep === 2) {
    _aiStudio.wizardStep = 3;
    renderWizardStep();
    const d = _aiStudio.wizardData;
    try {
      const result = await post("/ai-pricing/profiles/from-history", {
        name: d.name,
        note: d.note || undefined,
        filters: {
          from_date: d.from_date,
          to_date: d.to_date,
          include_statuses: d.include_statuses,
          min_sample_size: d.min_sample_size,
        },
      });
      const s = result.profile.summary;
      toast(`✓ Profile created — ${s.products_included} products analyzed (avg ${Math.round(s.avg_sample_size)} openings each).`, "success");
      closeNewProfileWizard();
      await loadAIProfiles();
      if (result.profile?.id) await selectAIProfile(result.profile.id);
    } catch (e) {
      toast(parseErrorMessage(e, "Failed to create profile."), "error");
      _aiStudio.wizardStep = 2;
      renderWizardStep();
    }
  }
}


/* ============================================================
   ALPHA 9.4 — PRICING INTELLIGENCE + MARKETING
   ============================================================ */

// ── State ────────────────────────────────────────────────────
const pricingIntelState = {
  activeTab:       "overview",
  filters: {
    from_date:       "",
    to_date:         "",
    brand:           "",
    product_line:    "",
    rep_id:          "",
    approved_only:   false,
    discounted_only: false,
  },
  cache: {
    overview:         null,
    brandModels:      null,
    categories:       null,
    brandComparison:  null,
    reps:             null,
  },
  repSortCol: "opening_count",
  repSortDir: "desc",
  selectedModel: null,
  featureFlagEnabled: null,
};

// ── Auth/session state helpers ────────────────────────────────

/** Wipe all authenticated UI to clean defaults. Call before showing marketing or login. */
function clearAuthenticatedUiState() {
  // KPI cards → dashes (not "?")
  const kpiIds = ["stat-active-quotes", "stat-pending-approvals", "stat-avg-margin", "stat-total-revenue"];
  kpiIds.forEach(id => { const n = el(id); if (n) n.textContent = "—"; });
  const subIds = ["stat-active-quotes-sub", "stat-pending-approvals-sub", "stat-avg-margin-sub", "stat-total-revenue-sub"];
  subIds.forEach(id => { const n = el(id); if (n) n.textContent = ""; });
  // Quote feed — clear
  const feed = el("quote-feed");
  if (feed) feed.innerHTML = "";
  // Header labels → defaults
  if (el("session-user-name"))    el("session-user-name").textContent    = "Not Signed In";
  if (el("session-company-name")) el("session-company-name").textContent = "No Company Selected";
  if (el("session-role-badge"))   { el("session-role-badge").textContent = "viewer"; el("session-role-badge").className = "role-badge role-viewer"; }
  // Hide no-tenant panel if visible
  el("no-tenant-panel")?.classList.add("hidden");
  // Clear STATE
  STATE.currentUser         = null;
  STATE.currentTenant       = null;
  STATE.availableTenants    = [];
  STATE.auth.impersonatedBy = null;
  STATE.auth.impersonator   = null;
  STATE.auth.ready          = false;
}

/** Full unauthenticated transition — clear UI + show marketing landing. */
function enterUnauthenticatedState(msg = "") {
  clearAuthenticatedUiState();
  _coreShowAuthShell(msg);           // sets auth-required, clears tenant UI
  el("auth-shell")?.classList.add("hidden"); // marketing is the front door
  showMarketingLanding();
}

/** User is authenticated but has no company/tenant. Show a clear no-tenant state instead of broken dashboard. */
function enterNoTenantState() {
  // Clear stale KPI "?"
  const kpiIds = ["stat-active-quotes", "stat-pending-approvals", "stat-avg-margin", "stat-total-revenue"];
  kpiIds.forEach(id => { const n = el(id); if (n) n.textContent = "—"; });
  const subIds = ["stat-active-quotes-sub", "stat-pending-approvals-sub", "stat-avg-margin-sub", "stat-total-revenue-sub"];
  subIds.forEach(id => { const n = el(id); if (n) n.textContent = ""; });
  // Clear quote feed
  const feed = el("quote-feed");
  if (feed) feed.innerHTML = "";
  // Show the no-tenant panel inside the dashboard tab
  el("no-tenant-panel")?.classList.remove("hidden");
  setApiStatus("error");
}

/**
 * Central handler for protected loader failures.
 * @param {Error} err  - error from apiFetch
 * @param {string} context - human label for toast message
 */
function handleProtectedLoadFailure(err, context) {
  const status = err?.status;
  if (status === 401) {
    enterUnauthenticatedState("Session expired. Please sign in again.");
  } else if (status === 403) {
    if (context) toast(`Access denied — ${context}.`, "warning");
  } else if (!STATE.currentTenant) {
    enterNoTenantState();
  } else if (context) {
    toast(`Failed to load ${context}.`, "error");
  }
}

// ── Auth shell: single unified definitions ────────────────────
// No _orig* indirection — _coreShowAuthShell/_coreHideAuthShell
// are the raw DOM operations; these wrappers own the marketing/app split.

function showAuthShell(msg = "") {
  // 1. Wipe stale authenticated UI so nothing fake persists
  clearAuthenticatedUiState();
  // 2. Run core auth-shell logic (auth-required class, clear tenant, etc.)
  _coreShowAuthShell(msg);
  // 3. Marketing landing is the front door — keep login form hidden
  el("auth-shell")?.classList.add("hidden");
  showMarketingLanding();
  finishBoot();
}

function hideAuthShell() {
  _coreHideAuthShell();
  hideMarketingLanding();
  finishBoot();
}

function showMarketingLanding() {
  el("marketing-landing")?.classList.remove("hidden");
}
function hideMarketingLanding() {
  el("marketing-landing")?.classList.add("hidden");
}
function showLoginFromMarketing() {
  hideMarketingLanding();
  _coreShowAuthShell("");
  finishBoot();
}

// ── Feature flag check ───────────────────────────────────────
async function _loadPIFlag() {
  if (pricingIntelState.featureFlagEnabled !== null) return pricingIntelState.featureFlagEnabled;
  try {
    const flags = await get("/feature-flags").catch(() => []);
    const flag  = (flags || []).find(f => f.flag_key === "pricing_intelligence_console");
    pricingIntelState.featureFlagEnabled = flag ? Boolean(flag.enabled) : false;
  } catch (_) {
    pricingIntelState.featureFlagEnabled = false;
  }
  return pricingIntelState.featureFlagEnabled;
}

function _canViewPI() {
  const role = (STATE.currentUser?.role || "").toLowerCase();
  if (role === "owner" || role === "sysop") return true;
  if (role === "manager") {
    // Explicit perm OR manager toggle (checked server-side; we trust server; just show UI)
    return hasPerm("can_view_pricing_intelligence") ||
           String(STATE.globalSettings?.pricing_intelligence_managers) === "1";
  }
  return false;
}

async function _syncPISidebarButton() {
  const btn = el("pricing-intel-tab-btn");
  if (!btn) return;
  await _loadPIFlag();
  const show = pricingIntelState.featureFlagEnabled && _canViewPI();
  btn.style.display = show ? "" : "none";
  // Also patch applyPermissions tabPerm map runtime
  if (show) {
    // register tab in switchAdminTab dynamically
    _piTabRegistered = true;
  }
}
let _piTabRegistered = false;

// ── Entry point ──────────────────────────────────────────────
async function openPricingIntelligencePanel() {
  // Pre-fill filter defaults
  if (!pricingIntelState.filters.from_date) {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    pricingIntelState.filters.from_date = d.toISOString().slice(0, 10);
  }
  if (!pricingIntelState.filters.to_date) {
    pricingIntelState.filters.to_date = new Date().toISOString().slice(0, 10);
  }
  _syncPIFilterInputs();
  _populatePIRepDropdown();
  _populatePIBrandDropdown();
  setPricingIntelligenceTab(pricingIntelState.activeTab);
}

function _syncPIFilterInputs() {
  const f = pricingIntelState.filters;
  if (el("pi-from-date"))      el("pi-from-date").value      = f.from_date || "";
  if (el("pi-to-date"))        el("pi-to-date").value        = f.to_date   || "";
  if (el("pi-filter-brand"))   el("pi-filter-brand").value   = f.brand     || "";
  if (el("pi-filter-line"))    el("pi-filter-line").value    = f.product_line || "";
  if (el("pi-filter-rep"))     el("pi-filter-rep").value     = f.rep_id    || "";
  if (el("pi-approved-only"))  el("pi-approved-only").checked  = !!f.approved_only;
  if (el("pi-discounted-only")) el("pi-discounted-only").checked = !!f.discounted_only;
}

function _populatePIRepDropdown() {
  const sel = el("pi-filter-rep");
  if (!sel) return;
  const reps = (STATE.users || []).filter(u => u.role === "rep");
  const existing = sel.querySelectorAll("option:not([value=''])").length;
  if (existing > 0) return;
  reps.forEach(r => {
    const o = document.createElement("option");
    o.value = r.id; o.textContent = r.name || r.email;
    sel.appendChild(o);
  });
}

function _populatePIBrandDropdown() {
  const sel = el("pi-filter-brand");
  if (!sel) return;
  const brands = [...new Set((STATE.products || []).map(p => p.manufacturer).filter(Boolean))];
  const existing = sel.querySelectorAll("option:not([value=''])").length;
  if (existing > 0) return;
  brands.forEach(b => {
    const o = document.createElement("option");
    o.value = b; o.textContent = b;
    sel.appendChild(o);
  });
}

function applyPricingIntelFilters() {
  const f = pricingIntelState.filters;
  f.from_date       = el("pi-from-date")?.value || "";
  f.to_date         = el("pi-to-date")?.value   || "";
  f.brand           = el("pi-filter-brand")?.value || "";
  f.product_line    = el("pi-filter-line")?.value  || "";
  f.rep_id          = el("pi-filter-rep")?.value   || "";
  f.approved_only   = el("pi-approved-only")?.checked  || false;
  f.discounted_only = el("pi-discounted-only")?.checked || false;
  // Bust cache
  pricingIntelState.cache = {
    overview: null, brandModels: null, categories: null, brandComparison: null, reps: null
  };
  setPricingIntelligenceTab(pricingIntelState.activeTab);
}

function resetPricingIntelFilters() {
  const d = new Date(); d.setFullYear(d.getFullYear() - 1);
  pricingIntelState.filters = {
    from_date: d.toISOString().slice(0, 10),
    to_date:   new Date().toISOString().slice(0, 10),
    brand: "", product_line: "", rep_id: "",
    approved_only: false, discounted_only: false,
  };
  pricingIntelState.cache = {
    overview: null, brandModels: null, categories: null, brandComparison: null, reps: null
  };
  _syncPIFilterInputs();
  setPricingIntelligenceTab(pricingIntelState.activeTab);
}

// ── Tab switching ────────────────────────────────────────────
function setPricingIntelligenceTab(tabName) {
  pricingIntelState.activeTab = tabName;
  qsa(".pi-tab").forEach(t => t.classList.toggle("active", t.dataset.pitab === tabName));
  qsa(".pi-pane").forEach(p => {
    const paneId = "pi-pane-" + p.id.replace("pi-pane-", "");
    p.classList.toggle("hidden", p.id !== "pi-pane-" + tabName);
    p.classList.toggle("active", p.id === "pi-pane-" + tabName);
  });
  switch (tabName) {
    case "overview":        loadPricingOverview();        break;
    case "brand-models":    loadBrandModelAnalysis();     break;
    case "categories":      loadCategoryAnalysis();       break;
    case "brand-comparison":loadBrandComparison();        break;
    case "rep-behavior":    loadRepAnalysis();            break;
    case "ai-studio":       /* passthrough — no fetch */  break;
  }
}

// ── Build filter query string ────────────────────────────────
function _piFilterParams(extra = {}) {
  const f = pricingIntelState.filters;
  const p = new URLSearchParams();
  if (f.from_date)      p.set("from_date",       f.from_date);
  if (f.to_date)        p.set("to_date",         f.to_date);
  if (f.brand)          p.set("brand",           f.brand);
  if (f.product_line)   p.set("product_line",    f.product_line);
  if (f.rep_id)         p.set("rep_id",          f.rep_id);
  if (f.approved_only)  p.set("approved_only",   "1");
  if (f.discounted_only) p.set("discounted_only","1");
  Object.entries(extra).forEach(([k, v]) => p.set(k, v));
  return p.toString() ? "?" + p.toString() : "";
}

// ── Overview tab ─────────────────────────────────────────────
async function loadPricingOverview() {
  if (pricingIntelState.cache.overview) {
    renderPricingOverview(pricingIntelState.cache.overview); return;
  }
  const cards = el("pi-overview-cards");
  if (cards) cards.innerHTML = `<div class="loading-state" style="grid-column:1/-1"><div class="spinner"></div><span>Loading…</span></div>`;
  try {
    const data = await get("/pricing-intelligence/overview" + _piFilterParams());
    pricingIntelState.cache.overview = data;
    renderPricingOverview(data);
  } catch (e) {
    if (cards) cards.innerHTML = `<div class="empty-state" style="grid-column:1/-1">${esc(parseErrorMessage(e, "Failed to load overview."))}</div>`;
  }
}

function renderPricingOverview(d) {
  const cards = el("pi-overview-cards");
  if (!cards) return;
  const cardDefs = [
    { label: "Quotes Analyzed",  val: (d.quotes_analyzed || 0).toLocaleString(), accent: false },
    { label: "Openings Analyzed",val: (d.openings_analyzed || 0).toLocaleString(), accent: false },
    { label: "Avg Sell Price",   val: fmtMoney(d.avg_sell_price || 0), accent: false },
    { label: "Avg Cost",         val: fmtMoney(d.avg_cost || 0),       accent: false },
    { label: "Avg Margin",       val: fmtPct(d.avg_margin_pct || 0),   accent: true },
    { label: "Approval Rate",    val: fmtPct(d.approval_rate || 0),    accent: false },
    { label: "Avg Discount",     val: fmtPct(d.discount_rate || 0),    accent: false },
  ];
  if (cards) cards.innerHTML = cardDefs.map(c => `
    <div class="pi-stat-card ${c.accent ? "pi-stat-card-accent" : ""}">
      <div class="pi-stat-label">${c.label}</div>
      <div class="pi-stat-val">${c.val}</div>
    </div>`).join("");

  const charts = el("pi-overview-charts");
  if (!charts) return;

  // Show CTA if no data yet
  if (!d.openings_analyzed) {
    charts.innerHTML = `
      <div class="empty-state empty-state-cta" style="grid-column:1/-1;padding:40px 24px;">
        <div class="empty-icon">📊</div>
        <div class="empty-state-title">No pricing data yet</div>
        <div class="empty-state-sub">Complete quotes to unlock Pricing Intelligence analytics. The console analyzes sell price, margin, and discount patterns across your catalog.</div>
        <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap;margin-top:4px;">
          <button class="btn btn-primary btn-sm" onclick="switchMode('field');setTimeout(()=>navigateTo('field-new-quote'),100)">Create a Quote</button>
          <button class="btn btn-ghost btn-sm" onclick="switchAdminTab('reports')">View Reports</button>
        </div>
      </div>`;
    return;
  }

  charts.innerHTML = `
    <div class="pi-chart-box">
      <div class="pi-chart-title">Margin Distribution</div>
      ${renderBarChart(d.margin_distribution || [], "bucket", "count", "#14B8A6")}
    </div>
    <div class="pi-chart-box">
      <div class="pi-chart-title">Price Distribution</div>
      ${renderBarChart(d.price_distribution || [], "bucket", "count", "#6366f1")}
    </div>
    <div class="pi-chart-box pi-chart-wide">
      <div class="pi-chart-title">Margin Trend (Monthly)</div>
      ${renderLineChart(d.trend_over_time || [], "period", "avg_margin_pct", "#14B8A6", "%")}
    </div>`;
}

// ── Inline SVG chart helpers ─────────────────────────────────
function renderBarChart(data, labelKey, valueKey, color) {
  if (!data.length) return `<div class="empty-state small">No data</div>`;
  const W = 420, H = 140, PADL = 36, PADB = 28, PADR = 8, PADT = 8;
  const vals = data.map(d => d[valueKey] || 0);
  const maxV = Math.max(...vals, 1);
  const barW = (W - PADL - PADR) / data.length;
  const bars = data.map((d, i) => {
    const bh = Math.max(2, ((d[valueKey] || 0) / maxV) * (H - PADB - PADT));
    const x  = PADL + i * barW + barW * 0.1;
    const y  = H - PADB - bh;
    const w  = barW * 0.8;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${bh.toFixed(1)}" fill="${color}" opacity="0.82" rx="2">
      <title>${esc(d[labelKey])}: ${d[valueKey]}</title></rect>
      <text x="${(x + w/2).toFixed(1)}" y="${(H - 6).toFixed(1)}" text-anchor="middle" font-size="9" fill="var(--text-secondary)">${esc(String(d[labelKey]).replace(/(\d{4,})/g, n => n.length > 4 ? n.slice(0,2)+'k' : n))}</text>`;
  }).join("");
  const yLines = [0, 0.25, 0.5, 0.75, 1].map(f => {
    const y = (H - PADB - f * (H - PADB - PADT)).toFixed(1);
    const v = Math.round(maxV * f);
    return `<line x1="${PADL}" y1="${y}" x2="${W-PADR}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>
            <text x="${PADL-3}" y="${parseFloat(y)+3}" text-anchor="end" font-size="8" fill="var(--text-secondary)">${v}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="pi-svg-chart">${yLines}${bars}</svg>`;
}

function renderLineChart(data, xKey, yKey, color, suffix = "") {
  if (!data.length) return `<div class="empty-state small">No data</div>`;
  const W = 560, H = 140, PADL = 40, PADB = 28, PADR = 12, PADT = 8;
  const vals = data.map(d => parseFloat(d[yKey]) || 0);
  const minV = Math.min(...vals);
  const maxV = Math.max(...vals, minV + 1);
  const range = maxV - minV || 1;
  const pts = data.map((d, i) => {
    const x = PADL + (i / Math.max(data.length - 1, 1)) * (W - PADL - PADR);
    const y = H - PADB - ((parseFloat(d[yKey]) - minV) / range) * (H - PADB - PADT);
    return { x: x.toFixed(1), y: y.toFixed(1), label: d[xKey], val: d[yKey] };
  });
  const polyline = pts.map(p => `${p.x},${p.y}`).join(" ");
  const area = `M${pts[0].x},${H - PADB} ` + pts.map(p => `L${p.x},${p.y}`).join(" ") + ` L${pts[pts.length-1].x},${H - PADB} Z`;
  const dots = pts.map(p => `<circle cx="${p.x}" cy="${p.y}" r="3" fill="${color}"><title>${p.label}: ${p.val}${suffix}</title></circle>`).join("");
  const xLabels = pts.filter((_, i) => data.length <= 12 || i % Math.ceil(data.length / 8) === 0)
    .map(p => `<text x="${p.x}" y="${H - 6}" text-anchor="middle" font-size="8" fill="var(--text-secondary)">${esc(String(p.label).slice(-5))}</text>`).join("");
  const yLines = [0, 0.5, 1].map(f => {
    const y = (H - PADB - f * (H - PADB - PADT)).toFixed(1);
    const v = (minV + range * f).toFixed(1);
    return `<line x1="${PADL}" y1="${y}" x2="${W-PADR}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>
            <text x="${PADL-3}" y="${parseFloat(y)+3}" text-anchor="end" font-size="8" fill="var(--text-secondary)">${v}${suffix}</text>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="pi-svg-chart">
    ${yLines}
    <path d="${area}" fill="${color}" opacity="0.08"/>
    <polyline points="${polyline}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
    ${dots}${xLabels}
  </svg>`;
}

// ── Brand Models tab ─────────────────────────────────────────
async function loadBrandModelAnalysis() {
  if (pricingIntelState.cache.brandModels) {
    renderBrandModelTable(pricingIntelState.cache.brandModels); return;
  }
  const tbody = el("pi-brand-tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="10" class="loading-cell"><div class="spinner"></div></td></tr>`;
  try {
    const data = await get("/pricing-intelligence/by-brand-model" + _piFilterParams());
    pricingIntelState.cache.brandModels = data;
    renderBrandModelTable(data);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="10" style="padding:16px;color:var(--red)">${esc(parseErrorMessage(e))}</td></tr>`;
  }
}

function renderBrandModelTable(rows) {
  const tbody = el("pi-brand-tbody");
  if (!tbody) return;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-cell">No data in selected range.</td></tr>`; return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr class="pi-row-clickable" onclick="loadModelDetail('${esc(r.brand)}','${esc(r.model)}','${esc(r.product_line)}')">
      <td>${esc(r.brand)}</td>
      <td class="mono">${esc(r.model)}</td>
      <td>${esc(r.product_line)}</td>
      <td>${esc(r.opening_type)}</td>
      <td class="mono">${r.opening_count}</td>
      <td class="mono">${fmtMoney(r.avg_sell_price)}</td>
      <td class="mono">${fmtMoney(r.avg_cost)}</td>
      <td class="mono pi-margin-cell">${fmtPct(r.avg_margin_pct)}</td>
      <td class="mono">${fmtPct(r.avg_discount_pct)}</td>
      <td class="mono">${fmtPct(r.approval_rate)}</td>
    </tr>`).join("");
}

// ── Category tab ─────────────────────────────────────────────
async function loadCategoryAnalysis() {
  if (pricingIntelState.cache.categories) {
    renderCategoryTable(pricingIntelState.cache.categories); return;
  }
  const tbody = el("pi-cat-tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="loading-cell"><div class="spinner"></div></td></tr>`;
  try {
    const data = await get("/pricing-intelligence/by-category" + _piFilterParams());
    pricingIntelState.cache.categories = data;
    renderCategoryTable(data);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:16px;color:var(--red)">${esc(parseErrorMessage(e))}</td></tr>`;
  }
}

function renderCategoryTable(rows) {
  const tbody = el("pi-cat-tbody");
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">No data.</td></tr>`; return; }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.opening_type)}</td>
      <td class="mono">${r.opening_count}</td>
      <td class="mono">${fmtMoney(r.avg_sell_price)}</td>
      <td class="mono pi-margin-cell">${fmtPct(r.avg_margin_pct)}</td>
      <td class="mono">${fmtPct(r.avg_discount_pct)}</td>
      <td class="mono">${fmtPct(r.approval_rate)}</td>
    </tr>`).join("");
}

// ── Brand Comparison tab ─────────────────────────────────────
async function loadBrandComparison() {
  if (pricingIntelState.cache.brandComparison) {
    renderBrandComparisonTable(pricingIntelState.cache.brandComparison); return;
  }
  const tbody = el("pi-comp-tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="6" class="loading-cell"><div class="spinner"></div></td></tr>`;
  try {
    const data = await get("/pricing-intelligence/brand-comparison" + _piFilterParams());
    pricingIntelState.cache.brandComparison = data;
    renderBrandComparisonTable(data);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="6" style="padding:16px;color:var(--red)">${esc(parseErrorMessage(e))}</td></tr>`;
  }
}

function renderBrandComparisonTable(rows) {
  const tbody = el("pi-comp-tbody");
  if (!tbody) return;
  if (!rows.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty-cell">No data.</td></tr>`; return; }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td>${esc(r.opening_type)}</td>
      <td>${esc(r.brand)}</td>
      <td class="mono">${r.opening_count}</td>
      <td class="mono pi-margin-cell">${fmtPct(r.avg_margin_pct)}</td>
      <td class="mono">${fmtMoney(r.avg_sell_price)}</td>
      <td class="mono">${fmtPct(r.avg_discount_pct)}</td>
    </tr>`).join("");
}

// ── Rep Behavior tab ─────────────────────────────────────────
async function loadRepAnalysis() {
  if (pricingIntelState.cache.reps) {
    renderRepTable(pricingIntelState.cache.reps); return;
  }
  const tbody = el("pi-rep-tbody");
  if (tbody) tbody.innerHTML = `<tr><td colspan="8" class="loading-cell"><div class="spinner"></div></td></tr>`;
  try {
    const data = await get("/pricing-intelligence/by-rep" + _piFilterParams());
    pricingIntelState.cache.reps = data;
    renderRepTable(data);
  } catch (e) {
    if (tbody) tbody.innerHTML = `<tr><td colspan="8" style="padding:16px;color:var(--red)">${esc(parseErrorMessage(e))}</td></tr>`;
  }
}

function renderRepTable(rows) {
  const tbody = el("pi-rep-tbody");
  if (!tbody) return;
  const col = pricingIntelState.repSortCol;
  const dir = pricingIntelState.repSortDir;
  const sorted = [...rows].sort((a, b) => {
    const av = a[col] ?? 0, bv = b[col] ?? 0;
    return dir === "asc" ? av - bv : bv - av;
  });
  if (!sorted.length) { tbody.innerHTML = `<tr><td colspan="8" class="empty-cell">No rep data.</td></tr>`; return; }
  tbody.innerHTML = sorted.map(r => `
    <tr>
      <td>${esc(r.rep_name)}</td>
      <td class="mono">${r.quote_count}</td>
      <td class="mono">${r.opening_count}</td>
      <td class="mono pi-margin-cell">${fmtPct(r.avg_margin_pct)}</td>
      <td class="mono">${fmtPct(r.avg_discount_pct)}</td>
      <td class="mono">${r.approval_requests}</td>
      <td class="mono ${r.below_floor_rate > 20 ? 'pi-alert-cell' : ''}">${fmtPct(r.below_floor_rate)}</td>
      <td class="mono">${fmtPct(r.close_rate)}</td>
    </tr>`).join("");
  // Sortable header arrows
  qsa("#pi-rep-table th.sortable").forEach(th => {
    const c = th.dataset.col;
    th.textContent = th.textContent.replace(/ [▲▼]/, "");
    if (c === col) th.textContent += dir === "asc" ? " ▲" : " ▼";
    th.onclick = () => {
      if (pricingIntelState.repSortCol === c) {
        pricingIntelState.repSortDir = pricingIntelState.repSortDir === "asc" ? "desc" : "asc";
      } else {
        pricingIntelState.repSortCol = c;
        pricingIntelState.repSortDir = "desc";
      }
      renderRepTable(pricingIntelState.cache.reps);
    };
  });
}

// ── Model Detail ─────────────────────────────────────────────
async function loadModelDetail(brand, model, productLine) {
  pricingIntelState.selectedModel = { brand, model, productLine };
  const detail = el("pi-model-detail");
  if (!detail) return;
  detail.classList.remove("hidden");
  detail.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading model detail…</span></div>`;
  detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const params = new URLSearchParams({ brand, model, product_line: productLine });
    const f = pricingIntelState.filters;
    if (f.from_date) params.set("from_date", f.from_date);
    if (f.to_date)   params.set("to_date",   f.to_date);
    const data = await get("/pricing-intelligence/model-detail?" + params.toString());
    renderModelDetail(data);
  } catch (e) {
    detail.innerHTML = `<div class="empty-state small">${esc(parseErrorMessage(e, "Failed to load model detail."))}</div>`;
  }
}

function renderModelDetail(d) {
  const detail = el("pi-model-detail");
  if (!detail) return;
  const canManage = hasPerm("can_manage_pricing_intelligence") ||
                    (STATE.currentUser?.role || "").toLowerCase() === "owner" ||
                    (STATE.currentUser?.role || "").toLowerCase() === "sysop";
  const aiStudioEnabled = pricingIntelState.featureFlagEnabled;

  const aiButtons = (canManage && aiStudioEnabled) ? `
    <div style="margin-top:16px;display:flex;gap:8px;flex-wrap:wrap;">
      <button class="btn btn-primary btn-sm" onclick="generateAIProfileFromModelDetail()">✦ Generate AI Pricing Profile</button>
      <button class="btn btn-ghost btn-sm" onclick="openAIPricingStudio()">Open AI Pricing Studio →</button>
    </div>` : "";

  detail.innerHTML = `
    <div class="pi-detail-header">
      <div>
        <div class="pi-detail-title">${esc(d.brand)} · ${esc(d.model)}</div>
        <div class="pi-detail-sub">${esc(d.product_line)}</div>
      </div>
      <button class="btn btn-ghost btn-sm" onclick="el('pi-model-detail').classList.add('hidden')">✕ Close</button>
    </div>
    <div class="pi-detail-charts">
      <div class="pi-chart-box">
        <div class="pi-chart-title">Price Distribution</div>
        ${renderBarChart(d.price_distribution || [], "bucket", "count", "#6366f1")}
      </div>
      <div class="pi-chart-box">
        <div class="pi-chart-title">Margin Distribution</div>
        ${renderBarChart(d.margin_distribution || [], "bucket", "count", "#14B8A6")}
      </div>
      <div class="pi-chart-box">
        <div class="pi-chart-title">Margin Trend</div>
        ${renderLineChart(d.trend_over_time || [], "period", "avg_margin_pct", "#14B8A6", "%")}
      </div>
      <div class="pi-chart-box">
        <div class="pi-chart-title">Size vs Sell Price</div>
        ${renderScatterChart(d.size_vs_price || [])}
      </div>
    </div>
    ${aiButtons}`;
}

function renderScatterChart(data) {
  if (!data.length) return `<div class="empty-state small">No scatter data</div>`;
  const W = 420, H = 160, PADL = 40, PADB = 28, PADR = 8, PADT = 8;
  const areas = data.map(d => (d.width || 0) * (d.height || 0));
  const prices = data.map(d => d.sell_price || 0);
  const maxA = Math.max(...areas, 1);
  const maxP = Math.max(...prices, 1);
  const dots = data.map(d => {
    const a = (d.width || 0) * (d.height || 0);
    const x = (PADL + (a / maxA) * (W - PADL - PADR)).toFixed(1);
    const y = (H - PADB - ((d.sell_price || 0) / maxP) * (H - PADB - PADT)).toFixed(1);
    return `<circle cx="${x}" cy="${y}" r="3" fill="#F59E0B" opacity="0.7"><title>${d.width}"×${d.height}" — ${fmtMoney(d.sell_price)} (${fmtPct(d.margin_pct)} margin)</title></circle>`;
  }).join("");
  return `<svg viewBox="0 0 ${W} ${H}" class="pi-svg-chart">
    <line x1="${PADL}" y1="${H-PADB}" x2="${W-PADR}" y2="${H-PADB}" stroke="var(--border)" stroke-width="0.7"/>
    <line x1="${PADL}" y1="${PADT}" x2="${PADL}" y2="${H-PADB}" stroke="var(--border)" stroke-width="0.7"/>
    <text x="${W/2}" y="${H}" text-anchor="middle" font-size="8" fill="var(--text-secondary)">Area (sq in)</text>
    <text x="10" y="${H/2}" text-anchor="middle" font-size="8" fill="var(--text-secondary)" transform="rotate(-90,10,${H/2})">Price</text>
    ${dots}
  </svg>`;
}

async function generateAIProfileFromModelDetail() {
  const m = pricingIntelState.selectedModel;
  if (!m) return;
  const f = pricingIntelState.filters;
  toast("Creating AI pricing profile from model history…", "info");
  try {
    const result = await post("/ai-pricing/profiles/from-history", {
      name: `${m.brand} ${m.model} — Auto`,
      filters: {
        from_date:       f.from_date,
        to_date:         f.to_date,
        include_statuses: ["approved","completed"],
        min_sample_size:  1,
      },
    });
    toast(`✓ Profile "${result.profile?.name}" created.`, "success");
    // Reset AI Studio state so it picks up the new profile
    _aiStudio.activeProfileId = null;
    _aiStudio.featureFlagEnabled = null; // will re-fetch on next open
    openAIPricingStudio();
  } catch (e) {
    toast(parseErrorMessage(e, "Could not create AI profile."), "error");
  }
}

// ── Formatting helpers (may already exist — guard) ───────────
if (typeof fmtMoney !== "function") {
  function fmtMoney(v) {
    if (v == null || isNaN(v)) return "—";
    return "$" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
}
if (typeof fmtPct !== "function") {
  function fmtPct(v) {
    if (v == null || isNaN(v)) return "—";
    return Number(v).toFixed(1) + "%";
  }
}

// ── Marketing: Demo Modal ────────────────────────────────────
let _demoSource = "landing_hero";

function openDemoModal(source) {
  _demoSource = source || "landing_hero";
  if (el("demo-source")) el("demo-source").value = _demoSource;
  el("demo-modal-wrap")?.classList.remove("hidden");
  setTimeout(() => el("demo-name")?.focus(), 50);
}
function closeDemoModal() {
  el("demo-modal-wrap")?.classList.add("hidden");
}

async function submitDemoRequest() {
  const name  = (el("demo-name")?.value  || "").trim();
  const email = (el("demo-email")?.value || "").trim();
  if (!name)  { toast("Name is required.", "warning"); return; }
  if (!email || !email.includes("@")) { toast("Valid email is required.", "warning"); return; }

  const body = el("demo-modal-body");
  const submitBtn = body?.querySelector("button[onclick='submitDemoRequest()']");
  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = "Sending…"; }

  try {
    await apiFetch("/api/marketing/demo-request", {
      method: "POST",
      body: JSON.stringify({
        name, email,
        company:      (el("demo-company")?.value || "").trim() || undefined,
        phone:        (el("demo-phone")?.value   || "").trim() || undefined,
        company_size: el("demo-size")?.value || undefined,
        source:       _demoSource,
      }),
    });
    if (body) body.innerHTML = `
      <div style="text-align:center;padding:32px 16px;">
        <div style="font-size:36px;margin-bottom:12px;">🎉</div>
        <div style="font-size:16px;font-weight:700;margin-bottom:8px;">You're on the list!</div>
        <div style="font-size:13px;color:var(--text-secondary);">We'll be in touch shortly to schedule your demo.</div>
        <button class="btn btn-ghost btn-sm" style="margin-top:20px;" onclick="closeDemoModal()">Close</button>
      </div>`;
  } catch (e) {
    toast(parseErrorMessage(e, "Failed to submit — please try again."), "error");
    if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = "Submit Request"; }
  }
}

// ── Marketing: Video Modal ───────────────────────────────────
function openVideoModal() {
  el("video-modal-wrap")?.classList.remove("hidden");
}
function closeVideoModal() {
  el("video-modal-wrap")?.classList.add("hidden");
}


/* ============================================================
   ALPHA 9.4 CONSOLIDATION — MARGIN TREND + REP PERFORMANCE REPORTS
   ============================================================ */

// ── Destroy helper for trend chart (mirrors destroyReportsMarginChart pattern)
let _trendChartInstance = null;
function destroyTrendChart() {
  if (_trendChartInstance) { try { _trendChartInstance.destroy(); } catch (_) {} _trendChartInstance = null; }
}

// ── Margin Trend ─────────────────────────────────────────────
async function loadMarginTrendReport() {
  const wrap = el("report-trend-summary");
  const canvasEl = el("reports-trend-chart");
  const emptyEl  = el("reports-trend-chart-empty");
  if (!wrap) return;
  wrap.innerHTML = reportLoadingMarkup("Loading margin trend…");
  destroyTrendChart();

  const params = new URLSearchParams();
  const from = el("report-trend-from")?.value || "";
  const to   = el("report-trend-to")?.value   || "";
  const rep  = el("report-trend-rep")?.value  || "";
  if (from) params.set("from_date", from);
  if (to)   params.set("to_date",   to);
  if (rep)  params.set("rep_id",    rep);

  try {
    const rows = await get(`/reports/margin-trend${params.toString() ? "?" + params : ""}`);
    if (!rows.length) {
      wrap.innerHTML = `<div class="empty-state empty-state-cta">
        <div class="empty-icon">📈</div>
        <div class="empty-state-title">No margin trend data yet</div>
        <div class="empty-state-sub">Complete quotes to start tracking margin trends over time.</div>
        <button class="btn btn-primary btn-sm" onclick="switchMode('field');setTimeout(()=>navigateTo('field-new-quote'),100)">Create a Quote</button>
      </div>`;
      if (canvasEl) canvasEl.classList.add("hidden");
      if (emptyEl)  { emptyEl.classList.remove("hidden"); emptyEl.textContent = "No trend data for this filter."; }
      return;
    }

    const totalRevenue = rows.reduce((s, r) => s + (r.revenue || 0), 0);
    const avgMargin    = rows.reduce((s, r) => s + (r.avg_margin || 0), 0) / rows.length;
    const totalQuotes  = rows.reduce((s, r) => s + (r.quote_count || 0), 0);
    renderReportStatCards("report-trend-summary", [
      { label: "Months Tracked",  value: rows.length.toString(),       sub: "In selected range" },
      { label: "Avg Margin",      value: `${fmt(avgMargin)}%`,          tone: "green", sub: "Across all months" },
      { label: "Total Revenue",   value: fmtMoney(totalRevenue),        sub: "Completed jobs" },
      { label: "Total Quotes",    value: fmt(totalQuotes, 0),           sub: "Quotes created" },
    ]);

    if (canvasEl) {
      canvasEl.classList.remove("hidden");
      if (emptyEl) emptyEl.classList.add("hidden");
      const tick  = getComputedStyle(document.documentElement).getPropertyValue("--text-secondary").trim() || "#8892a4";
      const grid  = getComputedStyle(document.documentElement).getPropertyValue("--border").trim() || "#2a3040";
      const teal  = "#14B8A6";

      _trendChartInstance = new Chart(canvasEl, {
        type: "line",
        data: {
          labels: rows.map(r => r.month),
          datasets: [
            {
              label: "Avg Margin %",
              data: rows.map(r => r.avg_margin),
              borderColor: teal,
              backgroundColor: teal + "22",
              pointRadius: 4,
              pointHoverRadius: 6,
              tension: 0.3,
              fill: true,
              yAxisID: "yMargin",
            },
            {
              label: "Quotes",
              data: rows.map(r => r.quote_count),
              borderColor: "#6366f1",
              backgroundColor: "transparent",
              pointRadius: 3,
              tension: 0.3,
              borderDash: [4, 3],
              yAxisID: "yQuotes",
            },
          ],
        },
        options: {
          responsive: true,
          interaction: { mode: "index", intersect: false },
          plugins: { legend: { labels: { color: tick, font: { size: 11 } } } },
          scales: {
            x:       { ticks: { color: tick, font: { size: 10 } }, grid: { color: grid } },
            yMargin: { position: "left",  ticks: { color: tick, callback: v => v + "%" }, grid: { color: grid } },
            yQuotes: { position: "right", ticks: { color: tick }, grid: { display: false } },
          },
        },
      });
    }
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">Failed to load margin trend.</div>`;
    toast(parseErrorMessage(err, "Failed to load margin trend."), "error");
  }
}

// ── Rep Performance Leaderboard ──────────────────────────────
async function loadRepPerformanceReport() {
  const wrap = el("report-rep-summary");
  if (!wrap) return;
  wrap.innerHTML = reportLoadingMarkup("Loading rep performance…");

  const params = new URLSearchParams();
  const from = el("report-rep-from")?.value || "";
  const to   = el("report-rep-to")?.value   || "";
  if (from) params.set("from_date", from);
  if (to)   params.set("to_date",   to);

  try {
    const rows = await get(`/reports/rep-performance${params.toString() ? "?" + params : ""}`);
    if (!rows.length) {
      wrap.innerHTML = `<div class="empty-state empty-state-cta">
        <div class="empty-icon">🏆</div>
        <div class="empty-state-title">No rep activity yet</div>
        <div class="empty-state-sub">Rep performance data populates once quotes are created by team members.</div>
        <button class="btn btn-ghost btn-sm" onclick="switchAdminTab('users')">Manage Users →</button>
      </div>`;
      return;
    }

    // Summary stat cards
    const topRep   = rows.reduce((best, r) => (r.completed_jobs > (best?.completed_jobs || 0) ? r : best), rows[0]);
    const avgClose = rows.reduce((s, r) => s + (r.close_rate || 0), 0) / rows.length;
    const totalCompleted = rows.reduce((s, r) => s + (r.completed_jobs || 0), 0);
    renderReportStatCards("report-rep-summary", [
      { label: "Reps Active",     value: rows.length.toString(),             sub: "In selected range" },
      { label: "Jobs Completed",  value: fmt(totalCompleted, 0),             tone: "green", sub: "Across all reps" },
      { label: "Avg Close Rate",  value: `${fmt(avgClose)}%`,                sub: "Approved + completed" },
      { label: "Top Performer",   value: esc(topRep?.rep_name || "—"),       sub: `${fmt(topRep?.completed_jobs || 0, 0)} completed jobs` },
    ]);

    // Leaderboard table
    const tableHtml = `
      <div class="report-breakdown-list" style="margin-top:12px;">
        <div class="report-breakdown-header" style="display:grid;grid-template-columns:1fr repeat(4,90px);gap:8px;padding:6px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:var(--text-secondary);">
          <span>Rep</span><span>Quotes</span><span>Completed</span><span>Avg Margin</span><span>Close Rate</span>
        </div>
        ${rows.map((r, i) => `
          <div class="report-breakdown-row" style="display:grid;grid-template-columns:1fr repeat(4,90px);gap:8px;padding:8px 12px;border-top:1px solid var(--border-subtle,#1e2536);align-items:center;">
            <div style="display:flex;align-items:center;gap:8px;">
              <span style="width:20px;height:20px;border-radius:50%;background:${i===0?'#F59E0B':i===1?'rgba(255,255,255,.15)':'rgba(255,255,255,.08)'};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:${i===0?'#0f1420':'var(--text-secondary)'};">${i+1}</span>
              <span style="font-size:13px;font-weight:600;">${esc(r.rep_name)}</span>
            </div>
            <span class="mono" style="font-size:12px;">${fmt(r.quotes, 0)}</span>
            <span class="mono" style="font-size:12px;color:#10b981;font-weight:600;">${fmt(r.completed_jobs, 0)}</span>
            <span class="mono" style="font-size:12px;">${fmt(r.avg_margin)}%</span>
            <span class="mono" style="font-size:12px;">${fmt(r.close_rate)}%</span>
          </div>`).join("")}
      </div>`;

    // Append table after stat cards
    const statCards = wrap.querySelector(".stats-grid");
    if (statCards) {
      statCards.insertAdjacentHTML("afterend", tableHtml);
    } else {
      wrap.innerHTML += tableHtml;
    }
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">Failed to load rep performance.</div>`;
    toast(parseErrorMessage(err, "Failed to load rep performance."), "error");
  }
}


/* ════════════════════════════════════════════════════════════
   WINDOWCALC LANDING PAGE JS — Alpha 9.4c
   ════════════════════════════════════════════════════════════ */

// ── Feature Tab Switcher ─────────────────────────────────
function wcSetBilling(mode, btn) {
  // Toggle annual/monthly billing display on pricing cards
  document.querySelectorAll('.wc-bill-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');

  document.querySelectorAll('[data-monthly]').forEach(el => {
    el.textContent = mode === 'annual' ? el.dataset.annual : el.dataset.monthly;
  });
}

function wcSwitchTab(btn, paneId) {
  const strip = btn.closest('.wc-tab-strip');
  const section = btn.closest('.wc-container') || btn.closest('section');
  strip?.querySelectorAll('.wc-tab-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  section?.querySelectorAll('.wc-tab-pane').forEach(p => p.classList.remove('active'));
  const pane = document.getElementById(paneId);
  if (!pane) return;

  // Show skeleton on mock screen for 3 seconds before revealing real content
  const mock = pane.querySelector('.wc-mock');
  if (mock) {
    const real = mock.innerHTML;
    mock.innerHTML = `
      <div class="wc-mock-bar">
        <div class="wc-mock-dot" style="background:#EF4444"></div>
        <div class="wc-mock-dot" style="background:#F59E0B"></div>
        <div class="wc-mock-dot" style="background:#10B981"></div>
        <span class="wc-mock-title">Loading preview…</span>
      </div>
      <div class="wc-mock-skeleton-inner">
        <div class="wc-shimmer-block" style="height:64px;margin-bottom:4px;"></div>
        <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-bottom:4px;">
          <div class="wc-shimmer-block" style="height:48px;"></div>
          <div class="wc-shimmer-block" style="height:48px;animation-delay:.1s"></div>
          <div class="wc-shimmer-block" style="height:48px;animation-delay:.2s"></div>
          <div class="wc-shimmer-block" style="height:48px;animation-delay:.3s"></div>
        </div>
        <div class="wc-shimmer-line wide" style="animation-delay:.1s"></div>
        <div class="wc-shimmer-line mid"  style="animation-delay:.2s"></div>
        <div class="wc-shimmer-line wide" style="animation-delay:.3s"></div>
        <div class="wc-shimmer-line short"style="animation-delay:.1s"></div>
        <div class="wc-shimmer-line wide" style="animation-delay:.25s"></div>
        <div class="wc-shimmer-line mid"  style="animation-delay:.15s"></div>
      </div>`;
    pane.classList.add('active');
    setTimeout(() => {
      mock.innerHTML = real;
    }, 3000);
  } else {
    pane.classList.add('active');
  }
}

// ── ROI Calculator ───────────────────────────────────────
function wcCalcROI() {
  const reps   = +(document.getElementById('wc-r-reps')?.value   || 5);
  const quotes = +(document.getElementById('wc-r-quotes')?.value || 8);
  const val    = +(document.getElementById('wc-r-val')?.value    || 8500);
  const pct    = +(document.getElementById('wc-r-pct')?.value    || 20) / 100;
  const depth  = +(document.getElementById('wc-r-depth')?.value  || 5)  / 100;

  const sv = document.getElementById('wc-r-reps-v');
  const qv = document.getElementById('wc-r-quotes-v');
  const vv = document.getElementById('wc-r-val-v');
  const pv = document.getElementById('wc-r-pct-v');
  const dv = document.getElementById('wc-r-depth-v');
  if (sv) sv.textContent = reps + ' rep' + (reps !== 1 ? 's' : '');
  if (qv) qv.textContent = quotes + ' quotes';
  if (vv) vv.textContent = '$' + val.toLocaleString();
  if (pv) pv.textContent = Math.round(pct * 100) + '% of quotes';
  if (dv) dv.textContent = Math.round(depth * 100) + ' pts below floor';

  const annualQuotes   = reps * quotes * 12;
  const atRiskRevenue  = annualQuotes * pct * val;
  const marginLoss     = atRiskRevenue * depth;
  const wcValue        = marginLoss * 0.7;
  const planCostMo     = 349;
  const paybackMonths  = (planCostMo * 12) / (wcValue || 1);

  const fmt = n => '$' + Math.round(n).toLocaleString();
  const setEl = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

  setEl('wc-r-rev',  fmt(atRiskRevenue));
  setEl('wc-r-loss', fmt(marginLoss));
  setEl('wc-r-wc',   fmt(wcValue));

  if (paybackMonths < 1)       setEl('wc-r-pb', '< 1 month');
  else if (paybackMonths < 12) setEl('wc-r-pb', Math.ceil(paybackMonths) + ' months');
  else                         setEl('wc-r-pb', (paybackMonths / 12).toFixed(1) + ' years');
}

// ── Lead Form Submit ─────────────────────────────────────
async function wcSubmitLead(e) {
  e.preventDefault();
  const btn = document.getElementById('wc-lead-submit');
  if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }

  const firstName = (document.getElementById('wc-f-first')?.value || '').trim();
  const lastName  = (document.getElementById('wc-f-last')?.value  || '').trim();
  const email     = (document.getElementById('wc-f-email')?.value || '').trim();
  const company   = (document.getElementById('wc-f-company')?.value || '').trim();
  const phone     = (document.getElementById('wc-f-phone')?.value || '').trim();
  const size      = document.getElementById('wc-f-size')?.value   || '';
  const volume    = document.getElementById('wc-f-volume')?.value || '';
  const challenge = document.getElementById('wc-f-challenge')?.value || '';
  const source    = document.getElementById('wc-f-source')?.value  || 'landing_page';

  try {
    const res = await fetch('/api/marketing/demo-request', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name:         `${firstName} ${lastName}`.trim(),
        email,
        company:      company || undefined,
        phone:        phone   || undefined,
        company_size: size    || undefined,
        source:       source,
        challenge:    challenge || undefined,
        volume:       volume    || undefined,
      })
    });

    if (!res.ok) throw new Error('Server error ' + res.status);

    const form = document.getElementById('wc-lead-form');
    const ok   = document.getElementById('wc-lead-success');
    if (form) form.style.display = 'none';
    if (ok)   ok.style.display = 'block';
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Request My Demo →'; }
    alert('Something went wrong — please try again.\n\nError: ' + err.message);
  }
}

// ── Animated Stat Counters (landing hero) ────────────────
function wcInitCounters() {
  const els = document.querySelectorAll('[data-wc-count]');
  if (!els.length) return;
  const obs = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const el  = entry.target;
      const tgt = +(el.getAttribute('data-wc-count') || 0);
      const sfx = el.getAttribute('data-wc-suffix') || '';
      let cur = 0;
      const steps = 60;
      const step = tgt / steps;
      const timer = setInterval(() => {
        cur = Math.min(cur + step, tgt);
        el.textContent = Math.round(cur) + sfx;
        if (cur >= tgt) clearInterval(timer);
      }, 50);
      obs.unobserve(el);
    });
  }, { threshold: 0.5 });
  els.forEach(el => obs.observe(el));
}

// ── Nav shadow on scroll ─────────────────────────────────
function wcNavScroll() {
  const nav = document.querySelector('.wc-nav');
  if (!nav) return;
  const handler = () => {
    nav.style.background = window.scrollY > 50
      ? 'rgba(7,17,31,.97)'
      : 'rgba(7,17,31,.9)';
  };
  window.addEventListener('scroll', handler, { passive: true });
}

// ── Init on DOM ready ────────────────────────────────────
function wcLandingInit() {
  wcCalcROI();
  wcInitCounters();
  wcNavScroll();
  // Sync version from server — single source of truth
  fetch("/api/health").then(r => r.json()).then(d => {
    const v = d.app_version || "Alpha 9.4d";
    document.querySelectorAll("[data-version-label]").forEach(el => el.textContent = v);
    const badge = document.querySelector(".wc-hero-badge");
    if (badge) badge.innerHTML = badge.innerHTML.replace(/Alpha\s+[\d.a-z]+/i, v);
  }).catch(() => {});
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wcLandingInit);
} else {
  wcLandingInit();
}


/* ════════════════════════════════════════════════════════════
   LEAD TRACKER — Alpha 9.4c
   ════════════════════════════════════════════════════════════ */

// ── State ─────────────────────────────────────────────────
const _leads = {
  all:         [],      // current loaded set
  filtered:    [],      // after client-side filter
  activeStatus: "",     // current status tab filter
  activeLead:  null,    // open drawer lead object
  counts:      {},      // status counts from server
  searchTimer: null,
  searchTouched: false, // only preserve filters the user entered during this session
};

function _resetLeadsSearchIfUntouched() {
  const searchEl = el("leads-search");
  if (!searchEl || _leads.searchTouched || !searchEl.value) return false;
  searchEl.value = "";
  return true;
}

function _scheduleLeadsSearchReset() {
  [0, 150, 600].forEach(delay => {
    setTimeout(() => {
      if (_resetLeadsSearchIfUntouched()) _applyLeadsSearch();
    }, delay);
  });
}

const LEAD_STATUS_META = {
  new:        { label: "🆕 New",         color: "#14B8A6" },
  contacted:  { label: "👀 Contacted",   color: "#60a5fa" },
  in_progress:{ label: "⚡ In Progress", color: "#F59E0B" },
  quoted:     { label: "📊 Quoted",      color: "#a78bfa" },
  closed_won: { label: "🏆 Closed/Won",  color: "#10B981" },
  cold:       { label: "🧊 Cold",        color: "#64748b" },
  custom:     { label: "🏷️ Tagged",      color: "#f472b6" },
};

function _canViewLeads()   { return (STATE.currentUser?.role||"").toLowerCase() === "sysop" || hasPerm("can_view_leads"); }
function _canManageLeads() { return (STATE.currentUser?.role||"").toLowerCase() === "sysop" || hasPerm("can_manage_leads"); }
function _canExportLeads() { return (STATE.currentUser?.role||"").toLowerCase() === "sysop" || hasPerm("can_export_leads"); }

// ── Sidebar button sync ───────────────────────────────────
function _syncLeadsSidebarButton() {
  const btn = el("leads-tab-btn");
  if (!btn) return;
  btn.style.display = _canViewLeads() ? "" : "none";
}

// ── Badge ─────────────────────────────────────────────────
async function loadLeadsBadge() {
  if (!_canViewLeads()) return;
  try {
    const data  = await get("/leads/badge");
    const count = data?.count || 0;
    const badge = el("leads-badge");
    if (!badge) return;
    badge.textContent = count > 0 ? count : "";
    badge.style.display = count > 0 ? "inline-flex" : "none";
    // Pulse teal if fresh, amber if > 3
    badge.style.background = count > 3 ? "#F59E0B" : "#14B8A6";
  } catch {}
}

// ── Main loader ───────────────────────────────────────────
async function loadLeadsTab() {
  if (!_canViewLeads()) {
    const wrap = el("leads-table-wrap");
    if (wrap) wrap.innerHTML = `<div class="empty-state">You do not have access to the Lead Tracker.</div>`;
    return;
  }

  const wrap = el("leads-table-wrap");
  if (wrap) wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading leads…</span></div>`;

  _resetLeadsSearchIfUntouched();

  const sortEl    = el("leads-sort");
  const sortBy    = sortEl?.value || "created_at";
  const starOnly  = el("leads-starred-only")?.checked ? "1" : "";

  let url = `/leads?sort_by=${sortBy}&sort_dir=desc`;
  if (_leads.activeStatus) url += `&status=${encodeURIComponent(_leads.activeStatus)}`;
  if (starOnly)             url += `&priority=1`;

  try {
    const data     = await get(url);
    _leads.all     = data.leads || [];
    _leads.counts  = data.counts || {};
    _leads.filtered = [..._leads.all];

    _renderLeadCounts(data.counts);
    _resetLeadsSearchIfUntouched();
    _applyLeadsSearch();
    _scheduleLeadsSearchReset();
    el("leads-export-btn") && (_canExportLeads()
      ? el("leads-export-btn").removeAttribute("disabled")
      : el("leads-export-btn").setAttribute("disabled", true));
  } catch (err) {
    if (wrap) wrap.innerHTML = `<div class="empty-state">Failed to load leads.</div>`;
    handleProtectedLoadFailure(err, "leads");
  }
}

function _renderLeadCounts(counts) {
  const all = Object.values(counts).filter((v, i, a) => i < 7).reduce((s, v) => s + v, 0);
  const setC = (id, val) => { const n = el(id); if (n) n.textContent = val > 0 ? val : ""; };
  setC("lfc-all",         counts.total || 0);
  setC("lfc-new",         counts.new || 0);
  setC("lfc-contacted",   counts.contacted || 0);
  setC("lfc-in_progress", counts.in_progress || 0);
  setC("lfc-quoted",      counts.quoted || 0);
  setC("lfc-closed_won",  counts.closed_won || 0);
  setC("lfc-cold",        counts.cold || 0);
  setC("lfc-custom",      counts.custom || 0);
  // Update sidebar badge from counts
  const badge = el("leads-badge");
  const newCount = counts.new || 0;
  if (badge) {
    badge.textContent = newCount > 0 ? newCount : "";
    badge.style.display = newCount > 0 ? "inline-flex" : "none";
    badge.style.background = newCount > 3 ? "#F59E0B" : "#14B8A6";
  }
}

function _applyLeadsSearch() {
  const q = (el("leads-search")?.value || "").toLowerCase().trim();
  _leads.filtered = q
    ? _leads.all.filter(l =>
        (l.name||"").toLowerCase().includes(q) ||
        (l.email||"").toLowerCase().includes(q) ||
        (l.company||"").toLowerCase().includes(q))
    : [..._leads.all];
  _renderLeadsTable(_leads.filtered);
}

function leadsSearch() {
  const searchEl = el("leads-search");
  _leads.searchTouched = !!searchEl?.value.trim();
  clearTimeout(_leads.searchTimer);
  _leads.searchTimer = setTimeout(_applyLeadsSearch, 220);
}

function leadsFilterStatus(btn, status) {
  _leads.activeStatus = status;
  el("leads-filter-strip")?.querySelectorAll(".leads-filter-btn")
    .forEach(b => b.classList.toggle("active", b === btn));
  loadLeadsTab();
}

// ── Table renderer ────────────────────────────────────────
function _renderLeadsTable(leads) {
  const wrap = el("leads-table-wrap");
  if (!wrap) return;

  if (!leads.length) {
    wrap.innerHTML = `
      <div class="empty-state empty-state-cta">
        <div class="empty-icon">🎯</div>
        <div class="empty-state-title">${_leads.activeStatus ? "No leads with this status" : "No leads yet"}</div>
        <div class="empty-state-sub">${_leads.activeStatus ? "Try a different filter or clear the status tab." : "Demo request form submissions will appear here."}</div>
      </div>`;
    return;
  }

  const canManage = _canManageLeads();

  wrap.innerHTML = `
    <table class="leads-table">
      <thead>
        <tr>
          <th style="width:28px;"></th>
          <th>Name / Company</th>
          <th>Contact</th>
          <th>Team</th>
          <th>Source</th>
          <th>Status</th>
          <th>Score</th>
          <th>Tag</th>
          <th>Follow-Up</th>
          <th>Submitted</th>
        </tr>
      </thead>
      <tbody>
        ${leads.map(l => {
          const meta    = LEAD_STATUS_META[l.status] || LEAD_STATUS_META.new;
          const stars   = "●".repeat(Math.min(l.score || 0, 5));
          const scoreColor = (l.score||0) >= 4 ? "#14B8A6" : (l.score||0) >= 3 ? "#F59E0B" : "#4a6080";
          const fup     = l.follow_up_date ? l.follow_up_date : "";
          const fupOver = fup && fup < new Date().toISOString().slice(0,10);
          const submitted = (l.created_at || "").slice(0,10);
          const lastAct = l.last_activity_at ? timeSince(l.last_activity_at) : "—";
          return `
          <tr class="leads-row" onclick="openLeadDrawer('${esc(l.id)}')">
            <td onclick="event.stopPropagation()">${canManage ? `<button class="leads-star-btn ${l.priority ? 'starred' : ''}" onclick="event.stopPropagation();quickToggleStar('${esc(l.id)}',this)" title="${l.priority ? 'Remove star' : 'Star this lead'}">${l.priority ? '★' : '☆'}</button>` : ''}</td>
            <td>
              <div class="leads-name">${esc(l.name)}</div>
              <div class="leads-company">${esc(l.company || "—")}</div>
            </td>
            <td>
              <div class="leads-email">${esc(l.email)}</div>
              <div class="leads-phone">${esc(l.phone || "")}</div>
            </td>
            <td><span class="leads-size">${esc(l.company_size || "—")}</span></td>
            <td><span class="leads-source">${esc(l.source || "—")}</span></td>
            <td>
              ${canManage ? `
              <select class="leads-status-pill" style="background:${meta.color}22;border-color:${meta.color}55;color:${meta.color};"
                onclick="event.stopPropagation()"
                onchange="event.stopPropagation();quickStatusChange('${esc(l.id)}',this.value,this)">
                ${Object.entries(LEAD_STATUS_META).map(([k,v]) => `<option value="${k}" ${k===l.status?'selected':''}>${v.label}</option>`).join("")}
              </select>` : `<span class="leads-status-pill" style="background:${meta.color}22;color:${meta.color};">${meta.label}</span>`}
            </td>
            <td><span class="leads-score" style="color:${scoreColor}" title="Lead score ${l.score||0}/5">${stars || "○"}</span></td>
            <td><span class="leads-tag">${esc(l.custom_tag || "")}</span></td>
            <td><span class="${fupOver ? 'leads-fup-overdue' : 'leads-fup'}">${fup || "—"}</span></td>
            <td>
              <div class="leads-date">${submitted}</div>
              <div class="leads-lastact">${lastAct}</div>
            </td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>
    <div class="leads-table-footer">${leads.length} lead${leads.length !== 1 ? "s" : ""} shown</div>
  `;
}

// ── Quick inline actions ──────────────────────────────────
async function quickStatusChange(leadId, newStatus, selectEl) {
  if (!_canManageLeads()) return;
  try {
    await put(`/leads/${leadId}`, { status: newStatus });
    const lead = _leads.all.find(l => l.id === leadId);
    if (lead) { lead.status = newStatus; lead.last_activity_at = new Date().toISOString(); }
    const meta = LEAD_STATUS_META[newStatus] || LEAD_STATUS_META.new;
    if (selectEl) {
      selectEl.style.background = meta.color + "22";
      selectEl.style.color      = meta.color;
      selectEl.style.borderColor= meta.color + "55";
    }
    _renderLeadCounts(await get("/leads/badge").then(() => {}).catch(() => {}));
    loadLeadsBadge();
    toast(`Status → ${meta.label}`, "success", 2000);
  } catch(e) {
    toast("Failed to update status.", "error");
  }
}

async function quickToggleStar(leadId, btn) {
  if (!_canManageLeads()) return;
  const lead    = _leads.all.find(l => l.id === leadId);
  if (!lead) return;
  const newPri  = lead.priority ? 0 : 1;
  try {
    await put(`/leads/${leadId}`, { priority: newPri });
    lead.priority = newPri;
    btn.textContent = newPri ? "★" : "☆";
    btn.classList.toggle("starred", !!newPri);
    toast(newPri ? "Lead starred ★" : "Star removed", "success", 1800);
  } catch(e) {
    toast("Failed to update.", "error");
  }
}

// ── Drawer ────────────────────────────────────────────────
async function openLeadDrawer(leadId) {
  const drawer = el("leads-drawer");
  if (!drawer) return;

  drawer.classList.remove("hidden");
  el("ld-info-grid") && (el("ld-info-grid").innerHTML = `<div class="loading-state" style="grid-column:1/-1"><div class="spinner"></div></div>`);

  try {
    const lead = await get(`/leads/${leadId}`);
    _leads.activeLead = lead;
    _populateDrawer(lead);
  } catch(e) {
    toast("Failed to load lead details.", "error");
    drawer.classList.add("hidden");
  }
}

function _populateDrawer(lead) {
  const meta = LEAD_STATUS_META[lead.status] || LEAD_STATUS_META.new;

  // Header
  if (el("ld-name"))    el("ld-name").textContent    = lead.name || "Unknown";
  if (el("ld-company")) el("ld-company").textContent = lead.company || lead.email;

  // Status select
  const statusSel = el("ld-status-select");
  if (statusSel) statusSel.value = lead.status || "new";

  // Star button
  const starBtn = el("ld-star-btn");
  if (starBtn) {
    starBtn.textContent = lead.priority ? "★ Starred" : "☆ Star";
    starBtn.classList.toggle("btn-primary", !!lead.priority);
  }

  // Follow-up date
  if (el("ld-followup")) el("ld-followup").value = lead.follow_up_date || "";

  // Custom tag row
  const tagRow = el("ld-tag-row");
  if (tagRow) tagRow.classList.toggle("hidden", lead.status !== "custom");
  if (el("ld-custom-tag")) el("ld-custom-tag").value = lead.custom_tag || "";

  // Info grid
  const grid = el("ld-info-grid");
  if (grid) {
    const fields = [
      ["Email",        lead.email],
      ["Phone",        lead.phone || "—"],
      ["Company",      lead.company || "—"],
      ["Team Size",    lead.company_size || "—"],
      ["Monthly Vol.", lead.notes ? (lead.notes.match(/Volume: ([^|]+)/) || [])[1] || "—" : "—"],
      ["Challenge",    lead.notes ? (lead.notes.match(/Challenge: ([^|]+)/) || [])[1] || "—" : "—"],
      ["Source",       lead.source || "—"],
      ["Submitted",    (lead.created_at || "").slice(0, 16).replace("T", " ")],
      ["Last Activity",(lead.last_activity_at || "—").slice(0, 16).replace("T", " ")],
    ];
    grid.innerHTML = fields.map(([k, v]) => `
      <div class="ld-field-key">${esc(k)}</div>
      <div class="ld-field-val">${esc(String(v || "—"))}</div>
    `).join("");
  }

  // Score row
  const scoreRow = el("ld-score-row");
  if (scoreRow) {
    const s = lead.score || 0;
    const color = s >= 4 ? "#14B8A6" : s >= 3 ? "#F59E0B" : "#64748b";
    scoreRow.innerHTML = `
      <div class="ld-score-label">Lead Score</div>
      <div class="ld-score-dots">
        ${[1,2,3,4,5].map(i =>
          `<span class="ld-score-dot ${i <= s ? 'active' : ''}" style="${i <= s ? 'background:' + color : ''}"></span>`
        ).join("")}
        <span class="ld-score-num" style="color:${color}">${s}/5</span>
      </div>
    `;
  }

  // Notes list
  _renderDrawerNotes(lead.notes_list || []);

  // Activity
  _renderDrawerActivity(lead.activity || []);
}

function _renderDrawerNotes(notes) {
  const wrap = el("ld-notes-list");
  if (!wrap) return;
  if (!notes.length) {
    wrap.innerHTML = `<div style="font-size:.8rem;color:#4a6080;padding:8px 0;">No notes yet.</div>`;
    return;
  }
  wrap.innerHTML = notes.map(n => `
    <div class="ld-note-item">
      <div class="ld-note-text">${esc(n.note_text)}</div>
      <div class="ld-note-meta">${(n.created_at || "").slice(0,16).replace("T"," ")}</div>
    </div>
  `).join("");
  wrap.scrollTop = wrap.scrollHeight;
}

function _renderDrawerActivity(events) {
  const wrap = el("ld-activity-list");
  if (!wrap) return;
  if (!events.length) {
    wrap.innerHTML = `<div style="font-size:.8rem;color:#4a6080;padding:8px 0;">No activity yet.</div>`;
    return;
  }
  const labels = {
    status_changed: "Status changed",
    priority_changed: "Star toggled",
    follow_up_set: "Follow-up date set",
    tag_changed: "Tag updated",
    note_added: "Note added",
  };
  wrap.innerHTML = events.map(a => `
    <div class="ld-activity-item">
      <span class="ld-activity-dot"></span>
      <div>
        <span class="ld-activity-type">${labels[a.event_type] || a.event_type}</span>
        ${a.old_value && a.new_value ? `<span class="ld-activity-change">${esc(a.old_value)} → ${esc(a.new_value)}</span>` : ""}
        <span class="ld-activity-time">${timeSince(a.created_at)}</span>
      </div>
    </div>
  `).join("");
}

async function leadQuickUpdate(field, value) {
  if (!_leads.activeLead || !_canManageLeads()) return;
  const leadId = _leads.activeLead.id;
  try {
    const updated = await put(`/leads/${leadId}`, { [field]: value });
    _leads.activeLead = { ..._leads.activeLead, ...updated };
    // Show/hide tag row
    if (field === "status") {
      el("ld-tag-row")?.classList.toggle("hidden", value !== "custom");
      const meta    = LEAD_STATUS_META[value] || LEAD_STATUS_META.new;
      toast(`Status → ${meta.label}`, "success", 2000);
    }
    // Refresh badge
    loadLeadsBadge();
    // Update row in table without full reload
    const row = _leads.all.find(l => l.id === leadId);
    if (row) Object.assign(row, updated);
    _applyLeadsSearch();
  } catch(e) {
    toast("Update failed.", "error");
  }
}

async function leadToggleStar() {
  if (!_leads.activeLead || !_canManageLeads()) return;
  const newPri = _leads.activeLead.priority ? 0 : 1;
  await leadQuickUpdate("priority", newPri);
  _leads.activeLead.priority = newPri;
  const btn = el("ld-star-btn");
  if (btn) {
    btn.textContent = newPri ? "★ Starred" : "☆ Star";
    btn.classList.toggle("btn-primary", !!newPri);
  }
}

async function leadSaveTag() {
  const tag = (el("ld-custom-tag")?.value || "").trim();
  await leadQuickUpdate("custom_tag", tag);
  toast("Tag saved.", "success", 1800);
}

async function leadAddNote() {
  if (!_leads.activeLead || !_canManageLeads()) return;
  const input = el("ld-note-input");
  const text  = (input?.value || "").trim();
  if (!text) { toast("Note can't be empty.", "warning"); return; }
  const btn   = document.querySelector(".ld-note-input-row .btn-primary");
  if (btn) { btn.disabled = true; btn.textContent = "Saving…"; }
  try {
    const note = await post(`/leads/${_leads.activeLead.id}/notes`, { note: text });
    if (input) input.value = "";
    const list = _leads.activeLead.notes_list || [];
    list.push(note);
    _leads.activeLead.notes_list = list;
    _renderDrawerNotes(list);
    // Prepend to activity
    const actList = _leads.activeLead.activity || [];
    actList.unshift({ event_type: "note_added", new_value: text.slice(0, 60), created_at: new Date().toISOString() });
    _leads.activeLead.activity = actList;
    _renderDrawerActivity(actList);
    toast("Note added.", "success", 1800);
  } catch(e) {
    toast("Failed to add note.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Add Note"; }
  }
}

function closeLeadDrawer() {
  el("leads-drawer")?.classList.add("hidden");
  _leads.activeLead = null;
  // Refresh table in case statuses changed
  _applyLeadsSearch();
  loadLeadsBadge();
}

// ── CSV Export ────────────────────────────────────────────
function exportLeadsCSV() {
  if (!_canExportLeads()) { toast("No permission to export leads.", "warning"); return; }
  let url = "/api/leads/export?v=" + Date.now();
  if (_leads.activeStatus) url += `&status=${encodeURIComponent(_leads.activeStatus)}`;
  window.open(url, "_blank");
}

// Leads badge fires from the post-login path via loadLeadsBadge() directly.


/* ════════════════════════════════════════════════════════════
   MASTER PRODUCT LIBRARY — Alpha 9.4d
   ════════════════════════════════════════════════════════════ */

const _ml = {
  products:    [],
  filtered:    [],
  searchTimer: null,
  shareProductId: null,
  shareAllTenants: [],
  shareSelected: new Set(),
};

const ML_TYPE_LABELS = {
  single_hung:        "Single Hung",
  horizontal_roller:  "Horizontal Roller",
  fixed:              "Fixed",
  casement:           "Casement",
  sliding_glass_door: "Sliding Glass Door",
  entry_door:         "Entry Door",
  french_door:        "French Door",
  bifold_door:        "Bi-Fold Door",
};

function _syncMasterLibrarySidebarButton() {
  const btn = el("master-library-tab-btn");
  if (!btn) return;
  const isSysop = (STATE.currentUser?.role || "").toLowerCase() === "sysop";
  btn.style.display = isSysop ? "" : "none";
  _syncBrowseLibraryButton();
}

// ── Main loader ───────────────────────────────────────────
async function loadMasterLibrary(view) {
  const isSysop = (STATE.currentUser?.role || "").toLowerCase() === "sysop";
  if (!isSysop) return;

  if (view === "requests") {
    el("ml-table-wrap").style.display = "none";
    el("ml-requests-wrap").style.display = "block";
    await _loadProductRequests();
    return;
  }

  el("ml-table-wrap").style.display = "block";
  el("ml-requests-wrap").style.display = "none";

  const wrap = el("ml-table-wrap");
  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading product library…</span></div>`;

  const mfr    = el("ml-filter-mfr")?.value    || "";
  const series = el("ml-filter-series")?.value || "";
  const otype  = el("ml-filter-type")?.value   || "";
  const active = el("ml-filter-active")?.value || "1";
  const q      = el("ml-search")?.value        || "";

  let url = `/master-products?active=${active}`;
  if (mfr)    url += `&manufacturer=${encodeURIComponent(mfr)}`;
  if (series) url += `&series=${encodeURIComponent(series)}`;
  if (otype)  url += `&opening_type=${encodeURIComponent(otype)}`;
  if (q)      url += `&q=${encodeURIComponent(q)}`;

  try {
    const data = await get(url);
    _ml.products = data.products || [];
    _ml.filtered = [..._ml.products];

    // Populate filter dropdowns
    const mfrSel = el("ml-filter-mfr");
    if (mfrSel && !mfrSel.getAttribute("data-populated")) {
      mfrSel.setAttribute("data-populated", "1");
      (data.manufacturers || []).forEach(m => {
        const o = document.createElement("option");
        o.value = m; o.textContent = m;
        mfrSel.appendChild(o);
      });
    }
    const serSel = el("ml-filter-series");
    if (serSel) {
      const prev = serSel.value;
      serSel.innerHTML = '<option value="">All Series</option>';
      const seriesForMfr = _ml.products
        .filter(p => !mfr || p.manufacturer === mfr)
        .map(p => p.series)
        .filter((v, i, a) => a.indexOf(v) === i)
        .sort();
      seriesForMfr.forEach(s => {
        const o = document.createElement("option");
        o.value = s; o.textContent = s;
        if (s === prev) o.selected = true;
        serSel.appendChild(o);
      });
    }

    _renderMasterLibraryTable(_ml.products);
    // Check pending requests badge
    _loadRequestsBadge();
  } catch (err) {
    wrap.innerHTML = `<div class="empty-state">Failed to load master products.</div>`;
    handleProtectedLoadFailure(err, "master-library");
  }
}

function mlSearchDebounced() {
  clearTimeout(_ml.searchTimer);
  _ml.searchTimer = setTimeout(() => loadMasterLibrary(), 300);
}

// ── Table renderer ────────────────────────────────────────
function _renderMasterLibraryTable(products) {
  const wrap = el("ml-table-wrap");
  if (!wrap) return;

  if (!products.length) {
    wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><div class="empty-state-title">No products found</div><div class="empty-state-sub">Adjust filters or add new products.</div></div>`;
    return;
  }

  // Group by manufacturer → series
  const grouped = {};
  products.forEach(p => {
    const key = p.manufacturer;
    if (!grouped[key]) grouped[key] = {};
    if (!grouped[key][p.series]) grouped[key][p.series] = [];
    grouped[key][p.series].push(p);
  });

  const now = new Date().toISOString().slice(0, 10);
  const sixMo = new Date(Date.now() + 182 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  let html = `<div class="ml-library-wrap">`;

  Object.entries(grouped).forEach(([mfr, seriesMap]) => {
    const totalCount = Object.values(seriesMap).reduce((s, a) => s + a.length, 0);
    html += `<div class="ml-mfr-group">
      <div class="ml-mfr-header">
        <span class="ml-mfr-name">${esc(mfr)}</span>
        <span class="ml-mfr-count">${totalCount} products</span>
      </div>`;

    Object.entries(seriesMap).forEach(([series, prods]) => {
      html += `<div class="ml-series-group">
        <div class="ml-series-header">${esc(series)} <span class="ml-series-count">${prods.length}</span></div>
        <table class="ml-table">
          <thead><tr>
            <th>Model</th><th>Name</th><th>Type</th>
            <th>Max Size</th><th>DP +/-</th><th>NOA</th>
            <th>HVHZ</th><th>Shares</th><th style="text-align:right">Actions</th>
          </tr></thead>
          <tbody>`;

      prods.forEach(p => {
        const noaWarn = p.noa_expires && p.noa_expires < now   ? 'ml-noa-expired'  :
                        p.noa_expires && p.noa_expires < sixMo  ? 'ml-noa-warning'  : '';
        const noaTip  = p.noa_expires && p.noa_expires < now   ? '⛔ EXPIRED'       :
                        p.noa_expires && p.noa_expires < sixMo  ? '⚠️ EXPIRING SOON' : '';
        const dp      = p.dp_rating_pos != null ? `+${p.dp_rating_pos} / -${p.dp_rating_neg}` : '—';
        const maxSize = `${p.max_width_in}"W × ${p.max_height_in}"H`;
        const msrp    = p.base_msrp ? `<span class="ml-msrp-field" title="Admin only — never shown to tenants">🔒 $${Number(p.base_msrp).toFixed(0)}</span>` : '';
        html += `<tr class="ml-row ${p.active ? '' : 'ml-inactive'}">
          <td class="ml-model">${esc(p.model_number)}</td>
          <td><div class="ml-name">${esc(p.name)}</div>${msrp}</td>
          <td><span class="ml-type-badge">${esc(ML_TYPE_LABELS[p.opening_type] || p.opening_type)}</span></td>
          <td class="ml-size">${maxSize}</td>
          <td class="ml-dp">${dp}<br/><span class="ml-missile">${esc(p.missile_impact||'')}</span></td>
          <td class="${noaWarn}">
            ${p.noa_number ? `<span class="ml-noa">${esc(p.noa_number)}</span>` : '<span style="color:var(--text-muted)">—</span>'}
            ${noaTip ? `<br/><span class="ml-noa-tip">${noaTip}</span>` : ''}
            ${p.noa_expires ? `<br/><span class="ml-noa-exp">Exp ${p.noa_expires}</span>` : ''}
          </td>
          <td>${p.hvhz_compliant ? '<span class="ml-hvhz">✓ HVHZ</span>' : '<span style="color:var(--text-muted)">—</span>'}</td>
          <td><span class="ml-share-count" onclick="openMasterShareDrawer('${esc(p.id)}','${esc(p.name)}')">${p.share_count || 0} tenant${(p.share_count||0)!==1?'s':''}</span></td>
          <td style="text-align:right;white-space:nowrap;">
            <button class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:.75rem;" onclick="openMasterProductForm('${esc(p.id)}')">Edit</button>
            <button class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:.75rem;margin-left:4px;" onclick="openMasterShareDrawer('${esc(p.id)}','${esc(p.name)}')">Share</button>
            ${p.active ? `<button class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:.75rem;margin-left:4px;color:var(--text-muted);" onclick="deactivateMasterProduct('${esc(p.id)}')">Deactivate</button>` : `<button class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:.75rem;margin-left:4px;color:#10B981;" onclick="reactivateMasterProduct('${esc(p.id)}')">Activate</button>`}
          </td>
        </tr>`;
      });
      html += `</tbody></table></div>`;
    });
    html += `</div>`;
  });

  html += `<div class="ml-footer">${products.length} products total</div></div>`;
  wrap.innerHTML = html;
}

// ── Add / Edit Product Form ───────────────────────────────
async function openMasterProductForm(pid) {
  const drawer = el("ml-product-drawer");
  if (!drawer) return;

  el("ml-form-id").value = "";
  el("ml-form-title").textContent = "Add Master Product";
  // Reset form
  ["ml-f-mfr","ml-f-series","ml-f-model","ml-f-name","ml-f-fd",
   "ml-f-noa","ml-f-exp","ml-f-desc","ml-f-spec","ml-f-msrp"].forEach(id => {
    const e = el(id); if (e) e.value = "";
  });
  ["ml-f-minw","ml-f-maxw","ml-f-minh","ml-f-maxh",
   "ml-f-dpp","ml-f-dpn","ml-f-lt"].forEach(id => {
    const e = el(id); if (e) e.value = "";
  });
  el("ml-f-hvhz").checked  = true;
  el("ml-f-active").checked = true;
  el("ml-f-type").value    = "single_hung";
  el("ml-f-missile").value = "LMI";

  if (pid) {
    el("ml-form-title").textContent = "Edit Product";
    el("ml-form-id").value = pid;
    const p = _ml.products.find(x => x.id === pid);
    if (p) {
      el("ml-f-mfr").value     = p.manufacturer || "";
      el("ml-f-series").value  = p.series        || "";
      el("ml-f-model").value   = p.model_number  || "";
      el("ml-f-name").value    = p.name          || "";
      el("ml-f-type").value    = p.opening_type  || "single_hung";
      el("ml-f-missile").value = p.missile_impact|| "LMI";
      el("ml-f-minw").value    = p.min_width_in  || "";
      el("ml-f-maxw").value    = p.max_width_in  || "";
      el("ml-f-minh").value    = p.min_height_in || "";
      el("ml-f-maxh").value    = p.max_height_in || "";
      el("ml-f-dpp").value     = p.dp_rating_pos != null ? p.dp_rating_pos : "";
      el("ml-f-dpn").value     = p.dp_rating_neg != null ? p.dp_rating_neg : "";
      el("ml-f-fd").value      = p.frame_depth   || "";
      el("ml-f-lt").value      = p.lead_time_weeks || "";
      el("ml-f-noa").value     = p.noa_number    || "";
      el("ml-f-exp").value     = p.noa_expires   || "";
      el("ml-f-desc").value    = p.description   || "";
      el("ml-f-spec").value    = p.spec_sheet_url|| "";
      el("ml-f-msrp").value    = p.base_msrp != null ? p.base_msrp : "";
      el("ml-f-hvhz").checked  = !!p.hvhz_compliant;
      el("ml-f-active").checked = !!p.active;
    }
  }

  drawer.classList.remove("hidden");
}

function closeMasterProductForm() {
  el("ml-product-drawer")?.classList.add("hidden");
}

async function saveMasterProduct() {
  const pid  = el("ml-form-id").value.trim();
  const body = {
    manufacturer:    el("ml-f-mfr").value.trim(),
    series:          el("ml-f-series").value.trim(),
    model_number:    el("ml-f-model").value.trim(),
    name:            el("ml-f-name").value.trim(),
    opening_type:    el("ml-f-type").value,
    missile_impact:  el("ml-f-missile").value,
    min_width_in:    parseFloat(el("ml-f-minw").value) || 12,
    max_width_in:    parseFloat(el("ml-f-maxw").value) || null,
    min_height_in:   parseFloat(el("ml-f-minh").value) || 12,
    max_height_in:   parseFloat(el("ml-f-maxh").value) || null,
    dp_rating_pos:   el("ml-f-dpp").value !== "" ? parseFloat(el("ml-f-dpp").value) : null,
    dp_rating_neg:   el("ml-f-dpn").value !== "" ? parseFloat(el("ml-f-dpn").value) : null,
    frame_depth:     el("ml-f-fd").value.trim() || null,
    lead_time_weeks: parseInt(el("ml-f-lt").value) || 5,
    noa_number:      el("ml-f-noa").value.trim() || null,
    noa_expires:     el("ml-f-exp").value || null,
    hvhz_compliant:  el("ml-f-hvhz").checked,
    description:     el("ml-f-desc").value.trim() || null,
    spec_sheet_url:  el("ml-f-spec").value.trim() || null,
    base_msrp:       el("ml-f-msrp").value !== "" ? parseFloat(el("ml-f-msrp").value) : null,
    active:          el("ml-f-active").checked ? 1 : 0,
  };

  if (!body.manufacturer || !body.series || !body.model_number || !body.name || !body.max_width_in || !body.max_height_in) {
    toast("Please fill in all required fields.", "warning"); return;
  }

  try {
    if (pid) {
      await put(`/master-products/${pid}`, body);
      toast("Product updated.", "success");
    } else {
      await post("/master-products", body);
      toast("Product created.", "success");
    }
    closeMasterProductForm();
    await loadMasterLibrary();
  } catch(e) {
    toast("Save failed: " + (e.message || e), "error");
  }
}

async function deactivateMasterProduct(pid) {
  if (!confirm("Deactivate this product? It will no longer be sharable.")) return;
  try {
    await post(`/master-products/${pid}/deactivate`, {});
    toast("Product deactivated.", "success");
    loadMasterLibrary();
  } catch(e) { toast("Failed.", "error"); }
}

async function reactivateMasterProduct(pid) {
  try {
    await put(`/master-products/${pid}`, { active: 1 });
    toast("Product activated.", "success");
    loadMasterLibrary();
  } catch(e) { toast("Failed.", "error"); }
}

// ── Share Drawer ──────────────────────────────────────────
async function openMasterShareDrawer(pid, pname) {
  _ml.shareProductId  = pid;
  _ml.shareSelected   = new Set();
  const drawer = el("ml-share-drawer");
  const list   = el("ml-share-list");
  const title  = el("ml-share-title");
  if (!drawer || !list) return;

  title.textContent = `Share: ${pname}`;
  list.innerHTML = `<div class="loading-state"><div class="spinner"></div></div>`;
  drawer.classList.remove("hidden");
  el("ml-share-note").value = "";

  try {
    const data = await get(`/master-products/${pid}/shares`);
    _ml.shareAllTenants = data.all_tenants || [];
    const sharedIds     = new Set(data.shared_tenant_ids || []);
    sharedIds.forEach(id => _ml.shareSelected.add(id));

    if (!_ml.shareAllTenants.length) {
      list.innerHTML = `<div style="color:var(--text-muted);font-size:.875rem;padding:12px 0;">No tenants in system yet.</div>`;
      return;
    }

    list.innerHTML = _ml.shareAllTenants.map(t => {
      const isShared = sharedIds.has(t.id);
      return `<label class="ml-share-item ${isShared ? 'ml-share-active' : ''}" id="ml-st-${esc(t.id)}">
        <input type="checkbox" ${isShared ? 'checked' : ''}
               onchange="_mlToggleTenantShare('${esc(t.id)}',this.checked)"
               style="accent-color:#14B8A6;width:16px;height:16px;flex-shrink:0;cursor:pointer;"/>
        <span>${esc(t.name)}</span>
        ${isShared ? '<span class="ml-share-badge">Shared</span>' : ''}
      </label>`;
    }).join("");
  } catch(e) {
    list.innerHTML = `<div style="color:var(--text-muted)">Failed to load share data.</div>`;
  }
}

function _mlToggleTenantShare(tid, checked) {
  if (checked) {
    _ml.shareSelected.add(tid);
  } else {
    _ml.shareSelected.delete(tid);
    // Revoke on server immediately
    del(`/master-products/${_ml.shareProductId}/shares/${tid}`).catch(() => {});
  }
  const lbl = el("ml-st-" + tid);
  if (lbl) lbl.classList.toggle("ml-share-active", checked);
}

async function saveMasterShares() {
  if (!_ml.shareProductId || !_ml.shareSelected.size) {
    toast("No tenants selected.", "warning"); return;
  }
  const note = el("ml-share-note")?.value.trim() || null;
  try {
    await post(`/master-products/${_ml.shareProductId}/shares`, {
      tenant_ids: [..._ml.shareSelected],
      notes: note,
    });
    toast(`Shared with ${_ml.shareSelected.size} tenant(s).`, "success");
    closeMasterShareDrawer();
    loadMasterLibrary();
  } catch(e) {
    toast("Share failed.", "error");
  }
}

function closeMasterShareDrawer() {
  el("ml-share-drawer")?.classList.add("hidden");
  _ml.shareProductId = null;
}

// ── Product Requests (SysOp queue) ───────────────────────
async function _loadRequestsBadge() {
  try {
    const rows = await get("/product-requests?status=pending");
    const badge = el("ml-requests-badge");
    if (!badge) return;
    const count = (rows || []).length;
    badge.textContent = count > 0 ? count : "";
    badge.style.display = count > 0 ? "inline-flex" : "none";
  } catch {}
}

async function _loadProductRequests() {
  const wrap = el("ml-requests-wrap");
  if (!wrap) return;
  wrap.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading requests…</span></div>`;
  try {
    const rows = await get("/product-requests?status=all");
    if (!rows.length) {
      wrap.innerHTML = `<div class="empty-state"><div class="empty-icon">✅</div><div class="empty-state-title">No product requests</div></div>`;
      return;
    }
    wrap.innerHTML = `
      <div class="tab-header" style="margin-bottom:0;">
        <h2 class="tab-title" style="font-size:1.1rem;">Product Update Requests</h2>
        <button class="btn btn-ghost btn-sm" onclick="loadMasterLibrary()">← Back to Library</button>
      </div>
      <table class="leads-table" style="margin-top:16px;">
        <thead><tr>
          <th>Tenant</th><th>Type</th><th>Field</th>
          <th>Requested Value</th><th>Reason</th>
          <th>Status</th><th>Submitted</th><th>Actions</th>
        </tr></thead>
        <tbody>
        ${rows.map(r => `
          <tr>
            <td>${esc(r.tenant_name || r.tenant_id)}</td>
            <td>${esc(r.request_type)}</td>
            <td>${esc(r.field_name || '—')}</td>
            <td>${esc(r.requested_value || '—')}</td>
            <td style="max-width:200px;word-break:break-word;">${esc(r.reason || '—')}</td>
            <td><span class="wc-mbadge ${r.status==='pending'?'wc-ba':r.status==='approved'?'wc-bg':'wc-br'}">${esc(r.status)}</span></td>
            <td>${(r.created_at||"").slice(0,10)}</td>
            <td style="white-space:nowrap;">
              ${r.status === "pending" ? `
                <button class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:.75rem;color:#10B981;"
                  onclick="respondProductRequest('${esc(r.id)}','approved')">Approve</button>
                <button class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:.75rem;color:#EF4444;margin-left:4px;"
                  onclick="respondProductRequest('${esc(r.id)}','denied')">Deny</button>
              ` : `<span style="color:var(--text-muted);font-size:.75rem;">${esc(r.admin_response||'')}</span>`}
            </td>
          </tr>`).join("")}
        </tbody>
      </table>`;
  } catch(e) {
    wrap.innerHTML = `<div class="empty-state">Failed to load requests.</div>`;
  }
}

async function respondProductRequest(rid, status) {
  const response = status === "denied" ? (prompt("Reason for denial (optional):") || "") : "";
  try {
    await put(`/product-requests/${rid}`, { status, admin_response: response });
    toast(`Request ${status}.`, "success");
    _loadProductRequests();
    _loadRequestsBadge();
  } catch(e) { toast("Failed.", "error"); }
}

// ── Tenant: Browse Library ────────────────────────────────
let _libAllProducts = [];

async function openLibraryBrowser() {
  const modal = el("library-browser-modal");
  const list  = el("library-browser-list");
  if (!modal) return;
  modal.classList.remove("hidden");
  list.innerHTML = `<div class="loading-state"><div class="spinner"></div><span>Loading library…</span></div>`;

  try {
    const data = await get("/library");
    _libAllProducts = data.products || [];

    // Populate manufacturer filter
    const mfrSel = el("lib-filter-mfr");
    if (mfrSel && !mfrSel.getAttribute("data-populated")) {
      mfrSel.setAttribute("data-populated","1");
      const mfrs = [...new Set(_libAllProducts.map(p => p.manufacturer))].sort();
      mfrs.forEach(m => {
        const o = document.createElement("option");
        o.value = m; o.textContent = m;
        mfrSel.appendChild(o);
      });
    }

    filterLibrary();
  } catch(e) {
    list.innerHTML = `<div class="empty-state">Failed to load library. You may not have products shared yet.</div>`;
  }
}

function filterLibrary() {
  const mfr   = el("lib-filter-mfr")?.value  || "";
  const otype = el("lib-filter-type")?.value  || "";
  const q     = (el("lib-search")?.value || "").toLowerCase();

  const filtered = _libAllProducts.filter(p =>
    (!mfr   || p.manufacturer === mfr) &&
    (!otype || p.opening_type === otype) &&
    (!q     || p.name.toLowerCase().includes(q) || p.model_number.toLowerCase().includes(q))
  );
  _renderLibraryList(filtered);
}

function _renderLibraryList(products) {
  const list = el("library-browser-list");
  if (!products.length) {
    list.innerHTML = `<div class="empty-state" style="padding:32px;"><div class="empty-icon">📦</div><div class="empty-state-title">No products match filters</div></div>`;
    return;
  }

  // Group by manufacturer
  const grouped = {};
  products.forEach(p => {
    if (!grouped[p.manufacturer]) grouped[p.manufacturer] = [];
    grouped[p.manufacturer].push(p);
  });

  list.innerHTML = Object.entries(grouped).map(([mfr, prods]) => `
    <div style="margin-bottom:28px;">
      <div style="font-family:'Syne',sans-serif;font-size:.8rem;font-weight:700;color:#14B8A6;text-transform:uppercase;letter-spacing:.08em;margin-bottom:12px;">${esc(mfr)}</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${prods.map(p => `
          <div class="ml-lib-card ${p.already_imported ? 'ml-lib-imported' : ''}">
            <div style="flex:1;">
              <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
                <span style="font-weight:700;color:var(--text-primary);">${esc(p.model_number)}</span>
                <span style="font-size:.85rem;color:var(--text-secondary);">${esc(p.name)}</span>
                <span class="ml-type-badge">${esc(ML_TYPE_LABELS[p.opening_type]||p.opening_type)}</span>
                ${p.hvhz_compliant ? '<span class="ml-hvhz">HVHZ</span>' : ''}
              </div>
              <div style="font-size:.78rem;color:var(--text-muted);margin-top:4px;">
                ${p.dp_rating_pos!=null ? `DP +${p.dp_rating_pos}/-${p.dp_rating_neg} · ` : ''}
                Max ${p.max_width_in}"W × ${p.max_height_in}"H
                ${p.noa_number ? ` · NOA ${esc(p.noa_number)}` : ''}
                ${p.series ? ` · ${esc(p.series)}` : ''}
              </div>
            </div>
            <div style="flex-shrink:0;">
              ${p.already_imported
                ? `<span style="font-size:.8rem;color:#10B981;font-weight:600;">✓ In Your Catalog</span>`
                : `<button class="btn btn-primary btn-sm" onclick="importLibraryProduct('${esc(p.id)}',this)">Add to Catalog</button>`}
            </div>
          </div>`).join("")}
      </div>
    </div>`
  ).join("");
}

async function importLibraryProduct(mpid, btn) {
  btn.disabled = true;
  btn.textContent = "Adding…";
  try {
    const res = await post(`/library/${mpid}/import`, {});
    btn.textContent = "✓ Added!";
    btn.style.background = "#10B981";
    const card = btn.closest(".ml-lib-card");
    if (card) card.classList.add("ml-lib-imported");
    toast("Product added to your catalog.", "success");
    // Refresh products tab in background
    setTimeout(() => loadProducts && loadProducts(), 500);
  } catch(e) {
    btn.disabled = false;
    btn.textContent = "Add to Catalog";
    toast("Import failed: " + (e.message || ""), "error");
  }
}

function closeLibraryBrowser() {
  el("library-browser-modal")?.classList.add("hidden");
  // Show Browse Library button for non-sysop users
}

// ── Show browse library button for tenants ────────────────
function _syncBrowseLibraryButton() {
  const btn = el("browse-library-btn");
  if (!btn) return;
  const role = (STATE.currentUser?.role || "").toLowerCase();
  btn.style.display = ["owner","manager","sysop"].includes(role) ? "" : "none";
}

// _syncBrowseLibraryButton is called from _syncMasterLibrarySidebarButton above

// ═══════════════════════════════════════════════════════════════════════════
// TIER 6: SHAREABLE PROPOSAL LINK (6-A)
// ═══════════════════════════════════════════════════════════════════════════

async function getShareLink(quoteId) {
  try {
    const result = await post(`/quotes/${quoteId}/share-link`, {});
    if (!result || !result.share_url) {
      toast("Failed to create share link", "error");
      return;
    }
    const shareUrl = result.share_url;
    navigator.clipboard.writeText(shareUrl);
    toast("Link copied to clipboard!", "success");

    // Replace button with display and actions
    const section = el(`share-link-section-${quoteId}`);
    if (section) {
      section.innerHTML = `
        <div class="share-link-display" style="display:flex;gap:8px;margin-bottom:8px;">
          <input type="text" readonly value="${esc(shareUrl)}" style="flex:1;padding:8px 12px;border:1px solid var(--border);border-radius:6px;font-size:12px;font-family:monospace;" />
          <button class="btn btn-primary btn-sm" onclick="copyShareLink('${esc(shareUrl)}')">Copy</button>
          <button class="btn btn-ghost btn-sm" onclick="revokeShareLink('${quoteId}')">Revoke</button>
        </div>
        <div style="font-size:11px;color:var(--text-muted);">Expires ${result.expires_at ? result.expires_at.split('T')[0] : 'later'}</div>
      `;
    }
  } catch (e) {
    toast("Error creating share link: " + (e.message || "Unknown error"), "error");
  }
}

async function copyShareLink(url) {
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied!", "success");
  } catch (e) {
    toast("Failed to copy link", "error");
  }
}

async function revokeShareLink(quoteId) {
  if (!confirm("Revoke this share link?")) return;
  try {
    await del(`/quotes/${quoteId}/share-link`);
    toast("Share link revoked", "success");
    const section = el(`share-link-section-${quoteId}`);
    if (section) {
      section.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="getShareLink('${quoteId}')">🔗 Get Shareable Link</button>`;
    }
  } catch (e) {
    toast("Failed to revoke link", "error");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 6: CUSTOMER VIEW (6-B)
// ═══════════════════════════════════════════════════════════════════════════

async function showCustomerView(quoteId) {
  try {
    const quote = STATE.currentQuote || await get(`/quotes/${quoteId}`);
    const overlay = el("customer-view-overlay");
    if (!overlay) {
      toast("Customer view not available", "error");
      return;
    }

    const openings = quote.openings || [];
    const total = quote.total_price || 0;

    let openingsHtml = "";
    if (openings.length > 0) {
      openingsHtml = openings.map(op => `
        <div class="cv-opening-card">
          <div class="cv-opening-info">
            <div class="cv-opening-type">${esc(op.opening_type || "Opening")}</div>
            <div class="cv-opening-dims">${op.width}" × ${op.height}"</div>
            ${op.product_name ? `<div class="cv-opening-product">${esc(op.product_name)}</div>` : ""}
            ${op.floor_level ? `<div class="cv-opening-dims">Floor ${op.floor_level}</div>` : ""}
            ${op.noa_status ? `<span class="cv-opening-noa ${op.noa_status}">${op.noa_status === "passed" ? "✓" : "✗"} DP</span>` : ""}
          </div>
          <div class="cv-opening-price">${fmtMoney(op.sell_price)}</div>
        </div>
      `).join("");
    } else {
      openingsHtml = '<div style="text-align:center;padding:20px;color:var(--text-muted);">No openings</div>';
    }

    overlay.innerHTML = `
      <div class="cv-header">
        <div class="cv-logo">WindowCalc</div>
        <button class="cv-exit-btn" onclick="exitCustomerView()">✕ Exit</button>
      </div>
      <div class="cv-customer-block">
        <div class="cv-customer-name">${esc(quote.customer_name || "Customer")}</div>
        <div class="cv-address">${esc(quote.job_address || "No address provided")}</div>
      </div>
      <div class="cv-opening-list">
        ${openingsHtml}
      </div>
      <div class="cv-total-bar">
        <div class="cv-total-label">Proposal Total</div>
        <div class="cv-total-amount">${fmtMoney(total)}</div>
      </div>
      <div class="cv-disclaimer">
        Prices subject to final measurement and site conditions.
      </div>
    `;

    overlay.classList.remove("hidden");
    document.body.style.overflow = "hidden";
  } catch (e) {
    toast("Error showing customer view: " + (e.message || "Unknown error"), "error");
  }
}

function exitCustomerView() {
  const overlay = el("customer-view-overlay");
  if (overlay) {
    overlay.classList.add("hidden");
  }
  document.body.style.overflow = "";
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 6: PIPELINE KANBAN DASHBOARD (6-C)
// ═══════════════════════════════════════════════════════════════════════════

async function renderPipelineView(container) {
  container.innerHTML = '<div class="loading-state"><div class="spinner"></div></div>';
  try {
    const data = await get("/pipeline");
    const { columns, summary } = data;

    let html = `
      <div style="padding:20px;">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:16px;margin-bottom:24px;">
          <div style="background:var(--bg-elevated);padding:16px;border-radius:8px;border:1px solid var(--border);">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">Total Pipeline</div>
            <div style="font-size:24px;font-weight:700;margin-top:4px;">${fmtMoney(summary.total_pipeline)}</div>
          </div>
          <div style="background:var(--bg-elevated);padding:16px;border-radius:8px;border:1px solid var(--border);">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">Win Rate</div>
            <div style="font-size:24px;font-weight:700;margin-top:4px;">${summary.won_rate.toFixed(0)}%</div>
          </div>
          <div style="background:var(--bg-elevated);padding:16px;border-radius:8px;border:1px solid var(--border);">
            <div style="font-size:11px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.08em;font-weight:600;">Avg Deal Size</div>
            <div style="font-size:24px;font-weight:700;margin-top:4px;">${fmtMoney(summary.avg_deal_size)}</div>
          </div>
        </div>

        <div class="pipeline-board">
    `;

    const statuses = [
      { key: "draft", label: "Draft", color: "#94a3b8" },
      { key: "pending_approval", label: "Submitted", color: "#f59e0b" },
      { key: "approved", label: "Approved", color: "#3b82f6" },
      { key: "completed", label: "Completed", color: "#10b981" },
      { key: "denied", label: "Denied", color: "#ef4444" },
    ];

    for (const status of statuses) {
      const col = columns[status.key] || { quotes: [], count: 0, total_value: 0 };
      html += `
        <div class="pipeline-column">
          <div class="pipeline-col-header">
            <div class="pipeline-col-title">${status.label}</div>
            <div class="pipeline-col-meta">${col.count} · ${fmtMoney(col.total_value)}</div>
          </div>
          <div class="pipeline-cards">
      `;
      for (const quote of col.quotes) {
        html += `
          <div class="pipeline-card" onclick="openQuoteModal('${quote.id}')">
            <div class="pipeline-card-name">${esc(quote.customer_name)}</div>
            <div class="pipeline-card-price">${fmtMoney(quote.total_price)}</div>
            <div class="pipeline-card-meta">${quote.opening_count} opening${quote.opening_count !== 1 ? "s" : ""}</div>
          </div>
        `;
      }
      html += `
          </div>
        </div>
      `;
    }

    html += `
        </div>
      </div>
    `;

    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = `<div class="empty-state">Failed to load pipeline: ${esc(e.message || "Unknown error")}</div>`;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TIER 6: SMS ENHANCEMENT PREP (6-G) — Unread badges
// ═══════════════════════════════════════════════════════════════════════════

window._unreadCheckInterval = null;

async function updateUnreadBadge() {
  try {
    const result = await get("/chat-threads/unread-count");
    const badge = el("job-hub-unread-badge");
    if (badge) {
      if (result.unread_count > 0) {
        badge.textContent = result.unread_count;
        badge.classList.remove("hidden");
      } else {
        badge.classList.add("hidden");
      }
    }
  } catch (e) {
    // Silent fail for unread count
  }
}

function startUnreadPolling() {
  if (window._unreadCheckInterval) clearInterval(window._unreadCheckInterval);
  window._unreadCheckInterval = setInterval(updateUnreadBadge, 60000);
  updateUnreadBadge();
}
