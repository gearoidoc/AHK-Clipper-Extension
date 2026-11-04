package main

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode/utf8"
)

const maxPreview = 120

var idComment = regexp.MustCompile(`;[ \t]*hsc:([a-z2-9]{6})[ \t]*$`)

// parsedHotstring is one hotstring definition found in a script, read the way
// AutoHotkey v2 reads it.
type parsedHotstring struct {
	// 1-based line number.
	Line          int
	Trigger       string
	CaseSensitive bool
	Instant       bool
	// A one-line preview of what it types, or "(runs code)".
	Text string
	// The `; hsc:<id>` this extension added, or "".
	ID string
	// lineHash of the line as written, so a replace can check it hasn't changed.
	Hash string
}

// parseHotstrings finds every hotstring in a script, skipping /* */ block
// comments.
func parseHotstrings(text string) []parsedHotstring {
	var found []parsedHotstring
	inBlock := false
	for i, line := range strings.Split(text, "\n") {
		line = strings.TrimSuffix(line, "\r")
		trimmed := strings.TrimSpace(line)
		if inBlock {
			inBlock = !strings.HasPrefix(trimmed, "*/") && !strings.HasSuffix(trimmed, "*/")
			continue
		}
		if strings.HasPrefix(trimmed, "/*") {
			inBlock = !strings.HasSuffix(trimmed[2:], "*/")
			continue
		}
		if h, ok := parseHotstringLine(trimmed); ok {
			h.Line = i + 1
			h.Hash = lineHash(line)
			found = append(found, h)
		}
	}
	return found
}

// parseHotstringLine follows script.cpp: comments go first, the options run
// to the next colon, and the trigger ends at the first unescaped "::".
func parseHotstringLine(line string) (parsedHotstring, bool) {
	var h parsedHotstring
	code, comment := splitComment(strings.TrimLeft(line, " \t"))
	if len(code) < 2 || code[0] != ':' {
		return h, false
	}
	optionsEnd := strings.IndexByte(code[1:], ':') + 1
	if optionsEnd == 0 {
		return h, false
	}
	options := code[1:optionsEnd]
	var trigger strings.Builder
	i := optionsEnd + 1
	for ; i < len(code); i++ {
		if code[i] == '`' && i+1 < len(code) {
			r, size := utf8.DecodeRuneInString(code[i+1:])
			trigger.WriteString(escapeValue(r))
			i += size
			continue
		}
		if code[i] == ':' && i+1 < len(code) && code[i+1] == ':' {
			break
		}
		trigger.WriteByte(code[i])
	}
	if i >= len(code) || trigger.Len() == 0 {
		return h, false
	}
	body := code[i+2:]

	execute := false
	for j := 0; j < len(options); j++ {
		next := byte(0)
		if j+1 < len(options) {
			next = options[j+1]
		}
		switch options[j] {
		case 'C', 'c':
			h.CaseSensitive = next != '0' && next != '1'
		case '*':
			h.Instant = next != '0'
		case 'X', 'x':
			execute = next != '0'
		}
	}

	switch {
	case body == "":
		// The hotstring's code follows on the next lines.
		h.Text = "(runs code)"
	case execute:
		if m := sendTextBody.FindStringSubmatch(body); m != nil {
			h.Text = preview(unescape(m[1]))
		} else {
			h.Text = "(runs code)"
		}
	default:
		h.Text = preview(unescape(body))
	}
	h.Trigger = trigger.String()
	if m := idComment.FindStringSubmatch(comment); m != nil {
		h.ID = m[1]
	}
	return h, true
}

// splitComment separates a line at the first semicolon with a space or tab
// on its left, which is where AutoHotkey starts a comment.
func splitComment(line string) (code, comment string) {
	for i := 1; i < len(line); i++ {
		if line[i] == ';' && (line[i-1] == ' ' || line[i-1] == '\t') {
			return strings.TrimRight(line[:i], " \t"), line[i:]
		}
	}
	return strings.TrimRight(line, " \t"), ""
}

func escapeValue(r rune) string {
	switch r {
	case 'n':
		return "\n"
	case 't':
		return "\t"
	case 'r':
		return "\r"
	case 's':
		return " "
	case 'b':
		return "\b"
	case 'a':
		return "\a"
	case 'f':
		return "\f"
	case 'v':
		return "\v"
	}
	// Any other escaped character stands for itself: `` ` `; `: `" ...
	return string(r)
}

func unescape(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '`' && i+1 < len(s) {
			r, size := utf8.DecodeRuneInString(s[i+1:])
			b.WriteString(escapeValue(r))
			i += size
			continue
		}
		b.WriteByte(s[i])
	}
	return b.String()
}

// preview fits text on one line: line breaks become a return symbol.
func preview(text string) string {
	text = strings.ReplaceAll(strings.ReplaceAll(text, "\r\n", "\n"), "\n", " \u21b5 ")
	text = strings.ReplaceAll(text, "\t", " ")
	if utf8.RuneCountInString(text) > maxPreview {
		runes := []rune(text)
		text = string(runes[:maxPreview-1]) + "\u2026"
	}
	return text
}

func lineHash(line string) string {
	sum := sha256.Sum256([]byte(line))
	return hex.EncodeToString(sum[:8])
}

func fileHash(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// sameTrigger compares triggers the way AutoHotkey matches them: exactly if
// either hotstring is case-sensitive, otherwise ignoring case.
func sameTrigger(a string, aCase bool, b string, bCase bool) bool {
	if aCase || bCase {
		return a == b
	}
	return strings.EqualFold(a, b)
}
