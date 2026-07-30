import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const APP_PATH = '/Applications/Chrome Debug.app';
const TIMEOUT_MS = 10_000;

const tmpDir = mkdtempSync(join(tmpdir(), 'glimpse-open-links-'));
const argsPath = join(tmpDir, 'args.json');
const mockBinary = join(tmpDir, 'glimpse-mock');

console.log('glimpse open-links flag regression test');

function pass(msg) {
  console.log(`  ✓ ${msg}`);
}

function fail(msg) {
  console.error(`  ✗ ${msg}`);
  throw new Error(msg);
}

function waitFor(emitter, event, timeoutMs = TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for '${event}' after ${timeoutMs}ms`));
    }, timeoutMs);

    emitter.once(event, (...args) => {
      clearTimeout(timer);
      resolve(args);
    });

    emitter.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function writeMockBinary() {
  const protocolReady = JSON.stringify({
    type: 'ready',
    screen: { width: 800, height: 600, scaleFactor: 1, visibleX: 0, visibleY: 0, visibleWidth: 800, visibleHeight: 600 },
    screens: [],
    appearance: { darkMode: false, accentColor: '#000000', reduceMotion: false, increaseContrast: false },
    cursor: { x: 0, y: 0 },
  });
  const scriptLines = [
    '#!/usr/bin/env node',
    "const fs = require('node:fs');",
    "const readline = require('node:readline');",
    "const argsPath = process.env.GLIMPSE_OPEN_LINKS_ARGS;",
    "if (argsPath) fs.writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));",
    "process.stderr.write('2026-07-30 glimpse[1:1] error messaging the mach port for IMKCFRunLoopWakeUpReliable\\n');",
    "process.stderr.write('[glimpse] expected diagnostic\\n');",
    `process.stdout.write(${JSON.stringify(protocolReady)} + '\\n');`,
    'let sentFinalReady = false;',
    'const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });',
    'rl.on("line", (line) => {',
    '  try {',
    '    const msg = JSON.parse(line);',
    '    if (msg?.type === "html" && !sentFinalReady) {',
    '      process.stdout.write(' + JSON.stringify(protocolReady) + ' + "\\n");',
    '      sentFinalReady = true;',
    '    }',
    '    if (msg?.type === "close") {',
    '      process.stdout.write(JSON.stringify({ type: "closed" }) + "\\n");',
    '      process.exit(0);',
    '    }',
    '  } catch {',
    '    // Ignore malformed JSON from this fixture.',
    '  }',
    '});',
  ];

  writeFileSync(mockBinary, scriptLines.join('\n'));
  chmodSync(mockBinary, 0o755);
}

async function openMockWindow(options) {
  const { open } = await import('../src/glimpse.mjs');
  const win = open('<body><a href="https://example.com">example</a></body>', options);
  await waitFor(win, 'ready');
  win.close();
  await waitFor(win, 'closed');
  return JSON.parse(readFileSync(argsPath, 'utf8'));
}

async function captureStderr(run) {
  const originalWrite = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk) => {
    captured += String(chunk);
    return true;
  };
  try {
    await run();
    return captured;
  } finally {
    process.stderr.write = originalWrite;
  }
}

try {
  writeMockBinary();
  process.env.GLIMPSE_BINARY_PATH = mockBinary;
  process.env.GLIMPSE_OPEN_LINKS_ARGS = argsPath;

  const stderr = await captureStderr(async () => {
    let args = await openMockWindow({ openLinks: true });
    if (!args.includes('--open-links')) fail('expected --open-links flag');
    if (args.includes('--open-links-app')) fail('did not expect --open-links-app when only openLinks=true');
    pass('mapped openLinks -> --open-links');

    args = await openMockWindow({ openLinksApp: APP_PATH });
    if (!args.includes('--open-links-app')) fail('expected --open-links-app flag');
    if (!args.includes(APP_PATH)) fail(`expected custom app path argument (${APP_PATH})`);
    if (args.includes('--open-links')) fail('did not expect explicit --open-links when only openLinksApp is set');
    pass('mapped openLinksApp -> --open-links-app');
  });

  if (stderr.includes('IMKCFRunLoopWakeUpReliable')) fail('expected IMK warning to be suppressed');
  if (!stderr.includes('[glimpse] expected diagnostic')) fail('expected normal native stderr to be forwarded');
  pass('suppressed IMK warning without hiding diagnostics');

  pass('open-links args mapping verified');
  console.log('\nopen-links test passed');
} finally {
  rmSync(tmpDir, { recursive: true, force: true });
}
