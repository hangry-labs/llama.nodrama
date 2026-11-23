//go:build !windows

package main

import (
	"os"
	"syscall"
)

func restartProcess(executable string) error {
	return syscall.Exec(executable, os.Args, os.Environ())
}
