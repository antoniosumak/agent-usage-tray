# Agent Usage

Agent Usage is a tray app for Windows and macOS. It shows your live Claude
quotas. It also tracks tokens and cost across your AI coding agents. Everything
stays on your computer.

<p align="center">
  <img src="docs/screenshots/popup-light.png" alt="The Agent Usage popup. It shows quota bars and today's cost." width="360">
</p>

## What it does

- **Shows your Claude quota in real time.** It reads the 5-hour session limit,
  the weekly limits, and your usage credits. The tray icon changes color as you
  get close to a limit. Green means low use. Yellow means medium use. Red means
  high use.
- **Tracks cost across your agents.** It shows how many tokens and dollars you
  use in Claude Code, Codex, and Cursor.
- **Groups the cost many ways.** You can see the cost by agent, by model, by
  tool or MCP server, and by project.
- **Shows the burn rate.** It gives you the current tokens per minute and
  dollars per hour. It also estimates the time until you reach the session
  limit.
- **Draws your activity.** It shows the cost in each 5-hour block. It also draws
  a heatmap of your token use for each hour of the day.
- **Warns you.** It sends a system notification one time when you pass a limit
  that you set.
- **Adds an optional desktop widget.** On Windows the widget floats near the
  tray. It shows the session bar and the 7-day bar. On macOS the menu bar item
  shows the same two bars.

## Screenshots

| Popup (dark) | Settings | Widget |
| --- | --- | --- |
| <img src="docs/screenshots/popup-dark.png" alt="The popup in the dark theme." width="260"> | <img src="docs/screenshots/settings-light.png" alt="The settings view. It shows the refresh interval, the warning threshold, the startup option, and the section toggles." width="260"> | <img src="docs/screenshots/widget.png" alt="The floating desktop widget. It shows two quota bars." width="260"> |

## How it works

- **Quota data comes from your Claude Code login.** The app reads the OAuth
  token from your local `~/.claude` folder. On macOS it reads the token from
  the Keychain instead. It then calls the Anthropic usage API. If you are not
  logged in to Claude Code, the app shows no quota.
- **Cost data comes from `tokscale`.** The app runs `tokscale` with `bunx` or
  `npx`. `tokscale` reads your local agent logs and calculates the tokens and
  the cost. You need `bun` or `node` on your computer for this feature.

The app sends no data to any server except the Anthropic usage API. It stores no
data in the cloud.

## Download

Get the latest build from the
[Releases page](https://github.com/antoniosumak/agent-usage-tray/releases/latest).

- **Windows:** `Agent Usage Setup x.y.z.exe`. Run it. The app installs for one
  user. It needs no admin rights. It adds a Start Menu shortcut, a desktop
  shortcut, and an uninstaller.
- **macOS:** `Agent Usage-x.y.z-arm64.dmg` for Apple Silicon or
  `Agent Usage-x.y.z-x64.dmg` for Intel. Open the DMG and drag the app to
  Applications. Zip builds are also available.

> The app is not signed. Windows SmartScreen shows "Unknown publisher". Click
> **More info**, then click **Run anyway**. On macOS, see the section below.

## macOS

- **First launch.** Gatekeeper blocks the app because it is not signed. Open
  **System Settings → Privacy & Security**, scroll to "Agent Usage was
  blocked", and click **Open Anyway**. Or right-click the app and choose
  **Open**. From a terminal, this does the same:
  `xattr -dr com.apple.quarantine "/Applications/Agent Usage.app"`
- **Keychain prompt.** Claude Code on macOS stores its login in the Keychain
  (service "Claude Code-credentials"). The app reads it with the `security`
  command. macOS asks once. Click **Always Allow**. If
  `~/.claude/.credentials.json` (or `$CLAUDE_CONFIG_DIR/.credentials.json`)
  exists, the app reads that file first. Codex reads `~/.codex/auth.json` as on
  Windows.
- **Menu bar item.** The app has no Dock icon. The menu bar item shows the same
  two rows as the Windows widget: the 5-hour bar and the 7-day bar, each with
  the percent and the reset time. Left-click opens the popup. Right-click shows
  **Quit**.
- **No auto-update.** macOS refuses unsigned updates. When a new version is out,
  the popup shows a **Download** link to the Releases page. Windows keeps
  auto-update.

## Build from source

```
npm ci
npm run dist        # Windows: the installer goes to release/
npm run dist:mac    # macOS: release/Agent Usage-<ver>-arm64.dmg (and x64)
```

## Cut a release

Push a version tag. GitHub Actions builds the Windows installer and the macOS
DMGs in a matrix and publishes them in one release.

```
npm version patch      # this bumps package.json and adds the tag vX.Y.Z
git push --follow-tags
```
