package main

import (
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
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
	if err := os.MkdirAll(filepath.Join(winresDir, "icons"), 0o755); err != nil {
		return err
	}
	for _, size := range []int{16, 32, 48, 64, 128, 256} {
		path := filepath.Join(winresDir, "icons", fmt.Sprintf("icon_%d.png", size))
		if err := ensureIconPNG(path, size); err != nil {
			return err
		}
	}
	config := map[string]any{
		"RT_GROUP_ICON": map[string]any{
			"APP": map[string]any{
				"0000": []string{
					"icons/icon_256.png",
					"icons/icon_128.png",
					"icons/icon_64.png",
					"icons/icon_48.png",
					"icons/icon_32.png",
					"icons/icon_16.png",
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
							"LegalCopyright":   "MIT License",
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

func ensureIconPNG(path string, size int) error {
	if info, err := os.Stat(path); err == nil && info.Size() > 0 {
		return nil
	}
	return writeFallbackIconPNG(path, size)
}

func writeFallbackIconPNG(path string, size int) error {
	img := image.NewRGBA(image.Rect(0, 0, size, size))
	transparent := color.RGBA{}
	draw.Draw(img, img.Bounds(), image.NewUniform(transparent), image.Point{}, draw.Src)
	cx := float64(size) / 2
	cy := float64(size) / 2
	radius := float64(size) * 0.45
	for y := 0; y < size; y++ {
		for x := 0; x < size; x++ {
			dx := float64(x) + 0.5 - cx
			dy := float64(y) + 0.5 - cy
			dist := math.Sqrt(dx*dx + dy*dy)
			if dist > radius {
				continue
			}
			t := float64(y) / float64(max(size-1, 1))
			base := mix(color.RGBA{0x12, 0x2b, 0x45, 0xff}, color.RGBA{0x1d, 0x4e, 0x75, 0xff}, t)
			img.SetRGBA(x, y, base)
		}
	}
	stroke := color.RGBA{0x58, 0xa6, 0xff, 0xff}
	light := color.RGBA{0xe6, 0xed, 0xf3, 0xff}
	drawLine(img, point{0.31, 0.64}, point{0.48, 0.28}, stroke, float64(size)*0.08)
	drawLine(img, point{0.48, 0.28}, point{0.66, 0.64}, stroke, float64(size)*0.08)
	drawLine(img, point{0.38, 0.52}, point{0.59, 0.52}, light, float64(size)*0.055)
	drawCircle(img, point{0.31, 0.64}, float64(size)*0.055, light)
	drawCircle(img, point{0.48, 0.28}, float64(size)*0.055, light)
	drawCircle(img, point{0.66, 0.64}, float64(size)*0.055, light)
	file, err := os.Create(path)
	if err != nil {
		return err
	}
	defer file.Close()
	return png.Encode(file, img)
}

type point struct {
	x float64
	y float64
}

func drawLine(img *image.RGBA, a, b point, c color.RGBA, width float64) {
	bounds := img.Bounds()
	ax := a.x * float64(bounds.Dx())
	ay := a.y * float64(bounds.Dy())
	bx := b.x * float64(bounds.Dx())
	by := b.y * float64(bounds.Dy())
	minX := int(math.Floor(math.Min(ax, bx) - width))
	maxX := int(math.Ceil(math.Max(ax, bx) + width))
	minY := int(math.Floor(math.Min(ay, by) - width))
	maxY := int(math.Ceil(math.Max(ay, by) + width))
	for y := minY; y <= maxY; y++ {
		for x := minX; x <= maxX; x++ {
			if x < 0 || y < 0 || x >= bounds.Dx() || y >= bounds.Dy() {
				continue
			}
			if distanceToSegment(float64(x)+0.5, float64(y)+0.5, ax, ay, bx, by) <= width/2 {
				img.SetRGBA(x, y, c)
			}
		}
	}
}

func drawCircle(img *image.RGBA, center point, radius float64, c color.RGBA) {
	bounds := img.Bounds()
	cx := center.x * float64(bounds.Dx())
	cy := center.y * float64(bounds.Dy())
	for y := int(cy - radius); y <= int(cy+radius); y++ {
		for x := int(cx - radius); x <= int(cx+radius); x++ {
			if x < 0 || y < 0 || x >= bounds.Dx() || y >= bounds.Dy() {
				continue
			}
			dx := float64(x) + 0.5 - cx
			dy := float64(y) + 0.5 - cy
			if math.Sqrt(dx*dx+dy*dy) <= radius {
				img.SetRGBA(x, y, c)
			}
		}
	}
}

func distanceToSegment(px, py, ax, ay, bx, by float64) float64 {
	dx := bx - ax
	dy := by - ay
	if dx == 0 && dy == 0 {
		return math.Hypot(px-ax, py-ay)
	}
	t := ((px-ax)*dx + (py-ay)*dy) / (dx*dx + dy*dy)
	t = math.Max(0, math.Min(1, t))
	return math.Hypot(px-(ax+t*dx), py-(ay+t*dy))
}

func mix(a, b color.RGBA, t float64) color.RGBA {
	return color.RGBA{
		R: uint8(lerp(int(a.R), int(b.R), t)),
		G: uint8(lerp(int(a.G), int(b.G), t)),
		B: uint8(lerp(int(a.B), int(b.B), t)),
		A: 0xff,
	}
}

func lerp(a, b int, t float64) int {
	return a + int(math.Round(float64(b-a)*t))
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
