package app

import (
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

func localLlamaServerContextTokens(server string) int {
	if runtime.GOOS != "linux" {
		return 0
	}
	serverPort := portFromServerURL(server)
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return 0
	}

	best := 0
	for _, entry := range entries {
		if !entry.IsDir() || !numeric(entry.Name()) {
			continue
		}
		data, err := os.ReadFile(filepath.Join("/proc", entry.Name(), "cmdline"))
		if err != nil || len(data) == 0 {
			continue
		}
		args := splitProcCmdline(data)
		if !isLlamaServerArgs(args) {
			continue
		}
		if serverPort != "" {
			processPort := parsePortFromArgs(args)
			if processPort != "" && processPort != serverPort {
				continue
			}
		}
		if ctx := parseContextFromArgs(args); ctx > best {
			best = ctx
		}
	}
	return best
}

func splitProcCmdline(data []byte) []string {
	raw := strings.Split(strings.TrimRight(string(data), "\x00"), "\x00")
	out := make([]string, 0, len(raw))
	for _, value := range raw {
		if value != "" {
			out = append(out, value)
		}
	}
	return out
}

func isLlamaServerArgs(args []string) bool {
	for _, arg := range args {
		base := filepath.Base(arg)
		if base == "llama-server" || strings.HasPrefix(base, "llama-server.") {
			return true
		}
	}
	return false
}

func parseContextFromArgs(args []string) int {
	for i, arg := range args {
		switch arg {
		case "-c", "--ctx-size", "--ctx_size":
			if i+1 < len(args) {
				return positiveAtoi(args[i+1])
			}
		}
		for _, prefix := range []string{"-c=", "--ctx-size=", "--ctx_size="} {
			if strings.HasPrefix(arg, prefix) {
				return positiveAtoi(strings.TrimPrefix(arg, prefix))
			}
		}
	}
	return 0
}

func parsePortFromArgs(args []string) string {
	for i, arg := range args {
		switch arg {
		case "--port":
			if i+1 < len(args) {
				return args[i+1]
			}
		}
		if strings.HasPrefix(arg, "--port=") {
			return strings.TrimPrefix(arg, "--port=")
		}
	}
	return ""
}

func portFromServerURL(server string) string {
	parsed, err := url.Parse(server)
	if err != nil {
		return ""
	}
	return parsed.Port()
}

func numeric(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if char < '0' || char > '9' {
			return false
		}
	}
	return true
}

func positiveAtoi(value string) int {
	parsed, err := strconv.Atoi(value)
	if err != nil || parsed <= 0 {
		return 0
	}
	return parsed
}
