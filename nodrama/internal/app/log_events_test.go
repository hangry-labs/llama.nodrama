package app

import (
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"llama.nodrama/nodrama/internal/llamacpp"
)

func TestPollLogEventsTailsFromStartupOffset(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "llama.log")
	if err := os.WriteFile(path, []byte("124.55.423.849 I slot print_timing: id  2 | task 248761 | n_decoded =   7609, tg =  38.97 t/s\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	dashboard := NewDashboard(nil, Config{LogPath: path}, BuildInfo{})
	events, err := dashboard.pollLogEvents(path, time.Unix(1_700_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("events = %d", len(events))
	}

	events, err = dashboard.pollLogEvents(path, time.Unix(1_700_000_001, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 0 {
		t.Fatalf("unchanged events = %d", len(events))
	}

	file, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.WriteString("124.55.424.000 I slot 2 kv cache reused, task 248761\n"); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	events, err = dashboard.pollLogEvents(path, time.Unix(1_700_000_002, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events after append = %d", len(events))
	}
	if events[0].Kind != "cache" || events[0].CacheAction != "reuse" {
		t.Fatalf("cache event = %#v", events[0])
	}
}

func TestPollLogEventsAssignsStableBatchOrder(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "llama.log")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}

	dashboard := NewDashboard(nil, Config{LogPath: path}, BuildInfo{})
	if _, err := dashboard.pollLogEvents(path, time.Unix(1_700_000_000, 0)); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(
		"124.55.424.000 I slot 1 kv cache reused, task 1\n"+
			"124.55.424.001 I slot 1 kv cache reused, task 2\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	events, err := dashboard.pollLogEvents(path, time.Unix(1_700_000_001, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events = %d", len(events))
	}
	if !events[1].At.After(events[0].At) {
		t.Fatalf("batch timestamps should preserve line order: %#v", events)
	}
}

func TestUpdateQueriesCreatesActiveSlotQuery(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)

	queries := dashboard.updateQueries(now, "model-a", []llamacpp.Slot{{
		ID:                2,
		TaskID:            248761,
		IsProcessing:      true,
		State:             "generating",
		PromptTokens:      10,
		DecodedTokens:     20,
		PromptCacheTokens: 8,
	}}, true, true, nil, nil)

	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].ID != "task_248761" {
		t.Fatalf("query id = %q", queries[0].ID)
	}
	if queries[0].Status != "running" {
		t.Fatalf("status = %q", queries[0].Status)
	}
	if queries[0].Model != "model-a" {
		t.Fatalf("model = %q", queries[0].Model)
	}
	if len(queries[0].SlotIDs) != 1 || queries[0].SlotIDs[0] != 2 {
		t.Fatalf("slots = %#v", queries[0].SlotIDs)
	}
	if queries[0].CompletionTokens != 20 {
		t.Fatalf("completion tokens = %d", queries[0].CompletionTokens)
	}

	queries = dashboard.updateQueries(now.Add(time.Second), "model-a", []llamacpp.Slot{{
		ID:           2,
		IsProcessing: false,
		State:        "idle",
	}}, true, true, nil, nil)
	if queries[0].Status != "complete" {
		t.Fatalf("completed status = %q", queries[0].Status)
	}
}

func TestUpdateQueriesClosesStaleRunningTaskWhenSlotsAreIdle(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	started := time.Unix(1_700_000_000, 0)
	now := started.Add(time.Second)
	dashboard.queries = map[string]QuerySummary{
		"task_88": {
			ID:        "task_88",
			Status:    "running",
			StartedAt: started,
			SlotIDs:   []int{1},
			TaskIDs:   []int{88},
		},
	}

	queries := dashboard.updateQueries(now, "model-a", []llamacpp.Slot{{
		ID:           1,
		IsProcessing: false,
		State:        "idle",
	}}, true, true, nil, nil)

	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].Status != "complete" {
		t.Fatalf("stale task status = %q", queries[0].Status)
	}
	if queries[0].EndedAt == nil {
		t.Fatal("stale task should get an ended timestamp")
	}
}

func TestUpdateQueriesDoesNotLetUnfinishedRequestKeepIdleTaskRunning(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)
	requests := []RequestSummary{{
		ID:        "req_stale",
		Route:     "/api/chat/completions",
		StartedAt: now.Add(-time.Second),
		SlotIDs:   []int{1},
		TaskIDs:   []int{88},
	}}

	queries := dashboard.updateQueries(now, "model-a", []llamacpp.Slot{{
		ID:           1,
		IsProcessing: false,
		State:        "idle",
	}}, true, true, requests, nil)

	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].Status != "complete" {
		t.Fatalf("idle task with unfinished request status = %q", queries[0].Status)
	}
}

func TestUpdateQueriesExpiresOrphanedQueuedRequestWhenQueueIsEmpty(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	started := time.Unix(1_700_000_000, 0)
	now := started.Add(staleQueuedRequestAge + time.Second)
	requests := []RequestSummary{{
		ID:        "req_orphaned",
		Route:     "/api/chat/completions",
		StartedAt: started,
	}}

	queries := dashboard.updateQueries(now, "model-a", []llamacpp.Slot{{
		ID:           1,
		IsProcessing: false,
		State:        "idle",
	}}, true, true, requests, nil)

	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].Status != "error" {
		t.Fatalf("orphaned request status = %q", queries[0].Status)
	}
	if queries[0].Error == "" {
		t.Fatal("orphaned request should explain why it was closed")
	}
}

func TestUpdateQueriesMergesRequestAndEvents(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)
	requests := []RequestSummary{{
		ID:      "req_1",
		Route:   "/api/chat/completions",
		Model:   "model-a",
		SlotIDs: []int{2},
		TaskIDs: []int{248761},
		Usage:   &TokenUsage{PromptTokens: 10, CompletionTokens: 20, TotalTokens: 30},
	}}
	events := []llamacppLogEventForTest{
		{id: "evt_1", kind: "timing", slotID: 2, taskID: 248761, tokensPerSecond: 38.97, at: now},
		{id: "evt_2", kind: "cache", slotID: 2, taskID: 248761, cacheAction: "reuse", at: now.Add(time.Second)},
	}

	queries := dashboard.updateQueries(now, "", nil, false, false, requests, testLogEvents(events))
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].CurrentTokensPerSec != 38.97 {
		t.Fatalf("rate = %v", queries[0].CurrentTokensPerSec)
	}
	if queries[0].LastCacheAction != "reuse" {
		t.Fatalf("cache action = %q", queries[0].LastCacheAction)
	}
	if queries[0].CacheReuseCount != 1 {
		t.Fatalf("cache reuse count = %d", queries[0].CacheReuseCount)
	}
	if !queries[0].CacheCached {
		t.Fatal("cache reuse should mark query cached")
	}
	if queries[0].LastCacheReuseAt == nil {
		t.Fatal("cache reuse timestamp was not tracked")
	}
	if len(queries[0].RequestIDs) != 1 || queries[0].RequestIDs[0] != "req_1" {
		t.Fatalf("request ids = %#v", queries[0].RequestIDs)
	}
}

func TestUpdateQueriesCountsRestoredCheckpointAsReuse(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)

	queries := dashboard.updateQueries(now, "model-a", []llamacpp.Slot{{
		ID:           1,
		TaskID:       88,
		IsProcessing: true,
		State:        "prompt-processing",
		PromptTokens: 50000,
	}}, true, true, nil, []llamacpp.LogEvent{{
		ID:             "evt_restore",
		At:             now,
		Kind:           "warning",
		Severity:       "W",
		SlotID:         1,
		TaskID:         88,
		Message:        "slot update_slots: id  1 | task 88 | restored context checkpoint (n_tokens = 42800)",
		RestoredTokens: 42800,
	}})
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].LastCacheAction != "restore" {
		t.Fatalf("cache action = %q", queries[0].LastCacheAction)
	}
	if queries[0].CacheReuseCount != 1 {
		t.Fatalf("cache reuse count = %d", queries[0].CacheReuseCount)
	}
	if !queries[0].CacheCached {
		t.Fatal("restored checkpoint should mark query cached")
	}
	if queries[0].CacheRestoredTokens != 42800 {
		t.Fatalf("restored tokens = %d", queries[0].CacheRestoredTokens)
	}
}

func TestUpdateQueriesDoesNotCountTinyRestoredPrefixAsReuse(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)

	queries := dashboard.updateQueries(now, "model-a", []llamacpp.Slot{{
		ID:           1,
		TaskID:       3079110,
		IsProcessing: true,
		State:        "prompt-processing",
	}}, true, true, nil, []llamacpp.LogEvent{{
		ID:             "evt_restore",
		At:             now,
		Kind:           "warning",
		Severity:       "W",
		SlotID:         1,
		TaskID:         3079110,
		Message:        "slot update_slots: id  1 | task 3079110 | restored context checkpoint (pos_min = 6, pos_max = 6, n_tokens = 7, n_past = 7, size = 62.813 MiB)",
		RestoredTokens: 7,
	}})
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].CacheReuseCount != 0 {
		t.Fatalf("tiny restore should not count as reuse before prompt tokens are known: %#v", queries[0])
	}

	queries = dashboard.updateQueries(now.Add(time.Second), "model-a", []llamacpp.Slot{{
		ID:           1,
		TaskID:       3079110,
		IsProcessing: true,
		State:        "generating",
	}}, true, true, nil, []llamacpp.LogEvent{{
		ID:           "evt_prompt",
		At:           now.Add(time.Second),
		Kind:         "prompt_eval",
		SlotID:       1,
		TaskID:       3079110,
		Message:      "slot print_timing: id  1 | task 3079110 | prompt eval time = 355.18 ms / 590 tokens",
		PromptTokens: 590,
	}})
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].PromptTokens != 590 {
		t.Fatalf("prompt tokens = %d", queries[0].PromptTokens)
	}
	if queries[0].CacheRestoredTokens != 7 {
		t.Fatalf("restored tokens = %d", queries[0].CacheRestoredTokens)
	}
	if queries[0].CacheReuseCount != 0 {
		t.Fatalf("tiny restore should not count as reuse after prompt tokens are known: %#v", queries[0])
	}
	if queries[0].LastCacheAction == "restore" {
		t.Fatalf("tiny restore should not surface as cache reuse action: %#v", queries[0])
	}
}

func TestUpdateQueriesIgnoresCacheSaveForQueryReuse(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)

	queries := dashboard.updateQueries(now, "model-a", []llamacpp.Slot{{
		ID:           1,
		TaskID:       88,
		IsProcessing: true,
		State:        "generating",
	}}, true, true, nil, []llamacpp.LogEvent{{
		ID:          "evt_save",
		At:          now,
		Kind:        "cache",
		SlotID:      1,
		TaskID:      88,
		CacheAction: "save",
		Message:     "saving idle slot to prompt cache",
	}})
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].LastCacheAction != "" {
		t.Fatalf("save should not surface as query cache action: %#v", queries[0])
	}
	if queries[0].CacheReuseCount != 0 {
		t.Fatalf("save should not count as reuse: %d", queries[0].CacheReuseCount)
	}
	if !queries[0].CacheCached {
		t.Fatal("save should mark query as cached without counting as reuse")
	}
}

func TestUpdateQueriesClearsCachedStateOnInvalidation(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)

	queries := dashboard.updateQueries(now, "model-a", nil, false, false, nil, []llamacpp.LogEvent{
		{
			ID:             "evt_restore",
			At:             now,
			Kind:           "warning",
			Severity:       "W",
			TaskID:         88,
			Message:        "slot update_slots: id  1 | task 88 | restored context checkpoint (n_tokens = 512)",
			RestoredTokens: 512,
		},
		{
			ID:           "evt_prompt",
			At:           now.Add(time.Nanosecond),
			Kind:         "prompt_eval",
			TaskID:       88,
			Message:      "slot print_timing: id 1 | task 88 | prompt eval time = 10 ms / 1024 tokens",
			PromptTokens: 1024,
		},
	})
	if len(queries) != 1 || !queries[0].CacheCached {
		t.Fatalf("restore should mark cached: %#v", queries)
	}

	queries = dashboard.updateQueries(now.Add(time.Second), "model-a", nil, false, false, nil, []llamacpp.LogEvent{{
		ID:       "evt_invalidate",
		At:       now.Add(time.Second),
		Kind:     "warning",
		Severity: "W",
		TaskID:   88,
		Message:  "slot update_slots: id  1 | task 88 | erased invalidated context checkpoint",
	}})
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].CacheCached {
		t.Fatalf("invalidate should clear cached badge state: %#v", queries[0])
	}
	if queries[0].CacheReuseCount != 1 {
		t.Fatalf("reuse history should remain after invalidation: %d", queries[0].CacheReuseCount)
	}
}

func TestUpdateQueriesDoesNotSmearConcurrentRequestTasks(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)
	ended := now.Add(time.Second)
	request := RequestSummary{
		ID:         "req_parallel",
		Route:      "/api/chat/completions",
		Model:      "model-a",
		StartedAt:  now,
		EndedAt:    &ended,
		DurationMS: 1000,
		Status:     200,
		SlotIDs:    []int{1, 2},
		TaskIDs:    []int{101, 202},
		Usage:      &TokenUsage{PromptTokens: 10, CompletionTokens: 20, TotalTokens: 30},
	}

	queries := dashboard.updateQueries(ended, "", nil, false, false, []RequestSummary{request}, nil)
	if len(queries) != 2 {
		t.Fatalf("queries = %d", len(queries))
	}
	for _, query := range queries {
		if query.ID == "task_101" && (len(query.TaskIDs) != 1 || query.TaskIDs[0] != 101) {
			t.Fatalf("task_101 smeared tasks: %#v", query.TaskIDs)
		}
		if query.ID == "task_202" && (len(query.TaskIDs) != 1 || query.TaskIDs[0] != 202) {
			t.Fatalf("task_202 smeared tasks: %#v", query.TaskIDs)
		}
	}
}

func TestUpdateQueriesRunningSlotUsesCurrentIdentity(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)

	dashboard.queries = map[string]QuerySummary{
		"task_77": {
			ID:              "task_77",
			Status:          "complete",
			StartedAt:       now.Add(-time.Minute),
			SlotIDs:         []int{1, 2},
			TaskIDs:         []int{77, 88},
			LastCacheAction: "invalidate",
		},
	}

	queries := dashboard.updateQueries(now, "model-a", []llamacpp.Slot{{
		ID:           2,
		TaskID:       77,
		IsProcessing: true,
		State:        "generating",
	}}, true, true, nil, nil)
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if len(queries[0].SlotIDs) != 1 || queries[0].SlotIDs[0] != 2 {
		t.Fatalf("slot ids = %#v", queries[0].SlotIDs)
	}
	if len(queries[0].TaskIDs) != 1 || queries[0].TaskIDs[0] != 77 {
		t.Fatalf("task ids = %#v", queries[0].TaskIDs)
	}
	if queries[0].LastCacheAction == "invalidate" {
		t.Fatal("running query should clear stale invalidate action")
	}
}

func TestUpdateQueriesMarksUnassignedRequestQueued(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)
	request := RequestSummary{
		ID:        "req_waiting",
		Route:     "/api/chat/completions",
		Model:     "model-a",
		StartedAt: now,
	}

	queries := dashboard.updateQueries(now, "", nil, false, false, []RequestSummary{request}, nil)
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].Status != "queued" {
		t.Fatalf("status = %q", queries[0].Status)
	}
}

func TestUpdateQueriesDoesNotShowInvalidateActionForRunningQuery(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)

	queries := dashboard.updateQueries(now, "model-a", []llamacpp.Slot{{
		ID:           1,
		TaskID:       77,
		IsProcessing: true,
		State:        "generating",
	}}, true, true, nil, []llamacpp.LogEvent{{
		ID:       "evt_invalidate",
		At:       now,
		Kind:     "warning",
		Severity: "W",
		SlotID:   1,
		TaskID:   77,
		Message:  "slot update_slots: id  1 | task 77 | erased invalidated context checkpoint",
	}})
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].Status != "running" {
		t.Fatalf("status = %q", queries[0].Status)
	}
	if queries[0].LastCacheAction == "invalidate" {
		t.Fatalf("running query should not show invalidate cache action: %#v", queries[0])
	}
}

func TestUpdateQueriesRanksRunningThenReuseThenRecent(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	for i := 1; i <= maxRecentQueries+2; i++ {
		started := base.Add(time.Duration(i) * time.Second)
		ended := started.Add(500 * time.Millisecond)
		requests := []RequestSummary{{
			ID:         "req_" + strconv.Itoa(i),
			Route:      "/api/chat/completions",
			StartedAt:  started,
			EndedAt:    &ended,
			DurationMS: 500,
			Status:     200,
			TaskIDs:    []int{i},
		}}
		dashboard.updateQueries(ended, "", nil, false, false, requests, nil)
	}

	events := []llamacpp.LogEvent{}
	for i := 1; i <= 3; i++ {
		events = append(events, llamacpp.LogEvent{
			ID:             "evt_restore_" + strconv.Itoa(i),
			At:             base.Add(time.Minute + time.Duration(i)*time.Second),
			Kind:           "warning",
			Severity:       "W",
			TaskID:         1,
			Message:        "slot update_slots: restored context checkpoint (n_tokens = 512)",
			RestoredTokens: 512,
		})
	}
	events = append(events, llamacpp.LogEvent{
		ID:           "evt_prompt_1",
		At:           base.Add(time.Minute + 4*time.Second),
		Kind:         "prompt_eval",
		TaskID:       1,
		Message:      "slot print_timing: id 1 | task 1 | prompt eval time = 10 ms / 1024 tokens",
		PromptTokens: 1024,
	})
	queries := dashboard.updateQueries(base.Add(time.Minute), "", []llamacpp.Slot{{
		ID:           9,
		TaskID:       999,
		IsProcessing: true,
		State:        "generating",
	}}, true, true, nil, events)

	if len(queries) != maxRecentQueries {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].ID != "task_999" || queries[0].Status != "running" {
		t.Fatalf("running query should rank first: %#v", queries)
	}
	if queries[1].ID != "task_1" || queries[1].CacheReuseCount != 3 {
		t.Fatalf("reused query should rank ahead of newer completed queries: %#v", queries)
	}
	if !queries[1].CacheCached {
		t.Fatalf("reused query should expose cached badge state: %#v", queries[1])
	}
	if hasQuery(queries, "task_2") {
		t.Fatalf("old unreused query should be pruned: %#v", queries)
	}
}

func TestUpdateQueriesRestoredCheckpointsAreCapped(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	events := make([]llamacpp.LogEvent, 0, maxRecentQueries+20)
	for i := 1; i <= maxRecentQueries+20; i++ {
		events = append(events, llamacpp.LogEvent{
			ID:             "evt_restore_" + strconv.Itoa(i),
			At:             base.Add(time.Duration(i) * time.Second),
			Kind:           "warning",
			Severity:       "W",
			TaskID:         i,
			Message:        "slot update_slots: restored context checkpoint (n_tokens = 512)",
			RestoredTokens: 512,
		})
	}

	queries := dashboard.updateQueries(base.Add(time.Minute), "", nil, false, false, nil, events)
	if len(queries) != maxRecentQueries {
		t.Fatalf("queries = %d", len(queries))
	}
}

type llamacppLogEventForTest struct {
	id              string
	kind            string
	slotID          int
	taskID          int
	tokensPerSecond float64
	cacheAction     string
	at              time.Time
}

func testLogEvents(in []llamacppLogEventForTest) []llamacpp.LogEvent {
	out := make([]llamacpp.LogEvent, 0, len(in))
	for _, event := range in {
		out = append(out, llamacpp.LogEvent{
			ID:              event.id,
			At:              event.at,
			Kind:            event.kind,
			SlotID:          event.slotID,
			TaskID:          event.taskID,
			TokensPerSecond: event.tokensPerSecond,
			CacheAction:     event.cacheAction,
		})
	}
	return out
}

func hasQuery(queries []QuerySummary, id string) bool {
	for _, query := range queries {
		if query.ID == id {
			return true
		}
	}
	return false
}
