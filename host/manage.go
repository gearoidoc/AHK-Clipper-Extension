package main

import (
	"fmt"
	"path/filepath"
)

const maxImportEntries = 5000

type deleteRequest struct {
	Type    string `json:"type"`
	Folder  string `json:"folder"`
	AhkPath string `json:"ahkPath"`
	Reload  string `json:"reload"`
	File    string `json:"file"`
	Line    int    `json:"line"`
	Hash    string `json:"hash"`
}

type deleteReply struct {
	OK   bool   `json:"ok"`
	File string `json:"file"`
}

// handleDelete removes one hotstring, as scan reported it, and a source
// comment directly above it, then validates and restarts like a save.
func handleDelete(raw []byte) (any, error) {
	var req deleteRequest
	if err := decodeStrict(raw, &req); err != nil {
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
	cut, err := cutEntry(tf.text, &replaceTarget{File: req.File, Line: req.Line, Hash: req.Hash})
	if err != nil {
		return nil, err
	}
	if err := commit(exe, []string{entry}, []change{{target, tf, tf.encode(cut.insert(nil))}}); err != nil {
		return nil, err
	}
	return deleteReply{OK: true, File: filepath.Base(target)}, nil
}

type importEntry struct {
	File string `json:"file"`
	Line string `json:"line"`
}

type importRequest struct {
	Type    string        `json:"type"`
	Folder  string        `json:"folder"`
	AhkPath string        `json:"ahkPath"`
	Reload  string        `json:"reload"`
	Entries []importEntry `json:"entries"`
}

type importSkip struct {
	// Index into the request's entries.
	Index  int    `json:"index"`
	Reason string `json:"reason"`
}

type importReply struct {
	OK      bool         `json:"ok"`
	Added   int          `json:"added"`
	Skipped []importSkip `json:"skipped"`
}

// handleImport adds many hotstrings in one transaction: a trigger already in
// the folder, or earlier in the same import, is skipped and reported; the
// rest are appended under each file's marker, with one validation and one
// restart for the lot. Every file the entries name must already exist.
func handleImport(raw []byte) (any, error) {
	var req importRequest
	if err := decodeStrict(raw, &req); err != nil {
		return nil, err
	}
	if len(req.Entries) == 0 || len(req.Entries) > maxImportEntries {
		return nil, fail(codeBadRequest, "an import needs 1 to %d hotstrings", maxImportEntries)
	}
	parsed := make([]parsedHotstring, len(req.Entries))
	for i, e := range req.Entries {
		if err := checkHotstringLine(e.Line); err != nil {
			return nil, fail(codeBadLine, "Entry %d isn't a hotstring line this extension writes.", i+1)
		}
		parsed[i], _ = parseHotstringLine(e.Line)
	}
	folder, err := resolveFolder(req.Folder)
	if err != nil {
		return nil, err
	}
	exe, err := resolveAutoHotkey(req.AhkPath)
	if err != nil {
		return nil, err
	}
	targets := map[string]string{}
	for _, e := range req.Entries {
		if _, done := targets[e.File]; !done {
			if targets[e.File], err = resolveFile(folder, e.File, true); err != nil {
				return nil, err
			}
		}
	}
	entry := ""
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

	type known struct {
		trigger, where string
		caseSensitive  bool
	}
	var existing []known
	files, err := ahkFiles(folder)
	if err != nil {
		return nil, err
	}
	for _, name := range files {
		if f, err := readText(filepath.Join(folder, name)); err == nil {
			for _, h := range parseHotstrings(f.text) {
				existing = append(existing, known{h.Trigger, name, h.CaseSensitive})
			}
		}
	}

	set := newEdits()
	open := func(path string) (*edit, error) {
		ed, err := set.open(path)
		if err != nil {
			return nil, err
		}
		return ed, checkExecuteDefault(path, ed.file)
	}

	reply := importReply{OK: true, Skipped: []importSkip{}}
	accepted := map[string][]string{}
	var order []string
	for i, h := range parsed {
		reason := ""
		for _, k := range existing {
			if sameTrigger(k.trigger, k.caseSensitive, h.Trigger, h.CaseSensitive) {
				reason = fmt.Sprintf("%s is already in %s", h.Trigger, k.where)
				break
			}
		}
		if reason != "" {
			reply.Skipped = append(reply.Skipped, importSkip{i, reason})
			continue
		}
		file := req.Entries[i].File
		existing = append(existing, known{h.Trigger, fmt.Sprintf("this import (entry %d)", i+1), h.CaseSensitive})
		if _, seen := accepted[file]; !seen {
			order = append(order, file)
		}
		accepted[file] = append(accepted[file], req.Entries[i].Line+" ; hsc:"+newID())
		reply.Added++
	}
	if reply.Added == 0 {
		return reply, nil
	}

	for _, file := range order {
		w, err := open(targets[file])
		if err != nil {
			return nil, err
		}
		w.text = appendEntry(w.text, accepted[file]...)
	}
	var entries []string
	if entry == "" {
		// Without a main script each file runs on its own, so every file
		// the import adds to is validated and restarted.
		for _, file := range order {
			entries = append(entries, targets[file])
		}
	} else {
		entries = []string{entry}
		ew, err := open(entry)
		if err != nil {
			return nil, err
		}
		for _, file := range order {
			if target := targets[file]; !samePath(target, entry) && !includesFile(ew.text, folder, filepath.Base(target)) {
				ew.text = addInclude(ew.text, filepath.Base(target))
			}
		}
	}
	if err := commit(exe, entries, set.changes()); err != nil {
		return nil, err
	}
	return reply, nil
}
