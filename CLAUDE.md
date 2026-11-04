# AHK Hotstring Clipper

Read `BRIEF.md` first: it is the spec, including the build phases and their acceptance criteria. `README.md` records the AutoHotkey rules as verified against the AHK v2 source, which supersede the brief where they differ.

- `npm run verify` is the gate for each phase: typecheck, node:test + `go test`, build, network check, e2e in Chrome for Testing.
- Local only is a hard rule: no network APIs in `extension/`, no `net` packages in `host/`. `npm run check:network` enforces it, so don't weaken the check to get past it.
- All AutoHotkey code generation stays in `extension/src/hotstring.ts`; every rule change needs a test in `extension/test/hotstring.test.ts`.
- The host's message types and error codes live in `host/handlers.go` and are mirrored in `extension/src/protocol.ts`; change both together.
- Write invisible or special Unicode characters in code as `\uXXXX` escapes, never literally.
- Development happens on Linux; the target is Windows. The PowerShell installer can't be run here, so check it by reading it carefully.
