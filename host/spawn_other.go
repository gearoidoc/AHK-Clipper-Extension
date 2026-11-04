//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// startDetached starts the process in its own session so it outlives the
// host. Only the Linux e2e test runs this path, with a fake AutoHotkey.
func startDetached(newCmd func() *exec.Cmd) (*exec.Cmd, error) {
	cmd := newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	return cmd, cmd.Start()
}
