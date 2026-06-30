package app

import (
	"fmt"
	"strings"
	"time"
)

func (m *Dashboard) ShortInfo() string {
	snapshot := m.Snapshot()
	overview := snapshot.Overview
	freeSlots := overview.TotalSlots - overview.BusySlots
	if freeSlots < 0 {
		freeSlots = 0
	}

	var b strings.Builder
	fmt.Fprintf(&b, "llama.nodrama shortInfo\n")
	fmt.Fprintf(&b, "status: %s\n", onlineLabel(overview.Online))
	fmt.Fprintf(&b, "server: %s\n", snapshot.Server)
	fmt.Fprintf(&b, "model: %s\n", emptyDash(overview.ModelAlias))
	fmt.Fprintf(&b, "updated: %s\n", snapshot.UpdatedAt.Format(time.RFC3339))
	if overview.ServerUptimeSeconds > 0 {
		fmt.Fprintf(&b, "server_uptime: %s", formatShortDuration(time.Duration(overview.ServerUptimeSeconds*float64(time.Second))))
		if overview.ServerStartedAt != nil {
			fmt.Fprintf(&b, " since=%s", overview.ServerStartedAt.Format(time.RFC3339))
		}
		if overview.ServerUptimeSource != "" {
			fmt.Fprintf(&b, " source=%s", overview.ServerUptimeSource)
		}
		fmt.Fprintf(&b, "\n")
	}
	fmt.Fprintf(&b, "slots: busy=%d free=%d total=%d\n", overview.BusySlots, freeSlots, overview.TotalSlots)
	fmt.Fprintf(&b, "queue: deferred=%.0f processing=%.0f\n", overview.RequestsDeferred, overview.RequestsProcessing)
	fmt.Fprintf(&b, "context_active: used=%d capacity=%d ratio=%.1f%% source=%s\n",
		overview.ContextUsedTokens,
		overview.ContextCapacityTokens,
		overview.ContextUsedRatio*100,
		emptyDash(overview.ContextCapacitySource),
	)
	fmt.Fprintf(&b, "throughput: generation=%.2f tok/s prompt=%.2f tok/s\n", overview.GenerationTokensPerSec, overview.PromptTokensPerSec)
	if fact, ok := snapshot.MetricFacts["nodrama:context_active_tokens"]; ok && fact.Peak5mAt != nil {
		fmt.Fprintf(&b, "context_peak_5m: used=%.0f at=%s\n", fact.Peak5mValue, fact.Peak5mAt.Format(time.RFC3339))
	}
	fmt.Fprintf(&b, "recommendation: %s\n", shortRecommendation(overview, freeSlots))
	writeQuerySummary(&b, snapshot.Queries)
	if len(snapshot.Warnings) > 0 {
		fmt.Fprintf(&b, "warnings: %s\n", strings.Join(snapshot.Warnings, " | "))
	}
	return b.String()
}

func writeQuerySummary(b *strings.Builder, queries []QuerySummary) {
	if len(queries) == 0 {
		fmt.Fprintf(b, "queries: none\n")
		return
	}
	running := 0
	queued := 0
	complete := 0
	errors := 0
	cached := 0
	for _, query := range queries {
		switch query.Status {
		case "running":
			running++
		case "queued":
			queued++
		case "complete":
			complete++
		case "error":
			errors++
		}
		if query.CacheCached {
			cached++
		}
	}
	fmt.Fprintf(b, "queries: running=%d queued=%d complete=%d error=%d cached=%d tracked=%d\n", running, queued, complete, errors, cached, len(queries))
}

func shortRecommendation(overview Overview, freeSlots int) string {
	if !overview.Online {
		return "server offline; do not send work"
	}
	if overview.RequestsDeferred > 0 {
		return "queue has deferred requests; wait before adding concurrent work"
	}
	if freeSlots <= 0 {
		return "no free slots; wait before adding concurrent work"
	}
	if overview.ContextUsedRatio >= 0.90 {
		return "free slot exists but active context is above 90%; use caution"
	}
	if overview.ContextUsedRatio >= 0.80 {
		return "free slot exists but active context is above 80%; prefer small requests"
	}
	return "free slot available; ok to send work"
}

func onlineLabel(online bool) string {
	if online {
		return "online"
	}
	return "offline"
}

func emptyDash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func formatShortDuration(value time.Duration) string {
	if value < 0 {
		value = 0
	}
	seconds := int64(value.Seconds())
	days := seconds / 86400
	seconds %= 86400
	hours := seconds / 3600
	seconds %= 3600
	minutes := seconds / 60
	seconds %= 60
	if days > 0 {
		return fmt.Sprintf("%dd %02dh %02dm", days, hours, minutes)
	}
	if hours > 0 {
		return fmt.Sprintf("%dh %02dm %02ds", hours, minutes, seconds)
	}
	if minutes > 0 {
		return fmt.Sprintf("%dm %02ds", minutes, seconds)
	}
	return fmt.Sprintf("%ds", seconds)
}
