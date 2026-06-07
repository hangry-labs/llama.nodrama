package app

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httputil"
	"net/url"
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
		cfg.Listen = ":39080"
	}
	if cfg.Server == "" {
		cfg.Server = "http://127.0.0.1:18080"
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
		log.Printf("llama.nodrama listening on http://%s, polling %s", cfg.Listen, cfg.Server)
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
