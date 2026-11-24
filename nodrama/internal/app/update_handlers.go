package app

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"
)

type preparedUpdate struct {
	plan  updatePlan
	token string
	data  []byte
}

func registerSelfUpdate(mux *http.ServeMux, info BuildInfo, restart chan<- struct{}) {
	registerUpdateHandlers(mux, info, restart, &http.Client{Timeout: 2 * time.Minute}, os.Executable)
}

func registerUpdateHandlers(mux *http.ServeMux, info BuildInfo, restart chan<- struct{}, client *http.Client, executable func() (string, error)) {
	var lock sync.Mutex
	var prepared *preparedUpdate
	mux.HandleFunc("GET /api/update/check", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		plan, err := resolveUpdate(ctx, client, r.URL.Query().Get("channel"), info)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		writeJSON(w, plan)
	})
	guard := func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if origin := r.Header.Get("Origin"); origin != "" {
				u, err := url.Parse(origin)
				if err != nil || u.Host != r.Host {
					http.Error(w, "origin mismatch", 403)
					return
				}
			}
			if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
				http.Error(w, "cross-site update denied", 403)
				return
			}
			if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
				http.Error(w, "expected JSON", 415)
				return
			}
			if !lock.TryLock() {
				http.Error(w, "update already running", 409)
				return
			}
			defer lock.Unlock()
			next(w, r)
		}
	}
	mux.HandleFunc("POST /api/update/download", guard(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Version string `json:"version"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request) != nil {
			http.Error(w, "invalid update request", 400)
			return
		}
		plan, err := resolveUpdate(r.Context(), client, "stable", info)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		if !plan.Available || request.Version != plan.Version {
			http.Error(w, "version changed; check for updates again", 409)
			return
		}
		prepared = nil
		req, err := http.NewRequestWithContext(r.Context(), "GET", plan.Asset.URL, nil)
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		req.Header.Set("User-Agent", "llama-nodrama-updater")
		response, err := client.Do(req)
		if err != nil {
			http.Error(w, err.Error(), 502)
			return
		}
		defer response.Body.Close()
		if response.StatusCode != 200 {
			http.Error(w, "download server returned "+response.Status, 502)
			return
		}
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-store")
		send := func(value any) error {
			if err := json.NewEncoder(w).Encode(value); err != nil {
				return err
			}
			return http.NewResponseController(w).Flush()
		}
		progress := func(received int64) error {
			return send(map[string]any{"status": "downloading", "received": received, "total": plan.Asset.Bytes})
		}
		if progress(0) != nil {
			return
		}
		data := make([]byte, 0, int(plan.Asset.Bytes))
		buffer := make([]byte, 64*1024)
		reader := io.LimitReader(response.Body, plan.Asset.Bytes+1)
		last := time.Now()
		for {
			n, readErr := reader.Read(buffer)
			data = append(data, buffer[:n]...)
			if int64(len(data)) > plan.Asset.Bytes {
				err = errors.New("update exceeds expected size")
				break
			}
			if time.Since(last) >= 100*time.Millisecond || int64(len(data)) == plan.Asset.Bytes {
				if progress(int64(len(data))) != nil {
					return
				}
				last = time.Now()
			}
			if readErr == io.EOF {
				break
			}
			if readErr != nil {
				err = readErr
				break
			}
		}
		sum := sha256.Sum256(data)
		if err == nil && (int64(len(data)) != plan.Asset.Bytes || !strings.EqualFold(hex.EncodeToString(sum[:]), plan.Asset.SHA256)) {
			err = errors.New("update checksum or size mismatch")
		}
		if err == nil {
			var token [16]byte
			_, err = rand.Read(token[:])
			if err == nil {
				prepared = &preparedUpdate{plan: plan, token: hex.EncodeToString(token[:]), data: data}
			}
		}
		if err != nil {
			_ = send(map[string]string{"status": "error", "error": err.Error()})
			return
		}
		if r.Context().Err() != nil {
			prepared = nil
			return
		}
		if send(map[string]string{"status": "ready", "version": plan.Version, "token": prepared.token}) != nil {
			prepared = nil
		}
	}))
	mux.HandleFunc("POST /api/update/install", guard(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Version string `json:"version"`
			Token   string `json:"token"`
		}
		if json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request) != nil {
			http.Error(w, "invalid update request", 400)
			return
		}
		if prepared == nil || request.Token != prepared.token || request.Version != prepared.plan.Version {
			http.Error(w, "download this version before installing", 409)
			return
		}
		target, err := executable()
		if err == nil {
			err = installUpdateData(prepared.plan, target, prepared.data)
		}
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		prepared = nil
		writeJSON(w, map[string]string{"status": "restarting"})
		_ = http.NewResponseController(w).Flush()
		select {
		case restart <- struct{}{}:
		default:
		}
	}))
}
