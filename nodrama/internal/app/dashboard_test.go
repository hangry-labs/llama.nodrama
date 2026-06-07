package app

import (
	"math"
	"testing"
	"time"

	"llama.nodrama/nodrama/internal/llamacpp"
)

func TestCounterRate(t *testing.T) {
	if got := counterRate(100, 160, 2); got != 30 {
		t.Fatalf("rate = %v", got)
	}
	if got := counterRate(160, 100, 2); got != 0 {
		t.Fatalf("reset rate = %v", got)
	}
	if got := counterRate(100, 160, 0); got != 0 {
		t.Fatalf("empty elapsed rate = %v", got)
	}
}

func TestRecordMetricHistory(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	history := dashboard.recordMetricHistory(base, map[string]float64{
		"llamacpp:requests_processing": 2,
		"bad:nan":                      math.NaN(),
		"bad:inf":                      math.Inf(1),
	})

	if got := len(history.Metrics["llamacpp:requests_processing"]); got != 1 {
		t.Fatalf("history length = %d", got)
	}
	if _, ok := history.Metrics["bad:nan"]; ok {
		t.Fatal("NaN sample should not be recorded")
	}
	if _, ok := history.Metrics["bad:inf"]; ok {
		t.Fatal("Inf sample should not be recorded")
	}

	history.Metrics["llamacpp:requests_processing"][0].V = 99
	next := dashboard.recordMetricHistory(base.Add(time.Second), map[string]float64{
		"llamacpp:requests_processing": 3,
	})
	if got := next.Metrics["llamacpp:requests_processing"][0].V; got != 2 {
		t.Fatalf("history was not copied, got first value %v", got)
	}
}

func TestRecordMetricHistoryTrimsWindow(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	dashboard.recordMetricHistory(base, map[string]float64{"metric": 1})
	history := dashboard.recordMetricHistory(base.Add(metricHistoryWindow+time.Second), map[string]float64{"metric": 2})

	points := history.Metrics["metric"]
	if len(points) != 1 {
		t.Fatalf("history length after trim = %d", len(points))
	}
	if points[0].V != 2 {
		t.Fatalf("remaining value = %v", points[0].V)
	}
}

func TestRecordMetricHistoryTracksPeakFacts(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	dashboard.recordMetricHistory(base, map[string]float64{"llamacpp:n_tokens_max": 100})
	dashboard.recordMetricHistory(base.Add(time.Second), map[string]float64{"llamacpp:n_tokens_max": 90})
	dashboard.recordMetricHistory(base.Add(2*time.Second), map[string]float64{"llamacpp:n_tokens_max": 120})

	facts := dashboard.copyMetricFacts()
	fact := facts["llamacpp:n_tokens_max"]
	if fact.PeakValue != 120 {
		t.Fatalf("peak = %v", fact.PeakValue)
	}
	if fact.PeakAt == nil || !fact.PeakAt.Equal(base.Add(2*time.Second)) {
		t.Fatalf("peak at = %v", fact.PeakAt)
	}
}

func TestDashboardUpdateSettingsAppliesRuntimeConfig(t *testing.T) {
	dashboard := NewDashboard(nil, Config{
		Server:       DefaultServer,
		Listen:       ":39080",
		PollInterval: time.Second,
		Timeout:      5 * time.Second,
	}, BuildInfo{})

	server := "http://127.0.0.1:18081"
	logPath := "/tmp/llama.cpp.log"
	pollMS := int64(500)
	timeoutMS := int64(2500)
	settings, err := dashboard.UpdateSettings(RuntimeSettingsUpdate{
		Server:       &server,
		LogPath:      &logPath,
		PollInterval: &pollMS,
		Timeout:      &timeoutMS,
	})
	if err != nil {
		t.Fatal(err)
	}
	if settings.Server != server || settings.LogPath != logPath || settings.PollInterval != pollMS || settings.Timeout != timeoutMS {
		t.Fatalf("settings = %#v", settings)
	}
	if dashboard.runtimeConfig().Server != server {
		t.Fatalf("runtime server = %q", dashboard.runtimeConfig().Server)
	}
}

func TestDashboardUpdateSettingsRejectsInvalidServer(t *testing.T) {
	dashboard := NewDashboard(nil, Config{
		Server:       DefaultServer,
		PollInterval: time.Second,
		Timeout:      5 * time.Second,
	}, BuildInfo{})

	badServer := "file:///tmp/socket"
	if _, err := dashboard.UpdateSettings(RuntimeSettingsUpdate{Server: &badServer}); err == nil {
		t.Fatal("expected invalid server error")
	}
	if dashboard.runtimeConfig().Server != DefaultServer {
		t.Fatalf("server changed after invalid update: %q", dashboard.runtimeConfig().Server)
	}
}

func TestDeriveSlotLiveRatesSumsActiveSlotDeltas(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	_, _, hasRate := dashboard.deriveSlotLiveRates(base, []llamacpp.Slot{
		{ID: 1, TaskID: 10, IsProcessing: true, DecodedTokens: 100, PromptProcessedTokens: 40},
		{ID: 2, TaskID: 20, IsProcessing: true, DecodedTokens: 200, PromptProcessedTokens: 80},
	})
	if hasRate {
		t.Fatal("first sample should only establish baselines")
	}

	promptRate, generationRate, hasRate := dashboard.deriveSlotLiveRates(base.Add(2*time.Second), []llamacpp.Slot{
		{ID: 1, TaskID: 10, IsProcessing: true, DecodedTokens: 180, PromptProcessedTokens: 60},
		{ID: 2, TaskID: 20, IsProcessing: true, DecodedTokens: 260, PromptProcessedTokens: 90},
	})
	if !hasRate {
		t.Fatal("expected slot-derived rate")
	}
	if generationRate != 70 {
		t.Fatalf("generation rate = %v", generationRate)
	}
	if promptRate != 15 {
		t.Fatalf("prompt rate = %v", promptRate)
	}

	history := dashboard.recordSlotHistory(base.Add(2*time.Second), []llamacpp.Slot{
		{ID: 1, TaskID: 10, IsProcessing: true},
		{ID: 2, TaskID: 20, IsProcessing: true},
	}, "model-a")
	if got := history.Slots["1"][0].GenerationTokensPerSec; got != 40 {
		t.Fatalf("slot 1 generation rate = %v", got)
	}
	if got := history.Slots["2"][0].GenerationTokensPerSec; got != 30 {
		t.Fatalf("slot 2 generation rate = %v", got)
	}
}

func TestDeriveSlotLiveRatesIgnoresTaskChangesAndResets(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	dashboard.deriveSlotLiveRates(base, []llamacpp.Slot{
		{ID: 1, TaskID: 10, IsProcessing: true, DecodedTokens: 100},
		{ID: 2, TaskID: 20, IsProcessing: true, DecodedTokens: 200},
	})

	_, generationRate, hasRate := dashboard.deriveSlotLiveRates(base.Add(time.Second), []llamacpp.Slot{
		{ID: 1, TaskID: 11, IsProcessing: true, DecodedTokens: 1000},
		{ID: 2, TaskID: 20, IsProcessing: true, DecodedTokens: 150},
	})
	if hasRate {
		t.Fatalf("task change/reset should not produce a rate, got %v", generationRate)
	}
}

func TestDeriveSlotLiveRatesIgnoresFinalIdleDump(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	dashboard.deriveSlotLiveRates(base, []llamacpp.Slot{
		{ID: 1, TaskID: 10, IsProcessing: true, DecodedTokens: 1000},
	})

	_, generationRate, hasRate := dashboard.deriveSlotLiveRates(base.Add(time.Second), []llamacpp.Slot{
		{ID: 1, TaskID: 10, IsProcessing: false, DecodedTokens: 50000},
	})
	if hasRate {
		t.Fatalf("idle final counters should not produce a live rate, got %v", generationRate)
	}
}

func TestRecordSlotHistory(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	history := dashboard.recordSlotHistory(base, []llamacpp.Slot{{
		ID:                 2,
		TaskID:             44,
		State:              "generating",
		IsProcessing:       true,
		ContextTokens:      4096,
		DecodedTokens:      12,
		RemainingTokens:    20,
		GenerationProgress: 0.25,
	}}, "model-a")

	points := history.Slots["2"]
	if len(points) != 1 {
		t.Fatalf("slot history length = %d", len(points))
	}
	if points[0].TaskID != 44 {
		t.Fatalf("task id = %d", points[0].TaskID)
	}
	if points[0].Model != "model-a" {
		t.Fatalf("model = %q", points[0].Model)
	}

	points[0].TaskID = 99
	next := dashboard.recordSlotHistory(base.Add(time.Second), []llamacpp.Slot{{
		ID:    2,
		State: "idle",
	}}, "model-a")
	if got := next.Slots["2"][0].TaskID; got != 44 {
		t.Fatalf("slot history was not copied, got task id %d", got)
	}
}

func TestRecordSlotHistoryTrimsWindow(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	dashboard.recordSlotHistory(base, []llamacpp.Slot{{ID: 1, State: "generating", IsProcessing: true}}, "model-a")
	history := dashboard.recordSlotHistory(base.Add(metricHistoryWindow+time.Second), []llamacpp.Slot{{ID: 1, State: "idle"}}, "model-a")

	points := history.Slots["1"]
	if len(points) != 1 {
		t.Fatalf("slot history length after trim = %d", len(points))
	}
	if points[0].State != "idle" {
		t.Fatalf("remaining slot state = %q", points[0].State)
	}
}

func TestRequestTracking(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})

	id := dashboard.StartRequest("/api/chat/completions", "model-a", true)
	dashboard.FinishRequest(id, 200, 1234, &TokenUsage{PromptTokens: 10, CompletionTokens: 3, TotalTokens: 13}, "")

	requests := dashboard.Snapshot().Requests
	if len(requests) != 1 {
		t.Fatalf("requests length = %d", len(requests))
	}
	req := requests[0]
	if req.ID != id {
		t.Fatalf("request id = %q", req.ID)
	}
	if req.Route != "/api/chat/completions" {
		t.Fatalf("route = %q", req.Route)
	}
	if req.Model != "model-a" {
		t.Fatalf("model = %q", req.Model)
	}
	if !req.Stream {
		t.Fatal("stream flag was not recorded")
	}
	if req.Status != 200 {
		t.Fatalf("status = %d", req.Status)
	}
	if req.ResponseBytes != 1234 {
		t.Fatalf("response bytes = %d", req.ResponseBytes)
	}
	if req.Usage == nil || req.Usage.TotalTokens != 13 {
		t.Fatalf("usage = %#v", req.Usage)
	}
	if req.EndedAt == nil {
		t.Fatal("endedAt was not recorded")
	}
	if req.DurationMS < 0 {
		t.Fatalf("duration = %d", req.DurationMS)
	}
}

func TestRequestTrackingCapsHistory(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})

	for i := 0; i < maxRequestHistory+5; i++ {
		dashboard.StartRequest("/api/chat/completions", "model-a", true)
	}

	requests := dashboard.Snapshot().Requests
	if len(requests) != maxRequestHistory {
		t.Fatalf("requests length = %d", len(requests))
	}
}

func TestInferRequestSlotsFromSlotHistory(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)
	dashboard.recordSlotHistory(base.Add(time.Second), []llamacpp.Slot{{
		ID:                1,
		TaskID:            77,
		IsProcessing:      true,
		State:             "generating",
		PromptCacheTokens: 42,
	}}, "model-a")
	dashboard.recordSlotHistory(base.Add(2*time.Second), []llamacpp.Slot{{
		ID:                2,
		TaskID:            88,
		IsProcessing:      true,
		State:             "prompt-processing",
		PromptCacheTokens: 20,
	}}, "model-a")

	slotIDs, taskIDs, promptCacheTokens := dashboard.inferRequestSlots(base, base.Add(1200*time.Millisecond))
	if len(slotIDs) != 1 || slotIDs[0] != 1 {
		t.Fatalf("slot ids = %#v", slotIDs)
	}
	if len(taskIDs) != 1 || taskIDs[0] != 77 {
		t.Fatalf("task ids = %#v", taskIDs)
	}
	if promptCacheTokens != 42 {
		t.Fatalf("prompt cache tokens = %d", promptCacheTokens)
	}
}

func TestEvaluateSuggestionsFromBackendData(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	dashboard.started = time.Unix(1_700_000_000, 0)
	now := dashboard.started.Add(guidanceWarmup + time.Second)

	suggestions := dashboard.evaluateSuggestions(now, "single", Overview{
		TotalSlots:         1,
		RequestsDeferred:   6,
		RequestsProcessing: 1,
	}, llamacpp.PropsSummary{}, llamacpp.MetricsSummary{},
		[]llamacpp.Slot{{ID: 0, State: "generating", IsProcessing: true}},
		SnapshotHistory{},
		nil,
		nil)
	if len(suggestions) != 0 {
		t.Fatalf("sustained suggestions should not trigger immediately: %#v", suggestions)
	}

	suggestions = dashboard.evaluateSuggestions(now.Add(31*time.Second), "single", Overview{
		TotalSlots:         1,
		RequestsDeferred:   6,
		RequestsProcessing: 1,
	}, llamacpp.PropsSummary{}, llamacpp.MetricsSummary{},
		[]llamacpp.Slot{{ID: 0, State: "generating", IsProcessing: true}},
		SnapshotHistory{},
		nil,
		nil)
	if !hasSuggestion(suggestions, "slots_saturated") {
		t.Fatalf("missing slots_saturated suggestion: %#v", suggestions)
	}
	if !hasSuggestion(suggestions, "deferred") {
		t.Fatalf("missing deferred suggestion: %#v", suggestions)
	}
}

func hasSuggestion(suggestions []Suggestion, id string) bool {
	for _, suggestion := range suggestions {
		if suggestion.ID == id {
			return true
		}
	}
	return false
}
