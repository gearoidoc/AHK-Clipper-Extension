package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

var (
	entryID   = regexp.MustCompile(`^[a-z2-9]{6}$`)
	sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type undoRequest struct {
	Type    string `json:"type"`
	Folder  string `json:"folder"`
	AhkPath string `json:"ahkPath"`
	Reload  string `json:"reload"`
	File    string `json:"file"`
	ID      string `json:"id"`
	Sha256  string `json:"sha256"`
}

type undoReply struct {
	OK   bool   `json:"ok"`
	File string `json:"file"`
	// True when the file went back to exactly what it was before the save,
	// which also brings back a hotstring that was replaced.
	Exact bool `json:"exact"`
}

// handleUndo reverses one save. If the file is still exactly as that save
// left it, the .bak written just before the save holds the previous bytes and
// goes back as-is. Otherwise only the entry with the save's id is removed.
func handleUndo(raw []byte) (any, error) {
	var req undoRequest
	if err := decodeStrict(raw, &req); err != nil {
		return nil, err
	}
	if !entryID.MatchString(req.ID) || !sha256Hex.MatchString(req.Sha256) {
		return nil, fail(codeBadRequest, "id and sha256 must come from a save reply")
	}
	folder, err := resolveFolder(req.Folder)
	if err != nil {
		return nil, err
	}
	exe, err := resolveAutoHotkey(req.AhkPath)
	if err != nil {
		return nil, err
	}
	target, err := resolveFile(folder, req.File, true)
	if err != nil {
		return nil, err
	}
	entry, err := resolveEntry(folder, target, req.Reload)
	if err != nil {
		return nil, err
	}

	unlock, err := lockFolder(folder)
	if err != nil {
		return nil, err
	}
	defer unlock()

	tf, err := readText(target)
	if err != nil {
		return nil, err
	}
	var data []byte
	exact := false
	if fileHash(tf.original) == req.Sha256 {
		// The .bak is the state before the save unless it already holds the
		// entry, which would mean some later write refreshed it.
		if bak, err := os.ReadFile(target + ".bak"); err == nil && !strings.Contains(string(bak), "hsc:"+req.ID) {
			data, exact = bak, true
		}
	}
	if !exact {
		text, removed := removeEntry(tf.text, req.ID)
		if !removed {
			return nil, fail(codeFileChanged, "That hotstring isn't in %s any more.", filepath.Base(target))
		}
		data = tf.encode(text)
	}
	if err := commit(exe, []string{entry}, []change{{target, tf, data}}); err != nil {
		return nil, err
	}
	return undoReply{OK: true, File: filepath.Base(target), Exact: exact}, nil
}

// removeEntry deletes the line ending in "; hsc:<id>" and a source comment
// directly above it.
func removeEntry(text, id string) (string, bool) {
	lines := strings.Split(text, "\n")
	for i, line := range lines {
		if parsed, ok := parseHotstringLine(strings.TrimSuffix(line, "\r")); !ok || parsed.ID != id {
			continue
		}
		first := i
		if i > 0 && strings.HasPrefix(strings.TrimSpace(lines[i-1]), commentPrefix) {
			first = i - 1
		}
		return strings.Join(append(lines[:first], lines[i+1:]...), "\n"), true
	}
	return text, false
}
