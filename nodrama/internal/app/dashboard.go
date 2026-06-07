package app

import (
	"context"
	"sync"
	"time"

	"llama.nodrama/nodrama/internal/gpu"
	"llama.nodrama/nodrama/internal/llamacpp"
)

type Snapshot struct {
	App            string                    `json:"app"`
	Build          BuildInfo                 `json:"build"`
	Server         string                    `json:"server"`
	PollIntervalMS int64                     `json:"pollIntervalMs"`
	StartedAt      time.Time                 `json:"startedAt"`
	UpdatedAt      time.Time                 `json:"updatedAt"`
	Endpoints      map[string]llamacpp.Probe `json:"endpoints"`
	Overview       Overview                  `json:"overview"`
	Props          llamacpp.PropsSummary     `json:"props"`
	Metrics        llamacpp.MetricsSummary   `json:"metrics"`
	Models         []llamacpp.ModelSummary   `json:"models"`
	Slots          []llamacpp.Slot           `json:"slots"`
	GPU            gpu.Snapshot              `json:"gpu"`
	Warnings       []string                  `json:"warnings"`
	RawMetrics     map[string]float64        `json:"rawMetrics,omitempty"`
	LastErrors     map[string]string         `json:"lastErrors,omitempty"`
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
}

func NewDashboard(client *llamacpp.Client, cfg Config, build BuildInfo) *Dashboard {
	now := time.Now()
	return &Dashboard{
		client:       client,
		cfg:          cfg,
		build:        build,
		started:      now,
		previousSlot: map[int]llamacpp.Slot{},
		snapshot: Snapshot{
			App:            "llama.nodrama",
			Build:          build,
			Server:         cfg.Server,
			PollIntervalMS: cfg.PollInterval.Milliseconds(),
			StartedAt:      now,
			UpdatedAt:      now,
			Endpoints:      map[string]llamacpp.Probe{},
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

func (m *Dashboard) poll(parent context.Context) {
	ctx, cancel := context.WithTimeout(parent, m.cfg.Timeout*4)
	defer cancel()

	endpoints := map[string]llamacpp.Probe{}
	lastErrors := map[string]string{}
	warnings := []string{}

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
	endpoints["metrics"] = metricsProbe
	rawMetrics := map[string]float64{}
	metrics := llamacpp.MetricsSummary{}
	if metricsProbe.OK {
		rawMetrics = llamacpp.ParsePrometheus(string(metricsBody))
		metrics = llamacpp.SummarizeMetrics(rawMetrics)
	} else {
		lastErrors["metrics"] = metricsProbe.Error
		warnings = append(warnings, "llama.cpp /metrics is unavailable; throughput and queue cards are degraded.")
	}

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
		PromptTokensPerSec:     metrics.PromptTokensPerSec,
		GenerationTokensPerSec: metrics.GenerationTokensPerSec,
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
		Server:         m.cfg.Server,
		PollIntervalMS: m.cfg.PollInterval.Milliseconds(),
		StartedAt:      m.started,
		UpdatedAt:      time.Now(),
		Endpoints:      endpoints,
		Overview:       overview,
		Props:          props,
		Metrics:        metrics,
		Models:         models,
		Slots:          slots,
		GPU:            gpuSnapshot,
		Warnings:       warnings,
		RawMetrics:     rawMetrics,
		LastErrors:     lastErrors,
	}

	m.mu.Lock()
	m.snapshot = snapshot
	m.previousSlot = nextPrevious
	m.mu.Unlock()
}
