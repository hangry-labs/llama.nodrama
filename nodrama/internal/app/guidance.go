package app

import (
	"fmt"
	"math"
	"sort"
	"time"

	"llama.nodrama/nodrama/internal/llamacpp"
)

const guidanceWarmup = 10 * time.Second

func (m *Dashboard) evaluateSuggestions(now time.Time, mode string, overview Overview, props llamacpp.PropsSummary, metrics llamacpp.MetricsSummary, slots []llamacpp.Slot, history SnapshotHistory, routerModels []map[string]any, loraAdapters []map[string]any, lastErrors map[string]string, events []llamacpp.LogEvent, logPath string) []Suggestion {
	if offline := serverOfflineSuggestion(overview, lastErrors, events, logPath); offline != nil {
		return []Suggestion{*offline}
	}
	if now.Sub(m.started) < guidanceWarmup {
		return []Suggestion{}
	}

	out := []Suggestion{}
	if suggestion := m.suggestSlotsSaturated(now, slots); suggestion != nil {
		out = append(out, *suggestion)
	}
	if suggestion := m.suggestDeferred(now, overview); suggestion != nil {
		out = append(out, *suggestion)
	}
	if suggestion := m.suggestSlowGeneration(now, metrics, history); suggestion != nil {
		out = append(out, *suggestion)
	}
	if props.IsSleeping {
		out = append(out, suggestion("sleeping", "info",
			"Model is sleeping",
			"The model has been unloaded after --sleep-idle-seconds of inactivity. The next request will reload it.",
			"If reload latency is unacceptable, raise --sleep-idle-seconds or remove the flag.",
			map[string]any{"value": "yes"}))
	}
	out = append(out, samplerSuggestions(slots)...)
	if suggestion := loraScaleSuggestion(loraAdapters); suggestion != nil {
		out = append(out, *suggestion)
	}
	if mode == "router" {
		if suggestion := failedModelSuggestion(routerModels); suggestion != nil {
			out = append(out, *suggestion)
		}
		if suggestion := m.loadingLongSuggestion(now, routerModels); suggestion != nil {
			out = append(out, *suggestion)
		}
	}

	sort.SliceStable(out, func(i, j int) bool {
		return severityRank(out[i].Severity) < severityRank(out[j].Severity)
	})
	return out
}

func serverOfflineSuggestion(overview Overview, lastErrors map[string]string, events []llamacpp.LogEvent, logPath string) *Suggestion {
	if overview.Online {
		return nil
	}

	explain := "No monitored llama.cpp endpoint is reachable, so the server process may be stopped, crashed, restarting, or listening on a different address."
	if endpoint, reason := mostUsefulEndpointError(lastErrors); reason != "" {
		explain += fmt.Sprintf(" Last endpoint error (%s): %s.", endpoint, reason)
	}
	if event := latestSevereLogEvent(events); event != nil {
		explain += " Latest severe log line: " + event.Message
	}

	suggest := "Check whether llama-server is still running and whether llama.nodrama points at the right --server URL."
	if logPath == "" {
		suggest += " Start llama.nodrama with --log <path-to-llama-server.log> so shutdown/error lines can be shown here."
	} else {
		suggest += " Open the log panel and inspect the newest error/fatal lines around the time it went offline."
	}

	return suggestionPtr("llama_cpp_offline", "bad",
		"llama.cpp is offline",
		explain,
		suggest,
		map[string]any{"value": "offline"})
}

func mostUsefulEndpointError(lastErrors map[string]string) (string, string) {
	for _, key := range []string{"health", "props", "slots", "metrics"} {
		if value := lastErrors[key]; value != "" {
			return key, value
		}
	}
	for key, value := range lastErrors {
		if value != "" {
			return key, value
		}
	}
	return "", ""
}

func latestSevereLogEvent(events []llamacpp.LogEvent) *llamacpp.LogEvent {
	for i := len(events) - 1; i >= 0; i-- {
		event := events[i]
		if event.Kind == "error" || event.Severity == "E" || event.Severity == "F" {
			return &event
		}
	}
	return nil
}

func (m *Dashboard) suggestSlotsSaturated(now time.Time, slots []llamacpp.Slot) *Suggestion {
	if len(slots) == 0 {
		m.sustained(now, "slots_saturated", false, 30*time.Second)
		return nil
	}
	busy := 0
	for _, slot := range slots {
		if slot.IsProcessing {
			busy++
		}
	}
	total := len(slots)
	if !m.sustained(now, "slots_saturated", float64(busy)/float64(total) >= 0.9, 30*time.Second) {
		return nil
	}
	return suggestionPtr("slots_saturated", "warn",
		"Slots saturated",
		"Almost every slot is currently processing a request. The server has no headroom; the next request will start queueing.",
		fmt.Sprintf("Raise --parallel from %d to %d, or reduce client concurrency.", total, total+1),
		map[string]any{"value": fmt.Sprintf("%d / %d", busy, total), "busy": busy, "total": total, "suggested": total + 1})
}

func (m *Dashboard) suggestDeferred(now time.Time, overview Overview) *Suggestion {
	deferred := overview.RequestsDeferred
	if !m.sustained(now, "deferred", deferred > 0, 5*time.Second) {
		return nil
	}
	total := overview.TotalSlots
	suggested := total + 1
	severity := "warn"
	if deferred >= 5 {
		severity = "bad"
	}
	return suggestionPtr("deferred", severity,
		"Requests waiting in queue",
		"requests_deferred is the queue of requests waiting for a free slot. Sustained values above zero mean clients are facing queue latency.",
		fmt.Sprintf("Raise --parallel to %d, or lower client concurrency.", suggested),
		map[string]any{"value": fmt.Sprintf("%.0f", deferred), "deferred": deferred, "total": total, "suggested": suggested})
}

func (m *Dashboard) suggestSlowGeneration(now time.Time, metrics llamacpp.MetricsSummary, history SnapshotHistory) *Suggestion {
	tps := metrics.GenerationTokensLivePerSec
	if metrics.RequestsProcessing < 1 || tps <= 0 {
		m.sustained(now, "idle_slow", false, 10*time.Second)
		return nil
	}
	points := history.Metrics["nodrama:tokens_predicted_rate"]
	if len(points) < 20 {
		m.sustained(now, "idle_slow", false, 10*time.Second)
		return nil
	}
	values := make([]float64, 0, len(points))
	for _, point := range points {
		if point.V > 0 && !math.IsNaN(point.V) && !math.IsInf(point.V, 0) {
			values = append(values, point.V)
		}
	}
	if len(values) < 10 {
		m.sustained(now, "idle_slow", false, 10*time.Second)
		return nil
	}
	sort.Float64s(values)
	median := values[len(values)/2]
	if !m.sustained(now, "idle_slow", tps < median*0.5, 10*time.Second) {
		return nil
	}
	return suggestionPtr("idle_slow", "warn",
		"Generation throughput dropped sharply",
		fmt.Sprintf("Live aggregate generation is currently %.1f tok/s, less than half of the recent median %.1f tok/s.", tps, median),
		"If the model spilled to CPU, raise --n-gpu-layers until VRAM is the limit. Otherwise check for another process competing for the GPU.",
		map[string]any{"value": fmt.Sprintf("%.1f / %.1f tok/s", tps, median), "current": fmt.Sprintf("%.1f", tps), "baseline": fmt.Sprintf("%.1f", median)})
}

func samplerSuggestions(slots []llamacpp.Slot) []Suggestion {
	out := []Suggestion{}
	seen := map[string]bool{}
	add := func(s Suggestion) {
		if seen[s.ID] {
			return
		}
		seen[s.ID] = true
		out = append(out, s)
	}
	for _, slot := range slots {
		if !slot.IsProcessing {
			continue
		}
		params := slot.Params
		if temp, ok := numberParamOK(params, "temperature"); ok && temp == 0 {
			add(suggestion("greedy_sampling", "info",
				"Greedy sampling",
				"temperature = 0 selects the most-likely token every step. This is deterministic and useful for tests, but monotonous for chat.",
				"If you want diversity, try temperature around 0.7.",
				map[string]any{"value": fmt.Sprintf("slot %d", slot.ID)}))
		} else if ok && temp > 1.5 {
			add(suggestion("temp_high", "warn",
				"Temperature is very high",
				"temperature > 1.5 flattens the distribution heavily, so output may become incoherent.",
				"Most chat models work best with temperature <= 1.0.",
				map[string]any{"value": fmt.Sprintf("slot %d - %.2f", slot.ID, temp)}))
		}
		if repeat, ok := numberParamOK(params, "repeat_penalty"); ok && repeat > 1.3 {
			add(suggestion("repeat_high", "warn",
				"Repeat penalty is aggressive",
				"repeat_penalty > 1.3 strongly discourages reusing tokens, which can break code, JSON, or structured formats.",
				"Try 1.05-1.15.",
				map[string]any{"value": fmt.Sprintf("slot %d - %.2f", slot.ID, repeat)}))
		}
		if mirostat, ok := numberParamOK(params, "mirostat"); ok && mirostat != 0 {
			add(suggestion("mirostat", "info",
				"Mirostat sampler active",
				"When mirostat is enabled, top_p and top_k are ignored; output entropy is targeted directly via mirostat_tau.",
				"Tune mirostat_tau instead of top_p or top_k.",
				map[string]any{"value": fmt.Sprintf("slot %d", slot.ID)}))
		}
		if dry, ok := numberParamOK(params, "dry_multiplier"); ok && dry > 0 {
			add(suggestion("dry", "info",
				"DRY anti-repetition active",
				"DRY detects sequence repeats and damps them. It is usually preferred over repeat_penalty for chat.",
				"Typical values are dry_multiplier 0.8, dry_base 1.75, dry_allowed_length 2.",
				map[string]any{"value": fmt.Sprintf("slot %d", slot.ID)}))
		}
	}
	return out
}

func loraScaleSuggestion(adapters []map[string]any) *Suggestion {
	for _, adapter := range adapters {
		scale := numberParam(adapter, "scale")
		if scale <= 1 {
			continue
		}
		return suggestionPtr("lora_scale", "warn",
			"Unusual LoRA scale",
			"LoRA scale > 1 amplifies the adapter beyond its trained range, often producing artifacts.",
			"Stay between 0 and 1 unless you know what you are doing.",
			map[string]any{"value": fmt.Sprintf("id %v - %.2f", adapter["id"], scale)})
	}
	return nil
}

func failedModelSuggestion(models []map[string]any) *Suggestion {
	for _, model := range models {
		status, _ := model["status"].(map[string]any)
		if stringParam(status, "value") != "failed" {
			continue
		}
		id := stringParam(model, "id")
		exitCode := numberParam(status, "exit_code")
		value := id
		if exitCode != 0 {
			value = fmt.Sprintf("%s (exit %.0f)", id, exitCode)
		}
		return suggestionPtr("failed_model", "bad",
			"Model failed to launch",
			"The router tried to start this model and the process exited with a failure code.",
			"Check exit_code and the model's args; common causes are bad path, insufficient VRAM, or invalid quantization.",
			map[string]any{"value": value})
	}
	return nil
}

func (m *Dashboard) loadingLongSuggestion(now time.Time, models []map[string]any) *Suggestion {
	var loading map[string]any
	for _, model := range models {
		status, _ := model["status"].(map[string]any)
		if stringParam(status, "value") == "loading" {
			loading = model
			break
		}
	}
	if !m.sustained(now, "loading_long", loading != nil, time.Minute) {
		return nil
	}
	return suggestionPtr("loading_long", "warn",
		"Model has been loading for a while",
		"Loading for more than 60 seconds usually means slow disk I/O, swapping, or VRAM pressure forcing partial offload.",
		"Check disk speed and free GPU memory; consider a smaller quantization.",
		map[string]any{"value": stringParam(loading, "id")})
}

func (m *Dashboard) sustained(now time.Time, id string, condition bool, duration time.Duration) bool {
	if m.sustainedSince == nil {
		m.sustainedSince = map[string]time.Time{}
	}
	if !condition {
		delete(m.sustainedSince, id)
		return false
	}
	started, ok := m.sustainedSince[id]
	if !ok {
		m.sustainedSince[id] = now
		return false
	}
	return now.Sub(started) >= duration
}

func suggestion(id, severity, title, explain, suggest string, context map[string]any) Suggestion {
	return Suggestion{ID: id, Severity: severity, Title: title, Explain: explain, Suggest: suggest, Context: context}
}

func suggestionPtr(id, severity, title, explain, suggest string, context map[string]any) *Suggestion {
	item := suggestion(id, severity, title, explain, suggest, context)
	return &item
}

func severityRank(severity string) int {
	switch severity {
	case "bad":
		return 0
	case "warn":
		return 1
	case "info":
		return 2
	default:
		return 9
	}
}

func numberParam(values map[string]any, key string) float64 {
	value, _ := numberParamOK(values, key)
	return value
}

func numberParamOK(values map[string]any, key string) (float64, bool) {
	if values == nil {
		return 0, false
	}
	switch value := values[key].(type) {
	case float64:
		return value, true
	case float32:
		return float64(value), true
	case int:
		return float64(value), true
	case int64:
		return float64(value), true
	case jsonNumber:
		n, _ := value.Float64()
		return n, true
	default:
		return 0, false
	}
}

func stringParam(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	value, _ := values[key].(string)
	return value
}

type jsonNumber interface {
	Float64() (float64, error)
}
