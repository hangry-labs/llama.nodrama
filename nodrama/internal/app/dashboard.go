package app

import (
	"context"
	"math"
	"net/http"
	"sync"
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
	Warnings       []string                  `json:"warnings"`
	RawMetrics     map[string]float64        `json:"rawMetrics,omitempty"`
	LastErrors     map[string]string         `json:"lastErrors,omitempty"`
}

type SnapshotHistory struct {
	Metrics map[string][]HistoryPoint `json:"metrics"`
}

type HistoryPoint struct {
	T int64   `json:"t"`
	V float64 `json:"v"`
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
	client  *llamacpp.Client
	cfg     Config
	build   BuildInfo
	started time.Time

	mu           sync.RWMutex
	snapshot     Snapshot
	previousSlot map[int]llamacpp.Slot

	historyMu     sync.Mutex
	rateHistory   []metricRateSample
	metricHistory map[string][]HistoryPoint
}

type metricRateSample struct {
	at             time.Time
	promptTotal    float64
	generatedTotal float64
}

const (
	liveRateWindow       = 5 * time.Second
	metricHistoryWindow  = time.Minute
	maxMetricHistorySize = 600
)

func NewDashboard(client *llamacpp.Client, cfg Config, build BuildInfo) *Dashboard {
	now := time.Now()
	return &Dashboard{
		client:        client,
		cfg:           cfg,
		build:         build,
		started:       now,
		previousSlot:  map[int]llamacpp.Slot{},
		metricHistory: map[string][]HistoryPoint{},
		snapshot: Snapshot{
			App:            "llama.nodrama",
			Build:          build,
			Mode:           "single",
			Server:         cfg.Server,
			PollIntervalMS: cfg.PollInterval.Milliseconds(),
			StartedAt:      now,
			UpdatedAt:      now,
			Endpoints:      map[string]llamacpp.Probe{},
			History:        SnapshotHistory{Metrics: map[string][]HistoryPoint{}},
			Warnings:       []string{"Waiting for first poll."},
		},
	}
}

func (m *Dashboard) StartedAt() time.Time {
	return m.started
}

func (m *Dashboard) Start(ctx context.Context) {
	go func() {
		m.poll(ctx)
		ticker := time.NewTicker(m.cfg.PollInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				m.poll(ctx)
			}
		}
	}()
}

func (m *Dashboard) Snapshot() Snapshot {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.snapshot
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

func (m *Dashboard) recordMetricHistory(now time.Time, metrics map[string]float64) SnapshotHistory {
	m.historyMu.Lock()
	defer m.historyMu.Unlock()

	if m.metricHistory == nil {
		m.metricHistory = map[string][]HistoryPoint{}
	}

	t := now.UnixMilli()
	cutoff := now.Add(-metricHistoryWindow).UnixMilli()
	for name, value := range metrics {
		if math.IsNaN(value) || math.IsInf(value, 0) {
			continue
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

	return m.copyMetricHistoryLocked()
}

func trimHistoryPoints(points []HistoryPoint, cutoff int64) []HistoryPoint {
	i := 0
	for i < len(points) && points[i].T < cutoff {
		i++
	}
	return points[i:]
}

func (m *Dashboard) copyMetricHistoryLocked() SnapshotHistory {
	out := SnapshotHistory{Metrics: make(map[string][]HistoryPoint, len(m.metricHistory))}
	for name, points := range m.metricHistory {
		copied := make([]HistoryPoint, len(points))
		copy(copied, points)
		out.Metrics[name] = copied
	}
	return out
}

func (m *Dashboard) ResetHistory() {
	m.historyMu.Lock()
	m.rateHistory = nil
	m.metricHistory = map[string][]HistoryPoint{}
	empty := m.copyMetricHistoryLocked()
	m.historyMu.Unlock()

	m.mu.Lock()
	m.snapshot.History = empty
	m.mu.Unlock()
}

func (m *Dashboard) poll(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, m.cfg.Timeout*4)
	defer cancel()

	endpoints := map[string]llamacpp.Probe{}
	lastErrors := map[string]string{}
	warnings := []string{}
	mode := "single"

	healthProbe, _ := m.client.Get(ctx, "/health")
	endpoints["health"] = healthProbe
	if !healthProbe.OK {
		lastErrors["health"] = healthProbe.Error
	}

	propsProbe, propsBody := m.client.Get(ctx, "/props")
	endpoints["props"] = propsProbe
	props := llamacpp.PropsSummary{}
	if propsProbe.OK {
		parsed, err := llamacpp.DecodeProps(propsBody)
		if err != nil {
			propsProbe.OK = false
			propsProbe.Error = err.Error()
			endpoints["props"] = propsProbe
			lastErrors["props"] = err.Error()
		} else {
			props = parsed
		}
	} else {
		lastErrors["props"] = propsProbe.Error
		warnings = append(warnings, "llama.cpp /props is unavailable; configuration cards are degraded.")
	}

	metricsProbe, metricsBody := m.client.Get(ctx, "/metrics")
	metricsAt := time.Now()
	endpoints["metrics"] = metricsProbe
	rawMetrics := map[string]float64{}
	metrics := llamacpp.MetricsSummary{}
	if metricsProbe.OK {
		rawMetrics = llamacpp.ParsePrometheus(string(metricsBody))
		metrics = llamacpp.SummarizeMetrics(rawMetrics)
		metrics.PromptTokensLivePerSec, metrics.GenerationTokensLivePerSec = m.deriveLiveRates(metricsAt, metrics.PromptTokensTotal, metrics.GeneratedTokensTotal)
		rawMetrics["nodrama:prompt_tokens_rate"] = metrics.PromptTokensLivePerSec
		rawMetrics["nodrama:tokens_predicted_rate"] = metrics.GenerationTokensLivePerSec
	} else {
		lastErrors["metrics"] = metricsProbe.Error
		warnings = append(warnings, "llama.cpp /metrics is unavailable; throughput and queue cards are degraded.")
	}
	history := m.recordMetricHistory(metricsAt, rawMetrics)

	slotsProbe, slotsBody := m.client.Get(ctx, "/slots")
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
		}
	} else {
		lastErrors["slots"] = slotsProbe.Error
		warnings = append(warnings, "llama.cpp /slots is unavailable; slot cards cannot be rendered.")
	}

	modelsProbe, modelsBody := m.client.Get(ctx, "/v1/models")
	endpoints["models"] = modelsProbe
	models := []llamacpp.ModelSummary{}
	if modelsProbe.OK {
		parsed, err := llamacpp.DecodeModels(modelsBody)
		if err != nil {
			modelsProbe.OK = false
			modelsProbe.Error = err.Error()
			endpoints["models"] = modelsProbe
			lastErrors["models"] = err.Error()
		} else {
			models = parsed
		}
	} else {
		lastErrors["models"] = modelsProbe.Error
	}

	routerProbe, routerBody := m.client.Get(ctx, "/models")
	endpoints["routerModels"] = routerProbe
	routerModels := []map[string]any{}
	if routerProbe.OK {
		parsed, isRouter, err := llamacpp.DecodeRouterModels(routerBody)
		if err != nil {
			routerProbe.OK = false
			routerProbe.Error = err.Error()
			endpoints["routerModels"] = routerProbe
			lastErrors["routerModels"] = err.Error()
		} else {
			routerModels = parsed
			if isRouter {
				mode = "router"
			}
		}
	} else if routerProbe.Status != http.StatusNotFound && routerProbe.Status != http.StatusNotImplemented {
		lastErrors["routerModels"] = routerProbe.Error
	}

	loraProbe, loraBody := m.client.Get(ctx, "/lora-adapters")
	endpoints["loraAdapters"] = loraProbe
	loraAdapters := []map[string]any{}
	if loraProbe.OK {
		parsed, err := llamacpp.DecodeLoraAdapters(loraBody)
		if err != nil {
			loraProbe.OK = false
			loraProbe.Error = err.Error()
			endpoints["loraAdapters"] = loraProbe
			lastErrors["loraAdapters"] = err.Error()
		} else {
			loraAdapters = parsed
		}
	} else if loraProbe.Status != http.StatusNotFound && loraProbe.Status != http.StatusNotImplemented {
		lastErrors["loraAdapters"] = loraProbe.Error
	}

	gpuSnapshot := gpu.Collect(ctx)
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

	overview := Overview{
		Online:                 healthProbe.OK || propsProbe.OK || slotsProbe.OK,
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

	nextPrevious := map[int]llamacpp.Slot{}
	for _, slot := range slots {
		nextPrevious[slot.ID] = slot
	}

	snapshot := Snapshot{
		App:            "llama.nodrama",
		Build:          m.build,
		Mode:           mode,
		Server:         m.cfg.Server,
		PollIntervalMS: m.cfg.PollInterval.Milliseconds(),
		StartedAt:      m.started,
		UpdatedAt:      time.Now(),
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
		Warnings:       warnings,
		RawMetrics:     rawMetrics,
		LastErrors:     lastErrors,
	}

	m.mu.Lock()
	m.snapshot = snapshot
	m.previousSlot = nextPrevious
	m.mu.Unlock()
}
