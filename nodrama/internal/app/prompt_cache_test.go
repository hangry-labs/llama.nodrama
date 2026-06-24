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
