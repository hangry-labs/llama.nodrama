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

	flag.Usage = func() {
		out := flag.CommandLine.Output()
		fmt.Fprintf(out, "llama-nodrama %s\n\n", resolvedVersion())
		fmt.Fprintln(out, "Usage:")
		fmt.Fprintln(out, "  llama-nodrama [options]")
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Examples:")
		fmt.Fprintf(out, "  llama-nodrama --server %s --listen %s\n", app.DefaultServer, app.DefaultListen)
		fmt.Fprintln(out, "  llama-nodrama --server http://192.168.1.50:8080 --log C:\\path\\to\\llama-server.log")
		fmt.Fprintln(out)
		fmt.Fprintln(out, "If llama.cpp is not found, open the dashboard and use the Settings button,")
		fmt.Fprintln(out, "or restart with --server pointing to your llama-server base URL.")
		fmt.Fprintln(out)
		fmt.Fprintln(out, "Options:")
		flag.PrintDefaults()
	}
	flag.StringVar(&cfg.Server, "server", app.DefaultServer, "llama.cpp server base URL")
	flag.StringVar(&cfg.Listen, "listen", app.DefaultListen, "HTTP listen address for the dashboard")
	flag.StringVar(&cfg.LogPath, "log", "", "optional llama.cpp log file path for /api/logs/tail")
	flag.BoolVar(&cfg.RawProxy, "raw-proxy", false, "expose selected raw llama.cpp proxy routes for debugging")
	flag.DurationVar(&cfg.PollInterval, "poll", time.Second, "llama.cpp polling interval")
	flag.DurationVar(&cfg.Timeout, "timeout", 5*time.Second, "upstream request timeout")
	flag.BoolVar(&showVersion, "version", false, "print version and exit")
	flag.Parse()

	version = resolvedVersion()
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

func resolvedVersion() string {
	if version != "" {
		return version
	}
	fromFile := strings.TrimSpace(versionFile)
	if fromFile != "" {
		return fromFile
	}
	return "dev"
}
