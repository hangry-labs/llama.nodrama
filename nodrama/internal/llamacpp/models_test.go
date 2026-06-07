package llamacpp

import "testing"

func TestDecodeRouterModelsDetectsRouterShape(t *testing.T) {
	models, router, err := DecodeRouterModels([]byte(`{
	  "data": [
	    {"id": "a", "status": {"value": "loaded"}},
	    {"id": "b", "status": {"value": "unloaded"}}
	  ]
	}`))
	if err != nil {
		t.Fatal(err)
	}
	if !router {
		t.Fatal("router mode was not detected")
	}
	if len(models) != 2 || models[0]["id"] != "a" {
		t.Fatalf("models = %#v", models)
	}
}

func TestDecodeRouterModelsIgnoresNonRouterList(t *testing.T) {
	models, router, err := DecodeRouterModels([]byte(`{"models": [{"name": "plain"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if router {
		t.Fatal("plain model list should not be router mode")
	}
	if len(models) != 1 {
		t.Fatalf("models len = %d", len(models))
	}
}

func TestDecodeLoraAdaptersSupportsDataEnvelope(t *testing.T) {
	adapters, err := DecodeLoraAdapters([]byte(`{"data": [{"id": 1, "path": "a.bin", "scale": 0.8}]}`))
	if err != nil {
		t.Fatal(err)
	}
	if len(adapters) != 1 || adapters[0]["path"] != "a.bin" {
		t.Fatalf("adapters = %#v", adapters)
	}
}
