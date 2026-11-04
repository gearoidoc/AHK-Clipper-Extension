package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func codeOf(err error) string {
	var he *hostError
	if errors.As(err, &he) {
		return he.code
	}
	return ""
}

func TestAppendEntry(t *testing.T) {
	cases := []struct{ name, before, after string }{
		{"empty file gets the marker", "", marker + "\r\n:T:a::b\r\n"},
		{"existing text gets a blank line and the marker", "x\r\n", "x\r\n\r\n" + marker + "\r\n:T:a::b\r\n"},
		{"a missing final newline is added", "x", "x\r\n\r\n" + marker + "\r\n:T:a::b\r\n"},
		{"the marker is added only once", marker + "\r\n:T:c::d\r\n", marker + "\r\n:T:c::d\r\n:T:a::b\r\n"},
		{"an LF-only file still works", "x\n" + marker + "\n", "x\n" + marker + "\n:T:a::b\r\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := appendEntry(c.before, ":T:a::b"); got != c.after {
				t.Fatalf("got %q, want %q", got, c.after)
			}
		})
	}
}

func TestIncludesFile(t *testing.T) {
	folder := filepath.Join(t.TempDir(), "AHK")
	cases := map[string]bool{
		`#Include "General.ahk"`:                true,
		`#Include General.ahk`:                  true,
		`  #include 'general.ahk' ; category`:   runtime.GOOS == "windows",
		`#Include "*i General.ahk"`:             true,
		`#Include %A_ScriptDir%\General.ahk`:    true,
		`#Include "%A_ScriptDir%/General.ahk"`:  true,
		`#IncludeAgain General.ahk`:             true,
		`#Include "` + folder + `/General.ahk"`: true,
		`; #Include "General.ahk"`:              false,
		`#Include "Email.ahk"`:                  false,
		`#Include <General>`:                    false,
		``:                                      false,
	}
	for src, want := range cases {
		if got := includesFile("x\r\n"+src+"\r\ny", folder, "General.ahk"); got != want {
			t.Errorf("includesFile(%q) = %v, want %v", src, got, want)
		}
	}
}

func TestAddInclude(t *testing.T) {
	cases := []struct{ name, before, after string }{
		{"after the last #Include", "#Requires AutoHotkey v2.0\r\n#Include \"A.ahk\"\r\n; end\r\n", "#Requires AutoHotkey v2.0\r\n#Include \"A.ahk\"\r\n#Include \"B.ahk\"\r\n; end\r\n"},
		{"at the end without any #Include", "#Requires AutoHotkey v2.0\r\n", "#Requires AutoHotkey v2.0\r\n#Include \"B.ahk\"\r\n"},
		{"after a last line with no newline", "x", "x\r\n#Include \"B.ahk\"\r\n"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := addInclude(c.before, "B.ahk"); got != c.after {
				t.Fatalf("got %q, want %q", got, c.after)
			}
		})
	}
}

func TestReadTextEncodings(t *testing.T) {
	dir := t.TempDir()
	write := func(name string, data []byte) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, data, 0o644); err != nil {
			t.Fatal(err)
		}
		return path
	}
	plain, err := readText(write("plain.ahk", []byte("héllo")))
	if err != nil || plain.bom || plain.text != "héllo" {
		t.Fatalf("plain: %+v, %v", plain, err)
	}
	bom, err := readText(write("bom.ahk", append([]byte{0xEF, 0xBB, 0xBF}, "x"...)))
	if err != nil || !bom.bom || bom.text != "x" || string(bom.encode("y")) != "\xEF\xBB\xBFy" {
		t.Fatalf("BOM is not kept: %+v, %v", bom, err)
	}
	for name, data := range map[string][]byte{
		"utf16le.ahk": {0xFF, 0xFE, 'x', 0},
		"utf16be.ahk": {0xFE, 0xFF, 0, 'x'},
		"ansi.ahk":    {'c', 'a', 'f', 0xE9},
	} {
		if _, err := readText(write(name, data)); codeOf(err) != codeEncoding {
			t.Errorf("%s: expected %s, got %v", name, codeEncoding, err)
		}
	}
}

func TestWriteFileReplacesAtomically(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.ahk")
	os.WriteFile(path, []byte("old"), 0o640)
	if err := writeFile(path, []byte("new")); err != nil {
		t.Fatal(err)
	}
	if data, _ := os.ReadFile(path); string(data) != "new" {
		t.Fatalf("content %q", data)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o640 {
		t.Fatalf("mode %v not kept", info.Mode().Perm())
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("temporary files left behind: %v", entries)
	}
}

func TestCreateFileRefusesToOverwrite(t *testing.T) {
	path := filepath.Join(t.TempDir(), "a.ahk")
	os.WriteFile(path, []byte("mine"), 0o644)
	if err := createFile(path, []byte("x")); codeOf(err) != codeFileExists {
		t.Fatalf("expected %s, got %v", codeFileExists, err)
	}
	if data, _ := os.ReadFile(path); string(data) != "mine" {
		t.Fatal("existing file was changed")
	}
}

func TestLockFolder(t *testing.T) {
	dir := t.TempDir()
	unlock, err := lockFolder(dir)
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	if _, err := lockFolder(dir); codeOf(err) != codeLocked {
		t.Fatalf("second lock: expected %s, got %v", codeLocked, err)
	}
	if waited := time.Since(start); waited < lockTimeout {
		t.Fatalf("gave up after %v", waited)
	}
	unlock()
	unlock2, err := lockFolder(dir)
	if err != nil {
		t.Fatalf("lock after unlock: %v", err)
	}
	unlock2()

	// A lock file left by a crashed host isn't held by anyone, so it doesn't block.
	os.WriteFile(filepath.Join(dir, lockName), []byte("left over"), 0o600)
	start = time.Now()
	unlock3, err := lockFolder(dir)
	if err != nil || time.Since(start) > 200*time.Millisecond {
		t.Fatalf("leftover lock file blocked: %v after %v", err, time.Since(start))
	}
	unlock3()
}
