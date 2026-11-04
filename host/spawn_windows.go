//go:build windows

package main

import (
	"errors"
	"os/exec"
	"syscall"
)

const (
	detachedProcess        = 0x00000008
	createBreakawayFromJob = 0x01000000
)

// startDetached starts AutoHotkey without the host's console or process
// group. Chrome doesn't put hosts in a job object, but if something else did,
// breaking away keeps AutoHotkey alive when that job closes. A job that
// forbids breakaway refuses the flag, so it retries without it.
func startDetached(newCmd func() *exec.Cmd) (*exec.Cmd, error) {
	flags := uint32(detachedProcess | syscall.CREATE_NEW_PROCESS_GROUP)
	cmd := newCmd()
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags | createBreakawayFromJob}
	err := cmd.Start()
	if errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		cmd = newCmd()
		cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: flags}
		err = cmd.Start()
	}
	return cmd, err
}
