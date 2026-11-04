package main

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const maxListedFiles = 1000

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
	return listFilesReply{OK: true, Folder: folder, Files: files}, nil
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
