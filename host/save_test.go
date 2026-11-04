package main

import (
	"bytes"
	"encoding/json/v2"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// fakeRunner records AutoHotkey calls and fails the ones it's told to.
type fakeRunner struct {
	calls                     []string
	failValidate, failRestart bool
	filesSeenDuringValidation map[string]string
}

func (f *fakeRunner) Validate(exe, script string) error {
	f.calls = append(f.calls, "validate "+filepath.Base(script))
	f.filesSeenDuringValidation = readAll(filepath.Dir(script))
	if f.failValidate {
		return fail(codeAhkInvalid, "General.ahk (3) : ==> fake error")
	}
	return nil
}

func (f *fakeRunner) Restart(exe, script string) error {
	f.calls = append(f.calls, "restart "+filepath.Base(script))
	if f.failRestart {
		return fail(codeReloadFailed, "fake restart failure")
	}
	return nil
}

func readAll(dir string) map[string]string {
	files := map[string]string{}
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		data, _ := os.ReadFile(filepath.Join(dir, e.Name()))
		files[e.Name()] = string(data)
	}
	return files
}

type saveSetup struct {
	folder string
	exe    string
	fake   *fakeRunner
}

func newSaveSetup(t *testing.T) *saveSetup {
	t.Helper()
	dir := mustEval(t, t.TempDir())
	folder := filepath.Join(dir, "Hotstrings")
	os.Mkdir(folder, 0o755)
	exe := filepath.Join(dir, "AutoHotkey64.exe")
	os.WriteFile(exe, nil, 0o755)
	fake := &fakeRunner{}
	old := runner
	runner = fake
	t.Cleanup(func() { runner = old })
	return &saveSetup{folder: folder, exe: exe, fake: fake}
}

func (s *saveSetup) request(t *testing.T, msg map[string]any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(msg)
	if err != nil {
		t.Fatal(err)
	}
	var buf bytes.Buffer
	if err := writeMessage(&buf, handle(raw)); err != nil {
		t.Fatal(err)
	}
	return replies(t, buf.Bytes())[0]
}

func (s *saveSetup) create(t *testing.T, name, kind, includeIn string) map[string]any {
	return s.request(t, map[string]any{"type": "createFile", "folder": s.folder, "name": name, "kind": kind, "includeIn": includeIn})
}

func (s *saveSetup) save(t *testing.T, file, line, reload string) map[string]any {
	return s.request(t, map[string]any{"type": "save", "folder": s.folder, "ahkPath": s.exe, "file": file, "line": line, "reload": reload})
}

func (s *saveSetup) read(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(s.folder, name))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

func TestSetUpFolderCreatesMainAndCategory(t *testing.T) {
	s := newSaveSetup(t)
	if r := s.create(t, "Main.ahk", "main", ""); r["ok"] != true {
		t.Fatalf("main: %v", r)
	}
	r := s.create(t, "General.ahk", "category", "Main.ahk")
	if r["ok"] != true || r["includeAdded"] != true {
		t.Fatalf("category: %v", r)
	}
	main := s.read(t, "Main.ahk")
	if !strings.HasPrefix(main, "#Requires AutoHotkey v2.0\r\n#SingleInstance Force\r\n") || !strings.HasSuffix(main, "\r\n#Include \"General.ahk\"\r\n") {
		t.Fatalf("Main.ahk:\n%s", main)
	}
	if general := s.read(t, "General.ahk"); !strings.Contains(general, "; General hotstrings.") || !strings.Contains(general, marker) {
		t.Fatalf("General.ahk:\n%s", general)
	}
	if r := s.create(t, "General.ahk", "category", ""); errorCode(r) != codeFileExists {
		t.Fatalf("second create: %v", r)
	}
	if r := s.create(t, "x.ahk", "script", ""); errorCode(r) != codeBadRequest {
		t.Fatalf("bad kind: %v", r)
	}

	list := s.request(t, map[string]any{"type": "listFiles", "folder": s.folder})
	files, _ := list["files"].([]any)
	if len(files) != 2 || files[0] != "General.ahk" || files[1] != "Main.ahk" {
		t.Fatalf("listFiles: %v", list)
	}
}

func TestSaveAppendsValidatesAndRestarts(t *testing.T) {
	s := newSaveSetup(t)
	s.create(t, "Main.ahk", "main", "")
	s.create(t, "General.ahk", "category", "Main.ahk")

	r := s.save(t, "General.ahk", ":T:;brb::be right back", "Main.ahk")
	if r["ok"] != true || r["file"] != "General.ahk" || r["entry"] != "Main.ahk" || r["includeAdded"] != false {
		t.Fatalf("save: %v", r)
	}
	id, _ := r["id"].(string)
	if !regexp.MustCompile(`^[a-z2-9]{6}$`).MatchString(id) {
		t.Fatalf("id %q", id)
	}
	if !strings.HasSuffix(s.read(t, "General.ahk"), marker+"\r\n:T:;brb::be right back ; hsc:"+id+"\r\n") {
		t.Fatalf("General.ahk:\n%q", s.read(t, "General.ahk"))
	}
	if got := strings.Join(s.fake.calls, ", "); got != "validate Main.ahk, restart Main.ahk" {
		t.Fatalf("AutoHotkey calls: %s", got)
	}
	if _, err := os.Stat(filepath.Join(s.folder, "General.ahk.bak")); err != nil {
		t.Fatal("no backup:", err)
	}
	if _, err := os.Stat(filepath.Join(s.folder, lockName)); !os.IsNotExist(err) {
		t.Fatal("lock left behind")
	}
}

func TestSaveAddsTheIncludeForANewCategory(t *testing.T) {
	s := newSaveSetup(t)
	s.create(t, "Main.ahk", "main", "")
	os.WriteFile(filepath.Join(s.folder, "Email.ahk"), []byte("; mine\r\n"), 0o644)

	r := s.save(t, "Email.ahk", ":T:;ty::thank you", "Main.ahk")
	if r["ok"] != true || r["includeAdded"] != true {
		t.Fatalf("save: %v", r)
	}
	if main := s.read(t, "Main.ahk"); strings.Count(main, `#Include "Email.ahk"`) != 1 {
		t.Fatalf("Main.ahk:\n%s", main)
	}
	if seen := s.fake.filesSeenDuringValidation["Main.ahk"]; !strings.Contains(seen, `#Include "Email.ahk"`) {
		t.Fatal("validation ran before the #Include was written")
	}
	if r := s.save(t, "Email.ahk", ":T:;ty2::thanks", "Main.ahk"); r["includeAdded"] != false {
		t.Fatalf("second save added the #Include again: %v", r)
	}
}

func TestSaveRestoresEverythingWhenAutoHotkeyRejectsIt(t *testing.T) {
	for _, step := range []string{"validate", "restart"} {
		t.Run(step, func(t *testing.T) {
			s := newSaveSetup(t)
			s.create(t, "Main.ahk", "main", "")
			os.WriteFile(filepath.Join(s.folder, "Email.ahk"), []byte("\xEF\xBB\xBF; mine"), 0o644)
			before := readAll(s.folder)
			s.fake.failValidate = step == "validate"
			s.fake.failRestart = step == "restart"

			r := s.save(t, "Email.ahk", ":T:;ty::thank you", "Main.ahk")
			want := map[string]string{"validate": codeAhkInvalid, "restart": codeReloadFailed}[step]
			if errorCode(r) != want {
				t.Fatalf("expected %s, got %v", want, r)
			}
			after := readAll(s.folder)
			for name, data := range before {
				if after[name] != data {
					t.Errorf("%s changed:\n%q\n%q", name, data, after[name])
				}
			}
			if _, err := os.Stat(filepath.Join(s.folder, lockName)); !os.IsNotExist(err) {
				t.Fatal("lock left behind")
			}
		})
	}
}

func TestSaveWithoutAMainScriptRestartsTheFileItself(t *testing.T) {
	s := newSaveSetup(t)
	os.WriteFile(filepath.Join(s.folder, "Solo.ahk"), []byte("#Requires AutoHotkey v2.0\n"), 0o644)
	if r := s.save(t, "Solo.ahk", ":X:;sig::SendText(\"a`nb\" A_EndChar)", ""); r["ok"] != true || r["entry"] != "Solo.ahk" {
		t.Fatalf("save: %v", r)
	}
	if got := strings.Join(s.fake.calls, ", "); got != "validate Solo.ahk, restart Solo.ahk" {
		t.Fatalf("AutoHotkey calls: %s", got)
	}
}

func TestSaveRefusesBadRequests(t *testing.T) {
	s := newSaveSetup(t)
	s.create(t, "Main.ahk", "main", "")
	s.create(t, "General.ahk", "category", "Main.ahk")
	os.WriteFile(filepath.Join(s.folder, "Exec.ahk"), []byte("#Hotstring X\r\n"), 0o644)
	os.WriteFile(filepath.Join(s.folder, "Wide.ahk"), []byte{0xFF, 0xFE, 'x', 0}, 0o644)
	ok := ":T:;a::b"
	cases := []struct {
		name string
		msg  map[string]any
		code string
	}{
		{"a code line", map[string]any{"line": `:X:;a::Run("calc")`}, codeBadLine},
		{"no folder", map[string]any{"folder": ""}, codeFolderMissing},
		{"a missing folder", map[string]any{"folder": filepath.Join(s.folder, "nope")}, codeFolderMissing},
		{"a missing file", map[string]any{"file": "Nope.ahk"}, codeFileMissing},
		{"a path in the name", map[string]any{"file": "../General.ahk"}, codeBadName},
		{"a missing main script", map[string]any{"reload": "Nope.ahk"}, codeFileMissing},
		{"another program as AutoHotkey", map[string]any{"ahkPath": "/bin/sh"}, codeAhkMissing},
		{"a missing AutoHotkey", map[string]any{"ahkPath": filepath.Join(s.folder, "AutoHotkey64.exe")}, codeAhkMissing},
		{"#Hotstring X in the file", map[string]any{"file": "Exec.ahk"}, codeHotstringX},
		{"a UTF-16 file", map[string]any{"file": "Wide.ahk"}, codeEncoding},
		{"an unknown field", map[string]any{"options": "X"}, codeBadRequest},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			msg := map[string]any{"type": "save", "folder": s.folder, "ahkPath": s.exe, "file": "General.ahk", "line": ok, "reload": "Main.ahk"}
			for k, v := range c.msg {
				msg[k] = v
			}
			before := readAll(s.folder)
			if r := s.request(t, msg); errorCode(r) != c.code {
				t.Fatalf("expected %s, got %v", c.code, r)
			}
			if after := readAll(s.folder); len(after) != len(before) || after["General.ahk"] != before["General.ahk"] {
				t.Fatal("files changed on a refused save")
			}
		})
	}
	if len(s.fake.calls) != 0 {
		t.Fatalf("AutoHotkey ran for a refused save: %v", s.fake.calls)
	}
}
