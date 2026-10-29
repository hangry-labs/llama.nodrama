package main

import (
	"image/color"
	"image/png"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/image/webp"
)

func TestWebPIconPreservesPixelsInWindowsIntermediate(t *testing.T) {
	source := filepath.Join("..", "..", "winres", "icons", "icon_16.webp")
	target := filepath.Join(t.TempDir(), "icon.png")
	if err := writeIconPNG(source, target, 16); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	before, err := webp.Decode(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	f, err = os.Open(target)
	if err != nil {
		t.Fatal(err)
	}
	after, err := png.Decode(f)
	f.Close()
	if err != nil {
		t.Fatal(err)
	}
	if before.Bounds() != after.Bounds() {
		t.Fatal("icon dimensions changed")
	}
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			if color.NRGBAModel.Convert(before.At(x, y)) != color.NRGBAModel.Convert(after.At(x, y)) {
				t.Fatalf("pixel changed at %d,%d", x, y)
			}
		}
	}
	if err := writeIconPNG(source, target, 32); err == nil {
		t.Fatal("wrong icon dimensions accepted")
	}
}
