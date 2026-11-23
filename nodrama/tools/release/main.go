package main

import (
	"flag"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strings"
)

var sourceVersionPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-SNAPSHOT)?$`)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	dryRun := flag.Bool("dry-run", false, "show automatic release policy without running checks or changing files/refs")
	flag.Parse()
	raw, err := os.ReadFile("VERSION")
	if err != nil {
		return err
	}
	line, err := releaseLine(strings.TrimSpace(string(raw)))
	if err != nil {
		return err
	}
	if !*dryRun {
		checks := exec.Command("go", "run", "./tools/check")
		checks.Stdout, checks.Stderr = os.Stdout, os.Stderr
		if err := checks.Run(); err != nil {
			return err
		}
	}
	fmt.Printf("Main CI publishes the next unused patch in %s after reviewed changes are pushed and checks pass. No files or Git refs changed.\n", line)
	return nil
}

func releaseLine(source string) (string, error) {
	parts := sourceVersionPattern.FindStringSubmatch(source)
	if len(parts) != 4 {
		return "", fmt.Errorf("expected vX.Y.Z or vX.Y.Z-SNAPSHOT, got %q", source)
	}
	return fmt.Sprintf("v%s.%s.x (starting at v%s.%s.%s)", parts[1], parts[2], parts[1], parts[2], parts[3]), nil
}
