package app

import "testing"

func TestParseContextFromArgs(t *testing.T) {
	tests := []struct {
		name string
		args []string
		want int
	}{
		{name: "short split", args: []string{"llama-server", "-c", "307200"}, want: 307200},
		{name: "long split", args: []string{"llama-server", "--ctx-size", "300000"}, want: 300000},
		{name: "long equals", args: []string{"llama-server", "--ctx-size=358400"}, want: 358400},
		{name: "missing", args: []string{"llama-server"}, want: 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := parseContextFromArgs(tt.args); got != tt.want {
				t.Fatalf("context = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestParsePortFromArgs(t *testing.T) {
	if got := parsePortFromArgs([]string{"llama-server", "--port", "18080"}); got != "18080" {
		t.Fatalf("port = %q", got)
	}
	if got := parsePortFromArgs([]string{"llama-server", "--port=18081"}); got != "18081" {
		t.Fatalf("port = %q", got)
	}
}

func TestIsLlamaServerArgs(t *testing.T) {
	if !isLlamaServerArgs([]string{"/app/llama-server", "-c", "307200"}) {
		t.Fatal("expected llama-server args")
	}
	if isLlamaServerArgs([]string{"llama-nodrama", "--server", "http://127.0.0.1:18080"}) {
		t.Fatal("llama-nodrama should not match llama-server")
	}
}
