package app

import (
	"testing"
	"time"
)

func TestCounterChangeWindowsAndCoverage(t *testing.T) {
	var points []HistoryPoint
	for second := int64(0); second <= 3600; second++ {
		points = append(points, HistoryPoint{T: second * 1000, V: float64(second * 2)})
	}
	for _, window := range []time.Duration{time.Minute, 5 * time.Minute, time.Hour} {
		got := counterChange(points, window, 3*time.Second)
		if got.Status != "complete" || got.Delta == nil || *got.Delta != window.Seconds()*2 || got.ObservedMS != window.Milliseconds() {
			t.Fatalf("%v: %+v", window, got)
		}
	}
	partial := counterChange(points[len(points)-30:], time.Minute, 3*time.Second)
	if partial.Status != "partial" || partial.Delta == nil || *partial.Delta != 58 || partial.ObservedMS != 29000 {
		t.Fatalf("partial: %+v", partial)
	}
	zero := counterChange([]HistoryPoint{{T: 1000, V: 5}, {T: 2000, V: 5}}, time.Minute, 3*time.Second)
	if zero.Delta == nil || *zero.Delta != 0 {
		t.Fatalf("quiet interval: %+v", zero)
	}
	for _, series := range [][]HistoryPoint{nil, {{T: 1000, V: 5}}} {
		got := counterChange(series, time.Minute, 3*time.Second)
		if got.Status != "collecting" || got.Delta != nil {
			t.Fatalf("no coverage: %+v", got)
		}
	}
}

func TestCounterChangeRejectsResetAndCollectionGap(t *testing.T) {
	for _, test := range []struct {
		name, status string
		points       []HistoryPoint
	}{
		{"drop", "reset", []HistoryPoint{{T: 1000, V: 100}, {T: 2000, V: 0}, {T: 3000, V: 150}}},
		{"retained reset marker", "reset", []HistoryPoint{{T: 1000, V: 5}, {T: 4000, V: 20, ResetAt: 2500}}},
		{"gap", "gap", []HistoryPoint{{T: 1000, V: 5}, {T: 20000, V: 20}}},
	} {
		t.Run(test.name, func(t *testing.T) {
			got := counterChange(test.points, time.Minute, 5*time.Second)
			if got.Status != test.status || got.Delta != nil {
				t.Fatalf("%+v", got)
			}
		})
	}
}

func TestCounterResetSurvivesLongHistoryCompaction(t *testing.T) {
	const metric = "llamacpp:tokens_predicted_total"
	dashboard := NewDashboard(nil, settingsDefaults(), BuildInfo{})
	// Two resets within five-second buckets must stay visible after values
	// catch up past their old totals, and after full-resolution history expires.
	for _, point := range []HistoryPoint{{T: 1000, V: 100}, {T: 2000, V: 0}, {T: 3000, V: 200}, {T: 5000, V: 1}, {T: 6000, V: 300}} {
		dashboard.recordMetricHistory(time.UnixMilli(point.T), map[string]float64{metric: point.V})
	}
	points := dashboard.metricLong[metric]
	if len(points) != 2 || points[0].ResetAt != 2000 || points[1].ResetAt != 5000 {
		t.Fatalf("reset markers lost: %+v", points)
	}
	got := dashboard.CounterHistoryChange(metric, time.Hour)
	if got.Status != "reset" || got.Delta != nil || got.Current != 300 {
		t.Fatalf("compacted summary: %+v", got)
	}
}

func TestCounterFactsKeepFiveMinuteBoundaryAndHourlyHistory(t *testing.T) {
	const metric = "llamacpp:prompt_tokens_total"
	dashboard := NewDashboard(nil, settingsDefaults(), BuildInfo{})
	for second := int64(0); second <= 3606; second++ {
		dashboard.recordMetricHistory(time.UnixMilli(second*1000), map[string]float64{metric: float64(second * 2)})
	}
	fact := dashboard.copyMetricFacts()[metric]
	if len(fact.Changes) != 3 {
		t.Fatalf("missing summaries: %+v", fact)
	}
	for _, change := range fact.Changes {
		if change.Status != "complete" || change.Delta == nil || *change.Delta != float64(change.ObservedMS)/1000*2 {
			t.Fatalf("bad interval: %+v", change)
		}
	}
	if len(dashboard.metricRecent[metric]) > 302 {
		t.Fatalf("recent counter history is not bounded: %d", len(dashboard.metricRecent[metric]))
	}
}
