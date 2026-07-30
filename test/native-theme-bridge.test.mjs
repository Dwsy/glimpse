import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const sourcePath = new URL('../src/glimpse.swift', import.meta.url);
const swift = readFileSync(sourcePath, 'utf8');
const match = swift.match(/let bridgeJS = """\n([\s\S]*?)\n"""/);
assert.ok(match, 'bridgeJS must remain extractable');

const messages = [];
const toggles = [];
const events = [];
class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init.detail;
  }
}
const document = {
  hasFocus: () => true,
  documentElement: { classList: { toggle: (...args) => toggles.push(args) } },
};
const window = {
  webkit: { messageHandlers: { glimpse: { postMessage: (body) => messages.push(JSON.parse(body)) } } },
  dispatchEvent: (event) => events.push(event),
};
const context = vm.createContext({ window, document, CustomEvent, Map, Set, Array, Promise, Error, JSON, String });
vm.runInContext(match[1], context);
const page = context.window;

const getInfo = page.glazeAPI.nativeTheme.getInfo();
assert.equal(messages.length, 1);
assert.equal(messages[0].__glimpse_native_theme.method, 'getInfo');
const getInfoId = messages[0].__glimpse_native_theme.id;
page.__GLIMPSE_NATIVE_THEME_RESOLVE__(getInfoId, {
  shouldUseDarkColors: false,
  themeSource: 'system',
  accentColor: '#138af2',
}, null);
assert.deepEqual(await getInfo, {
  shouldUseDarkColors: false,
  themeSource: 'system',
  accentColor: '#138af2',
});

const setTheme = page.glazeAPI.nativeTheme.setThemeSource('dark');
assert.equal(messages.at(-1).__glimpse_native_theme.method, 'setThemeSource');
assert.equal(messages.at(-1).__glimpse_native_theme.argument, 'dark');
page.__GLIMPSE_NATIVE_THEME_RESOLVE__(messages.at(-1).__glimpse_native_theme.id, true, null);
assert.equal(await setTheme, true);

let notification = null;
const unsubscribe = page.glazeAPI.glaze.ipc.onNotification('nativeTheme:updated', (info) => {
  notification = info;
});
page.__GLIMPSE_NATIVE_THEME_NOTIFY__('nativeTheme:updated', { shouldUseDarkColors: true, themeSource: 'dark' });
assert.deepEqual(notification, { shouldUseDarkColors: true, themeSource: 'dark' });
unsubscribe();
notification = null;
page.__GLIMPSE_NATIVE_THEME_NOTIFY__('nativeTheme:updated', { shouldUseDarkColors: false, themeSource: 'light' });
assert.equal(notification, null);

assert.match(swift, /var nativeThemeSource: String = "system"/);
assert.match(swift, /setNativeThemeSource\(_ source: String, for rec: WindowRecord\)/);
assert.match(swift, /rec\.window\.appearance = appearance/);
assert.match(swift, /NSColor\.systemColorsDidChangeNotification/);
assert.match(swift, /__glimpse_native_theme/);
console.log('native-theme bridge test passed');
