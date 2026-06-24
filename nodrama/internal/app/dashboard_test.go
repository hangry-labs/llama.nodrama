package app

import (
	"math"
	"strings"
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
	if fact.Peak5mValue != 120 {
		t.Fatalf("5m peak = %v", fact.Peak5mValue)
	}
	if fact.Peak5mAt == nil || !fact.Peak5mAt.Equal(base.Add(2*time.Second)) {
		t.Fatalf("5m peak at = %v", fact.Peak5mAt)
	}
}

func TestMetricHistoryUsesLongHistoryAndLimitsPoints(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)

	for i := 0; i < 30; i++ {
		dashboard.recordMetricHistory(base.Add(time.Duration(i)*metricLongInterval), map[string]float64{
			"metric": float64(i),
		})
	}

	points := dashboard.MetricHistory("metric", base.Add(-time.Hour), 5)
	if len(points) != 5 {
		t.Fatalf("limited points = %d", len(points))
	}
	if points[len(points)-1].V != 29 {
		t.Fatalf("last point = %#v", points[len(points)-1])
	}
}

func TestActiveContextUsagePrefersDeploymentContextAndCountsActiveSlots(t *testing.T) {
	usage := activeContextUsage([]llamacpp.Slot{
		{ID: 0, IsProcessing: true, ContextTokens: 262144, ContextEstimateTokens: 100000},
		{ID: 1, IsProcessing: false, ContextTokens: 262144, ContextEstimateTokens: 90000},
		{ID: 2, IsProcessing: true, ContextTokens: 262144, ContextEstimateTokens: 50000},
	}, llamacpp.PropsSummary{ContextTokens: 262144}, []llamacpp.LogEvent{
		{CacheLimitTokens: 358400},
		{DeploymentCtx: 307200},
	}, 0)

	if usage.UsedTokens != 150000 {
		t.Fatalf("used tokens = %d", usage.UsedTokens)
	}
	if usage.CapacityTokens != 307200 {
		t.Fatalf("capacity = %d", usage.CapacityTokens)
	}
	if usage.Source != "deployment context" {
		t.Fatalf("source = %q", usage.Source)
	}
	if math.Abs(usage.Ratio-(150000.0/307200.0)) > 0.000001 {
		t.Fatalf("ratio = %v", usage.Ratio)
	}
}

func TestActiveContextUsageFallsBackToProcessArgs(t *testing.T) {
	usage := activeContextUsage([]llamacpp.Slot{
		{ID: 0, IsProcessing: true, ContextTokens: 262144, ContextEstimateTokens: 100000},
	}, llamacpp.PropsSummary{ContextTokens: 262144}, nil, 307200)

	if usage.UsedTokens != 100000 || usage.CapacityTokens != 307200 {
		t.Fatalf("usage = %#v", usage)
	}
	if usage.Source != "process args" {
		t.Fatalf("source = %q", usage.Source)
	}
}

func TestActiveContextUsageFallsBackToCacheLimit(t *testing.T) {
	usage := activeContextUsage([]llamacpp.Slot{
		{ID: 0, IsProcessing: true, ContextTokens: 262144, ContextEstimateTokens: 100000},
		{ID: 1, IsProcessing: true, ContextTokens: 262144, ContextEstimateTokens: 50000},
	}, llamacpp.PropsSummary{}, []llamacpp.LogEvent{{
		CacheLimitTokens: 358400,
	}}, 0)

	if usage.UsedTokens != 150000 || usage.CapacityTokens != 358400 {
		t.Fatalf("usage = %#v", usage)
	}
	if usage.Source != "shared cache limit" {
		t.Fatalf("source = %q", usage.Source)
	}
}

func TestActiveContextUsageFallsBackToPropsContext(t *testing.T) {
	usage := activeContextUsage([]llamacpp.Slot{
		{ID: 0, IsProcessing: true, ContextTokens: 262144, ContextEstimateTokens: 100000},
	}, llamacpp.PropsSummary{ContextTokens: 262144}, nil, 0)

	if usage.UsedTokens != 100000 || usage.CapacityTokens != 262144 {
		t.Fatalf("usage = %#v", usage)
	}
	if usage.Source != "props context fallback" {
		t.Fatalf("source = %q", usage.Source)
	}
}

func TestActiveContextUsageFallsBackToSlotCapacity(t *testing.T) {
	usage := activeContextUsage([]llamacpp.Slot{
		{ID: 0, IsProcessing: true, ContextTokens: 100, ContextEstimateTokens: 40},
		{ID: 1, IsProcessing: true, ContextTokens: 100, ContextEstimateTokens: 50},
	}, llamacpp.PropsSummary{}, nil, 0)

	if usage.UsedTokens != 90 || usage.CapacityTokens != 100 {
		t.Fatalf("usage = %#v", usage)
	}
	if usage.Source != "slot capacity fallback" {
		t.Fatalf("source = %q", usage.Source)
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
		Online:             true,
		TotalSlots:         1,
		RequestsDeferred:   6,
		RequestsProcessing: 1,
	}, llamacpp.PropsSummary{}, llamacpp.MetricsSummary{},
		[]llamacpp.Slot{{ID: 0, State: "generating", IsProcessing: true}},
		SnapshotHistory{},
		nil,
		nil,
		nil,
		nil,
		"")
	if len(suggestions) != 0 {
		t.Fatalf("sustained suggestions should not trigger immediately: %#v", suggestions)
	}

	suggestions = dashboard.evaluateSuggestions(now.Add(31*time.Second), "single", Overview{
		Online:             true,
		TotalSlots:         1,
		RequestsDeferred:   6,
		RequestsProcessing: 1,
	}, llamacpp.PropsSummary{}, llamacpp.MetricsSummary{},
		[]llamacpp.Slot{{ID: 0, State: "generating", IsProcessing: true}},
		SnapshotHistory{},
		nil,
		nil,
		nil,
		nil,
		"")
	if !hasSuggestion(suggestions, "slots_saturated") {
		t.Fatalf("missing slots_saturated suggestion: %#v", suggestions)
	}
	if !hasSuggestion(suggestions, "deferred") {
		t.Fatalf("missing deferred suggestion: %#v", suggestions)
	}
}

func TestEvaluateSuggestionsReportsOfflineWithLogClue(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	now := time.Unix(1_700_000_000, 0)

	suggestions := dashboard.evaluateSuggestions(now, "single", Overview{Online: false},
		llamacpp.PropsSummary{}, llamacpp.MetricsSummary{}, nil, SnapshotHistory{}, nil, nil,
		map[string]string{"health": "connect: connection refused"},
		[]llamacpp.LogEvent{{
			Kind:     "error",
			Severity: "E",
			Message:  "srv init: failed to allocate KV cache",
		}},
		"/tmp/llama-server.log")

	if len(suggestions) != 1 {
		t.Fatalf("suggestions = %#v", suggestions)
	}
	if suggestions[0].ID != "llama_cpp_offline" || suggestions[0].Severity != "bad" {
		t.Fatalf("offline suggestion = %#v", suggestions[0])
	}
	if !strings.Contains(suggestions[0].Explain, "connection refused") {
		t.Fatalf("missing endpoint error: %q", suggestions[0].Explain)
	}
	if !strings.Contains(suggestions[0].Explain, "failed to allocate KV cache") {
		t.Fatalf("missing log clue: %q", suggestions[0].Explain)
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
