package main

import (
	"context"
	_ "embed"
	"flag"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"llama.nodrama/nodrama/internal/app"
)

//go:embed VERSION
var versionFile string

var (
	version = ""
	commit  = "local"
	date    = "unknown"
)

func main() {
	var cfg app.Config
	var showVersion bool

	flag.StringVar(&cfg.Server, "server", "http://127.0.0.1:18080", "llama.cpp server base URL")
	flag.StringVar(&cfg.Listen, "listen", ":39080", "HTTP listen address for the dashboard")
	flag.StringVar(&cfg.LogPath, "log", "", "optional llama.cpp log file path for /api/logs/tail")
	flag.BoolVar(&cfg.RawProxy, "raw-proxy", false, "expose selected raw llama.cpp proxy routes for debugging")
	flag.DurationVar(&cfg.PollInterval, "poll", time.Second, "llama.cpp polling interval")
	flag.DurationVar(&cfg.Timeout, "timeout", 5*time.Second, "upstream request timeout")
	flag.BoolVar(&showVersion, "version", false, "print version and exit")
	flag.Parse()

	if version == "" {
		version = strings.TrimSpace(versionFile)
	}
	if version == "" {
		version = "dev"
	}
	info := app.BuildInfo{Version: version, Commit: commit, Date: date}
	if showVersion {
		fmt.Printf("llama-nodrama %s %s %s\n", info.Version, info.Commit, info.Date)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := app.Run(ctx, cfg, info); err != nil {
		log.Fatal(err)
	}
}
