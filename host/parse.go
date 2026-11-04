package main

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode/utf8"
)

var (
	idComment = regexp.MustCompile(`;[ \t]*hsc:([a-z2-9]{6})[ \t]*$`)
	// Options the extension can show and write back: * ? C B0 O plus T or X.
	editableOptions = regexp.MustCompile(`^(?:\*0?|\?0?|[Cc]0?|[Bb]0?|[Oo]0?|[Tt]|[Xx])*$`)
)

// parsedHotstring is one hotstring definition found in a script, read the way
// AutoHotkey v2 reads it.
type parsedHotstring struct {
	// 1-based line number.
	Line          int
	Trigger       string
	CaseSensitive bool
	Instant       bool
	// The options between the first two colons, as written.
	Options string
	// What it types, decoded; for a hotstring that runs code, the code as written.
	Text string
	Code bool
	// Its code is on the lines below the hotstring line, which a one-line
	// edit or delete would leave behind.
	Multiline bool
	// Whether the extension can show it in its editor and write it back
	// without changing what it does.
	Editable bool
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

	textMode := strings.ContainsAny(strings.ReplaceAll(strings.ReplaceAll(options, "T0", ""), "t0", ""), "Tt")
	switch {
	case body == "":
		// The hotstring's code follows on the next lines.
		h.Code, h.Multiline = true, true
	case execute:
		if m := sendTextBody.FindStringSubmatch(body); m != nil {
			h.Text = unescape(m[1])
		} else {
			h.Code, h.Text = true, body
		}
	default:
		h.Text = unescape(body)
	}
	h.Options = options
	// Plain auto-replace (no T) sends {Enter}, ^c and the like as keys, which
	// :T: would type literally, so only text without them can be rewritten.
	h.Editable = !h.Code && editableOptions.MatchString(options) &&
		(textMode || execute || !strings.ContainsAny(h.Text, "{}^!+#"))
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
