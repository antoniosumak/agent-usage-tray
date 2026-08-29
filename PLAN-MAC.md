# Agent Usage — macOS Port Plan

Goal: ship an unsigned macOS build (arm64 + x64) with the same popup, quota/cost pipelines and
a menu bar item that mirrors the Windows taskbar widget (two rows: 5h / 7d bar + % + reset).
Windows behavior must not change.

Decisions (from discussion 2026-08-29):

| Decision | Answer |
|---|---|
| Signing | None. Unsigned zip + dmg on GitHub Releases. README: "Open Anyway" instructions. Revisit $99 Apple Developer if adoption warrants. |
| Auto-update | Disabled on darwin (Squirrel.Mac refuses unsigned updates). Show "new version available" link to the release page instead. |
| Taskbar widget | Not ported. `widget.ts` stays Windows-only. Menu bar item carries the same content as a single wide image. |
| Menu bar item | Glyph + two rows (`5h ▓▓▓░░ 42% 2h` / `7d ▓░░░░ 18% 4d`), colored thresholds. Rendered offscreen from `widget.html`. |
| Popup | Unchanged. Only anchored below the menu bar instead of above the taskbar. |
| Fallback | If offscreen rendering misbehaves, draw the two rows with the existing `drawText` pixel font into a Buffer (same path as `createBarsIcon`). |

## Platform surface today

| File | Windows-only thing | Mac action |
|---|---|---|
| `src/main/widget.ts` | PowerShell + Win32 (SetParent, WH_MOUSE_LL, registry watch) | never imported on darwin |
| `src/main/tray.ts:123` `isPinned` | `reg query` | darwin: skip, always render full item |
| `src/main/tray.ts` `popupPosition` | anchors above bottom taskbar | darwin: anchor below tray bounds |
| `src/main/main.ts:20` | `setAppUserModelId` | harmless no-op, keep |
| `src/main/main.ts:32` `skipTaskbar` | ignored on Mac | add `app.dock.hide()` |
| `src/main/cost.ts:66` | `where.exe` | `which` on non-win32 |
| `src/main/cost.ts:82` | `shell: true` joined command | works on Mac, keep |
| `src/main/quota.ts:46` `readToken` | `~/.claude/.credentials.json` | Mac Claude Code stores token in **Keychain**; read via `security` CLI |
| `src/main/quota.ts:237` | UA `(Windows 11)` | platform-aware string |
| `src/main/settings.ts:93` `applyLoginItem` | `PORTABLE_EXECUTABLE_FILE` path | only set `path` on win32 |
| `src/main/updates.ts` | electron-updater | darwin: poll GitHub releases API, no download |
| `package.json` `build` | `win`/`nsis`, `.ico` | add `mac` target, `.icns` |
| `.github/workflows/release.yml` | `windows-latest` only | matrix: add `macos-latest` job |

## Phases

### 1. Build target + CI (no runtime changes)

- `package.json` `build.mac`: `{ target: [{ target: "zip", arch: ["arm64","x64"] }, { target: "dmg", arch: ["arm64","x64"] }], icon: "build/icon.icns", category: "public.app-category.developer-tools", identity: null }` — `identity: null` = skip signing explicitly (electron-builder otherwise ad-hoc signs, which is fine too, but explicit is quieter in CI logs).
- Generate `build/icon.icns` in `scripts/gen-icon.js` (electron-builder also accepts a 1024×1024 `icon.png` and converts — simplest: emit `build/icon.png`, set `mac.icon` to it).
- Add `"dist:mac": "npm run build && electron-builder --mac"`.
- `release.yml`: convert to matrix `[windows-latest, macos-latest]`, each runs `electron-builder --<os> --publish always`. Keep the draft→live flip in a final job that `needs` both.
- Verify: `npx electron-builder --mac --dir` on a Mac (or CI) produces `release/mac-arm64/Agent Usage.app`.

### 2. Boot on Mac without crashing (guards)

`src/main/main.ts`:
```ts
const isMac = process.platform === "darwin";
if (isMac) app.dock.hide();
const widget = isMac ? null : createWidget();
// every `widget.` use becomes `widget?.`; watchWidgetClicks only when widget
```
Import `./widget` stays (module has no top-level side effects), so no dynamic import needed.

`src/main/cost.ts` `commandExists`: `spawn(process.platform === "win32" ? "where.exe" : "which", [cmd])`.

`src/main/settings.ts` `applyLoginItem`: guard `path` with `process.platform === "win32"`.

`src/main/quota.ts` Codex UA: `process.platform === "darwin" ? "(Mac OS)" : "(Windows 11)"`.

### 3. Claude token from Keychain

Claude Code on macOS writes the OAuth blob to Keychain service `"Claude Code-credentials"`
(account = current user), same JSON shape as `.credentials.json`. `readToken`:

```ts
if (process.platform === "darwin") {
  // security exits 44 when the item is missing; treat any failure as no-token
  const raw = await execFileP("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  json = JSON.parse(raw.stdout);
}
```
Still honor `CLAUDE_CONFIG_DIR/.credentials.json` first (users who opted out of Keychain).
First run triggers one macOS Keychain prompt — click "Always Allow". Note in README.

Codex: `~/.codex/auth.json` exists on Mac too. No change.

### 4. Menu bar item

`src/main/tray.ts`, darwin branch:

- `createTray`: on darwin create an offscreen renderer once:
  ```ts
  const off = new BrowserWindow({ show: false, width: 104, height: 22, transparent: true, frame: false,
    webPreferences: { offscreen: true, preload } });
  off.loadFile("widget.html");
  off.webContents.setFrameRate(2);
  off.webContents.on("paint", (_e, _dirty, image) => tray.setImage(image));
  ```
  `paint` fires only when content changes, so `setFrameRate` is a cap, not a poll.
  Return `off` so `push()` in main.ts can `off.webContents.send("state", snapshot)` — reuse the
  existing `widget.webContents.send` slot: on darwin `widget` *is* the offscreen window, just never shown.
  Net effect in main.ts: `const widget = isMac ? createMenuBarRenderer(tray) : createWidget();`
- `updateTray`: on darwin skip `isPinned`/`setImage` (image comes from `paint`), keep `setToolTip`.
- `popupPosition`: `const below = process.platform === "darwin"; y = below ? trayBounds.y + trayBounds.height + 4 : wa.y + wa.height - height - 8;`
- Retina: `paint` delivers a `NativeImage` at the window's device scale factor already; verify it reports `scaleFactor 2` on Retina (else `nativeImage.createFromBitmap(image.toBitmap(), {width, height, scaleFactor: 2})`).

`src/renderer/widget.html`:
- Transparent surface on darwin: `#root { background: transparent; border: 0; padding: 0 }` under `@media` — simplest: main sends `platform` in the state snapshot; `widget.ts` toggles `body.classList.add("mac")`.
- Ink follows menu bar: `.mac { color: light-dark(#101012, #f5f5f7) }`, track `light-dark(rgba(0,0,0,.16), rgba(255,255,255,.22))`. Electron's `nativeTheme` drives `prefers-color-scheme` in the renderer, so `light-dark()` works.
- Font `8.5px -apple-system`. Row height 9px, gap 2px, total 22px.

Right-click → `tray.setContextMenu` already has Quit. Left-click → existing `tray.on("click")`.

### 5. Updates on darwin

`src/main/updates.ts`: `if (process.platform === "darwin") return startReleasePoll(onUpdate)` — fetch
`https://api.github.com/repos/antoniosumak/agent-usage-tray/releases/latest` every 24h, compare
`tag_name` to `app.getVersion()`, emit `{ version, status: "available" }`. `installUpdate` on darwin
opens the release URL via `shell.openExternal`. Renderer: `status: "available"` renders the same
banner with "Download" instead of "Install".

### 6. Docs

- README: macOS section — Gatekeeper "Open Anyway" (System Settings → Privacy & Security), Keychain prompt, no auto-update.
- `docs/index.html`: download button per platform; privacy section mentions Keychain read on Mac.
- `package.json` description: drop "Windows".

## Verification (needs a Mac or CI + tester)

1. `npm run build && npx electron-builder --mac --dir` → app bundle exists, launches, no Dock icon.
2. Menu bar shows two rows, correct colors, updates when `AGENT_USAGE_FAKE=1` cycles thresholds.
3. Left-click opens popup directly below the item; blur closes it. Right-click → Quit.
4. Quota loads from Keychain after one "Always Allow" prompt. Codex loads from `~/.codex/auth.json`.
5. Cost section populates (tokscale via `which bunx`/`npx`).
6. Light ↔ dark toggle in System Settings re-inks the menu bar item.
7. Windows build still works: `npm run dist` unchanged, widget still embeds.
8. Unit tests: `npx tsc --noEmit` + existing `*.test.ts` pass on both.

## Known unknowns

- `paint` event image scale on Retina (phase 4). Fallback: `drawText` pixel-font renderer, ~40 lines.
- Keychain service name — verify against a real Mac `~/Library/Keychains` (`security dump-keychain | grep -i claude`). Community tools use `"Claude Code-credentials"`.
- Menu bar overflow on 13" screens hides rightmost items with no flyout. If reported, add a setting `menuBarCompact` → glyph + `42%` only.
- 8.5pt text on non-Retina external monitors will be mushy. Accept.

## Out of scope

Signing/notarization, Dock/Notification Center widgets, Homebrew cask, per-monitor menu bars.
