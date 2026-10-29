package app

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"sync"
)

// Parallel replies share one browser connection. Separate streaming fetches
// exhaust HTTP/1 connection pools and prevent snapshot/log polling.
type chatBatchFrame struct {
	Index       int    `json:"index"`
	Type        string `json:"type"`
	Status      int    `json:"status,omitempty"`
	ContentType string `json:"contentType,omitempty"`
	Data        []byte `json:"data,omitempty"` // Base64 preserves arbitrary UTF-8/SSE chunk boundaries.
	Error       string `json:"error,omitempty"`
}

func chatBatchHandler(dashboard *Dashboard) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		count, err := strconv.Atoi(r.URL.Query().Get("count"))
		if err != nil || count < 1 || count > 8 {
			http.Error(w, "count must be between 1 and 8", http.StatusBadRequest)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, chatMetadataReadLimit))
		if err != nil {
			http.Error(w, "chat batch body exceeds limit or cannot be read", http.StatusRequestEntityTooLarge)
			return
		}
		var meta chatRequestMetadata
		if json.Unmarshal(body, &meta) != nil || !meta.Stream {
			http.Error(w, "batch requires a streaming chat request", http.StatusBadRequest)
			return
		}
		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()
		w.Header().Set("Content-Type", "application/x-ndjson")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Accel-Buffering", "no")
		if err := http.NewResponseController(w).Flush(); err != nil {
			return
		}
		var mutex sync.Mutex
		encoder := json.NewEncoder(w)
		emit := func(frame chatBatchFrame) error {
			mutex.Lock()
			defer mutex.Unlock()
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := encoder.Encode(frame); err != nil {
				cancel()
				return err
			}
			if err := http.NewResponseController(w).Flush(); err != nil {
				cancel()
				return err
			}
			return nil
		}
		var workers sync.WaitGroup
		handler := chatCompletionsHandler(dashboard)
		for index := 0; index < count; index++ {
			workers.Add(1)
			go func(index int) {
				defer workers.Done()
				defer func() {
					if cause := recover(); cause != nil {
						if cause != http.ErrAbortHandler {
							logWarnf("chat_batch_worker_panic index=%d", index)
						}
						_ = emit(chatBatchFrame{Index: index, Type: "error", Error: "Upstream chat stream interrupted"})
					}
				}()
				request := r.Clone(ctx)
				request.Body = io.NopCloser(bytes.NewReader(body))
				request.ContentLength = int64(len(body))
				request.TransferEncoding = nil
				request.Header.Set("Accept", "text/event-stream")
				// Let the Go transport decompress before framing upstream bytes.
				request.Header.Del("Accept-Encoding")
				writer := &chatBatchResponseWriter{header: make(http.Header), index: index, emit: emit}
				handler.ServeHTTP(writer, request)
				writer.WriteHeader(http.StatusOK)
				_ = emit(chatBatchFrame{Index: index, Type: "done"})
			}(index)
		}
		workers.Wait()
	})
}

type chatBatchResponseWriter struct {
	header      http.Header
	index       int
	wroteHeader bool
	err         error
	emit        func(chatBatchFrame) error
}

func (w *chatBatchResponseWriter) Header() http.Header { return w.header }
func (w *chatBatchResponseWriter) WriteHeader(status int) {
	if w.wroteHeader || status < 200 {
		return
	}
	w.wroteHeader = true
	w.err = w.emit(chatBatchFrame{Index: w.index, Type: "headers", Status: status, ContentType: w.header.Get("Content-Type")})
}
func (w *chatBatchResponseWriter) Write(data []byte) (int, error) {
	w.WriteHeader(http.StatusOK)
	if w.err != nil {
		return 0, w.err
	}
	if err := w.emit(chatBatchFrame{Index: w.index, Type: "data", Data: data}); err != nil {
		return 0, fmt.Errorf("write batch stream: %w", err)
	}
	return len(data), nil
}
func (w *chatBatchResponseWriter) Flush() {} // Each emitted frame is already flushed.
