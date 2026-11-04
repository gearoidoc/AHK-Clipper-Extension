package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// saveMsg builds a save request with the setup's folder and AutoHotkey.
func (s *saveSetup) saveMsg(fields map[string]any) map[string]any {
	msg := map[string]any{"type": "save", "folder": s.folder, "ahkPath": s.exe, "file": "General.ahk", "reload": "Main.ahk"}
	for k, v := range fields {
		msg[k] = v
	}
	return msg
}

func (s *saveSetup) undo(t *testing.T, token map[string]any) map[string]any {
	return s.request(t, map[string]any{
		"type": "undo", "folder": s.folder, "ahkPath": s.exe, "reload": "Main.ahk",
		"file": token["file"], "id": token["id"], "sha256": token["sha256"],
	})
}

func newFolder(t *testing.T) *saveSetup {
	s := newSaveSetup(t)
	s.create(t, "Main.ahk", "main", "")
	s.create(t, "General.ahk", "category", "Main.ahk")
	return s
}

func scanOf(t *testing.T, s *saveSetup) []map[string]any {
	t.Helper()
	r := s.request(t, map[string]any{"type": "scan", "folder": s.folder})
	if r["ok"] != true {
		t.Fatalf("scan: %v", r)
	}
	var out []map[string]any
	for _, h := range r["hotstrings"].([]any) {
		out = append(out, h.(map[string]any))
	}
	return out
}

func TestScanListsEveryHotstring(t *testing.T) {
	s := newFolder(t)
	os.WriteFile(filepath.Join(s.folder, "Email.ahk"), []byte("::btw::by the way\r\n/*\r\n::no::x\r\n*/\r\n:C*X:Sig::SendText(\"a\")\r\n"), 0o644)
	os.WriteFile(filepath.Join(s.folder, "Wide.ahk"), []byte{0xFF, 0xFE, 'x', 0}, 0o644)
	s.save(t, "General.ahk", ":*T:;brb::be right back", "Main.ahk")

	r := s.request(t, map[string]any{"type": "scan", "folder": s.folder})
	files, _ := r["files"].([]any)
	skipped, _ := r["skipped"].([]any)
	if len(files) != 4 || len(skipped) != 1 || skipped[0] != "Wide.ahk" {
		t.Fatalf("files %v, skipped %v", files, skipped)
	}
	var got []string
	for _, h := range scanOf(t, s) {
		got = append(got, h["file"].(string)+":"+h["trigger"].(string))
	}
	if strings.Join(got, " ") != "Email.ahk:btw Email.ahk:Sig General.ahk:;brb" {
		t.Fatalf("got %v", got)
	}
	sig := scanOf(t, s)[1]
	if sig["caseSensitive"] != true || sig["instant"] != true || sig["text"] != "a" || sig["line"] != float64(5) {
		t.Fatalf("Sig: %v", sig)
	}
	if brb := scanOf(t, s)[2]; brb["id"] == "" || brb["text"] != "be right back" {
		t.Fatalf(";brb: %v", brb)
	}
}

func TestSaveRefusesADuplicateTriggerAnywhereInTheFolder(t *testing.T) {
	s := newFolder(t)
	os.WriteFile(filepath.Join(s.folder, "Email.ahk"), []byte("::BRB::be right back\r\n:C:Sig::x\r\n"), 0o644)
	before := readAll(s.folder)
	for _, line := range []string{":T:;x::y", ":T:brb::again", ":*T:Brb::again"} {
		r := s.request(t, s.saveMsg(map[string]any{"line": line}))
		if line == ":T:;x::y" {
			if r["ok"] != true {
				t.Fatalf("a new trigger was refused: %v", r)
			}
			before = readAll(s.folder)
			continue
		}
		if errorCode(r) != codeDuplicate || !strings.Contains(r["error"].(map[string]any)["message"].(string), "Email.ahk (line 1)") {
			t.Fatalf("%s: %v", line, r)
		}
	}
	// Case matters as soon as either side is case-sensitive.
	if r := s.request(t, s.saveMsg(map[string]any{"line": ":T:sig::other"})); r["ok"] != true {
		t.Fatalf("sig vs C Sig: %v", r)
	}
	if r := s.request(t, s.saveMsg(map[string]any{"line": ":CT:Sig::other"})); errorCode(r) != codeDuplicate {
		t.Fatalf("C Sig vs C Sig: %v", r)
	}
	if after := readAll(s.folder); after["Email.ahk"] != before["Email.ahk"] {
		t.Fatal("a refused save changed a file")
	}
}

func TestReplaceSwapsTheEntryInPlace(t *testing.T) {
	s := newFolder(t)
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;a::first"}))
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;brb::be right back", "comment": "; from Old page, https://old.example, 2026-11-01"}))
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;z::last"}))
	var target map[string]any
	for _, h := range scanOf(t, s) {
		if h["trigger"] == ";brb" {
			target = h
		}
	}
	replace := map[string]any{"file": "General.ahk", "line": target["line"], "hash": target["hash"]}

	r := s.request(t, s.saveMsg(map[string]any{"line": ":*T:;brb::back in a moment", "replace": replace}))
	if r["ok"] != true || r["replaced"] != true {
		t.Fatalf("replace: %v", r)
	}
	general := s.read(t, "General.ahk")
	if strings.Contains(general, "be right back") || strings.Contains(general, "Old page") {
		t.Fatalf("old entry or its comment is still there:\n%s", general)
	}
	order := []string{":T:;a::first", ":*T:;brb::back in a moment ; hsc:" + r["id"].(string), ":T:;z::last"}
	last := -1
	for _, want := range order {
		i := strings.Index(general, want)
		if i <= last {
			t.Fatalf("entries out of place, looking for %q:\n%s", want, general)
		}
		last = i
	}

	// The same line number with stale contents is refused.
	if r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;brb::x", "replace": replace})); errorCode(r) != codeFileChanged {
		t.Fatalf("stale replace: %v", r)
	}
	// A replacement goes to the file it replaces.
	if r := s.request(t, s.saveMsg(map[string]any{"file": "Main.ahk", "line": ":T:;q::x", "replace": replace})); errorCode(r) != codeBadRequest {
		t.Fatalf("replace into another file: %v", r)
	}
}

func TestSourceCommentGoesAboveTheLine(t *testing.T) {
	s := newFolder(t)
	comment := "; from Example page, https://example.com, 2026-11-04"
	r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;ex::example", "comment": comment}))
	if r["ok"] != true || !strings.HasSuffix(s.read(t, "General.ahk"), comment+"\r\n:T:;ex::example ; hsc:"+r["id"].(string)+"\r\n") {
		t.Fatalf("%v\n%q", r, s.read(t, "General.ahk"))
	}
	for _, bad := range []string{"; elsewhere", "; from x\r\nRun(\"calc\")", "Run(\"calc\") ; from x", "; from " + strings.Repeat("x", maxCommentLength)} {
		if r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;q::x", "comment": bad})); errorCode(r) != codeBadLine {
			t.Errorf("comment %q: %v", bad, r)
		}
	}
}

func TestUndoRestoresTheFileExactly(t *testing.T) {
	s := newFolder(t)
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;a::first"}))
	before := readAll(s.folder)
	r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;b::second", "comment": "; from Page, https://example.com, 2026-11-04"}))
	s.fake.calls = nil

	u := s.undo(t, r["undo"].(map[string]any))
	if u["ok"] != true || u["exact"] != true {
		t.Fatalf("undo: %v", u)
	}
	if s.read(t, "General.ahk") != before["General.ahk"] {
		t.Fatalf("not restored:\n%q\n%q", s.read(t, "General.ahk"), before["General.ahk"])
	}
	if got := strings.Join(s.fake.calls, ", "); got != "validate Main.ahk, restart Main.ahk" {
		t.Fatalf("AutoHotkey calls: %s", got)
	}
}

func TestUndoOfAReplaceBringsTheOldEntryBack(t *testing.T) {
	s := newFolder(t)
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;brb::be right back"}))
	before := s.read(t, "General.ahk")
	h := scanOf(t, s)[0]
	r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;brb::back soon", "replace": map[string]any{"file": "General.ahk", "line": h["line"], "hash": h["hash"]}}))
	if u := s.undo(t, r["undo"].(map[string]any)); u["exact"] != true || s.read(t, "General.ahk") != before {
		t.Fatalf("undo: %v\n%q", u, s.read(t, "General.ahk"))
	}
}

func TestUndoAfterLaterChangesRemovesOnlyThatEntry(t *testing.T) {
	s := newFolder(t)
	r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;b::second", "comment": "; from Page, https://example.com, 2026-11-04"}))
	later := s.request(t, s.saveMsg(map[string]any{"line": ":T:;c::third"}))
	u := s.undo(t, r["undo"].(map[string]any))
	general := s.read(t, "General.ahk")
	if u["ok"] != true || u["exact"] != false || strings.Contains(general, ";b::") || strings.Contains(general, "; from Page") || !strings.Contains(general, ";c::third ; hsc:"+later["id"].(string)) {
		t.Fatalf("undo: %v\n%s", u, general)
	}
	if u := s.undo(t, r["undo"].(map[string]any)); errorCode(u) != codeFileChanged {
		t.Fatalf("second undo: %v", u)
	}
}

func TestUndoRollsBackWhenAutoHotkeyRejectsIt(t *testing.T) {
	s := newFolder(t)
	r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;b::second"}))
	after := s.read(t, "General.ahk")
	s.fake.failValidate = true
	if u := s.undo(t, r["undo"].(map[string]any)); errorCode(u) != codeAhkInvalid {
		t.Fatalf("undo: %v", u)
	}
	if s.read(t, "General.ahk") != after {
		t.Fatal("a failed undo changed the file")
	}
}

func TestUndoRejectsMadeUpTokens(t *testing.T) {
	s := newFolder(t)
	for _, token := range []map[string]any{
		{"file": "General.ahk", "id": "NOTOK!", "sha256": strings.Repeat("a", 64)},
		{"file": "General.ahk", "id": "abcdef", "sha256": "short"},
		{"file": "../x.ahk", "id": "abcdef", "sha256": strings.Repeat("a", 64)},
	} {
		if u := s.undo(t, token); u["ok"] != false {
			t.Errorf("%v accepted: %v", token, u)
		}
	}
}
