package main

import (
	"bytes"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func findEntry(t *testing.T, s *saveSetup, trigger string) map[string]any {
	t.Helper()
	for _, h := range scanOf(t, s) {
		if h["trigger"] == trigger {
			return h
		}
	}
	t.Fatalf("%s not found by scan", trigger)
	return nil
}

func targetOf(h map[string]any) map[string]any {
	return map[string]any{"file": h["file"], "line": h["line"], "hash": h["hash"]}
}

func TestScanReturnsFullEntries(t *testing.T) {
	s := newFolder(t)
	os.WriteFile(filepath.Join(s.folder, "Hand.ahk"), []byte(strings.Join([]string{
		"::btw::by the way",
		"::sig::Regards{Enter}Jane",
		":X:;run::Run(\"notepad\")",
		":*X:;two::SendText(\"line one`nline two\")",
	}, "\r\n")), 0o644)
	got := map[string]map[string]any{}
	for _, h := range scanOf(t, s) {
		got[h["trigger"].(string)] = h
	}
	check := func(trigger, kind, text, options string, editable bool) {
		h := got[trigger]
		if h["kind"] != kind || h["text"] != text || h["options"] != options || h["editable"] != editable {
			t.Errorf("%s: %v", trigger, h)
		}
	}
	check("btw", "text", "by the way", "", true)
	check("sig", "text", "Regards{Enter}Jane", "", false)
	check(";run", "code", `Run("notepad")`, "X", false)
	check(";two", "text", "line one\nline two", "*X", true)
}

func TestScanPagesLongCollections(t *testing.T) {
	s := newFolder(t)
	long := strings.Repeat("x", 4000)
	var lines []string
	for i := 0; i < 400; i++ {
		lines = append(lines, ":T:;t"+strings.Repeat("a", i%30)+string(rune('a'+i%26))+"::"+long)
	}
	os.WriteFile(filepath.Join(s.folder, "Big.ahk"), []byte(strings.Join(lines, "\r\n")), 0o644)

	total, pages, start := 0, 0, 0
	for {
		r := s.request(t, map[string]any{"type": "scan", "folder": s.folder, "start": start})
		var buf bytes.Buffer
		writeMessage(&buf, r)
		if size := binary.LittleEndian.Uint32(buf.Bytes()[:4]); size > maxOutbound {
			t.Fatalf("page of %d bytes is over Chrome's limit", size)
		}
		total += len(r["hotstrings"].([]any))
		pages++
		next := int(r["next"].(float64))
		if next == 0 {
			break
		}
		if next <= start {
			t.Fatalf("next %d doesn't move past %d", next, start)
		}
		start = next
	}
	if total != 400 || pages < 2 {
		t.Fatalf("%d hotstrings in %d pages", total, pages)
	}
}

func TestEditKeepsTheSourceComment(t *testing.T) {
	s := newFolder(t)
	comment := "; from Page, https://example.com, 2026-11-04"
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;brb::be right back", "comment": comment}))
	h := findEntry(t, s, ";brb")
	r := s.request(t, s.saveMsg(map[string]any{"line": ":*T:;brb::back soon", "replace": targetOf(h), "keepComment": true}))
	if r["ok"] != true || !strings.HasSuffix(s.read(t, "General.ahk"), comment+"\r\n:*T:;brb::back soon ; hsc:"+r["id"].(string)+"\r\n") {
		t.Fatalf("%v\n%q", r, s.read(t, "General.ahk"))
	}
}

func TestEditCanMoveAnEntryToAnotherFile(t *testing.T) {
	s := newFolder(t)
	comment := "; from Page, https://example.com, 2026-11-04"
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;a::first"}))
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;brb::be right back", "comment": comment}))
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;z::last"}))
	os.WriteFile(filepath.Join(s.folder, "Chat.ahk"), []byte("; Chat\r\n"), 0o644)
	h := findEntry(t, s, ";brb")

	r := s.request(t, s.saveMsg(map[string]any{"file": "Chat.ahk", "line": ":T:;brb::be right back", "replace": targetOf(h), "keepComment": true}))
	if r["ok"] != true || r["includeAdded"] != true {
		t.Fatalf("move: %v", r)
	}
	general, chat := s.read(t, "General.ahk"), s.read(t, "Chat.ahk")
	if strings.Contains(general, ";brb") || strings.Contains(general, "; from Page") || !strings.Contains(general, ";a::first") || !strings.Contains(general, ";z::last") {
		t.Fatalf("General.ahk:\n%s", general)
	}
	if !strings.HasSuffix(chat, comment+"\r\n:T:;brb::be right back ; hsc:"+r["id"].(string)+"\r\n") {
		t.Fatalf("Chat.ahk:\n%q", chat)
	}
	if !strings.Contains(s.read(t, "Main.ahk"), `#Include "Chat.ahk"`) {
		t.Fatal("Main.ahk doesn't include Chat.ahk")
	}
}

func TestEditToAnExistingTriggerIsRefused(t *testing.T) {
	s := newFolder(t)
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;a::first"}))
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;b::second"}))
	h := findEntry(t, s, ";b")
	if r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;a::second", "replace": targetOf(h), "keepComment": true})); errorCode(r) != codeDuplicate {
		t.Fatalf("got %v", r)
	}
	// Keeping its own trigger is fine.
	if r := s.request(t, s.saveMsg(map[string]any{"line": ":T:;b::changed", "replace": targetOf(h), "keepComment": true})); r["ok"] != true {
		t.Fatalf("got %v", r)
	}
}

func TestDeleteRemovesTheEntryAndItsComment(t *testing.T) {
	s := newFolder(t)
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;a::first"}))
	before := s.read(t, "General.ahk")
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;b::second", "comment": "; from Page, https://example.com, 2026-11-04"}))
	h := findEntry(t, s, ";b")
	s.fake.calls = nil

	del := func(target map[string]any) map[string]any {
		return s.request(t, map[string]any{"type": "delete", "folder": s.folder, "ahkPath": s.exe, "reload": "Main.ahk",
			"file": target["file"], "line": target["line"], "hash": target["hash"]})
	}
	if r := del(h); r["ok"] != true || s.read(t, "General.ahk") != before {
		t.Fatalf("delete: %v\n%q\n%q", r, s.read(t, "General.ahk"), before)
	}
	if got := strings.Join(s.fake.calls, ", "); got != "validate Main.ahk, restart Main.ahk" {
		t.Fatalf("AutoHotkey calls: %s", got)
	}
	if r := del(h); errorCode(r) != codeFileChanged {
		t.Fatalf("stale delete: %v", r)
	}

	a := findEntry(t, s, ";a")
	s.fake.failValidate = true
	if r := del(a); errorCode(r) != codeAhkInvalid || s.read(t, "General.ahk") != before {
		t.Fatalf("delete with a failing validation: %v", r)
	}
}

func TestImportSkipsDuplicatesAndRestartsOnce(t *testing.T) {
	s := newFolder(t)
	s.request(t, s.saveMsg(map[string]any{"line": ":T:;brb::be right back"}))
	os.WriteFile(filepath.Join(s.folder, "Chat.ahk"), []byte("; Chat\r\n"), 0o644)
	s.fake.calls = nil

	r := s.request(t, map[string]any{"type": "import", "folder": s.folder, "ahkPath": s.exe, "reload": "Main.ahk", "entries": []any{
		map[string]any{"file": "General.ahk", "line": ":T:;ty::thank you"},
		map[string]any{"file": "Chat.ahk", "line": ":*T:;lol::laughing"},
		map[string]any{"file": "General.ahk", "line": ":T:;BRB::already there"},
		map[string]any{"file": "Chat.ahk", "line": ":T:;ty::twice in the import"},
		map[string]any{"file": "Chat.ahk", "line": ":X:;sig::SendText(\"a`nb\" A_EndChar)"},
	}})
	if r["ok"] != true || r["added"] != float64(3) {
		t.Fatalf("import: %v", r)
	}
	skipped := r["skipped"].([]any)
	if len(skipped) != 2 || skipped[0].(map[string]any)["index"] != float64(2) || skipped[1].(map[string]any)["index"] != float64(3) ||
		!strings.Contains(skipped[0].(map[string]any)["reason"].(string), "already in General.ahk") ||
		!strings.Contains(skipped[1].(map[string]any)["reason"].(string), "this import (entry 1)") {
		t.Fatalf("skipped: %v", skipped)
	}
	if !strings.Contains(s.read(t, "General.ahk"), ";ty::thank you ; hsc:") || !strings.Contains(s.read(t, "Chat.ahk"), ";lol::laughing ; hsc:") ||
		!strings.Contains(s.read(t, "Chat.ahk"), ";sig::SendText") || !strings.Contains(s.read(t, "Main.ahk"), `#Include "Chat.ahk"`) {
		t.Fatal("entries or the #Include are missing")
	}
	if got := strings.Join(s.fake.calls, ", "); got != "validate Main.ahk, restart Main.ahk" {
		t.Fatalf("AutoHotkey calls: %s", got)
	}
}

func TestImportIsAllOrNothing(t *testing.T) {
	s := newFolder(t)
	before := readAll(s.folder)
	s.fake.failValidate = true
	r := s.request(t, map[string]any{"type": "import", "folder": s.folder, "ahkPath": s.exe, "reload": "Main.ahk", "entries": []any{
		map[string]any{"file": "General.ahk", "line": ":T:;a::one"},
	}})
	if errorCode(r) != codeAhkInvalid {
		t.Fatalf("import: %v", r)
	}
	if after := readAll(s.folder); after["General.ahk"] != before["General.ahk"] {
		t.Fatal("a failed import changed a file")
	}
}

func TestImportRefusesBadRequests(t *testing.T) {
	s := newFolder(t)
	cases := map[string][]any{
		"no entries":         {},
		"a code line":        {map[string]any{"file": "General.ahk", "line": `:X:;a::Run("calc")`}},
		"a missing file":     {map[string]any{"file": "Nope.ahk", "line": ":T:;a::b"}},
		"a path in the name": {map[string]any{"file": "../x.ahk", "line": ":T:;a::b"}},
	}
	want := map[string]string{"no entries": codeBadRequest, "a code line": codeBadLine, "a missing file": codeFileMissing, "a path in the name": codeBadName}
	for name, entries := range cases {
		r := s.request(t, map[string]any{"type": "import", "folder": s.folder, "ahkPath": s.exe, "reload": "Main.ahk", "entries": entries})
		if errorCode(r) != want[name] {
			t.Errorf("%s: %v", name, r)
		}
	}
	if len(s.fake.calls) != 0 {
		t.Fatalf("AutoHotkey ran: %v", s.fake.calls)
	}
}

func TestInboundCapAllowsLargeImports(t *testing.T) {
	if maxInbound < 4<<20 {
		t.Fatalf("maxInbound is %d", maxInbound)
	}
}
