# Agent Usage

Windows tray app: live Claude quotas + cross-agent token/cost tracking.

## Download

Grab the latest **Agent Usage Setup `x.y.z`.exe** from the
[Releases page](https://github.com/antoniosumak/agent-usage-tray/releases/latest)
and run it. Installs per-user (no admin), adds a Start Menu + desktop shortcut,
and an uninstaller.

> Unsigned app — Windows SmartScreen shows "Unknown publisher". Click
> **More info → Run anyway**.

## Build from source

```
npm ci
npm run dist    # installer in release/
```

## Cutting a release

Push a version tag; GitHub Actions builds and publishes the installer.

```
npm version patch      # bumps package.json + tags vX.Y.Z
git push --follow-tags
```
