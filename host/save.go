package main

import (
	"crypto/rand"
	"os"
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
	// An existing hotstring to replace instead of appending. In the same file
	// it's swapped in place; in another file it moves to the end of File.
	Replace *replaceTarget `json:"replace"`
	// On a replace, keep the source comment above the old entry (editing an
	// entry keeps where it came from; replacing it with a new capture doesn't).
	KeepComment bool `json:"keepComment"`
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

	set := newEdits()
	t, err := set.open(target)
	if err != nil {
		return nil, err
	}
	if err := checkExecuteDefault(target, t.file); err != nil {
		return nil, err
	}
	id := newID()
	entryLines := []string{req.Line + " ; hsc:" + id}
	withComment := func(comment string) []string {
		if req.Comment != "" {
			comment = req.Comment
		}
		if comment == "" {
			return entryLines
		}
		return append([]string{comment}, entryLines...)
	}

	moveSource := ""
	if req.Replace == nil {
		t.text = appendEntry(t.text, withComment("")...)
	} else {
		source, err := resolveFile(folder, req.Replace.File, true)
		if err != nil {
			return nil, err
		}
		s, err := set.open(source)
		if err != nil {
			return nil, err
		}
		cut, err := cutEntry(s.text, req.Replace)
		if err != nil {
			return nil, err
		}
		if samePath(source, target) {
			t.text = cut.insert(withComment(cut.keptComment(req.KeepComment)))
		} else {
			// A move: out of the old file, onto the end of the new one.
			s.text = cut.insert(nil)
			t.text = appendEntry(t.text, withComment(cut.keptComment(req.KeepComment))...)
			moveSource = source
		}
	}
	// After cutEntry, so a stale replace reads as "changed", not "duplicate".
	if err := checkNoDuplicate(folder, newHotstring, req.Replace); err != nil {
		return nil, err
	}

	includeAdded := false
	if !samePath(entry, target) {
		e, err := set.open(entry)
		if err != nil {
			return nil, err
		}
		if err := checkExecuteDefault(entry, e.file); err != nil {
			return nil, err
		}
		if !includesFile(e.text, folder, filepath.Base(target)) {
			e.text = addInclude(e.text, filepath.Base(target))
			includeAdded = true
		}
	}
	entries := []string{entry}
	if req.Reload == "" && moveSource != "" {
		// Each file runs as its own script, so the one the hotstring left
		// needs restarting too, or its old copy keeps firing.
		entries = append(entries, moveSource)
	}
	if err := commit(exe, entries, set.changes()); err != nil {
		return nil, err
	}
	return saveReply{
		OK:           true,
		ID:           id,
		File:         filepath.Base(target),
		Entry:        filepath.Base(entry),
		IncludeAdded: includeAdded,
		Replaced:     req.Replace != nil,
		Undo:         undoToken{File: filepath.Base(target), ID: id, Sha256: fileHash(t.file.encode(t.text))},
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

// cutResult is a file's lines with one entry taken out.
type cutResult struct {
	lines   []string
	at      int
	comment string
	eol     string
}

// cutEntry takes out the hotstring at r.Line and a source comment directly
// above it, after checking the line is still the one scan reported.
func cutEntry(text string, r *replaceTarget) (cutResult, error) {
	lines := strings.Split(text, "\n")
	i := r.Line - 1
	if i < 0 || i >= len(lines) || lineHash(strings.TrimSuffix(lines[i], "\r")) != r.Hash {
		return cutResult{}, fail(codeFileChanged, "%s changed since the hotstrings were listed. Refresh and try again.", r.File)
	}
	if h, ok := parseHotstringLine(strings.TrimSuffix(lines[i], "\r")); ok && h.Multiline {
		return cutResult{}, fail(codeCodeBlock, "The code of %s continues on the lines below it, so change or delete it by hand in %s.", h.Trigger, r.File)
	}
	cut := cutResult{at: i}
	if strings.HasSuffix(lines[i], "\r") {
		cut.eol = "\r"
	}
	if i > 0 && strings.HasPrefix(strings.TrimSpace(lines[i-1]), commentPrefix) {
		cut.at = i - 1
		cut.comment = strings.TrimSpace(lines[i-1])
	}
	cut.lines = append(append([]string{}, lines[:cut.at]...), lines[i+1:]...)
	return cut, nil
}

// keptComment is the old source comment if it should stay, else "".
func (c cutResult) keptComment(keep bool) string {
	if keep {
		return c.comment
	}
	return ""
}

// insert puts entry lines where the old entry was and joins the file again.
func (c cutResult) insert(entryLines []string) string {
	added := make([]string, len(entryLines))
	for j, l := range entryLines {
		added[j] = l + c.eol
	}
	lines := append(append(append([]string{}, c.lines[:c.at]...), added...), c.lines[c.at:]...)
	return strings.Join(lines, "\n")
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

// edits collects the new text of every file one request changes, so two
// changes to the same file build on each other. A move out of the main
// script that also adds an #Include to it is the case that needs this.
type edits struct {
	order []string
	files map[string]*edit
}

type edit struct {
	file *textFile
	text string
}

func newEdits() *edits {
	return &edits{files: map[string]*edit{}}
}

// open returns the file's pending edit, reading it the first time.
func (e *edits) open(path string) (*edit, error) {
	if ed, ok := e.files[path]; ok {
		return ed, nil
	}
	f, err := readText(path)
	if err != nil {
		return nil, err
	}
	e.files[path] = &edit{file: f, text: f.text}
	e.order = append(e.order, path)
	return e.files[path], nil
}

// changes lists the files whose text actually changed, in the order opened.
func (e *edits) changes() []change {
	var out []change
	for _, path := range e.order {
		if ed := e.files[path]; ed.text != ed.file.text {
			out = append(out, change{path, ed.file, ed.file.encode(ed.text)})
		}
	}
	return out
}

// commit writes the changes and makes them live. It either succeeds
// completely or leaves every file, and every .bak, as it was: each file's
// .bak is refreshed and the file replaced atomically, every entry script is
// validated with AutoHotkey, and only then restarted. Any failure restores
// the original bytes. The entries are the main script, or, when each file
// runs on its own, every script the request changed.
func commit(exe string, entries []string, changes []change) error {
	type backup struct {
		path    string
		data    []byte
		existed bool
	}
	var backups []backup
	restore := func() {
		for _, c := range changes {
			writeFile(c.path, c.file.original)
		}
		// A failed commit mustn't leave a .bak that Undo would mistake for
		// the state before an earlier save.
		for _, b := range backups {
			if b.existed {
				writeFile(b.path, b.data)
			} else {
				os.Remove(b.path)
			}
		}
	}
	for _, c := range changes {
		bak := c.path + ".bak"
		old, err := os.ReadFile(bak)
		backups = append(backups, backup{bak, old, err == nil})
		if err := writeFile(bak, c.file.original); err != nil {
			restore()
			return err
		}
		if err := writeFile(c.path, c.data); err != nil {
			restore()
			return err
		}
	}
	for _, entry := range entries {
		if err := runner.Validate(exe, entry); err != nil {
			restore()
			return err
		}
	}
	for _, entry := range entries {
		if err := runner.Restart(exe, entry); err != nil {
			restore()
			return err
		}
	}
	return nil
}
