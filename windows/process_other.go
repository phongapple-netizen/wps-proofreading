//go:build !windows

package main

import (
	"context"
	"os"
	"os/exec"
)

func batchCommand(ctx context.Context, command string) *exec.Cmd {
	return exec.CommandContext(ctx, "cmd.exe", "/d", "/s", "/c", `"`+command+`"`)
}

func hideWindow(cmd *exec.Cmd) {}

func startHidden(cmd *exec.Cmd) error { return cmd.Start() }

func killManagedProcess(process *os.Process) error { return process.Kill() }
