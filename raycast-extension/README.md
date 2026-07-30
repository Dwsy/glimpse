# Glimpse Windows — Raycast Extension

List, focus, and close open Glimpse micro-UI windows from Raycast.

## Fix “Missing executable”

Raycast needs **compiled** command files (`list-windows.js`, `focus-active.js`) next to `package.json`. Source-only import will fail.

```bash
cd /Users/dengwenyu/Dev/AI/glimpse/raycast-extension
npm run prepare-import   # install + build + sync .js to root
```

Then either:

### A) Import (one-shot)

1. Raycast → **Import Extension…**
2. Select folder:  
   `/Users/dengwenyu/Dev/AI/glimpse/raycast-extension`
3. Confirm `list-windows.js` and `focus-active.js` exist in that folder.

### B) Dev mode (recommended while hacking)

```bash
cd /Users/dengwenyu/Dev/AI/glimpse/raycast-extension
npm run dev
```

Leave this running; Raycast hot-reloads the extension.

## Commands

| Command | Mode | Description |
|---------|------|-------------|
| **Browse GAPPs** | view | By project · open · version history · enable/archive |
| **Run Last GAPP** | no-view | Isolated open (no Pi) of most recent run |
| **Switch Glimpse Window** | view | Live host windows; Enter focuses |
| **Focus Active Glimpse Window** | no-view | Focus key/first live window |

GAPP commands use `~/Dev/AI/glimpse/gapp-sdk` (portable, no agent).

## Prerequisites

1. Glimpse host running (open any window via `open()` / `glimpseui`).
2. Control socket exists:

```bash
ls ~/Library/Application\ Support/dev.glimpse.ui/control.sock
node /Users/dengwenyu/Dev/AI/glimpse/bin/glimpse-ctl.mjs list
```

## Protocol

Unix socket: `~/Library/Application Support/dev.glimpse.ui/control.sock`

```json
{"type":"list"}
{"type":"focus","id":"<window-id>"}
{"type":"close","id":"<window-id>"}
```
