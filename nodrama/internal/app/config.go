package app

import "time"

type Config struct {
	Server       string
	Listen       string
	PollInterval time.Duration
	Timeout      time.Duration
}

type BuildInfo struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Date    string `json:"date"`
}
