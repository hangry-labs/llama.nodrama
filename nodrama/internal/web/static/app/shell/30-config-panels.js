"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  Server config card. Router shows the actual CLI args; single mode
 *  shows what /props exposes plus a clear note that args are not
 *  available from the server.
 * ──────────────────────────────────────────────────────────────────── */
function renderServerConfigCard() {
  const sec = $("#config-section");
  sec.innerHTML = "";
  const card = el("div", { class: "card full" }, [
    el("h2", null, t("config.title")),
  ]);
  sec.appendChild(card);

  if (state.mode === "router") {
    card.appendChild(el("div", { class: "sub" }, t("config.router_args")));
    if (!state.models.length) {
      card.appendChild(el("div", { class: "sub" }, t("models.no_models")));
      return;
    }
    const list = el("div", { class: "model-list" });
    for (const m of state.models) {
      const rawArgs = (m.status && Array.isArray(m.status.args)) ? m.status.args : [];
      const args = rawArgs.length ? rawArgs.join(" ") : "";
      const parsedOptions = parseLaunchArgs(rawArgs);
      const block = el("div", { class: "model-card" }, [
        el("div", { class: "name" }, m.id),
        parsedOptions.length ? configOptionGrid(parsedOptions) : null,
        args ? el("div", { class: "args-block" }, args)
             : el("div", { class: "sub" }, t("common.empty")),
        args ? el("div", { class: "row-actions" }, [
          el("button", {
            onclick: (e) => copyToClipboard(args, e.currentTarget),
          }, t("common.copy")),
        ]) : null,
      ].filter(Boolean));
      list.appendChild(block);
    }
    card.appendChild(list);
  } else {
    /* If /props never came back, don't fake an "effective config" with
     * default-derived booleans (e.g. is_sleeping=No is meaningless when
     * we never reached the server). */
    if (!state.props) {
      card.appendChild(el("div", { class: "sub" }, t("config.no_data")));
      return;
    }
    card.appendChild(el("div", { class: "sub" }, t("config.effective_subset")));
    const props = state.props;
    const meta = (state.v1models[0] && state.v1models[0].meta) || {};
    card.appendChild(configOptionGrid(effectiveConfigOptions(props, meta)));
    card.appendChild(el("div", { class: "sub warn",
      style: "color: var(--warn);"
    }, t("config.effective_note")));
  }
}

function renderLoraCard() {
  const sec = $("#lora-section");
  sec.innerHTML = "";
  const adapters = Array.isArray(state.loraAdapters) ? state.loraAdapters : [];
  const showHelp = () => showModal({
    title: t("lora.help_title"),
    bodyNode: el("div", { style: "white-space: pre-line;" }, t("lora.help")),
    okLabel: t("common.close"),
  });
  const card = el("div", { class: "card full" }, [
    el("h2", { class: "section-title-row" }, [
      t("lora.title"),
      el("button", {
        class: "info-btn",
        title: t("lora.help_title"),
        "aria-label": t("lora.help_title"),
        onclick: showHelp,
      }, "?"),
    ]),
  ]);
  sec.appendChild(card);
  if (!adapters.length) {
    card.appendChild(el("div", { class: "sub" }, t("lora.empty")));
    return;
  }
  const tbl = el("div", { class: "kv-table" }, [
    el("div", { class: "k" }, t("lora.id")),
    el("div", { class: "k" }, t("lora.path")),
    el("div", { class: "k" }, t("lora.scale")),
  ]);
  /* shift to a 3-column layout */
  tbl.style.gridTemplateColumns = "max-content 1fr max-content";
  for (const a of adapters) {
    tbl.appendChild(el("div", { class: "v" }, String(a.id)));
    tbl.appendChild(el("div", { class: "v" }, String(a.path || "—")));
    tbl.appendChild(el("div", { class: "v" }, fmtParam(a.scale)));
  }
  card.appendChild(tbl);
}

