package llamacpp

func stringAt(values map[string]any, key string) string {
	if values == nil {
		return ""
	}
	value, _ := values[key].(string)
	return value
}

func intAt(values map[string]any, key string) int {
	if values == nil {
		return 0
	}
	return int(numberAt(values, key))
}

func numberAt(values map[string]any, key string) float64 {
	if values == nil {
		return 0
	}
	switch value := values[key].(type) {
	case float64:
		return value
	case int:
		return float64(value)
	case int64:
		return float64(value)
	case jsonNumber:
		n, _ := value.Float64()
		return n
	default:
		return 0
	}
}

type jsonNumber interface {
	Float64() (float64, error)
}

func max(first int, rest ...int) int {
	out := first
	for _, value := range rest {
		if value > out {
			out = value
		}
	}
	return out
}
