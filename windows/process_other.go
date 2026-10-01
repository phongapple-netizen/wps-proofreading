//go:build !windows

package main

import "os/exec"

func startHidden(cmd *exec.Cmd) error { return cmd.Start() }
