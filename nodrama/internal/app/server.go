package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"strings"
	"time"

	"llama.nodrama/nodrama/internal/llamacpp"
	"llama.nodrama/nodrama/internal/web"
)

func Run(ctx context.Context, cfg Config, info BuildInfo) error {
	if cfg.PollInterval <= 0 {
		cfg.PollInterval = time.Second
	}
	if cfg.Timeout <= 0 {
		cfg.Timeout = 5 * time.Second
	}
	if cfg.Listen == "" {
		cfg.Listen = DefaultListen
	}
	if cfg.Server == "" {
		cfg.Server = DefaultServer
	}

	client, err := llamacpp.NewClient(cfg.Server, cfg.Timeout)
	if err != nil {
		return fmt.Errorf("configure llama.cpp client: %w", err)
	}

	dashboard := NewDashboard(client, cfg, info)
	dashboard.Start(ctx)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /{$}", func(w http.ResponseWriter, r *http.Request) {
		web.ServeIndex(w, r)
	})
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/server.log", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.Handle("GET /static/", http.StripPrefix("/static/", web.StaticHandler()))
	if err := registerAPIProxies(mux, dashboard); err != nil {
		return err
	}
	if cfg.RawProxy {
		if err := registerLlamaProxy(mux, cfg.Server); err != nil {
			return err
		}
	}
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"status":     "ok",
			"app":        "llama.nodrama",
			"build":      info,
			"startedAt":  dashboard.StartedAt(),
			"server":     dashboard.Settings().Server,
			"snapshotAt": dashboard.Snapshot().UpdatedAt,
		})
	})
	mux.HandleFunc("GET /api/snapshot", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, dashboard.Snapshot())
	})
	mux.HandleFunc("GET /api/events", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, dashboard.Snapshot().Events)
	})
	mux.HandleFunc("GET /api/queries", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, dashboard.Snapshot().Queries)
	})
	mux.HandleFunc("GET /api/settings", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, dashboard.Settings())
	})
	mux.HandleFunc("POST /api/settings", func(w http.ResponseWriter, r *http.Request) {
		var update RuntimeSettingsUpdate
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64*1024)).Decode(&update); err != nil {
			http.Error(w, "invalid settings payload: "+err.Error(), http.StatusBadRequest)
			return
		}
		settings, err := dashboard.UpdateSettings(update)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		writeJSON(w, settings)
	})
	mux.HandleFunc("GET /api/logs/tail", runtimeLogTailHandler(dashboard))
	mux.HandleFunc("POST /api/history/reset", func(w http.ResponseWriter, r *http.Request) {
		dashboard.ResetHistory()
		writeJSON(w, map[string]string{"status": "ok"})
	})

	server := &http.Server{
		Addr:              cfg.Listen,
		Handler:           withHeaders(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	errc := make(chan error, 1)
	go func() {
		logStartup(cfg, info)
		go logEndpointDiagnostics(ctx, dashboard)
		errc <- server.ListenAndServe()
	}()

	select {
	case <-ctx.Done():
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			return err
		}
		return nil
	case err := <-errc:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	}
}

func registerLlamaProxy(mux *http.ServeMux, rawTarget string) error {
	target, err := url.Parse(rawTarget)
	if err != nil {
		return fmt.Errorf("configure proxy target: %w", err)
	}
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = 100 * time.Millisecond
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		proxy.ServeHTTP(w, r)
	})

	for _, path := range []string{
		"/health",
		"/props",
		"/slots",
		"/slots/",
		"/metrics",
		"/v1/models",
		"/v1/chat/completions",
		"/models",
		"/models/",
		"/lora-adapters",
		"/completion",
	} {
		mux.Handle(path, handler)
	}
	return nil
}

func logStartup(cfg Config, info BuildInfo) {
	openURL := dashboardOpenURL(cfg.Listen)
	logStartupBanner()
	logInfof("llama.nodrama starting version=%s", info.Version)
	logInfof("dashboard_url=%s", openURL)
	logInfof("listen_address=%s", cfg.Listen)
	logInfof("llama_cpp_server=%s", cfg.Server)
	logInfof("poll_interval=%s upstream_timeout=%s", cfg.PollInterval, cfg.Timeout)
	if cfg.LogPath == "" {
		logWarnf("log_tail=disabled reason=no_log_path_configured")
		logInfof("log_tail_hint=\"restart with --log <path-to-llama-server.log> or set Log file path in the UI Settings\"")
	} else if _, err := os.Stat(cfg.LogPath); err != nil {
		logWarnf("log_tail=unavailable path=%q error=%q", cfg.LogPath, err)
		logInfof("log_tail_hint=\"check the log path or update it from the UI Settings\"")
	} else {
		logInfof("log_tail=enabled path=%q", cfg.LogPath)
	}
	logInfof("settings_hint=\"open %s and click Settings to change server/log/poll/timeout at runtime\"", openURL)
}

func dashboardOpenURL(listen string) string {
	host, port, err := net.SplitHostPort(listen)
	if err != nil {
		if strings.HasPrefix(listen, ":") {
			return "http://127.0.0.1" + listen
		}
		return "http://" + listen
	}
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port)
}

func logEndpointDiagnostics(parent context.Context, dashboard *Dashboard) {
	timer := time.NewTimer(1500 * time.Millisecond)
	defer timer.Stop()
	select {
	case <-parent.Done():
		return
	case <-timer.C:
	}

	settings := dashboard.Settings()
	client := dashboard.runtimeClient()
	ctx, cancel := context.WithTimeout(parent, 3*time.Second)
	defer cancel()

	type endpointProbe struct {
		path  string
		label string
		probe llamacpp.Probe
	}
	endpoints := []endpointProbe{
		{path: "/health", label: "health"},
		{path: "/props", label: "props"},
		{path: "/metrics", label: "metrics"},
		{path: "/slots", label: "slots"},
	}
	online := false
	for i := range endpoints {
		endpoints[i].probe, _ = client.Get(ctx, endpoints[i].path)
		if endpoints[i].probe.OK {
			online = true
		}
	}
	if !online {
		logWarnf("llama_cpp_connection=unavailable server=%q reason=no_probe_endpoint_responded", settings.Server)
		logInfof("llama_cpp_start_hint=\"llama-server --metrics --host 127.0.0.1 --port 8080 -m <model.gguf>\"")
		logInfof("llama_nodrama_config_hint=\"if llama-server uses another port, restart with --server http://host:port or change Server URL in the UI Settings\"")
		return
	}
	for _, endpoint := range endpoints {
		if endpoint.probe.OK {
			logDebugf("llama_cpp_endpoint=ok path=%q latency_ms=%d", endpoint.path, endpoint.probe.LatencyMS)
			continue
		}
		logWarnf("llama_cpp_endpoint=unavailable path=%q error=%q", endpoint.path, endpoint.probe.Error)
	}
	if !endpoints[2].probe.OK {
		logWarnf("metrics_degraded=true reason=metrics_endpoint_unavailable")
		logInfof("metrics_hint=\"start llama-server with --metrics for throughput and queue cards\"")
	}
	if !endpoints[3].probe.OK {
		logWarnf("slots_degraded=true reason=slots_endpoint_unavailable")
		logInfof("slots_hint=\"ensure llama-server exposes /slots; do not start it with --no-slots\"")
	}
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
	}
}

func withHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		next.ServeHTTP(w, r)
	})
}
