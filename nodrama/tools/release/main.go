package main

import (
	"bytes"
	"flag"
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
	dryRun := flag.Bool("dry-run", false, "preview promotion without modifying files or Git refs")
	flag.Parse()
	if *dryRun {
		raw, err := os.ReadFile(versionFile)
		if err != nil {
			return err
		}
		matches := snapshotVersionPattern.FindStringSubmatch(strings.TrimSpace(string(raw)))
		if len(matches) != 4 {
			return fmt.Errorf("expected snapshot version")
		}
		fmt.Printf("Would release v%s.%s.%s, open v%s.%d.0-SNAPSHOT, and atomically push main with the release tag. No files or refs changed.\n", matches[1], matches[2], matches[3], matches[1], mustAtoi(matches[2])+1)
		return nil
	}
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
	branch, err := gitOutput("branch", "--show-current")
	if err != nil {
		return err
	}
	if strings.TrimSpace(branch) != "main" {
		return fmt.Errorf("release requires main")
	}
	if err := git("fetch", "origin", "main", "--tags"); err != nil {
		return err
	}
	local, err := gitOutput("rev-parse", "HEAD")
	if err != nil {
		return err
	}
	remote, err := gitOutput("rev-parse", "origin/main")
	if err != nil {
		return err
	}
	if local != remote {
		return fmt.Errorf("main must be synchronized with origin/main")
	}

	if _, err := gitOutput("rev-parse", "-q", "--verify", "refs/tags/"+release); err == nil {
		return fmt.Errorf("tag %s already exists", release)
	}
	checks := exec.Command("go", "run", "./tools/check")
	checks.Stdout, checks.Stderr = os.Stdout, os.Stderr
	if err := checks.Run(); err != nil {
		return fmt.Errorf("release checks: %w", err)
	}

	if err := writeVersion(release); err != nil {
		return err
	}
	if err := refreshWindowsResources(); err != nil {
		return err
	}
	if err := git("add", versionFile, "winres"); err != nil {
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
	if err := refreshWindowsResources(); err != nil {
		return err
	}
	if err := git("add", versionFile, "winres"); err != nil {
		return err
	}
	if err := git("commit", "-m", "chore: start "+next); err != nil {
		return err
	}
	if err := git("push", "--atomic", "origin", "HEAD:refs/heads/main", "refs/tags/"+release); err != nil {
		return fmt.Errorf("%w; inspect refs and retry: git push --atomic origin HEAD:refs/heads/main refs/tags/%s (do not rerun promotion)", err, release)
	}

	fmt.Printf("released %s, opened %s, and pushed commits/tags\n", release, next)
	return nil
}

func writeVersion(version string) error {
	return os.WriteFile(versionFile, []byte(version+"\n"), 0o644)
}

func refreshWindowsResources() error {
	cmd := exec.Command("go", "run", "./tools/windowsres")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	return cmd.Run()
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
