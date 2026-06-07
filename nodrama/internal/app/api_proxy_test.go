package app

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestChatCompletionsProxyTracksRequest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Fatalf("upstream path = %q", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\n")
		_, _ = io.WriteString(w, "data: {\"usage\":{\"prompt_tokens\":4,\"completion_tokens\":2,\"total_tokens\":6}}\n\n")
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	mux := http.NewServeMux()
	if err := registerAPIProxies(mux, upstream.URL, dashboard); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodPost, "/api/chat/completions", strings.NewReader(`{"model":"model-a","stream":true}`))
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}
	if rec.Header().Get("X-Nodrama-Request-ID") == "" {
		t.Fatal("missing request id header")
	}

	requests := dashboard.Snapshot().Requests
	if len(requests) != 1 {
		t.Fatalf("requests length = %d", len(requests))
	}
	if requests[0].Model != "model-a" {
		t.Fatalf("tracked model = %q", requests[0].Model)
	}
	if !requests[0].Stream {
		t.Fatal("stream flag was not tracked")
	}
	if requests[0].Status != http.StatusOK {
		t.Fatalf("tracked status = %d", requests[0].Status)
	}
	if requests[0].ResponseBytes == 0 {
		t.Fatal("response bytes were not tracked")
	}
	if requests[0].Usage == nil || requests[0].Usage.TotalTokens != 6 {
		t.Fatalf("usage = %#v", requests[0].Usage)
	}
}

func TestModelAndSlotActionProxies(t *testing.T) {
	seen := map[string]int{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := r.URL.Path
		if r.URL.RawQuery != "" {
			key += "?" + r.URL.RawQuery
		}
		seen[key]++
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"ok":true}`)
	}))
	defer upstream.Close()

	dashboard := NewDashboard(nil, Config{}, BuildInfo{})
	mux := http.NewServeMux()
	if err := registerAPIProxies(mux, upstream.URL, dashboard); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		path string
		body string
		want string
	}{
		{path: "/api/models/load", body: `{"model":"model-a"}`, want: "/models/load"},
		{path: "/api/models/unload", body: `{"model":"model-a"}`, want: "/models/unload"},
		{path: "/api/slots/2/erase", body: ``, want: "/slots/2?action=erase"},
	} {
		req := httptest.NewRequest(http.MethodPost, tc.path, strings.NewReader(tc.body))
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, req)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s status = %d body = %s", tc.path, rec.Code, rec.Body.String())
		}
		if seen[tc.want] != 1 {
			t.Fatalf("%s was not proxied to %s; seen = %#v", tc.path, tc.want, seen)
		}
	}

	if got := len(dashboard.Snapshot().Requests); got != 3 {
		t.Fatalf("tracked request count = %d", got)
	}
}
