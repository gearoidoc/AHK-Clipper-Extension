package main

import (
	"strings"
	"testing"
)

func TestParseHotstringLine(t *testing.T) {
	cases := []struct {
		line          string
		trigger       string
		caseSensitive bool
		instant       bool
		text          string
		id            string
	}{
		{"::btw::by the way", "btw", false, false, "by the way", ""},
		{":T:;brb::be right back ; hsc:k3j9x2", ";brb", false, false, "be right back", "k3j9x2"},
		{":*T:;brb::be right back", ";brb", false, true, "be right back", ""},
		{":*0T:;x::y", ";x", false, false, "y", ""},
		{":C:Ab::x", "Ab", true, false, "x", ""},
		{":C1:Ab::x", "Ab", false, false, "x", ""},
		{":C0:Ab::x", "Ab", false, false, "x", ""},
		{":T:a`:b::x", "a:b", false, false, "x", ""},
		{":T:x`:::y", "x:", false, false, "y", ""},
		{":T:``t::y", "`t", false, false, "y", ""},
		{":T:a `;b::y", "a ;b", false, false, "y", ""},
		{":T:;dc::a::b", ";dc", false, false, "a::b", ""},
		{":T:;sc::a `;b", ";sc", false, false, "a ;b", ""},
		{":X:;sig::SendText(\"Best regards,`nJane\" A_EndChar)", ";sig", false, false, "Best regards, \u21b5 Jane", ""},
		{":X:;q::SendText(\"say `\"hi`\"\")", ";q", false, false, "say \"hi\"", ""},
		{":X:;run::Run(\"notepad\")", ";run", false, false, "(runs code)", ""},
		{"::;fn::", ";fn", false, false, "(runs code)", ""},
		{"  :T:;ind::indented", ";ind", false, false, "indented", ""},
		{":T:;e::\u00e9t\u00e9", ";e", false, false, "\u00e9t\u00e9", ""},
		{":T:`\u00e9x::y", "\u00e9x", false, false, "y", ""},
	}
	for _, c := range cases {
		h, ok := parseHotstringLine(c.line)
		if !ok {
			t.Errorf("%q: not parsed", c.line)
			continue
		}
		if h.Trigger != c.trigger || h.CaseSensitive != c.caseSensitive || h.Instant != c.instant || h.Text != c.text || h.ID != c.id {
			t.Errorf("%q:\n got  %q case=%v instant=%v text=%q id=%q\n want %q case=%v instant=%v text=%q id=%q",
				c.line, h.Trigger, h.CaseSensitive, h.Instant, h.Text, h.ID, c.trigger, c.caseSensitive, c.instant, c.text, c.id)
		}
	}
	for _, line := range []string{"", "; :T:a::b", "a::b", "^j::Send(\"x\")", ":T:no double colon", "::", ":T:::empty trigger", "#Include \"x.ahk\""} {
		if h, ok := parseHotstringLine(line); ok {
			t.Errorf("%q parsed as a hotstring: %+v", line, h)
		}
	}
}

// Every line toHotstring() produces must read back as the trigger it was
// made from: a cross-check between the TypeScript generator and this parser.
func TestFixtureLinesParseBackToTheirTriggers(t *testing.T) {
	for _, row := range loadFixture(t).Lines {
		h, ok := parseHotstringLine(row.Line + " ; hsc:k3j9x2")
		if !ok || h.Trigger != row.Trigger || h.ID != "k3j9x2" {
			t.Errorf("%s: %q parsed as %+v (ok=%v), want trigger %q", row.Name, row.Line, h, ok, row.Trigger)
		}
	}
}

func TestParseHotstringsSkipsBlockCommentsAndCountsLines(t *testing.T) {
	src := strings.Join([]string{
		"#Requires AutoHotkey v2.0", // 1
		":T:;a::one",                // 2
		"/*",                        // 3
		":T:;hidden::no",            // 4
		"*/",                        // 5
		"/* one-line */",            // 6
		":T:;b::two\r",              // 7
		"; :T:;c::commented",        // 8
	}, "\n")
	got := parseHotstrings(src)
	if len(got) != 2 || got[0].Trigger != ";a" || got[0].Line != 2 || got[1].Trigger != ";b" || got[1].Line != 7 {
		t.Fatalf("got %+v", got)
	}
	if got[1].Hash != lineHash(":T:;b::two") {
		t.Fatal("the hash must ignore the CR of a CRLF line")
	}
}

func TestSameTrigger(t *testing.T) {
	if !sameTrigger(";BRB", false, ";brb", false) {
		t.Error("triggers without C match in any case")
	}
	if sameTrigger(";BRB", true, ";brb", false) || sameTrigger(";BRB", false, ";brb", true) {
		t.Error("a case-sensitive trigger only matches its exact case")
	}
	if !sameTrigger(";brb", true, ";brb", true) {
		t.Error("identical triggers match")
	}
}

func TestPreviewIsOneShortLine(t *testing.T) {
	long := preview(strings.Repeat("\u00e9", 500))
	if n := len([]rune(long)); n != maxPreview || !strings.HasSuffix(long, "\u2026") {
		t.Fatalf("length %d: %q", n, long)
	}
	if got := preview("a\r\nb\tc"); got != "a \u21b5 b c" {
		t.Fatalf("got %q", got)
	}
}
