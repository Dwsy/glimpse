import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const swift = readFileSync(new URL('../src/glimpse.swift', import.meta.url), 'utf8');
const match = swift.match(/let bridgeJS = """\n([\s\S]*?)\n"""/);
assert.ok(match, 'bridgeJS must remain extractable');
const messages = [];
const window = {
  webkit: { messageHandlers: { glimpse: { postMessage: (body) => messages.push(JSON.parse(body)) } } },
  dispatchEvent() {},
};
const document = { hasFocus: () => true, documentElement: { classList: { toggle() {} } } };
class CustomEvent {}
const context = vm.createContext({ window, document, CustomEvent, Map, Set, Array, Promise, Error, JSON, String, Date, URL });
vm.runInContext(match[1], context);

const openPending = context.window.glazeAPI.dialog.showOpenDialog({
  title: 'Choose files', properties: ['openFile', 'multiSelections'],
  filters: [{ name: 'Text', extensions: ['txt'] }],
});
const openRequest = messages.at(-1).__glimpse_native_dialog;
assert.equal(openRequest.method, 'showOpenDialog');
assert.deepEqual(openRequest.args[0].properties, ['openFile', 'multiSelections']);
context.window.__GLIMPSE_NATIVE_DIALOG_RESOLVE__(openRequest.id, { canceled: false, filePaths: ['/tmp/a.txt'] }, null);
assert.deepEqual(await openPending, { canceled: false, filePaths: ['/tmp/a.txt'] });

const savePending = context.window.glazeAPI.dialog.showSaveDialog({ defaultPath: '/tmp/output.txt' });
const saveRequest = messages.at(-1).__glimpse_native_dialog;
assert.equal(saveRequest.method, 'showSaveDialog');
context.window.__GLIMPSE_NATIVE_DIALOG_RESOLVE__(saveRequest.id, { canceled: true, filePath: '' }, null);
assert.deepEqual(await savePending, { canceled: true, filePath: '' });

const messagePending = context.window.glazeAPI.dialog.showMessageBox({
  type: 'question', message: 'Continue?', buttons: ['Cancel', 'OK'], defaultId: 1,
  checkboxLabel: 'Remember', checkboxChecked: true,
});
const messageRequest = messages.at(-1).__glimpse_native_dialog;
assert.equal(messageRequest.method, 'showMessageBox');
context.window.__GLIMPSE_NATIVE_DIALOG_RESOLVE__(messageRequest.id, { response: 1, checkboxChecked: true }, null);
assert.deepEqual(await messagePending, { response: 1, checkboxChecked: true });

const errorPending = context.window.glazeAPI.dialog.showErrorBox('Failure', 'Something went wrong');
const errorRequest = messages.at(-1).__glimpse_native_dialog;
assert.equal(errorRequest.method, 'showErrorBox');
assert.deepEqual(errorRequest.args, ['Failure', 'Something went wrong']);
context.window.__GLIMPSE_NATIVE_DIALOG_RESOLVE__(errorRequest.id, null, null);
assert.equal(await errorPending, null);

const rejected = context.window.glazeAPI.dialog.showMessageBox({ message: '' });
const bad = messages.at(-1).__glimpse_native_dialog;
context.window.__GLIMPSE_NATIVE_DIALOG_RESOLVE__(bad.id, null, 'MessageBox requires a non-empty message');
await assert.rejects(rejected, /non-empty message/);

assert.match(swift, /let panel = NSOpenPanel\(\)/);
assert.match(swift, /let panel = NSSavePanel\(\)/);
assert.match(swift, /let alert = NSAlert\(\)/);
assert.match(swift, /beginSheetModal\(for: rec\.window\)/);
assert.match(swift, /nativeDialogRequestIds\.isEmpty/);
assert.match(swift, /securityScopedBookmark/);
assert.match(swift, /__glimpse_native_dialog/);
console.log('native dialog bridge test passed');
