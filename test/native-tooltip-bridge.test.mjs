import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/glimpse.swift", import.meta.url), "utf8");

test("tooltip child pages bridge resize and interruptible animation to the native host", () => {
  const block = source.match(/\(function installNativeChildWindowBridge\(\) \{[\s\S]*?\}\)\(\);/)?.[0];
  assert.ok(block);
  const messages = [];
  const window = {
    location: { href: "about:blank?feature=tooltip&id=test" },
    webkit: { messageHandlers: { glimpse: { postMessage: (value) => messages.push(JSON.parse(value)) } } },
  };
  vm.runInNewContext(block, { window, URL, Number });
  window.resizeTo(180, 42);
  window.animateOut();
  window.cancelAnimateOut();
  assert.deepEqual(messages, [
    { __glimpse_native_child_resize: { width: 180, height: 42 } },
    { __glimpse_native_child_animation: { action: "animateOut" } },
    { __glimpse_native_child_animation: { action: "cancelAnimateOut" } },
  ]);
});

test("Glimpse implements source-confirmed WKUIDelegate tooltip windows", () => {
  assert.match(source, /WKUIDelegate/);
  assert.match(source, /createWebViewWith configuration: WKWebViewConfiguration/);
  assert.match(source, /nativeChildRecords/);
  assert.match(source, /NSGlassEffectView/);
  assert.match(source, /func webViewDidClose\(_ webView: WKWebView\)/);
  assert.match(source, /private func animateOutNativeChild\(_ child: NativeChildWindowRecord\)/);
  assert.match(source, /private func cancelAnimateOutNativeChild\(_ child: NativeChildWindowRecord\)/);
  assert.match(source, /child\.animateOutGeneration == generation/);
  assert.match(source, /window\.onAnimateOutComplete\?\.\(\)/);
});
