"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  Log tail (Phase 6). The browser reads a bounded JSON tail from
 *  /api/logs/tail. The backend only enables it when launched with --log.
 * ──────────────────────────────────────────────────────────────────── */
const LOG_TAIL_BYTES = 65536;
const LOG_MAX_LINES = 2000;
const logState = {
  url: null,
  enabled: false,
  totalSize: 0,
  lastModified: null,
  lines: [],
  follow: true,
  hideIdle: true,
  filter: "",
  cacheSignature: "",
};

async function detectLog() {
  try {
    const payload = await fetchJSON("/api/logs/tail?bytes=1&lines=1", {
      withModel: false,
      timeout: 4000,
    });
    logState.enabled = !!(payload && payload.enabled);
    logState.totalSize = payload && payload.size ? payload.size : 0;
    return logState.enabled;
  } catch (_e) { return false; }
}

async function fetchLogTail() {
  if (!logState.enabled) return null;
  const payload = await fetchJSON("/api/logs/tail?bytes=" + LOG_TAIL_BYTES + "&lines=" + LOG_MAX_LINES, {
    withModel: false,
    timeout: 8000,
  });
  if (!payload || !payload.enabled) return null;
  const marker = String(payload.updatedAt || "") + ":" + String(payload.size || 0);
  if (marker === logState.lastModified) return null;
  logState.lastModified = marker;
  logState.totalSize = payload.size || 0;
  return payload;
}

/* Minimal ANSI SGR renderer — color/bold codes only, anything else
 * is dropped. Returns a fragment of <span>s. */
function ansiToFragment(line) {
  const frag = document.createDocumentFragment();
  const parts = line.split(/\x1b\[([\d;]*)m/);
  /* parts: [text, code, text, code, text, ...] */
  let activeClasses = [];
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      if (!parts[i]) continue;
      if (activeClasses.length === 0) {
        frag.appendChild(document.createTextNode(parts[i]));
      } else {
        const span = document.createElement("span");
        span.className = activeClasses.join(" ");
        span.textContent = parts[i];
        frag.appendChild(span);
      }
    } else {
      const code = parts[i];
      if (code === "" || code === "0") {
        activeClasses = [];
        continue;
      }
      const codes = code.split(";").map((s) => parseInt(s, 10));
      for (const c of codes) {
        if (c === 0) activeClasses = [];
        else if (c === 1) activeClasses.push("ansi-bold");
        else if ((c >= 30 && c <= 37) || (c >= 90 && c <= 97)) {
          activeClasses = activeClasses.filter((cl) => !cl.match(/^ansi-\d/));
          activeClasses.push("ansi-" + c);
        }
      }
    }
  }
  return frag;
}

function renderLogLines(replace) {
  const view = $("#log-view");
  if (!view) return;
  if (replace) view.innerHTML = "";
  const start = replace ? 0 : view.childNodes.length;
  for (let i = start; i < logState.lines.length; i++) {
    const line = logState.lines[i];
    const ln = el("span", { class: "ln" });
    ln.appendChild(ansiToFragment(line));
    if (!shouldShowLogLine(line)) {
      ln.classList.add("hidden");
    }
    view.appendChild(ln);
  }
  if (logState.follow) view.scrollTop = view.scrollHeight;
}

function shouldShowLogLine(line) {
  const text = String(line || "");
  const lower = text.toLowerCase();
  const filter = logState.filter.toLowerCase();
  if (logState.hideIdle && isIdleLogLine(text, lower)) return false;
  return !filter || lower.indexOf(filter) !== -1;
}

function isIdleLogLine(line, lower) {
  if (lower.includes("update_slots: all slots are idle")) return true;
  if (lower.includes("llama.cpp slot snapshot")) return true;
  const trimmed = line.trim();
  if (/^slot=\d+\s+state=unknown\b.*\bn_past=-\//i.test(trimmed)) return true;
  if (/^busy_slots=\d+\/\d+$/i.test(trimmed)) return true;
  return false;
}

function refreshLogVisibility() {
  const view = $("#log-view");
  if (!view) return;
  for (let i = 0; i < logState.lines.length && i < view.childNodes.length; i++) {
    view.childNodes[i].classList.toggle("hidden", !shouldShowLogLine(logState.lines[i]));
  }
}

function selectionInsideLogView() {
  const view = $("#log-view");
  const sel = window.getSelection && window.getSelection();
  if (!view || !sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  for (let i = 0; i < sel.rangeCount; i++) {
    const range = sel.getRangeAt(i);
    if (view.contains(range.startContainer) || view.contains(range.endContainer)) return true;
  }
  return false;
}

function logTailOverlap(oldLines, newLines) {
  const max = Math.min(oldLines.length, newLines.length);
  for (let n = max; n > 0; n--) {
    let ok = true;
    for (let i = 0; i < n; i++) {
      if (oldLines[oldLines.length - n + i] !== newLines[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return n;
  }
  return 0;
}

function applyLogPayload(payload) {
  if (payload == null) return;
  let lines;
  let truncated = false;
  if (typeof payload === "string") {
    lines = payload.split(/\r?\n/);
  } else {
    lines = Array.isArray(payload.lines) ? payload.lines.slice() : [];
    truncated = !!payload.truncated;
  }
  /* Only byte-truncated tails need the first partial line removed. */
  if (truncated && lines.length > 1) lines.shift();
  /* trailing empty line from "...\n" */
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  lines = lines.slice(-LOG_MAX_LINES);

  const oldLines = logState.lines;
  const overlap = logTailOverlap(oldLines, lines);
  if (oldLines.length && overlap > 0) {
    const added = lines.slice(overlap);
    const merged = oldLines.concat(added);
    const view = $("#log-view");
    const removed = Math.max(0, merged.length - LOG_MAX_LINES);
    const selected = selectionInsideLogView();
    logState.lines = selected ? merged : merged.slice(-LOG_MAX_LINES);
    if (view && removed > 0 && !selected) {
      for (let i = 0; i < removed && view.firstChild; i++) view.removeChild(view.firstChild);
    }
    renderLogLines(false);
    refreshConfigForCacheState();
    return;
  }

  if (selectionInsideLogView()) {
    logState.lines = lines;
    refreshConfigForCacheState();
    return;
  }
  logState.lines = lines;
  renderLogLines(true);
  refreshConfigForCacheState();
}

function refreshConfigForCacheState() {
  const cacheState = latestPromptCacheState();
  const signature = cacheState
    ? [cacheState.cachePrompts, cacheState.cacheUsedMiB, cacheState.cacheLimitMiB, cacheState.cacheLimitTokens, cacheState.cacheEstTokens].join(":")
    : "";
  if (signature === logState.cacheSignature) return;
  logState.cacheSignature = signature;
  renderServerConfigCard();
}

function ensureLogSection() {
  const sec = $("#log-section");
  if (sec.dataset.built === "1") return;
  sec.dataset.built = "1";
  sec.innerHTML = "";
  if (!logState.enabled) return;
  const card = el("div", { class: "card full log-card" }, [
    el("h2", null, [
      t("log.title") + " ",
      el("button", { class: "info-btn", title: t("log.setup_help_title"),
                     onclick: () => showLogHelp() }, "ⓘ"),
    ]),
    el("div", { class: "log-toolbar" }, [
      el("label", null, [
        el("input", { type: "checkbox", id: "log-follow", checked: "checked",
                      onchange: () => { logState.follow = $("#log-follow").checked; }}),
        " " + t("log.follow"),
      ]),
      el("label", null, [
        el("input", { type: "checkbox", id: "log-hide-idle",
                      checked: logState.hideIdle ? "checked" : null,
                      onchange: () => { logState.hideIdle = $("#log-hide-idle").checked; refreshLogVisibility(); }}),
        " " + t("log.hide_idle"),
      ]),
      el("input", { type: "search", placeholder: t("log.search"),
                    oninput: (e) => { logState.filter = e.target.value; refreshLogVisibility(); }}),
      el("span", { class: "sub", id: "log-status" }, ""),
    ]),
    el("div", { class: "log-view", id: "log-view",
                onscroll: (e) => {
                  /* user scrolled away from bottom → stop autoscrolling */
                  const v = e.target;
                  const atBottom = (v.scrollTop + v.clientHeight + 4) >= v.scrollHeight;
                  if (!atBottom && logState.follow) {
                    logState.follow = false;
                    const cb = $("#log-follow"); if (cb) cb.checked = false;
                  }
                }}, t("log.empty")),
  ]);
  sec.appendChild(card);
}

function showLogHelp() {
  showModal({
    title: t("log.setup_help_title"),
    bodyNode: el("div", null, t("log.setup_help")),
    okLabel: t("common.close"),
  });
}

async function startLogPoller() {
  const ok = await detectLog();
  if (!ok) {
    logState.enabled = false;
    return;
  }
  ensureLogSection();
  /* immediate first fetch */
  try {
    const txt = await fetchLogTail();
    if (txt != null) applyLogPayload(txt);
  } catch (e) {
    showBanner("log-init", "log: " + e.message, "warn");
  }
  startPoller("log", 5000, async () => {
    const txt = await fetchLogTail();
    if (txt != null) applyLogPayload(txt);
  });
}

/* Secondary read-side polling is now owned by the backend snapshot. */
function startSecondaryPollers() {
}

