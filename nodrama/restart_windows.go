package main

import (
	"os"
	"os/exec"
	"syscall"
)

func restartProcess(executable string) error {
	command := exec.Command(executable, os.Args[1:]...)
	command.Stdin, command.Stdout, command.Stderr = os.Stdin, os.Stdout, os.Stderr
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	return command.Start()
}
