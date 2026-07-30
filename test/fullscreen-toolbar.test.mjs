import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const swift = readFileSync(new URL("../src/glimpse.swift", import.meta.url), "utf8");
assert.match(swift, /win\.toolbarStyle = \.unified/);
assert.match(swift, /func windowWillEnterFullScreen\(_ notification: Notification\)/);
assert.match(swift, /setTransparentToolbarVisible\(false, for: notification, phase: "willEnterFullScreen"\)/);
assert.match(swift, /func windowDidEnterFullScreen\(_ notification: Notification\)/);
assert.match(swift, /setTransparentToolbarVisible\(false, for: notification, phase: "didEnterFullScreen"\)/);
assert.match(swift, /func windowDidExitFullScreen\(_ notification: Notification\)/);
assert.match(swift, /setTransparentToolbarVisible\(true, for: notification, phase: "didExitFullScreen"\)/);
assert.match(swift, /rec\.config\.transparent, !rec\.config\.frameless/);
assert.match(swift, /toolbar\.isVisible = visible/);
console.log("fullscreen toolbar test passed");
