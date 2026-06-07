package llamacpp

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strconv"
)

type Slot struct {
	ID                    int            `json:"id"`
	TaskID                int            `json:"taskId"`
	State                 string         `json:"state"`
	IsProcessing          bool           `json:"isProcessing"`
	ContextTokens         int            `json:"contextTokens"`
	ContextEstimateTokens int            `json:"contextEstimateTokens"`
	PromptTokens          int            `json:"promptTokens"`
	PromptProcessedTokens int            `json:"promptProcessedTokens"`
	PromptCacheTokens     int            `json:"promptCacheTokens"`
	DecodedTokens         int            `json:"decodedTokens"`
	RemainingTokens       int            `json:"remainingTokens"`
	GenerationProgress    float64        `json:"generationProgress"`
	PromptProgress        float64        `json:"promptProgress"`
	NextTokenShape        string         `json:"nextTokenShape"`
	CounterState          string         `json:"counterState,omitempty"`
	SamplerSummary        []string       `json:"samplerSummary"`
	Params                map[string]any `json:"params,omitempty"`
}

type rawSlot struct {
	ID                    int             `json:"id"`
	TaskID                int             `json:"id_task"`
	IsProcessing          bool            `json:"is_processing"`
	ContextTokens         int             `json:"n_ctx"`
	PromptTokens          int             `json:"n_prompt_tokens"`
	PromptProcessedTokens int             `json:"n_prompt_tokens_processed"`
	PromptCacheTokens     int             `json:"n_prompt_tokens_cache"`
	Params                map[string]any  `json:"params"`
	NextToken             json.RawMessage `json:"next_token"`
}

type nextToken struct {
	Decoded   int `json:"n_decoded"`
	Remaining int `json:"n_remain"`
}

func DecodeSlots(body []byte, previous map[int]Slot) ([]Slot, error) {
	var rawList []rawSlot
	if err := json.Unmarshal(body, &rawList); err != nil {
		var envelope struct {
			Slots []rawSlot `json:"slots"`
		}
		if envelopeErr := json.Unmarshal(body, &envelope); envelopeErr != nil {
			return nil, err
		}
		rawList = envelope.Slots
	}

	out := make([]Slot, 0, len(rawList))
	for _, raw := range rawList {
		normalized, err := normalizeSlot(raw, previous[raw.ID])
		if err != nil {
			return nil, err
		}
		out = append(out, normalized)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out, nil
}

func normalizeSlot(raw rawSlot, previous Slot) (Slot, error) {
	next, shape, err := decodeNextToken(raw.NextToken)
	if err != nil {
		return Slot{}, fmt.Errorf("slot %d next_token: %w", raw.ID, err)
	}

	decoded := next.Decoded
	remaining := next.Remaining
	counterState := ""
	taskChanged := previous.TaskID != 0 && raw.TaskID != previous.TaskID && raw.IsProcessing
	staleNextToken := taskChanged && decoded == previous.DecodedTokens && remaining == previous.RemainingTokens
	earlyTaskCounters := taskChanged && raw.PromptTokens == 0 && raw.PromptProcessedTokens > 0 && decoded > 0
	if staleNextToken || earlyTaskCounters {
		decoded = 0
		remaining = 0
		counterState = "settling"
	}

	nPredict := intAt(raw.Params, "n_predict")
	if nPredict <= 0 {
		nPredict = intAt(raw.Params, "max_tokens")
	}

	generationTotal := 0
	if nPredict > 0 {
		generationTotal = nPredict
	} else if decoded+remaining > 0 {
		generationTotal = decoded + max(remaining, 0)
	}

	generationProgress := 0.0
	if generationTotal > 0 {
		generationProgress = clamp(float64(decoded)/float64(generationTotal), 0, 1)
	}

	promptProgress := 0.0
	if raw.PromptTokens > 0 {
		promptProgress = clamp(float64(raw.PromptProcessedTokens)/float64(raw.PromptTokens), 0, 1)
	}

	contextEstimate := max(raw.PromptTokens, raw.PromptProcessedTokens, raw.PromptCacheTokens) + decoded
	state := "idle"
	if raw.IsProcessing {
		switch {
		case counterState == "settling":
			state = "starting"
		case decoded > 0 || remaining > 0:
			state = "generating"
		case raw.PromptTokens > 0 && raw.PromptProcessedTokens < raw.PromptTokens:
			state = "prompt-processing"
		default:
			state = "processing"
		}
	}

	return Slot{
		ID:                    raw.ID,
		TaskID:                raw.TaskID,
		State:                 state,
		IsProcessing:          raw.IsProcessing,
		ContextTokens:         raw.ContextTokens,
		ContextEstimateTokens: contextEstimate,
		PromptTokens:          raw.PromptTokens,
		PromptProcessedTokens: raw.PromptProcessedTokens,
		PromptCacheTokens:     raw.PromptCacheTokens,
		DecodedTokens:         decoded,
		RemainingTokens:       remaining,
		GenerationProgress:    generationProgress,
		PromptProgress:        promptProgress,
		NextTokenShape:        shape,
		CounterState:          counterState,
		SamplerSummary:        samplerSummary(raw.Params),
		Params:                raw.Params,
	}, nil
}

func decodeNextToken(raw json.RawMessage) (nextToken, string, error) {
	if len(raw) == 0 || string(raw) == "null" {
		return nextToken{}, "missing", nil
	}

	var object nextToken
	if err := json.Unmarshal(raw, &object); err == nil {
		return object, "object", nil
	}

	var list []nextToken
	if err := json.Unmarshal(raw, &list); err != nil {
		return nextToken{}, "", err
	}
	if len(list) == 0 {
		return nextToken{}, "array", nil
	}
	return list[0], "array", nil
}

func samplerSummary(params map[string]any) []string {
	if len(params) == 0 {
		return nil
	}
	keys := []string{"temperature", "top_k", "top_p", "min_p", "repeat_penalty", "n_predict", "max_tokens", "reasoning_format"}
	out := make([]string, 0, len(keys))
	for _, key := range keys {
		value, ok := params[key]
		if !ok {
			continue
		}
		out = append(out, key+"="+formatParam(value))
	}
	return out
}

func formatParam(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case float64:
		if math.Abs(v-math.Round(v)) < 0.000001 {
			return strconv.FormatInt(int64(math.Round(v)), 10)
		}
		return strconv.FormatFloat(v, 'f', 3, 64)
	case bool:
		return strconv.FormatBool(v)
	default:
		return fmt.Sprint(v)
	}
}

func clamp(value, lo, hi float64) float64 {
	if value < lo {
		return lo
	}
	if value > hi {
		return hi
	}
	return value
}
