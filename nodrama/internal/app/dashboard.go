package app

import (
	"context"
	"fmt"
	"math"
	"net/http"
	"sort"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"llama.nodrama/nodrama/internal/gpu"
	"llama.nodrama/nodrama/internal/llamacpp"
)

type Snapshot struct {
	App            string                    `json:"app"`
	Build          BuildInfo                 `json:"build"`
	Mode           string                    `json:"mode"`
	Server         string                    `json:"server"`
	PollIntervalMS int64                     `json:"pollIntervalMs"`
	StartedAt      time.Time                 `json:"startedAt"`
	UpdatedAt      time.Time                 `json:"updatedAt"`
	Endpoints      map[string]llamacpp.Probe `json:"endpoints"`
	Overview       Overview                  `json:"overview"`
	Props          llamacpp.PropsSummary     `json:"props"`
	Metrics        llamacpp.MetricsSummary   `json:"metrics"`
	Models         []llamacpp.ModelSummary   `json:"models"`
	RouterModels   []map[string]any          `json:"routerModels,omitempty"`
	LoraAdapters   []map[string]any          `json:"loraAdapters,omitempty"`
	Slots          []llamacpp.Slot           `json:"slots"`
	GPU            gpu.Snapshot              `json:"gpu"`
	History        SnapshotHistory           `json:"history"`
	MetricFacts    map[string]MetricFact     `json:"metricFacts,omitempty"`
	Suggestions    []Suggestion              `json:"suggestions"`
	Requests       []RequestSummary          `json:"requests,omitempty"`
	Queries        []QuerySummary            `json:"queries,omitempty"`
	Events         []llamacpp.LogEvent       `json:"events,omitempty"`
	Warnings       []string                  `json:"warnings"`
	RawMetrics     map[string]float64        `json:"rawMetrics,omitempty"`
	LastErrors     map[string]string         `json:"lastErrors,omitempty"`
	Update         UpdateInfo                `json:"update"`
}

type SnapshotHistory struct {
	Metrics map[string][]HistoryPoint     `json:"metrics"`
	Slots   map[string][]SlotHistoryPoint `json:"slots"`
}

type HistoryPoint struct {
	T int64   `json:"t"`
	V float64 `json:"v"`
}

type MetricFact struct {
	PeakValue float64    `json:"peakValue,omitempty"`
	PeakAt    *time.Time `json:"peakAt,omitempty"`
}

type SlotHistoryPoint struct {
	T                      int64   `json:"t"`
	ID                     int     `json:"id"`
	TaskID                 int     `json:"taskId,omitempty"`
	State                  string  `json:"state"`
	IsProcessing           bool    `json:"isProcessing"`
	ContextTokens          int     `json:"contextTokens,omitempty"`
	ContextEstimateTokens  int     `json:"contextEstimateTokens,omitempty"`
	PromptTokens           int     `json:"promptTokens,omitempty"`
	PromptProcessedTokens  int     `json:"promptProcessedTokens,omitempty"`
	PromptCacheTokens      int     `json:"promptCacheTokens,omitempty"`
	DecodedTokens          int     `json:"decodedTokens,omitempty"`
	RemainingTokens        int     `json:"remainingTokens,omitempty"`
	PromptTokensPerSec     float64 `json:"promptTokensPerSec,omitempty"`
	GenerationTokensPerSec float64 `json:"generationTokensPerSec,omitempty"`
	GenerationProgress     float64 `json:"generationProgress,omitempty"`
	PromptProgress         float64 `json:"promptProgress,omitempty"`
	Model                  string  `json:"model,omitempty"`
}

type Suggestion struct {
	ID       string         `json:"id"`
	Severity string         `json:"severity"`
	Title    string         `json:"title"`
	Explain  string         `json:"explain"`
	Suggest  string         `json:"suggest"`
	Context  map[string]any `json:"context,omitempty"`
}

type RequestSummary struct {
	ID                string      `json:"id"`
	Route             string      `json:"route"`
	Model             string      `json:"model,omitempty"`
	Stream            bool        `json:"stream"`
	StartedAt         time.Time   `json:"startedAt"`
	EndedAt           *time.Time  `json:"endedAt,omitempty"`
	DurationMS        int64       `json:"durationMs,omitempty"`
	Status            int         `json:"status,omitempty"`
	ResponseBytes     int64       `json:"responseBytes,omitempty"`
	Usage             *TokenUsage `json:"usage,omitempty"`
	SlotIDs           []int       `json:"slotIds,omitempty"`
	TaskIDs           []int       `json:"taskIds,omitempty"`
	PromptCacheTokens int         `json:"promptCacheTokens,omitempty"`
	Error             string      `json:"error,omitempty"`
}

type TokenUsage struct {
	PromptTokens     int `json:"promptTokens,omitempty"`
	CompletionTokens int `json:"completionTokens,omitempty"`
	TotalTokens      int `json:"totalTokens,omitempty"`
}

type QuerySummary struct {
	ID                  string     `json:"id"`
	Status              string     `json:"status"`
	Route               string     `json:"route"`
	RequestIDs          []string   `json:"requestIds,omitempty"`
	Model               string     `json:"model,omitempty"`
	Stream              bool       `json:"stream"`
	StartedAt           time.Time  `json:"startedAt"`
	EndedAt             *time.Time `json:"endedAt,omitempty"`
	DurationMS          int64      `json:"durationMs,omitempty"`
	SlotIDs             []int      `json:"slotIds,omitempty"`
	TaskIDs             []int      `json:"taskIds,omitempty"`
	PromptTokens        int        `json:"promptTokens,omitempty"`
	CompletionTokens    int        `json:"completionTokens,omitempty"`
	TotalTokens         int        `json:"totalTokens,omitempty"`
	PromptCacheTokens   int        `json:"promptCacheTokens,omitempty"`
	CacheCached         bool       `json:"cacheCached,omitempty"`
	CacheReuseCount     int        `json:"cacheReuseCount,omitempty"`
	CurrentTokensPerSec float64    `json:"currentTokensPerSec,omitempty"`
	LastTimingEventAt   *time.Time `json:"lastTimingEventAt,omitempty"`
	LastCacheAction     string     `json:"lastCacheAction,omitempty"`
	LastCacheReuseAt    *time.Time `json:"lastCacheReuseAt,omitempty"`
	LastCacheEventAt    *time.Time `json:"lastCacheEventAt,omitempty"`
	LastEventAt         *time.Time `json:"lastEventAt,omitempty"`
	Error               string     `json:"error,omitempty"`
}

type Overview struct {
	Online                 bool    `json:"online"`
	RequestsProcessing     float64 `json:"requestsProcessing"`
	RequestsDeferred       float64 `json:"requestsDeferred"`
	PromptTokensPerSec     float64 `json:"promptTokensPerSec"`
	GenerationTokensPerSec float64 `json:"generationTokensPerSec"`
	BusySlots              int     `json:"busySlots"`
	TotalSlots             int     `json:"totalSlots"`
	PromptTokensTotal      float64 `json:"promptTokensTotal"`
	GeneratedTokensTotal   float64 `json:"generatedTokensTotal"`
	ContextTokens          int     `json:"contextTokens"`
	ModelAlias             string  `json:"modelAlias"`
}

type Dashboard struct {
	client       *llamacpp.Client
	cfg          Config
	build        BuildInfo
	started      time.Time
	lastSlowPoll time.Time
	runtimeMu    sync.RWMutex

	mu           sync.RWMutex
	snapshot     Snapshot
	previousSlot map[int]llamacpp.Slot

	historyMu      sync.Mutex
	rateHistory    []metricRateSample
	slotRateLast   map[int]slotRateSample
	slotLiveRates  map[int]slotLiveRate
	metricHistory  map[string][]HistoryPoint
	metricFacts    map[string]MetricFact
	slotHistory    map[int][]SlotHistoryPoint
	logOffset      int64
	logInitialized bool
	logPartial     string
	logEventSeq    uint64
	logEvents      []llamacpp.LogEvent

	requestSeq uint64
	requestMu  sync.Mutex
	requests   []RequestSummary

	queryMu         sync.Mutex
	queries         map[string]QuerySummary
	slotQuery       map[int]string
	lastSlotQuery   map[int]string
	seenQueryEvents map[string]bool

	updateMu        sync.Mutex
	updateInfo      UpdateInfo
	updateCheckedAt time.Time

	sustainedSince map[string]time.Time
}

type metricRateSample struct {
	at             time.Time
	promptTotal    float64
	generatedTotal float64
}

type slotRateSample struct {
	at                    time.Time
	taskID                int
	isProcessing          bool
	promptProcessedTokens int
	decodedTokens         int
}

type slotLiveRate struct {
	promptTokensPerSec     float64
	generationTokensPerSec float64
}

const (
	liveRateWindow       = 5 * time.Second
	metricHistoryWindow  = time.Minute
	slowPollInterval     = 5 * time.Second
	maxMetricHistorySize = 600
	maxRequestHistory    = 200
	maxLogEventHistory   = 500
)

func NewDashboard(client *llamacpp.Client, cfg Config, build BuildInfo) *Dashboard {
	now := time.Now()
	return &Dashboard{
		client:          client,
		cfg:             cfg,
		build:           build,
		started:         now,
		previousSlot:    map[int]llamacpp.Slot{},
		slotRateLast:    map[int]slotRateSample{},
		slotLiveRates:   map[int]slotLiveRate{},
		metricHistory:   map[string][]HistoryPoint{},
		metricFacts:     map[string]MetricFact{},
		slotHistory:     map[int][]SlotHistoryPoint{},
		queries:         map[string]QuerySummary{},
		slotQuery:       map[int]string{},
		lastSlotQuery:   map[int]string{},
		seenQueryEvents: map[string]bool{},
		sustainedSince:  map[string]time.Time{},
		snapshot: Snapshot{
			App:            "llama.nodrama",
			Build:          build,
			Mode:           "single",
			Server:         cfg.Server,
			PollIntervalMS: cfg.PollInterval.Milliseconds(),
			StartedAt:      now,
			UpdatedAt:      now,
			Endpoints:      map[string]llamacpp.Probe{},
			History:        SnapshotHistory{Metrics: map[string][]HistoryPoint{}, Slots: map[string][]SlotHistoryPoint{}},
			Suggestions:    []Suggestion{},
			Requests:       []RequestSummary{},
			Warnings:       []string{"Waiting for first poll."},
			Update:         defaultUpdateInfo(build.Version),
		},
		updateInfo: defaultUpdateInfo(build.Version),
	}
}

func (m *Dashboard) StartedAt() time.Time {
	return m.started
}

func (m *Dashboard) Start(ctx context.Context) {
	go func() {
		m.poll(ctx)
		for {
			interval := m.runtimeConfig().PollInterval
			if interval <= 0 {
				interval = time.Second
			}
			timer := time.NewTimer(interval)
			select {
			case <-ctx.Done():
				timer.Stop()
				return
			case <-timer.C:
				m.poll(ctx)
			}
		}
	}()
}

func (m *Dashboard) runtimeConfig() Config {
	m.runtimeMu.RLock()
	defer m.runtimeMu.RUnlock()
	return m.cfg
}

func (m *Dashboard) runtimeClient() *llamacpp.Client {
	m.runtimeMu.RLock()
	defer m.runtimeMu.RUnlock()
	return m.client
}

func (m *Dashboard) Settings() RuntimeSettings {
	cfg := m.runtimeConfig()
	return runtimeSettingsFromConfig(cfg)
}

func runtimeSettingsFromConfig(cfg Config) RuntimeSettings {
	return RuntimeSettings{
		Server:       cfg.Server,
		Listen:       cfg.Listen,
		LogPath:      cfg.LogPath,
		RawProxy:     cfg.RawProxy,
		PollInterval: cfg.PollInterval.Milliseconds(),
		Timeout:      cfg.Timeout.Milliseconds(),
	}
}

func (m *Dashboard) UpdateSettings(update RuntimeSettingsUpdate) (RuntimeSettings, error) {
	m.runtimeMu.Lock()
	cfg := m.cfg
	if update.Server != nil {
		cfg.Server = *update.Server
	}
	if update.LogPath != nil {
		cfg.LogPath = *update.LogPath
	}
	if update.PollInterval != nil {
		if *update.PollInterval < 200 || *update.PollInterval > 60_000 {
			m.runtimeMu.Unlock()
			return RuntimeSettings{}, fmt.Errorf("pollIntervalMs must be between 200 and 60000")
		}
		cfg.PollInterval = time.Duration(*update.PollInterval) * time.Millisecond
	}
	if update.Timeout != nil {
		if *update.Timeout < 250 || *update.Timeout > 120_000 {
			m.runtimeMu.Unlock()
			return RuntimeSettings{}, fmt.Errorf("timeoutMs must be between 250 and 120000")
		}
		cfg.Timeout = time.Duration(*update.Timeout) * time.Millisecond
	}
	client, err := llamacpp.NewClient(cfg.Server, cfg.Timeout)
	if err != nil {
		m.runtimeMu.Unlock()
		return RuntimeSettings{}, err
	}
	serverChanged := cfg.Server != m.cfg.Server
	logChanged := cfg.LogPath != m.cfg.LogPath
	m.cfg = cfg
	m.client = client
	settings := runtimeSettingsFromConfig(cfg)
	m.runtimeMu.Unlock()

	if serverChanged || logChanged {
		m.ResetHistory()
	}
	return settings, nil
}

func (m *Dashboard) Snapshot() Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snapshot
}

func copyProbes(in map[string]llamacpp.Probe) map[string]llamacpp.Probe {
	out := make(map[string]llamacpp.Probe, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func copyStringMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for key, value := range in {
		out[key] = value
	}
	return out
}

func (m *Dashboard) deriveLiveRates(now time.Time, promptTotal, generatedTotal float64) (float64, float64) {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	if len(m.rateHistory) > 0 {
		prev := m.rateHistory[len(m.rateHistory)-1]
		if promptTotal < prev.promptTotal || generatedTotal < prev.generatedTotal {
			m.rateHistory = nil
		}
	}

	m.rateHistory = append(m.rateHistory, metricRateSample{
		at:             now,
		promptTotal:    promptTotal,
		generatedTotal: generatedTotal,
	})

	cutoff := now.Add(-liveRateWindow)
	for len(m.rateHistory) > 1 && m.rateHistory[0].at.Before(cutoff) {
		m.rateHistory = m.rateHistory[1:]
	}
	if len(m.rateHistory) < 2 {
		return 0, 0
	}
	base := m.rateHistory[0]
	elapsed := now.Sub(base.at).Seconds()
	if elapsed <= 0 {
		return 0, 0
	}
	promptRate := counterRate(base.promptTotal, promptTotal, elapsed)
	generatedRate := counterRate(base.generatedTotal, generatedTotal, elapsed)
	return promptRate, generatedRate
}

func counterRate(previous, current, elapsedSeconds float64) float64 {
	if current < previous || elapsedSeconds <= 0 {
		return 0
	}
	return (current - previous) / elapsedSeconds
}

func (m *Dashboard) deriveSlotLiveRates(now time.Time, slots []llamacpp.Slot) (float64, float64, bool) {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	if m.slotRateLast == nil {
		m.slotRateLast = map[int]slotRateSample{}
	}
	if m.slotLiveRates == nil {
		m.slotLiveRates = map[int]slotLiveRate{}
	}

	seen := map[int]bool{}
	promptRate := 0.0
	generationRate := 0.0
	hasRate := false
	for _, slot := range slots {
		seen[slot.ID] = true
		liveRate := slotLiveRate{}
		current := slotRateSample{
			at:                    now,
			taskID:                slot.TaskID,
			isProcessing:          slot.IsProcessing,
			promptProcessedTokens: slot.PromptProcessedTokens,
			decodedTokens:         slot.DecodedTokens,
		}
		previous, ok := m.slotRateLast[slot.ID]
		m.slotRateLast[slot.ID] = current
		if !ok || !slot.IsProcessing || !previous.isProcessing {
			m.slotLiveRates[slot.ID] = liveRate
			continue
		}
		if slot.TaskID == 0 || previous.taskID == 0 || slot.TaskID != previous.taskID {
			m.slotLiveRates[slot.ID] = liveRate
			continue
		}
		elapsed := now.Sub(previous.at).Seconds()
		if elapsed <= 0 {
			m.slotLiveRates[slot.ID] = liveRate
			continue
		}
		promptDelta := slot.PromptProcessedTokens - previous.promptProcessedTokens
		if promptDelta > 0 {
			liveRate.promptTokensPerSec = float64(promptDelta) / elapsed
			promptRate += liveRate.promptTokensPerSec
			hasRate = true
		}
		decodedDelta := slot.DecodedTokens - previous.decodedTokens
		if decodedDelta > 0 {
			liveRate.generationTokensPerSec = float64(decodedDelta) / elapsed
			generationRate += liveRate.generationTokensPerSec
			hasRate = true
		}
		m.slotLiveRates[slot.ID] = liveRate
	}
	for slotID := range m.slotRateLast {
		if !seen[slotID] {
			delete(m.slotRateLast, slotID)
			delete(m.slotLiveRates, slotID)
		}
	}
	return promptRate, generationRate, hasRate
}

func (m *Dashboard) recordMetricHistory(now time.Time, metrics map[string]float64) SnapshotHistory {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	if m.metricHistory == nil {
		m.metricHistory = map[string][]HistoryPoint{}
	}
	if m.metricFacts == nil {
		m.metricFacts = map[string]MetricFact{}
	}

	t := now.UnixMilli()
	cutoff := now.Add(-metricHistoryWindow).UnixMilli()
	for name, value := range metrics {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			continue
		}
		fact := m.metricFacts[name]
		if fact.PeakAt == nil || value > fact.PeakValue {
			peakAt := now
			m.metricFacts[name] = MetricFact{PeakValue: value, PeakAt: &peakAt}
		}
		points := append(m.metricHistory[name], HistoryPoint{T: t, V: value})
		points = trimHistoryPoints(points, cutoff)
		if len(points) > maxMetricHistorySize {
			points = points[len(points)-maxMetricHistorySize:]
		}
		m.metricHistory[name] = points
	}

	for name, points := range m.metricHistory {
		points = trimHistoryPoints(points, cutoff)
		if len(points) == 0 {
			delete(m.metricHistory, name)
			continue
		}
		m.metricHistory[name] = points
	}

	return m.copyHistoryLocked()
}

func (m *Dashboard) copyMetricFacts() map[string]MetricFact {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	out := make(map[string]MetricFact, len(m.metricFacts))
	for name, fact := range m.metricFacts {
		out[name] = MetricFact{
			PeakValue: fact.PeakValue,
			PeakAt:    cloneTimePtr(fact.PeakAt),
		}
	}
	return out
}

func trimHistoryPoints(points []HistoryPoint, cutoff int64) []HistoryPoint {
	i := 0
	for i < len(points) && points[i].T < cutoff {
		i++
	}
	return points[i:]
}

func (m *Dashboard) recordSlotHistory(now time.Time, slots []llamacpp.Slot, model string) SnapshotHistory {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	if m.slotHistory == nil {
		m.slotHistory = map[int][]SlotHistoryPoint{}
	}

	t := now.UnixMilli()
	cutoff := now.Add(-metricHistoryWindow).UnixMilli()
	for _, slot := range slots {
		points := append(m.slotHistory[slot.ID], SlotHistoryPoint{
			T:                      t,
			ID:                     slot.ID,
			TaskID:                 slot.TaskID,
			State:                  slot.State,
			IsProcessing:           slot.IsProcessing,
			ContextTokens:          slot.ContextTokens,
			ContextEstimateTokens:  slot.ContextEstimateTokens,
			PromptTokens:           slot.PromptTokens,
			PromptProcessedTokens:  slot.PromptProcessedTokens,
			PromptCacheTokens:      slot.PromptCacheTokens,
			DecodedTokens:          slot.DecodedTokens,
			RemainingTokens:        slot.RemainingTokens,
			PromptTokensPerSec:     m.slotLiveRates[slot.ID].promptTokensPerSec,
			GenerationTokensPerSec: m.slotLiveRates[slot.ID].generationTokensPerSec,
			GenerationProgress:     slot.GenerationProgress,
			PromptProgress:         slot.PromptProgress,
			Model:                  model,
		})
		points = trimSlotHistoryPoints(points, cutoff)
		if len(points) > maxMetricHistorySize {
			points = points[len(points)-maxMetricHistorySize:]
		}
		m.slotHistory[slot.ID] = points
	}

	for slotID, points := range m.slotHistory {
		points = trimSlotHistoryPoints(points, cutoff)
		if len(points) == 0 {
			delete(m.slotHistory, slotID)
			continue
		}
		m.slotHistory[slotID] = points
	}

	return m.copyHistoryLocked()
}

func trimSlotHistoryPoints(points []SlotHistoryPoint, cutoff int64) []SlotHistoryPoint {
	i := 0
	for i < len(points) && points[i].T < cutoff {
		i++
	}
	return points[i:]
}

func (m *Dashboard) copyHistoryLocked() SnapshotHistory {
	out := SnapshotHistory{
		Metrics: make(map[string][]HistoryPoint, len(m.metricHistory)),
		Slots:   make(map[string][]SlotHistoryPoint, len(m.slotHistory)),
	}
	for name, points := range m.metricHistory {
		copied := make([]HistoryPoint, len(points))
		copy(copied, points)
		out.Metrics[name] = copied
	}
	for slotID, points := range m.slotHistory {
		copied := make([]SlotHistoryPoint, len(points))
		copy(copied, points)
		out.Slots[strconv.Itoa(slotID)] = copied
	}
	return out
}

func (m *Dashboard) ResetHistory() {
	m.historyMu.Lock()
	m.rateHistory = nil
	m.metricHistory = map[string][]HistoryPoint{}
	m.metricFacts = map[string]MetricFact{}
	m.slotHistory = map[int][]SlotHistoryPoint{}
	m.slotLiveRates = map[int]slotLiveRate{}
	m.logEvents = nil
	m.logEventSeq = 0
	m.logOffset = 0
	m.logInitialized = false
	m.logPartial = ""
	empty := m.copyHistoryLocked()
	m.historyMu.Unlock()

	m.mu.Lock()
	m.snapshot.History = empty
	m.snapshot.MetricFacts = nil
	m.snapshot.Events = nil
	m.snapshot.Queries = nil
	m.mu.Unlock()

	m.queryMu.Lock()
	m.queries = map[string]QuerySummary{}
	m.slotQuery = map[int]string{}
	m.lastSlotQuery = map[int]string{}
	m.seenQueryEvents = map[string]bool{}
	m.queryMu.Unlock()
}

func (m *Dashboard) updateReleaseInfo(ctx context.Context, now time.Time) UpdateInfo {
	m.updateMu.Lock()
	if !m.updateCheckedAt.IsZero() && now.Sub(m.updateCheckedAt) < updateCheckInterval {
		info := m.updateInfo
		m.updateMu.Unlock()
		return info
	}
	m.updateCheckedAt = now
	m.updateMu.Unlock()

	info := checkLatestRelease(ctx, m.build.Version)

	m.updateMu.Lock()
	m.updateInfo = info
	m.updateMu.Unlock()
	return info
}

func (m *Dashboard) currentUpdateInfo() UpdateInfo {
	m.updateMu.Lock()
	defer m.updateMu.Unlock()
	if m.updateInfo.RepoURL == "" {
		m.updateInfo = defaultUpdateInfo(m.build.Version)
	}
	return m.updateInfo
}

func (m *Dashboard) StartRequest(route, model string, stream bool) string {
	now := time.Now()
	seq := atomic.AddUint64(&m.requestSeq, 1)
	id := "req_" + strconv.FormatInt(now.UnixNano(), 10) + "_" + strconv.FormatUint(seq, 10)

	m.requestMu.Lock()
	m.requests = append(m.requests, RequestSummary{
		ID:        id,
		Route:     route,
		Model:     model,
		Stream:    stream,
		StartedAt: now,
	})
	if len(m.requests) > maxRequestHistory {
		m.requests = m.requests[len(m.requests)-maxRequestHistory:]
	}
	requests := m.copyRequestsLocked()
	m.requestMu.Unlock()

	m.updateSnapshotRequests(requests)
	return id
}

func (m *Dashboard) FinishRequest(id string, status int, responseBytes int64, usage *TokenUsage, errText string) {
	ended := time.Now()

	m.requestMu.Lock()
	for i := len(m.requests) - 1; i >= 0; i-- {
		if m.requests[i].ID != id {
			continue
		}
		slotIDs, taskIDs, promptCacheTokens := m.inferRequestSlots(m.requests[i].StartedAt, ended)
		m.requests[i].EndedAt = &ended
		m.requests[i].DurationMS = ended.Sub(m.requests[i].StartedAt).Milliseconds()
		m.requests[i].Status = status
		m.requests[i].ResponseBytes = responseBytes
		m.requests[i].Usage = usage
		m.requests[i].SlotIDs = slotIDs
		m.requests[i].TaskIDs = taskIDs
		m.requests[i].PromptCacheTokens = promptCacheTokens
		m.requests[i].Error = errText
		break
	}
	requests := m.copyRequestsLocked()
	m.requestMu.Unlock()

	m.updateSnapshotRequests(requests)
}

func (m *Dashboard) inferRequestSlots(started, ended time.Time) ([]int, []int, int) {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	startMS := started.Add(-500 * time.Millisecond).UnixMilli()
	endMS := ended.Add(500 * time.Millisecond).UnixMilli()
	slotSet := map[int]bool{}
	taskSet := map[int]bool{}
	maxPromptCache := 0
	for slotID, points := range m.slotHistory {
		for _, point := range points {
			if point.T < startMS || point.T > endMS || !point.IsProcessing {
				continue
			}
			slotSet[slotID] = true
			if point.TaskID > 0 {
				taskSet[point.TaskID] = true
			}
			if point.PromptCacheTokens > maxPromptCache {
				maxPromptCache = point.PromptCacheTokens
			}
		}
	}
	slotIDs := sortedIntKeys(slotSet)
	taskIDs := sortedIntKeys(taskSet)
	return slotIDs, taskIDs, maxPromptCache
}

func sortedIntKeys(values map[int]bool) []int {
	out := make([]int, 0, len(values))
	for value := range values {
		out = append(out, value)
	}
	sort.Ints(out)
	return out
}

func (m *Dashboard) copyRequests() []RequestSummary {
	m.requestMu.Lock()
	defer m.requestMu.Unlock()
	return m.copyRequestsLocked()
}

func (m *Dashboard) copyRequestsLocked() []RequestSummary {
	out := make([]RequestSummary, len(m.requests))
	for i, request := range m.requests {
		out[i] = request
		if request.EndedAt != nil {
			ended := *request.EndedAt
			out[i].EndedAt = &ended
		}
		if request.Usage != nil {
			usage := *request.Usage
			out[i].Usage = &usage
		}
		if request.SlotIDs != nil {
			out[i].SlotIDs = append([]int(nil), request.SlotIDs...)
		}
		if request.TaskIDs != nil {
			out[i].TaskIDs = append([]int(nil), request.TaskIDs...)
		}
	}
	return out
}

func (m *Dashboard) updateSnapshotRequests(requests []RequestSummary) {
	m.mu.Lock()
	m.snapshot.Requests = requests
	m.mu.Unlock()
}

func (m *Dashboard) poll(parent context.Context) {
	cfg := m.runtimeConfig()
	client := m.runtimeClient()
	ctx, cancel := context.WithTimeout(parent, cfg.Timeout*4)
	defer cancel()

	previous := m.Snapshot()
	pollAt := time.Now()
	pollSlow := m.lastSlowPoll.IsZero() || pollAt.Sub(m.lastSlowPoll) >= slowPollInterval
	endpoints := copyProbes(previous.Endpoints)
	lastErrors := copyStringMap(previous.LastErrors)
	update := m.currentUpdateInfo()
	warnings := []string{}
	mode := previous.Mode
	if mode == "" {
		mode = "single"
	}

	healthProbe, _ := client.Get(ctx, "/health")
	endpoints["health"] = healthProbe
	if !healthProbe.OK {
		lastErrors["health"] = healthProbe.Error
	} else {
		delete(lastErrors, "health")
	}

	props := previous.Props
	if pollSlow {
		propsProbe, propsBody := client.Get(ctx, "/props")
		endpoints["props"] = propsProbe
		if propsProbe.OK {
			parsed, err := llamacpp.DecodeProps(propsBody)
			if err != nil {
				propsProbe.OK = false
				propsProbe.Error = err.Error()
				endpoints["props"] = propsProbe
				lastErrors["props"] = err.Error()
			} else {
				props = parsed
				delete(lastErrors, "props")
			}
		} else {
			lastErrors["props"] = propsProbe.Error
		}
	}

	metricsProbe, metricsBody := client.Get(ctx, "/metrics")
	metricsAt := time.Now()
	endpoints["metrics"] = metricsProbe
	rawMetrics := map[string]float64{}
	metrics := llamacpp.MetricsSummary{}
	if metricsProbe.OK {
		rawMetrics = llamacpp.ParsePrometheus(string(metricsBody))
		metrics = llamacpp.SummarizeMetrics(rawMetrics)
		delete(lastErrors, "metrics")
	} else {
		lastErrors["metrics"] = metricsProbe.Error
	}

	slotsProbe, slotsBody := client.Get(ctx, "/slots")
	endpoints["slots"] = slotsProbe
	slots := []llamacpp.Slot{}
	if slotsProbe.OK {
		parsed, err := llamacpp.DecodeSlots(slotsBody, m.previousSlot)
		if err != nil {
			slotsProbe.OK = false
			slotsProbe.Error = err.Error()
			endpoints["slots"] = slotsProbe
			lastErrors["slots"] = err.Error()
		} else {
			slots = parsed
			delete(lastErrors, "slots")
		}
	} else {
		lastErrors["slots"] = slotsProbe.Error
	}
	if slotsProbe.OK {
		slotPromptRate, slotGenerationRate, _ := m.deriveSlotLiveRates(time.Now(), slots)
		metrics.PromptTokensLivePerSec = slotPromptRate
		metrics.GenerationTokensLivePerSec = slotGenerationRate
	} else if metricsProbe.OK {
		metrics.PromptTokensLivePerSec, metrics.GenerationTokensLivePerSec = m.deriveLiveRates(metricsAt, metrics.PromptTokensTotal, metrics.GeneratedTokensTotal)
	}
	rawMetrics["nodrama:prompt_tokens_rate"] = metrics.PromptTokensLivePerSec
	rawMetrics["nodrama:tokens_predicted_rate"] = metrics.GenerationTokensLivePerSec
	history := m.recordMetricHistory(time.Now(), rawMetrics)
	metricFacts := m.copyMetricFacts()

	models := previous.Models
	if pollSlow {
		modelsProbe, modelsBody := client.Get(ctx, "/v1/models")
		endpoints["models"] = modelsProbe
		if modelsProbe.OK {
			parsed, err := llamacpp.DecodeModels(modelsBody)
			if err != nil {
				modelsProbe.OK = false
				modelsProbe.Error = err.Error()
				endpoints["models"] = modelsProbe
				lastErrors["models"] = err.Error()
			} else {
				models = parsed
				delete(lastErrors, "models")
			}
		} else {
			lastErrors["models"] = modelsProbe.Error
		}
	}

	routerModels := previous.RouterModels
	if pollSlow {
		routerProbe, routerBody := client.Get(ctx, "/models")
		endpoints["routerModels"] = routerProbe
		if routerProbe.OK {
			parsed, isRouter, err := llamacpp.DecodeRouterModels(routerBody)
			if err != nil {
				routerProbe.OK = false
				routerProbe.Error = err.Error()
				endpoints["routerModels"] = routerProbe
				lastErrors["routerModels"] = err.Error()
			} else {
				routerModels = parsed
				delete(lastErrors, "routerModels")
				if isRouter {
					mode = "router"
				} else {
					mode = "single"
				}
			}
		} else if routerProbe.Status != http.StatusNotFound && routerProbe.Status != http.StatusNotImplemented {
			lastErrors["routerModels"] = routerProbe.Error
		}
	}

	loraAdapters := previous.LoraAdapters
	if pollSlow {
		loraProbe, loraBody := client.Get(ctx, "/lora-adapters")
		endpoints["loraAdapters"] = loraProbe
		if loraProbe.OK {
			parsed, err := llamacpp.DecodeLoraAdapters(loraBody)
			if err != nil {
				loraProbe.OK = false
				loraProbe.Error = err.Error()
				endpoints["loraAdapters"] = loraProbe
				lastErrors["loraAdapters"] = err.Error()
			} else {
				loraAdapters = parsed
				delete(lastErrors, "loraAdapters")
			}
		} else if loraProbe.Status != http.StatusNotFound && loraProbe.Status != http.StatusNotImplemented {
			lastErrors["loraAdapters"] = loraProbe.Error
		} else {
			delete(lastErrors, "loraAdapters")
		}
	}

	gpuSnapshot := previous.GPU
	if pollSlow {
		gpuSnapshot = gpu.Collect(ctx)
		update = m.updateReleaseInfo(ctx, pollAt)
		m.lastSlowPoll = pollAt
	}
	if probe, ok := endpoints["props"]; ok && !probe.OK {
		warnings = append(warnings, "llama.cpp /props is unavailable; configuration cards are degraded.")
	}
	if !metricsProbe.OK {
		warnings = append(warnings, "llama.cpp /metrics is unavailable; throughput and queue cards are degraded.")
	}
	if !slotsProbe.OK {
		warnings = append(warnings, "llama.cpp /slots is unavailable; slot cards cannot be rendered.")
	}
	if !gpuSnapshot.Available {
		warnings = append(warnings, "nvidia-smi is unavailable; GPU telemetry is degraded.")
	}

	busySlots := 0
	for _, slot := range slots {
		if slot.IsProcessing {
			busySlots++
		}
	}
	totalSlots := props.TotalSlots
	if totalSlots == 0 {
		totalSlots = len(slots)
	}

	modelAlias := props.ModelAlias
	if modelAlias == "" && len(models) > 0 {
		modelAlias = models[0].ID
	}
	snapshotAt := time.Now()
	events := previous.Events
	if cfg.LogPath != "" {
		parsedEvents, err := m.pollLogEvents(cfg.LogPath, snapshotAt)
		if err != nil {
			warnings = append(warnings, "Configured llama.cpp log could not be read: "+err.Error())
		}
		events = parsedEvents
	}
	history = m.recordSlotHistory(snapshotAt, slots, modelAlias)
	propsOK := false
	if probe, ok := endpoints["props"]; ok {
		propsOK = probe.OK
	}

	overview := Overview{
		Online:                 healthProbe.OK || propsOK || slotsProbe.OK,
		RequestsProcessing:     metrics.RequestsProcessing,
		RequestsDeferred:       metrics.RequestsDeferred,
		PromptTokensPerSec:     metrics.PromptTokensLivePerSec,
		GenerationTokensPerSec: metrics.GenerationTokensLivePerSec,
		BusySlots:              busySlots,
		TotalSlots:             totalSlots,
		PromptTokensTotal:      metrics.PromptTokensTotal,
		GeneratedTokensTotal:   metrics.GeneratedTokensTotal,
		ContextTokens:          props.ContextTokens,
		ModelAlias:             modelAlias,
	}

	if !overview.Online {
		warnings = append(warnings, "No llama.cpp endpoint is reachable.")
	}
	if metrics.RequestsDeferred > 0 {
		warnings = append(warnings, "Requests are deferred; clients are waiting for free slots.")
	}
	if totalSlots > 0 && busySlots == totalSlots {
		warnings = append(warnings, "All slots are currently busy.")
	}
	suggestions := m.evaluateSuggestions(snapshotAt, mode, overview, props, metrics, slots, history, routerModels, loraAdapters)

	nextPrevious := map[int]llamacpp.Slot{}
	for _, slot := range slots {
		nextPrevious[slot.ID] = slot
	}

	requests := m.copyRequests()
	snapshot := Snapshot{
		App:            "llama.nodrama",
		Build:          m.build,
		Mode:           mode,
		Server:         cfg.Server,
		PollIntervalMS: cfg.PollInterval.Milliseconds(),
		StartedAt:      m.started,
		UpdatedAt:      snapshotAt,
		Endpoints:      endpoints,
		Overview:       overview,
		Props:          props,
		Metrics:        metrics,
		Models:         models,
		RouterModels:   routerModels,
		LoraAdapters:   loraAdapters,
		Slots:          slots,
		GPU:            gpuSnapshot,
		History:        history,
		MetricFacts:    metricFacts,
		Suggestions:    suggestions,
		Requests:       requests,
		Queries:        m.updateQueries(snapshotAt, modelAlias, slots, requests, events),
		Events:         events,
		Warnings:       warnings,
		RawMetrics:     rawMetrics,
		LastErrors:     lastErrors,
		Update:         update,
	}

	m.mu.Lock()
	m.snapshot = snapshot
	m.previousSlot = nextPrevious
	m.mu.Unlock()
}
