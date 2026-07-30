/**
 * Client for the macOS Glimpse host control Unix socket.
 * Used by `glimpse-ctl` CLI and the Raycast extension.
 */
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export function controlSocketPath() {
  if (process.env.GLIMPSE_CONTROL_SOCK) return process.env.GLIMPSE_CONTROL_SOCK;
  return join(homedir(), 'Library/Application Support/dev.glimpse.ui/control.sock');
}

export function isControlSocketAvailable(path = controlSocketPath()) {
  return existsSync(path);
}

/**
 * Send one JSON command and wait for one JSON response line.
 * @param {{ type: string, [key: string]: any }} command
 * @param {{ timeoutMs?: number, socketPath?: string }} [opts]
 */
export function controlRequest(command, opts = {}) {
  const socketPath = opts.socketPath || controlSocketPath();
  const timeoutMs = opts.timeoutMs ?? 2000;

  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
      reject(Object.assign(new Error(`Glimpse host not running (no socket at ${socketPath})`), { code: 'ENOHOST' }));
      return;
    }

    const client = net.createConnection(socketPath);
    let buf = '';
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      if (err) reject(err);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      finish(Object.assign(new Error('control socket timeout'), { code: 'ETIMEDOUT' }));
    }, timeoutMs);

    client.on('connect', () => {
      client.write(JSON.stringify(command) + '\n');
    });

    client.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl === -1) return;
      const line = buf.slice(0, nl).trim();
      try {
        finish(null, JSON.parse(line));
      } catch (e) {
        finish(new Error(`invalid control response: ${line}`));
      }
    });

    client.on('error', (err) => finish(err));
    client.on('end', () => {
      if (!settled && buf.trim()) {
        try {
          finish(null, JSON.parse(buf.trim()));
        } catch {
          finish(new Error('connection closed before valid response'));
        }
      } else if (!settled) {
        finish(new Error('connection closed before response'));
      }
    });
  });
}

export async function listWindows(opts) {
  const res = await controlRequest({ type: 'list' }, opts);
  if (res.type === 'error') throw new Error(res.message || 'list failed');
  return res;
}

export async function focusWindow(id, opts) {
  const res = await controlRequest({ type: 'focus', id }, opts);
  if (res.type === 'error') throw new Error(res.message || 'focus failed');
  return res;
}

export async function closeWindow(id, opts) {
  const res = await controlRequest({ type: 'close', id }, opts);
  if (res.type === 'error') throw new Error(res.message || 'close failed');
  return res;
}

export async function ping(opts) {
  return controlRequest({ type: 'ping' }, opts);
}
