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

func TestQueriesFromRequestsEnrichesFromEvents(t *testing.T) {
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
		{kind: "timing", slotID: 2, taskID: 248761, tokensPerSecond: 38.97, at: now},
		{kind: "cache", slotID: 2, taskID: 248761, cacheAction: "reuse", at: now.Add(time.Second)},
	}

	queries := queriesFromRequests(requests, testLogEvents(events))
	if len(queries) != 1 {
		t.Fatalf("queries = %d", len(queries))
	}
	if queries[0].CurrentTokensPerSec != 38.97 {
		t.Fatalf("rate = %v", queries[0].CurrentTokensPerSec)
	}
	if queries[0].LastCacheAction != "reuse" {
		t.Fatalf("cache action = %q", queries[0].LastCacheAction)
	}
}

type llamacppLogEventForTest struct {
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
