"use strict";

function findV1Meta(modelId) {
  if (!Array.isArray(state.v1models)) return null;
  return state.v1models.find((m) => m && (m.id === modelId)) || null;
}

function renderModelsCard() {
  const sec = $("#models-section");
  sec.innerHTML = "";
  const card = el("div", { class: "card full" }, [
    el("h2", null, t("models.title")),
  ]);
  sec.appendChild(card);

  if (state.mode === "router") {
    /* selector + per-model cards */
    const sel = el("select", { id: "model-selector",
                               style: "max-width: 100%; min-width: 200px;",
                               onchange: () => onModelSelect($("#model-selector").value) });
    sel.appendChild(el("option", { value: "" }, "— " + t("models.selector") + " —"));
    for (const m of state.models) {
      sel.appendChild(el("option", {
        value: m.id,
        selected: m.id === state.selectedModel ? "selected" : null,
      }, m.id));
    }
    card.appendChild(el("div", { class: "row-actions" }, [
      el("span", { class: "sub" }, t("models.selector") + ":"),
      sel,
    ]));

    if (state.models.length === 0) {
      card.appendChild(el("div", { class: "sub" }, t("models.no_models")));
    } else {
      const list = el("div", { class: "model-list" });
      for (const m of state.models) list.appendChild(routerModelCard(m));
      card.appendChild(list);
    }
  } else {
    /* single-model: show the active model's metadata.
     * If neither /v1/models nor /props came back, render a "no data"
     * note instead of a fake card with a placeholder name like "model"
     * and a green "loaded" badge. */
    const id = (state.v1models[0] && state.v1models[0].id)
            || (state.props && state.props.model_path)
            || null;
    if (!id) {
      card.appendChild(el("div", { class: "sub" }, t("models.no_data")));
      return;
    }
    const meta = findV1Meta(id) || state.v1models[0] || null;
    card.appendChild(singleModelCard(id, meta));
  }
}

function routerModelCard(m) {
  const status = (m.status && m.status.value) || "unknown";
  const isActive = m.id === state.selectedModel;
  const meta = findV1Meta(m.id);
  const node = el("div", { class: "model-card" + (isActive ? " active" : "") }, [
    el("div", { class: "name" }, m.id),
    el("div", { class: "row-actions" }, [
      el("span", { class: "badge status-" + status }, t("models.status." + status)
        || t("models.status.unknown")),
      m.in_cache ? el("span", { class: "badge" }, t("models.cached")) : null,
      (m.status && m.status.failed && m.status.exit_code !== undefined && m.status.exit_code !== null)
        ? el("span", { class: "badge status-failed" },
            t("models.exit_code") + " " + m.status.exit_code)
        : null,
    ].filter(Boolean)),
    m.path ? el("div", { class: "sub" },
      el("span", { class: "badge" }, t("model.path")) )
      : null,
    m.path ? el("div", { class: "sub", style: "word-break: break-all;" }, m.path) : null,
  ]);
  if (meta && meta.meta) {
    node.appendChild(metaKVTable(meta.meta));
  }
  if (m.status && Array.isArray(m.status.args) && m.status.args.length) {
    const argsTxt = m.status.args.join(" ");
    const block = el("div", { class: "args-block" }, argsTxt);
    node.appendChild(block);
    node.appendChild(el("div", { class: "row-actions" }, [
      el("button", {
        onclick: (e) => copyToClipboard(argsTxt, e.currentTarget),
      }, t("common.copy")),
    ]));
  }
  /* load / unload buttons */
  const actions = el("div", { class: "row-actions" }, []);
  if (status === "loaded" || status === "sleeping") {
    actions.appendChild(el("button", {
      onclick: () => confirmAction(
        t("models.confirm.unload", { name: m.id }),
        () => callLoadOrUnload("/api/models/unload", m.id, "unload")
      ),
    }, t("models.actions.unload")));
  } else {
    actions.appendChild(el("button", {
      onclick: () => confirmAction(
        t("models.confirm.load", { name: m.id }),
        () => callLoadOrUnload("/api/models/load", m.id, "load")
      ),
    }, t("models.actions.load")));
  }
  node.appendChild(actions);
  return node;
}

function singleModelCard(id, meta) {
  const props = state.props || {};
  const card = el("div", { class: "model-card" }, [
    el("div", { class: "name" }, id),
    el("div", { class: "row-actions" }, [
      props.is_sleeping
        ? el("span", { class: "badge status-sleeping" }, t("models.status.sleeping"))
        : el("span", { class: "badge status-loaded" }, t("models.status.loaded")),
    ]),
  ]);
  if (props.model_path) {
    card.appendChild(el("div", { class: "kv-table" }, [
      el("div", { class: "k" }, t("model.path")),
      el("div", { class: "v" }, props.model_path),
    ]));
  }
  if (meta && meta.meta) card.appendChild(metaKVTable(meta.meta));
  return card;
}

function metaKVTable(meta) {
  const rows = [];
  function row(labelKey, val) {
    rows.push(el("div", { class: "k" }, t(labelKey)));
    rows.push(el("div", { class: "v" }, val == null ? "—" : String(val)));
  }
  if (meta.n_vocab !== undefined)      row("model.n_vocab",     meta.n_vocab);
  if (meta.n_ctx_train !== undefined)  row("model.n_ctx_train", meta.n_ctx_train);
  if (meta.n_embd !== undefined)       row("model.n_embd",      meta.n_embd);
  if (meta.n_params !== undefined)     row("model.n_params",    fmtNumber(meta.n_params));
  if (meta.size !== undefined)         row("model.size",        fmtBytes(meta.size));
  return el("div", { class: "kv-table" }, rows);
}

function fmtBytes(n) {
  if (!isFinite(n) || n == null) return "—";
  if (n >= 1024 * 1024 * 1024) return (n / (1024 * 1024 * 1024)).toFixed(2) + " GB";
  if (n >= 1024 * 1024) return (n / (1024 * 1024)).toFixed(2) + " MB";
  if (n >= 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

