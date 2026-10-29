package main

import (
	"encoding/json"
	"fmt"
	"image/png"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"golang.org/x/image/webp"
)

const (
	versionFile = "VERSION"
	winresDir   = "winres"
)

var semverPattern = regexp.MustCompile(`^v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-SNAPSHOT)?$`)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	raw, err := os.ReadFile(versionFile)
	if err != nil {
		return err
	}
	version := strings.TrimSpace(string(raw))
	matches := semverPattern.FindStringSubmatch(version)
	if len(matches) != 4 {
		return fmt.Errorf("%s must contain vX.Y.Z or vX.Y.Z-SNAPSHOT, got %q", versionFile, version)
	}
	numericVersion := fmt.Sprintf("%s.%s.%s.0", matches[1], matches[2], matches[3])
	if err := os.MkdirAll(filepath.Join(winresDir, "generated"), 0o755); err != nil {
		return err
	}
	for _, size := range []int{16, 32, 48, 64, 128, 256} {
		source := filepath.Join(winresDir, "icons", fmt.Sprintf("icon_%d.webp", size))
		path := filepath.Join(winresDir, "generated", fmt.Sprintf("icon_%d.png", size))
		if err := writeIconPNG(source, path, size); err != nil {
			return err
		}
	}
	config := map[string]any{
		"RT_GROUP_ICON": map[string]any{
			"APP": map[string]any{
				"0000": []string{
					"generated/icon_256.png",
					"generated/icon_128.png",
					"generated/icon_64.png",
					"generated/icon_48.png",
					"generated/icon_32.png",
					"generated/icon_16.png",
				},
			},
		},
		"RT_MANIFEST": map[string]any{
			"#1": map[string]any{
				"0409": map[string]any{
					"description":     "llama.nodrama",
					"minimum-os":      "win10",
					"execution-level": "as invoker",
					"dpi-awareness":   "per monitor v2",
					"long-path-aware": true,
				},
			},
		},
		"RT_VERSION": map[string]any{
			"#1": map[string]any{
				"0000": map[string]any{
					"fixed": map[string]any{
						"file_version":    numericVersion,
						"product_version": numericVersion,
						"flags":           versionFlags(version),
					},
					"info": map[string]any{
						"0409": map[string]string{
							"CompanyName":      "Hangry Labs",
							"FileDescription":  "llama.cpp dashboard",
							"FileVersion":      version,
							"InternalName":     "llama-nodrama",
							"LegalCopyright":   "Copyright (c) 2026 Hangry Labs",
							"OriginalFilename": "llama-nodrama.exe",
							"ProductName":      "llama.nodrama",
							"ProductVersion":   version,
						},
					},
				},
			},
		},
	}
	out, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(winresDir, "winres.json"), append(out, '\n'), 0o644)
}

func versionFlags(version string) string {
	if strings.Contains(version, "-SNAPSHOT") {
		return "Prerelease"
	}
	return ""
}

// Windows resources require PNG/DIB data. Only WebP sources are tracked;
// generated PNG intermediates live in the ignored winres/generated directory.
func writeIconPNG(source, path string, size int) error {
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	img, err := webp.Decode(file)
	file.Close()
	if err != nil {
		return fmt.Errorf("decode icon %s: %w", source, err)
	}
	if img.Bounds().Dx() != size || img.Bounds().Dy() != size {
		return fmt.Errorf("icon %s must be %dx%d", source, size, size)
	}
	output, err := os.Create(path)
	if err != nil {
		return err
	}
	err = png.Encode(output, img)
	closeErr := output.Close()
	if err != nil {
		return err
	}
	return closeErr
}
