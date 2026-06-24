"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  Guidance rendering. Suggestions are produced by the Go backend and
 *  carried in /api/snapshot; the browser only renders them.
 * ──────────────────────────────────────────────────────────────────── */
function evaluateGuidance() {
  return Array.isArray(state.suggestions) ? state.suggestions : [];
}

function renderGuidance() {
  const sec = $("#guidance-section");
  if (!sec) return;
  if (sec.dataset.built !== "1") {
    sec.dataset.built = "1";
    sec.innerHTML = "";
    sec.appendChild(el("div", { class: "card full" }, [
      el("h2", null, t("guidance.title")),
      el("div", { class: "guidance-list", id: "guidance-list" }),
    ]));
  }
  const list = $("#guidance-list");
  const suggestions = evaluateGuidance();
  list.innerHTML = "";
  if (!suggestions.length) {
    /* "No suggestions" can mean two very different things:
     *   1. Server is reachable and looks healthy → keep the existing copy.
     *   2. We can't reach the server at all → stop pretending it's healthy.
     * Distinguish by whether anything came back. */
    const noData = !state.props && !state.metrics
                   && (!state.slots || !state.slots.length);
    list.appendChild(el("div", { class: "sub" },
      t(noData ? "guidance.no_data" : "guidance.empty")));
    return;
  }
  for (const s of suggestions) {
    const item = el("div", { class: "suggestion severity-" + s.severity }, [
      el("div", { class: "head" }, [
        el("span", { class: "sev-badge " + s.severity },
          t("guidance.severity." + s.severity)),
        el("span", null, s.title),
        s.context && s.context.value
          ? el("span", { class: "sub" }, "— " + s.context.value)
          : null,
      ].filter(Boolean)),
      el("div", { class: "body" }, [
        el("div", null, s.explain),
        el("div", { style: "margin-top: 4px;" }, [
          el("strong", null, "→ "),
          s.suggest,
        ]),
      ]),
    ]);
    list.appendChild(item);
  }
}

/* Re-evaluate guidance whenever the data that feeds it changes. */
function bumpGuidance() {
  /* Throttle so a fast metrics poll doesn't spam re-render. */
  if (bumpGuidance._t) return;
  bumpGuidance._t = setTimeout(() => {
    bumpGuidance._t = null;
    renderGuidance();
  }, 250);
}

