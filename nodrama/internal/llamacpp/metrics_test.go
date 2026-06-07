package llamacpp

import "testing"

func TestParsePrometheus(t *testing.T) {
	parsed := ParsePrometheus(`# HELP llamacpp:requests_processing requests
llamacpp:requests_processing 2
llamacpp:prompt_tokens_seconds 1207.29
llamacpp:ignored NaN
metric_with_labels{slot="0"} 42
`)

	if parsed["llamacpp:requests_processing"] != 2 {
		t.Fatalf("requests_processing = %v", parsed["llamacpp:requests_processing"])
	}
	if parsed["llamacpp:prompt_tokens_seconds"] != 1207.29 {
		t.Fatalf("prompt_tokens_seconds = %v", parsed["llamacpp:prompt_tokens_seconds"])
	}
	if _, ok := parsed["llamacpp:ignored"]; ok {
		t.Fatalf("NaN metric should be ignored")
	}
	if parsed["metric_with_labels"] != 42 {
		t.Fatalf("metric_with_labels = %v", parsed["metric_with_labels"])
	}
}
