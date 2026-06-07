package app

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"llama.nodrama/nodrama/internal/llamacpp"
)

func TestPollLogEventsReadsIncrementally(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "llama.log")
	if err := os.WriteFile(path, []byte("124.55.423.849 I slot print_timing: id  2 | task 248761 | n_decoded =   7609, tg =  38.97 t/s\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	dashboard := NewDashboard(nil, Config{LogPath: path}, BuildInfo{})
	events, err := dashboard.pollLogEvents(time.Unix(1_700_000_000, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
		t.Fatalf("events = %d", len(events))
	}
	if events[0].Kind != "timing" || events[0].SlotID != 2 || events[0].TaskID != 248761 {
		t.Fatalf("event = %#v", events[0])
	}

	events, err = dashboard.pollLogEvents(time.Unix(1_700_000_001, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 1 {
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

	events, err = dashboard.pollLogEvents(time.Unix(1_700_000_002, 0))
	if err != nil {
		t.Fatal(err)
	}
	if len(events) != 2 {
		t.Fatalf("events after append = %d", len(events))
	}
	if events[1].Kind != "cache" || events[1].CacheAction != "reuse" {
		t.Fatalf("cache event = %#v", events[1])
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
	}}, nil, nil)

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
	}}, nil, nil)
	if queries[0].Status != "complete" {
		t.Fatalf("completed status = %q", queries[0].Status)
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

	queries := dashboard.updateQueries(now, "", nil, requests, testLogEvents(events))
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].CurrentTokensPerSec != 38.97 {
		t.Fatalf("rate = %v", queries[0].CurrentTokensPerSec)
	}
	if queries[0].LastCacheAction != "reuse" {
		t.Fatalf("cache action = %q", queries[0].LastCacheAction)
	}
	if !queries[0].CacheResident {
		t.Fatal("query should be marked cache resident")
	}
	if len(queries[0].RequestIDs) != 1 || queries[0].RequestIDs[0] != "req_1" {
		t.Fatalf("request ids = %#v", queries[0].RequestIDs)
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

	queries := dashboard.updateQueries(ended, "", nil, []RequestSummary{request}, nil)
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

func TestUpdateQueriesMarksUnassignedRequestQueued(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)
	request := RequestSummary{
		ID:        "req_waiting",
		Route:     "/api/chat/completions",
		Model:     "model-a",
		StartedAt: now,
	}

	queries := dashboard.updateQueries(now, "", nil, []RequestSummary{request}, nil)
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].Status != "queued" {
		t.Fatalf("status = %q", queries[0].Status)
	}
}

func TestUpdateQueriesKeepsRecentPlusCacheResident(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	for i := 1; i <= maxRecentQueries+2; i++ {
		started := base.Add(time.Duration(i) * time.Second)
		ended := started.Add(500 * time.Millisecond)
		requests := []RequestSummary{{
			ID:         "req_" + string(rune('a'+i)),
			Route:      "/api/chat/completions",
			StartedAt:  started,
			EndedAt:    &ended,
			DurationMS: 500,
			Status:     200,
			TaskIDs:    []int{i},
		}}
		dashboard.updateQueries(ended, "", nil, requests, nil)
	}

	queries := dashboard.updateQueries(base.Add(time.Minute), "", nil, nil, []llamacpp.LogEvent{{
		ID:          "evt_cache_resident",
		At:          base.Add(time.Minute),
		Kind:        "cache",
		TaskID:      1,
		CacheAction: "save",
		Message:     "saving idle slot to prompt cache",
	}})

	if len(queries) != maxRecentQueries+1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if !hasQuery(queries, "task_1") {
		t.Fatalf("resident older query was pruned: %#v", queries)
	}
	if hasQuery(queries, "task_2") {
		t.Fatalf("old non-resident query should be pruned: %#v", queries)
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
