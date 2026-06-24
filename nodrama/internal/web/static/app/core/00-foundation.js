"use strict";


/* Resolve a key for the active language, fallback to English. */
function t(key, vars) {
  const dict = I18N[state.lang] || {};
  let s = dict[key];
  if (s === undefined) s = I18N.en[key];
  if (s === undefined) s = key;
  if (vars) {
    s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
  }
  return s;
}

/* ──────────────────────────────────────────────────────────────────────
 *  URL parameter parser. All settings live here — no localStorage.
 * ──────────────────────────────────────────────────────────────────── */
function parseParams() {
  const u = new URL(window.location.href);
  const q = u.searchParams;
  return {
    server: (q.get("server") || "").trim(),
    model:  (q.get("model")  || "").trim(),
    poll:   clampInt(q.get("poll"), 1000, 200, 60_000),
    log:    q.has("log") ? q.get("log") : null,   /* null = auto-detect */
    lang:   (q.get("lang") || "").trim(),
    prompt: q.get("prompt") || "",                /* prefill chat input */
    demo:   demoMode(q.get("demo")),              /* "", "1", or "router" */
  };
}
function clampInt(s, fallback, min, max) {
  const n = parseInt(s, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function demoMode(v) {
  /* Only "1" (single) and "router" enable the mock; anything else stays
   * live so a typo like ?demo=true doesn't silently swap real metrics. */
  const s = (v || "").trim();
  return s === "1" || s === "router" ? s : "";
}

/* Pick a UI language from ?lang, then navigator.language, then 'en'. */
function pickLang(requested) {
  const supported = Object.keys(I18N);
  const normalize = (value) => {
    const lang = String(value || "").toLowerCase();
    if (!lang) return "";
    if (supported.includes(value)) return value;
    if (lang.startsWith("ko")) return "ko";
    if (lang.startsWith("ja")) return "ja";
    if (lang.startsWith("zh")) return "zh-CN";
    if (lang.startsWith("es")) return "es";
    if (lang.startsWith("en")) return "en";
    return "";
  };
  const requestedLang = normalize(requested);
  if (requestedLang) return requestedLang;
  const navLang = normalize(navigator.language || "en");
  if (navLang) return navLang;
  return "en";
}

/* ──────────────────────────────────────────────────────────────────────
 *  Global state. One object, no hidden globals.
 * ──────────────────────────────────────────────────────────────────── */
const params = parseParams();
function emptyHistory() {
  return { metrics: {}, slots: {} };
}

const state = {
  params,
  lang: pickLang(params.lang),
  serverBase: deriveServerBase(params.server),
  /* Populated by the first snapshot and refreshed by pollers. */
  mode: null,           /* "single" | "router" */
  selectedModel: params.model || null,
  props: null,
  v1models: [],
  models: [],
  loraAdapters: [],
  metrics: null,
  metricFacts: {},
  slots: [],
  queries: [],
  events: [],
  snapshot: null,
  history: emptyHistory(),
  suggestions: null,
  paused: false,
  /* `healthy` flips true only when /props came back at least once.
   * The status LED reads this — never `lastUpdate` alone — so a
   * pause/resume or visibility toggle can't lie about server state. */
  healthy: false,
  pollers: [],          /* {name, abort, timer} */
  lastUpdate: null,
  ui: {
    bootDone: false,
    logEnabled: false,
    supportSignature: "",
  },
};

function deriveServerBase(raw) {
  if (!raw) return window.location.origin;
  try {
    const url = new URL(raw, window.location.href);
    /* Whitelist http(s) only — javascript:, data:, file: etc. would either
     * fail in fetch or behave surprisingly. Better to surface early. */
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return window.location.origin;
    }
    return url.origin + (url.pathname.replace(/\/+$/, ""));
  } catch (_e) {
    /* report at boot time, fall back to current origin */
    return window.location.origin;
  }
}

/* ──────────────────────────────────────────────────────────────────────
 *  Tiny DOM helpers
 * ──────────────────────────────────────────────────────────────────── */
function $(sel, root) { return (root || document).querySelector(sel); }
function $$(sel, root) { return Array.from((root || document).querySelectorAll(sel)); }
function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) for (const k in attrs) {
    if (k === "class") node.className = attrs[k];
    else if (k === "style") node.style.cssText = attrs[k];
    else if (k.startsWith("on") && typeof attrs[k] === "function") {
      node.addEventListener(k.slice(2), attrs[k]);
    } else if (k === "data") {
      for (const dk in attrs.data) node.dataset[dk] = attrs.data[dk];
    } else if (attrs[k] !== undefined && attrs[k] !== null) {
      node.setAttribute(k, attrs[k]);
    }
  }
  if (children !== undefined) {
    if (Array.isArray(children)) {
      for (const c of children) {
        if (c == null) continue;
        node.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
      }
    } else if (typeof children === "string") {
      node.textContent = children;
    } else {
      node.appendChild(children);
    }
  }
  return node;
}

/* Render every element with data-i18n="key" using the current language. */
function applyI18n(root) {
  const scope = root || document;
  scope.querySelectorAll("[data-i18n]").forEach((n) => {
    n.textContent = t(n.dataset.i18n);
  });
}

/* ──────────────────────────────────────────────────────────────────────
 *  Header wiring
 * ──────────────────────────────────────────────────────────────────── */
function initHeader() {
  $("#server-display").textContent = state.serverBase;
  $("#server-display").title = state.serverBase;
  setBuildDisplay(null, null);
  const settingsButton = $("#settings-button");
  if (settingsButton) {
    settingsButton.title = t("header.settings");
    settingsButton.setAttribute("aria-label", t("header.settings"));
    settingsButton.addEventListener("click", openSettingsModal);
  }
  const sel = $("#lang-select");
  sel.value = state.lang;
  sel.addEventListener("change", () => {
    const u = new URL(window.location.href);
    u.searchParams.set("lang", sel.value);
    window.location.href = u.toString();
  });
  document.documentElement.lang = state.lang;
  applyI18n();
}

/* Status LED: 'connecting' | 'online' | 'warn' | 'offline' | 'error' */
function setStatus(state_, textKey) {
  const led = $("#status-led");
  const txt = $("#status-text");
  led.classList.remove("on", "warn", "bad");
  txt.classList.remove("online", "warn", "offline", "error");
  if (state_ === "online")  led.classList.add("on");
  if (state_ === "warn")    led.classList.add("warn");
  if (state_ === "offline") led.classList.add("bad");
  if (state_ === "error")   led.classList.add("bad");
  if (state_ === "online" || state_ === "warn" || state_ === "offline" || state_ === "error") {
    txt.classList.add(state_);
  }
  txt.dataset.i18n = textKey;
  txt.textContent = t(textKey);
}

/* Push / clear an error banner. id de-duplicates. */
function showBanner(id, message, severity) {
  const wrap = $("#banners");
  let n = wrap.querySelector('[data-id="' + cssEscape(id) + '"]');
  if (!n) {
    n = el("div", { class: "banner" + (severity === "warn" ? " warn" : ""), data: { id } });
    wrap.appendChild(n);
  } else {
    n.className = "banner" + (severity === "warn" ? " warn" : "");
  }
  n.textContent = message;
}
function clearBanner(id) {
  const wrap = $("#banners");
  const n = wrap.querySelector('[data-id="' + cssEscape(id) + '"]');
  if (n) n.remove();
}
function cssEscape(s) { return String(s).replace(/[^\w-]/g, "_"); }
