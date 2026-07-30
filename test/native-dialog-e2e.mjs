import { open } from '../src/glimpse.mjs';
import { writeFileSync } from 'node:fs';

const evidencePath = process.env.NATIVE_DIALOG_E2E_EVIDENCE || 'artifacts/native-dialog/runtime.json';
const title = process.env.NATIVE_DIALOG_E2E_TITLE || `OpenGlaze Native Dialog E2E ${process.pid}`;
const timeoutMs = 45_000;
const HTML = `<!doctype html><html><body><h1>Native Dialog E2E</h1></body></html>`;
const evidence = { result: 'RUNNING', title, nodePid: process.pid, stages: [] };
const persist = () => writeFileSync(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
persist();

function waitFor(win, event, timeout = timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for ${event}`)), timeout);
    win.once(event, (...args) => { clearTimeout(timer); resolve(args); });
    win.once('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

let win;
try {
  win = open(HTML, { title, width: 620, height: 420 });
  await waitFor(win, 'ready');
  evidence.ready = true;
  persist();

  const runStage = async (name, js) => {
    evidence.awaiting = name;
    persist();
    win.send(`(async()=>{try{const result=await (${js});window.glimpse.send({nativeDialogE2E:${JSON.stringify(name)},result});}catch(error){window.glimpse.send({nativeDialogE2E:${JSON.stringify(name)},error:String(error&&error.message||error)});}})()`);
    const [message] = await waitFor(win, 'message');
    if (message?.nativeDialogE2E !== name) throw new Error(`Unexpected ${name} message: ${JSON.stringify(message)}`);
    if (message.error) throw new Error(`${name}: ${message.error}`);
    evidence.stages.push({ name, result: message.result ?? null });
    evidence.awaiting = null;
    persist();
    return message.result;
  };

  const message = await runStage('messageBox', `window.glazeAPI.dialog.showMessageBox({type:'question',title:'OpenGlaze Message',message:'Continue native dialog E2E?',detail:'This alert must be a sheet attached to the invoking window.',buttons:['Cancel','Continue'],defaultId:1,cancelId:0,checkboxLabel:'Remember this choice',checkboxChecked:true})`);
  if (message?.response !== 1 || message?.checkboxChecked !== true) throw new Error(`Unexpected messageBox result ${JSON.stringify(message)}`);

  const error = await runStage('errorBox', `window.glazeAPI.dialog.showErrorBox('OpenGlaze Error Box','Native NSAlert error sheet verification')`);
  if (error !== null) throw new Error(`Unexpected errorBox result ${JSON.stringify(error)}`);

  const opened = await runStage('openDialog', `window.glazeAPI.dialog.showOpenDialog({title:'OpenGlaze Open Panel',buttonLabel:'Choose',properties:['openFile','multiSelections','showHiddenFiles'],filters:[{name:'Text',extensions:['txt','md']}]})`);
  if (opened?.canceled !== true || !Array.isArray(opened?.filePaths) || opened.filePaths.length !== 0) throw new Error(`Unexpected openDialog result ${JSON.stringify(opened)}`);

  const saved = await runStage('saveDialog', `window.glazeAPI.dialog.showSaveDialog({title:'OpenGlaze Save Panel',buttonLabel:'Save',defaultPath:'/tmp/openglaze-native-dialog-e2e.txt',filters:[{name:'Text',extensions:['txt']}]})`);
  if (saved?.canceled !== true || saved?.filePath !== '') throw new Error(`Unexpected saveDialog result ${JSON.stringify(saved)}`);

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
