package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestChatBatchConcurrentStreamsAndTracking(t *testing.T) {
	arrived := make(chan struct{}, 8)
	release := make(chan struct{})
	var invalid atomic.Bool
	var sequence atomic.Int32
	const payload = `{"model":"synthetic","stream":true,"messages":[{"role":"user","content":"test"}]}`
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		if r.URL.String() != "/v1/chat/completions" || string(body) != payload {
			invalid.Store(true)
		}
		index := sequence.Add(1)
		arrived <- struct{}{}
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		if index == 1 {
			http.Error(w, "synthetic unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"héllo 🦙\"},\"finish_reason\":\"stop\"}],\"usage\":{\"total_tokens\":6}}\n\ndata: [DONE]\n\n")
	}))
	defer upstream.Close()
	dashboard := NewDashboard(nil, Config{Server: upstream.URL}, BuildInfo{})
	mux := http.NewServeMux()
	if err := registerAPIProxies(mux, dashboard); err != nil {
		t.Fatal(err)
	}
	mux.HandleFunc("GET /probe", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) })
	server := httptest.NewServer(mux)
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second, Transport: &http.Transport{MaxConnsPerHost: 6}}
	defer client.CloseIdleConnections()
	response, err := client.Post(server.URL+"/api/chat/completions/batch?count=8", "application/json", strings.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	for range 8 {
		select {
		case <-arrived:
		case <-time.After(3 * time.Second):
			t.Fatal("all eight requests must reach upstream before any complete")
		}
	}
	probe, err := client.Get(server.URL + "/probe")
	if err != nil {
		t.Fatal(err)
	}
	probe.Body.Close()
	if probe.StatusCode != 204 {
		t.Fatal("monitoring connection unavailable")
	}
	close(release)
	decoder := json.NewDecoder(response.Body)
	var statuses [8]int
	var bodies [8]string
	var finished [8]bool
	for {
		var frame chatBatchFrame
		if err := decoder.Decode(&frame); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if frame.Index < 0 || frame.Index >= 8 {
			t.Fatalf("invalid index: %d", frame.Index)
		}
		switch frame.Type {
		case "headers":
			statuses[frame.Index] = frame.Status
		case "data":
			bodies[frame.Index] += string(frame.Data)
		case "done":
			finished[frame.Index] = true
		default:
			t.Fatalf("unexpected frame: %#v", frame)
		}
	}
	failures := 0
	for index, status := range statuses {
		if !finished[index] {
			t.Fatalf("stream %d not finished", index)
		}
		if status == 503 {
			failures++
		} else if status != 200 || !strings.Contains(bodies[index], "héllo 🦙") {
			t.Fatalf("stream %d status=%d body=%q", index, status, bodies[index])
		}
	}
	if failures != 1 || invalid.Load() {
		t.Fatalf("failures=%d invalid forwarding=%v", failures, invalid.Load())
	}
	requests := dashboard.Snapshot().Requests
	if len(requests) != 8 {
		t.Fatalf("tracked %d requests", len(requests))
	}
	for _, request := range requests {
		if request.EndedAt == nil || request.Model != "synthetic" || request.Error != "" {
			t.Fatalf("invalid tracking: %#v", request)
		}
		if request.Status == 200 && (request.Usage == nil || request.Usage.TotalTokens != 6) {
			t.Fatalf("missing usage: %#v", request)
		}
	}
}

func TestChatBatchValidation(t *testing.T) {
	dashboard := NewDashboard(nil, Config{Server: "http://127.0.0.1:1"}, BuildInfo{})
	for _, test := range []struct {
		count, body string
		status      int
	}{
		{"", `{"stream":true}`, 400},
		{"0", `{"stream":true}`, 400},
		{"9", `{"stream":true}`, 400},
		{"two", `{"stream":true}`, 400},
		{"2", `{"stream":false}`, 400},
		{"2", `broken`, 400},
		{"2", strings.Repeat(" ", chatMetadataReadLimit+1), 413},
	} {
		recorder := httptest.NewRecorder()
		request := httptest.NewRequest("POST", "/api/chat/completions/batch?count="+test.count, strings.NewReader(test.body))
		chatBatchHandler(dashboard).ServeHTTP(recorder, request)
		if recorder.Code != test.status {
			t.Fatalf("count=%s status=%d, want %d", test.count, recorder.Code, test.status)
		}
	}
}

func TestChatBatchUpstreamDisconnectIsIsolatedAndTracked(t *testing.T) {
	var sequence atomic.Int32
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if sequence.Add(1) == 1 {
			connection, buffer, err := w.(http.Hijacker).Hijack()
			if err != nil {
				return
			}
			defer connection.Close()
			_, _ = buffer.WriteString("HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: 10000\r\n\r\ndata: ")
			_ = buffer.Flush()
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	dashboard := NewDashboard(nil, Config{Server: upstream.URL}, BuildInfo{})
	server := httptest.NewServer(chatBatchHandler(dashboard))
	defer server.Close()
	client := &http.Client{Timeout: 5 * time.Second}
	response, err := client.Post(server.URL+"?count=2", "application/json", strings.NewReader(`{"stream":true}`))
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	decoder := json.NewDecoder(response.Body)
	errors, done := 0, 0
	for {
		var frame chatBatchFrame
		if err := decoder.Decode(&frame); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if frame.Type == "error" {
			errors++
		} else if frame.Type == "done" {
			done++
		}
	}
	if errors != 1 || done != 1 {
		t.Fatalf("errors=%d completed=%d", errors, done)
	}
	requests := dashboard.Snapshot().Requests
	if len(requests) != 2 {
		t.Fatalf("tracked %d requests", len(requests))
	}
	errors = 0
	for _, request := range requests {
		if request.EndedAt == nil {
			t.Fatal("disconnected request still shown as running")
		}
		if request.Error != "" {
			errors++
		}
	}
	if errors != 1 {
		t.Fatalf("tracked %d errors", errors)
	}
}
