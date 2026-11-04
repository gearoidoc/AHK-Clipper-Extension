package main

import (
	"crypto/rand"
	"path/filepath"
	"strings"
)

// Entry ids avoid letters and digits that are easy to confuse.
const idAlphabet = "abcdefghjkmnpqrstuvwxyz23456789"

const commentPrefix = "; from "

type saveRequest struct {
	Type    string `json:"type"`
	Folder  string `json:"folder"`
	AhkPath string `json:"ahkPath"`
	File    string `json:"file"`
	Line    string `json:"line"`
	// A source comment line to write above the hotstring, or "".
	Comment string `json:"comment"`
	// The script to restart: a main script that #Includes File, or "" to
	// restart File itself.
	Reload string `json:"reload"`
	// An existing hotstring to replace in place instead of appending.
	Replace *replaceTarget `json:"replace"`
}

// replaceTarget names a hotstring as scan reported it. Hash guards against
// the file having changed since.
type replaceTarget struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Hash string `json:"hash"`
}

// undoToken lets the extension undo exactly this save.
type undoToken struct {
	File   string `json:"file"`
	ID     string `json:"id"`
	Sha256 string `json:"sha256"`
}

type saveReply struct {
	OK   bool   `json:"ok"`
	ID   string `json:"id"`
	File string `json:"file"`
	// The script that was validated and restarted.
	Entry        string    `json:"entry"`
	IncludeAdded bool      `json:"includeAdded"`
	Replaced     bool      `json:"replaced"`
	Undo         undoToken `json:"undo"`
}

// handleSave writes one hotstring and makes it live: appended under the
// marker, or replacing an existing one in place. Under the folder lock it
// refuses a trigger that already exists anywhere in the folder, then hands
// the new file contents to commit.
func handleSave(raw []byte) (any, error) {
	var req saveRequest
	if err := decodeStrict(raw, &req); err != nil {
		return nil, err
	}
	if err := checkHotstringLine(req.Line); err != nil {
		return nil, err
	}
	if err := checkComment(req.Comment); err != nil {
		return nil, err
	}
	newHotstring, _ := parseHotstringLine(req.Line)
	if req.Replace != nil && req.Replace.File != req.File {
		return nil, fail(codeBadRequest, "a replacement must be saved to the file it replaces")
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
	if err := checkExecuteDefault(target, tf); err != nil {
		return nil, err
	}
	id := newID()
	entryLines := []string{req.Line + " ; hsc:" + id}
	if req.Comment != "" {
		entryLines = append([]string{req.Comment}, entryLines...)
	}
	var text string
	if req.Replace != nil {
		if text, err = replaceEntry(tf.text, req.Replace, entryLines); err != nil {
			return nil, err
		}
	} else {
		text = appendEntry(tf.text, entryLines...)
	}
	// After replaceEntry, so a stale replace reads as "changed", not "duplicate".
	if err := checkNoDuplicate(folder, newHotstring, req.Replace); err != nil {
		return nil, err
	}
	changes := []change{{target, tf, tf.encode(text)}}

	includeAdded := false
	if !samePath(entry, target) {
		ef, err := readText(entry)
		if err != nil {
			return nil, err
		}
		if err := checkExecuteDefault(entry, ef); err != nil {
			return nil, err
		}
		if !includesFile(ef.text, folder, filepath.Base(target)) {
			changes = append(changes, change{entry, ef, ef.encode(addInclude(ef.text, filepath.Base(target)))})
			includeAdded = true
		}
	}
	if err := commit(exe, entry, changes); err != nil {
		return nil, err
	}
	return saveReply{
		OK:           true,
		ID:           id,
		File:         filepath.Base(target),
		Entry:        filepath.Base(entry),
		IncludeAdded: includeAdded,
		Replaced:     req.Replace != nil,
		Undo:         undoToken{File: filepath.Base(target), ID: id, Sha256: fileHash(changes[0].data)},
	}, nil
}

// checkExecuteDefault refuses a script whose #Hotstring directives turn on X:
// plain-text hotstrings below them would run as code.
func checkExecuteDefault(path string, f *textFile) error {
	if executesByDefault(f.text) {
		return fail(codeHotstringX, "%s turns on #Hotstring X, which would run plain-text hotstrings as code. Remove that directive to add hotstrings here.", filepath.Base(path))
	}
	return nil
}

// resolveEntry returns the script to validate and restart.
func resolveEntry(folder, target, reload string) (string, error) {
	if reload == "" {
		return target, nil
	}
	return resolveFile(folder, reload, true)
}

// checkNoDuplicate refuses a trigger that any .ahk file in the folder already
// has, other than the hotstring being replaced. Unreadable files are skipped.
func checkNoDuplicate(folder string, h parsedHotstring, replacing *replaceTarget) error {
	files, err := ahkFiles(folder)
	if err != nil {
		return err
	}
	for _, name := range files {
		f, err := readText(filepath.Join(folder, name))
		if err != nil {
			continue
		}
		for _, existing := range parseHotstrings(f.text) {
			if replacing != nil && name == replacing.File && existing.Line == replacing.Line {
				continue
			}
			if sameTrigger(existing.Trigger, existing.CaseSensitive, h.Trigger, h.CaseSensitive) {
				return fail(codeDuplicate, "%s is already in %s (line %d). Replace it or choose another trigger.", existing.Trigger, name, existing.Line)
			}
		}
	}
	return nil
}

// replaceEntry swaps the hotstring at r.Line, and a source comment directly
// above it, for the new entry lines.
func replaceEntry(text string, r *replaceTarget, entryLines []string) (string, error) {
	lines := strings.Split(text, "\n")
	i := r.Line - 1
	if i < 0 || i >= len(lines) || lineHash(strings.TrimSuffix(lines[i], "\r")) != r.Hash {
		return "", fail(codeFileChanged, "%s changed since the dialog opened. Close it and try again.", r.File)
	}
	first := i
	if i > 0 && strings.HasPrefix(strings.TrimSpace(lines[i-1]), commentPrefix) {
		first = i - 1
	}
	eol := ""
	if strings.HasSuffix(lines[i], "\r") {
		eol = "\r"
	}
	replacement := make([]string, len(entryLines))
	for j, l := range entryLines {
		replacement[j] = l + eol
	}
	lines = append(lines[:first], append(replacement, lines[i+1:]...)...)
	return strings.Join(lines, "\n"), nil
}

func newID() string {
	b := make([]byte, 6)
	rand.Read(b)
	for i := range b {
		b[i] = idAlphabet[int(b[i])%len(idAlphabet)]
	}
	return string(b)
}

// change is one file's new contents within a commit.
type change struct {
	path string
	file *textFile
	data []byte
}

// commit writes the changes and makes them live. It either succeeds
// completely or leaves every file as it was: each file's .bak is refreshed
// and the file replaced atomically, the entry script is validated with
// AutoHotkey, and only then restarted. Any failure restores the original
// bytes.
func commit(exe, entry string, changes []change) error {
	restore := func() {
		for _, c := range changes {
			writeFile(c.path, c.file.original)
		}
	}
	for _, c := range changes {
		if err := writeFile(c.path+".bak", c.file.original); err != nil {
			restore()
			return err
		}
		if err := writeFile(c.path, c.data); err != nil {
			restore()
			return err
		}
	}
	if err := runner.Validate(exe, entry); err != nil {
		restore()
		return err
	}
	if err := runner.Restart(exe, entry); err != nil {
		restore()
		return err
	}
	return nil
}
