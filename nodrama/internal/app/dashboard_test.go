package app

import (
	"math"
	"testing"
	"time"
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

func TestRequestTracking(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})

	id := dashboard.StartRequest("/api/chat/completions", "model-a", true)
	dashboard.FinishRequest(id, 200, 1234, "")

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
