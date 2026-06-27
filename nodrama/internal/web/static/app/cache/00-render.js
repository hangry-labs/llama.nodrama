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
    ]));
  }

  const summary = $("#cache-summary");
  const bar = $("#cache-bar");
  if (!summary || !bar) return;
  clearCacheSlotHighlight();
  clearPromptCacheKeyHighlight();
  clearQueryCacheKeyHighlight();
  bar.innerHTML = "";

  if (!cache || !cache.available) {
    summary.textContent = t("cache.empty");
    bar.hidden = true;
    return;
  }

  bar.hidden = false;

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
    summary.textContent = t("cache.empty");
    return;
  }

  for (const segment of segments) {
    const attrs = {
      class: "cache-segment " + segment.kind,
      title: segment.title,
      style: "width: " + Math.max(0.75, segment.percent * 100).toFixed(2) + "%",
    };
    if (segment.slotId !== undefined || segment.cacheKey) {
      attrs.tabindex = "0";
      attrs.data = {};
      if (segment.slotId !== undefined) attrs.data.slotId = String(segment.slotId);
      if (segment.cacheKey) attrs.data.cacheKey = segment.cacheKey;
    }
    const node = el("div", attrs, segment.label);
    if (segment.slotId !== undefined || segment.cacheKey) {
      node.addEventListener("mouseenter", () => highlightPromptCacheSegmentRefs(segment));
      node.addEventListener("mouseleave", clearPromptCacheSegmentRefs);
      node.addEventListener("focus", () => highlightPromptCacheSegmentRefs(segment));
      node.addEventListener("blur", clearPromptCacheSegmentRefs);
    }
    bar.appendChild(node);
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
  const slotId = entry.lastSlotId;
  const taskId = entry.lastTaskId;
  const lastUsedAt = entry.lastUsedAt;
  const name = cacheSizeTokenLabel(mib, tokens) || (kind === "other" ? t("cache.others") : t("cache.unknown_entry"));
  const detailParts = [];
  if (checkpoints > 0) detailParts.push(checkpoints + " ckpt");
  if (count > 0) detailParts.push(count + " entries");
  if (slotId !== undefined && slotId !== null) detailParts.push("slot " + slotId);
  const detail = detailParts.join(" · ") || "—";
  const titleParts = [kind === "other" ? t("cache.others") : ("id: " + key)];
  if (mib > 0) titleParts.push(formatCacheMiB(mib));
  if (tokens > 0) titleParts.push(fmtTokensCompact(tokens) + " tokens");
  if (checkpoints > 0) titleParts.push(checkpoints + " checkpoints");
  if (count > 0) titleParts.push(count + " entries");
  const linkedQueries = kind === "entry" ? promptCacheLinkedQueries(key) : [];
  if (linkedQueries.length) titleParts.push("queries: " + linkedQueries.join(", "));
  if (slotId !== undefined && slotId !== null) titleParts.push("last slot: " + slotId);
  if (taskId !== undefined && taskId !== null) titleParts.push("last task: " + taskId);
  if (lastUsedAt) titleParts.push("last used: " + fmtDateTime(lastUsedAt));
  return {
    kind,
    name,
    label: name,
    detail,
    percent: denom > 0 ? mib / denom : 0,
    title: titleParts.join("\n"),
    slotId: slotId !== undefined && slotId !== null ? Number(slotId) : undefined,
    cacheKey: kind === "entry" ? key : "",
  };
}

function promptCacheLinkedQueries(cacheKey) {
  if (!cacheKey || !Array.isArray(state.queries)) return [];
  return state.queries
    .filter((q) => q && q.cacheKey === cacheKey)
    .map((q) => q.id || ("task " + ((q.taskIds || [])[0] || "?")))
    .slice(0, 4);
}

function findPromptCacheEntry(cache, cacheKey) {
  if (!cache || !cacheKey) return null;
  const entries = Array.isArray(cache.topEntries) ? cache.topEntries : [];
  return entries.find((entry) => entry && entry.key === cacheKey) || null;
}

function promptCacheEntryLabel(entry) {
  if (!entry) return "";
  return cacheSizeTokenLabel(Number(entry.mib || 0), Number(entry.tokens || 0));
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

function formatCacheMiB(mib) {
  const value = Number(mib || 0);
  if (value >= 1024) return fmtNumber(value / 1024) + " GiB";
  return fmtNumber(value) + " MiB";
}

function cacheSizeTokenLabel(mib, tokens) {
  const parts = [];
  if (mib > 0) parts.push(formatCacheMiB(mib));
  if (tokens > 0) parts.push(fmtTokensCompact(tokens) + " tok");
  return parts.join(" · ");
}

function highlightCacheSlot(slotId) {
  clearCacheSlotHighlight();
  const slot = document.querySelector('[data-slot="' + slotId + '"]');
  if (slot) slot.classList.add("cache-highlight");
}

function clearCacheSlotHighlight() {
  $$(".slot.cache-highlight").forEach((slot) => slot.classList.remove("cache-highlight"));
}

function highlightPromptCacheSegmentRefs(segment) {
  if (segment.slotId !== undefined) highlightCacheSlot(segment.slotId);
  if (segment.cacheKey) highlightQueryCacheKey(segment.cacheKey);
}

function clearPromptCacheSegmentRefs() {
  clearCacheSlotHighlight();
  clearQueryCacheKeyHighlight();
}

function highlightPromptCacheKey(cacheKey) {
  clearPromptCacheKeyHighlight();
  if (!cacheKey) return;
  $$('[data-cache-key]').forEach((node) => {
    if (node.dataset.cacheKey === cacheKey && node.classList.contains("cache-segment")) {
      node.classList.add("cache-match-highlight");
    }
  });
}

function clearPromptCacheKeyHighlight() {
  $$(".cache-segment.cache-match-highlight").forEach((node) => node.classList.remove("cache-match-highlight"));
}

function highlightQueryCacheKey(cacheKey) {
  clearQueryCacheKeyHighlight();
  if (!cacheKey) return;
  $$('[data-cache-key]').forEach((node) => {
    if (node.dataset.cacheKey === cacheKey && node.classList.contains("query-card")) {
      node.classList.add("cache-match-highlight");
    }
  });
}

function clearQueryCacheKeyHighlight() {
  $$(".query-card.cache-match-highlight").forEach((node) => node.classList.remove("cache-match-highlight"));
}
