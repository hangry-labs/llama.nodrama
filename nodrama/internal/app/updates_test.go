package app

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"llama.nodrama/nodrama/internal/llamacpp"
)

func TestDashboardPollingDoesNotCheckForUpdates(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer upstream.Close()
	previous := http.DefaultClient
	requests := 0
	http.DefaultClient = &http.Client{Transport: updateTransport(func(r *http.Request) (*http.Response, error) {
		requests++
		return updateTestClient([]byte(`{}`)).Do(r)
	})}
	defer func() { http.DefaultClient = previous }()
	client, err := llamacpp.NewClient(upstream.URL, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	dashboard := NewDashboard(client, Config{Server: upstream.URL, Timeout: time.Second}, BuildInfo{Version: "v0.6.0-SNAPSHOT"})
	dashboard.poll(context.Background())
	if requests != 0 {
		t.Fatalf("background update requests: %d", requests)
	}
}

func TestCompareReleaseVersions(t *testing.T) {
	for _, tc := range []struct {
		name    string
		latest  string
		current string
		want    int
	}{
		{name: "newer patch", latest: "v0.1.1", current: "v0.1.0", want: 1},
		{name: "newer minor", latest: "v0.2.0", current: "v0.1.9", want: 1},
		{name: "same release", latest: "v0.1.0", current: "v0.1.0", want: 0},
		{name: "final release upgrades snapshot", latest: "v0.2.0", current: "v0.2.0-SNAPSHOT", want: 1},
		{name: "older latest", latest: "v0.1.0", current: "v0.2.0-SNAPSHOT", want: -1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := compareReleaseVersions(tc.latest, tc.current)
			switch {
			case tc.want > 0 && got <= 0:
				t.Fatalf("compareReleaseVersions(%q, %q) = %d, want > 0", tc.latest, tc.current, got)
			case tc.want == 0 && got != 0:
				t.Fatalf("compareReleaseVersions(%q, %q) = %d, want 0", tc.latest, tc.current, got)
			case tc.want < 0 && got >= 0:
				t.Fatalf("compareReleaseVersions(%q, %q) = %d, want < 0", tc.latest, tc.current, got)
			}
		})
	}
}
