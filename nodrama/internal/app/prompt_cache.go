package app

import (
	"math"
	"sort"

	"llama.nodrama/nodrama/internal/llamacpp"
)

const maxPromptCacheTopEntries = 10
const promptCacheMiBEpsilon = 0.001

func (m *Dashboard) applyPromptCacheEventLocked(event llamacpp.LogEvent) {
	if event.Kind != "cache" {
		return
	}

	if isPromptCacheStateEvent(event) {
		at := event.At
		m.promptCache = PromptCacheSummary{
			Available:   true,
			UpdatedAt:   &at,
			PromptCount: event.CachePrompts,
			UsedMiB:     event.CacheUsedMiB,
			LimitMiB:    event.CacheLimitMiB,
			LimitTokens: event.CacheLimitTokens,
			EstTokens:   event.CacheEstTokens,
		}
		m.promptCache.UsedTokensEstimate = promptCacheUsedTokensEstimate(event.CacheUsedMiB, event.CacheLimitMiB, event.CacheEstTokens)
		m.promptCacheMap = map[string]PromptCacheEntry{}
		m.rebuildPromptCacheSummaryLocked()
		return
	}

	if event.CacheAction != "observe" || event.CacheKey == "" {
		return
	}

	if m.promptCacheMap == nil {
		m.promptCacheMap = map[string]PromptCacheEntry{}
	}
	if !m.promptCache.Available {
		at := event.At
		m.promptCache = PromptCacheSummary{
			Available: true,
			UpdatedAt: &at,
		}
	}

	entry := m.promptCacheMap[event.CacheKey]
	entry.Key = event.CacheKey
	if event.PromptTokens > 0 {
		entry.Tokens = event.PromptTokens
	}
	if event.CacheCheckpoints > 0 {
		entry.Checkpoints = event.CacheCheckpoints
	}
	if event.CacheSizeMiB > 0 {
		entry.MiB = event.CacheSizeMiB
	}
	m.promptCacheMap[event.CacheKey] = entry
	m.rebuildPromptCacheSummaryLocked()
}

func isPromptCacheStateEvent(event llamacpp.LogEvent) bool {
	return event.CachePrompts > 0 ||
		event.CacheUsedMiB > 0 ||
		event.CacheLimitMiB > 0 ||
		event.CacheLimitTokens > 0 ||
		event.CacheEstTokens > 0
}

func promptCacheUsedTokensEstimate(usedMiB, limitMiB float64, estTokens int) int {
	if usedMiB <= 0 || limitMiB <= 0 || estTokens <= 0 {
		return 0
	}
	ratio := math.Max(0, math.Min(1, usedMiB/limitMiB))
	return int(math.Round(ratio * float64(estTokens)))
}

func (m *Dashboard) rebuildPromptCacheSummaryLocked() {
	if !m.promptCache.Available {
		return
	}

	entries := make([]PromptCacheEntry, 0, len(m.promptCacheMap))
	for _, entry := range m.promptCacheMap {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool {
		if entries[i].MiB != entries[j].MiB {
			return entries[i].MiB > entries[j].MiB
		}
		if entries[i].Tokens != entries[j].Tokens {
			return entries[i].Tokens > entries[j].Tokens
		}
		return entries[i].Key < entries[j].Key
	})

	limitMiB := m.promptCache.LimitMiB
	usedMiB := m.promptCache.UsedMiB
	if usedMiB <= 0 {
		for _, entry := range entries {
			usedMiB += entry.MiB
		}
	}
	tokenLimit := m.promptCache.EstTokens
	if tokenLimit <= 0 {
		tokenLimit = m.promptCache.LimitTokens
	}

	m.promptCache.ObservedEntries = len(entries)
	m.promptCache.Complete = m.promptCache.PromptCount == 0 || len(entries) >= m.promptCache.PromptCount
	m.promptCache.TopEntries = nil
	m.promptCache.Other = nil
	m.promptCache.UntrackedMiB = 0
	m.promptCache.UnusedMiB = 0

	other := PromptCacheEntry{Key: "Others"}
	trackedMiB := 0.0
	for i, entry := range entries {
		entry = promptCachePercentages(entry, limitMiB, usedMiB, tokenLimit)
		trackedMiB += entry.MiB
		if i < maxPromptCacheTopEntries {
			m.promptCache.TopEntries = append(m.promptCache.TopEntries, entry)
			continue
		}
		other.Count++
		other.Tokens += entry.Tokens
		other.Checkpoints += entry.Checkpoints
		other.MiB += entry.MiB
	}
	if other.Count > 0 {
		other = promptCachePercentages(other, limitMiB, usedMiB, tokenLimit)
		m.promptCache.Other = &other
	}

	if usedMiB-trackedMiB > promptCacheMiBEpsilon {
		m.promptCache.UntrackedMiB = usedMiB - trackedMiB
	}
	if limitMiB-usedMiB > promptCacheMiBEpsilon {
		m.promptCache.UnusedMiB = limitMiB - usedMiB
	}
}

func promptCachePercentages(entry PromptCacheEntry, limitMiB, usedMiB float64, tokenLimit int) PromptCacheEntry {
	if limitMiB > 0 && entry.MiB > 0 {
		entry.PercentOfLimit = entry.MiB / limitMiB
	}
	if usedMiB > 0 && entry.MiB > 0 {
		entry.PercentOfUsed = entry.MiB / usedMiB
	}
	if entry.PercentOfLimit == 0 && tokenLimit > 0 && entry.Tokens > 0 {
		entry.PercentOfLimit = float64(entry.Tokens) / float64(tokenLimit)
	}
	return entry
}

func (m *Dashboard) copyPromptCache() *PromptCacheSummary {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()
	return m.copyPromptCacheLocked()
}

func (m *Dashboard) copyPromptCacheLocked() *PromptCacheSummary {
	if !m.promptCache.Available {
		return nil
	}
	out := m.promptCache
	if m.promptCache.UpdatedAt != nil {
		at := *m.promptCache.UpdatedAt
		out.UpdatedAt = &at
	}
	out.TopEntries = append([]PromptCacheEntry(nil), m.promptCache.TopEntries...)
	if m.promptCache.Other != nil {
		other := *m.promptCache.Other
		out.Other = &other
	}
	return &out
}

func (m *Dashboard) resetPromptCacheLocked() {
	m.promptCache = PromptCacheSummary{}
	m.promptCacheMap = map[string]PromptCacheEntry{}
}
