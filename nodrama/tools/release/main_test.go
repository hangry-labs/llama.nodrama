package main

import (
	"strings"
	"testing"
)

func TestRoutineReleaseKeepsVersionLine(t *testing.T) {
	for _, tc := range []struct{ current, line string }{
		{"v0.6.0-SNAPSHOT", "v0.6.x (starting at v0.6.0)"},
		{"v0.6.9-SNAPSHOT", "v0.6.x (starting at v0.6.9)"},
		{"v0.7.0-SNAPSHOT", "v0.7.x (starting at v0.7.0)"},
		{"v1.2.3", "v1.2.x (starting at v1.2.3)"},
	} {
		line, err := releaseLine(tc.current)
		if err != nil || line != tc.line {
			t.Errorf("%s: line=%s err=%v", tc.current, line, err)
		}
	}
	for _, source := range []string{"main", "v0.6.0-beta", "v1.2", "v01.2.3", strings.Repeat("a", 40)} {
		if _, err := releaseLine(source); err == nil {
			t.Errorf("accepted %q", source)
		}
	}
}
