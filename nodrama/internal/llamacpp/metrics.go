package llamacpp

import (
	"math"
	"regexp"
	"strconv"
	"strings"
)

type MetricsSummary struct {
	RequestsProcessing         float64 `json:"requestsProcessing"`
	RequestsDeferred           float64 `json:"requestsDeferred"`
	PromptTokensPerSec         float64 `json:"promptTokensPerSec"`
	GenerationTokensPerSec     float64 `json:"generationTokensPerSec"`
	PromptTokensLivePerSec     float64 `json:"promptTokensLivePerSec"`
	GenerationTokensLivePerSec float64 `json:"generationTokensLivePerSec"`
	BusySlotsPerDecode         float64 `json:"busySlotsPerDecode"`
	PromptTokensTotal          float64 `json:"promptTokensTotal"`
	GeneratedTokensTotal       float64 `json:"generatedTokensTotal"`
	DecodeTotal                float64 `json:"decodeTotal"`
	TokensMax                  float64 `json:"tokensMax"`
}

var metricLine = regexp.MustCompile(`^([A-Za-z_:][\w:]*)(\{[^}]*\})?\s+(-?[\d.eE+\-]+|NaN|\+?Inf|-Inf)`)

func ParsePrometheus(text string) map[string]float64 {
	out := map[string]float64{}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		match := metricLine.FindStringSubmatch(line)
		if match == nil {
			continue
		}
		value, ok := parseMetricNumber(match[3])
		if !ok {
			continue
		}
		out[match[1]] = value
	}
	return out
}

func SummarizeMetrics(metrics map[string]float64) MetricsSummary {
	return MetricsSummary{
		RequestsProcessing:     finite(metrics["llamacpp:requests_processing"]),
		RequestsDeferred:       finite(metrics["llamacpp:requests_deferred"]),
		PromptTokensPerSec:     finite(metrics["llamacpp:prompt_tokens_seconds"]),
		GenerationTokensPerSec: finite(metrics["llamacpp:predicted_tokens_seconds"]),
		BusySlotsPerDecode:     finite(metrics["llamacpp:n_busy_slots_per_decode"]),
		PromptTokensTotal:      firstFinite(metrics, "llamacpp:prompt_tokens_total", "llamacpp:n_prompt_tokens_total"),
		GeneratedTokensTotal:   firstFinite(metrics, "llamacpp:tokens_predicted_total", "llamacpp:n_tokens_predicted_total"),
		DecodeTotal:            finite(metrics["llamacpp:n_decode_total"]),
		TokensMax:              finite(metrics["llamacpp:n_tokens_max"]),
	}
}

func parseMetricNumber(raw string) (float64, bool) {
	switch raw {
	case "NaN", "Inf", "+Inf", "-Inf":
		return 0, false
	default:
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, false
		}
		return value, true
	}
}

func firstFinite(metrics map[string]float64, keys ...string) float64 {
	for _, key := range keys {
		value, ok := metrics[key]
		if ok {
			return finite(value)
		}
	}
	return 0
}

func finite(value float64) float64 {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return 0
	}
	return value
}
