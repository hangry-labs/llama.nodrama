package llamacpp

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Probe struct {
	OK        bool   `json:"ok"`
	Status    int    `json:"status"`
	Error     string `json:"error,omitempty"`
	LatencyMS int64  `json:"latencyMs"`
	Bytes     int    `json:"bytes"`
}

type Client struct {
	base    string
	timeout time.Duration
	http    *http.Client
}

func NewClient(rawBase string, timeout time.Duration) (*Client, error) {
	parsed, err := url.Parse(rawBase)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return nil, fmt.Errorf("server URL must use http or https")
	}
	if parsed.Host == "" {
		return nil, fmt.Errorf("server URL must include a host")
	}
	if timeout <= 0 {
		timeout = 5 * time.Second
	}
	return &Client{
		base:    strings.TrimRight(parsed.String(), "/"),
		timeout: timeout,
		http: &http.Client{
			Timeout: timeout,
		},
	}, nil
}

func (c *Client) Get(ctx context.Context, path string) (Probe, []byte) {
	start := time.Now()
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return Probe{Error: err.Error(), LatencyMS: time.Since(start).Milliseconds()}, nil
	}
	req.Header.Set("Accept", "application/json,text/plain,*/*")
	req.Header.Set("User-Agent", "llama-nodrama")

	resp, err := c.http.Do(req)
	if err != nil {
		return Probe{Error: err.Error(), LatencyMS: time.Since(start).Milliseconds()}, nil
	}
	defer resp.Body.Close()

	body, readErr := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	probe := Probe{
		OK:        resp.StatusCode >= 200 && resp.StatusCode < 300,
		Status:    resp.StatusCode,
		LatencyMS: time.Since(start).Milliseconds(),
		Bytes:     len(body),
	}
	if readErr != nil {
		probe.OK = false
		probe.Error = readErr.Error()
		return probe, body
	}
	if !probe.OK {
		probe.Error = resp.Status
	}
	return probe, body
}
