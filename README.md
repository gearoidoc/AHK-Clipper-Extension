# AHK Hotstring Clipper

A Chrome extension that turns highlighted text into an AutoHotkey v2 hotstring, written into one of your `.ahk` files by a small native host on your PC. Local only: nothing leaves the machine. [BRIEF.md](BRIEF.md) has the full design.

**Status: Phase 1 (MVP).** Select text, press `Alt+Shift+H` (or right-click → *Add as AHK hotstring*), type a trigger, press Enter: the hotstring is written to your chosen file and AutoHotkey reloads. Trigger suggestions, duplicate detection, Undo, option chips and the live preview arrive in Phase 2.

## Layout

| Path | What |
| --- | --- |
| `extension/` | The MV3 extension: `manifest.json`, TypeScript sources in `src/`, tests in `test/` |
| `extension/src/hotstring.ts` | All AutoHotkey code generation: `toHotstring()`, `normalizeText()`, `validateTrigger()`, `sourceComment()` |
| `extension/src/background.ts` | Service worker: shortcut, context menu, and the only part that talks to the host |
| `extension/src/content/dialog-host.ts` | Content script that places the dialog iframe and gives focus back to the page |
| `extension/src/dialog/` | The capture dialog, an extension page shown in that iframe |
| `host/` | The native host in Go, standard library only |
| `host/testdata/hotstrings.json` | Expected lines, shared by the TypeScript and Go tests |
| `installer/` | `install.ps1` / `uninstall.ps1` for Windows |
| `scripts/` | Build, release, network check and e2e scripts |
| `dist/` | Built, loadable extension (generated) |
| `.e2e/dist/` | Test build with an e2e hook and local host permissions (generated, never shipped) |
| `release/` | Release zip for the Windows PC (generated) |

## Install on Windows

You need Chrome and AutoHotkey v2. No admin rights are needed.

1. Unzip `ahk-hotstring-clipper-<version>.zip` (from `npm run release`) somewhere permanent, e.g. `C:\Tools\ahk-hotstring-clipper`. Chrome loads the extension from that folder, so keep it there.
2. In that folder, run:
   ```powershell
   powershell -ExecutionPolicy Bypass -File .\install.ps1
   ```
   Run it from an open PowerShell window, not with right-click → Run with PowerShell, which closes before you can read any error. It should finish by printing "Installed the native host for extension …". It copies the host to `%LOCALAPPDATA%\AHK Hotstring Clipper\`, writes its manifest there and registers it under `HKCU\Software\Google\Chrome\NativeMessagingHosts\com.gearoid.ahk_clipper`. Add `-BlockNetwork` in an administrator PowerShell to also block the host's outbound traffic in Windows Firewall.
3. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the `extension` folder. The ID shown must equal `extension-id.txt` (`alniempejkicbflhamllogohohmamfnl`).
4. Open the extension's **Options** page and click **Test connection**. It should show the host version, "Echo matched" and the path to `AutoHotkey64.exe`.

To update, unzip the new release over the old folder, run `install.ps1` again and click the reload icon on the extension in `chrome://extensions`.

To remove it, run `uninstall.ps1` the same way, then remove the extension in `chrome://extensions`. Your `.ahk` files are never touched by uninstalling.

### Work laptops

On a managed PC, ask IT to approve these together:
1. AutoHotkey v2 itself.
2. The unsigned host `ahk-clipper-host.exe` in `%LOCALAPPDATA%\AHK Hotstring Clipper\`.
3. Loading an unpacked extension. Developer mode can be blocked by the `ExtensionDeveloperModeSettings` policy.
4. Per-user native messaging hosts. The `NativeMessagingUserLevelHosts` policy can turn them off.

### Test connection messages

| Message | Meaning |
| --- | --- |
| The native host isn't installed | Chrome found no registry entry for `com.gearoid.ahk_clipper`. Run `install.ps1`. |
| Registered for a different extension ID | The host manifest's `allowed_origins` doesn't list this extension. Run `install.ps1` again. |
| The native host stopped before it replied | The exe crashed or was blocked; see Known limits for Smart App Control. |
| `forbidden_origin` | The host was built for a different extension ID than the one calling it. |

## Use it

**First run.** Settings opens when the extension is installed.
1. Enter the full path of your hotstring folder, for example `C:\Users\you\Documents\Hotstrings`, and press Tab.
2. For an empty folder, click **Set up this folder**. It creates `Main.ahk` and `General.ahk`.
3. Double-click `Main.ahk` to start it. That's the one script anyone runs.
4. Optionally, set the path to `AutoHotkey64.exe` (it's found automatically otherwise) and click **Test connection**.

**Adding a hotstring.**
1. Select text on any page.
2. Press `Alt+Shift+H`, or right-click → **Add as AHK hotstring**.
3. Type a trigger such as `;brb`. Change the file if you like.
4. Press **Enter** (Ctrl+Enter inside the replacement box). **Esc** closes the dialog without saving.

The dialog says "Saved `;brb` to General.ahk, reloaded" and focus goes back where you were. If anything fails, the dialog stays open with the message and everything you typed. The shortcut can be changed from Settings.

### Recommended layout for a shared collection

```
Hotstrings\
  Main.ahk          the only script anyone runs: #Includes every category
  General.ahk
  Email.ahk
  Support-Replies.ahk
```

- **One file per category,** so a teammate can find things by name rather than scrolling through hundreds of lines. Each hotstring is a single line.
- **Adding categories:** create a new `.ahk` file in the folder (Phase 2 adds *New file…* to the dialog) and pick it in the dialog. The first save adds its `#Include` line to `Main.ahk`.
- **Dropping a category:** put a `;` in front of its `#Include` line.
- **Teammates don't need the extension,** only AutoHotkey v2 and a copy of the folder (from a shared drive or a git repository). The extension is the curator's tool.

Each saved line ends with a short id comment, `:T:;brb::be right back ; hsc:k3j9x2`, which Phase 2's Undo uses to find exactly that entry. AutoHotkey ignores it.

## Develop

Requirements: Node 24+, Go 1.27+, and for `npm run e2e` Chrome for Testing:

```sh
npm ci
npx @puppeteer/browsers install chrome@stable --path ~/.cache/chrome-for-testing
```

| Command | Does |
| --- | --- |
| `npm run build` | Bundles the extension into `dist/` with esbuild |
| `npm run build:e2e` | The test variant in `.e2e/dist/` |
| `npm run build:host` | Builds `host/bin/ahk-clipper-host.exe` (Windows) and `host/bin/ahk-clipper-host` (Linux, for e2e) |
| `npm test` | Extension tests (node:test) and host tests (`go test`) |
| `npm run typecheck` | `tsc` over the extension and the tests |
| `npm run check:network` | Fails on any network API, remote URL, loosened manifest or Go `net` dependency |
| `npm run e2e` | Chrome for Testing with the Linux host. On `dist/`: the fixed ID, Test connection and its errors, and that the CSP blocks every network API. On `.e2e/dist/`, with a fake `AutoHotkey64.exe`: folder setup, then the dialog end to end (placement, focus, save, validation failure, new categories, missing folder, a strict-CSP page, no page access to the dialog) |
| `npm run verify` | All of the above; the gate for each phase |
| `npm run release` | Builds and packages `release/ahk-hotstring-clipper-<version>.zip` |

The extension ID comes from the public key in `extension/manifest.json` (`node scripts/extension-id.mjs` prints it). The private key was never kept: unpacked extensions don't need it, and the extension is never published.

## AutoHotkey output rules

`toHotstring(trigger, text, options)` produces one line. Every rule was checked against the AutoHotkey v2 docs and the v2.0 source (`script.cpp`, `hook.cpp`, `hotkey.cpp`, `keyboard_mouse.cpp`). The tests in `extension/test/hotstring.test.ts` pin each rule. They also decode 2,000 random tricky lines with a model of AutoHotkey's own line parser.

- **Two forms.** Single-line text with no leading or trailing whitespace and no tabs uses text mode: `:T:;brb::be right back`. Everything else becomes a string literal in execute mode: ``:X:;sig::SendText("Best regards,`nJane" A_EndChar)``.
- **`A_EndChar` in execute mode.** An `:X:` hotstring backspaces the trigger but never re-types the ending character (Space, Enter, ...) that fired it, unlike `:T:`. So the line appends `A_EndChar`, except with `O` (meant to drop it), `B0` (it stays where you typed it) or `*` (there is none).
- **Escaping.** Backticks are doubled everywhere. A `;` with a space or tab on its left becomes `` `; ``, because it would otherwise start a comment. In triggers every `:` becomes `` `: ``: v2 ends the trigger at the first unescaped `::`, so a trailing colon would cut it short. In `:X:` literals `"` becomes `` `" ``, line breaks become `` `n `` and tabs become `` `t ``.
- **Limits.** Triggers can be at most 40 characters (AutoHotkey's limit). Replacements are capped at 4,800 characters, because SendInput silently drops keystrokes past about 5,000. That also keeps each line under AutoHotkey's 16,384-character line limit.
- **Triggers** can't be empty or contain `::`, line breaks, tabs or other control characters. A space only gets a warning: Space is an ending character, so a shorter hotstring may fire first.
- **Text from pages** is normalised first. Line endings become `\n`, smart quotes become `'` and `"`, and non-breaking spaces become spaces. Zero-width spaces, word joiners, BOMs, soft hyphens and control characters are removed. Zero-width joiners stay, because emoji need them.
- **A lone `{`** is safe in `:T:`: text and raw mode turn off the one-true-brace parsing that would otherwise treat it as a function body.

### Saving

The host does every disk and AutoHotkey operation in one transaction. It either fully succeeds or leaves every file byte-for-byte as it was.

1. **Checks.** Only a plain `.ahk` name directly inside the configured folder is accepted; symlinks and junctions that lead out of it are refused. The line must match exactly the two shapes above, so no other AutoHotkey code can reach a file.
2. **Writing.** Under a short-lived lock file, the line is appended after a `; --- Added by Hotstring Clipper ---` marker, in UTF-8 with CRLF (a BOM is kept if the file had one; UTF-16 and ANSI files are refused). The `#Include` is added to `Main.ahk` if that's needed. Each file is written to a temporary file and renamed over the original, after refreshing `<name>.bak`.
3. **Validation.** `AutoHotkey64.exe /ErrorStdOut=UTF-8 /Validate Main.ahk` loads the whole script without running it. It exits before AutoHotkey's single-instance check, so the running script isn't disturbed. If it fails, the original files are restored and AutoHotkey's message is shown.
4. **Restart.** `AutoHotkey64.exe /ErrorStdOut=UTF-8 /restart Main.ahk` is started detached. It replaces the running copy once it has loaded, and it keeps running after Chrome closes. If it exits with an error within 750 ms, the files are restored.
5. **`#Hotstring X`.** A file whose `#Hotstring` directives turn on `X` is refused, because they would make plain-text lines run as code.

Not handled, by design:
- `:X:` hotstrings don't adjust case the way auto-replace does (typing `;BRB` with `C` off won't give `BE RIGHT BACK`).
- A `#Hotstring` directive earlier in a file changes the defaults of the lines below it, including these ones.
- Continuation sections are never used, so their trimming and `)` rules don't apply.

## Privacy: local only

Enforced in code and checked by `npm run check:network` and `npm run e2e`:

- The extension has no host permissions and uses no network API. It runs a script in a page only when you press the shortcut or use the context menu there (`activeTab`).
- **The dialog is an extension page in an iframe,** so the page can neither read what you type nor style the dialog. Its URL changes every session (`use_dynamic_url`), so sites can't probe whether the extension is installed.
- **The selected text** travels through extension messaging and in-memory `chrome.storage.session`, never `window.postMessage`. The e2e test checks the page sees no messages.
- **Settings** live in `chrome.storage.local`; the sync storage area is rejected by the check.
- The CSP for extension pages and the service worker is `default-src 'self'; script-src 'self'; object-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'`. The brief asked for `connect-src 'none'`; `default-src 'self'` is added because `connect-src` doesn't cover images, stylesheets, fonts or frames. The e2e test shows the CSP blocks `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, `import()`, images, stylesheets and iframes from both the service worker and the options page. A local server records zero requests, while the same probes from an ordinary page all reach it.
- The host imports nothing from `net`, `net/*` or `crypto/tls` (`go list -deps`, Windows and Linux builds). It checks that Chrome started it for this extension's ID, and it accepts only a fixed set of message types, decoded strictly.
- There is no telemetry and no update URL, and the extension is never published.

Outside the extension's control: if your AHK folder is inside OneDrive, Dropbox or Google Drive, that sync client uploads the files.

## Known limits

- Content scripts can't run on `chrome://` pages, the Chrome Web Store or the built-in PDF viewer, so the shortcut does nothing there.
- Only the top frame is captured. Text selected inside an iframe still works through the context menu, which passes the selection along.
- **Reloading finds the running script by its window title,** which includes the AutoHotkey version. Start `Main.ahk` with the same AutoHotkey the extension uses, or you get a second copy and hotstrings fire twice.
- The host exe is unsigned. Windows 11 Smart App Control, if it's on, may refuse to run it. That shows up as "The native host stopped before it replied".
- Only Google Chrome is registered (not Edge, Brave or Chromium).
