#!/bin/zsh
set -euo pipefail
repo="${0:A:h:h}"
cd "$repo"
mkdir -p artifacts/native-notification
/bin/rm -f artifacts/native-notification/runtime.json artifacts/native-notification/harness.log
npm run build:macos >/tmp/native-notification-e2e-build.log 2>&1
NATIVE_NOTIFICATION_E2E_EVIDENCE="$repo/artifacts/native-notification/runtime.json" node test/native-notification-e2e.mjs > artifacts/native-notification/harness.log 2>&1 || {
  code=$?
  cat artifacts/native-notification/runtime.json >&2 || true
  cat artifacts/native-notification/harness.log >&2 || true
  exit "$code"
}
node - <<'NODE'
const d=require('./artifacts/native-notification/runtime.json');
if(d.result!=='PASS') throw new Error(JSON.stringify(d));
if(d.events[0]?.nativeNotificationE2E!=='show' || d.events[0]?.payload?.delivered!==true) throw new Error('notification was not delivered');
if(d.events[1]?.nativeNotificationE2E!=='close') throw new Error('notification close event missing');
console.log(JSON.stringify(d,null,2));
NODE
echo OPENGLAZE_NATIVE_NOTIFICATION_REAL_E2E_PASS
