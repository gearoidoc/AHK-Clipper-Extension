package main

import (
	"bytes"
	"encoding/binary"
	"encoding/json/v2"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"
)

const testID = "alniempejkicbflhamllogohohmamfnl"

var testOrigin = []string{"chrome-extension://" + testID + "/", "--parent-window=0"}

func init() { extensionID = testID }

func frame(body string) []byte {
	return append(binary.LittleEndian.AppendUint32(nil, uint32(len(body))), body...)
}

// replies splits a host's stdout into its decoded JSON messages.
func replies(t *testing.T, out []byte) []map[string]any {
	t.Helper()
	r := bytes.NewReader(out)
	var all []map[string]any
	for {
		body, err := readMessage(r)
		if errors.Is(err, io.EOF) {
			return all
		}
		if err != nil {
			t.Fatalf("reading reply: %v", err)
		}
		var m map[string]any
		if err := json.Unmarshal(body, &m); err != nil {
			t.Fatalf("reply is not JSON: %q", body)
		}
		all = append(all, m)
	}
}

func errorCode(m map[string]any) string {
	if e, ok := m["error"].(map[string]any); ok {
		code, _ := e["code"].(string)
		return code
	}
	return ""
}

func TestFramingRoundTrip(t *testing.T) {
	var buf bytes.Buffer
	if err := writeMessage(&buf, map[string]string{"hello": "wörld"}); err != nil {
		t.Fatal(err)
	}
	if got := binary.LittleEndian.Uint32(buf.Bytes()[:4]); int(got) != buf.Len()-4 {
		t.Fatalf("length prefix %d, body %d bytes", got, buf.Len()-4)
	}
	body, err := readMessage(&buf)
	if err != nil || string(body) != `{"hello":"wörld"}` {
		t.Fatalf("got %q, %v", body, err)
	}
	if _, err := readMessage(&buf); !errors.Is(err, io.EOF) {
		t.Fatalf("expected io.EOF after the last message, got %v", err)
	}
}

func TestReadMessageRejectsBadFrames(t *testing.T) {
	cases := map[string][]byte{
		"truncated prefix": {1, 0},
		"truncated body":   frame(`{"type":"ping"}`)[:10],
		"oversized":        binary.LittleEndian.AppendUint32(nil, maxInbound+1),
	}
	for name, input := range cases {
		t.Run(name, func(t *testing.T) {
			_, err := readMessage(bytes.NewReader(input))
			if err == nil || errors.Is(err, io.EOF) {
				t.Fatalf("expected a framing error, got %v", err)
			}
		})
	}
}

func TestWriteMessageReplacesOversizedReplies(t *testing.T) {
	var buf bytes.Buffer
	if err := writeMessage(&buf, map[string]string{"big": strings.Repeat("x", maxOutbound)}); err != nil {
		t.Fatal(err)
	}
	if got := errorCode(replies(t, buf.Bytes())[0]); got != codeTooLarge {
		t.Fatalf("expected %s, got %q", codeTooLarge, got)
	}
}

func TestRunServesMessagesUntilEOF(t *testing.T) {
	in := bytes.NewReader(append(frame(`{"type":"ping","echo":"one"}`), frame(`{"type":"ping","echo":"two"}`)...))
	var out bytes.Buffer
	if code := run(testOrigin, in, &out); code != 0 {
		t.Fatalf("exit code %d", code)
	}
	got := replies(t, out.Bytes())
	if len(got) != 2 || got[0]["echo"] != "one" || got[1]["echo"] != "two" {
		t.Fatalf("replies: %v", got)
	}
	if got[0]["ok"] != true || got[0]["version"] != version {
		t.Fatalf("ping reply: %v", got[0])
	}
}

func TestRunRejectsOtherOrigins(t *testing.T) {
	cases := map[string][]string{
		"no arguments":    nil,
		"other extension": {"chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"},
		"missing slash":   {"chrome-extension://" + testID},
	}
	for name, args := range cases {
		t.Run(name, func(t *testing.T) {
			var out bytes.Buffer
			if code := run(args, bytes.NewReader(frame(`{"type":"ping"}`)), &out); code != 1 {
				t.Fatalf("exit code %d", code)
			}
			if got := errorCode(replies(t, out.Bytes())[0]); got != codeForbiddenOrigin {
				t.Fatalf("expected %s, got %q", codeForbiddenOrigin, got)
			}
		})
	}
}

func TestRunRefusesWithoutBuiltInID(t *testing.T) {
	extensionID = ""
	defer func() { extensionID = testID }()
	var out bytes.Buffer
	if code := run(testOrigin, bytes.NewReader(nil), &out); code != 1 {
		t.Fatalf("exit code %d", code)
	}
}

func TestRunStopsAfterAFramingError(t *testing.T) {
	var out bytes.Buffer
	if code := run(testOrigin, bytes.NewReader([]byte{9, 0}), &out); code != 1 {
		t.Fatalf("exit code %d", code)
	}
	if got := errorCode(replies(t, out.Bytes())[0]); got != codeBadRequest {
		t.Fatalf("expected %s, got %q", codeBadRequest, got)
	}
}

func TestHandleValidatesRequests(t *testing.T) {
	cases := []struct{ name, request, code string }{
		{"ping", `{"type":"ping","echo":"hi"}`, ""},
		{"ping without echo", `{"type":"ping"}`, ""},
		{"not JSON", `ping`, codeBadRequest},
		{"not an object", `["ping"]`, codeBadRequest},
		{"type is not a string", `{"type":1}`, codeBadRequest},
		{"missing type", `{"echo":"hi"}`, codeUnknownType},
		{"unknown type", `{"type":"exec"}`, codeUnknownType},
		{"type differs in case", `{"type":"Ping"}`, codeUnknownType},
		{"unknown field", `{"type":"ping","path":"C:\\x"}`, codeBadRequest},
		{"field differs in case", `{"type":"ping","Echo":"hi"}`, codeBadRequest},
		{"duplicate field", `{"type":"ping","echo":"a","echo":"b"}`, codeBadRequest},
		{"echo is not a string", `{"type":"ping","echo":5}`, codeBadRequest},
		{"echo too long", `{"type":"ping","echo":"` + strings.Repeat("x", maxEcho+1) + `"}`, codeBadRequest},
		{"invalid UTF-8", "{\"type\":\"ping\",\"echo\":\"\xff\"}", codeBadRequest},
		{"trailing data", `{"type":"ping"} {}`, codeBadRequest},
		{"listFiles needs a folder", `{"type":"listFiles"}`, codeFolderMissing},
		{"save needs a hotstring line", `{"type":"save"}`, codeBadLine},
		{"scan not yet", `{"type":"scan"}`, codeNotImplemented},
		{"undo not yet", `{"type":"undo"}`, codeNotImplemented},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var buf bytes.Buffer
			if err := writeMessage(&buf, handle([]byte(c.request))); err != nil {
				t.Fatal(err)
			}
			reply := replies(t, buf.Bytes())[0]
			if got := errorCode(reply); got != c.code {
				t.Fatalf("expected code %q, got %q (%v)", c.code, got, reply)
			}
			if (c.code == "") != (reply["ok"] == true) {
				t.Fatalf("ok is %v for code %q", reply["ok"], c.code)
			}
		})
	}
}

func TestAhkCandidates(t *testing.T) {
	env := map[string]string{`ProgramFiles`: `/pf`, `LOCALAPPDATA`: `/la`}
	got := ahkCandidates(func(k string) string { return env[k] })
	want := []string{
		filepath.Join("/pf", "AutoHotkey", "v2", "AutoHotkey64.exe"),
		filepath.Join("/la", "Programs", "AutoHotkey", "v2", "AutoHotkey64.exe"),
	}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v, want %v", got, want)
	}
	if got := ahkCandidates(func(string) string { return "" }); len(got) != 0 {
		t.Fatalf("expected no candidates without environment, got %v", got)
	}
}
