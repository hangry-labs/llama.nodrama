package app

import (
	"math"
	"time"
)

const serverUptimeMetric = "nodrama:server_uptime_seconds"

func (m *Dashboard) recordServerUptimeSampleLocked(observedAt time.Time, uptime time.Duration, source string) {
	if observedAt.IsZero() || uptime < 0 {
		return
	}
	m.serverUptimeDuration = uptime
	m.serverUptimeObservedAt = observedAt
	m.serverUptimeSource = source
}

func (m *Dashboard) serverUptimeEstimate(now time.Time, metrics map[string]float64, online bool) (float64, *time.Time, string, bool) {
	if !online {
		return 0, nil, "", false
	}
	if startedAt, ok := metricProcessStartTime(metrics); ok {
		uptime := now.Sub(startedAt)
		if uptime >= 0 {
			return uptime.Seconds(), timePtr(startedAt), "metrics", true
		}
	}

	m.historyMu.Lock()
	uptime := m.serverUptimeDuration
	observedAt := m.serverUptimeObservedAt
	source := m.serverUptimeSource
	m.historyMu.Unlock()

	if observedAt.IsZero() || uptime < 0 {
		return 0, nil, "", false
	}
	elapsed := now.Sub(observedAt)
	if elapsed < 0 {
		elapsed = 0
	}
	uptime += elapsed
	return uptime.Seconds(), timePtr(now.Add(-uptime)), source, true
}

func metricProcessStartTime(metrics map[string]float64) (time.Time, bool) {
	for _, key := range []string{
		"process_start_time_seconds",
		"llamacpp:process_start_time_seconds",
		"llamacpp:server_start_time_seconds",
		"server_start_time_seconds",
	} {
		value, ok := metrics[key]
		if !ok || value <= 0 || math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		seconds, fraction := math.Modf(value)
		return time.Unix(int64(seconds), int64(fraction*1e9)), true
	}
	return time.Time{}, false
}
