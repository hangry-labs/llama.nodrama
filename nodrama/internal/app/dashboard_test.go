package app

import "testing"

func TestCounterRate(t *testing.T) {
	if got := counterRate(100, 160, 2); got != 30 {
		t.Fatalf("rate = %v", got)
	}
	if got := counterRate(160, 100, 2); got != 0 {
		t.Fatalf("reset rate = %v", got)
	}
	if got := counterRate(100, 160, 0); got != 0 {
		t.Fatalf("empty elapsed rate = %v", got)
	}
}
