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
	"llama.nodrama/nodrama/internal/system"
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
	PromptCache    *PromptCacheSummary       `json:"promptCache,omitempty"`
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
	PeakValue   float64    `json:"peakValue,omitempty"`
	PeakAt      *time.Time `json:"peakAt,omitempty"`
	Peak5mValue float64    `json:"peak5mValue,omitempty"`
	Peak5mAt    *time.Time `json:"peak5mAt,omitempty"`
}

type ContextUsage struct {
	UsedTokens     int     `json:"usedTokens"`
	CapacityTokens int     `json:"capacityTokens"`
	Ratio          float64 `json:"ratio"`
	Source         string  `json:"source,omitempty"`
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
	CacheKey            string     `json:"cacheKey,omitempty"`
	PromptTokens        int        `json:"promptTokens,omitempty"`
	CompletionTokens    int        `json:"completionTokens,omitempty"`
	TotalTokens         int        `json:"totalTokens,omitempty"`
	PromptCacheTokens   int        `json:"promptCacheTokens,omitempty"`
	CacheRestoredTokens int        `json:"cacheRestoredTokens,omitempty"`
	CacheReuseRatio     float64    `json:"cacheReuseRatio,omitempty"`
	CacheCached         bool       `json:"cacheCached,omitempty"`
	CacheReuseCount     int        `json:"cacheReuseCount,omitempty"`
	CurrentTokensPerSec float64    `json:"currentTokensPerSec,omitempty"`
	LastTimingEventAt   *time.Time `json:"lastTimingEventAt,omitempty"`
	LastCacheAction     string     `json:"lastCacheAction,omitempty"`
	LastCacheReuseAt    *time.Time `json:"lastCacheReuseAt,omitempty"`
	LastCacheEventAt    *time.Time `json:"lastCacheEventAt,omitempty"`
	LastEventAt         *time.Time `json:"lastEventAt,omitempty"`
	Error               string     `json:"error,omitempty"`

	cacheRestoreEvents        int
	cacheRestoreEventsCounted int
}

type PromptCacheSummary struct {
	Available          bool               `json:"available"`
	UpdatedAt          *time.Time         `json:"updatedAt,omitempty"`
	PromptCount        int                `json:"promptCount,omitempty"`
	ObservedEntries    int                `json:"observedEntries,omitempty"`
	Complete           bool               `json:"complete"`
	UsedMiB            float64            `json:"usedMiB,omitempty"`
	LimitMiB           float64            `json:"limitMiB,omitempty"`
	LimitTokens        int                `json:"limitTokens,omitempty"`
	EstTokens          int                `json:"estTokens,omitempty"`
	UsedTokensEstimate int                `json:"usedTokensEstimate,omitempty"`
	TopEntries         []PromptCacheEntry `json:"topEntries,omitempty"`
	Other              *PromptCacheEntry  `json:"other,omitempty"`
	UntrackedMiB       float64            `json:"untrackedMiB,omitempty"`
	UnusedMiB          float64            `json:"unusedMiB,omitempty"`
}

type PromptCacheEntry struct {
	Key            string     `json:"key,omitempty"`
	Count          int        `json:"count,omitempty"`
	Tokens         int        `json:"tokens,omitempty"`
	Checkpoints    int        `json:"checkpoints,omitempty"`
	MiB            float64    `json:"mib,omitempty"`
	LastSlotID     *int       `json:"lastSlotId,omitempty"`
	LastTaskID     *int       `json:"lastTaskId,omitempty"`
	LastUsedAt     *time.Time `json:"lastUsedAt,omitempty"`
	PercentOfLimit float64    `json:"percentOfLimit,omitempty"`
	PercentOfUsed  float64    `json:"percentOfUsed,omitempty"`
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
	ContextUsedTokens      int     `json:"contextUsedTokens"`
	ContextCapacityTokens  int     `json:"contextCapacityTokens"`
	ContextUsedRatio       float64 `json:"contextUsedRatio"`
	ContextCapacitySource  string  `json:"contextCapacitySource,omitempty"`
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
	slotLogRates   map[int]slotLogRate
	metricHistory  map[string][]HistoryPoint
	metricRecent   map[string][]HistoryPoint
	metricLong     map[string][]HistoryPoint
	metricFacts    map[string]MetricFact
	cpuLast        cpuUsageSample
	cpuLastOK      bool
	slotHistory    map[int][]SlotHistoryPoint
	logOffset      int64
	logInitialized bool
	logPartial     string
	logEventSeq    uint64
	logEvents      []llamacpp.LogEvent
	promptCache    PromptCacheSummary
	promptCacheMap map[string]PromptCacheEntry

	requestSeq uint64
	requestMu  sync.Mutex
	requests   []RequestSummary

	queryMu         sync.Mutex
	queries         map[string]QuerySummary
	slotQuery       map[int]string
	lastSlotQuery   map[int]string
	taskQuery       map[int]string
	seenQueryEvents map[string]bool
	pendingCacheKey string
	pendingCacheAt  time.Time

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

type slotLogRate struct {
	taskID                 int
	at                     time.Time
	generationTokensPerSec float64
}

type cpuUsageSample struct {
	at        time.Time
	usageUsec uint64
	cpus      float64
}

const (
	liveRateWindow       = 5 * time.Second
	slotLogRateFreshness = 7 * time.Second
	metricHistoryWindow  = time.Minute
	metricRecentWindow   = 5 * time.Minute
	metricLongWindow     = 24 * time.Hour
	metricLongInterval   = 5 * time.Second
	slowPollInterval     = 5 * time.Second
	maxMetricHistorySize = 600
	maxMetricRecentSize  = 2000
	maxMetricLongSize    = 20000
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
		slotLogRates:    map[int]slotLogRate{},
		metricHistory:   map[string][]HistoryPoint{},
		metricRecent:    map[string][]HistoryPoint{},
		metricLong:      map[string][]HistoryPoint{},
		metricFacts:     map[string]MetricFact{},
		slotHistory:     map[int][]SlotHistoryPoint{},
		promptCacheMap:  map[string]PromptCacheEntry{},
		queries:         map[string]QuerySummary{},
		slotQuery:       map[int]string{},
		lastSlotQuery:   map[int]string{},
		taskQuery:       map[int]string{},
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
	if m.slotLogRates == nil {
		m.slotLogRates = map[int]slotLogRate{}
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
		if !slot.IsProcessing {
			m.slotLiveRates[slot.ID] = liveRate
			continue
		}

		if logRate, ok := m.freshSlotLogRateLocked(now, slot); ok {
			liveRate.generationTokensPerSec = logRate
			generationRate += logRate
			hasRate = true
		}

		if !ok || !previous.isProcessing {
			m.slotLiveRates[slot.ID] = liveRate
			continue
		}
		sameTask := slot.TaskID > 0 && previous.taskID > 0 && slot.TaskID == previous.taskID
		if !sameTask {
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
		if liveRate.generationTokensPerSec == 0 {
			decodedDelta := slot.DecodedTokens - previous.decodedTokens
			if decodedDelta > 0 {
				liveRate.generationTokensPerSec = float64(decodedDelta) / elapsed
				generationRate += liveRate.generationTokensPerSec
				hasRate = true
			}
		}
		m.slotLiveRates[slot.ID] = liveRate
	}
	for slotID := range m.slotRateLast {
		if !seen[slotID] {
			delete(m.slotRateLast, slotID)
			delete(m.slotLiveRates, slotID)
		}
	}
	for slotID, rate := range m.slotLogRates {
		if !seen[slotID] || now.Sub(rate.at) > slotLogRateFreshness*2 {
			delete(m.slotLogRates, slotID)
		}
	}
	return promptRate, generationRate, hasRate
}

func (m *Dashboard) freshSlotLogRateLocked(now time.Time, slot llamacpp.Slot) (float64, bool) {
	rate, ok := m.slotLogRates[slot.ID]
	if !ok || rate.generationTokensPerSec <= 0 {
		return 0, false
	}
	if rate.at.IsZero() || now.Sub(rate.at) > slotLogRateFreshness {
		return 0, false
	}
	if slot.TaskID > 0 && rate.taskID > 0 && slot.TaskID != rate.taskID {
		return 0, false
	}
	return rate.generationTokensPerSec, true
}

func (m *Dashboard) recordMetricHistory(now time.Time, metrics map[string]float64) SnapshotHistory {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	if m.metricHistory == nil {
		m.metricHistory = map[string][]HistoryPoint{}
	}
	if m.metricRecent == nil {
		m.metricRecent = map[string][]HistoryPoint{}
	}
	if m.metricLong == nil {
		m.metricLong = map[string][]HistoryPoint{}
	}
	if m.metricFacts == nil {
		m.metricFacts = map[string]MetricFact{}
	}

	t := now.UnixMilli()
	cutoff := now.Add(-metricHistoryWindow).UnixMilli()
	recentCutoff := now.Add(-metricRecentWindow).UnixMilli()
	longCutoff := now.Add(-metricLongWindow).UnixMilli()
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

		recent := append(m.metricRecent[name], HistoryPoint{T: t, V: value})
		recent = trimHistoryPoints(recent, recentCutoff)
		if len(recent) > maxMetricRecentSize {
			recent = recent[len(recent)-maxMetricRecentSize:]
		}
		m.metricRecent[name] = recent

		m.recordLongMetricHistoryLocked(name, t, value, longCutoff)
	}

	for name, points := range m.metricHistory {
		points = trimHistoryPoints(points, cutoff)
		if len(points) == 0 {
			delete(m.metricHistory, name)
			continue
		}
		m.metricHistory[name] = points
	}
	for name, points := range m.metricRecent {
		points = trimHistoryPoints(points, recentCutoff)
		if len(points) == 0 {
			delete(m.metricRecent, name)
			continue
		}
		m.metricRecent[name] = points
	}
	for name, points := range m.metricLong {
		points = trimHistoryPoints(points, longCutoff)
		if len(points) == 0 {
			delete(m.metricLong, name)
			continue
		}
		if len(points) > maxMetricLongSize {
			points = points[len(points)-maxMetricLongSize:]
		}
		m.metricLong[name] = points
	}

	return m.copyHistoryLocked()
}

func (m *Dashboard) recordLongMetricHistoryLocked(name string, t int64, value float64, cutoff int64) {
	bucket := (t / metricLongInterval.Milliseconds()) * metricLongInterval.Milliseconds()
	points := trimHistoryPoints(m.metricLong[name], cutoff)
	if len(points) > 0 {
		last := &points[len(points)-1]
		lastBucket := (last.T / metricLongInterval.Milliseconds()) * metricLongInterval.Milliseconds()
		if lastBucket == bucket {
			// Keep the highest value within each bucket so short spikes are not flattened away.
			if value >= last.V {
				last.T = t
				last.V = value
			}
			m.metricLong[name] = points
			return
		}
	}
	points = append(points, HistoryPoint{T: t, V: value})
	if len(points) > maxMetricLongSize {
		points = points[len(points)-maxMetricLongSize:]
	}
	m.metricLong[name] = points
}

func (m *Dashboard) copyMetricFacts() map[string]MetricFact {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	out := make(map[string]MetricFact, len(m.metricFacts))
	for name, fact := range m.metricFacts {
		copied := MetricFact{
			PeakValue: fact.PeakValue,
			PeakAt:    cloneTimePtr(fact.PeakAt),
		}
		if peak, ok := peakHistoryPoint(m.metricRecent[name]); ok {
			peakAt := time.UnixMilli(peak.T)
			copied.Peak5mValue = peak.V
			copied.Peak5mAt = &peakAt
		}
		out[name] = copied
	}
	return out
}

func (m *Dashboard) recordContainerCPUPercent(now time.Time) (float64, bool) {
	stats, err := system.ReadContainerCPUStats()
	if err != nil || stats.CPUs <= 0 {
		m.cpuLastOK = false
		return 0, false
	}
	current := cpuUsageSample{at: now, usageUsec: stats.UsageUsec, cpus: stats.CPUs}
	if !m.cpuLastOK {
		m.cpuLast = current
		m.cpuLastOK = true
		return 0, false
	}
	previous := m.cpuLast
	m.cpuLast = current
	elapsedUsec := now.Sub(previous.at).Seconds() * 1_000_000
	if elapsedUsec <= 0 || stats.UsageUsec < previous.usageUsec {
		return 0, false
	}
	percent := (float64(stats.UsageUsec-previous.usageUsec) / (elapsedUsec * stats.CPUs)) * 100
	if math.IsNaN(percent) || math.IsInf(percent, 0) || percent < 0 {
		return 0, false
	}
	return percent, true
}

func peakHistoryPoint(points []HistoryPoint) (HistoryPoint, bool) {
	if len(points) == 0 {
		return HistoryPoint{}, false
	}
	peak := points[0]
	for _, point := range points[1:] {
		if point.V >= peak.V {
			peak = point
		}
	}
	return peak, true
}

func activeContextUsage(slots []llamacpp.Slot, props llamacpp.PropsSummary, events []llamacpp.LogEvent, processContextTokens int) ContextUsage {
	used := 0
	slotCapacity := 0
	for _, slot := range slots {
		if slot.ContextTokens > slotCapacity {
			slotCapacity = slot.ContextTokens
		}
		if slot.IsProcessing && slot.ContextEstimateTokens > 0 {
			used += slot.ContextEstimateTokens
		}
	}

	capacity := 0
	source := ""
	if event := latestDeploymentContextEvent(events); event != nil && event.DeploymentCtx > 0 {
		capacity = event.DeploymentCtx
		source = "deployment context"
	} else if processContextTokens > 0 {
		capacity = processContextTokens
		source = "process args"
	} else if event := latestCacheStateEvent(events); event != nil && event.CacheLimitTokens > 0 {
		capacity = event.CacheLimitTokens
		source = "shared cache limit"
	} else if props.ContextTokens > 0 {
		capacity = props.ContextTokens
		source = "props context fallback"
	} else if slotCapacity > 0 {
		capacity = slotCapacity
		source = "slot capacity fallback"
	}

	ratio := 0.0
	if capacity > 0 {
		ratio = float64(used) / float64(capacity)
	}
	return ContextUsage{
		UsedTokens:     used,
		CapacityTokens: capacity,
		Ratio:          ratio,
		Source:         source,
	}
}

func latestDeploymentContextEvent(events []llamacpp.LogEvent) *llamacpp.LogEvent {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].DeploymentCtx > 0 {
			return &events[i]
		}
	}
	return nil
}

func latestCacheStateEvent(events []llamacpp.LogEvent) *llamacpp.LogEvent {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].CacheLimitTokens > 0 {
			return &events[i]
		}
	}
	return nil
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

func (m *Dashboard) MetricHistory(metric string, since time.Time, maxPoints int) []HistoryPoint {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	if maxPoints <= 0 {
		maxPoints = 2000
	}
	if maxPoints > maxMetricLongSize {
		maxPoints = maxMetricLongSize
	}
	cutoff := since.UnixMilli()
	points := trimHistoryPoints(m.metricLong[metric], cutoff)
	recent := trimHistoryPoints(m.metricRecent[metric], cutoff)
	if len(recent) > 0 {
		recentStart := recent[0].T
		older := trimHistoryPointsBefore(points, recentStart)
		if len(recent) >= maxPoints {
			out := make([]HistoryPoint, len(recent))
			copy(out, recent)
			return limitHistoryPoints(out, maxPoints)
		}
		older = limitHistoryPoints(older, maxPoints-len(recent))
		combined := make([]HistoryPoint, 0, len(older)+len(recent))
		combined = append(combined, older...)
		combined = append(combined, recent...)
		points = combined
	} else if len(points) == 0 {
		points = trimHistoryPoints(m.metricHistory[metric], cutoff)
	}
	out := make([]HistoryPoint, len(points))
	copy(out, points)
	return limitHistoryPoints(out, maxPoints)
}

func trimHistoryPointsBefore(points []HistoryPoint, before int64) []HistoryPoint {
	i := 0
	for i < len(points) && points[i].T < before {
		i++
	}
	return points[:i]
}

func limitHistoryPoints(points []HistoryPoint, maxPoints int) []HistoryPoint {
	if maxPoints <= 0 || len(points) <= maxPoints {
		return points
	}
	bucketSize := int(math.Ceil(float64(len(points)) / float64(maxPoints)))
	if bucketSize < 1 {
		bucketSize = 1
	}
	out := make([]HistoryPoint, 0, maxPoints)
	for start := 0; start < len(points); start += bucketSize {
		end := start + bucketSize
		if end > len(points) {
			end = len(points)
		}
		peak := points[start]
		for _, point := range points[start+1 : end] {
			if point.V >= peak.V {
				peak = point
			}
		}
		out = append(out, peak)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].T < out[j].T })
	if len(out) > maxPoints {
		out = out[len(out)-maxPoints:]
	}
	return out
}

func (m *Dashboard) ResetHistory() {
	m.historyMu.Lock()
	m.rateHistory = nil
	m.metricHistory = map[string][]HistoryPoint{}
	m.metricRecent = map[string][]HistoryPoint{}
	m.metricLong = map[string][]HistoryPoint{}
	m.metricFacts = map[string]MetricFact{}
	m.cpuLast = cpuUsageSample{}
	m.cpuLastOK = false
	m.slotHistory = map[int][]SlotHistoryPoint{}
	m.slotLiveRates = map[int]slotLiveRate{}
	m.logEvents = nil
	m.logEventSeq = 0
	m.logOffset = 0
	m.logInitialized = false
	m.logPartial = ""
	m.resetPromptCacheLocked()
	empty := m.copyHistoryLocked()
	m.historyMu.Unlock()

	m.mu.Lock()
	m.snapshot.History = empty
	m.snapshot.MetricFacts = nil
	m.snapshot.PromptCache = nil
	m.snapshot.Events = nil
	m.snapshot.Queries = nil
	m.mu.Unlock()

	m.queryMu.Lock()
	m.queries = map[string]QuerySummary{}
	m.slotQuery = map[int]string{}
	m.lastSlotQuery = map[int]string{}
	m.taskQuery = map[int]string{}
	m.seenQueryEvents = map[string]bool{}
	m.pendingCacheKey = ""
	m.pendingCacheAt = time.Time{}
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
				props = llamacpp.PropsSummary{}
			} else {
				props = parsed
				delete(lastErrors, "props")
			}
		} else {
			lastErrors["props"] = propsProbe.Error
			props = llamacpp.PropsSummary{}
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

	snapshotAt := time.Now()
	events := previous.Events
	if cfg.LogPath != "" {
		parsedEvents, err := m.pollLogEvents(cfg.LogPath, snapshotAt)
		if err != nil {
			warnings = append(warnings, "Configured llama.cpp log could not be read: "+err.Error())
		}
		events = parsedEvents
	}
	promptCache := m.copyPromptCache()
	processContextTokens := 0
	if previous.Overview.ContextCapacitySource == "process args" {
		processContextTokens = previous.Overview.ContextCapacityTokens
	}
	if pollSlow || processContextTokens == 0 {
		processContextTokens = localLlamaServerContextTokens(cfg.Server)
	}
	contextUsage := activeContextUsage(slots, props, events, processContextTokens)
	rawMetrics["nodrama:prompt_tokens_rate"] = metrics.PromptTokensLivePerSec
	rawMetrics["nodrama:tokens_predicted_rate"] = metrics.GenerationTokensLivePerSec
	rawMetrics["nodrama:context_active_tokens"] = float64(contextUsage.UsedTokens)
	rawMetrics["nodrama:context_active_capacity_tokens"] = float64(contextUsage.CapacityTokens)
	rawMetrics["nodrama:context_active_ratio"] = contextUsage.Ratio
	if cpuPercent, ok := m.recordContainerCPUPercent(snapshotAt); ok {
		rawMetrics["nodrama:container_cpu_percent"] = cpuPercent
	}
	history := m.recordMetricHistory(snapshotAt, rawMetrics)
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
		ContextUsedTokens:      contextUsage.UsedTokens,
		ContextCapacityTokens:  contextUsage.CapacityTokens,
		ContextUsedRatio:       contextUsage.Ratio,
		ContextCapacitySource:  contextUsage.Source,
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
	suggestions := m.evaluateSuggestions(snapshotAt, mode, overview, props, metrics, slots, history, routerModels, loraAdapters, lastErrors, events, cfg.LogPath)

	nextPrevious := map[int]llamacpp.Slot{}
	for _, slot := range slots {
		nextPrevious[slot.ID] = slot
	}

	requests := m.copyRequests()
	queries := m.updateQueries(snapshotAt, modelAlias, slots, slotsProbe.OK, metricsProbe.OK && metrics.RequestsDeferred <= 0, requests, events)
	promptCache = annotatePromptCacheUsage(promptCache, queries)
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
		PromptCache:    promptCache,
		Suggestions:    suggestions,
		Requests:       requests,
		Queries:        queries,
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
