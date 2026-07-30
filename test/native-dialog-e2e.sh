#!/bin/zsh
set -euo pipefail
repo="${0:A:h:h}"
cd "$repo"
evidence="$repo/artifacts/native-dialog/runtime.json"
log="$repo/artifacts/native-dialog/harness.log"
/bin/rm -f "$evidence" "$log"
title="OpenGlaze Native Dialog E2E $$"
NATIVE_DIALOG_E2E_EVIDENCE="$evidence" NATIVE_DIALOG_E2E_TITLE="$title" node test/native-dialog-e2e.mjs >"$log" 2>&1 &
harness=$!
cleanup() {
  kill "$harness" 2>/dev/null || true
  pkill -f -- "--title $title" 2>/dev/null || true
}
trap cleanup EXIT

wait_stage() {
  local stage="$1"
  for _ in {1..240}; do
    if [[ -f "$evidence" ]] && node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1]));process.exit(d.awaiting===process.argv[2]?0:1)' "$evidence" "$stage" 2>/dev/null; then return 0; fi
    sleep .1
  done
  echo "Timed out waiting for stage $stage" >&2
  cat "$evidence" >&2 || true
  cat "$log" >&2 || true
  return 1
}

find_pid() {
  python3 - "$title" <<'PY2'
import subprocess,sys
needle='--title '+sys.argv[1]
for line in subprocess.check_output(['ps','-axo','pid=,command='],text=True).splitlines():
    stripped=line.strip()
    if '/Glimpse.app/Contents/MacOS/glimpse' not in stripped or needle not in stripped:
        continue
    pid,command=stripped.split(None,1)
    if command.startswith('/Users/dengwenyu/Dev/AI/glimpse/src/Glimpse.app/Contents/MacOS/glimpse '):
        print(pid)
        break
PY2
}
for _ in {1..120}; do pid=$(find_pid); [[ -n "${pid:-}" ]] && break; sleep .1; done
[[ -n "${pid:-}" ]] || { echo "Glimpse PID not found" >&2; exit 1; }

wait_stage messageBox
/tmp/native-dialog-ax "$pid" inspect messageBox > artifacts/native-dialog/message-box-ax.json
node - <<'NODE'
const d=JSON.parse(require('node:fs').readFileSync('artifacts/native-dialog/message-box-ax.json'));
if(!d.trusted) process.exit(77);
const roles=d.nodes.map(x=>x.role);
if(!roles.includes('AXSheet')) throw new Error('NSAlert is not exposed as an attached AXSheet');
if(!d.nodes.some(x=>x.role==='AXButton' && x.title==='Continue')) throw new Error('Continue button missing');
NODE
/tmp/native-dialog-ax "$pid" press Continue

wait_stage errorBox
/tmp/native-dialog-ax "$pid" inspect errorBox > artifacts/native-dialog/error-box-ax.json
/tmp/native-dialog-ax "$pid" press OK

wait_stage openDialog
/tmp/native-dialog-ax "$pid" inspect openDialog > artifacts/native-dialog/open-panel-ax.json
/tmp/native-dialog-ax "$pid" escape '*'

wait_stage saveDialog
/tmp/native-dialog-ax "$pid" inspect saveDialog > artifacts/native-dialog/save-panel-ax.json
node - <<'NODE'
const d=JSON.parse(require('node:fs').readFileSync('artifacts/native-dialog/save-panel-ax.json'));
if(!d.nodes.some(x=>x.role==='AXButton' && x.title==='Cancel')) throw new Error('Save Panel Cancel button missing');
NODE
/tmp/native-dialog-ax "$pid" press Cancel

wait "$harness"
trap - EXIT
node - <<'NODE'
const fs=require('node:fs');
const d=JSON.parse(fs.readFileSync('artifacts/native-dialog/runtime.json','utf8'));
if(d.result!=='PASS') throw new Error(JSON.stringify(d));
const by=Object.fromEntries(d.stages.map(x=>[x.name,x.result]));
if(by.messageBox.response!==1 || by.messageBox.checkboxChecked!==true) throw new Error('message result mismatch');
if(by.errorBox!==null) throw new Error('error result mismatch');
if(!by.openDialog.canceled || by.openDialog.filePaths.length) throw new Error('open cancel mismatch');
if(!by.saveDialog.canceled || by.saveDialog.filePath!=='') throw new Error('save cancel mismatch');
console.log(JSON.stringify(d,null,2));
NODE
echo NATIVE_DIALOG_REAL_APPKIT_E2E_PASS
