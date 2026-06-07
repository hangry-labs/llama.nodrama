package llamacpp

import "testing"

func TestDecodePropsIncludesSleepingState(t *testing.T) {
	props, err := DecodeProps([]byte(`{
	  "model_alias": "demo",
	  "total_slots": 3,
	  "is_sleeping": true,
	  "default_generation_settings": {"n_ctx": 4096, "params": {"temperature": 0.7}}
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if !props.IsSleeping {
		t.Fatal("sleeping state was not decoded")
	}
	if props.ContextTokens != 4096 {
		t.Fatalf("context tokens = %d", props.ContextTokens)
	}
}
