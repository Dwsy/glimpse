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

const pending = context.window.glazeAPI.dialog.showDatePicker({
  mode: 'date',
  x: 12,
  y: 24,
  width: 160,
  height: 32,
  initialValue: '2026-07-26',
  min: '2026-01-01',
  max: '2026-12-31',
});
const request = messages.at(-1).__glimpse_native_date_picker;
assert.equal(request.options.mode, 'date');
assert.equal(request.options.initialValue, '2026-07-26');
context.window.__GLIMPSE_NATIVE_DATE_PICKER_RESOLVE__(request.id, { canceled: false, value: '2026-07-26' }, null);
assert.deepEqual(await pending, { canceled: false, value: '2026-07-26' });

const rejected = context.window.glazeAPI.dialog.showDatePicker({ mode: 'invalid' });
const bad = messages.at(-1).__glimpse_native_date_picker;
context.window.__GLIMPSE_NATIVE_DATE_PICKER_RESOLVE__(bad.id, null, 'Invalid native date picker request');
await assert.rejects(rejected, /Invalid native date picker request/);

assert.match(swift, /final class NativeDatePickerSession/);
assert.match(swift, /let picker = NSDatePicker\(\)/);
assert.match(swift, /picker\.focusRingType = \.none/);
assert.match(swift, /picker\.sizeToFit\(\)/);
assert.match(swift, /let fitting = picker\.fittingSize/);
assert.match(swift, /width: max\(minimumButtonRowWidth, pickerSize\.width \+ horizontalPadding \* 2\)/);
assert.doesNotMatch(swift, /contentSize = NSSize\(width: 320, height:/);
assert.match(swift, /session\.popover\.show\(relativeTo:/);
assert.match(swift, /__glimpse_native_date_picker/);
console.log('native date picker bridge test passed');
