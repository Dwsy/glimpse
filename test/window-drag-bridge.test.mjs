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
const document = {
  hasFocus: () => true,
  documentElement: { classList: { toggle() {} } },
};
class CustomEvent {}
const context = vm.createContext({ window, document, CustomEvent, Map, Set, Array, Promise, Error, JSON, String });
vm.runInContext(match[1], context);

context.window.glimpse.setWindowDragRegions({
  drag: [{ x: 100, y: 0, width: 700, height: 52 }],
  noDrag: [{ x: 600, y: 8, width: 180, height: 36 }],
});
assert.deepEqual(messages.at(-1), {
  __glimpse_window_drag_regions: {
    drag: [{ x: 100, y: 0, width: 700, height: 52 }],
    noDrag: [{ x: 600, y: 8, width: 180, height: 36 }],
  },
});
assert.match(swift, /NSEvent\.addLocalMonitorForEvents\(matching: \[\.leftMouseDown\]\)/);
assert.match(swift, /shouldPerformWindowDrag\(windowIdentity: UInt, locationInWindow: NSPoint\)/);
assert.match(swift, /window\.performDrag\(with: event\)/);
assert.match(swift, /windowNoDragRegions\.contains/);
assert.match(swift, /isStandardWindowButtonHit\(locationInWindow, in: rec\.window\)/);
assert.match(swift, /\[\.closeButton, \.miniaturizeButton, \.zoomButton\]/);
assert.match(swift, /window\.standardWindowButton\(type\)/);
assert.match(swift, /insetBy\(dx: -4, dy: -4\)/);
assert.match(swift, /__glimpse_window_drag_regions/);
console.log('window drag bridge test passed');
