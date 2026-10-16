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

The GAPP host daemon listens on `http://127.0.0.1:54888` with a bearer token at
`~/.pi/gapp/host-token`. Any running Pi session with the `generative-ui`
extension hosts it — and when nothing is listening, Raycast starts a detached
daemon itself, so GAPPs open without a Pi session. Only a "connection refused"
triggers that spawn; an HTTP error from a live daemon never does.

| Env var | Default | Purpose |
|---------|---------|---------|
| `GAPP_HOST_BASE` | `http://127.0.0.1:54888` | Daemon base URL |
| `GAPP_HOST_TOKEN` | — | Bearer token (else read from the token file) |
| `GAPP_HOST_TOKEN_PATH` | `~/.pi/gapp/host-token` | Token file location |
| `GAPP_DAEMON_DIR` | `~/.pi/agent/extensions/generative-ui/gapp` | Where `daemon-supervisor.ts` lives |
| `GAPP_BUN_BIN` | `bun` on `PATH`, else `~/.bun/bin/bun` | Bun used to launch the supervisor |

The daemon logs to `~/.pi/gapp/_host/gapp-host.log`; check it when startup fails.

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
