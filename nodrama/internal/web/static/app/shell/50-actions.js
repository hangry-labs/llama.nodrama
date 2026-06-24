"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  POST handlers
 * ──────────────────────────────────────────────────────────────────── */
async function callLoadOrUnload(path, modelId, kind) {
  try {
    await fetchJSON(path, {
      method: "POST",
      withModel: false,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
      timeout: 60_000,
    });
    /* refresh /models so status updates */
    refreshRouterModels();
  } catch (e) {
    showBanner("post-" + kind, kind + ": " + e.message);
  }
}

async function refreshRouterModels() {
  if (state.mode !== "router") return;
  try {
    await refreshSnapshot({ timeout: 6000 });
  } catch (e) {
    showBanner("models-refresh", "/api/snapshot: " + e.message, "warn");
  }
}

/* Slot actions use the backend proxy so browsers do not call llama.cpp directly. */
async function slotAction(id, action) {
  const confirmKey = "slots.confirm." + action;
  const message = t(confirmKey, { id });
  const fileNode = el("div", null, [
    el("div", null, message),
    action !== "erase" ? el("div", { style: "margin-top: 8px;" }, [
      "filename: ",
      el("input", { id: "slot-fname", value: "slot_" + id + ".bin",
                    style: "min-width: 200px;" }),
    ]) : null,
  ].filter(Boolean));
  showModal({
    title: t("common.confirm"),
    bodyNode: fileNode,
    onOk: async () => {
      const body = action === "erase" ? null : JSON.stringify({
        filename: ($("#slot-fname") && $("#slot-fname").value) || ("slot_" + id + ".bin"),
      });
      try {
        await fetchJSON("/api/slots/" + id + "/" + action, {
          method: "POST",
          withModel: false,
          headers: action === "erase" ? {} : { "Content-Type": "application/json" },
          body,
          timeout: 30_000,
        });
      } catch (e) {
        showBanner("slot-" + action, "slot " + id + " " + action + ": " + e.message);
      }
    },
  });
}

