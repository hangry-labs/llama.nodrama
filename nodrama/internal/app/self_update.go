package app

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"debug/buildinfo"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const updateLimit = 64 << 20

var ErrRestart = errors.New("dashboard restart requested")

type updateHTTPError struct {
	status int
	text   string
}

func (e *updateHTTPError) Error() string { return "update server returned " + e.text }

type updateAsset struct {
	Name   string `json:"name"`
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	OS     string `json:"os"`
	Arch   string `json:"arch"`
	Format string `json:"format,omitempty"`
}
type updatePlan struct {
	Channel   string      `json:"channel"`
	Version   string      `json:"version"`
	Commit    string      `json:"commit,omitempty"`
	Current   BuildInfo   `json:"current"`
	Available bool        `json:"available"`
	Asset     updateAsset `json:"asset"`
}

func officialUpdateURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host == "github.com" && u.User == nil && u.RawQuery == "" &&
		strings.HasPrefix(u.Path, "/hangry-labs/llama.nodrama/releases/download/") && !strings.Contains(u.Path, "..")
}
func updateGet(ctx context.Context, client *http.Client, raw string, limit int64) ([]byte, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", raw, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", "llama-nodrama-updater")
	res, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return nil, &updateHTTPError{status: res.StatusCode, text: res.Status}
	}
	data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) > limit {
		return nil, errors.New("update exceeds size limit")
	}
	return data, nil
}
func resolveUpdate(ctx context.Context, client *http.Client, channel string, current BuildInfo) (updatePlan, error) {
	// Older browser tabs can still request the removed preview channel.
	if channel == "" || channel == "preview" {
		channel = "stable"
	}
	plan := updatePlan{Channel: channel, Current: current}
	if channel != "stable" {
		return plan, errors.New("only regular releases are supported")
	}
	data, err := updateGet(ctx, client, LatestReleaseAPI, 1<<20)
	if err != nil {
		return plan, err
	}
	var release struct {
		Tag        string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
		Immutable  bool   `json:"immutable"`
		Assets     []struct {
			Name string `json:"name"`
			URL  string `json:"browser_download_url"`
			Size int64  `json:"size"`
		} `json:"assets"`
	}
	if err = json.Unmarshal(data, &release); err != nil {
		return plan, err
	}
	if _, ok := parseReleaseVersion(release.Tag); !ok || strings.Contains(release.Tag, "-") || release.Draft || release.Prerelease || !release.Immutable {
		return plan, errors.New("expected a published immutable numbered release")
	}
	plan.Version = release.Tag
	plan.Available = compareReleaseVersions(release.Tag, current.Version) > 0
	format := "tar.gz"
	if runtime.GOOS == "windows" {
		format = "zip"
	}
	name := "llama-nodrama-" + runtime.GOOS + "-" + runtime.GOARCH + "." + format
	var sumsURL string
	for _, asset := range release.Assets {
		if asset.Name == name {
			plan.Asset = updateAsset{Name: name, URL: asset.URL, Bytes: asset.Size, OS: runtime.GOOS, Arch: runtime.GOARCH, Format: format}
		}
		if asset.Name == "SHA256SUMS" {
			sumsURL = asset.URL
		}
	}
	baseURL := RepositoryURL + "/releases/download/" + release.Tag + "/"
	if sumsURL != baseURL+"SHA256SUMS" || plan.Asset.URL != baseURL+name {
		return plan, errors.New("release has no official checksum file")
	}
	sums, err := updateGet(ctx, client, sumsURL, 1<<20)
	if err != nil {
		return plan, err
	}
	for _, line := range strings.Split(string(sums), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && strings.TrimPrefix(fields[1], "*") == name {
			plan.Asset.SHA256 = fields[0]
		}
	}
	hash, err := hex.DecodeString(plan.Asset.SHA256)
	if !officialUpdateURL(plan.Asset.URL) || err != nil || len(hash) != 32 || plan.Asset.Bytes <= 0 || plan.Asset.Bytes > updateLimit {
		return plan, errors.New("no valid update asset for this platform")
	}
	return plan, nil
}

func unpackUpdate(data []byte, format string) ([]byte, error) {
	name := "llama-nodrama"
	if runtime.GOOS == "windows" {
		name += ".exe"
	}
	read := func(r io.Reader) ([]byte, error) {
		b, e := io.ReadAll(io.LimitReader(r, updateLimit+1))
		if len(b) > updateLimit {
			return nil, errors.New("unpacked update exceeds limit")
		}
		return b, e
	}
	switch format {
	case "":
		return data, nil
	case "zip":
		archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
		if err != nil {
			return nil, err
		}
		for _, file := range archive.File {
			if file.Name == name && !file.FileInfo().IsDir() {
				r, e := file.Open()
				if e != nil {
					return nil, e
				}
				defer r.Close()
				return read(r)
			}
		}
	case "tar.gz":
		gz, err := gzip.NewReader(bytes.NewReader(data))
		if err != nil {
			return nil, err
		}
		defer gz.Close()
		archive := tar.NewReader(io.LimitReader(gz, updateLimit+1))
		for {
			h, e := archive.Next()
			if e == io.EOF {
				break
			}
			if e != nil {
				return nil, e
			}
			if h.Name == name && h.Typeflag == tar.TypeReg {
				return read(archive)
			}
		}
	default:
		return nil, errors.New("unsupported update archive")
	}
	return nil, errors.New("executable missing from update")
}

func installUpdate(ctx context.Context, client *http.Client, plan updatePlan, target string) error {
	data, err := updateGet(ctx, client, plan.Asset.URL, updateLimit)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(data)
	if int64(len(data)) != plan.Asset.Bytes || !strings.EqualFold(hex.EncodeToString(sum[:]), plan.Asset.SHA256) {
		return errors.New("update checksum or size mismatch")
	}
	data, err = unpackUpdate(data, plan.Asset.Format)
	if err != nil {
		return err
	}
	target, err = filepath.EvalSymlinks(target)
	if err != nil {
		return err
	}
	info, err := os.Stat(target)
	if err != nil {
		return err
	}
	staged, err := os.CreateTemp(filepath.Dir(target), ".nodrama-update-*")
	if err != nil {
		return fmt.Errorf("cannot write installation folder: %w", err)
	}
	path := staged.Name()
	defer os.Remove(path)
	if _, err = staged.Write(data); err == nil {
		err = staged.Sync()
	}
	closeErr := staged.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	metadata, err := buildinfo.ReadFile(path)
	if err != nil {
		return fmt.Errorf("invalid Go executable: %w", err)
	}
	osMatch, archMatch := false, false
	revision := ""
	for _, setting := range metadata.Settings {
		if setting.Key == "GOOS" {
			osMatch = setting.Value == runtime.GOOS
		}
		if setting.Key == "GOARCH" {
			archMatch = setting.Value == runtime.GOARCH
		}
		if setting.Key == "vcs.revision" {
			revision = setting.Value
		}
	}
	if metadata.Main.Path != "llama.nodrama/nodrama" || !osMatch || !archMatch {
		return errors.New("update executable does not match this application/platform")
	}
	if plan.Commit != "" && revision != plan.Commit {
		return errors.New("update executable commit does not match manifest")
	}
	if err = os.Chmod(path, info.Mode().Perm()); err != nil {
		return err
	}
	backup := target + ".previous"
	if _, err = os.Stat(backup); err == nil {
		if err = os.Remove(backup); err != nil {
			return err
		}
	}
	if err = os.Rename(target, backup); err != nil {
		return fmt.Errorf("cannot replace installed binary: %w", err)
	}
	if err = os.Rename(path, target); err != nil {
		rollback := os.Rename(backup, target)
		return fmt.Errorf("install failed: %v; rollback: %v", err, rollback)
	}
	return nil
}

func registerSelfUpdate(mux *http.ServeMux, info BuildInfo, restart chan<- struct{}) {
	client := &http.Client{Timeout: 2 * time.Minute}
	var lock sync.Mutex
	mux.HandleFunc("GET /api/update/check", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		plan, err := resolveUpdate(ctx, client, r.URL.Query().Get("channel"), info)
		if err != nil {

			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		writeJSON(w, plan)
	})
	mux.HandleFunc("POST /api/update/install", func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host {
				http.Error(w, "origin mismatch", 403)
				return
			}
		}
		if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			http.Error(w, "cross-site update denied", 403)
			return
		}
		if !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
			http.Error(w, "expected JSON", 415)
			return
		}
		if !lock.TryLock() {
			http.Error(w, "update already running", 409)
			return
		}
		defer lock.Unlock()
		var request struct {
			Channel string `json:"channel"`
			Version string `json:"version"`
			Commit  string `json:"commit"`
		}
		if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&request); err != nil {
			http.Error(w, "invalid update request", 400)
			return
		}
		plan, err := resolveUpdate(r.Context(), client, request.Channel, info)
		if err == nil && (!plan.Available || plan.Version != request.Version || plan.Commit != request.Commit) {
			err = errors.New("build changed; check for updates again")
		}
		var target string
		if err == nil {
			target, err = os.Executable()
		}
		if err == nil {
			err = installUpdate(r.Context(), client, plan, target)
		}
		if err != nil {
			http.Error(w, err.Error(), 400)
			return
		}
		writeJSON(w, map[string]string{"status": "restarting"})
		_ = http.NewResponseController(w).Flush()
		select {
		case restart <- struct{}{}:
		default:
		}
	})
}
