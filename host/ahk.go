package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

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
