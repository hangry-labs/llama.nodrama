package app

import (
	"strings"
	"testing"
)

func TestDashboardOpenURL(t *testing.T) {
	for _, tc := range []struct {
		listen string
		want   string
	}{
		{listen: ":39080", want: "http://127.0.0.1:39080"},
		{listen: "0.0.0.0:39081", want: "http://127.0.0.1:39081"},
		{listen: "localhost:39082", want: "http://localhost:39082"},
	} {
		if got := dashboardOpenURL(tc.listen); got != tc.want {
			t.Fatalf("dashboardOpenURL(%q) = %q, want %q", tc.listen, got, tc.want)
		}
	}
}

func TestShortInfoReportsFreeSlotRecommendation(t *testing.T) {
	dashboard := NewDashboard(nil, Config{Server: "http://127.0.0.1:18080"}, BuildInfo{})
	dashboard.snapshot = Snapshot{
		Server: "http://127.0.0.1:18080",
		Overview: Overview{
			Online:                true,
			BusySlots:             1,
			TotalSlots:            3,
			ContextUsedTokens:     100,
			ContextCapacityTokens: 1000,
			ContextUsedRatio:      0.10,
			ModelAlias:            "model-a",
		},
	}

	info := dashboard.ShortInfo()
	for _, want := range []string{
		"status: online",
		"slots: busy=1 free=2 total=3",
		"context_active: used=100 capacity=1000 ratio=10.0%",
		"recommendation: free slot available; ok to send work",
	} {
		if !strings.Contains(info, want) {
			t.Fatalf("shortInfo missing %q:\n%s", want, info)
		}
	}
}
