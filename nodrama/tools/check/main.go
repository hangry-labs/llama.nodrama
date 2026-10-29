// Command check runs the same dependency-free Go and UI checks locally and in CI.
package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if _, err := os.Stat("go.mod"); err != nil {
		return fmt.Errorf("run this command from nodrama: go run ./tools/check")
	}
	if _, err := exec.LookPath("node"); err != nil {
		return fmt.Errorf("UI checks require Node.js 22 or newer on PATH: %w", err)
	}
	fmt.Println("Checking Go formatting")
	formatted, err := exec.Command("gofmt", "-l", ".").Output()
	if err != nil {
		return fmt.Errorf("gofmt: %w", err)
	}
	if files := strings.TrimSpace(string(formatted)); files != "" {
		return fmt.Errorf("run gofmt on:\n%s", files)
	}
	for _, args := range [][]string{{"vet", "./..."}, {"test", "./..."}} {
		if err := command("go", args...); err != nil {
			return err
		}
	}
	// Node compiles every browser script, verifies asset references/translations,
	// and exercises chat streams/state without a live model or npm dependencies.
	tests, err := filepath.Glob("tests/*.test.cjs")
	if err != nil {
		return err
	}
	if len(tests) == 0 {
		return fmt.Errorf("no UI regression tests found")
	}
	return command("node", append([]string{"--test"}, tests...)...)
}

func command(name string, args ...string) error {
	fmt.Println(name, strings.Join(args, " "))
	cmd := exec.Command(name, args...)
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s checks failed: %w", name, err)
	}
	return nil
}
