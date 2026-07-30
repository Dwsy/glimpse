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

const Notification = context.window.openGlaze.Notification;
assert.equal(Notification.isSupported(), true);
const events = [];
const notification = new Notification({
  id: 'build-complete', title: 'Build complete', subtitle: 'OpenGlaze', body: 'Your app is ready', silent: true,
});
notification.on('show', (event) => events.push(event.type));
notification.once('click', (event) => events.push(event.type));
notification.on('close', (event) => events.push(event.type));
notification.on('failed', (event) => events.push(`${event.type}:${event.error}`));
notification.show();
assert.deepEqual(messages.at(-1).__glimpse_native_notification, {
  method: 'show', id: 'build-complete',
  options: { id: 'build-complete', title: 'Build complete', subtitle: 'OpenGlaze', body: 'Your app is ready', silent: true, sound: '' },
});
context.window.__GLIMPSE_NATIVE_NOTIFICATION_EVENT__('build-complete', 'show', { type: 'show', delivered: true, backend: 'legacyNotificationCenter' });
context.window.__GLIMPSE_NATIVE_NOTIFICATION_EVENT__('build-complete', 'click', { type: 'click' });
assert.deepEqual(events, ['show', 'click']);
notification.close();
assert.deepEqual(messages.at(-1).__glimpse_native_notification, { method: 'close', id: 'build-complete' });

const failed = new Notification({ id: 'denied', body: 'Denied' });
failed.on('failed', (event) => events.push(`${event.type}:${event.error}`));
context.window.__GLIMPSE_NATIVE_NOTIFICATION_EVENT__('denied', 'failed', { type: 'failed', error: 'Notification permission is denied' });
assert.equal(events.at(-1), 'failed:Notification permission is denied');

assert.match(swift, /import UserNotifications/);
assert.match(swift, /UNUserNotificationCenterDelegate/);
assert.match(swift, /UNMutableNotificationContent\(\)/);
assert.match(swift, /UNNotificationRequest\(identifier: id/);
assert.match(swift, /getDeliveredNotifications/);
assert.match(swift, /legacyNotificationCenter/);
assert.match(swift, /\"delivered\": true/);
assert.match(swift, /emitNativeNotificationShowOnce/);
assert.match(swift, /identifier: "GLIMPSE_NOTIFICATION"/);
assert.match(swift, /\.customDismissAction/);
assert.match(swift, /__glimpse_native_notification/);
assert.match(swift, /__GLIMPSE_NATIVE_NOTIFICATION_EVENT__/);
assert.match(swift, /legacyNotificationCenterDidActivate/);
assert.match(swift, /legacyNotificationCenterDidDeliver/);
assert.match(swift, /deliverNotification:/);
assert.match(swift, /NSClassFromString\("NSUserNotification"\)/);
assert.match(swift, /NSClassFromString\("NSUserNotificationCenter"\)/);
console.log('native notification bridge test passed');
