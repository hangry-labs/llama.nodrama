package llamacpp

import "testing"

func TestDecodePropsPreservesVisionCapability(t *testing.T) {
	props, err := DecodeProps([]byte(`{"modalities":{"vision":true},"chat_template_caps":{"vision":true}}`))
	if err != nil || props.Modalities["vision"] != true || props.ChatTemplateCaps["vision"] != true {
		t.Fatalf("vision metadata lost: %#v, %v", props, err)
	}
}

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
