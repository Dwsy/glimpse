# Glimpse Windows — Raycast Extension

Browse GAPPs and switch GAPP windows from Raycast. Window lifecycle goes
through the **GAPP host daemon**, so windows outlive the Raycast command
process and stay focusable/closeable from later invocations.

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
| **Run Last GAPP** | no-view | Open the most recent run through the GAPP host daemon |
| **Switch GAPP Window** | view | Live GAPP windows; Enter focuses, ⌘K closes |
| **Focus Active GAPP Window** | no-view | Focus the most recently opened GAPP window |

## Prerequisites

The GAPP host daemon must be listening on `http://127.0.0.1:54888` (any running
Pi session with the `generative-ui` extension hosts it; it is otherwise started
on demand) with a bearer token at `~/.pi/gapp/host-token`.

```bash
TOKEN=$(cat ~/.pi/gapp/host-token)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:54888/v1/gapp
```

## Protocol

GAPP host daemon (HTTP + bearer token) — full contract in
`~/.pi/agent/extensions/generative-ui/gapp/PROTOCOL.md`:

```
GET  /v1/gapp                    # live apps + leases + sessions
POST /v1/gapp/apps/:appId/open   # {"cwd","scope","versionId","source"}
POST /v1/gapp/apps/:appId/window # {"action":"focus"|"close"}
```

Disk stays SSOT for catalog, version history and run history — those reads keep
going through `~/Dev/AI/glimpse/gapp-sdk` from the Raycast process. Opening,
focusing and closing windows is daemon-owned (`instances: single` leases
included), so a Raycast-opened window behaves exactly like one opened from Pi.
