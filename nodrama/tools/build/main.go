package main

import (
	"bytes"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const versionFile = "VERSION"

type target struct {
	goos   string
	goarch string
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	var all bool
	var goos string
	var goarch string
	flag.BoolVar(&all, "all", false, "build common release targets")
	flag.StringVar(&goos, "os", runtime.GOOS, "target GOOS for single-target builds")
	flag.StringVar(&goarch, "arch", runtime.GOARCH, "target GOARCH for single-target builds")
	flag.Parse()

	targets := []target{{goos: goos, goarch: goarch}}
	if all {
		targets = []target{
			{goos: "linux", goarch: "amd64"},
			{goos: "linux", goarch: "arm64"},
			{goos: "darwin", goarch: "amd64"},
			{goos: "darwin", goarch: "arm64"},
			{goos: "windows", goarch: "amd64"},
			{goos: "windows", goarch: "arm64"},
		}
	}

	version, err := readVersion()
	if err != nil {
		return err
	}
	commit := gitCommit()
	buildDate := time.Now().UTC().Format("2006-01-02T15:04:05Z")
	if err := os.MkdirAll("bin", 0o755); err != nil {
		return err
	}

	for _, target := range targets {
		if err := buildTarget(target, version, commit, buildDate, all); err != nil {
			return err
		}
	}
	return nil
}

func readVersion() (string, error) {
	raw, err := os.ReadFile(versionFile)
	if err != nil {
		return "", err
	}
	version := strings.TrimSpace(string(raw))
	if version == "" {
		return "", fmt.Errorf("%s is empty", versionFile)
	}
	return version, nil
}

func buildTarget(target target, version, commit, buildDate string, matrixName bool) error {
	if target.goos == "windows" {
		if err := prepareWindowsResources(target.goarch); err != nil {
			return err
		}
	}

	name := "llama-nodrama"
	if matrixName {
		name = fmt.Sprintf("llama-nodrama-%s-%s", target.goos, target.goarch)
	}
	if target.goos == "windows" {
		name += ".exe"
	}
	out := filepath.Join("bin", name)

	ldflags := fmt.Sprintf("-s -w -X main.version=%s -X main.commit=%s -X main.date=%s", version, commit, buildDate)
	cmd := exec.Command("go", "build", "-trimpath", "-ldflags", ldflags, "-o", out, ".")
	cmd.Env = append(os.Environ(),
		"CGO_ENABLED=0",
		"GOOS="+target.goos,
		"GOARCH="+target.goarch,
	)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	fmt.Printf("building %s/%s -> %s\n", target.goos, target.goarch, out)
	return cmd.Run()
}

func prepareWindowsResources(goarch string) error {
	cmd := exec.Command("go", "run", "./tools/windowsres")
	cmd.Env = nativeGoEnv()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return err
	}
	if _, err := exec.LookPath("go-winres"); err != nil {
		return fmt.Errorf("go-winres is required for Windows icon/version resources; run `task windows-res` once, then retry")
	}
	cmd = exec.Command("go-winres", "make", "--arch", goarch)
	cmd.Env = nativeGoEnv()
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func nativeGoEnv() []string {
	env := os.Environ()
	out := make([]string, 0, len(env))
	for _, value := range env {
		if strings.HasPrefix(value, "GOOS=") || strings.HasPrefix(value, "GOARCH=") {
			continue
		}
		out = append(out, value)
	}
	return append(out, "GOOS="+runtime.GOOS, "GOARCH="+runtime.GOARCH)
}

func gitCommit() string {
	cmd := exec.Command("git", "rev-parse", "--short", "HEAD")
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = ioDiscard{}
	if err := cmd.Run(); err != nil {
		return "local"
	}
	commit := strings.TrimSpace(out.String())
	if commit == "" {
		return "local"
	}
	return commit
}

type ioDiscard struct{}

func (ioDiscard) Write(p []byte) (int, error) {
	return len(p), nil
}
