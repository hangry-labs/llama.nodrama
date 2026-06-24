package llamacpp

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

type LogEvent struct {
	ID               string    `json:"id,omitempty"`
	At               time.Time `json:"at"`
	TimestampRaw     string    `json:"timestamp,omitempty"`
	Kind             string    `json:"kind"`
	Severity         string    `json:"severity,omitempty"`
	SlotID           int       `json:"slotId,omitempty"`
	TaskID           int       `json:"taskId,omitempty"`
	CacheKey         string    `json:"cacheKey,omitempty"`
	DeploymentCtx    int       `json:"deploymentCtx,omitempty"`
	PromptTokens     int       `json:"promptTokens,omitempty"`
	RestoredTokens   int       `json:"restoredTokens,omitempty"`
	CachePrompts     int       `json:"cachePrompts,omitempty"`
	CacheUsedMiB     float64   `json:"cacheUsedMiB,omitempty"`
	CacheLimitMiB    float64   `json:"cacheLimitMiB,omitempty"`
	CacheLimitTokens int       `json:"cacheLimitTokens,omitempty"`
	CacheEstTokens   int       `json:"cacheEstTokens,omitempty"`
	CacheCheckpoints int       `json:"cacheCheckpoints,omitempty"`
	CacheSizeMiB     float64   `json:"cacheSizeMiB,omitempty"`
	DecodedTokens    int       `json:"decodedTokens,omitempty"`
	TokensPerSecond  float64   `json:"tokensPerSecond,omitempty"`
	CacheAction      string    `json:"cacheAction,omitempty"`
	Message          string    `json:"message"`
	Raw              string    `json:"raw,omitempty"`
}

var (
	logLaunchPattern     = regexp.MustCompile(`slot launch_slot_:\s*id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|`)
	logTimingPattern     = regexp.MustCompile(`slot print_timing:\s*id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*n_decoded\s*=\s*(\d+),\s*tg\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*t/s`)
	logPromptEvalPattern = regexp.MustCompile(`slot print_timing:\s*id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*prompt eval time\s*=.*?/\s*(\d+)\s+tokens`)
	logPromptKeyPattern  = regexp.MustCompile(`-\s*prompt\s+(0x[0-9A-Fa-f]+):\s*(\d+)\s+tokens(?:,\s*checkpoints:\s*(\d+),\s*([0-9]+(?:\.[0-9]+)?)\s+MiB)?`)
	logCtxSeqPattern     = regexp.MustCompile(`\bn_ctx_seq\s*\(\s*(\d+)\s*\)`)
	logSlotCtxPattern    = regexp.MustCompile(`\bslot context\s*\(\s*(\d+)\s*\)`)
	logRestoredPattern   = regexp.MustCompile(`restored context checkpoint .*?\bn_tokens\s*=\s*(\d+)`)
	logCacheStatePattern = regexp.MustCompile(`cache state:\s*(\d+)\s+prompts,\s*([0-9]+(?:\.[0-9]+)?)\s+MiB\s*\(limits:\s*([0-9]+(?:\.[0-9]+)?)\s+MiB,\s*(\d+)\s+tokens,\s*(\d+)\s+est\)`)
	logSlotPattern       = regexp.MustCompile(`\bslot\b[^\d]*(\d+)`)
	logTaskPattern       = regexp.MustCompile(`\btask\b[^\d-]*(-?\d+)`)
)

func ParseLogLine(line string, observedAt time.Time) (LogEvent, bool) {
	line = strings.TrimSpace(line)
	if line == "" {
		return LogEvent{}, false
	}

	timestampRaw, severity, message := splitLogPrefix(line)
	lower := strings.ToLower(message)
	event := LogEvent{
		At:           observedAt,
		TimestampRaw: timestampRaw,
		Severity:     severity,
		Message:      message,
		Raw:          line,
	}

	if contextTokens := deploymentContextTokens(message); contextTokens > 0 {
		event.Kind = "config"
		event.DeploymentCtx = contextTokens
		return event, true
	}

	if matches := logPromptKeyPattern.FindStringSubmatch(message); len(matches) >= 3 {
		event.Kind = "cache"
		event.CacheAction = "observe"
		event.CacheKey = matches[1]
		event.PromptTokens = mustAtoi(matches[2])
		if len(matches) >= 5 {
			event.CacheCheckpoints = mustAtoi(matches[3])
			event.CacheSizeMiB = mustParseFloat(matches[4])
		}
		return event, true
	}

	if matches := logLaunchPattern.FindStringSubmatch(message); len(matches) == 3 {
		event.Kind = "launch"
		event.SlotID = mustAtoi(matches[1])
		event.TaskID = mustAtoi(matches[2])
		return event, true
	}

	if matches := logTimingPattern.FindStringSubmatch(message); len(matches) == 5 {
		event.Kind = "timing"
		event.SlotID = mustAtoi(matches[1])
		event.TaskID = mustAtoi(matches[2])
		event.DecodedTokens = mustAtoi(matches[3])
		event.TokensPerSecond = mustParseFloat(matches[4])
		return event, true
	}

	if matches := logPromptEvalPattern.FindStringSubmatch(message); len(matches) == 4 {
		event.Kind = "prompt_eval"
		event.SlotID = mustAtoi(matches[1])
		event.TaskID = mustAtoi(matches[2])
		event.PromptTokens = mustAtoi(matches[3])
		return event, true
	}

	if strings.Contains(lower, "cache") || strings.Contains(lower, "kv self") || strings.Contains(lower, "kv cache") {
		event.Kind = "cache"
		event.CacheAction = classifyCacheAction(lower)
		event.SlotID = firstRegexInt(logSlotPattern, message)
		event.TaskID = firstRegexInt(logTaskPattern, message)
		event.RestoredTokens = restoredTokens(message)
		event.CachePrompts, event.CacheUsedMiB, event.CacheLimitMiB, event.CacheLimitTokens, event.CacheEstTokens = cacheState(message)
		return event, true
	}

	if severity == "W" || severity == "E" || severity == "F" {
		event.Kind = "warning"
		if severity == "E" || severity == "F" {
			event.Kind = "error"
		}
		event.SlotID = firstRegexInt(logSlotPattern, message)
		event.TaskID = firstRegexInt(logTaskPattern, message)
		event.RestoredTokens = restoredTokens(message)
		return event, true
	}

	return LogEvent{}, false
}

func cacheState(message string) (int, float64, float64, int, int) {
	matches := logCacheStatePattern.FindStringSubmatch(message)
	if len(matches) < 6 {
		return 0, 0, 0, 0, 0
	}
	return mustAtoi(matches[1]), mustParseFloat(matches[2]), mustParseFloat(matches[3]), mustAtoi(matches[4]), mustAtoi(matches[5])
}

func deploymentContextTokens(message string) int {
	for _, pattern := range []*regexp.Regexp{logCtxSeqPattern, logSlotCtxPattern} {
		matches := pattern.FindStringSubmatch(message)
		if len(matches) >= 2 {
			return mustAtoi(matches[1])
		}
	}
	return 0
}

func restoredTokens(message string) int {
	matches := logRestoredPattern.FindStringSubmatch(message)
	if len(matches) < 2 {
		return 0
	}
	return mustAtoi(matches[1])
}

func splitLogPrefix(line string) (string, string, string) {
	fields := strings.Fields(line)
	if len(fields) < 2 {
		return "", "", line
	}
	if isSeverity(fields[1]) {
		return fields[0], fields[1], strings.TrimSpace(strings.TrimPrefix(line, fields[0]+" "+fields[1]))
	}
	if isSeverity(fields[0]) {
		return "", fields[0], strings.TrimSpace(strings.TrimPrefix(line, fields[0]))
	}
	return "", "", line
}

func isSeverity(value string) bool {
	switch value {
	case "I", "W", "E", "F":
		return true
	default:
		return false
	}
}

func classifyCacheAction(lower string) string {
	switch {
	case strings.Contains(lower, "evict"):
		return "evict"
	case strings.Contains(lower, "reuse"), strings.Contains(lower, "reused"):
		return "reuse"
	case strings.Contains(lower, "hit"):
		return "hit"
	case strings.Contains(lower, "load"), strings.Contains(lower, "loaded"):
		return "load"
	case strings.Contains(lower, "save"), strings.Contains(lower, "saved"):
		return "save"
	case strings.Contains(lower, "shift"):
		return "shift"
	case strings.Contains(lower, "remove"), strings.Contains(lower, "clear"):
		return "clear"
	default:
		return "observe"
	}
}

func firstRegexInt(pattern *regexp.Regexp, value string) int {
	matches := pattern.FindStringSubmatch(value)
	if len(matches) < 2 {
		return 0
	}
	parsed := mustAtoi(matches[1])
	if parsed < 0 {
		return 0
	}
	return parsed
}

func mustAtoi(value string) int {
	parsed, _ := strconv.Atoi(value)
	return parsed
}

func mustParseFloat(value string) float64 {
	parsed, _ := strconv.ParseFloat(value, 64)
	return parsed
}
