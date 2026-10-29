package app

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
	"time"
)

func settingsDefaults() Config {
	return Config{Server: DefaultServer, Listen: DefaultListen, PollInterval: time.Second, Timeout: 5 * time.Second}
}

func TestSettingsSurviveRestartAndExplicitFlagsWin(t *testing.T) {
	directory := t.TempDir()
	cfg, err := LoadSettings(settingsDefaults(), directory, nil)
	if err != nil {
		t.Fatal(err)
	}
	cfg.Server = "http://127.0.0.1:18080"
	cfg.LogPath = "/example/llama.log"
	cfg.Listen = "127.0.0.1:39082"
	cfg.RawProxy = true
	cfg.PollInterval = 1500 * time.Millisecond
	if err := SaveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	dashboard := NewDashboard(nil, cfg, BuildInfo{})
	timeout := int64(7000)
	if _, err := dashboard.UpdateSettings(RuntimeSettingsUpdate{Timeout: &timeout}); err != nil {
		t.Fatal(err)
	}
	cfg.Timeout = 7 * time.Second
	restarted, err := LoadSettings(settingsDefaults(), directory, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(cfg, restarted) {
		t.Fatalf("restart: got %+v, want %+v", restarted, cfg)
	}
	cli := settingsDefaults()
	cli.Server = "http://127.0.0.1:18081"
	restarted, err = LoadSettings(cli, directory, map[string]bool{"server": true, "raw-proxy": true, "log": true})
	if err != nil {
		t.Fatal(err)
	}
	if restarted.Server != cli.Server || restarted.RawProxy || restarted.LogPath != "" || restarted.Timeout != 7*time.Second {
		t.Fatalf("explicit flags did not override saved settings: %+v", restarted)
	}
	if entries, _ := filepath.Glob(filepath.Join(directory, ".settings-*")); len(entries) != 0 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

func TestSettingsRejectMalformedAndInvalidFiles(t *testing.T) {
	for _, data := range []string{`{`, `null`, `[]`, `{} {}`, `{"server":"ftp://example.test"}`, `{"pollIntervalMs":9223372036854775807}`, `{"timeoutMs":0}`} {
		t.Run(data, func(t *testing.T) {
			directory := t.TempDir()
			if err := os.WriteFile(filepath.Join(directory, "settings.json"), []byte(data), 0o600); err != nil {
				t.Fatal(err)
			}
			if _, err := LoadSettings(settingsDefaults(), directory, nil); err == nil {
				t.Fatal("invalid settings accepted")
			}
		})
	}
}

func TestSettingsPartialFileAndDisabledPersistence(t *testing.T) {
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "settings.json"), []byte(`{"pollIntervalMs":2000}`), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadSettings(settingsDefaults(), directory, nil)
	if err != nil || cfg.PollInterval != 2*time.Second || cfg.Server != DefaultServer {
		t.Fatalf("partial settings: %+v, %v", cfg, err)
	}
	cfg, err = LoadSettings(settingsDefaults(), "none", nil)
	if err != nil || cfg.SettingsPath != "" {
		t.Fatalf("disabled persistence: %+v, %v", cfg, err)
	}
	if err := SaveSettings(cfg); err != nil {
		t.Fatal(err)
	}
}

func TestSettingsSaveFailurePreservesRuntime(t *testing.T) {
	directory := t.TempDir()
	// A regular file cannot be used as the settings directory on any OS.
	blocker := filepath.Join(directory, "blocked")
	if err := os.WriteFile(blocker, []byte("unchanged"), 0o600); err != nil {
		t.Fatal(err)
	}
	cfg := settingsDefaults()
	cfg.SettingsPath = filepath.Join(blocker, "settings.json")
	dashboard := NewDashboard(nil, cfg, BuildInfo{})
	before := dashboard.Settings()
	server := "http://127.0.0.1:18080"
	if _, err := dashboard.UpdateSettings(RuntimeSettingsUpdate{Server: &server}); err == nil {
		t.Fatal("save failure not reported")
	}
	if got := dashboard.Settings(); !reflect.DeepEqual(before, got) {
		t.Fatalf("runtime changed after save failure: %+v", got)
	}
	if data, _ := os.ReadFile(blocker); string(data) != "unchanged" {
		t.Fatal("existing file changed")
	}
}

func TestSettingsDefaultDirectoryUsesOSUserConfiguration(t *testing.T) {
	directory := t.TempDir()
	switch runtime.GOOS {
	case "windows":
		t.Setenv("APPDATA", directory)
	case "darwin":
		t.Setenv("HOME", directory)
	default:
		t.Setenv("XDG_CONFIG_HOME", directory)
	}
	base, err := os.UserConfigDir()
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadSettings(settingsDefaults(), "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if cfg.SettingsPath != filepath.Join(base, "llama-nodrama", "settings.json") {
		t.Fatalf("unexpected default path: %s", cfg.SettingsPath)
	}
	if err := SaveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(cfg.SettingsPath); err != nil {
		t.Fatal(err)
	}
}

func TestSettingsUnchangedWhenStartupPortIsInUse(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	cfg := settingsDefaults()
	cfg.Listen = listener.Addr().String()
	cfg.SettingsPath = filepath.Join(t.TempDir(), "settings.json")
	if err := SaveSettings(cfg); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(cfg.SettingsPath)
	cfg.Server = "http://127.0.0.1:18080"
	if err := Run(context.Background(), cfg, BuildInfo{}); err == nil {
		t.Fatal("expected occupied-port error")
	}
	after, _ := os.ReadFile(cfg.SettingsPath)
	if string(after) != string(before) {
		t.Fatal("failed startup overwrote saved settings")
	}
}
