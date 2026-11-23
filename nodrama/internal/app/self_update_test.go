package app

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

type updateTransport func(*http.Request) (*http.Response, error)

func (f updateTransport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }
func updateTestClient(data []byte) *http.Client {
	return &http.Client{Transport: updateTransport(func(*http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data)), Header: make(http.Header)}, nil
	})}
}

func TestResolveRegularReleaseAndLegacyChannel(t *testing.T) {
	const version = "v0.6.1"
	format := "tar.gz"
	if runtime.GOOS == "windows" {
		format = "zip"
	}
	name := "llama-nodrama-" + runtime.GOOS + "-" + runtime.GOARCH + "." + format
	base := RepositoryURL + "/releases/download/" + version + "/"
	binaryURL, sumsURL := base+name, base+"SHA256SUMS"
	immutable := true
	client := func() *http.Client {
		return &http.Client{Transport: updateTransport(func(r *http.Request) (*http.Response, error) {
			var data []byte
			switch r.URL.String() {
			case LatestReleaseAPI:
				data, _ = json.Marshal(map[string]any{"tag_name": version, "immutable": immutable, "assets": []map[string]any{
					{"name": name, "browser_download_url": binaryURL, "size": 1024},
					{"name": "SHA256SUMS", "browser_download_url": sumsURL},
				}})
			case sumsURL:
				data = []byte(strings.Repeat("a", 64) + "  " + name + "\n")
			default:
				t.Fatalf("unexpected request %s", r.URL)
			}
			return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(data))}, nil
		})}
	}
	for _, channel := range []string{"", "stable", "preview"} {
		for _, current := range []string{"v0.6.0-SNAPSHOT", "v0.6.0", version, "v0.6.2"} {
			plan, err := resolveUpdate(context.Background(), client(), channel, BuildInfo{Version: current})
			wantAvailable := compareReleaseVersions(version, current) > 0
			if err != nil || plan.Channel != "stable" || plan.Version != version || plan.Asset.URL != base+name || plan.Available != wantAvailable {
				t.Fatalf("channel=%q current=%s plan=%#v err=%v", channel, current, plan, err)
			}
		}
	}
	for _, raw := range []string{"https://example.com/binary", RepositoryURL + "/releases/download/v0.5.0/" + name} {
		binaryURL = raw
		if _, err := resolveUpdate(context.Background(), client(), "stable", BuildInfo{}); err == nil {
			t.Fatalf("accepted asset from another release: %s", raw)
		}
	}
	binaryURL = base + name
	sumsURL = RepositoryURL + "/releases/download/v0.5.0/SHA256SUMS"
	if _, err := resolveUpdate(context.Background(), client(), "stable", BuildInfo{}); err == nil {
		t.Fatal("accepted checksum file from another release")
	}
	sumsURL = base + "SHA256SUMS"
	immutable = false
	if _, err := resolveUpdate(context.Background(), client(), "stable", BuildInfo{}); err == nil {
		t.Fatal("accepted mutable release")
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
	plan := updatePlan{Asset: updateAsset{URL: RepositoryURL + "/releases/download/v0.6.1/test", SHA256: hex.EncodeToString(hash[:]), Bytes: int64(len(data))}}
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
		t.Fatal("accepted different build commit")
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
