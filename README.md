# AHK Hotstring Clipper

A Chrome extension that turns highlighted text into an AutoHotkey v2 hotstring, written into one of your `.ahk` files by a small native host on your PC. Local only: nothing leaves the machine. [BRIEF.md](BRIEF.md) has the full design.

**Status: Phase 0 (plumbing spike).** The extension, the native host and `toHotstring()` exist. Test connection works end to end. Saving hotstrings arrives in Phase 1.

## Layout

| Path | What |
| --- | --- |
| `extension/` | The MV3 extension: `manifest.json`, TypeScript sources in `src/`, tests in `test/` |
| `extension/src/hotstring.ts` | All AutoHotkey code generation: `toHotstring()`, `normalizeText()`, `validateTrigger()`, `sourceComment()` |
| `host/` | The native host in Go, standard library only |
| `installer/` | `install.ps1` / `uninstall.ps1` for Windows |
| `scripts/` | Build, release, network check and e2e scripts |
| `dist/` | Built, loadable extension (generated) |
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

To remove it, run `uninstall.ps1` the same way, then remove the extension in `chrome://extensions`. Your `.ahk` files are never touched by uninstalling.

### Test connection messages

| Message | Meaning |
| --- | --- |
| The native host isn't installed | Chrome found no registry entry for `com.gearoid.ahk_clipper`. Run `install.ps1`. |
| Registered for a different extension ID | The host manifest's `allowed_origins` doesn't list this extension. Run `install.ps1` again. |
| The native host stopped before it replied | The exe crashed or was blocked; see Known limits for Smart App Control. |
| `forbidden_origin` | The host was built for a different extension ID than the one calling it. |

## Develop

Requirements: Node 24+, Go 1.27+, and for `npm run e2e` Chrome for Testing:

```sh
npm ci
npx @puppeteer/browsers install chrome@stable --path ~/.cache/chrome-for-testing
```

| Command | Does |
| --- | --- |
| `npm run build` | Bundles the extension into `dist/` with esbuild |
| `npm run build:host` | Builds `host/bin/ahk-clipper-host.exe` (Windows) and `host/bin/ahk-clipper-host` (Linux, for e2e) |
| `npm test` | `toHotstring()` tests (node:test) and host tests (`go test`) |
| `npm run typecheck` | `tsc` over the extension and the tests |
| `npm run check:network` | Fails on any network API, remote URL, loosened manifest or Go `net` dependency |
| `npm run e2e` | Loads `dist/` in Chrome for Testing with the Linux host and checks the round trip, the fixed ID, the error messages and that the CSP blocks every network API |
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

Not handled, by design:
- `:X:` hotstrings don't adjust case the way auto-replace does (typing `;BRB` with `C` off won't give `BE RIGHT BACK`).
- A `#Hotstring` directive earlier in a file changes the defaults of the lines below it, including these ones.
- Continuation sections are never used, so their trimming and `)` rules don't apply.

## Privacy: local only

Enforced in code and checked by `npm run check:network` and `npm run e2e`:

- The extension has no host permissions and uses no network API.
- Settings will live in `chrome.storage.local`; `storage.sync` is rejected by the check.
- The CSP for extension pages and the service worker is `default-src 'self'; script-src 'self'; object-src 'self'; connect-src 'none'; form-action 'none'; base-uri 'none'`. The brief asked for `connect-src 'none'`; `default-src 'self'` is added because `connect-src` doesn't cover images, stylesheets, fonts or frames. The e2e test shows the CSP blocks `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, `import()`, images, stylesheets and iframes from both the service worker and the options page. A local server records zero requests, while the same probes from an ordinary page all reach it.
- The host imports nothing from `net`, `net/*` or `crypto/tls` (`go list -deps`, Windows and Linux builds). It checks that Chrome started it for this extension's ID, and it accepts only a fixed set of message types, decoded strictly.
- There is no telemetry and no update URL, and the extension is never published.

Outside the extension's control: if your AHK folder is inside OneDrive, Dropbox or Google Drive, that sync client uploads the files.

## Known limits

- Content scripts can't run on `chrome://` pages, the Chrome Web Store or the built-in PDF viewer.
- The host exe is unsigned. Windows 11 Smart App Control, if it's on, may refuse to run it. That shows up as "The native host stopped before it replied".
- Only Google Chrome is registered (not Edge, Brave or Chromium).
