package app

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
)

var errNoPreview = errors.New("no published immutable preview is available")

type previewReleaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	Size int64  `json:"size"`
}

type previewRelease struct {
	Tag         string                `json:"tag_name"`
	Draft       bool                  `json:"draft"`
	Prerelease  bool                  `json:"prerelease"`
	Immutable   bool                  `json:"immutable"`
	PublishedAt time.Time             `json:"published_at"`
	Assets      []previewReleaseAsset `json:"assets"`
}

func previewDownloadURL(tag, name string) string {
	return RepositoryURL + "/releases/download/" + tag + "/" + name
}

func (release previewRelease) hasAsset(name, rawURL string, size int64) bool {
	for _, asset := range release.Assets {
		if asset.Name == name && asset.URL == rawURL && asset.Size == size {
			return true
		}
	}
	return false
}

// Discovery moves; each selected release, manifest and executable stays pinned.
func latestPreview(ctx context.Context, client *http.Client) (previewRelease, error) {
	var newest previewRelease
	// Bound API work and response sizes even in a repository with years of builds.
	for page := 1; page <= 5; page++ {
		rawURL := strings.TrimSuffix(LatestReleaseAPI, "/latest") + "?per_page=100&page=" + strconv.Itoa(page)
		data, err := updateGet(ctx, client, rawURL, 8<<20)
		if err != nil {
			return newest, err
		}
		var releases []previewRelease
		if err := json.Unmarshal(data, &releases); err != nil {
			return newest, err
		}
		for _, release := range releases {
			commit := strings.TrimPrefix(release.Tag, "preview-")
			if release.Draft || !release.Prerelease || !release.Immutable || len(commit) != 40 || release.Tag != "preview-"+commit || release.PublishedAt.IsZero() {
				continue
			}
			if _, err := hex.DecodeString(commit); err != nil {
				continue
			}
			for _, asset := range release.Assets {
				if asset.Name == "update.json" && asset.URL == previewDownloadURL(release.Tag, "update.json") && asset.Size > 0 && asset.Size <= 1<<20 && release.PublishedAt.After(newest.PublishedAt) {
					newest = release
				}
			}
		}
		if len(releases) < 100 {
			break
		}
	}
	if newest.Tag == "" {
		return newest, errNoPreview
	}
	return newest, nil
}
