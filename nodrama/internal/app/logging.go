package app

import (
	"log"
	"os"
)

var startupBanner = []string{
	" _   _                                _          _         ",
	"| | | | __ _ _ __   __ _ _ __ _   _  | |    __ _| |__  ___ ",
	"| |_| |/ _` | '_ \\ / _` | '__| | | | | |   / _` | '_ \\/ __|",
	"|  _  | (_| | | | | (_| | |  | |_| | | |__| (_| | |_) \\__ \\",
	"|_| |_|\\__,_|_| |_|\\__, |_|   \\__, | |_____\\__,_|_.__/|___/",
	"                   |___/      |___/                         ",
	"      llama.nodrama - no drama, just slots",
}

func logStartupBanner() {
	for _, line := range startupBanner {
		logInfof("%s", line)
	}
}

func logDebugf(format string, args ...any) {
	if os.Getenv("LLAMA_NODRAMA_DEBUG") == "" {
		return
	}
	log.Printf("DEBUG "+format, args...)
}

func logInfof(format string, args ...any) {
	log.Printf("INFO  "+format, args...)
}

func logWarnf(format string, args ...any) {
	log.Printf("WARN  "+format, args...)
}
