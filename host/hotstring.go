package main

import (
	"regexp"
	"strings"
)

// The host writes only lines in the exact shape toHotstring()
// (extension/src/hotstring.ts) produces: a :T: line of plain text, or an :X:
// line whose whole action is one SendText() string literal. Anything else
// could be AutoHotkey code, so it never reaches a file.
var (
	hotstringLine = regexp.MustCompile("^:(\\*?)(\\??)(C?)((?:B0)?)(O?)([TX]):((?:`.|[^`:\\r\\n])+)::(.+)$")
	textModeBody  = regexp.MustCompile("^(?:`.|[^`\\r\\n\\t])+$")
	sendTextBody  = regexp.MustCompile("^SendText\\(\"(?:`.|[^`\"\\r\\n])*\"(?: A_EndChar)?\\)$")

	hotstringDirective = regexp.MustCompile(`(?im)^[ \t]*#Hotstring[ \t]+([^\r\n]*)`)
)

const maxLineLength = 16_000

func checkHotstringLine(line string) error {
	bad := fail(codeBadLine, "That isn't a hotstring line this extension writes.")
	if line == "" || len(line) > maxLineLength {
		return bad
	}
	// A semicolon after a space or tab starts a comment, which would cut the line short.
	if strings.Contains(line, " ;") || strings.Contains(line, "\t;") {
		return bad
	}
	m := hotstringLine.FindStringSubmatch(line)
	if m == nil {
		return bad
	}
	body := m[8]
	switch m[6] {
	case "T":
		// Text mode trims leading and trailing spaces, so toHotstring never uses it for them.
		if !textModeBody.MatchString(body) || body != strings.Trim(body, " ") {
			return bad
		}
	case "X":
		if !sendTextBody.MatchString(body) {
			return bad
		}
	}
	return nil
}

// executesByDefault reports whether #Hotstring directives in src leave the X
// option on at the end of the file. Hotstrings below that without an explicit
// X0, including :T: lines, would run their text as code.
func executesByDefault(src string) bool {
	on := false
	for _, m := range hotstringDirective.FindAllStringSubmatch(src, -1) {
		options := stripComment(m[1])
		fields := strings.Fields(options)
		if len(fields) == 0 {
			continue
		}
		switch strings.ToLower(fields[0]) {
		case "endchars", "nomouse", "mousereset":
			continue
		}
		for i := 0; i < len(options); i++ {
			if options[i] == 'X' || options[i] == 'x' {
				on = i+1 >= len(options) || options[i+1] != '0'
			}
		}
	}
	return on
}

// stripComment removes a trailing " ; comment" from a directive's argument.
func stripComment(s string) string {
	for i := 1; i < len(s); i++ {
		if s[i] == ';' && (s[i-1] == ' ' || s[i-1] == '\t') {
			return strings.TrimSpace(s[:i])
		}
	}
	return strings.TrimSpace(s)
}
