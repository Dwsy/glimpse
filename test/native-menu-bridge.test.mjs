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
const context = vm.createContext({ window, document, CustomEvent, Map, Set, Array, Promise, Error, JSON, String });
vm.runInContext(match[1], context);

const pending = context.window.glazeAPI.Menu.popup({
  coordinateSpace: 'view',
  x: 10,
  y: 20,
  minWidth: 120,
  items: [{ type: 'normal', label: 'One', commandId: 7 }],
});
const request = messages.at(-1).__glimpse_native_menu;
assert.equal(request.method, 'popup');
assert.equal(request.options.items[0].commandId, 7);
context.window.__GLIMPSE_NATIVE_MENU_RESOLVE__(request.id, { commandId: 7 }, null);
assert.deepEqual(await pending, { commandId: 7 });

const rejected = context.window.glazeAPI.Menu.popup({ items: [] });
const bad = messages.at(-1).__glimpse_native_menu;
context.window.__GLIMPSE_NATIVE_MENU_RESOLVE__(bad.id, null, 'Menu.popup requires a non-empty items array');
await assert.rejects(rejected, /non-empty items array/);

assert.match(swift, /final class NativeMenuSelectionTarget/);
assert.match(swift, /private func buildNativeMenu/);
assert.match(swift, /menu\.popUp\(positioning:/);
assert.match(swift, /__glimpse_native_menu/);
console.log('native menu bridge test passed');
