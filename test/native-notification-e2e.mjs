import { open } from '../src/glimpse.mjs';
import { writeFileSync } from 'node:fs';

const evidencePath = process.env.NATIVE_NOTIFICATION_E2E_EVIDENCE || 'artifacts/native-notification/runtime.json';
const unique = `${Date.now()}-${process.pid}`;
const notificationId = `openglaze-notification-${unique}`;
const title = `OpenGlaze Notification E2E ${unique}`;
const evidence = { result: 'RUNNING', title, notificationId, events: [] };
const persist = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
persist();

function waitFor(win, event, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeoutMs);
    win.once(event, (...args) => { clearTimeout(timer); resolve(args); });
    win.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

let win;
try {
  win = open('<!doctype html><h1>Notification E2E</h1>', { title, width: 520, height: 280 });
  await waitFor(win, 'ready');
  evidence.ready = true;
  persist();
  win.send(`(()=>{
    const n=new window.openGlaze.Notification({
      id:${JSON.stringify(notificationId)},
      title:'OpenGlaze build complete',
      subtitle:'Native notification E2E',
      body:'This notification is delivered by UNUserNotificationCenter.',
      silent:true
    });
    window.__OPENGLAZE_NOTIFICATION_E2E__=n;
    for(const event of ['show','click','close','failed']) n.on(event,(payload)=>window.glimpse.send({nativeNotificationE2E:event,payload}));
    n.show();
  })()`);
  const [shown] = await waitFor(win, 'message', 30_000);
  evidence.events.push(shown);
  persist();
  if (shown?.nativeNotificationE2E === 'failed') {
    throw new Error(`Native notification failed: ${shown.payload?.error || 'unknown error'}`);
  }
  if (shown?.nativeNotificationE2E !== 'show' || shown.payload?.delivered !== true) {
    throw new Error(`Expected delivered show event, got ${JSON.stringify(shown)}`);
  }
  win.send('window.__OPENGLAZE_NOTIFICATION_E2E__.close()');
  const [closed] = await waitFor(win, 'message', 10_000);
  evidence.events.push(closed);
  if (closed?.nativeNotificationE2E !== 'close') throw new Error(`Expected close event, got ${JSON.stringify(closed)}`);
  evidence.result = 'PASS';
  evidence.completedAt = new Date().toISOString();
  persist();
  win.close();
  await waitFor(win, 'closed', 10_000);
  process.exit(0);
} catch (error) {
  evidence.result = 'FAIL';
  evidence.error = error?.stack || String(error);
  evidence.completedAt = new Date().toISOString();
  persist();
  win?.close();
  process.exit(1);
}
