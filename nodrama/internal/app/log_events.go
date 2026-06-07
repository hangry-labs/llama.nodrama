package app

import (
	"io"
	"os"
	"strconv"
	"strings"
	"time"

	"llama.nodrama/nodrama/internal/llamacpp"
)

const maxLogReadBytes = 1024 * 1024

func (m *Dashboard) pollLogEvents(now time.Time) ([]llamacpp.LogEvent, error) {
	if m.cfg.LogPath == "" {
		return nil, nil
	}

	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	lines, err := m.readNewLogLines()
	if err != nil {
		return m.copyLogEvents(), err
	}
	if len(lines) == 0 {
		return m.copyLogEvents(), nil
	}

	for _, line := range lines {
		event, ok := llamacpp.ParseLogLine(line, now)
		if !ok {
			continue
		}
		m.logEventSeq++
		event.ID = "evt_" + strconv.FormatUint(m.logEventSeq, 10)
		m.logEvents = append(m.logEvents, event)
		if len(m.logEvents) > maxLogEventHistory {
			m.logEvents = m.logEvents[len(m.logEvents)-maxLogEventHistory:]
		}
	}
	return m.copyLogEvents(), nil
}

func (m *Dashboard) readNewLogLines() ([]string, error) {
	file, err := os.Open(m.cfg.LogPath)
	if err != nil {
		return nil, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, err
	}
	size := info.Size()
	if size < m.logOffset {
		m.logOffset = 0
		m.logPartial = ""
	}
	if size == m.logOffset {
		return nil, nil
	}

	start := m.logOffset
	if size-start > maxLogReadBytes {
		start = size - maxLogReadBytes
		m.logPartial = ""
	}
	if _, err := file.Seek(start, io.SeekStart); err != nil {
		return nil, err
	}
	data, err := io.ReadAll(file)
	if err != nil {
		return nil, err
	}
	m.logOffset = size
	if len(data) == 0 {
		return nil, nil
	}

	text := m.logPartial + string(data)
	text = strings.ReplaceAll(text, "\r\n", "\n")
	if !strings.HasSuffix(text, "\n") {
		lastNewline := strings.LastIndexByte(text, '\n')
		if lastNewline < 0 {
			m.logPartial = text
			return nil, nil
		}
		m.logPartial = text[lastNewline+1:]
		text = text[:lastNewline+1]
	} else {
		m.logPartial = ""
	}

	rawLines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	lines := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines, nil
}

func (m *Dashboard) copyLogEvents() []llamacpp.LogEvent {
	out := make([]llamacpp.LogEvent, len(m.logEvents))
	copy(out, m.logEvents)
	return out
}

func queriesFromRequests(requests []RequestSummary, events []llamacpp.LogEvent) []QuerySummary {
	queries := make([]QuerySummary, 0, len(requests))
	for _, request := range requests {
		query := QuerySummary{
			ID:                request.ID,
			Status:            requestStatus(request),
			Route:             request.Route,
			Model:             request.Model,
			Stream:            request.Stream,
			StartedAt:         request.StartedAt,
			EndedAt:           request.EndedAt,
			DurationMS:        request.DurationMS,
			SlotIDs:           append([]int(nil), request.SlotIDs...),
			TaskIDs:           append([]int(nil), request.TaskIDs...),
			PromptCacheTokens: request.PromptCacheTokens,
			Error:             request.Error,
		}
		if request.Usage != nil {
			query.PromptTokens = request.Usage.PromptTokens
			query.CompletionTokens = request.Usage.CompletionTokens
			query.TotalTokens = request.Usage.TotalTokens
		}
		enrichQueryFromEvents(&query, events)
		queries = append(queries, query)
	}
	return queries
}

func requestStatus(request RequestSummary) string {
	if request.EndedAt == nil {
		return "running"
	}
	if request.Error != "" || request.Status >= 400 {
		return "error"
	}
	return "complete"
}

func enrichQueryFromEvents(query *QuerySummary, events []llamacpp.LogEvent) {
	taskSet := map[int]bool{}
	slotSet := map[int]bool{}
	for _, taskID := range query.TaskIDs {
		taskSet[taskID] = true
	}
	for _, slotID := range query.SlotIDs {
		slotSet[slotID] = true
	}
	if len(taskSet) == 0 && len(slotSet) == 0 {
		return
	}

	for _, event := range events {
		if !eventMatchesQuery(event, taskSet, slotSet) {
			continue
		}
		switch event.Kind {
		case "timing":
			query.CurrentTokensPerSec = event.TokensPerSecond
			at := event.At
			query.LastTimingEventAt = &at
		case "cache":
			query.LastCacheAction = event.CacheAction
			at := event.At
			query.LastCacheEventAt = &at
		}
	}
}

func eventMatchesQuery(event llamacpp.LogEvent, taskSet, slotSet map[int]bool) bool {
	if event.TaskID > 0 && taskSet[event.TaskID] {
		return true
	}
	if event.SlotID > 0 && slotSet[event.SlotID] {
		return true
	}
	return false
}
