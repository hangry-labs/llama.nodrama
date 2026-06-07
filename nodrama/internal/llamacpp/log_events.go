package llamacpp

import (
	"regexp"
	"strconv"
	"strings"
	"time"
)

type LogEvent struct {
	ID              string    `json:"id,omitempty"`
	At              time.Time `json:"at"`
	TimestampRaw    string    `json:"timestamp,omitempty"`
	Kind            string    `json:"kind"`
	Severity        string    `json:"severity,omitempty"`
	SlotID          int       `json:"slotId,omitempty"`
	TaskID          int       `json:"taskId,omitempty"`
	DecodedTokens   int       `json:"decodedTokens,omitempty"`
	TokensPerSecond float64   `json:"tokensPerSecond,omitempty"`
	CacheAction     string    `json:"cacheAction,omitempty"`
	Message         string    `json:"message"`
	Raw             string    `json:"raw,omitempty"`
}

var (
	logTimingPattern = regexp.MustCompile(`slot print_timing:\s*id\s+(\d+)\s*\|\s*task\s+(\d+)\s*\|\s*n_decoded\s*=\s*(\d+),\s*tg\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*t/s`)
	logSlotPattern   = regexp.MustCompile(`\bslot\b[^\d]*(\d+)`)
	logTaskPattern   = regexp.MustCompile(`\btask\b[^\d-]*(-?\d+)`)
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

	if matches := logTimingPattern.FindStringSubmatch(message); len(matches) == 5 {
		event.Kind = "timing"
		event.SlotID = mustAtoi(matches[1])
		event.TaskID = mustAtoi(matches[2])
		event.DecodedTokens = mustAtoi(matches[3])
		event.TokensPerSecond = mustParseFloat(matches[4])
		return event, true
	}

	if strings.Contains(lower, "cache") || strings.Contains(lower, "kv self") || strings.Contains(lower, "kv cache") {
		event.Kind = "cache"
		event.CacheAction = classifyCacheAction(lower)
		event.SlotID = firstRegexInt(logSlotPattern, message)
		event.TaskID = firstRegexInt(logTaskPattern, message)
		return event, true
	}

	if severity == "W" || severity == "E" || severity == "F" {
		event.Kind = "warning"
		if severity == "E" || severity == "F" {
			event.Kind = "error"
		}
		event.SlotID = firstRegexInt(logSlotPattern, message)
		event.TaskID = firstRegexInt(logTaskPattern, message)
		return event, true
	}

	return LogEvent{}, false
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
