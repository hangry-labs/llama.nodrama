package app

import "time"

const (
	DefaultServer = "http://127.0.0.1:8080"
	DefaultListen = ":39080"
)

type Config struct {
	Server       string
	Listen       string
	LogPath      string
	RawProxy     bool
	PollInterval time.Duration
	Timeout      time.Duration
}

type RuntimeSettings struct {
	Server       string `json:"server"`
	Listen       string `json:"listen"`
	LogPath      string `json:"logPath"`
	RawProxy     bool   `json:"rawProxy"`
	PollInterval int64  `json:"pollIntervalMs"`
	Timeout      int64  `json:"timeoutMs"`
}

type RuntimeSettingsUpdate struct {
	Server       *string `json:"server,omitempty"`
	LogPath      *string `json:"logPath,omitempty"`
	PollInterval *int64  `json:"pollIntervalMs,omitempty"`
	Timeout      *int64  `json:"timeoutMs,omitempty"`
}

type BuildInfo struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Date    string `json:"date"`
}
