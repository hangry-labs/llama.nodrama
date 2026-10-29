package app

import (
	"sort"
	"time"
)

// CounterChange reports an observed increase, never an extrapolated total.
// Missing coverage, resets and gaps must not look like a quiet complete window.
type CounterChange struct {
	WindowSeconds int64    `json:"windowSeconds"`
	Delta         *float64 `json:"delta"`
	ObservedMS    int64    `json:"observedMs"`
	From          int64    `json:"from"`
	To            int64    `json:"to"`
	Status        string   `json:"status"`
	Current       float64  `json:"current"`
}

func isCounterMetric(name string) bool {
	switch name {
	case "llamacpp:prompt_tokens_total", "llamacpp:prompt_tokens_cached_total",
		"llamacpp:tokens_predicted_total", "llamacpp:n_decode_total",
		"llamacpp:prompt_seconds_total", "llamacpp:tokens_predicted_seconds_total":
		return true
	}
	return false
}

func trimCounterHistory(name string, points []HistoryPoint, cutoff int64) []HistoryPoint {
	if !isCounterMetric(name) {
		return trimHistoryPoints(points, cutoff)
	}
	index := sort.Search(len(points), func(i int) bool { return points[i].T >= cutoff })
	// Retain the boundary observation needed to measure the full five minutes.
	if index > 0 {
		index--
	}
	return points[index:]
}

func counterChange(points []HistoryPoint, window, maxGap time.Duration) CounterChange {
	change := CounterChange{WindowSeconds: int64(window / time.Second), Status: "collecting"}
	if len(points) == 0 {
		return change
	}
	change.To = points[len(points)-1].T
	change.Current = points[len(points)-1].V
	cutoff := change.To - window.Milliseconds()
	index := sort.Search(len(points), func(i int) bool { return points[i].T >= cutoff })
	if index > 0 && points[index].T != cutoff {
		index--
	}
	change.From = points[index].T
	change.ObservedMS = change.To - change.From
	if index == len(points)-1 {
		return change
	}
	change.Status = "complete"
	if change.From > cutoff {
		change.Status = "partial"
	}
	for i := index; i < len(points); i++ {
		point := points[i]
		if point.ResetAt > 0 && point.ResetAt > cutoff && point.ResetAt <= change.To || (i > index && point.V < points[i-1].V) {
			change.Status = "reset"
			return change
		}
		if i > index && point.T-points[i-1].T > maxGap.Milliseconds() {
			change.Status = "gap"
		}
	}
	if change.Status != "gap" {
		delta := points[len(points)-1].V - points[index].V
		change.Delta = &delta
	}
	return change
}

func (m *Dashboard) CounterHistoryChange(metric string, window time.Duration) *CounterChange {
	if !isCounterMetric(metric) {
		return nil
	}
	poll := m.runtimeConfig().PollInterval
	m.historyMu.Lock()
	defer m.historyMu.Unlock()
	change := counterChange(m.metricLong[metric], window, max(3*poll, 3*metricLongInterval))
	return &change
}
