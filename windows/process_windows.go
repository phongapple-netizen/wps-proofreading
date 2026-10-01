//go:build windows

package main

import (
	"context"
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

const detachedProcess = 0x00000008

func batchCommand(ctx context.Context, command string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "cmd.exe")
	// cmd.exe does not use CommandLineToArgvW quoting. Supply its command line
	// directly, so embedded quotes are not escaped a second time by os/exec.
	cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: syscall.EscapeArg(cmd.Path) + ` /d /s /c "` + command + `"`}
	return cmd
}

func hideWindow(cmd *exec.Cmd) {
	if cmd.SysProcAttr == nil {
		cmd.SysProcAttr = &syscall.SysProcAttr{}
	}
	cmd.SysProcAttr.HideWindow = true
}

func startHidden(cmd *exec.Cmd) error {
	hideWindow(cmd)
	cmd.SysProcAttr.CreationFlags |= syscall.CREATE_NEW_PROCESS_GROUP | detachedProcess
	return cmd.Start()
}

func killManagedProcess(process *os.Process) error {
	// npm's .cmd launcher can own the actual server as a descendant.
	cmd := exec.Command("taskkill.exe", "/PID", strconv.Itoa(process.Pid), "/T", "/F")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if err := cmd.Run(); err != nil {
		return process.Kill()
	}
	return nil
}
