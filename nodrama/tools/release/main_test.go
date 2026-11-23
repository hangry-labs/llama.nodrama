package main

import "testing"

func TestRoutineReleaseKeepsVersionLine(t *testing.T) {
	for _, tc := range []struct{ current, release, next string }{
		{"v0.6.0-SNAPSHOT", "v0.6.0", "v0.6.1-SNAPSHOT"},
		{"v0.6.9-SNAPSHOT", "v0.6.9", "v0.6.10-SNAPSHOT"},
		{"v0.7.0-SNAPSHOT", "v0.7.0", "v0.7.1-SNAPSHOT"},
		{"v1.2.3-SNAPSHOT", "v1.2.3", "v1.2.4-SNAPSHOT"},
	} {
		release, next := releaseVersions(snapshotVersionPattern.FindStringSubmatch(tc.current))
		if release != tc.release || next != tc.next {
			t.Errorf("%s: release=%s next=%s", tc.current, release, next)
		}
	}
}
