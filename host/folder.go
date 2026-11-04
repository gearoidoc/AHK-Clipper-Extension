package main

import (
	"encoding/json/v2"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"unicode/utf8"
)

const (
	maxListedFiles = 1000
	// A scan reply's hotstrings stop at this many bytes of JSON and the reply
	// says where to go on, leaving room for the file lists under Chrome's
	// 1 MB limit for replies.
	scanPageBytes = 700_000
	// One entry's text is cut short past this, so a single huge hand-written
	// line can't make every scan fail.
	maxEntryText = 50_000
)

type listFilesRequest struct {
	Type   string `json:"type"`
	Folder string `json:"folder"`
}

type listFilesReply struct {
	OK     bool     `json:"ok"`
	Folder string   `json:"folder"`
	Files  []string `json:"files"`
}

// handleListFiles lists the .ahk files directly inside the folder, sorted
// case-insensitively.
func handleListFiles(raw []byte) (any, error) {
	var req listFilesRequest
	if err := decodeStrict(raw, &req); err != nil {
		return nil, err
	}
	folder, err := resolveFolder(req.Folder)
	if err != nil {
		return nil, err
	}
	files, err := ahkFiles(folder)
	if err != nil {
		return nil, err
	}
	return listFilesReply{OK: true, Folder: folder, Files: files}, nil
}

// ahkFiles lists the .ahk files directly inside folder, sorted
// case-insensitively.
func ahkFiles(folder string) ([]string, error) {
	entries, err := os.ReadDir(folder)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, e := range entries {
		name := e.Name()
		if !e.Type().IsRegular() || strings.HasPrefix(name, ".") || !strings.EqualFold(filepath.Ext(name), ".ahk") {
			continue
		}
		files = append(files, name)
	}
	slices.SortFunc(files, func(a, b string) int { return strings.Compare(strings.ToLower(a), strings.ToLower(b)) })
	if len(files) > maxListedFiles {
		files = files[:maxListedFiles]
	}
	return files, nil
}

type scanRequest struct {
	Type   string `json:"type"`
	Folder string `json:"folder"`
	// Index of the first hotstring to return: 0, or a previous reply's next.
	Start int `json:"start"`
}

type scanEntry struct {
	File          string `json:"file"`
	Line          int    `json:"line"`
	Trigger       string `json:"trigger"`
	CaseSensitive bool   `json:"caseSensitive"`
	Instant       bool   `json:"instant"`
	Options       string `json:"options"`
	// "text", or "code" for a hotstring that runs code (Text is then the code).
	Kind     string `json:"kind"`
	Text     string `json:"text"`
	Editable bool   `json:"editable"`
	// Its code continues on the lines below, so it can't be deleted here.
	Multiline bool   `json:"multiline"`
	ID        string `json:"id"`
	Hash      string `json:"hash"`
}

type scanReply struct {
	OK         bool        `json:"ok"`
	Folder     string      `json:"folder"`
	Files      []string    `json:"files"`
	Hotstrings []scanEntry `json:"hotstrings"`
	// Files that couldn't be read as UTF-8 and so weren't scanned.
	Skipped []string `json:"skipped"`
	// The start of the next page, or 0 when this reply holds the rest.
	Next int `json:"next"`
}

// handleScan lists the folder's files and every hotstring in them, for the
// dialog's duplicate check and the hotstring list. Long collections come in
// pages: each reply ends near scanPageBytes and gives the next start.
func handleScan(raw []byte) (any, error) {
	var req scanRequest
	if err := decodeStrict(raw, &req); err != nil {
		return nil, err
	}
	folder, err := resolveFolder(req.Folder)
	if err != nil {
		return nil, err
	}
	files, err := ahkFiles(folder)
	if err != nil {
		return nil, err
	}
	if req.Start < 0 {
		return nil, fail(codeBadRequest, "start can't be negative")
	}
	reply := scanReply{OK: true, Folder: folder, Files: files, Hotstrings: []scanEntry{}, Skipped: []string{}}
	index, size := 0, 0
	for _, name := range files {
		f, err := readText(filepath.Join(folder, name))
		if err != nil {
			reply.Skipped = append(reply.Skipped, name)
			continue
		}
		for _, h := range parseHotstrings(f.text) {
			if index++; index <= req.Start {
				continue
			}
			kind := "text"
			if h.Code {
				kind = "code"
			}
			e := scanEntry{
				File: name, Line: h.Line, Trigger: h.Trigger, CaseSensitive: h.CaseSensitive, Instant: h.Instant,
				Options: h.Options, Kind: kind, Text: h.Text, Editable: h.Editable, Multiline: h.Multiline, ID: h.ID, Hash: h.Hash,
			}
			if len(e.Text) > maxEntryText {
				e.Text = truncateUTF8(e.Text, maxEntryText) + "\u2026"
				e.Editable = false
			}
			// Measured as JSON, since escaping can double the size of text.
			encoded, err := json.Marshal(e)
			if err != nil {
				return nil, err
			}
			if size > 0 && size+len(encoded) > scanPageBytes {
				reply.Next = index - 1
				return reply, nil
			}
			size += len(encoded)
			reply.Hotstrings = append(reply.Hotstrings, e)
		}
	}
	return reply, nil
}

type createFileRequest struct {
	Type   string `json:"type"`
	Folder string `json:"folder"`
	Name   string `json:"name"`
	// "main" for the script that #Includes the categories, "category" for one of them.
	Kind string `json:"kind"`
	// The main script to add an #Include for the new file to, or "".
	IncludeIn string `json:"includeIn"`
}

type createFileReply struct {
	OK           bool   `json:"ok"`
	File         string `json:"file"`
	IncludeAdded bool   `json:"includeAdded"`
}

func handleCreateFile(raw []byte) (any, error) {
	var req createFileRequest
	if err := decodeStrict(raw, &req); err != nil {
		return nil, err
	}
	folder, err := resolveFolder(req.Folder)
	if err != nil {
		return nil, err
	}
	path, err := resolveFile(folder, req.Name, false)
	if err != nil {
		return nil, err
	}
	var content string
	switch req.Kind {
	case "main":
		content = mainTemplate()
	case "category":
		content = categoryTemplate(strings.TrimSuffix(req.Name, filepath.Ext(req.Name)))
	default:
		return nil, fail(codeBadRequest, `kind must be "main" or "category"`)
	}

	unlock, err := lockFolder(folder)
	if err != nil {
		return nil, err
	}
	defer unlock()

	var mainPath string
	var main *textFile
	if req.IncludeIn != "" {
		if mainPath, err = resolveFile(folder, req.IncludeIn, true); err != nil {
			return nil, err
		}
		if main, err = readText(mainPath); err != nil {
			return nil, err
		}
	}
	if err := createFile(path, []byte(content)); err != nil {
		return nil, err
	}
	reply := createFileReply{OK: true, File: filepath.Base(path)}
	if main != nil && !includesFile(main.text, folder, reply.File) {
		if err := writeFile(mainPath+".bak", main.original); err != nil {
			return nil, err
		}
		if err := writeFile(mainPath, main.encode(addInclude(main.text, reply.File))); err != nil {
			return nil, err
		}
		reply.IncludeAdded = true
	}
	return reply, nil
}

func mainTemplate() string {
	return strings.Join([]string{
		"#Requires AutoHotkey v2.0",
		"#SingleInstance Force",
		"",
		"; Run this script to load every hotstring category below.",
		"; Each category is its own .ahk file in this folder. To turn one off,",
		"; put a semicolon at the start of its #Include line.",
		"; AHK Hotstring Clipper adds an #Include here for each new category.",
		"",
	}, crlf)
}

func categoryTemplate(title string) string {
	return strings.Join([]string{
		"#Requires AutoHotkey v2.0",
		"",
		"; " + title + " hotstrings.",
		"; AHK Hotstring Clipper adds new entries at the end; editing them by hand is fine.",
		"",
		marker,
		"",
	}, crlf)
}

// truncateUTF8 cuts s to at most n bytes without splitting a character.
func truncateUTF8(s string, n int) string {
	for n > 0 && n < len(s) && !utf8.RuneStart(s[n]) {
		n--
	}
	return s[:n]
}
