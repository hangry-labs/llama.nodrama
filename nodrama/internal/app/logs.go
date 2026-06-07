package app

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"os"
	"strconv"
	"time"
)

const (
	defaultLogTailBytes = 64 * 1024
	maxLogTailBytes     = 1024 * 1024
	defaultLogTailLines = 2000
	maxLogTailLines     = 10000
)

type LogTailResponse struct {
	Enabled   bool       `json:"enabled"`
	Size      int64      `json:"size,omitempty"`
	Lines     []string   `json:"lines,omitempty"`
	Truncated bool       `json:"truncated,omitempty"`
	UpdatedAt *time.Time `json:"updatedAt,omitempty"`
	Error     string     `json:"error,omitempty"`
}

func logTailHandler(path string) http.HandlerFunc {
	return logTailHandlerFunc(func() string { return path })
}

func runtimeLogTailHandler(dashboard *Dashboard) http.HandlerFunc {
	return logTailHandlerFunc(func() string { return dashboard.Settings().LogPath })
}

func logTailHandlerFunc(pathFn func() string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path := pathFn()
		if path == "" {
			writeJSON(w, LogTailResponse{Enabled: false})
			return
		}
		limitBytes := clampInt(queryInt(r, "bytes", defaultLogTailBytes), 1, maxLogTailBytes)
		limitLines := clampInt(queryInt(r, "lines", defaultLogTailLines), 1, maxLogTailLines)
		payload, err := readLogTail(path, limitBytes, limitLines)
		if err != nil {
			status := http.StatusInternalServerError
			if errors.Is(err, os.ErrNotExist) {
				status = http.StatusNotFound
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.WriteHeader(status)
			writeJSON(w, LogTailResponse{Enabled: true, Error: err.Error()})
			return
		}
		writeJSON(w, payload)
	}
}

func readLogTail(path string, limitBytes, limitLines int) (LogTailResponse, error) {
	file, err := os.Open(path)
	if err != nil {
		return LogTailResponse{}, err
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return LogTailResponse{}, err
	}
	size := info.Size()
	readSize := int64(limitBytes)
	if size < readSize {
		readSize = size
	}
	offset := size - readSize
	if offset > 0 {
		if _, err := file.Seek(offset, 0); err != nil {
			return LogTailResponse{}, err
		}
	}
	buf := make([]byte, readSize)
	n, err := io.ReadFull(file, buf)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return LogTailResponse{}, err
	}
	buf = buf[:n]
	if offset > 0 {
		if idx := bytes.IndexByte(buf, '\n'); idx >= 0 && idx+1 < len(buf) {
			buf = buf[idx+1:]
		}
	}
	lines := splitLogLines(buf)
	if len(lines) > limitLines {
		lines = lines[len(lines)-limitLines:]
	}
	updatedAt := info.ModTime()
	return LogTailResponse{
		Enabled:   true,
		Size:      size,
		Lines:     lines,
		Truncated: offset > 0,
		UpdatedAt: &updatedAt,
	}, nil
}

func splitLogLines(buf []byte) []string {
	raw := bytes.Split(bytes.ReplaceAll(buf, []byte("\r\n"), []byte("\n")), []byte("\n"))
	if len(raw) > 0 && len(raw[len(raw)-1]) == 0 {
		raw = raw[:len(raw)-1]
	}
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		lines = append(lines, string(line))
	}
	return lines
}

func queryInt(r *http.Request, key string, fallback int) int {
	raw := r.URL.Query().Get(key)
	if raw == "" {
		return fallback
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return value
}

func clampInt(value, minValue, maxValue int) int {
	if value < minValue {
		return minValue
	}
	if value > maxValue {
		return maxValue
	}
	return value
}
