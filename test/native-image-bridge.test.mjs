import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const swift = fs.readFileSync(new URL('../src/glimpse.swift', import.meta.url), 'utf8');
const match = swift.match(/let bridgeJS = """\n([\s\S]*?)\n"""/);
assert.ok(match, 'bridgeJS must remain extractable');
const messages = [];
const delegated = [];
const window = {
  webkit: { messageHandlers: { glimpse: { postMessage: (body) => messages.push(JSON.parse(body)) } } },
  glazeAPI: { glaze: { ipc: { invoke(channel, argument) { delegated.push({ channel, argument }); return Promise.resolve({ delegated: true }); } } } },
  dispatchEvent() {},
  setTimeout() { return 1; },
  clearTimeout() {},
};
const document = { hasFocus: () => true, documentElement: { classList: { toggle() {} } } };
class CustomEvent {}
const context = vm.createContext({ window, document, CustomEvent, Map, Set, Array, Promise, Error, JSON, String, URL });
vm.runInContext(match[1], context);

const symbolPromise = context.window.glazeAPI.glaze.ipc.invoke('nativeImage:createFromNamedImage', {
  imageName: 'square.and.arrow.up',
});
const symbolRequest = messages.at(-1).__glimpse_native_image;
assert.equal(symbolRequest.channel, 'nativeImage:createFromNamedImage');
assert.equal(symbolRequest.argument.imageName, 'square.and.arrow.up');
const symbolResult = {
  isEmpty: false,
  isTemplate: true,
  dataURL: 'data:image/png;base64,AA==',
  size: { width: 16, height: 16 },
};
context.window.__GLIMPSE_NATIVE_IMAGE_RESOLVE__(symbolRequest.id, symbolResult, null);
assert.deepEqual(await symbolPromise, symbolResult);

const pathPromise = context.window.glazeAPI.glaze.ipc.invoke('nativeImage:createFromPath', {
  path: '/tmp/native-menu-icon.png',
});
const pathRequest = messages.at(-1).__glimpse_native_image;
assert.equal(pathRequest.channel, 'nativeImage:createFromPath');
assert.equal(pathRequest.argument.path, '/tmp/native-menu-icon.png');
context.window.__GLIMPSE_NATIVE_IMAGE_RESOLVE__(pathRequest.id, null, 'Native image path is not a supported file');
await assert.rejects(pathPromise, /not a supported file/);

const delegatedResult = await context.window.glazeAPI.glaze.ipc.invoke('glaze:ping', { value: 1 });
assert.deepEqual(delegatedResult, { delegated: true });
assert.deepEqual(delegated, [{ channel: 'glaze:ping', argument: { value: 1 } }]);

assert.match(swift, /NSImage\(systemSymbolName: imageName/);
assert.match(swift, /NSImage\(contentsOf: url\)/);
assert.match(swift, /\.isRegularFileKey, \.fileSizeKey/);
assert.match(swift, /fileSize <= 32 \* 1024 \* 1024/);
assert.match(swift, /data:image\/png;base64,/);
assert.match(swift, /__glimpse_native_image/);
assert.match(swift, /Native image request timed out/);

assert.equal(context.window.glazeAPI.glaze.ipc.invoke.__glimpseNativeImageBridge, true);
const accessorWrapper = context.window.glazeAPI.glaze.ipc.invoke;
context.window.glazeAPI.glaze.ipc.invoke = function(channel, argument) {
  delegated.push({ channel, argument, late: true });
  return Promise.resolve({ lateDelegated: true });
};
assert.equal(context.window.glazeAPI.glaze.ipc.invoke, accessorWrapper);
const lateResult = await context.window.glazeAPI.glaze.ipc.invoke('glaze:late', { value: 2 });
assert.deepEqual(lateResult, { lateDelegated: true });
assert.deepEqual(delegated.at(-1), { channel: 'glaze:late', argument: { value: 2 }, late: true });
console.log('native image bridge test passed');
