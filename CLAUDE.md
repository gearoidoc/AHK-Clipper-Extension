# AHK Hotstring Clipper

Read `BRIEF.md` first: it is the spec, including the build phases and their acceptance criteria. `README.md` records the AutoHotkey rules as verified against the AHK v2 source, which supersede the brief where they differ.

- `npm run verify` is the gate for each phase: typecheck, node:test + `go test`, both builds, network check, e2e in Chrome for Testing. The e2e build (`.e2e/dist`, `__E2E__`) only adds a test hook and local host permissions; production `dist/` must never contain either.
- Local only is a hard rule: no network APIs in `extension/`, no `net` packages in `host/`. `npm run check:network` enforces it, so don't weaken the check to get past it.
- All AutoHotkey code generation stays in `extension/src/hotstring.ts`; the host only accepts lines in that exact shape (`host/hotstring.go`). A rule change updates both, plus the shared fixture `host/testdata/hotstrings.json`.
- The host's message types (`host/handlers.go`) and error codes (`host/errors.go`) are mirrored in `extension/src/protocol.ts`; change both sides together.
- Write invisible or special Unicode characters in code as `\uXXXX` escapes, never literally.
- Development happens on Linux; the target is Windows. The PowerShell installer can't be run here, so check it by reading it carefully.
