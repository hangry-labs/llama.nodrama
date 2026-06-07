package app

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestReadLogTail(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "server.log")
	if err := os.WriteFile(path, []byte("one\ntwo\nthree\nfour\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	tail, err := readLogTail(path, 12, 2)
	if err != nil {
		t.Fatal(err)
	}
	if !tail.Enabled {
		t.Fatal("tail should be enabled")
	}
	if len(tail.Lines) != 2 {
		t.Fatalf("lines len = %d: %#v", len(tail.Lines), tail.Lines)
	}
	if tail.Lines[0] != "three" || tail.Lines[1] != "four" {
		t.Fatalf("lines = %#v", tail.Lines)
	}
	if !tail.Truncated {
		t.Fatal("expected truncated tail")
	}
}

func TestLogTailHandlerDisabled(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/logs/tail", nil)
	rec := httptest.NewRecorder()

	logTailHandler("").ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d", rec.Code)
	}
	if rec.Body.String() != "{\"enabled\":false}\n" {
		t.Fatalf("body = %q", rec.Body.String())
	}
}
