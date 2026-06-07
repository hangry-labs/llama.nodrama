package app

import "testing"

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
		{name: "same snapshot base", latest: "v0.2.0", current: "v0.2.0-SNAPSHOT", want: 0},
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
