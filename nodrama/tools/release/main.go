package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
)

const versionFile = "VERSION"

var snapshotVersionPattern = regexp.MustCompile(`^v([0-9]+)\.([0-9]+)\.([0-9]+)-SNAPSHOT$`)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	if out, err := gitOutput("status", "--porcelain"); err != nil {
		return err
	} else if strings.TrimSpace(out) != "" {
		return fmt.Errorf("working tree must be clean before release:\n%s", out)
	}

	raw, err := os.ReadFile(versionFile)
	if err != nil {
		return err
	}
	current := strings.TrimSpace(string(raw))
	matches := snapshotVersionPattern.FindStringSubmatch(current)
	if len(matches) != 4 {
		return fmt.Errorf("%s must contain vX.Y.Z-SNAPSHOT, got %q", versionFile, current)
	}

	major := mustAtoi(matches[1])
	minor := mustAtoi(matches[2])
	release := fmt.Sprintf("v%d.%d.%s", major, minor, matches[3])
	next := fmt.Sprintf("v%d.%d.0-SNAPSHOT", major, minor+1)

	if _, err := gitOutput("rev-parse", "-q", "--verify", "refs/tags/"+release); err == nil {
		return fmt.Errorf("tag %s already exists", release)
	}

	if err := writeVersion(release); err != nil {
		return err
	}
	if err := git("add", versionFile); err != nil {
		return err
	}
	if err := git("commit", "-m", "chore: release "+release); err != nil {
		return err
	}
	if err := git("tag", "-a", release, "-m", release); err != nil {
		return err
	}

	if err := writeVersion(next); err != nil {
		return err
	}
	if err := git("add", versionFile); err != nil {
		return err
	}
	if err := git("commit", "-m", "chore: start "+next); err != nil {
		return err
	}
	if err := git("push", "origin", "HEAD", "--follow-tags"); err != nil {
		return err
	}

	fmt.Printf("released %s, opened %s, and pushed commits/tags\n", release, next)
	return nil
}

func writeVersion(version string) error {
	return os.WriteFile(versionFile, []byte(version+"\n"), 0o644)
}

func git(args ...string) error {
	cmd := exec.Command("git", args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
}

func gitOutput(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = os.Stderr
	err := cmd.Run()
	return out.String(), err
}

func mustAtoi(value string) int {
	parsed, err := strconv.Atoi(value)
	if err != nil {
		panic(err)
	}
	return parsed
}
