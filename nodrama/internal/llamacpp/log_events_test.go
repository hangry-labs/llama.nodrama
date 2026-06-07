package llamacpp

import (
	"testing"
	"time"
)

func TestParseTimingLogLine(t *testing.T) {
	event, ok := ParseLogLine("124.55.423.849 I slot print_timing: id  2 | task 248761 | n_decoded =   7609, tg =  38.97 t/s", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("timing line was not parsed")
	}
	if event.Kind != "timing" {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.TimestampRaw != "124.55.423.849" {
		t.Fatalf("timestamp = %q", event.TimestampRaw)
	}
	if event.Severity != "I" {
		t.Fatalf("severity = %q", event.Severity)
	}
	if event.SlotID != 2 || event.TaskID != 248761 {
		t.Fatalf("slot/task = %d/%d", event.SlotID, event.TaskID)
	}
	if event.DecodedTokens != 7609 {
		t.Fatalf("decoded = %d", event.DecodedTokens)
	}
	if event.TokensPerSecond != 38.97 {
		t.Fatalf("tg = %v", event.TokensPerSecond)
	}
}

func TestParseCacheLogLine(t *testing.T) {
	event, ok := ParseLogLine("124.55.423.849 I slot 2 kv cache reused, task 248761", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("cache line was not parsed")
	}
	if event.Kind != "cache" {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.CacheAction != "reuse" {
		t.Fatalf("cache action = %q", event.CacheAction)
	}
	if event.SlotID != 2 || event.TaskID != 248761 {
		t.Fatalf("slot/task = %d/%d", event.SlotID, event.TaskID)
	}
}

func TestParseCacheLogLineIgnoresNegativeTaskID(t *testing.T) {
	event, ok := ParseLogLine("154.55.789.160 I slot slot_save_an: id  1 | task -1 | saving idle slot to prompt cache", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("cache line was not parsed")
	}
	if event.TaskID != 0 {
		t.Fatalf("negative task id should be ignored, got %d", event.TaskID)
	}
}

func TestParseWarningLogLine(t *testing.T) {
	event, ok := ParseLogLine("W slot 1 request failed", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("warning line was not parsed")
	}
	if event.Kind != "warning" {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.SlotID != 1 {
		t.Fatalf("slot = %d", event.SlotID)
	}
}
