package app

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const updateCheckInterval = 6 * time.Hour

type UpdateInfo struct {
	CheckedAt      *time.Time `json:"checkedAt,omitempty"`
	CurrentVersion string     `json:"currentVersion,omitempty"`
	LatestVersion  string     `json:"latestVersion,omitempty"`
	LatestURL      string     `json:"latestUrl,omitempty"`
	RepoURL        string     `json:"repoUrl"`
	Available      bool       `json:"available"`
	Error          string     `json:"error,omitempty"`
}

type latestReleaseResponse struct {
	TagName string `json:"tag_name"`
	HTMLURL string `json:"html_url"`
}

func defaultUpdateInfo(currentVersion string) UpdateInfo {
	return UpdateInfo{
		CurrentVersion: currentVersion,
		LatestURL:      LatestReleaseURL,
		RepoURL:        RepositoryURL,
	}
}

func checkLatestRelease(ctx context.Context, currentVersion string) UpdateInfo {
	info := defaultUpdateInfo(currentVersion)
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, LatestReleaseAPI, nil)
	if err != nil {
		info.Error = err.Error()
		return info
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "llama-nodrama/"+currentVersion)

	resp, err := http.DefaultClient.Do(req)
	checkedAt := time.Now()
	info.CheckedAt = &checkedAt
	if err != nil {
		info.Error = err.Error()
		return info
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		info.Error = fmt.Sprintf("GitHub returned %s", resp.Status)
		return info
	}

	var latest latestReleaseResponse
	if err := json.NewDecoder(resp.Body).Decode(&latest); err != nil {
		info.Error = err.Error()
		return info
	}
	info.LatestVersion = strings.TrimSpace(latest.TagName)
	if strings.TrimSpace(latest.HTMLURL) != "" {
		info.LatestURL = strings.TrimSpace(latest.HTMLURL)
	}
	info.Available = compareReleaseVersions(info.LatestVersion, currentVersion) > 0
	return info
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
