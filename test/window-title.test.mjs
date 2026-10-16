/**
 * Window title test — the window follows the page's <title> like a browser tab,
 * while an explicitly requested title stays pinned.
 *
 * Two layers:
 *  1. Static assertions pin the contract (flags, defaults, wiring).
 *  2. A live host check reads the real NSWindow title over the control socket.
 *     Skipped when no compiled binary is available (CI without macOS).
 */
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import net from "node:net";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const swift = readFileSync(join(root, "src/glimpse.swift"), "utf8");
const nodeHost = readFileSync(join(root, "src/glimpse.mjs"), "utf8");

// ── 1. Contract ─────────────────────────────────────────────────────────

assert.match(swift, /var title: String = "Glimpse"/);
assert.match(swift, /var titleExplicit: Bool = false/);
assert.match(swift, /c\.title = v\s*\n\s*c\.titleExplicit = true/);
assert.match(swift, /config\.title = args\[i\]\s*\n\s*config\.titleExplicit = true/);
assert.match(swift, /self\.titlePinned = config\.titleExplicit/);
// Page titles are mirrored through KVO on WKWebView.title, not polled.
assert.match(swift, /built\.webView\.observe\(\\\.title, options: \[\.new\]\)/);
assert.match(swift, /func applyPageTitle\(_ raw: String\?\)/);
assert.match(swift, /guard !closed, !titlePinned else \{ return \}/);
// An empty WebKit title (untitled document, or mid-navigation) must not blank
// the window — otherwise the title flickers on every load.
assert.match(swift, /guard !title\.isEmpty, window\.title != title else \{ return \}/);
assert.match(swift, /titleObservation\?\.invalidate\(\)/);
// Explicit protocol titles pin the window.
assert.match(swift, /rec\.window\.title = title\s*\n\s*rec\.titlePinned = true/);
// Node wrapper keeps forwarding title as an open option.
assert.match(nodeHost, /if \(options\.title != null\) payload\.title = options\.title/);

// ── 2. Live behavior ────────────────────────────────────────────────────

const override = process.env.GLIMPSE_BINARY_PATH || process.env.GLIMPSE_HOST_PATH;
const bundled = join(root, "src/Glimpse.app/Contents/MacOS/glimpse");
const binary = override || (existsSync(bundled) ? bundled : join(root, "src/glimpse"));

if (process.platform !== "darwin" || !existsSync(binary)) {
  console.log("window title contract verified (live check skipped: no macOS binary)");
  process.exit(0);
}

const socketPath = join(homedir(), "Library/Application Support/dev.glimpse.ui/control.sock");
if (existsSync(socketPath)) {
  console.log("window title contract verified (live check skipped: another host owns the socket)");
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64 = (html) => Buffer.from(html).toString("base64");

function controlRequest(command, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buf = "";
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error(`control socket timeout: ${command.type}`));
    }, timeoutMs);
    client.on("connect", () => client.write(JSON.stringify(command) + "\n"));
    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      clearTimeout(timer);
      client.destroy();
      resolve(JSON.parse(buf.slice(0, nl)));
    });
    client.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const proc = spawn(binary, ["--host"], { stdio: ["pipe", "pipe", "pipe"] });
const send = (obj) => proc.stdin.write(JSON.stringify(obj) + "\n");
let hostReady = false;
createInterface({ input: proc.stdout, crlfDelay: Infinity }).on("line", (line) => {
  try {
    if (JSON.parse(line).type === "host-ready") hostReady = true;
  } catch {
    // Non-JSON stdout is debug noise; ignore.
  }
});

async function waitFor(pred, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const titleOf = async (id) => {
  const res = await controlRequest({ type: "list" });
  return res.windows.find((w) => w.id === id)?.title;
};

try {
  await waitFor(() => hostReady, "host-ready");
  await waitFor(() => existsSync(socketPath), "control socket");

  // Untitled window adopts the page title.
  send({ type: "open", id: "auto", width: 400, height: 300 });
  await sleep(400);
  send({
    type: "html",
    id: "auto",
    html: b64("<!doctype html><html><head><title>Browser Tab Title</title></head><body>hi</body></html>"),
  });
  await sleep(1200);
  assert.equal(await titleOf("auto"), "Browser Tab Title", "page <title> should become the window title");

  // Later document.title writes keep the window in sync.
  send({ type: "eval", id: "auto", js: "document.title = 'Renamed Live'" });
  await sleep(600);
  assert.equal(await titleOf("auto"), "Renamed Live", "live document.title writes should be mirrored");

  // A document without <title> keeps the placeholder instead of blanking.
  send({ type: "open", id: "untitled", width: 400, height: 300 });
  await sleep(400);
  send({ type: "html", id: "untitled", html: b64("<!doctype html><html><body>no title</body></html>") });
  await sleep(1200);
  assert.equal(await titleOf("untitled"), "Glimpse", "titleless document should keep the placeholder");

  // An explicitly requested title wins over the page.
  send({ type: "open", id: "pinned", width: 400, height: 300, title: "Pinned At Open" });
  await sleep(400);
  send({ type: "html", id: "pinned", html: b64("<!doctype html><html><head><title>Page Loses</title></head></html>") });
  await sleep(1200);
  assert.equal(await titleOf("pinned"), "Pinned At Open", "explicit open.title should stay pinned");

  // The `title` protocol command pins too.
  send({ type: "title", id: "auto", title: "Host Override" });
  await sleep(400);
  send({ type: "eval", id: "auto", js: "document.title = 'Should Not Win'" });
  await sleep(600);
  assert.equal(await titleOf("auto"), "Host Override", "title command should pin against the page");

  console.log("window title test passed");
} finally {
  try {
    send({ type: "quit" });
  } catch {
    // Host may already be gone.
  }
  await sleep(600);
  proc.kill("SIGKILL");
  if (existsSync(socketPath)) {
    try {
      unlinkSync(socketPath);
    } catch {
      // Another process may have cleaned it up first.
    }
  }
}
