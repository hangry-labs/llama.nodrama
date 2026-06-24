"use strict";

/* ──────────────────────────────────────────────────────────────────────
 *  Polling engine. setTimeout chain with backoff + AbortController.
 *  Never setInterval — that allows requests to stack when the server
 *  is slow.
 * ──────────────────────────────────────────────────────────────────── */
function startPoller(name, intervalMs, taskFn) {
  let timer = null;
  let aborter = null;
  let stopped = false;
  let backoff = 0;       /* extra ms added on consecutive failures */
  const MAX_BACKOFF = 10_000;

  async function tick() {
    if (stopped) return;
    if (state.paused) {
      timer = setTimeout(tick, intervalMs);
      return;
    }
    aborter = new AbortController();
    try {
      await taskFn(aborter.signal);
      backoff = 0;
      clearBanner("poll-" + name);
    } catch (e) {
      if (e.aborted || e.name === "AbortError") {
        /* swallowed */
      } else {
        backoff = Math.min(MAX_BACKOFF, Math.max(1000, backoff ? backoff * 2 : 1000));
        showBanner(
          "poll-" + name,
          name + ": " + (e.message || t("error.fetch_failed")),
          "warn"
        );
      }
    }
    if (!stopped) timer = setTimeout(tick, intervalMs + backoff);
  }

  const handle = {
    name,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (aborter) try { aborter.abort(); } catch (_) {}
    },
  };
  state.pollers.push(handle);
  /* fire first tick on next microtask to avoid stacking inside boot() */
  Promise.resolve().then(tick);
  return handle;
}

function stopAllPollers() {
  for (const p of state.pollers) p.stop();
  state.pollers = [];
}

/* Pause / resume hook for keyboard shortcuts. */
function setPaused(v) {
  state.paused = !!v;
  if (state.paused) {
    setStatus("warn", "common.pause");
  } else if (state.healthy) {
    setStatus("online", "header.status.online");
  } else if (state.ui.bootDone) {
    setStatus("offline", "header.status.offline");
  } else {
    setStatus("connecting", "header.status.connecting");
  }
}

/* When the tab is hidden, abort in-flight requests and pause —
 * resume on visibility. Cheap battery / server-load saver. */
document.addEventListener("visibilitychange", () => {
  if (document.hidden) setPaused(true);
  else setPaused(false);
});

