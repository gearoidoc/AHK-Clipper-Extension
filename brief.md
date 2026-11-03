# AHK Hotstring Clipper — Chrome Extension Brief

Nov 3, 2026 · @Gearóid

## Overview

Build a Manifest V3 Chrome extension that turns highlighted text on any web page into an AutoHotkey v2 hotstring, written straight into a chosen `.ahk` file and live within a second. A small dialog appears next to the selection to set the trigger, the target file and the hotstring options, with a live preview of the exact line that will be written.

- **User:** one person, on Windows, with AutoHotkey v2 installed and a folder of `.ahk` files.
- **Core loop:** select text → press a shortcut → type a trigger → Enter. Under five seconds, no mouse required.
- **Out of scope for v1:** macOS/Linux, syncing between machines, AutoHotkey v1 syntax, rich-text/HTML capture, editing existing hotstrings (planned for phase 3).

How to use this brief: drop it in the repo as `BRIEF.md`, ask Claude Code to read it, plan in plan mode, and start with phase 0.

## User flow

The whole flow happens on the page; the user never opens a popup or settings to save a hotstring.

1. Select text on any page.
2. Open the dialog with the keyboard shortcut (default `Alt+Shift+H`, via `chrome.commands`) or the context-menu item "Add as AHK hotstring".
3. The dialog opens anchored to the selection, with the replacement text prefilled, a suggested trigger selected, and the last-used file chosen.
4. Type a trigger, optionally change file or options, and watch the preview line update as you type.
5. Press Enter. The extension sends the hotstring to the native host, which checks for duplicates, writes the file and reloads the AutoHotkey script.
6. A small toast confirms: "Saved `;brb` to Work.ahk, reloaded", with an Undo button for 10 seconds.
7. On any failure (duplicate, host missing, write error) the dialog stays open with the message inline, so nothing typed is lost.

## The capture dialog

A single compact card, about 360 px wide, rendered in an extension-origin iframe so the page can't style it, script it or read what you type. It follows the system light/dark theme and closes cleanly without leaving listeners behind.

| Field | Control | Default | Behaviour |
| --- | --- | --- | --- |
| Trigger | Text input, autofocused | Suggested from the text (prefix + initials of the first words, e.g. `;btw`) | Validated live: not empty, max 40 chars, no `::`, no line breaks; warns on spaces |
| Replacement | Textarea | The selection, trimmed, as plain text | Editable; shows line and character count |
| File | Dropdown of `.ahk` files in the configured folder + "New file…" | Last file used | "New file…" asks for a name and creates it with a `#Requires AutoHotkey v2.0` header |
| Options | Toggle chips | From settings | `*` fire immediately · `?` inside words · `C` case-sensitive · `B0` keep the typed trigger · `O` omit ending character |
| Source comment | Checkbox | On | Adds `; from <page title>, <url>, <date>` above the hotstring |
| Preview | Read-only code line | Live | Shows exactly what will be written, including escaping |
| Duplicate notice | Inline banner | Hidden | If the trigger exists in any file: shows file and current text, offers Replace or Rename |

Keyboard: Enter saves (Ctrl+Enter inside the textarea), Esc closes, Tab moves trigger → replacement → file → options → Save. The dialog never steals focus after it closes; focus returns to where it was.

## Architecture

The extension never writes files itself: a small native messaging host on your PC does every disk and AutoHotkey operation, and the extension only talks to it.

&#91;embedded content: architecture · extension, native host, AutoHotkey\]

Why a native host rather than the browser's File System Access API:

- Chrome can't write to arbitrary paths. File System Access needs a folder handle that is awkward to share between the content script and the service worker, and its permission can lapse and re-prompt.
- Only a native process can reload AutoHotkey, scan every file for duplicates, and write atomically with backups.
- The cost is a one-time install: the host `.exe`, its manifest JSON, and one registry key under `HKCU\Software\Google\Chrome\NativeMessagingHosts`, all done by a script.

Messages are JSON over stdio with Chrome's 4-byte length prefix. The host manifest's `allowed_origins` lists only this extension's ID.

## AutoHotkey output rules

All AHK code generation lives in one pure function, `toHotstring(trigger, text, options)`, with a unit-test table of tricky inputs. Escaping is where this tool will fail silently, so it gets tested before any UI work.

**Two output forms.** Pick automatically:

- Simple single-line text → text mode, which sends `{}`, `!`, `#`, `^`, `+` literally:

```autohotkey
; from Example page, https://example.com, 2026-11-03
:T:;brb::be right back
```

- Anything multi-line, or with leading/trailing whitespace → execute mode with a string literal, which has one well-defined escaping scheme:

```autohotkey
:X:;sig::SendText("Best regards,`nJane")
```

**Escaping hazards to cover in tests:**

- Backtick is AHK's escape character and must be doubled.
- A semicolon preceded by a space or tab starts a comment in `:T:` form and must be written as `` `; ``.
- Leading and trailing whitespace is trimmed in `:T:` form, so route those cases to `:X:`.
- In `:X:` string literals: escape `` ` `` and `"`, convert line breaks to `` `n `` and tabs to `` `t ``.
- Triggers: reject `::` and line breaks; escape backtick and semicolon the same way.
- Normalise smart quotes, non-breaking spaces and `\r\n` from the page before generating.

**Writing files (native host):**

- UTF-8, CRLF line endings, append under a `; --- Added by Hotstring Clipper ---` marker.
- Atomic write: write a temp file, then rename over the original. Keep one `.bak` per file, refreshed before each write.
- Only ever write inside the configured AHK folder; reject any path that resolves outside it.
- Each saved entry gets an id comment so Undo can remove exactly that block.

**Reload:** run `AutoHotkey64.exe /restart "<entry script>"`, which replaces the running instance without a prompt. The entry script is either the file just written or a main script that `#Include`s the managed files (setting). Hotstrings only take effect after a reload, so a failed reload is reported as an error, not a success.

**Duplicate detection:** scan every `.ahk` file in the folder for lines matching `^\s*:([^:\r\n]*):(.+?)::` and compare triggers, respecting the `C` option for case.

Claude Code should confirm each rule above against the AutoHotkey v2 documentation for hotstrings, escape sequences and continuation sections, and adjust the tests if any differ.

## Settings page

One plain options page, stored in `chrome.storage.local`, with a "Test connection" button that pings the native host and shows its version and the AutoHotkey path it found.

| Setting | Default | Notes |
| --- | --- | --- |
| AHK folder | None (required on first run) | Root the host may read and write; dropdown lists `.ahk` files here |
| Entry script to reload | The file just written | Or a main script that `#Include`s the others |
| AutoHotkey executable | `C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe` | Host auto-detects; editable |
| Default options | All off | Pre-ticks the option chips in the dialog |
| Trigger prefix | `;` | Used for suggestions; empty allowed |
| Suggest a trigger | On | Off leaves the trigger field blank |
| Source comment | On | Default for the dialog checkbox |
| Keyboard shortcut | `Alt+Shift+H` | Changed at `chrome://extensions/shortcuts`; the page links there |

## Build phases and acceptance criteria

Four phases, each ending in something usable; don't start the next until the current one's checks pass.

**Phase 0: plumbing spike**

- [ ] Unpacked extension with a fixed ID (via the manifest `key`) talks to a native host that echoes a message
- [ ] Host registration script (PowerShell, current user only, no admin) and an uninstall script
- [ ] `toHotstring()` and its escaping tests pass

**Phase 1: MVP**

- [ ] Select text, press the shortcut, type a trigger, Enter → line appended to the chosen file
- [ ] Context-menu entry does the same
- [ ] AutoHotkey reloads and the new hotstring works in Notepad within 2 seconds
- [ ] Settings page with folder, AHK path and Test connection
- [ ] Clear errors when the host isn't installed, the folder is missing or the reload fails

**Phase 2: polish**

- [ ] Trigger suggestion, duplicate detection with Replace/Rename, New file…
- [ ] Undo toast removes exactly the entry just added
- [ ] Option chips, source comment, live preview, dark mode
- [ ] Works on Gmail, Google Docs (selection via clipboard fallback if needed), Notion and a plain static page

**Phase 3: manage (optional)**

- [ ] Options page lists all hotstrings across files with search, edit and delete
- [ ] Import/export as CSV

## Privacy: local only

Nothing the extension or the native host handles may leave this machine. This is a hard requirement with checks, not a convention.

**Enforced by design:**

- No host permissions, and no `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon` anywhere in the code.
- Manifest CSP for extension pages: `script-src 'self'; object-src 'self'; connect-src 'none'`. Claude Code confirms this blocks connections from the service worker and options page.
- All dependencies bundled locally: no CDNs, remote fonts or remote code.
- Settings live in `chrome.storage.local`, never `chrome.storage.sync`, which uploads to your Google account.
- The dialog runs in an extension-origin iframe, so the web page can't read what you type into it. A dialog injected straight into the page's DOM would let page scripts see your keystrokes. Selection text reaches the iframe through extension messaging, not `window.postMessage`.
- The native host contains no networking code. For Go, `go list -deps` must not include `net` or `net/http`.
- No telemetry, crash reporting or update checks. Load unpacked, with no `update_url`, and never publish to the Chrome Web Store.

**Checked before each release:**

- [ ] A check script fails the build if any network API appears in the source
- [ ] DevTools network panel on the service worker and options page shows zero requests during a save
- [ ] Optional: the install script adds an outbound Windows Firewall rule blocking the native host `.exe`

**Outside the extension's control:**

- If your AHK folder sits inside OneDrive, Dropbox or Google Drive, that sync client uploads the files. Use a non-synced folder if that matters.
- The page you highlight on already has the selected text; the extension can't change that.

## Constraints and open decisions

**Constraints for Claude Code:**

- Minimal permissions: `contextMenus`, `nativeMessaging`, `storage`, `activeTab`, `scripting`. Inject the dialog on demand with `activeTab` + `chrome.scripting`; no `<all_urls>` host permission.
- No network access of any kind; see Privacy: local only.
- Plain TypeScript, no UI framework; build with Vite or esbuild into a loadable `dist/` folder.
- Native host accepts a fixed set of message types only (`ping`, `listFiles`, `scan`, `save`, `undo`, `reload`) and validates every field.
- Known limits to document, not solve: `chrome://` pages, the Chrome Web Store, and the built-in PDF viewer block content scripts.

**Open decisions (Claude Code proposes, I confirm):**

| Decision | Recommended | Alternative |
| --- | --- | --- |
| Native host language | Go, compiled to one `.exe` with no runtime | Python + PyInstaller; C# single-file |
| File layout | Many files in one folder, user picks per hotstring | One managed file only (simpler, no dropdown) |
| Reload target | The file just written | A main script with `#Include`s |
| Text in iframes | Top frame only in v1 | `allFrames` injection |
