package app

import (
	"testing"
	"time"
)

func TestHistoryGapSurvivesThinningWithoutChangingSource(t *testing.T) {
	points := []HistoryPoint{{T: 1000, V: 0}, {T: 2000, V: 9}, {T: 3000, V: 0}, {T: 20000, V: 1}, {T: 21000, V: 8}, {T: 22000, V: 0}}
	marked := historyCollectionGaps(points, time.Second)
	for _, limit := range []int{3, 20} {
		sampled := sampleHistoryWithGaps(marked, limit)
		gaps := 0
		for _, point := range sampled {
			if point.GapBefore {
				gaps++
			}
		}
		if gaps != 1 {
			t.Fatalf("limit %d: lost collection break: %#v", limit, sampled)
		}
	}
	if !marked[3].GapBefore || points[3].GapBefore {
		t.Fatal("sampling modified source history")
	}
}

func TestHistoryKeepsOlderWindowWhenRecentSamplesExceedBudget(t *testing.T) {
	dashboard := NewDashboard(nil, Config{PollInterval: 250 * time.Millisecond}, BuildInfo{})
	dashboard.metricLong["test"] = []HistoryPoint{{T: 1000, V: 0}, {T: 6000, V: 9}, {T: 11000, V: 0}}
	for i := 0; i < 100; i++ {
		dashboard.metricRecent["test"] = append(dashboard.metricRecent["test"], HistoryPoint{T: 12000 + int64(i)*250, V: 0})
	}
	points := dashboard.MetricHistory("test", time.UnixMilli(0), 10)
	if len(points) > 10 || len(points) < 2 || points[0].T >= 12000 {
		t.Fatalf("older history squeezed out: %#v", points)
	}
	for _, point := range points {
		if point.GapBefore {
			t.Fatalf("continuous history treated as gap: %#v", point)
		}
	}
}
