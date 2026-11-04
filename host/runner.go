package main

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	validateTimeout = 10 * time.Second
	// A script that fails to load under /restart exits almost at once.
	restartGrace = 750 * time.Millisecond
	maxAhkOutput = 1500
)

// ahkRunner runs AutoHotkey; tests swap in a fake.
type ahkRunner interface {
	// Validate loads script without running it.
	Validate(exe, script string) error
	// Restart starts script in place of its running instance, if any.
	Restart(exe, script string) error
}

var runner ahkRunner = processRunner{}

type processRunner struct{}

// Validate runs `AutoHotkey64.exe /Validate`, which exits before the
// single-instance check, so it never disturbs the running script.
func (processRunner) Validate(exe, script string) error {
	ctx, cancel := context.WithTimeout(context.Background(), validateTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "/ErrorStdOut=UTF-8", "/Validate", script)
	cmd.Dir = filepath.Dir(script)
	var out bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &out
	err := cmd.Run()
	var exitErr *exec.ExitError
	switch {
	case ctx.Err() != nil:
		return fail(codeAhkInvalid, "AutoHotkey took longer than %s to check %s.", validateTimeout, filepath.Base(script))
	case errors.As(err, &exitErr):
		return fail(codeAhkInvalid, "AutoHotkey can't load %s, so nothing was saved:\n%s", filepath.Base(script), ahkOutput(out.String()))
	case err != nil:
		return fail(codeAhkMissing, "Couldn't run %s: %v", exe, err)
	}
	return nil
}

// Restart runs `AutoHotkey64.exe /restart`, which closes the running instance
// of the same script once the new one has loaded. The new process is detached
// so it outlives this host; a failure shows up as an early non-zero exit.
func (processRunner) Restart(exe, script string) error {
	var out bytes.Buffer
	cmd, err := startDetached(func() *exec.Cmd {
		out.Reset()
		cmd := exec.Command(exe, "/ErrorStdOut=UTF-8", "/restart", script)
		cmd.Dir = filepath.Dir(script)
		cmd.Stderr = &out
		return cmd
	})
	if err != nil {
		return fail(codeReloadFailed, "Couldn't start AutoHotkey: %v", err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return fail(codeReloadFailed, "AutoHotkey stopped while reloading %s:\n%s", filepath.Base(script), ahkOutput(out.String()))
		}
	case <-time.After(restartGrace):
	}
	return nil
}

func ahkOutput(s string) string {
	s = strings.TrimSpace(s)
	if s == "" {
		return "(AutoHotkey gave no details)"
	}
	if len(s) > maxAhkOutput {
		s = s[:maxAhkOutput] + "\u2026"
	}
	return s
}
