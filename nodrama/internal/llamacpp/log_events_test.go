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

func TestParsePromptEvalLogLine(t *testing.T) {
	event, ok := ParseLogLine("1699.58.709.999 I slot print_timing: id  1 | task 3079110 | prompt eval time =     355.18 ms /   590 tokens (    0.60 ms per token,  1661.15 tokens per second)", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("prompt eval line was not parsed")
	}
	if event.Kind != "prompt_eval" {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.SlotID != 1 || event.TaskID != 3079110 {
		t.Fatalf("slot/task = %d/%d", event.SlotID, event.TaskID)
	}
	if event.PromptTokens != 590 {
		t.Fatalf("prompt tokens = %d", event.PromptTokens)
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

func TestParseCacheStateLogLine(t *testing.T) {
	event, ok := ParseLogLine("124.55.424.001 I srv update: - cache state: 13 prompts, 7022.706 MiB (limits: 8192.000 MiB, 358400 tokens, 358400 est)", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("cache state line was not parsed")
	}
	if event.Kind != "cache" {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.CachePrompts != 13 {
		t.Fatalf("cache prompts = %d", event.CachePrompts)
	}
	if event.CacheUsedMiB != 7022.706 {
		t.Fatalf("cache used MiB = %v", event.CacheUsedMiB)
	}
	if event.CacheLimitMiB != 8192.000 {
		t.Fatalf("cache limit MiB = %v", event.CacheLimitMiB)
	}
	if event.CacheLimitTokens != 358400 {
		t.Fatalf("cache limit tokens = %d", event.CacheLimitTokens)
	}
	if event.CacheEstTokens != 358400 {
		t.Fatalf("cache est tokens = %d", event.CacheEstTokens)
	}
}

func TestParseDeploymentContextLogLine(t *testing.T) {
	event, ok := ParseLogLine("0.45.270.896 W llama_context: n_ctx_seq (307200) > n_ctx_train (262144) -- possible training context overflow", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("deployment context line was not parsed")
	}
	if event.Kind != "config" {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.DeploymentCtx != 307200 {
		t.Fatalf("deployment context = %d", event.DeploymentCtx)
	}
}

func TestParseSlotContextLogLine(t *testing.T) {
	event, ok := ParseLogLine("0.47.931.676 W srv    load_model: the slot context (307200) exceeds the training context of the model (262144) - capping", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("slot context line was not parsed")
	}
	if event.Kind != "config" {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.DeploymentCtx != 307200 {
		t.Fatalf("deployment context = %d", event.DeploymentCtx)
	}
}

func TestParsePromptCacheKeyLogLine(t *testing.T) {
	event, ok := ParseLogLine("1699.36.265.797 I srv        update:    - prompt 0x5fca730e7cf0:     584 tokens, checkpoints:  1,   131.697 MiB", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("prompt cache key line was not parsed")
	}
	if event.Kind != "cache" || event.CacheAction != "observe" {
		t.Fatalf("kind/action = %q/%q", event.Kind, event.CacheAction)
	}
	if event.CacheKey != "0x5fca730e7cf0" {
		t.Fatalf("cache key = %q", event.CacheKey)
	}
	if event.PromptTokens != 584 {
		t.Fatalf("prompt tokens = %d", event.PromptTokens)
	}
}

func TestParseLaunchLogLine(t *testing.T) {
	event, ok := ParseLogLine("1699.36.265.954 I slot launch_slot_: id  1 | task 3079110 | processing task, is_child = 0", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("launch line was not parsed")
	}
	if event.Kind != "launch" {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.SlotID != 1 || event.TaskID != 3079110 {
		t.Fatalf("slot/task = %d/%d", event.SlotID, event.TaskID)
	}
}

func TestParseRestoredCheckpointTokens(t *testing.T) {
	event, ok := ParseLogLine("1699.36.288.943 W slot update_slots: id  1 | task 3079110 | restored context checkpoint (pos_min = 6, pos_max = 6, n_tokens = 7, n_past = 7, size = 62.813 MiB)", time.Unix(1_700_000_000, 0))
	if !ok {
		t.Fatal("restore line was not parsed")
	}
	if event.Kind != "warning" {
		t.Fatalf("kind = %q", event.Kind)
	}
	if event.SlotID != 1 || event.TaskID != 3079110 {
		t.Fatalf("slot/task = %d/%d", event.SlotID, event.TaskID)
	}
	if event.RestoredTokens != 7 {
		t.Fatalf("restored tokens = %d", event.RestoredTokens)
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
