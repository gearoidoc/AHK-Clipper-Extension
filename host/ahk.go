package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
)

// The executable must be an AutoHotkey interpreter, so the host can't be used
// to launch any other program.
var ahkExeName = regexp.MustCompile(`(?i)^AutoHotkey[A-Za-z0-9_]*\.exe$`)

// findAutoHotkey returns the path of the AutoHotkey v2 interpreter, or "" if
// it isn't in one of the installer's default locations or on PATH.
func findAutoHotkey() string {
	if runtime.GOOS != "windows" {
		return ""
	}
	for _, path := range ahkCandidates(os.Getenv) {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			return path
		}
	}
	if path, err := exec.LookPath("AutoHotkey64.exe"); err == nil {
		return path
	}
	return ""
}

// ahkCandidates lists where the AutoHotkey v2 installer puts AutoHotkey64.exe:
// Program Files for an all-users install, LocalAppData for a current-user one.
func ahkCandidates(getenv func(string) string) []string {
	var paths []string
	if dir := getenv("ProgramFiles"); dir != "" {
		paths = append(paths, filepath.Join(dir, "AutoHotkey", "v2", "AutoHotkey64.exe"))
	}
	if dir := getenv("LOCALAPPDATA"); dir != "" {
		paths = append(paths, filepath.Join(dir, "Programs", "AutoHotkey", "v2", "AutoHotkey64.exe"))
	}
	return paths
}

// resolveAutoHotkey returns the interpreter to run: the path from Settings,
// or the auto-detected one when that is empty.
func resolveAutoHotkey(configured string) (string, error) {
	path := configured
	if path == "" {
		if path = findAutoHotkey(); path == "" {
			return "", fail(codeAhkMissing, "AutoHotkey v2 wasn't found. Install it, or set the path to AutoHotkey64.exe in Settings.")
		}
	}
	if !filepath.IsAbs(path) || !ahkExeName.MatchString(filepath.Base(path)) {
		return "", fail(codeAhkMissing, "The AutoHotkey path in Settings must be the full path to AutoHotkey64.exe.")
	}
	if info, err := os.Stat(path); err != nil || !info.Mode().IsRegular() {
		return "", fail(codeAhkMissing, "AutoHotkey isn't at %s. Check the path in Settings.", path)
	}
	return path, nil
}
