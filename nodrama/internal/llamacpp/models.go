package llamacpp

import "encoding/json"

type ModelSummary struct {
	ID      string         `json:"id"`
	Aliases []string       `json:"aliases,omitempty"`
	OwnedBy string         `json:"ownedBy,omitempty"`
	Object  string         `json:"object,omitempty"`
	Family  string         `json:"family,omitempty"`
	Format  string         `json:"format,omitempty"`
	Size    float64        `json:"size,omitempty"`
	Params  float64        `json:"params,omitempty"`
	Meta    map[string]any `json:"meta,omitempty"`
}

func DecodeModels(body []byte) ([]ModelSummary, error) {
	var envelope struct {
		Data []struct {
			ID      string         `json:"id"`
			Aliases []string       `json:"aliases"`
			OwnedBy string         `json:"owned_by"`
			Object  string         `json:"object"`
			Meta    map[string]any `json:"meta"`
		} `json:"data"`
		Models []struct {
			Name    string `json:"name"`
			Model   string `json:"model"`
			Details struct {
				Family string `json:"family"`
				Format string `json:"format"`
			} `json:"details"`
		} `json:"models"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, err
	}

	out := make([]ModelSummary, 0, len(envelope.Data)+len(envelope.Models))
	seen := map[string]bool{}
	for _, model := range envelope.Data {
		if model.ID == "" || seen[model.ID] {
			continue
		}
		seen[model.ID] = true
		out = append(out, ModelSummary{
			ID:      model.ID,
			Aliases: model.Aliases,
			OwnedBy: model.OwnedBy,
			Object:  model.Object,
			Size:    numberAt(model.Meta, "size"),
			Params:  numberAt(model.Meta, "n_params"),
			Meta:    model.Meta,
		})
	}
	for _, model := range envelope.Models {
		id := model.Model
		if id == "" {
			id = model.Name
		}
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, ModelSummary{
			ID:     id,
			Family: model.Details.Family,
			Format: model.Details.Format,
		})
	}
	return out, nil
}

func DecodeRouterModels(body []byte) ([]map[string]any, bool, error) {
	list, err := decodeObjectList(body, "data", "models")
	if err != nil {
		return nil, false, err
	}
	router := false
	for _, item := range list {
		status, ok := item["status"].(map[string]any)
		if ok {
			_, router = status["value"]
		}
		if router {
			break
		}
	}
	return list, router, nil
}

func DecodeLoraAdapters(body []byte) ([]map[string]any, error) {
	return decodeObjectList(body, "data", "adapters", "lora_adapters")
}

func decodeObjectList(body []byte, keys ...string) ([]map[string]any, error) {
	var raw any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}

	var list []any
	switch value := raw.(type) {
	case []any:
		list = value
	case map[string]any:
		for _, key := range keys {
			if nested, ok := value[key].([]any); ok {
				list = nested
				break
			}
		}
	}

	out := make([]map[string]any, 0, len(list))
	for _, item := range list {
		object, ok := item.(map[string]any)
		if !ok {
			continue
		}
		out = append(out, object)
	}
	return out, nil
}
