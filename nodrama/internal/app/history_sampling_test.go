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

func TestLongGaugeHistoryKeepsConsistentCadenceAndLatestValue(t *testing.T) {
	dashboard := NewDashboard(nil, Config{PollInterval: 250 * time.Millisecond}, BuildInfo{})
	base := time.Unix(1_700_000_000, 0)
	const metric = "nodrama:container_cpu_percent"
	for i := 0; i <= 2401; i++ {
		value := 0.2
		if i%20 == 0 {
			value = 20
		}
		if i == 2300 {
			value = 72
		}
		dashboard.recordMetricHistory(base.Add(time.Duration(i)*250*time.Millisecond), map[string]float64{metric: value})
	}
	points := dashboard.MetricHistory(metric, base.Add(-time.Second), 2000)
	if len(points) > 125 || len(points) < 110 {
		t.Fatalf("mixed sampling density remains: %d points", len(points))
	}
	peak, _ := peakHistoryPoint(points)
	if peak.V != 72 || points[len(points)-1].V != 0.2 || points[len(points)-1].T != base.Add(2401*250*time.Millisecond).UnixMilli() {
		t.Fatalf("lost peak or current value: peak=%#v last=%#v", peak, points[len(points)-1])
	}
	// A short view still gets full-resolution samples.
	short := dashboard.MetricHistory(metric, base.Add(9*time.Minute), 2000)
	if len(short) < 200 {
		t.Fatalf("short view lost raw detail: %d", len(short))
	}
}

func TestPeakBucketsPreserveCollectionBreaks(t *testing.T) {
	points := []HistoryPoint{{T: 0, V: 3}, {T: 250, V: 9}, {T: 500, V: 0}, {T: 3000, V: 2, GapBefore: true}, {T: 3250, V: 0}}
	got := peakHistoryBuckets(points, 5*time.Second)
	if len(got) != 3 || got[0].V != 9 || !got[1].GapBefore || got[2].GapBefore || got[2].V != 0 {
		t.Fatalf("peak/gap/latest not preserved: %#v", got)
	}
}

func TestHistoryThinningRetainsRangeEndpoints(t *testing.T) {
	points := []HistoryPoint{{T: 0, V: 0}, {T: 1, V: 100}, {T: 2, V: 0}, {T: 3, V: 80}, {T: 4, V: 0}}
	got := sampleHistoryWithGaps(points, 3)
	if len(got) != 3 || got[0].T != 0 || got[1].V != 100 || got[2].T != 4 || got[2].V != 0 {
		t.Fatalf("thinning replaced an endpoint: %#v", got)
	}
}

func TestUptimeIsCurrentOnly(t *testing.T) {
	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	history := dashboard.recordMetricHistory(time.Now(), map[string]float64{serverUptimeMetric: 123, "other": 1})
	if len(history.Metrics[serverUptimeMetric]) != 0 || len(dashboard.MetricHistory(serverUptimeMetric, time.Time{}, 2000)) != 0 {
		t.Fatal("uptime history is still collected")
	}
	if _, ok := dashboard.copyMetricFacts()[serverUptimeMetric]; ok {
		t.Fatal("uptime peaks are still collected")
	}
	if len(history.Metrics["other"]) != 1 {
		t.Fatal("other history was affected")
	}
}
