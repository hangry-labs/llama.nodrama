package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	chatMetadataReadLimit = 4 * 1024 * 1024
	usageBufferLimit      = 1024 * 1024
)

type chatRequestMetadata struct {
	Model  string `json:"model"`
	Stream bool   `json:"stream"`
}

func registerAPIProxies(mux *http.ServeMux, rawTarget string, dashboard *Dashboard) error {
	target, err := url.Parse(rawTarget)
	if err != nil {
		return fmt.Errorf("configure api proxy target: %w", err)
	}

	mux.Handle("POST /api/chat/completions", chatCompletionsHandler(target, dashboard))
	mux.Handle("POST /api/models/load", fixedPathProxy(target, dashboard, "/api/models/load", "/models/load"))
	mux.Handle("POST /api/models/unload", fixedPathProxy(target, dashboard, "/api/models/unload", "/models/unload"))
	mux.Handle("POST /api/slots/{id}/save", slotActionProxy(target, dashboard, "save"))
	mux.Handle("POST /api/slots/{id}/restore", slotActionProxy(target, dashboard, "restore"))
	mux.Handle("POST /api/slots/{id}/erase", slotActionProxy(target, dashboard, "erase"))
	return nil
}

func chatCompletionsHandler(target *url.URL, dashboard *Dashboard) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		meta := readChatRequestMetadata(r)
		proxy := reverseProxy(target, "/v1/chat/completions", "")
		serveTrackedProxy(w, r, dashboard, "/api/chat/completions", meta.Model, meta.Stream, proxy)
	})
}

func fixedPathProxy(target *url.URL, dashboard *Dashboard, route, upstreamPath string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		meta := readChatRequestMetadata(r)
		serveTrackedProxy(w, r, dashboard, route, meta.Model, false, reverseProxy(target, upstreamPath, ""))
	})
}

func slotActionProxy(target *url.URL, dashboard *Dashboard, action string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		slotID := r.PathValue("id")
		if _, err := strconv.Atoi(slotID); err != nil {
			http.Error(w, "invalid slot id", http.StatusBadRequest)
			return
		}
		upstreamPath := "/slots/" + slotID
		route := "/api/slots/" + slotID + "/" + action
		serveTrackedProxy(w, r, dashboard, route, "", false, reverseProxy(target, upstreamPath, "action="+url.QueryEscape(action)))
	})
}

func serveTrackedProxy(w http.ResponseWriter, r *http.Request, dashboard *Dashboard, route, model string, stream bool, proxy *httputil.ReverseProxy) {
	requestID := dashboard.StartRequest(route, model, stream)
	w.Header().Set("X-Nodrama-Request-ID", requestID)

	tracker := &trackingResponseWriter{ResponseWriter: w}
	var proxyErr string
	proxy.ErrorHandler = func(w http.ResponseWriter, req *http.Request, err error) {
		proxyErr = err.Error()
		http.Error(w, "upstream error: "+err.Error(), http.StatusBadGateway)
	}
	proxy.ServeHTTP(tracker, r)

	status := tracker.status
	if status == 0 {
		status = http.StatusOK
	}
	dashboard.FinishRequest(requestID, status, tracker.bytes, tracker.usage.finish(), proxyErr)
}

func reverseProxy(target *url.URL, upstreamPath, upstreamQuery string) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.FlushInterval = 100 * time.Millisecond
	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		originalDirector(req)
		req.URL.Path = joinURLPath(target.Path, upstreamPath)
		req.URL.RawPath = ""
		req.URL.RawQuery = upstreamQuery
		req.Host = target.Host
		req.Header.Set("User-Agent", "llama-nodrama")
		req.Header.Set("Cache-Control", "no-store")
	}
	return proxy
}

func joinURLPath(basePath, upstreamPath string) string {
	if basePath == "" || basePath == "/" {
		if strings.HasPrefix(upstreamPath, "/") {
			return upstreamPath
		}
		return "/" + upstreamPath
	}
	return strings.TrimRight(basePath, "/") + "/" + strings.TrimLeft(upstreamPath, "/")
}

func readChatRequestMetadata(r *http.Request) chatRequestMetadata {
	if r.Body == nil {
		return chatRequestMetadata{}
	}

	original := r.Body
	prefix, _ := io.ReadAll(io.LimitReader(original, chatMetadataReadLimit+1))
	r.Body = multiReadCloser{
		Reader: io.MultiReader(bytes.NewReader(prefix), original),
		Closer: original,
	}

	if len(prefix) > chatMetadataReadLimit {
		return chatRequestMetadata{}
	}
	var meta chatRequestMetadata
	if err := json.Unmarshal(prefix, &meta); err != nil {
		return chatRequestMetadata{}
	}
	return meta
}

type multiReadCloser struct {
	io.Reader
	io.Closer
}

type trackingResponseWriter struct {
	http.ResponseWriter
	status int
	bytes  int64
	usage  usageAccumulator
}

func (w *trackingResponseWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *trackingResponseWriter) Write(p []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	n, err := w.ResponseWriter.Write(p)
	w.bytes += int64(n)
	w.usage.add(p[:n])
	return n, err
}

func (w *trackingResponseWriter) Flush() {
	if flusher, ok := w.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (w *trackingResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := w.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, http.ErrNotSupported
	}
	return hijacker.Hijack()
}

type usageAccumulator struct {
	buf   []byte
	usage TokenUsage
	seen  bool
}

func (u *usageAccumulator) add(p []byte) {
	if len(u.buf)+len(p) > usageBufferLimit {
		remaining := usageBufferLimit - len(u.buf)
		if remaining <= 0 {
			return
		}
		p = p[:remaining]
	}
	u.buf = append(u.buf, p...)

	for {
		idx := bytes.IndexByte(u.buf, '\n')
		if idx < 0 {
			return
		}
		line := string(bytes.TrimSpace(u.buf[:idx]))
		u.buf = u.buf[idx+1:]
		u.parseLine(line)
	}
}

func (u *usageAccumulator) finish() *TokenUsage {
	if len(bytes.TrimSpace(u.buf)) > 0 {
		u.parseLine(string(bytes.TrimSpace(u.buf)))
		u.parseJSON(bytes.TrimSpace(u.buf))
	}
	if !u.seen {
		return nil
	}
	usage := u.usage
	return &usage
}

func (u *usageAccumulator) parseLine(line string) {
	if line == "" {
		return
	}
	if strings.HasPrefix(line, "data:") {
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			return
		}
		u.parseJSON([]byte(payload))
		return
	}
	u.parseJSON([]byte(line))
}

func (u *usageAccumulator) parseJSON(payload []byte) {
	var envelope struct {
		Usage struct {
			PromptTokens     int `json:"prompt_tokens"`
			CompletionTokens int `json:"completion_tokens"`
			TotalTokens      int `json:"total_tokens"`
		} `json:"usage"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil {
		return
	}
	if envelope.Usage.PromptTokens == 0 && envelope.Usage.CompletionTokens == 0 && envelope.Usage.TotalTokens == 0 {
		return
	}
	u.usage = TokenUsage{
		PromptTokens:     envelope.Usage.PromptTokens,
		CompletionTokens: envelope.Usage.CompletionTokens,
		TotalTokens:      envelope.Usage.TotalTokens,
	}
	u.seen = true
}
