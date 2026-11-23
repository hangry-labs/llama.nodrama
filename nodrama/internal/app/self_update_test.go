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

func TestResolvePreviewIdentityAndValidation(t *testing.T) {
	commit := strings.Repeat("a", 40)
	manifest := updateManifest{Schema: 1, Version: "v0.6.0-SNAPSHOT", Commit: commit, Assets: []updateAsset{{Name: "binary", OS: runtime.GOOS, Arch: runtime.GOARCH, URL: RepositoryURL + "/releases/download/preview/binary", SHA256: strings.Repeat("a", 64), Bytes: 1024}}}
	data, _ := json.Marshal(manifest)
	for _, current := range []string{commit, strings.Repeat("b", 40)} {
		plan, err := resolveUpdate(context.Background(), updateTestClient(data), "preview", BuildInfo{Commit: current})
		if err != nil || plan.Available != (current != commit) {
			t.Fatalf("plan=%#v err=%v", plan, err)
		}
	}
	for _, raw := range []string{"http://github.com/hangry-labs/llama.nodrama/releases/download/preview/a", "https://example.com/a", "https://github.com/other/repo/releases/download/tag/a"} {
		if officialUpdateURL(raw) {
			t.Fatalf("accepted %s", raw)
		}
	}
	manifest.Assets[0].URL = "https://example.com/other-binary"
	data, _ = json.Marshal(manifest)
	if _, err := resolveUpdate(context.Background(), updateTestClient(data), "preview", BuildInfo{}); err == nil {
		t.Fatal("accepted external binary")
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
