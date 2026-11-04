// Command ahk-clipper-host is the native messaging host for the AHK Hotstring
// Clipper extension. Chrome starts it and exchanges length-prefixed JSON over
// stdio; it does every disk and AutoHotkey operation for the extension.
//
// It must never import anything that can reach the network:
// scripts/check-no-network.mjs fails the build if `go list -deps` shows one.
package main

import (
	"errors"
	"fmt"
	"io"
	"os"
)

// Set at build time by scripts/build-host.mjs:
// -ldflags "-X main.version=<package.json version> -X main.extensionID=<ID>".
var (
	version     = "dev"
	extensionID = ""
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout))
}

// run serves messages until Chrome closes stdin. One process may get a single
// message (runtime.sendNativeMessage) or many (runtime.connectNative).
func run(args []string, in io.Reader, out io.Writer) int {
	if err := checkOrigin(args); err != nil {
		// Chrome would only report "Native host has exited", so explain first.
		_ = writeMessage(out, errorResponse(codeForbiddenOrigin, err.Error()))
		return 1
	}
	for {
		msg, err := readMessage(in)
		if errors.Is(err, io.EOF) {
			return 0
		}
		if err != nil {
			// The stream can't be resynchronised after a framing error.
			_ = writeMessage(out, errorResponse(codeBadRequest, err.Error()))
			return 1
		}
		if err := writeMessage(out, handle(msg)); err != nil {
			return 1
		}
	}
}

// checkOrigin confirms Chrome started us for our own extension. Chrome passes
// the caller's origin as the first argument (and on Windows a
// --parent-window=<handle> argument after it). The host manifest's
// allowed_origins already restricts this; checking again costs nothing.
func checkOrigin(args []string) error {
	if extensionID == "" {
		return errors.New("this host was built without an extension ID; build it with scripts/build-host.mjs")
	}
	want := "chrome-extension://" + extensionID + "/"
	if len(args) == 0 || args[0] != want {
		got := "(none)"
		if len(args) > 0 {
			got = args[0]
		}
		return fmt.Errorf("caller origin %s is not %s", got, want)
	}
	return nil
}
