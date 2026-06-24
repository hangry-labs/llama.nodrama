"use strict";

function renderPromptCache(cache) {
  const sec = $("#cache-section");
  if (!sec) return;
  if (sec.dataset.built !== "1") {
    sec.dataset.built = "1";
    sec.innerHTML = "";
    sec.appendChild(el("div", { class: "card full cache-card" }, [
      el("div", { class: "cache-head" }, [
        el("h2", null, t("cache.title")),
        el("span", { class: "sub", id: "cache-summary" }, t("cache.empty")),
      ]),
      el("div", { class: "cache-bar", id: "cache-bar" }),
      el("div", { class: "cache-legend", id: "cache-legend" }),
    ]));
  }

  const summary = $("#cache-summary");
  const bar = $("#cache-bar");
  const legend = $("#cache-legend");
  if (!summary || !bar || !legend) return;
  bar.innerHTML = "";
  legend.innerHTML = "";

  if (!cache || !cache.available) {
    summary.textContent = t("cache.empty");
    bar.hidden = true;
    legend.hidden = true;
    return;
  }

  bar.hidden = false;
  legend.hidden = false;

  const used = Number(cache.usedMiB || 0);
  const limit = Number(cache.limitMiB || 0);
  const prompts = Number(cache.promptCount || 0);
  const observed = Number(cache.observedEntries || 0);
  const usedText = limit > 0
    ? formatCacheMiB(used) + " / " + formatCacheMiB(limit)
    : formatCacheMiB(used);
  const countText = observed && prompts
    ? observed + "/" + prompts
    : (observed || prompts || 0);
  summary.textContent = t("cache.summary", {
    used: usedText,
    count: countText,
  });

  const denom = limit > 0 ? limit : Math.max(used, cacheEntryMiBSum(cache));
  const segments = promptCacheSegments(cache, denom);
  if (!segments.length) {
    bar.hidden = true;
    legend.hidden = true;
    summary.textContent = t("cache.empty");
    return;
  }

  for (const segment of segments) {
    const node = el("div", {
      class: "cache-segment " + segment.kind,
      title: segment.title,
      style: "width: " + Math.max(0.75, segment.percent * 100).toFixed(2) + "%",
    }, segment.label);
    bar.appendChild(node);
  }

  for (const segment of segments.filter((s) => s.kind !== "unused")) {
    legend.appendChild(el("div", { class: "cache-legend-item" }, [
      el("span", { class: "cache-swatch " + segment.kind }),
      el("span", { class: "cache-name" }, segment.name),
      el("span", { class: "cache-size" }, segment.detail),
    ]));
  }
}

function promptCacheSegments(cache, denom) {
  const out = [];
  const entries = Array.isArray(cache.topEntries) ? cache.topEntries : [];
  for (const entry of entries) {
    out.push(promptCacheSegment(entry, denom, "entry"));
  }
  if (cache.other) {
    out.push(promptCacheSegment(cache.other, denom, "other"));
  }
  const untracked = Number(cache.untrackedMiB || 0);
  if (untracked > 0 && denom > 0) {
    out.push({
      kind: "untracked",
      name: t("cache.untracked"),
      label: t("cache.untracked"),
      detail: formatCacheMiB(untracked),
      percent: untracked / denom,
      title: t("cache.untracked") + "\n" + formatCacheMiB(untracked),
    });
  }
  const unused = Number(cache.unusedMiB || 0);
  if (unused > 0 && denom > 0) {
    out.push({
      kind: "unused",
      name: t("cache.unused"),
      label: t("cache.unused"),
      detail: formatCacheMiB(unused),
      percent: unused / denom,
      title: t("cache.unused") + "\n" + formatCacheMiB(unused),
    });
  }
  return out.filter((segment) => segment.percent > 0);
}

function promptCacheSegment(entry, denom, kind) {
  const key = entry.key || t("cache.unknown_entry");
  const mib = Number(entry.mib || 0);
  const tokens = Number(entry.tokens || 0);
  const checkpoints = Number(entry.checkpoints || 0);
  const count = Number(entry.count || 0);
  const name = kind === "other"
    ? t("cache.others")
    : shortCacheKey(key);
  const detailParts = [];
  if (mib > 0) detailParts.push(formatCacheMiB(mib));
  if (tokens > 0) detailParts.push(fmtTokensCompact(tokens) + " tok");
  if (checkpoints > 0) detailParts.push(checkpoints + " ckpt");
  if (count > 0) detailParts.push(count + " entries");
  const detail = detailParts.join(" · ") || "—";
  const titleParts = [kind === "other" ? t("cache.others") : key];
  if (mib > 0) titleParts.push(formatCacheMiB(mib));
  if (tokens > 0) titleParts.push(fmtTokensCompact(tokens) + " tokens");
  if (checkpoints > 0) titleParts.push(checkpoints + " checkpoints");
  if (count > 0) titleParts.push(count + " entries");
  return {
    kind,
    name,
    label: name,
    detail,
    percent: denom > 0 ? mib / denom : 0,
    title: titleParts.join("\n"),
  };
}

function cacheEntryMiBSum(cache) {
  let total = 0;
  for (const entry of Array.isArray(cache.topEntries) ? cache.topEntries : []) {
    total += Number(entry.mib || 0);
  }
  if (cache.other) total += Number(cache.other.mib || 0);
  total += Number(cache.untrackedMiB || 0);
  total += Number(cache.unusedMiB || 0);
  return total;
}

function shortCacheKey(key) {
  const s = String(key || "");
  if (s.length <= 10) return s;
  return s.slice(0, 6) + "…" + s.slice(-4);
}

function formatCacheMiB(mib) {
  const value = Number(mib || 0);
  if (value >= 1024) return fmtNumber(value / 1024) + " GiB";
  return fmtNumber(value) + " MiB";
}
