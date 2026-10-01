//go:build windows

package main

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
)

const detachedProcess = 0x00000008

func startHidden(cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | detachedProcess}
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
