package app

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"time"

	"llama.nodrama/nodrama/internal/llamacpp"
)

// LoadSettings applies saved settings before explicitly supplied CLI flags.
// An empty directory selects the OS user configuration directory; "none"
// disables persistence for ephemeral instances.
func LoadSettings(cli Config, directory string, explicit map[string]bool) (Config, error) {
	if directory == "none" {
		cli.SettingsPath = ""
		return cli, validateSettings(cli)
	}
	if directory == "" {
		base, err := os.UserConfigDir()
		if err != nil {
			return Config{}, fmt.Errorf("locate settings directory: %w", err)
		}
		directory = filepath.Join(base, "llama-nodrama")
	}
	path, err := filepath.Abs(filepath.Join(directory, "settings.json"))
	if err != nil {
		return Config{}, err
	}
	cli.SettingsPath = path
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return cli, validateSettings(cli)
	}
	if err != nil {
		return Config{}, fmt.Errorf("read settings %s: %w", path, err)
	}
	// Start with defaults so manually authored partial settings remain useful.
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return Config{}, fmt.Errorf("read settings %s: expected a JSON object", path)
	}
	saved := runtimeSettingsFromConfig(cli)
	decoder := json.NewDecoder(bytes.NewReader(data))
	if err = decoder.Decode(&saved); err == nil {
		var extra any
		if next := decoder.Decode(&extra); next != io.EOF {
			err = fmt.Errorf("expected one JSON object")
		}
	}
	if err != nil {
		return Config{}, fmt.Errorf("read settings %s: %w", path, err)
	}
	if !explicit["server"] {
		cli.Server = saved.Server
	}
	if !explicit["listen"] {
		cli.Listen = saved.Listen
	}
	if !explicit["log"] {
		cli.LogPath = saved.LogPath
	}
	if !explicit["raw-proxy"] {
		cli.RawProxy = saved.RawProxy
	}
	// Validate before converting milliseconds to Duration to avoid overflow.
	if !explicit["poll"] {
		if saved.PollInterval < 200 || saved.PollInterval > 60000 {
			return Config{}, fmt.Errorf("settings %s: pollIntervalMs must be between 200 and 60000", path)
		}
		cli.PollInterval = time.Duration(saved.PollInterval) * time.Millisecond
	}
	if !explicit["timeout"] {
		if saved.Timeout < 250 || saved.Timeout > 120000 {
			return Config{}, fmt.Errorf("settings %s: timeoutMs must be between 250 and 120000", path)
		}
		cli.Timeout = time.Duration(saved.Timeout) * time.Millisecond
	}
	return cli, validateSettings(cli)
}

func validateSettings(cfg Config) error {
	if _, err := llamacpp.NewClient(cfg.Server, cfg.Timeout); err != nil {
		return err
	}
	if cfg.PollInterval < 200*time.Millisecond || cfg.PollInterval > time.Minute {
		return fmt.Errorf("poll interval must be between 200ms and 60s")
	}
	if cfg.Timeout < 250*time.Millisecond || cfg.Timeout > 2*time.Minute {
		return fmt.Errorf("timeout must be between 250ms and 120s")
	}
	return nil
}

// SaveSettings replaces the file only after a complete write. On failure the
// old file remains intact and callers must leave the runtime config unchanged.
func SaveSettings(cfg Config) error {
	if cfg.SettingsPath == "" {
		return nil
	}
	settings := runtimeSettingsFromConfig(cfg)
	settings.SettingsPath = "" // The storage location is not itself a setting.
	data, err := json.MarshalIndent(settings, "", "  ")
	if err != nil {
		return err
	}
	directory := filepath.Dir(cfg.SettingsPath)
	if err = os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("create settings directory: %w", err)
	}
	file, err := os.CreateTemp(directory, ".settings-*")
	if err != nil {
		return fmt.Errorf("create settings file: %w", err)
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(append(data, '\n')); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(file.Name(), cfg.SettingsPath)
	}
	if err != nil {
		return fmt.Errorf("save settings %s: %w", cfg.SettingsPath, err)
	}
	return nil
}
