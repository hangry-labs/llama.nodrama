package app

import (
	"strconv"
	"strings"
	"time"
)

type UpdateInfo struct {
	CheckedAt      *time.Time `json:"checkedAt,omitempty"`
	CurrentVersion string     `json:"currentVersion,omitempty"`
	LatestVersion  string     `json:"latestVersion,omitempty"`
	LatestURL      string     `json:"latestUrl,omitempty"`
	RepoURL        string     `json:"repoUrl"`
	Available      bool       `json:"available"`
	Error          string     `json:"error,omitempty"`
}

func defaultUpdateInfo(currentVersion string) UpdateInfo {
	return UpdateInfo{
		CurrentVersion: currentVersion,
		LatestURL:      LatestReleaseURL,
		RepoURL:        RepositoryURL,
	}
}

func compareReleaseVersions(latest, current string) int {
	latestParts, latestOK := parseReleaseVersion(latest)
	currentParts, currentOK := parseReleaseVersion(current)
	if !latestOK || !currentOK {
		return strings.Compare(normalizeVersion(latest), normalizeVersion(current))
	}
	for i := 0; i < len(latestParts); i++ {
		if latestParts[i] > currentParts[i] {
			return 1
		}
		if latestParts[i] < currentParts[i] {
			return -1
		}
	}
	if strings.HasSuffix(current, "-SNAPSHOT") && !strings.Contains(latest, "-") {
		return 1
	}
	if strings.HasSuffix(latest, "-SNAPSHOT") && !strings.Contains(current, "-") {
		return -1
	}
	return 0
}

func parseReleaseVersion(version string) ([3]int, bool) {
	var out [3]int
	clean := normalizeVersion(version)
	if clean == "" {
		return out, false
	}
	parts := strings.Split(clean, ".")
	if len(parts) != 3 {
		return out, false
	}
	for i, part := range parts {
		value, err := strconv.Atoi(part)
		if err != nil || value < 0 {
			return out, false
		}
		out[i] = value
	}
	return out, true
}

func normalizeVersion(version string) string {
	clean := strings.TrimSpace(version)
	clean = strings.TrimPrefix(clean, "v")
	if idx := strings.Index(clean, "-"); idx >= 0 {
		clean = clean[:idx]
	}
	return clean
}
