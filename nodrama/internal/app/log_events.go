package app

import (
	"bufio"
	"io"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"llama.nodrama/nodrama/internal/llamacpp"
)

const maxLogReadBytes = 1024 * 1024
const maxRecentQueries = 10
const staleQueuedRequestAge = 10 * time.Second
const minMeaningfulCacheReuseTokens = 64
const minMeaningfulCacheReuseRatio = 0.10
const pendingCacheKeyTTL = 5 * time.Second
const maxInitialLogStateLines = 512

func (m *Dashboard) pollLogEvents(logPath string, now time.Time) ([]llamacpp.LogEvent, error) {
	if logPath == "" {
		return nil, nil
	}

	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	lines, err := m.readNewLogLines(logPath)
	if err != nil {
		return m.copyLogEvents(), err
	}
	if len(lines) == 0 {
		return m.copyLogEvents(), nil
	}

	for i, line := range lines {
		eventAt := now.Add(time.Duration(i) * time.Nanosecond)
		event, ok := llamacpp.ParseLogLine(line, eventAt)
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

func (m *Dashboard) readNewLogLines(logPath string) ([]string, error) {
	file, err := os.Open(logPath)
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
	if !m.logInitialized {
		m.logInitialized = true
		m.logOffset = size
		m.logPartial = ""
		return readInitialLogStateLines(file)
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

	return splitEventLogLines(text), nil
}

func readInitialLogStateLines(file *os.File) ([]string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)
	lines := make([]string, 0, 16)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if !initialLogStateLine(line) {
			continue
		}
		lines = append(lines, line)
		if len(lines) > maxInitialLogStateLines {
			lines = lines[len(lines)-maxInitialLogStateLines:]
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return lines, nil
}

func initialLogStateLine(line string) bool {
	return strings.Contains(line, "cache state:") ||
		strings.Contains(line, "n_ctx_seq") ||
		strings.Contains(line, "slot context")
}

func splitEventLogLines(text string) []string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	rawLines := strings.Split(strings.TrimSuffix(text, "\n"), "\n")
	lines := make([]string, 0, len(rawLines))
	for _, line := range rawLines {
		if trimmed := strings.TrimSpace(line); trimmed != "" {
			lines = append(lines, trimmed)
		}
	}
	return lines
}

func (m *Dashboard) copyLogEvents() []llamacpp.LogEvent {
	out := make([]llamacpp.LogEvent, len(m.logEvents))
	copy(out, m.logEvents)
	return out
}

func (m *Dashboard) updateQueries(now time.Time, model string, slots []llamacpp.Slot, slotsKnown bool, queueKnownEmpty bool, requests []RequestSummary, events []llamacpp.LogEvent) []QuerySummary {
	m.queryMu.Lock()
	defer m.queryMu.Unlock()

	if m.queries == nil {
		m.queries = map[string]QuerySummary{}
	}
	if m.slotQuery == nil {
		m.slotQuery = map[int]string{}
	}
	if m.lastSlotQuery == nil {
		m.lastSlotQuery = map[int]string{}
	}
	if m.taskQuery == nil {
		m.taskQuery = map[int]string{}
	}
	if m.seenQueryEvents == nil {
		m.seenQueryEvents = map[string]bool{}
	}

	requestByTask := requestsByTask(requests)
	previousSlotQuery := m.slotQuery
	m.slotQuery = map[int]string{}
	activeQuery := map[string]bool{}
	activeTask := map[int]bool{}

	for _, event := range events {
		if event.ID != "" && m.seenQueryEvents[event.ID] {
			continue
		}
		if event.ID != "" {
			m.seenQueryEvents[event.ID] = true
		}
		m.applyEventToQuery(event, now)
	}

	for _, slot := range slots {
		if !slot.IsProcessing || slot.TaskID <= 0 {
			continue
		}
		activeTask[slot.TaskID] = true
		id := m.queryIDForTask(slot.TaskID)
		query := m.ensureQuery(id, now)
		query.Status = "running"
		query.Route = "llama.cpp"
		if model != "" {
			query.Model = model
		}
		query.SlotIDs = []int{slot.ID}
		query.TaskIDs = []int{slot.TaskID}
		query.PromptTokens = maxInt(query.PromptTokens, slot.PromptTokens)
		query.CompletionTokens = maxInt(query.CompletionTokens, slot.DecodedTokens)
		query.TotalTokens = maxInt(query.TotalTokens, query.PromptTokens+query.CompletionTokens)
		query.PromptCacheTokens = maxInt(query.PromptCacheTokens, slot.PromptCacheTokens)
		query = promoteRestoredCacheReuse(query, now)
		query.EndedAt = nil
		if query.LastCacheAction == "invalidate" {
			query.LastCacheAction = ""
			query.LastCacheEventAt = nil
			query.CacheCached = false
		}
		query.DurationMS = now.Sub(query.StartedAt).Milliseconds()
		query.LastEventAt = timePtr(now)
		if request, ok := requestByTask[slot.TaskID]; ok {
			mergeRequestIntoQuery(&query, request)
		}
		m.queries[id] = query
		m.slotQuery[slot.ID] = id
		m.lastSlotQuery[slot.ID] = id
		activeQuery[id] = true
	}

	for slotID, queryID := range previousSlotQuery {
		if _, ok := m.slotQuery[slotID]; ok {
			continue
		}
		query := m.queries[queryID]
		if query.ID == "" || query.Status != "running" {
			continue
		}
		query.Status = "complete"
		query.EndedAt = timePtr(now)
		query.DurationMS = now.Sub(query.StartedAt).Milliseconds()
		query.LastEventAt = timePtr(now)
		m.queries[queryID] = query
	}

	for _, request := range requests {
		ids := m.queryIDsForRequest(request)
		if len(request.TaskIDs) > 0 {
			delete(m.queries, request.ID)
		}
		for _, id := range ids {
			query := m.ensureQuery(id, request.StartedAt)
			mergeRequestIntoQuery(&query, request)
			if activeQuery[id] {
				query.Status = "running"
				query.EndedAt = nil
			}
			m.queries[id] = query
		}
	}

	if slotsKnown {
		m.closeInactiveTaskQueries(now, activeTask)
	}
	if queueKnownEmpty {
		m.closeOrphanedQueuedRequests(now)
	}

	return m.pruneAndCopyQueries()
}

func (m *Dashboard) closeInactiveTaskQueries(now time.Time, activeTask map[int]bool) {
	for id, query := range m.queries {
		if (query.Status != "running" && query.Status != "queued") || len(query.TaskIDs) == 0 {
			continue
		}
		stillActive := false
		for _, taskID := range query.TaskIDs {
			if activeTask[taskID] {
				stillActive = true
				break
			}
		}
		if stillActive {
			continue
		}
		query.Status = "complete"
		query.EndedAt = timePtr(now)
		query.DurationMS = now.Sub(query.StartedAt).Milliseconds()
		query.LastEventAt = timePtr(now)
		m.queries[id] = query
	}
}

func (m *Dashboard) closeOrphanedQueuedRequests(now time.Time) {
	for id, query := range m.queries {
		if query.Status != "queued" || len(query.TaskIDs) > 0 || now.Sub(query.StartedAt) < staleQueuedRequestAge {
			continue
		}
		query.Status = "error"
		query.EndedAt = timePtr(now)
		query.DurationMS = now.Sub(query.StartedAt).Milliseconds()
		query.LastEventAt = timePtr(now)
		query.Error = "request did not reach an active llama.cpp slot"
		m.queries[id] = query
	}
}

func (m *Dashboard) ensureQuery(id string, startedAt time.Time) QuerySummary {
	query := m.queries[id]
	if query.ID == "" {
		query.ID = id
		query.Status = "complete"
		query.Route = "llama.cpp"
		query.StartedAt = startedAt
		query.LastEventAt = timePtr(startedAt)
	}
	return query
}

func (m *Dashboard) applyEventToQuery(event llamacpp.LogEvent, fallbackTime time.Time) {
	queryID := ""
	eventAt := event.At
	if eventAt.IsZero() {
		eventAt = fallbackTime
	}

	if event.Kind == "cache" && event.CacheKey != "" && event.TaskID == 0 {
		m.pendingCacheKey = event.CacheKey
		m.pendingCacheAt = eventAt
		return
	}

	if event.Kind == "launch" && event.TaskID > 0 {
		queryID = m.queryIDForLaunch(event.TaskID, eventAt)
		query := m.ensureQuery(queryID, eventAt)
		query.Status = "running"
		query.Route = "llama.cpp"
		if event.CacheKey != "" {
			query.CacheKey = event.CacheKey
		} else if key := cacheKeyFromQueryID(queryID); key != "" {
			query.CacheKey = key
		}
		if event.SlotID > 0 {
			query.SlotIDs = appendUniqueInt(query.SlotIDs, event.SlotID)
			m.slotQuery[event.SlotID] = queryID
			m.lastSlotQuery[event.SlotID] = queryID
		}
		query.TaskIDs = appendUniqueInt(query.TaskIDs, event.TaskID)
		query.EndedAt = nil
		query.LastEventAt = timePtr(eventAt)
		m.queries[query.ID] = query
		return
	}

	if event.TaskID > 0 {
		queryID = m.queryIDForTask(event.TaskID)
	} else if event.SlotID > 0 {
		if id, ok := m.slotQuery[event.SlotID]; ok {
			queryID = id
		} else if id, ok := m.lastSlotQuery[event.SlotID]; ok {
			queryID = id
		}
	}
	if queryID == "" {
		return
	}

	query := m.ensureQuery(queryID, eventAt)
	if event.CacheKey != "" {
		query.CacheKey = event.CacheKey
	} else if key := cacheKeyFromQueryID(queryID); key != "" {
		query.CacheKey = key
	}
	if event.SlotID > 0 {
		query.SlotIDs = appendUniqueInt(query.SlotIDs, event.SlotID)
	}
	if event.TaskID > 0 {
		query.TaskIDs = appendUniqueInt(query.TaskIDs, event.TaskID)
	}
	switch event.Kind {
	case "timing":
		query.CurrentTokensPerSec = event.TokensPerSecond
		query.CompletionTokens = maxInt(query.CompletionTokens, event.DecodedTokens)
		query.TotalTokens = maxInt(query.TotalTokens, query.PromptTokens+query.CompletionTokens)
		query.LastTimingEventAt = timePtr(eventAt)
	case "prompt_eval":
		query.PromptTokens = maxInt(query.PromptTokens, event.PromptTokens)
		query.TotalTokens = maxInt(query.TotalTokens, query.PromptTokens+query.CompletionTokens)
		query = promoteRestoredCacheReuse(query, eventAt)
	case "cache":
		switch event.CacheAction {
		case "hit", "load", "reuse":
			query.LastCacheAction = event.CacheAction
			query.LastCacheEventAt = timePtr(eventAt)
			query.LastCacheReuseAt = timePtr(eventAt)
			query.CacheCached = true
			query.CacheReuseCount++
		case "save":
			query.CacheCached = true
			query.LastCacheEventAt = timePtr(eventAt)
		case "evict", "clear":
			query.CacheCached = false
			query.LastCacheAction = "evict"
			query.LastCacheEventAt = timePtr(eventAt)
		}
	case "warning", "error":
		if strings.Contains(strings.ToLower(event.Message), "restored context checkpoint") {
			query.LastCacheEventAt = timePtr(eventAt)
			query.CacheRestoredTokens = maxInt(query.CacheRestoredTokens, event.RestoredTokens)
			query.cacheRestoreEvents++
			query.CacheCached = true
			query = promoteRestoredCacheReuse(query, eventAt)
		}
		if strings.Contains(strings.ToLower(event.Message), "erased invalidated context checkpoint") {
			query.CacheCached = false
			if query.Status != "running" {
				query.LastCacheAction = "invalidate"
				query.LastCacheEventAt = timePtr(eventAt)
			}
		}
		if event.Kind == "error" {
			query.Status = "error"
			query.Error = event.Message
		}
	}
	query.LastEventAt = timePtr(eventAt)
	m.queries[query.ID] = query
}

func promoteRestoredCacheReuse(query QuerySummary, eventAt time.Time) QuerySummary {
	if query.CacheRestoredTokens <= 0 || query.cacheRestoreEventsCounted >= query.cacheRestoreEvents {
		return query
	}
	if !isMeaningfulCacheReuse(query.CacheRestoredTokens, query.PromptTokens) {
		query.CacheReuseRatio = cacheReuseRatio(query.CacheRestoredTokens, query.PromptTokens)
		return query
	}
	query.LastCacheAction = "restore"
	query.LastCacheEventAt = timePtr(eventAt)
	query.LastCacheReuseAt = timePtr(eventAt)
	query.CacheCached = true
	for query.cacheRestoreEventsCounted < query.cacheRestoreEvents {
		query.CacheReuseCount++
		query.cacheRestoreEventsCounted++
	}
	query.CacheReuseRatio = cacheReuseRatio(query.CacheRestoredTokens, query.PromptTokens)
	return query
}

func isMeaningfulCacheReuse(restoredTokens, promptTokens int) bool {
	if restoredTokens < minMeaningfulCacheReuseTokens {
		return false
	}
	if promptTokens <= 0 {
		return false
	}
	return cacheReuseRatio(restoredTokens, promptTokens) >= minMeaningfulCacheReuseRatio
}

func cacheReuseRatio(restoredTokens, promptTokens int) float64 {
	if restoredTokens <= 0 || promptTokens <= 0 {
		return 0
	}
	return float64(restoredTokens) / float64(promptTokens)
}

func (m *Dashboard) pruneAndCopyQueries() []QuerySummary {
	queries := make([]QuerySummary, 0, len(m.queries))
	for _, query := range m.queries {
		queries = append(queries, cloneQuery(query))
	}
	sort.SliceStable(queries, func(i, j int) bool {
		if queryRunningRank(queries[i]) != queryRunningRank(queries[j]) {
			return queryRunningRank(queries[i]) < queryRunningRank(queries[j])
		}
		if queries[i].CacheReuseCount != queries[j].CacheReuseCount {
			return queries[i].CacheReuseCount > queries[j].CacheReuseCount
		}
		leftReuseAt := queryCacheReuseTime(queries[i])
		rightReuseAt := queryCacheReuseTime(queries[j])
		if !leftReuseAt.Equal(rightReuseAt) {
			return leftReuseAt.After(rightReuseAt)
		}
		leftSortAt := querySortTime(queries[i])
		rightSortAt := querySortTime(queries[j])
		if !leftSortAt.Equal(rightSortAt) {
			return leftSortAt.After(rightSortAt)
		}
		return queries[i].ID > queries[j].ID
	})

	kept := make([]QuerySummary, 0, len(queries))
	keepIDs := map[string]bool{}
	for _, query := range queries {
		if query.Status != "running" && query.Status != "queued" && len(kept) >= maxRecentQueries {
			continue
		}
		kept = append(kept, query)
		keepIDs[query.ID] = true
	}
	for id := range m.queries {
		if !keepIDs[id] {
			delete(m.queries, id)
		}
	}
	for taskID, id := range m.taskQuery {
		if !keepIDs[id] {
			delete(m.taskQuery, taskID)
		}
	}
	for slotID, id := range m.lastSlotQuery {
		if !keepIDs[id] {
			delete(m.lastSlotQuery, slotID)
		}
	}
	return kept
}

func requestsByTask(requests []RequestSummary) map[int]RequestSummary {
	out := map[int]RequestSummary{}
	for _, request := range requests {
		for _, taskID := range request.TaskIDs {
			if taskID > 0 {
				out[taskID] = request
			}
		}
	}
	return out
}

func (m *Dashboard) queryIDsForRequest(request RequestSummary) []string {
	if len(request.TaskIDs) == 0 {
		return []string{request.ID}
	}
	ids := make([]string, 0, len(request.TaskIDs))
	for _, taskID := range request.TaskIDs {
		if taskID > 0 {
			ids = append(ids, m.queryIDForTask(taskID))
		}
	}
	if len(ids) == 0 {
		return []string{request.ID}
	}
	return ids
}

func (m *Dashboard) queryIDForTask(taskID int) string {
	if taskID <= 0 {
		return ""
	}
	if id, ok := m.taskQuery[taskID]; ok && id != "" {
		return id
	}
	id := taskQueryID(taskID)
	m.taskQuery[taskID] = id
	return id
}

func (m *Dashboard) queryIDForLaunch(taskID int, eventAt time.Time) string {
	if taskID <= 0 {
		return ""
	}
	if m.pendingCacheKey != "" && !m.pendingCacheAt.IsZero() {
		age := eventAt.Sub(m.pendingCacheAt)
		if age >= 0 && age <= pendingCacheKeyTTL {
			id := cacheQueryID(m.pendingCacheKey)
			m.taskQuery[taskID] = id
			m.pendingCacheKey = ""
			m.pendingCacheAt = time.Time{}
			return id
		}
		if age > pendingCacheKeyTTL {
			m.pendingCacheKey = ""
			m.pendingCacheAt = time.Time{}
		}
	}
	return m.queryIDForTask(taskID)
}

func mergeRequestIntoQuery(query *QuerySummary, request RequestSummary) {
	query.RequestIDs = appendUniqueString(query.RequestIDs, request.ID)
	if request.Route != "" {
		query.Route = request.Route
	}
	if request.Model != "" {
		query.Model = request.Model
	}
	query.Stream = request.Stream
	if request.StartedAt.Before(query.StartedAt) || query.StartedAt.IsZero() {
		query.StartedAt = request.StartedAt
	}
	if taskID := taskIDFromQueryID(query.ID); taskID > 0 {
		query.TaskIDs = appendUniqueInt(query.TaskIDs, taskID)
	} else {
		query.SlotIDs = appendUniqueInts(query.SlotIDs, request.SlotIDs)
		query.TaskIDs = appendUniqueInts(query.TaskIDs, request.TaskIDs)
	}
	if request.EndedAt != nil {
		query.EndedAt = cloneTimePtr(request.EndedAt)
		query.DurationMS = request.DurationMS
		query.Status = requestStatus(request)
		query.LastEventAt = cloneTimePtr(request.EndedAt)
	} else if len(query.TaskIDs) == 0 {
		query.Status = "queued"
	} else {
		query.Status = "running"
	}
	query.PromptCacheTokens = maxInt(query.PromptCacheTokens, request.PromptCacheTokens)
	if request.Usage != nil {
		query.PromptTokens = maxInt(query.PromptTokens, request.Usage.PromptTokens)
		query.CompletionTokens = maxInt(query.CompletionTokens, request.Usage.CompletionTokens)
		query.TotalTokens = maxInt(query.TotalTokens, request.Usage.TotalTokens)
	}
	if request.Error != "" {
		query.Error = request.Error
	}
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

func taskQueryID(taskID int) string {
	return "task_" + strconv.Itoa(taskID)
}

func cacheQueryID(cacheKey string) string {
	if cacheKey == "" {
		return ""
	}
	return "cache_" + cacheKey
}

func cacheKeyFromQueryID(id string) string {
	raw, ok := strings.CutPrefix(id, "cache_")
	if !ok {
		return ""
	}
	return raw
}

func taskIDFromQueryID(id string) int {
	raw, ok := strings.CutPrefix(id, "task_")
	if !ok {
		return 0
	}
	parsed, _ := strconv.Atoi(raw)
	return parsed
}

func querySortTime(query QuerySummary) time.Time {
	if query.LastEventAt != nil {
		return *query.LastEventAt
	}
	if query.EndedAt != nil {
		return *query.EndedAt
	}
	return query.StartedAt
}

func queryCacheReuseTime(query QuerySummary) time.Time {
	if query.LastCacheReuseAt != nil {
		return *query.LastCacheReuseAt
	}
	return time.Time{}
}

func queryRunningRank(query QuerySummary) int {
	switch query.Status {
	case "running":
		return 0
	case "queued":
		return 1
	default:
		return 2
	}
}

func appendUniqueInts(base []int, values []int) []int {
	for _, value := range values {
		base = appendUniqueInt(base, value)
	}
	return base
}

func appendUniqueInt(values []int, value int) []int {
	if value <= 0 {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func appendUniqueString(values []string, value string) []string {
	if value == "" {
		return values
	}
	for _, existing := range values {
		if existing == value {
			return values
		}
	}
	return append(values, value)
}

func cloneQuery(query QuerySummary) QuerySummary {
	query.RequestIDs = append([]string(nil), query.RequestIDs...)
	query.SlotIDs = append([]int(nil), query.SlotIDs...)
	query.TaskIDs = append([]int(nil), query.TaskIDs...)
	query.EndedAt = cloneTimePtr(query.EndedAt)
	query.LastTimingEventAt = cloneTimePtr(query.LastTimingEventAt)
	query.LastCacheReuseAt = cloneTimePtr(query.LastCacheReuseAt)
	query.LastCacheEventAt = cloneTimePtr(query.LastCacheEventAt)
	query.LastEventAt = cloneTimePtr(query.LastEventAt)
	return query
}

func cloneTimePtr(value *time.Time) *time.Time {
	if value == nil {
		return nil
	}
	cloned := *value
	return &cloned
}

func timePtr(value time.Time) *time.Time {
	return &value
}

func maxInt(a, b int) int {
	if b > a {
		return b
	}
	return a
}
