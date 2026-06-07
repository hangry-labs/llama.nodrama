package llamacpp

import "encoding/json"

type PropsSummary struct {
	ModelAlias      string         `json:"modelAlias,omitempty"`
	ModelPath       string         `json:"modelPath,omitempty"`
	BuildInfo       string         `json:"buildInfo,omitempty"`
	TotalSlots      int            `json:"totalSlots"`
	ContextTokens   int            `json:"contextTokens"`
	ContextTrain    int            `json:"contextTrain"`
	IsSleeping      bool           `json:"isSleeping"`
	Modalities      map[string]any `json:"modalities,omitempty"`
	SamplerDefaults map[string]any `json:"samplerDefaults,omitempty"`
}

func DecodeProps(body []byte) (PropsSummary, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return PropsSummary{}, err
	}

	settings, _ := raw["default_generation_settings"].(map[string]any)
	params, _ := settings["params"].(map[string]any)
	modalities, _ := raw["modalities"].(map[string]any)

	contextTokens := intAt(settings, "n_ctx")
	if contextTokens == 0 {
		contextTokens = intAt(raw, "n_ctx")
	}

	return PropsSummary{
		ModelAlias:      stringAt(raw, "model_alias"),
		ModelPath:       stringAt(raw, "model_path"),
		BuildInfo:       stringAt(raw, "build_info"),
		TotalSlots:      intAt(raw, "total_slots"),
		ContextTokens:   contextTokens,
		ContextTrain:    intAt(raw, "n_ctx_train"),
		IsSleeping:      boolAt(raw, "is_sleeping"),
		Modalities:      modalities,
		SamplerDefaults: params,
	}, nil
}
