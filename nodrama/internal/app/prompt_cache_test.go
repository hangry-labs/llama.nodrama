package app

import (
	"testing"
	"time"
)

func TestAnnotatePromptCacheUsageKeepsSlotZero(t *testing.T) {
	older := time.Date(2026, 6, 25, 10, 0, 0, 0, time.UTC)
	newer := older.Add(time.Minute)
	cache := &PromptCacheSummary{
		Available: true,
		TopEntries: []PromptCacheEntry{{
			Key: "0xabc",
			MiB: 64,
		}},
	}

	out := annotatePromptCacheUsage(cache, []QuerySummary{
		{
			CacheKey:         "0xabc",
			SlotIDs:          []int{2},
			TaskIDs:          []int{100},
			LastCacheReuseAt: &older,
			StartedAt:        older,
		},
		{
			CacheKey:         "0xabc",
			SlotIDs:          []int{0},
			TaskIDs:          []int{101},
			LastCacheReuseAt: &newer,
			StartedAt:        newer,
		},
	})

	entry := out.TopEntries[0]
	if entry.LastSlotID == nil || *entry.LastSlotID != 0 {
		t.Fatalf("last slot id = %#v, want pointer to 0", entry.LastSlotID)
	}
	if entry.LastTaskID == nil || *entry.LastTaskID != 101 {
		t.Fatalf("last task id = %#v, want pointer to 101", entry.LastTaskID)
	}
	if entry.LastUsedAt == nil || !entry.LastUsedAt.Equal(newer) {
		t.Fatalf("last used at = %#v, want %s", entry.LastUsedAt, newer)
	}
}

func TestPromptCacheWithMetricsProvidesHonestFallback(t *testing.T) {
	at := time.Date(2026, 9, 16, 1, 0, 0, 0, time.UTC)
	out := promptCacheWithMetrics(nil, map[string]float64{
		"llamacpp:prompt_tokens_cached_total": 12_647_500,
	}, at)

	if out == nil || !out.Available {
		t.Fatal("metric-backed prompt cache summary is unavailable")
	}
	if out.DetailsAvailable {
		t.Fatal("metric-only summary must not claim detailed occupancy")
	}
	if out.Source != "metrics" || out.ReusedTokensTotal != 12_647_500 {
		t.Fatalf("metric-only summary = %#v", out)
	}
	if out.UsedMiB != 0 || out.LimitMiB != 0 {
		t.Fatalf("metric-only summary invented memory occupancy: %#v", out)
	}
}

func TestPromptCacheWithMetricsPreservesDetailedLogData(t *testing.T) {
	at := time.Date(2026, 9, 16, 1, 0, 0, 0, time.UTC)
	cache := &PromptCacheSummary{
		Available:        true,
		DetailsAvailable: true,
		Source:           "logs",
		UsedMiB:          1024,
		LimitMiB:         8192,
	}
	out := promptCacheWithMetrics(cache, map[string]float64{
		"llamacpp:prompt_tokens_cached_total": 42,
	}, at)

	if !out.DetailsAvailable || out.Source != "logs" || out.UsedMiB != 1024 || out.LimitMiB != 8192 {
		t.Fatalf("detailed summary was changed: %#v", out)
	}
	if out.ReusedTokensTotal != 42 {
		t.Fatalf("reused tokens total = %d", out.ReusedTokensTotal)
	}
}
