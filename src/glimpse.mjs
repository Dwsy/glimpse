import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getFollowCursorSupport, supportsFollowCursor } from './follow-cursor-support.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

function resolveChromiumBackend() {
  return {
    path: process.execPath,
    extraArgs: [join(__dirname, 'chromium-backend.mjs')],
    platform: 'linux-chromium',
    buildHint: 'Using system Chromium via CDP (no native binary needed)',
  };
}

function resolveNativeHost() {
  const override = process.env.GLIMPSE_BINARY_PATH || process.env.GLIMPSE_HOST_PATH;
  if (override) {
    return {
      path: isAbsolute(override) ? override : resolve(process.cwd(), override),
      platform: 'override',
      buildHint: `Using override: ${override}`,
    };
  }

  switch (process.platform) {
    case 'darwin': {
      // Prefer .app bundle so Dock shows icon + "Glimpse" (Chrome-like).
      const appBinary = join(__dirname, 'Glimpse.app', 'Contents', 'MacOS', 'glimpse');
      const plain = join(__dirname, 'glimpse');
      return {
        path: existsSync(appBinary) ? appBinary : plain,
        platform: 'darwin',
        buildHint: "Run 'npm run build:macos' or 'swiftc -O src/glimpse.swift -o src/glimpse'",
      };
    }
    case 'linux': {
      const backend = process.env.GLIMPSE_BACKEND;
      if (backend === 'chromium') return resolveChromiumBackend();

      const nativePath = join(__dirname, 'glimpse');
      if (backend === 'native' || existsSync(nativePath)) {
        return {
          path: nativePath,
          platform: 'linux',
          buildHint: "Run 'npm run build:linux' (requires Rust toolchain and GTK4/WebKitGTK dev packages)",
        };
      }

      // Auto-fallback: no native binary found, try Chromium backend
      return resolveChromiumBackend();
    }
    case 'win32':
      return {
        path: join(__dirname, 'glimpse.exe'),
        platform: 'win32',
        buildHint: "Run 'npm run build:windows' (requires Rust toolchain and WebView2 Runtime)",
      };
    default:
      throw new Error(`Unsupported platform: ${process.platform}. Glimpse supports macOS, Linux, and Windows.`);
  }
}

export function getNativeHostInfo() {
  return resolveNativeHost();
}

export { getFollowCursorSupport, supportsFollowCursor };

const IMK_RUN_LOOP_WARNING = 'error messaging the mach port for IMKCFRunLoopWakeUpReliable';

function forwardNativeStderr(proc) {
  const rl = createInterface({ input: proc.stderr, crlfDelay: Infinity });
  rl.on('line', (line) => {
    if (line.includes(IMK_RUN_LOOP_WARNING)) return;
    process.stderr.write(`${line}\n`);
  });
}

// ---------------------------------------------------------------------------
// Shared multi-window host (macOS) — one Dock icon, many windows
// ---------------------------------------------------------------------------

/** @type {null | { proc: import('node:child_process').ChildProcess, windows: Map<string, GlimpseWindow>, ready: boolean, queue: object[] }} */
let sharedHost = null;

function shouldUseSharedHost(options = {}) {
  // Shared host is opt-in: quieter default (no --host process / control socket
  // lifecycle noise). Enable with options.shared or GLIMPSE_SHARED=1.
  if (process.env.GLIMPSE_ISOLATED === '1') return false;
  if (process.platform !== 'darwin') return false;
  // Accessory-style windows stay isolated (no Dock tile / separate lifecycle).
  if (options.clickThrough || options._isolated) return false;
  if (options.shared === true || process.env.GLIMPSE_SHARED === '1') return true;
  return false;
}

function ensureSharedHost() {
  if (sharedHost && sharedHost.proc && !sharedHost.proc.killed) {
    return sharedHost;
  }

  const host = ensureBinary();
  const proc = spawn(host.path, ['--host'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: false,
  });
  forwardNativeStderr(proc);

  const state = {
    proc,
    windows: new Map(),
    ready: false,
    queue: [],
  };
  sharedHost = state;

  const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    if (msg.type === 'host-ready') {
      state.ready = true;
      for (const cmd of state.queue) {
        writeHost(cmd);
      }
      state.queue = [];
      return;
    }

    const id = msg.id;
    if (id && state.windows.has(id)) {
      state.windows.get(id)._handleHostMessage(msg);
      return;
    }

    // Broadcast host-level events without id only if single window
    if (!id && state.windows.size === 1) {
      const only = state.windows.values().next().value;
      only?._handleHostMessage(msg);
    }
  });

  proc.on('exit', () => {
    for (const win of state.windows.values()) {
      win._markClosed();
    }
    state.windows.clear();
    if (sharedHost === state) sharedHost = null;
  });

  proc.stdin.on('error', () => {});

  return state;
}

function writeHost(obj) {
  const state = sharedHost;
  if (!state || !state.proc || state.proc.killed) return;
  if (!state.ready && obj.type !== 'open') {
    // open is also queued until host-ready
  }
  if (!state.ready) {
    state.queue.push(obj);
    return;
  }
  try {
    state.proc.stdin.write(JSON.stringify(obj) + '\n');
  } catch {
    // host gone
  }
}

function optionsToOpenPayload(id, options = {}) {
  const payload = { type: 'open', id };
  if (options.width != null) payload.width = options.width;
  if (options.height != null) payload.height = options.height;
  if (options.title != null) payload.title = options.title;
  if (options.frameless) payload.frameless = true;
  if (options.floating) payload.floating = true;
  if (options.transparent) payload.transparent = true;
  if (options.clickThrough) payload.clickThrough = true;
  if (options.hidden) payload.hidden = true;
  if (options.autoClose) payload.autoClose = true;
  if (options.openLinks) payload.openLinks = true;
  if (options.openLinksApp) payload.openLinksApp = options.openLinksApp;
  if (options.findInPage === true) payload.findInPage = true;
  if (options.x != null) payload.x = options.x;
  if (options.y != null) payload.y = options.y;
  if (options.followCursor && supportsFollowCursor()) payload.followCursor = true;
  if (options.cursorOffset?.x != null) payload.cursorOffsetX = options.cursorOffset.x;
  if (options.cursorOffset?.y != null) payload.cursorOffsetY = options.cursorOffset.y;
  if (options.cursorAnchor) payload.cursorAnchor = options.cursorAnchor;
  if (options.followMode != null) payload.followMode = options.followMode;
  return payload;
}

// ---------------------------------------------------------------------------
// GlimpseWindow
// ---------------------------------------------------------------------------

class GlimpseWindow extends EventEmitter {
  #proc;
  #closed = false;
  #pendingHTML = null;
  #info = null;
  #id = null;
  #shared = false;

  constructor(procOrNull, initialHTML, { id = null, shared = false } = {}) {
    super();
    this.#proc = procOrNull;
    this.#pendingHTML = initialHTML;
    this.#id = id;
    this.#shared = shared;

    if (!shared && procOrNull) {
      this.#attachIsolatedProcess(procOrNull);
    }
  }

  #attachIsolatedProcess(proc) {
    proc.stdin.on('error', () => {});

    const rl = createInterface({ input: proc.stdout, crlfDelay: Infinity });

    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('error', new Error(`Malformed protocol line: ${line}`));
        return;
      }
      this._handleHostMessage(msg);
    });

    proc.on('error', (err) => this.emit('error', err));

    proc.on('exit', () => {
      this._markClosed();
    });
  }

  /** @internal */
  _handleHostMessage(msg) {
    switch (msg.type) {
      case 'ready': {
        // Two-phase handshake: first ready = blank page → push pending HTML;
        // second ready = user content loaded → emit to caller.
        const info = {
          screen: msg.screen,
          screens: msg.screens,
          appearance: msg.appearance,
          cursor: msg.cursor,
          cursorTip: msg.cursorTip ?? null,
        };
        this.#info = info;
        if (this.#pendingHTML) {
          this.setHTML(this.#pendingHTML);
          this.#pendingHTML = null;
        } else {
          this.emit('ready', info);
        }
        break;
      }
      case 'info':
        this.#info = {
          screen: msg.screen,
          screens: msg.screens,
          appearance: msg.appearance,
          cursor: msg.cursor,
          cursorTip: msg.cursorTip ?? null,
        };
        this.emit('info', this.#info);
        break;
      case 'message':
        this.emit('message', msg.data);
        break;
      case 'click':
        this.emit('click');
        break;
      case 'closed':
        this._markClosed();
        break;
      default:
        break;
    }
  }

  /** @internal */
  _markClosed() {
    if (!this.#closed) {
      this.#closed = true;
      if (this.#shared && this.#id && sharedHost) {
        sharedHost.windows.delete(this.#id);
        // Host process exits on last window close (clears Dock icon).
        // ensureSharedHost() re-spawns on the next open().
      }
      this.emit('closed');
    }
  }

  #write(obj) {
    if (this.#closed) return;
    if (this.#shared) {
      const payload = this.#id ? { ...obj, id: this.#id } : obj;
      writeHost(payload);
      return;
    }
    this.#proc.stdin.write(JSON.stringify(obj) + '\n');
  }

  /** @internal — for subclass use only */
  _write(obj) {
    this.#write(obj);
  }

  send(js) {
    this.#write({ type: 'eval', js });
  }

  setHTML(html) {
    this.#write({ type: 'html', html: Buffer.from(html).toString('base64') });
  }

  show(options = {}) {
    const msg = { type: 'show' };
    if (options.title != null) msg.title = options.title;
    this.#write(msg);
  }

  close() {
    this.#write({ type: 'close' });
  }

  loadFile(path) {
    this.#write({ type: 'file', path });
  }

  get info() {
    return this.#info;
  }

  getInfo() {
    this.#write({ type: 'get-info' });
  }

  followCursor(enabled, anchor, mode) {
    if (enabled && !supportsFollowCursor()) {
      const { reason } = getFollowCursorSupport();
      process.emitWarning(`followCursor disabled: ${reason}`, { code: 'GLIMPSE_FOLLOW_CURSOR_UNSUPPORTED' });
      return;
    }
    const msg = { type: 'follow-cursor', enabled };
    if (anchor !== undefined) msg.anchor = anchor;
    if (mode !== undefined) msg.mode = mode;
    this.#write(msg);
  }
}

function ensureBinary() {
  const host = resolveNativeHost();

  // Chromium backend doesn't need a compiled binary -- just node + system Chrome
  if (host.platform === 'linux-chromium') return host;

  if (!existsSync(host.path)) {
    const skippedBuildPath = join(__dirname, '..', '.glimpse-build-skipped');
    const skippedReason = existsSync(skippedBuildPath)
      ? readFileSync(skippedBuildPath, 'utf8').trim()
      : null;
    throw new Error(
      skippedReason
        ? `Glimpse host not found at '${host.path}'. ${skippedReason}`
        : `Glimpse host not found at '${host.path}'. ${host.buildHint}`
    );
  }
  return host;
}

function openShared(html, options = {}) {
  const state = ensureSharedHost();
  const id = randomUUID();
  const win = new GlimpseWindow(null, html, { id, shared: true });
  state.windows.set(id, win);

  const openPayload = optionsToOpenPayload(id, options);
  writeHost(openPayload);
  // HTML is sent after first ready (blank) via #pendingHTML in _handleHostMessage

  return win;
}

function openIsolated(html, options = {}) {
  const host = ensureBinary();

  const args = [];
  if (options.width != null) args.push('--width', String(options.width));
  if (options.height != null) args.push('--height', String(options.height));
  if (options.title != null) args.push('--title', options.title);

  if (options.frameless) args.push('--frameless');
  if (options.floating) args.push('--floating');
  if (options.transparent) args.push('--transparent');
  if (options.clickThrough) args.push('--click-through');
  if (options.hidden) args.push('--hidden');
  if (options.autoClose) args.push('--auto-close');

  const supportsFindInPage = host.platform === 'darwin' || host.platform === 'override';
  if (options.findInPage === true && supportsFindInPage) args.push('--find-in-page');

  const supportsOpenLinks = host.platform === 'darwin' || host.platform === 'override';
  if (options.openLinks && supportsOpenLinks) args.push('--open-links');
  if (options.openLinksApp && supportsOpenLinks) args.push('--open-links-app', options.openLinksApp);

  if (options.followCursor && supportsFollowCursor()) {
    args.push('--follow-cursor');
  } else if (options.followCursor) {
    const { reason } = getFollowCursorSupport();
    process.emitWarning(`followCursor disabled: ${reason}`, { code: 'GLIMPSE_FOLLOW_CURSOR_UNSUPPORTED' });
  }

  if (options.x != null) args.push(`--x=${options.x}`);
  if (options.y != null) args.push(`--y=${options.y}`);

  if (options.cursorOffset?.x != null) args.push(`--cursor-offset-x=${options.cursorOffset.x}`);
  if (options.cursorOffset?.y != null) args.push(`--cursor-offset-y=${options.cursorOffset.y}`);
  if (options.cursorAnchor) args.push('--cursor-anchor', options.cursorAnchor);
  if (options.followMode != null) args.push('--follow-mode', options.followMode);

  const spawnArgs = [...(host.extraArgs || []), ...args];
  const proc = spawn(host.path, spawnArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: process.platform === 'win32',
  });
  forwardNativeStderr(proc);
  return new GlimpseWindow(proc, html, { shared: false });
}

export function open(html, options = {}) {
  if (shouldUseSharedHost(options)) {
    return openShared(html, options);
  }
  return openIsolated(html, options);
}

class GlimpseStatusItem extends GlimpseWindow {
  setTitle(title) {
    this._write({ type: 'title', title });
  }

  resize(width, height) {
    this._write({ type: 'resize', width, height });
  }
}

export function statusItem(html, options = {}) {
  const host = ensureBinary();

  if (host.platform !== 'darwin' && host.platform !== 'linux-chromium') {
    throw new Error(`statusItem() is only supported on macOS and Linux/Chromium (current platform: ${host.platform})`);
  }

  const args = ['--status-item'];
  if (options.width != null) args.push('--width', String(options.width));
  if (options.height != null) args.push('--height', String(options.height));
  if (options.title != null) args.push('--title', options.title);

  const spawnArgs = [...(host.extraArgs || []), ...args];
  const proc = spawn(host.path, spawnArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  forwardNativeStderr(proc);
  return new GlimpseStatusItem(proc, html, { shared: false });
}

export function prompt(html, options = {}) {
  return new Promise((resolve, reject) => {
    const win = open(html, { ...options, autoClose: true });
    let resolved = false;

    const timer = options.timeout
      ? setTimeout(() => {
          if (!resolved) {
            resolved = true;
            win.close();
            reject(new Error('Prompt timed out'));
          }
        }, options.timeout)
      : null;

    win.once('message', (data) => {
      if (!resolved) {
        resolved = true;
        if (timer) clearTimeout(timer);
        resolve(data);
      }
    });

    win.once('closed', () => {
      if (timer) clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        resolve(null);
      }
    });

    win.once('error', (err) => {
      if (timer) clearTimeout(timer);
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
  });
}
