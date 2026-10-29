"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  Boot sequence. Discovers single-model vs router mode, picks the
 *  active model in router mode, and then starts the dashboard pollers.
 * ──────────────────────────────────────────────────────────────────── */
async function boot() {
  /* Install the demo fetch shim before initHeader / any fetch fires.
   * ?demo=1 → single-mode synthetic; ?demo=router → router-mode. */
  if (state.params.demo) {
    installDemoShim(state.params.demo === "router" ? "router" : "single");
  }

  initHeader();
  ensureRootScaffold();
  setStatus("connecting", "header.status.connecting");

  if (state.params.server && state.serverBase === window.location.origin
      && state.params.server !== window.location.origin) {
    /* deriveServerBase fell back; show the user. */
    showBanner("bad-url", t("error.bad_url") + ": " + state.params.server, "warn");
  }

  try {
    await refreshSnapshot({ timeout: 8000 });
  } catch (e) {
    setStatus("error", "header.status.error");
    showBanner("snapshot", t("error.fetch_failed") + ": /api/snapshot — " + e.message);
    renderMetricsDisabled();
    renderSlotsDisabled();
  }

  state.ui.bootDone = true;
  state.bootedAt = Date.now();

  renderBootSummary();
  renderChatPanel();
  renderGuidance();
  startCorePollers();
  startSecondaryPollers();
  /* fire-and-forget log detection — never blocks the dashboard */
  startLogPoller().catch(() => {});
}

/* Stable mount points for feature modules. Each renderer owns one section. */
function ensureRootScaffold() {
  const root = $("#root");
  root.innerHTML = "";
  root.appendChild(el("div", { class: "diagnostics-heading full" }, [
    el("div", null, [el("h1", null, t("diagnostics.overview")), el("p", null, t("diagnostics.subtitle"))]),
    el("div", { class: "diagnostics-controls" }, [
      el("span", { id: "diagnostics-state", class: "telemetry-state" }),
      el("button", { id: "diagnostics-pause", onclick: () => setPaused(!state.paused) }, t("diagnostics.pause")),
    ]),
  ]));
  const navigation = $("#top-navigation");
  navigation.replaceChildren();
  navigation.setAttribute("aria-label", t("diagnostics.overview"));
  for (const [id, label] of [["metrics", "diagnostics.navigation_overview"], ["slots", "slots.title"], ["queries", "queries.title"],
    ["chat", "chat.title"], ["models", "diagnostics.system"], ["log", "log.title"]]) {
    navigation.appendChild(el("a", { href: "#" + id + "-section", onclick: event => {
      event.preventDefault();
      const section = $("#" + id + "-section");
      if (id === "log" && !section?.firstElementChild) { showLogHelp(); return; }
      const target = section?.firstElementChild || section;
      target?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    } }, t(label)));
  }
  root.appendChild(el("section", { id: "metrics-section", class: "full", "aria-label": t("diagnostics.overview") }));
  root.appendChild(el("div", { id: "cache-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "slots-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "queries-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "chat-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "models-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "config-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "lora-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "log-section", class: "full",
                               style: "display: contents;" }));
  root.appendChild(el("div", { id: "guidance-section", class: "full",
                               style: "display: contents;" }));
}

function renderDiagnosticStatus() {
  const indicator = $("#diagnostics-state"), pause = $("#diagnostics-pause");
  if (!indicator || !pause) return;
  indicator.textContent = t(state.paused ? "diagnostics.paused" : state.ui.snapshotStale ? "diagnostics.stale" : state.healthy ? "diagnostics.live" : "header.status.offline");
  indicator.classList.toggle("is-live", state.healthy && !state.paused && !state.ui.snapshotStale);
  $("#metrics-section")?.classList.toggle("is-stale", !!state.ui.snapshotStale);
  if (state.ui.snapshotStale) {
    for (const note of $$(".metric-note")) note.textContent = t("diagnostics.observed") + " " + fmtTime(state.lastUpdate);
  }
  pause.textContent = t(state.paused ? "diagnostics.resume" : "diagnostics.pause");
  pause.setAttribute("aria-pressed", String(state.paused));
}

/* Render Models, Server config, and LoRA cards. Re-callable; on each call
 * we rebuild the section content. Cheap because it's not on the hot path. */
function renderBootSummary() {
  renderModelsCard();
  renderServerConfigCard();
  renderLoraCard();
}

