package main

import (
	"crypto/rand"
	"path/filepath"
)

// Entry ids avoid letters and digits that are easy to confuse.
const idAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

type saveRequest struct {
	Type    string `json:"type"`
	Folder  string `json:"folder"`
	AhkPath string `json:"ahkPath"`
	File    string `json:"file"`
	Line    string `json:"line"`
	// The script to restart: a main script that #Includes File, or "" to
	// restart File itself.
	Reload string `json:"reload"`
}

type saveReply struct {
	OK   bool   `json:"ok"`
	ID   string `json:"id"`
	File string `json:"file"`
	// The script that was validated and restarted.
	Entry        string `json:"entry"`
	IncludeAdded bool   `json:"includeAdded"`
}

// handleSave appends one hotstring and makes it live. It either succeeds
// completely or leaves every file as it was: the files are written, the entry
// script is validated with AutoHotkey, and only then restarted; any failure
// along the way restores the original bytes.
func handleSave(raw []byte) (any, error) {
	var req saveRequest
	if err := decodeStrict(raw, &req); err != nil {
		return nil, err
	}
	if err := checkHotstringLine(req.Line); err != nil {
		return nil, err
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
	entry := target
	if req.Reload != "" {
		if entry, err = resolveFile(folder, req.Reload, true); err != nil {
			return nil, err
		}
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
	var ef *textFile
	includeNeeded := false
	if !samePath(entry, target) {
		if ef, err = readText(entry); err != nil {
			return nil, err
		}
		includeNeeded = !includesFile(ef.text, folder, filepath.Base(target))
	}
	for path, f := range map[string]*textFile{target: tf, entry: ef} {
		if f != nil && executesByDefault(f.text) {
			return nil, fail(codeHotstringX, "%s turns on #Hotstring X, which would run plain-text hotstrings as code. Remove that directive to add hotstrings here.", filepath.Base(path))
		}
	}

	id := newID()
	type change struct {
		path string
		file *textFile
		text string
	}
	changes := []change{{target, tf, appendEntry(tf.text, req.Line+" ; hsc:"+id)}}
	if includeNeeded {
		changes = append(changes, change{entry, ef, addInclude(ef.text, filepath.Base(target))})
	}
	restore := func() {
		for _, c := range changes {
			writeFile(c.path, c.file.original)
		}
	}
	for _, c := range changes {
		if err := writeFile(c.path+".bak", c.file.original); err != nil {
			restore()
			return nil, err
		}
		if err := writeFile(c.path, c.file.encode(c.text)); err != nil {
			restore()
			return nil, err
		}
	}
	if err := runner.Validate(exe, entry); err != nil {
		restore()
		return nil, err
	}
	if err := runner.Restart(exe, entry); err != nil {
		restore()
		return nil, err
	}
	return saveReply{
		OK:           true,
		ID:           id,
		File:         filepath.Base(target),
		Entry:        filepath.Base(entry),
		IncludeAdded: includeNeeded,
	}, nil
}

func newID() string {
	b := make([]byte, 6)
	rand.Read(b)
	for i := range b {
		b[i] = idAlphabet[int(b[i])%len(idAlphabet)]
	}
	return string(b)
}
