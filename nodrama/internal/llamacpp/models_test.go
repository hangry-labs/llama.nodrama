package llamacpp

import "testing"

func TestDecodeModelsPreservesInputModalities(t *testing.T) {
	models, err := DecodeModels([]byte(`{"data":[{"id":"synthetic","architecture":{"input_modalities":["text","image"]}}]}`))
	if err != nil || len(models) != 1 {
		t.Fatalf("models=%#v, %v", models, err)
	}
	inputs, ok := models[0].Architecture["input_modalities"].([]any)
	if !ok || len(inputs) != 2 || inputs[1] != "image" {
		t.Fatalf("input modalities lost: %#v", models[0])
	}
}

func TestDecodeModelsToleratesOtherArchitectureMetadata(t *testing.T) {
	models, err := DecodeModels([]byte(`{"data":[{"id":"synthetic","architecture":"text-model"}]}`))
	if err != nil || len(models) != 1 || models[0].ID != "synthetic" {
		t.Fatalf("models=%#v, %v", models, err)
	}
}

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
