package app

import "testing"

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
