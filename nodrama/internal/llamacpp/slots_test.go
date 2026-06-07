package llamacpp

import "testing"

func TestDecodeSlotsNormalizesNextTokenArray(t *testing.T) {
	body := []byte(`[
	  {
	    "id": 1,
	    "id_task": 31020,
	    "n_ctx": 262144,
	    "is_processing": true,
	    "n_prompt_tokens": 7366,
	    "n_prompt_tokens_processed": 1892,
	    "n_prompt_tokens_cache": 12,
	    "params": {"temperature": 0.1, "n_predict": 32768},
	    "next_token": [{"n_remain": 0, "n_decoded": 0}]
	  }
	]`)

	slots, err := DecodeSlots(body, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(slots) != 1 {
		t.Fatalf("slots len = %d", len(slots))
	}
	slot := slots[0]
	if slot.NextTokenShape != "array" {
		t.Fatalf("shape = %s", slot.NextTokenShape)
	}
	if slot.DecodedTokens != 0 || slot.RemainingTokens != 0 {
		t.Fatalf("decoded/remain = %d/%d", slot.DecodedTokens, slot.RemainingTokens)
	}
	if slot.State != "prompt-processing" {
		t.Fatalf("state = %s", slot.State)
	}
}

func TestDecodeSlotsGenerationTakesPrecedenceAfterCountersSettle(t *testing.T) {
	body := []byte(`[
	  {
	    "id": 1,
	    "id_task": 31020,
	    "n_ctx": 262144,
	    "is_processing": true,
	    "n_prompt_tokens": 27,
	    "n_prompt_tokens_processed": 26,
	    "n_prompt_tokens_cache": 0,
	    "params": {"temperature": 0.1, "n_predict": 220},
	    "next_token": [{"n_remain": 201, "n_decoded": 19}]
	  }
	]`)

	slots, err := DecodeSlots(body, nil)
	if err != nil {
		t.Fatal(err)
	}
	if slots[0].State != "generating" {
		t.Fatalf("state = %s", slots[0].State)
	}
}

func TestDecodeSlotsSuppressesStaleCountersOnTaskChange(t *testing.T) {
	previous := map[int]Slot{
		1: {ID: 1, TaskID: 100, DecodedTokens: 678, RemainingTokens: 32090},
	}
	body := []byte(`[
	  {
	    "id": 1,
	    "id_task": 101,
	    "n_ctx": 262144,
	    "is_processing": true,
	    "n_prompt_tokens": 0,
	    "n_prompt_tokens_processed": 1692,
	    "params": {"n_predict": 32768},
	    "next_token": [{"n_remain": 32090, "n_decoded": 678}]
	  }
	]`)

	slots, err := DecodeSlots(body, previous)
	if err != nil {
		t.Fatal(err)
	}
	slot := slots[0]
	if slot.CounterState != "settling" {
		t.Fatalf("counter state = %q", slot.CounterState)
	}
	if slot.DecodedTokens != 0 || slot.RemainingTokens != 0 {
		t.Fatalf("stale decoded/remain were not reset: %d/%d", slot.DecodedTokens, slot.RemainingTokens)
	}
}

func TestDecodeSlotsSuppressesUnchangedNextTokenOnTaskChange(t *testing.T) {
	previous := map[int]Slot{
		1: {ID: 1, TaskID: 100, DecodedTokens: 220, RemainingTokens: 0},
	}
	body := []byte(`[
	  {
	    "id": 1,
	    "id_task": 101,
	    "n_ctx": 262144,
	    "is_processing": true,
	    "n_prompt_tokens": 15,
	    "n_prompt_tokens_processed": 15,
	    "params": {"n_predict": 180},
	    "next_token": [{"n_remain": 0, "n_decoded": 220}]
	  }
	]`)

	slots, err := DecodeSlots(body, previous)
	if err != nil {
		t.Fatal(err)
	}
	slot := slots[0]
	if slot.CounterState != "settling" || slot.State != "starting" {
		t.Fatalf("state/counter = %s/%s", slot.State, slot.CounterState)
	}
	if slot.DecodedTokens != 0 || slot.RemainingTokens != 0 {
		t.Fatalf("stale decoded/remain were not reset: %d/%d", slot.DecodedTokens, slot.RemainingTokens)
	}
}
