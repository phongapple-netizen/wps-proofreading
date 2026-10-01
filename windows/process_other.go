//go:build !windows

package main

import (
	"os"
	"os/exec"
)

func startHidden(cmd *exec.Cmd) error { return cmd.Start() }

func killManagedProcess(process *os.Process) error { return process.Kill() }
