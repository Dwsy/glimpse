/**
 * Isolated GAPP runner — opens a GAPP with glimpseui without Pi agent.
 * Works from Raycast, CLI, other tools.
 */
import { pathToFileURL } from "node:url";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { realpathSync } from "node:fs";
import {
  resolveGapp,
  loadVersion,
  injectGappRuntime,
  setGappState,
  recordRun,
  GappValidationError,
} from "./storage.mjs";
import { touchProject } from "./registry.mjs";

const DEFAULT_GAPP_HOST_BASE = "http://127.0.0.1:54888";
const HOST_RPC_TIMEOUT_MS = 130_000;
const HOST_LEASE_TIMEOUT_MS = 5_000;
const DEFAULT_HOST_TOKEN_PATH = join(homedir(), ".pi", "gapp", "host-token");

/** Same bearer token the GAPP host daemon issues (see generative-ui/gapp/auth.ts). */
export function readHostToken() {
  const fromEnv = (process.env.GAPP_HOST_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const path = process.env.GAPP_HOST_TOKEN_PATH || DEFAULT_HOST_TOKEN_PATH;
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function hostHeaders(extra = {}) {
  const token = readHostToken();
  return token ? { ...extra, Authorization: `Bearer ${token}` } : { ...extra };
}

export class GappLeaseError extends Error {
  constructor(message, lease) {
    super(message);
    this.name = "GappLeaseError";
    this.code = "already_connected";
    this.lease = lease;
  }
}

/**
 * Take the host lease for this app so instances=single holds across processes.
 * Returns a no-op release when no host is reachable: the isolated runner then
 * degrades to a plain window opener instead of failing.
 */
export async function acquireRunnerLease(bundle, appCwd, hostBase, sessionId) {
  const url = `${hostBase}/v1/gapp/leases/${encodeURIComponent(bundle.meta.id)}`;
  const body = JSON.stringify({
    sessionId,
    instances: bundle.meta.instances === "multi" ? "multi" : "single",
    host: hostBase,
    cwd: appCwd,
    scope: bundle.meta.scope,
    pid: process.pid,
    hasWindow: true,
  });
  let payload;
  try {
    const response = await fetch(url, {
      method: "PUT",
      headers: hostHeaders({ "Content-Type": "application/json" }),
      body,
      signal: AbortSignal.timeout(HOST_LEASE_TIMEOUT_MS),
    });
    payload = await response.json().catch(() => null);
    if (response.ok && payload?.ok === true) {
      return {
        ok: true,
        release: async () => {
          await fetch(url, {
            method: "DELETE",
            headers: hostHeaders({ "Content-Type": "application/json" }),
            body: JSON.stringify({ sessionId }),
            signal: AbortSignal.timeout(HOST_LEASE_TIMEOUT_MS),
          }).catch(() => {});
        },
      };
    }
  } catch {
    return { ok: true, release: async () => {} };
  }
  if (payload?.code === "already_connected") {
    throw new GappLeaseError(
      payload.message || `GAPP "${bundle.meta.id}" is already live in another session`,
      payload.lease,
    );
  }
  return { ok: true, release: async () => {} };
}

function normalizeHostBase(value) {
  const url = new URL(String(value || DEFAULT_GAPP_HOST_BASE));
  const hosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (url.protocol !== "http:" || !hosts.has(url.hostname.toLowerCase())) {
    throw new Error("GAPP Host must use loopback HTTP");
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("GAPP Host URL cannot include credentials, path, query, or fragment");
  }
  return url.origin;
}

async function resolveGlimpseui() {
  const candidates = [];
  if (process.env.GLIMPSEUI_PATH) candidates.push(process.env.GLIMPSEUI_PATH);
  if (process.env.GLIMPSE_PACKAGE) candidates.push(process.env.GLIMPSE_PACKAGE);
  candidates.push(join(homedir(), "Dev/AI/glimpse"));
  candidates.push(join(homedir(), "Dev/glimpse"));
  try {
    const { execSync } = await import("node:child_process");
    const g = execSync("npm root -g", { encoding: "utf8", timeout: 2000 }).trim();
    candidates.push(join(g, "glimpseui"));
  } catch {
    // ignore
  }
  candidates.push("/opt/homebrew/lib/node_modules/glimpseui");

  for (const c of candidates) {
    try {
      const root = existsSync(c) ? realpathSync(c) : c;
      const entry = join(root, "src/glimpse.mjs");
      if (existsSync(entry)) {
        return import(pathToFileURL(entry).href);
      }
      const pkg = join(root, "package.json");
      if (existsSync(pkg)) {
        // try package main
        const main = join(root, "src/glimpse.mjs");
        if (existsSync(main)) return import(pathToFileURL(main).href);
      }
    } catch {
      // continue
    }
  }

  try {
    return await import("glimpseui");
  } catch (e) {
    throw new Error(
      `glimpseui not found. npm i -g ~/Dev/AI/glimpse  or set GLIMPSEUI_PATH (${e.message})`,
    );
  }
}

function dispatchHostResult(win, message) {
  win.send(`window.GappHost&&window.GappHost.__dispatch(${JSON.stringify(message)})`);
}

async function proxyHostRpc(win, data, meta, cwd, hostBase) {
  const requestId = String(data.requestId || "");
  const method = String(data.method || "").trim();
  const args = data.arguments ?? {};
  if (!requestId || !method || !args || typeof args !== "object" || Array.isArray(args)) {
    dispatchHostResult(win, {
      type: "gapp_host_result",
      requestId,
      ok: false,
      error: { code: "invalid_args", message: "Invalid Host RPC request" },
    });
    return;
  }

  try {
    const response = await fetch(`${hostBase}/v1/gapp/apps/${encodeURIComponent(meta.id)}/rpc`, {
      method: "POST",
      headers: hostHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        method,
        arguments: args,
        cwd,
        sessionId: `isolated-${process.pid}`,
      }),
      signal: AbortSignal.timeout(HOST_RPC_TIMEOUT_MS),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok || payload?.ok !== true) {
      throw new Error(payload?.error?.message || payload?.error || `GAPP Host HTTP ${response.status}`);
    }
    dispatchHostResult(win, {
      type: "gapp_host_result",
      requestId,
      ok: true,
      result: payload.result,
    });
  } catch (error) {
    dispatchHostResult(win, {
      type: "gapp_host_result",
      requestId,
      ok: false,
      error: {
        code: "host_unavailable",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}

export function attachMessageRouter(win, meta, cwd, hostBase) {
  win.on("message", (data) => {
    if (!data || typeof data !== "object") return;
    if (data.id && data.id !== meta.id) return;
    if (data.type === "gapp_state") {
      void setGappState(meta.id, data.state, { scope: meta.scope, cwd, merge: false }).catch(() => {});
      return;
    }
    if (data.type === "gapp_host_request") {
      void proxyHostRpc(win, data, meta, cwd, hostBase);
    }
  });
}

export function gappWindowOptions(meta, title) {
  return {
    width: meta.width ?? 900,
    height: meta.height ?? 700,
    title,
    frameless: meta.frameless === true,
    transparent: meta.transparent === true,
    floating: meta.floating === true,
    clickThrough: meta.clickThrough === true,
    autoClose: meta.autoClose === true,
    openLinks: meta.openLinks === true,
    openLinksApp: meta.openLinksApp,
  };
}

/**
 * Open a GAPP in a Glimpse window (isolated from Pi).
 * @param {string} id
 * @param {{ cwd?: string, scope?: string, versionId?: string, source?: string, keepAlive?: boolean, hostBase?: string, sessionId?: string, skipLease?: boolean }} [options]
 * @returns {Promise<{ win: any, meta: any, dir: string }>}
 */
export async function runGapp(id, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  let bundle;
  let versionId = options.versionId || null;

  if (versionId) {
    const snap = await loadVersion(id, versionId, { cwd, scope: options.scope });
    if (!snap) throw new GappValidationError(`Version not found: ${versionId}`);
    bundle = {
      meta: { ...snap.meta, cwd: snap.meta.cwd || cwd },
      state: snap.state,
      html: snap.html,
      dir: snap.dir,
    };
  } else {
    bundle = options.scope
      ? await (await import("./storage.mjs")).loadGappBundle(options.scope, id, cwd)
      : await resolveGapp(id, cwd);
  }

  if (!bundle) throw new GappValidationError(`GAPP not found: ${id}`);

  const appCwd = bundle.meta.cwd || cwd;
  const hostBase = normalizeHostBase(options.hostBase || process.env.GAPP_HOST_BASE);
  // Lease before spawning the window: refuse instead of opening a second live
  // connection to a strong-state app.
  const sessionId = options.sessionId || `sdk-${process.pid}`;
  const lease = options.skipLease
    ? { release: async () => {} }
    : await acquireRunnerLease(bundle, appCwd, hostBase, sessionId);

  const { open } = await resolveGlimpseui();
  const html = injectGappRuntime(bundle.html, bundle.meta, bundle.state);

  const prev = process.env.OS_ACTIVITY_MODE;
  process.env.OS_ACTIVITY_MODE = "disable";
  let win;
  try {
    const title = versionId
      ? `${bundle.meta.name} @ ${versionId.slice(0, 19)}`
      : bundle.meta.name || bundle.meta.id;
    win = open(html, gappWindowOptions(bundle.meta, title));
  } finally {
    if (prev === undefined) delete process.env.OS_ACTIVITY_MODE;
    else process.env.OS_ACTIVITY_MODE = prev;
  }

  attachMessageRouter(win, bundle.meta, appCwd, hostBase);
  win.on("closed", () => {
    void lease.release();
  });

  if (bundle.meta.scope === "project" && appCwd) {
    await touchProject(appCwd, { name: appCwd.split("/").pop() });
  }

  if (!versionId) {
    await recordRun(bundle.meta.id, {
      scope: bundle.meta.scope,
      cwd: appCwd,
      source: options.source || "sdk-runner",
    }).catch(() => {});
  }

  return { win, meta: bundle.meta, dir: bundle.dir, versionId };
}

/**
 * Run and optionally wait until window closes (CLI helper).
 */
export async function runGappUntilClosed(id, options = {}) {
  const { win, meta, dir, versionId } = await runGapp(id, options);
  await new Promise((resolve) => {
    win.on("closed", resolve);
    // safety timeout only if requested
    if (options.timeoutMs) {
      setTimeout(resolve, options.timeoutMs);
    }
  });
  return { meta, dir, versionId };
}
