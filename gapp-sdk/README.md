# @glimpse/gapp-sdk

Portable **Glimpse-APP (GAPP)** SDK — storage, version history, run log, and isolated window runner.

Works **without Pi agent**: Raycast, CLI, scripts, other tools.

## Layout

```
project:  <cwd>/.pi/gapp/<id>/{meta.json,state.json,index.html,versions/,runs.jsonl}
global:   ~/.pi/gapp/<id>/...
registry: ~/.pi/gapp/_registry.json
runs:     ~/.pi/gapp/_runs.jsonl
```

## Install

```bash
# from monorepo root (already next to glimpseui)
cd ~/Dev/AI/glimpse
npm i -g .          # also links gapp CLI via package.json bin
# or
node gapp-sdk/bin/gapp.mjs list
```

## CLI

```bash
gapp list [--all] [--cwd path]
gapp catalog
gapp open <id> [--cwd path] [--version <stamp>]
gapp history <id>
gapp runs [id]
gapp enable|disable|archive <id>
```

## API

```js
import {
  catalogGapps,
  runGapp,
  listVersions,
  upsertGapp,
  recordRun,
} from "./gapp-sdk/src/index.mjs";

const sections = await catalogGapps();
await runGapp("my-board", { cwd: "/path/to/project", source: "my-tool" });
```

## Isolation

`runGapp` only needs:

1. On-disk GAPP files
2. `glimpseui` (local/global)

No Pi session, no agent tools.
