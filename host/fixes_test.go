package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

// Moving a hotstring out of the main script into a file it doesn't include
// yet: the cut and the new #Include both land in Main.ahk.
func TestMoveOutOfTheMainScript(t *testing.T) {
	s := newSaveSetup(t)
	os.WriteFile(filepath.Join(s.folder, "Main.ahk"), []byte("#Requires AutoHotkey v2.0\r\n:T:;m::from main\r\n"), 0o644)
	os.WriteFile(filepath.Join(s.folder, "Chat.ahk"), []byte("; Chat\r\n"), 0o644)
	h := findEntry(t, s, ";m")
	r := s.request(t, map[string]any{"type": "save", "folder": s.folder, "ahkPath": s.exe, "file": "Chat.ahk", "reload": "Main.ahk",
		"line": ":T:;m::from main", "replace": targetOf(h), "keepComment": true})
	if r["ok"] != true || r["includeAdded"] != true {
		t.Fatalf("move: %v", r)
	}
	main := s.read(t, "Main.ahk")
	if strings.Contains(main, ";m::") || !strings.Contains(main, `#Include "Chat.ahk"`) {
		t.Fatalf("Main.ahk:\n%s", main)
	}
	if !strings.Contains(s.read(t, "Chat.ahk"), ":T:;m::from main ; hsc:") {
		t.Fatalf("Chat.ahk:\n%s", s.read(t, "Chat.ahk"))
	}
}

// A hotstring whose code is on the following lines can't be cut to one line.
func TestMultilineCodeCantBeDeletedOrReplaced(t *testing.T) {
	s := newFolder(t)
	original := "::mail::\r\n{\r\n    Run \"mailto:x@example.com\"\r\n}\r\n"
	os.WriteFile(filepath.Join(s.folder, "General.ahk"), []byte(original), 0o644)
	h := findEntry(t, s, "mail")
	if h["multiline"] != true || h["kind"] != "code" {
		t.Fatalf("scan: %v", h)
	}
	del := s.request(t, map[string]any{"type": "delete", "folder": s.folder, "ahkPath": s.exe, "reload": "Main.ahk", "file": "General.ahk", "line": h["line"], "hash": h["hash"]})
	rep := s.request(t, s.saveMsg(map[string]any{"line": ":T:mail::text", "replace": targetOf(h)}))
	if errorCode(del) != codeCodeBlock || errorCode(rep) != codeCodeBlock {
		t.Fatalf("delete %v, replace %v", del, rep)
	}
	if s.read(t, "General.ahk") != original || len(s.fake.calls) != 0 {
		t.Fatal("the file or AutoHotkey was touched")
	}
	// A one-line code hotstring is still fine to delete.
	os.WriteFile(filepath.Join(s.folder, "General.ahk"), []byte(":X:;run::Run(\"notepad\")\r\n"), 0o644)
	run := findEntry(t, s, ";run")
	if r := s.request(t, map[string]any{"type": "delete", "folder": s.folder, "ahkPath": s.exe, "reload": "Main.ahk", "file": "General.ahk", "line": run["line"], "hash": run["hash"]}); r["ok"] != true {
		t.Fatalf("one-line delete: %v", r)
	}
}

// A failed save leaves the .bak as it was, so Undo of an earlier save still
// restores the state before it.
func TestUndoAfterALaterFailedSave(t *testing.T) {
	s := newFolder(t)
	before := s.read(t, "General.ahk")
	r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;a::A"}))
	bak, _ := os.ReadFile(filepath.Join(s.folder, "General.ahk.bak"))
	s.fake.failValidate = true
	if f := s.request(t, s.saveMsg(map[string]any{"line": ":T:;b::B"})); errorCode(f) != codeAhkInvalid {
		t.Fatalf("second save: %v", f)
	}
	if after, _ := os.ReadFile(filepath.Join(s.folder, "General.ahk.bak")); !bytes.Equal(after, bak) {
		t.Fatal("a failed save changed the .bak")
	}
	s.fake.failValidate = false
	u := s.undo(t, r["undo"].(map[string]any))
	if u["ok"] != true || s.read(t, "General.ahk") != before {
		t.Fatalf("undo: %v\n%q", u, s.read(t, "General.ahk"))
	}
}

// Undo doesn't trust a .bak that already holds the entry it's undoing.
func TestUndoIgnoresABakThatHoldsTheEntry(t *testing.T) {
	s := newFolder(t)
	r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;a::A"}))
	path := filepath.Join(s.folder, "General.ahk")
	current, _ := os.ReadFile(path)
	os.WriteFile(path+".bak", current, 0o644)
	u := s.undo(t, r["undo"].(map[string]any))
	if u["ok"] != true || u["exact"] != false || strings.Contains(s.read(t, "General.ahk"), ";a::A") {
		t.Fatalf("undo: %v\n%s", u, s.read(t, "General.ahk"))
	}
}

// Without a main script, a move restarts both files, and an import into
// several files validates and restarts each of them.
func TestWrittenModeRestartsEveryChangedFile(t *testing.T) {
	s := newSaveSetup(t)
	os.WriteFile(filepath.Join(s.folder, "General.ahk"), []byte(":T:;brb::be right back\r\n"), 0o644)
	os.WriteFile(filepath.Join(s.folder, "Chat.ahk"), []byte("; Chat\r\n"), 0o644)
	h := findEntry(t, s, ";brb")
	r := s.request(t, map[string]any{"type": "save", "folder": s.folder, "ahkPath": s.exe, "file": "Chat.ahk", "reload": "",
		"line": ":T:;brb::be right back", "replace": targetOf(h), "keepComment": true})
	if r["ok"] != true {
		t.Fatalf("move: %v", r)
	}
	if got := strings.Join(s.fake.calls, ", "); got != "validate Chat.ahk, validate General.ahk, restart Chat.ahk, restart General.ahk" {
		t.Fatalf("move calls: %s", got)
	}

	s.fake.calls = nil
	r = s.request(t, map[string]any{"type": "import", "folder": s.folder, "ahkPath": s.exe, "reload": "", "entries": []any{
		map[string]any{"file": "General.ahk", "line": ":T:;a::one"},
		map[string]any{"file": "Chat.ahk", "line": ":T:;b::two"},
	}})
	if r["ok"] != true || r["added"] != float64(2) {
		t.Fatalf("import: %v", r)
	}
	if got := strings.Join(s.fake.calls, ", "); got != "validate General.ahk, validate Chat.ahk, restart General.ahk, restart Chat.ahk" {
		t.Fatalf("import calls: %s", got)
	}
}

// Scan pages stay under Chrome's 1 MB however much the text grows when
// escaped as JSON, and one enormous line is cut short instead of failing.
func TestScanPagesStayUnderTheReplyLimit(t *testing.T) {
	s := newFolder(t)
	var lines []string
	for i := 0; i < 12; i++ {
		lines = append(lines, ":X:;c"+string(rune('a'+i))+"::Run(\""+strings.Repeat(`\"`, 60_000)+"\")")
	}
	lines = append(lines, ":T:;huge::"+strings.Repeat("x", 2_000_000))
	os.WriteFile(filepath.Join(s.folder, "Big.ahk"), []byte(strings.Join(lines, "\r\n")), 0o644)

	total, start := 0, 0
	for page := 0; ; page++ {
		raw := handle([]byte(`{"type":"scan","folder":` + jsonString(s.folder) + `,"start":` + itoa(start) + `}`))
		var buf bytes.Buffer
		writeMessage(&buf, raw)
		if size := binary.LittleEndian.Uint32(buf.Bytes()[:4]); size > maxOutbound*9/10 {
			t.Fatalf("page %d is %d bytes", page, size)
		}
		reply := replies(t, buf.Bytes())[0]
		if reply["ok"] != true {
			t.Fatalf("page %d: %v", page, reply)
		}
		for _, h := range reply["hotstrings"].([]any) {
			total++
			if e := h.(map[string]any); e["trigger"] == ";huge" && (e["editable"] != false || len(e["text"].(string)) > maxEntryText+3) {
				t.Fatalf("huge entry not cut short: editable %v, %d bytes", e["editable"], len(e["text"].(string)))
			}
		}
		if start = int(reply["next"].(float64)); start == 0 {
			break
		}
	}
	if total != 13 {
		t.Fatalf("scanned %d hotstrings", total)
	}
}

func jsonString(s string) string {
	return `"` + strings.ReplaceAll(strings.ReplaceAll(s, `\`, `\\`), `"`, `\"`) + `"`
}

func itoa(n int) string {
	return strconv.Itoa(n)
}
