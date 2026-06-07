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
