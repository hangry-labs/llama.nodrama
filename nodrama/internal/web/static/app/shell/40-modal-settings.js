"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  Router: switching active model. Updates URL (?model=) so the view
 *  is shareable, restarts pollers so subsequent GETs use the new model,
 *  and re-renders the model section.
 * ──────────────────────────────────────────────────────────────────── */
function onModelSelect(id) {
  state.selectedModel = id || null;
  const u = new URL(window.location.href);
  if (id) u.searchParams.set("model", id);
  else u.searchParams.delete("model");
  window.history.replaceState({}, "", u.toString());
  resetHistories();
  startCorePollers();
  renderModelsCard();
}

/* ──────────────────────────────────────────────────────────────────────
 *  Modal / confirmation.
 *  We never call window.confirm so we can show formatted body and avoid
 *  the browser-native dialog blocking the event loop.
 * ──────────────────────────────────────────────────────────────────── */
function showModal({ title, bodyNode, okLabel, onOk, mutating, wide }) {
  const back = el("div", { class: "modal-backdrop", role: "dialog", "aria-modal": "true" });
  let onKey;
  const errorNode = el("div", { class: "error", hidden: true }, "");
  const close = () => {
    back.remove();
    if (onKey) document.removeEventListener("keydown", onKey);
  };
  const isAction = typeof onOk === "function";
  const ok = el("button", { class: isAction ? "primary" : "", onclick: async () => {
    if (!isAction) {
      close();
      return;
    }
    ok.disabled = true;
    errorNode.hidden = true;
    try {
      await onOk();
      close();
    } catch (e) {
      errorNode.textContent = e && e.message ? e.message : String(e);
      errorNode.hidden = false;
      ok.disabled = false;
    }
  }}, okLabel || (isAction ? t("common.confirm") : t("common.close")));
  const cancel = isAction ? el("button", { onclick: close }, t("common.cancel")) : null;
  /* mutating modals get a "this changes server state" warning; informational
   * modals (like the log help dialog) skip it. */
  const warnNode = mutating
    ? el("div", { class: "warn" }, "⚠ " + t(state.mode === "router"
        ? "modal.warn_router" : "modal.warn_server"))
    : null;
  const m = el("div", { class: wide ? "modal wide" : "modal" }, [
    el("h3", null, title),
    el("div", { class: "body" }, bodyNode),
    warnNode,
    errorNode,
    el("div", { class: "actions" }, [cancel, ok].filter(Boolean)),
  ].filter(Boolean));
  back.appendChild(m);
  back.addEventListener("click", (e) => { if (e.target === back) close(); });
  document.body.appendChild(back);
  /* Esc closes — listen on document so focus position doesn't matter */
  onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  ok.focus();
}

function confirmAction(message, onOk) {
  showModal({
    title: t("common.confirm"),
    bodyNode: el("div", null, message),
    mutating: true,
    onOk,
  });
}

async function openSettingsModal() {
  const body = el("div", { class: "settings-form" }, t("common.loading"));
  let loaded = null;
  const fields = {};

  const render = (settings) => {
    loaded = settings || {};
    body.innerHTML = "";
    fields.server = el("input", { type: "url", value: loaded.server || "", placeholder: "http://127.0.0.1:8080" });
    fields.logPath = el("input", { type: "text", value: loaded.logPath || "", placeholder: "/path/to/llama.cpp.log" });
    fields.poll = el("input", { type: "number", min: "200", max: "60000", step: "50", value: String(loaded.pollIntervalMs || 1000) });
    fields.timeout = el("input", { type: "number", min: "250", max: "120000", step: "250", value: String(loaded.timeoutMs || 5000) });
    body.append(
      el("label", null, [t("settings.server"), fields.server]),
      el("label", null, [t("settings.log_path"), fields.logPath]),
      el("label", null, [t("settings.poll"), fields.poll]),
      el("label", null, [t("settings.timeout"), fields.timeout]),
      el("div", { class: "readonly" }, [
        el("div", { class: "k" }, t("settings.listen")),
        el("div", null, (loaded.listen || "—") + " · " + t("settings.startup_only")),
        el("div", { class: "k" }, t("settings.raw_proxy")),
        el("div", null, (loaded.rawProxy ? t("common.enabled") : t("common.disabled")) + " · " + t("settings.startup_only")),
      ]),
      el("div", { class: "sub" }, t("settings.note"))
    );
  };

  showModal({
    title: t("settings.title"),
    bodyNode: body,
    okLabel: t("settings.save"),
    mutating: true,
    onOk: async () => {
      if (!loaded) throw new Error(t("common.loading"));
      const payload = {
        server: fields.server.value.trim(),
        logPath: fields.logPath.value.trim(),
        pollIntervalMs: clampInt(fields.poll.value, loaded.pollIntervalMs || 1000, 200, 60000),
        timeoutMs: clampInt(fields.timeout.value, loaded.timeoutMs || 5000, 250, 120000),
      };
      const saved = await fetchJSON("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        withModel: false,
        timeout: 8000,
      });
      state.params.poll = saved.pollIntervalMs || payload.pollIntervalMs;
      $("#server-display").textContent = saved.server || payload.server;
      $("#server-display").title = saved.server || payload.server;
      showBanner("settings-saved", t("settings.saved"), "warn");
      setTimeout(() => clearBanner("settings-saved"), 2500);
      await refreshSnapshot({ timeout: 8000 });
      startCorePollers();
    },
  });

  try {
    render(await fetchJSON("/api/settings", { withModel: false, timeout: 8000 }));
  } catch (e) {
    body.textContent = t("error.fetch_failed") + ": /api/settings — " + e.message;
  }
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const old = btn.textContent;
      btn.textContent = t("common.copied");
      setTimeout(() => { btn.textContent = old; }, 1200);
    }
  } catch (e) {
    showBanner("clipboard", e.message || "clipboard error", "warn");
  }
}

