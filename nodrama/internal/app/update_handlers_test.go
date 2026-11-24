package app

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
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

func TestStagedDownloadDoesNotInstallUntilExplicitRequest(t *testing.T) {
	target := filepath.Join(t.TempDir(), "dashboard")
	if runtime.GOOS == "windows" {
		target += ".exe"
	}
	if out, err := exec.Command("go", "build", "-o", target, "../..").CombinedOutput(); err != nil {
		t.Fatalf("build: %s %v", out, err)
	}
	data, _ := os.ReadFile(target)
	var archive bytes.Buffer
	format := "tar.gz"
	name := "llama-nodrama"
	if runtime.GOOS == "windows" {
		format = "zip"
		name += ".exe"
		z := zip.NewWriter(&archive)
		w, _ := z.Create(name)
		_, _ = w.Write(data)
		_ = z.Close()
	} else {
		g := gzip.NewWriter(&archive)
		z := tar.NewWriter(g)
		_ = z.WriteHeader(&tar.Header{Name: name, Size: int64(len(data)), Mode: 0755})
		_, _ = z.Write(data)
		_ = z.Close()
		_ = g.Close()
	}
	payload := archive.Bytes()
	sum := sha256.Sum256(payload)
	asset := "llama-nodrama-" + runtime.GOOS + "-" + runtime.GOARCH + "." + format
	base := RepositoryURL + "/releases/download/v9.0.0/"
	calls := 0
	corrupt := false
	client := &http.Client{Transport: updateTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		var body []byte
		switch r.URL.String() {
		case LatestReleaseAPI:
			body, _ = json.Marshal(map[string]any{"tag_name": "v9.0.0", "immutable": true, "assets": []map[string]any{{"name": asset, "size": len(payload), "browser_download_url": base + asset}, {"name": "SHA256SUMS", "browser_download_url": base + "SHA256SUMS"}}})
		case base + "SHA256SUMS":
			body = []byte(hex.EncodeToString(sum[:]) + "  " + asset)
		case base + asset:
			body = append([]byte(nil), payload...)
			if corrupt {
				body[0] ^= 1
			}
		default:
			t.Fatalf("unexpected URL %s", r.URL)
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(bytes.NewReader(body))}, nil
	})}
	mux := http.NewServeMux()
	restart := make(chan struct{}, 1)
	registerUpdateHandlers(mux, BuildInfo{Version: "v0.6.0"}, restart, client, func() (string, error) { return target, nil })
	post := func(path, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		return w
	}
	if w := post("/api/update/install", `{"version":"v9.0.0"}`); w.Code != 409 || calls != 0 {
		t.Fatal("install downloaded implicitly")
	}
	w := post("/api/update/download", `{"version":"v9.0.0"}`)
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	var ready struct{ Status, Token, Version string }
	progress := false
	decoder := json.NewDecoder(w.Body)
	for {
		var event map[string]any
		if err := decoder.Decode(&event); err == io.EOF {
			break
		} else if err != nil {
			t.Fatal(err)
		}
		if event["status"] == "downloading" {
			progress = true
		}
		if event["status"] == "ready" {
			b, _ := json.Marshal(event)
			_ = json.Unmarshal(b, &ready)
		}
	}
	if !progress || ready.Token == "" || len(restart) != 0 {
		t.Fatal("missing progress/ready, or early restart")
	}
	if _, err := os.Stat(target + ".previous"); !os.IsNotExist(err) {
		t.Fatal("download replaced executable")
	}
	before := calls
	if w := post("/api/update/install", `{"version":"v9.0.0","token":"wrong"}`); w.Code != 409 {
		t.Fatal("accepted wrong download token")
	}
	request, _ := json.Marshal(map[string]string{"version": ready.Version, "token": ready.Token})
	if w := post("/api/update/install", string(request)); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if calls != before || len(restart) != 1 {
		t.Fatal("install fetched again or did not restart")
	}
	if _, err := os.Stat(target + ".previous"); err != nil {
		t.Fatal("no rollback binary")
	}
	corrupt = true
	w = post("/api/update/download", `{"version":"v9.0.0"}`)
	if !strings.Contains(w.Body.String(), "checksum") || strings.Contains(w.Body.String(), `"status":"ready"`) {
		t.Fatal("bad download became installable")
	}
	if w := post("/api/update/install", string(request)); w.Code != 409 {
		t.Fatal("old staged token survived failed replacement download")
	}
}
