package main

import (
	"bytes"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	marker   = "; --- Added by Hotstring Clipper ---"
	crlf     = "\r\n"
	lockName = ".hotstring-clipper.lock"
	// A host that crashed mid-save leaves its lock behind; saves take well under this.
	staleLock   = 30 * time.Second
	lockTimeout = 2 * time.Second
)

var (
	utf8BOM          = []byte{0xEF, 0xBB, 0xBF}
	includeDirective = regexp.MustCompile(`(?im)^[ \t]*#Include(?:Again)?[ \t]+([^\r\n]*)`)
	scriptDirVar     = regexp.MustCompile(`(?i)%A_ScriptDir%`)
)

// textFile is a script read as UTF-8, remembering its exact bytes for
// rollback and whether it started with a byte order mark.
type textFile struct {
	original []byte
	bom      bool
	text     string
}

func readText(path string) (*textFile, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	f := &textFile{original: data}
	name := filepath.Base(path)
	switch {
	case bytes.HasPrefix(data, utf8BOM):
		f.bom = true
		data = data[len(utf8BOM):]
	case bytes.HasPrefix(data, []byte{0xFF, 0xFE}), bytes.HasPrefix(data, []byte{0xFE, 0xFF}):
		return nil, fail(codeEncoding, "%s is saved as UTF-16. Save it as UTF-8 to add hotstrings to it.", name)
	}
	if !utf8.Valid(data) {
		return nil, fail(codeEncoding, "%s isn't valid UTF-8 (it may be saved as ANSI). Save it as UTF-8 to add hotstrings to it.", name)
	}
	f.text = string(data)
	return f, nil
}

func (f *textFile) encode(text string) []byte {
	if f.bom {
		return append(append([]byte{}, utf8BOM...), text...)
	}
	return []byte(text)
}

// writeFile replaces path atomically: it writes a temporary file in the same
// folder, flushes it and renames it over the original, so a crash can never
// leave a half-written script.
func writeFile(path string, data []byte) error {
	mode := fs.FileMode(0o644)
	if info, err := os.Stat(path); err == nil {
		mode = info.Mode().Perm()
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // Fails harmlessly once the rename has succeeded.
	_, err = tmp.Write(data)
	if err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(tmp.Name(), mode)
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return fail(codeFileBusy, "Couldn't replace %s. If it's open in another program, close it and try again. (%v)", filepath.Base(path), err)
	}
	return nil
}

// createFile writes a new file, failing if one already exists.
func createFile(path string, data []byte) error {
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if errors.Is(err, fs.ErrExist) {
		return fail(codeFileExists, "%s already exists.", filepath.Base(path))
	} else if err != nil {
		return err
	}
	_, err = f.Write(data)
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		os.Remove(path)
	}
	return err
}

// lockFolder serialises writes to one folder across host processes: Chrome
// starts a separate host for every message.
func lockFolder(folder string) (unlock func(), err error) {
	path := filepath.Join(folder, lockName)
	deadline := time.Now().Add(lockTimeout)
	for {
		f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
		if err == nil {
			f.Close()
			return func() { os.Remove(path) }, nil
		}
		if !errors.Is(err, fs.ErrExist) {
			return nil, err
		}
		if info, statErr := os.Stat(path); statErr == nil && time.Since(info.ModTime()) > staleLock {
			os.Remove(path)
			continue
		}
		if time.Now().After(deadline) {
			return nil, fail(codeLocked, "Another save to this folder is still running. Try again in a moment.")
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// appendEntry adds lines at the end of a script, under the marker, using CRLF.
func appendEntry(text string, lines ...string) string {
	var b strings.Builder
	b.WriteString(text)
	if text != "" && !strings.HasSuffix(text, "\n") {
		b.WriteString(crlf)
	}
	if !hasLine(text, marker) {
		if text != "" {
			b.WriteString(crlf)
		}
		b.WriteString(marker + crlf)
	}
	for _, line := range lines {
		b.WriteString(line + crlf)
	}
	return b.String()
}

func hasLine(text, want string) bool {
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == want {
			return true
		}
	}
	return false
}

// includesFile reports whether the script src, which lives in folder, has an
// #Include for name. It understands the usual forms: a plain or quoted name,
// optionally with *i and a %A_ScriptDir% prefix. Missing a rarer form only
// means a redundant #Include gets added, which AutoHotkey ignores because it
// includes each file once.
func includesFile(src, folder, name string) bool {
	want := filepath.Join(folder, name)
	for _, m := range includeDirective.FindAllStringSubmatch(src, -1) {
		arg := strings.Trim(stripComment(m[1]), `"'`)
		if len(arg) > 3 && strings.EqualFold(arg[:3], "*i ") {
			arg = strings.TrimSpace(arg[3:])
		}
		arg = scriptDirVar.ReplaceAllLiteralString(arg, folder)
		arg = filepath.FromSlash(strings.ReplaceAll(arg, `\`, "/"))
		if !filepath.IsAbs(arg) {
			arg = filepath.Join(folder, arg)
		}
		if samePath(arg, want) {
			return true
		}
	}
	return false
}

// addInclude adds `#Include "name"` after the last #Include line, or at the
// end of the script if it has none.
func addInclude(text, name string) string {
	directive := `#Include "` + name + `"`
	matches := includeDirective.FindAllStringIndex(text, -1)
	if len(matches) == 0 {
		if text != "" && !strings.HasSuffix(text, "\n") {
			text += crlf
		}
		return text + directive + crlf
	}
	end := matches[len(matches)-1][1]
	return text[:end] + crlf + directive + text[end:]
}
