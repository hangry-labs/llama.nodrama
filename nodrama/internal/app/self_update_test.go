package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

type updateTransport func(*http.Request) (*http.Response, error)

func (f updateTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func updateTestClient(data []byte) *http.Client {
	return &http.Client{Transport: updateTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header)}, nil
	})}
}

func TestResolvePreviewIdentityAndValidation(t *testing.T) {
	commit := strings.Repeat("a", 40)
	tag := "preview-" + commit
	manifest := updateManifest{Schema: 1, Version: "v0.6.0-SNAPSHOT", Commit: commit, Assets: []updateAsset{{Name: "binary", OS: runtime.GOOS, Arch: runtime.GOARCH, URL: previewDownloadURL(tag, "binary"), SHA256: strings.Repeat("a", 64), Bytes: 1024}}}
	release := previewFixture(tag)
	release.Assets = append(release.Assets, previewReleaseAsset{Name: "binary", URL: manifest.Assets[0].URL, Size: 1024})
	client := func() *http.Client {
		return &http.Client{Transport: updateTransport(func(r *http.Request) (*http.Response, error) {
			var value any
			switch r.URL.String() {
			case strings.TrimSuffix(LatestReleaseAPI, "/latest") + "?per_page=100&page=1":
				value = []previewRelease{release}
			case previewDownloadURL(tag, "update.json"):
				value = manifest
			default:
				t.Fatalf("unexpected request %s", r.URL)
			}
			data, _ := json.Marshal(value)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header)}, nil
		})}
	}
	for _, current := range []string{commit, strings.Repeat("b", 40)} {
		plan, err := resolveUpdate(context.Background(), client(), "preview", BuildInfo{Commit: current})
		if err != nil || plan.Available != (current != commit) {
			t.Fatalf("plan=%#v err=%v", plan, err)
		}
	}
	for _, raw := range []string{"http://github.com/hangry-labs/llama.nodrama/releases/download/preview/a", "https://example.com/a", "https://github.com/other/repo/releases/download/tag/a"} {
		if officialUpdateURL(raw) {
			t.Fatalf("accepted %s", raw)
		}
	}
	for _, raw := range []string{"https://example.com/other-binary", previewDownloadURL("preview", "binary"), previewDownloadURL("preview-"+strings.Repeat("b", 40), "binary")} {
		manifest.Assets[0].URL = raw
		if _, err := resolveUpdate(context.Background(), client(), "preview", BuildInfo{}); err == nil {
			t.Fatalf("accepted binary from another release: %s", raw)
		}
	}
	manifest.Assets[0].URL = previewDownloadURL(tag, "binary")
	manifest.Commit = strings.Repeat("b", 40)
	if _, err := resolveUpdate(context.Background(), client(), "preview", BuildInfo{}); err == nil {
		t.Fatal("accepted manifest from another commit")
	}
	manifest.Commit = commit
	release.Assets = release.Assets[:1]
	if _, err := resolveUpdate(context.Background(), client(), "preview", BuildInfo{}); err == nil {
		t.Fatal("accepted binary absent from immutable release")
	}
}

func previewFixture(tag string) previewRelease {
	return previewRelease{Tag: tag, Prerelease: true, Immutable: true, PublishedAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Assets: []previewReleaseAsset{{Name: "update.json", URL: previewDownloadURL(tag, "update.json"), Size: 1000}}}
}

func TestLatestPreviewDiscovery(t *testing.T) {
	old := previewFixture("preview-" + strings.Repeat("a", 40))
	newest := previewFixture("preview-" + strings.Repeat("b", 40))
	newest.PublishedAt = old.PublishedAt.Add(time.Hour)
	for _, invalid := range []string{"legacy", "draft", "mutable", "stable", "missing manifest", "external manifest", "wrong tag", "unpublished"} {
		t.Run(invalid, func(t *testing.T) {
			bad := previewFixture("preview-" + strings.Repeat("c", 40))
			bad.PublishedAt = newest.PublishedAt.Add(time.Hour)
			switch invalid {
			case "legacy":
				bad.Tag = "preview"
			case "draft":
				bad.Draft = true
			case "mutable":
				bad.Immutable = false
			case "stable":
				bad.Prerelease = false
			case "missing manifest":
				bad.Assets = nil
			case "external manifest":
				bad.Assets[0].URL = "https://example.com/update.json"
			case "wrong tag":
				bad.Tag = "preview-" + strings.Repeat("z", 40)
			case "unpublished":
				bad.PublishedAt = time.Time{}
			}
			// Deliberately out of publication order, with a newer invalid candidate.
			data, _ := json.Marshal([]previewRelease{old, bad, newest})
			got, err := latestPreview(context.Background(), updateTestClient(data))
			if err != nil || got.Tag != newest.Tag {
				t.Fatalf("got=%s err=%v", got.Tag, err)
			}
		})
	}
	t.Run("pagination", func(t *testing.T) {
		pages := 0
		client := &http.Client{Transport: updateTransport(func(r *http.Request) (*http.Response, error) {
			pages++
			if r.URL.Query().Get("page") != strconv.Itoa(pages) {
				t.Fatalf("unexpected page %s", r.URL)
			}
			items := make([]previewRelease, 100)
			items[0] = old
			if pages == 2 {
				items = []previewRelease{newest}
			}
			data, _ := json.Marshal(items)
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data))}, nil
		})}
		got, err := latestPreview(context.Background(), client)
		if err != nil || got.Tag != newest.Tag || pages != 2 {
			t.Fatalf("got=%s pages=%d err=%v", got.Tag, pages, err)
		}
	})
	if _, err := latestPreview(context.Background(), updateTestClient([]byte(`[]`))); !errors.Is(err, errNoPreview) {
		t.Fatalf("empty feed err=%v", err)
	}
}

func TestInstallUpdateValidatesBeforeReplacingExecutable(t *testing.T) {
	target := filepath.Join(t.TempDir(), "dashboard")
	if runtime.GOOS == "windows" {
		target += ".exe"
	}
	command := exec.Command("go", "build", "-o", target, "../..")
	if out, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	data, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	plan := updatePlan{Asset: updateAsset{URL: RepositoryURL + "/releases/download/preview/test", SHA256: hex.EncodeToString(hash[:]), Bytes: int64(len(data))}}
	bad := append([]byte(nil), data...)
	bad[len(bad)-1] ^= 1
	if err := installUpdate(context.Background(), updateTestClient(bad), plan, target); err == nil {
		t.Fatal("accepted checksum mismatch")
	}
	current, _ := os.ReadFile(target)
	if !bytes.Equal(current, data) {
		t.Fatal("bad download changed installed app")
	}
	invalid := []byte("not an executable")
	sum := sha256.Sum256(invalid)
	invalidPlan := plan
	invalidPlan.Asset.Bytes = int64(len(invalid))
	invalidPlan.Asset.SHA256 = hex.EncodeToString(sum[:])
	if err := installUpdate(context.Background(), updateTestClient(invalid), invalidPlan, target); err == nil {
		t.Fatal("accepted invalid executable")
	}
	wrongCommit := plan
	wrongCommit.Commit = strings.Repeat("0", 40)
	if err := installUpdate(context.Background(), updateTestClient(data), wrongCommit, target); err == nil {
		t.Fatal("accepted different preview commit")
	}
	if err := installUpdate(context.Background(), updateTestClient(data), plan, target); err != nil {
		t.Fatal(err)
	}
	backup, _ := os.ReadFile(target + ".previous")
	if !bytes.Equal(backup, data) {
		t.Fatal("missing rollback binary")
	}
}

func TestUpdateInstallRejectsCrossOrigin(t *testing.T) {
	mux := http.NewServeMux()
	registerSelfUpdate(mux, BuildInfo{}, make(chan struct{}, 1))
	request := httptest.NewRequest("POST", "http://localhost/api/update/install", strings.NewReader(`{"channel":"preview"}`))
	request.Header.Set("Origin", "https://unrelated.example")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	mux.ServeHTTP(response, request)
	if response.Code != 403 {
		t.Fatalf("status %d", response.Code)
	}
}
