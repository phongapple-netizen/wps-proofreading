//go:build windows

package main

import (
	"os/exec"
	"syscall"
)

const detachedProcess = 0x00000008

func startHidden(cmd *exec.Cmd) error {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: syscall.CREATE_NEW_PROCESS_GROUP | detachedProcess}
	return cmd.Start()
}
