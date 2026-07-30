/**
 * GAPP on-disk storage + version history.
 *
 * Layout:
 *   project:  <cwd>/.pi/gapp/<id>/{meta.json,state.json,index.html,versions/,runs.jsonl}
 *   global:   ~/.pi/gapp/<id>/...
 *   versions: versions/<iso-stamp>/{meta.json,state.json,index.html} + versions/index.json
 */
import { mkdir, writeFile, readFile, readdir, unlink, rename, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

export const ID_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;

export class GappValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "GappValidationError";
  }
}

export function gappGlobalRoot() {
  return process.env.GAPP_GLOBAL_DIR || join(homedir(), ".pi", "gapp");
}

export function gappProjectRoot(cwd = process.cwd()) {
  if (process.env.GAPP_PROJECT_DIR) return process.env.GAPP_PROJECT_DIR;
  return join(cwd, ".pi", "gapp");
}

export function validateGappId(id) {
  const trimmed = String(id).trim().toLowerCase();
  if (!ID_RE.test(trimmed)) {
    throw new GappValidationError(
      `Invalid gapp id "${id}". Use 2-64 chars: [a-z0-9][a-z0-9_-]*`,
    );
  }
  return trimmed;
}

export function slugifyGappId(input) {
  const slug = String(input)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!slug || !ID_RE.test(slug)) {
    throw new GappValidationError(`Cannot derive valid gapp id from "${input}"`);
  }
  return slug;
}

function rootFor(scope, cwd = process.cwd()) {
  return scope === "global" ? gappGlobalRoot() : gappProjectRoot(cwd);
}

export function gappDir(scope, id, cwd = process.cwd()) {
  return join(rootFor(scope, cwd), validateGappId(id));
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

const pathWriteQueues = new Map();
let tempFileSequence = 0;

function enqueuePathWrite(path, operation) {
  const previous = pathWriteQueues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  pathWriteQueues.set(path, next);
  return next.finally(() => {
    if (pathWriteQueues.get(path) === next) pathWriteQueues.delete(path);
  });
}

async function readJsonFile(path) {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function writeJsonFileUnlocked(path, data) {
  const tempPath = `${path}.${process.pid}.${++tempFileSequence}.tmp`;
  try {
    await writeFile(tempPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
    await rename(tempPath, path);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
}

async function writeJsonFile(path, data) {
  return enqueuePathWrite(path, () => writeJsonFileUnlocked(path, data));
}

function hashContent(html, state) {
  return createHash("sha256")
    .update(String(html ?? ""))
    .update("\0")
    .update(JSON.stringify(state ?? {}))
    .digest("hex")
    .slice(0, 16);
}

function normalizeMeta(raw, scope, cwd) {
  const now = new Date().toISOString();
  const id = validateGappId(raw.id);
  return {
    id,
    name: (raw.name || id).trim(),
    description: (raw.description || "").trim(),
    created: raw.created || now,
    updated: raw.updated || now,
    scope,
    enabled: raw.enabled !== false,
    archived: raw.archived === true,
    entry: "index.html",
    stateFile: "state.json",
    width: typeof raw.width === "number" ? raw.width : 900,
    height: typeof raw.height === "number" ? raw.height : 700,
    version: typeof raw.version === "number" ? raw.version : 1,
    contentHash: raw.contentHash || null,
    lastRunAt: raw.lastRunAt || null,
    runCount: typeof raw.runCount === "number" ? raw.runCount : 0,
    ...(scope === "project" ? { cwd } : {}),
  };
}

export async function loadGappMeta(scope, id, cwd = process.cwd()) {
  const dir = gappDir(scope, id, cwd);
  const meta = await readJsonFile(join(dir, "meta.json"));
  if (!meta || typeof meta.id !== "string") return null;
  return meta;
}

export async function loadGappState(scope, id, cwd = process.cwd()) {
  const dir = gappDir(scope, id, cwd);
  return (await readJsonFile(join(dir, "state.json"))) ?? {};
}

export async function loadGappHtml(scope, id, cwd = process.cwd()) {
  const dir = gappDir(scope, id, cwd);
  try {
    return await readFile(join(dir, "index.html"), "utf-8");
  } catch {
    return null;
  }
}

export async function loadGappBundle(scope, id, cwd = process.cwd()) {
  const meta = await loadGappMeta(scope, id, cwd);
  if (!meta) return null;
  const html = await loadGappHtml(scope, id, cwd);
  if (html == null) return null;
  const state = await loadGappState(scope, id, cwd);
  return { meta, state, html, dir: gappDir(scope, id, cwd) };
}

export async function listScope(scope, cwd = process.cwd()) {
  const root = rootFor(scope, cwd);
  let entries = [];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (name.startsWith(".") || name.startsWith("_")) continue;
    const meta = await readJsonFile(join(root, name, "meta.json"));
    if (!meta?.id) continue;
    meta.id = name;
    meta.scope = scope;
    if (scope === "project") meta.cwd = cwd;
    out.push(meta);
  }
  return out;
}

export async function listGapps(options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const project = await listScope("project", cwd);
  const global = await listScope("global", cwd);
  const byId = new Map();
  for (const m of global) byId.set(m.id, m);
  for (const m of project) byId.set(m.id, m);

  let all = [...byId.values()];
  if (options.enabledOnly) {
    all = all.filter((m) => m.enabled && !m.archived);
  } else {
    if (!options.includeArchived) all = all.filter((m) => !m.archived);
    if (!options.includeDisabled) all = all.filter((m) => m.enabled || m.archived);
  }
  return all.sort((a, b) => (b.updated || "").localeCompare(a.updated || ""));
}

export async function listOnlineGapps(cwd = process.cwd()) {
  return listGapps({ cwd, enabledOnly: true, includeArchived: false });
}

export async function resolveGapp(id, cwd = process.cwd()) {
  const safeId = validateGappId(id);
  return (
    (await loadGappBundle("project", safeId, cwd)) ||
    (await loadGappBundle("global", safeId, cwd))
  );
}

/** Snapshot current files into versions/<stamp>/ before overwrite. */
export async function snapshotVersion(dir, reason = "upsert") {
  const meta = await readJsonFile(join(dir, "meta.json"));
  let html = null;
  try {
    html = await readFile(join(dir, "index.html"), "utf-8");
  } catch {
    return null;
  }
  if (!meta || html == null) return null;

  const state = (await readJsonFile(join(dir, "state.json"))) ?? {};
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const versionsRoot = join(dir, "versions");
  const snapDir = join(versionsRoot, stamp);
  await ensureDir(snapDir);

  const contentHash = hashContent(html, state);
  const versionMeta = {
    ...meta,
    snapshotAt: new Date().toISOString(),
    snapshotReason: reason,
    contentHash,
  };

  await writeJsonFile(join(snapDir, "meta.json"), versionMeta);
  await writeJsonFile(join(snapDir, "state.json"), state);
  await writeFile(join(snapDir, "index.html"), html, "utf-8");

  const indexPath = join(versionsRoot, "index.json");
  const index = (await readJsonFile(indexPath)) || { versions: [] };
  index.versions = index.versions || [];
  index.versions.unshift({
    id: stamp,
    at: versionMeta.snapshotAt,
    reason,
    contentHash,
    name: meta.name,
    version: meta.version ?? null,
  });
  // keep last 100
  index.versions = index.versions.slice(0, 100);
  await writeJsonFile(indexPath, index);

  return { stamp, contentHash, dir: snapDir };
}

export async function listVersions(id, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const bundle = options.scope
    ? await loadGappBundle(options.scope, id, cwd)
    : await resolveGapp(id, cwd);
  if (!bundle) return [];
  const index = await readJsonFile(join(bundle.dir, "versions", "index.json"));
  return index?.versions ?? [];
}

export async function loadVersion(id, versionId, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const bundle = options.scope
    ? await loadGappBundle(options.scope, id, cwd)
    : await resolveGapp(id, cwd);
  if (!bundle) return null;
  const snapDir = join(bundle.dir, "versions", versionId);
  const meta = await readJsonFile(join(snapDir, "meta.json"));
  const state = (await readJsonFile(join(snapDir, "state.json"))) ?? {};
  let html;
  try {
    html = await readFile(join(snapDir, "index.html"), "utf-8");
  } catch {
    return null;
  }
  if (!meta) return null;
  return { meta, state, html, dir: snapDir, versionId };
}

export async function restoreVersion(id, versionId, options = {}) {
  const snap = await loadVersion(id, versionId, options);
  if (!snap) throw new GappValidationError(`Version not found: ${versionId}`);
  const cwd = options.cwd ?? process.cwd();
  // snapshot current first
  const current = options.scope
    ? await loadGappBundle(options.scope, id, cwd)
    : await resolveGapp(id, cwd);
  if (current) await snapshotVersion(current.dir, "pre-restore");

  return upsertGapp({
    id: snap.meta.id,
    name: snap.meta.name,
    description: snap.meta.description,
    scope: snap.meta.scope,
    enabled: snap.meta.enabled,
    archived: snap.meta.archived,
    width: snap.meta.width,
    height: snap.meta.height,
    state: snap.state,
    html: snap.html,
    cwd: snap.meta.cwd || cwd,
    skipSnapshot: true,
    bumpVersion: true,
  });
}

export async function upsertGapp(input) {
  const cwd = input.cwd ?? process.cwd();
  const scope = input.scope === "global" ? "global" : "project";
  const id = input.id ? validateGappId(input.id) : slugifyGappId(input.name);
  if (!input.html || !String(input.html).trim()) {
    throw new GappValidationError("html is required");
  }

  const dir = gappDir(scope, id, cwd);
  await ensureDir(dir);

  const existing = await readJsonFile(join(dir, "meta.json"));
  // Snapshot previous revision when content exists and not skipped
  if (existing && !input.skipSnapshot) {
    try {
      await snapshotVersion(dir, input.snapshotReason || "upsert");
    } catch {
      // non-fatal
    }
  }

  const now = new Date().toISOString();
  const contentHash = hashContent(input.html, input.state !== undefined ? input.state : {});
  const prevVersion = typeof existing?.version === "number" ? existing.version : 0;
  const version = input.bumpVersion !== false ? prevVersion + 1 : prevVersion || 1;

  const meta = normalizeMeta(
    {
      id,
      name: input.name,
      description: input.description ?? existing?.description ?? "",
      created: existing?.created,
      updated: now,
      enabled: input.enabled ?? existing?.enabled ?? true,
      archived: input.archived ?? existing?.archived ?? false,
      width: input.width ?? existing?.width,
      height: input.height ?? existing?.height,
      version,
      contentHash,
      lastRunAt: existing?.lastRunAt ?? null,
      runCount: existing?.runCount ?? 0,
    },
    scope,
    cwd,
  );

  const state =
    input.state !== undefined
      ? input.state
      : ((await readJsonFile(join(dir, "state.json"))) ?? {});

  await writeJsonFile(join(dir, "meta.json"), meta);
  await writeJsonFile(join(dir, "state.json"), state);
  await writeFile(join(dir, "index.html"), input.html, "utf-8");

  return { meta, state, html: input.html, dir };
}

export async function setGappState(id, state, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const resolved = options.scope
    ? await loadGappBundle(options.scope, id, cwd)
    : await resolveGapp(id, cwd);
  if (!resolved) throw new GappValidationError(`GAPP not found: ${id}`);

  const scope = resolved.meta.scope;
  const statePath = join(resolved.dir, "state.json");
  return enqueuePathWrite(statePath, async () => {
    const bundle = await loadGappBundle(scope, id, cwd);
    if (!bundle) throw new GappValidationError(`GAPP not found: ${id}`);

    let next = state;
    if (options.merge) {
      const prev = bundle.state;
      if (
        prev &&
        typeof prev === "object" &&
        !Array.isArray(prev) &&
        state &&
        typeof state === "object" &&
        !Array.isArray(state)
      ) {
        next = { ...prev, ...state };
      }
    }

    const meta = { ...bundle.meta, updated: new Date().toISOString() };
    await writeJsonFileUnlocked(statePath, next);
    await writeJsonFile(join(bundle.dir, "meta.json"), meta);
    return { meta, state: next, dir: bundle.dir };
  });
}

export async function setGappStatus(id, status, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const bundle = options.scope
    ? await loadGappBundle(options.scope, id, cwd)
    : await resolveGapp(id, cwd);
  if (!bundle) throw new GappValidationError(`GAPP not found: ${id}`);

  const meta = {
    ...bundle.meta,
    updated: new Date().toISOString(),
    enabled: status.enabled ?? bundle.meta.enabled,
    archived: status.archived ?? bundle.meta.archived,
  };
  if (status.archived === true) meta.enabled = false;
  await writeJsonFile(join(bundle.dir, "meta.json"), meta);
  return meta;
}

export async function recordRun(id, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const bundle = options.scope
    ? await loadGappBundle(options.scope, id, cwd)
    : await resolveGapp(id, cwd);
  if (!bundle) throw new GappValidationError(`GAPP not found: ${id}`);

  const now = new Date().toISOString();
  const meta = {
    ...bundle.meta,
    lastRunAt: now,
    runCount: (bundle.meta.runCount || 0) + 1,
    updated: bundle.meta.updated || now,
  };
  await writeJsonFile(join(bundle.dir, "meta.json"), meta);

  const line = JSON.stringify({
    at: now,
    id: meta.id,
    name: meta.name,
    scope: meta.scope,
    cwd: meta.cwd || cwd,
    version: meta.version,
    contentHash: meta.contentHash,
    source: options.source || "sdk",
  });
  await writeFile(join(bundle.dir, "runs.jsonl"), line + "\n", { flag: "a" });

  // global run log
  const globalLog = join(gappGlobalRoot(), "_runs.jsonl");
  await ensureDir(gappGlobalRoot());
  await writeFile(globalLog, line + "\n", { flag: "a" });

  return meta;
}

export async function listRuns(id, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const bundle = options.scope
    ? await loadGappBundle(options.scope, id, cwd)
    : await resolveGapp(id, cwd);
  if (!bundle) return [];
  try {
    const text = await readFile(join(bundle.dir, "runs.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();
  } catch {
    return [];
  }
}

export async function listGlobalRuns(limit = 100) {
  try {
    const text = await readFile(join(gappGlobalRoot(), "_runs.jsonl"), "utf-8");
    return text
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse()
      .slice(0, limit);
  } catch {
    return [];
  }
}

export async function deleteGapp(id, options = {}) {
  const cwd = options.cwd ?? process.cwd();
  const bundle = options.scope
    ? await loadGappBundle(options.scope, id, cwd)
    : await resolveGapp(id, cwd);
  if (!bundle) return false;
  for (const file of ["meta.json", "state.json", "index.html", "runs.jsonl"]) {
    await unlink(join(bundle.dir, file)).catch(() => {});
  }
  await rm(join(bundle.dir, "versions"), { recursive: true, force: true }).catch(() => {});
  return true;
}

/** Inject GappStore bridge + live state into HTML before opening. */
export function injectGappRuntime(html, meta, state) {
  const bridge = `<script id="gapp-runtime">
window.__GAPP_ID__=${JSON.stringify(meta.id)};
window.__GAPP_META__=${JSON.stringify({ id: meta.id, name: meta.name, scope: meta.scope, version: meta.version ?? null })};
window.__GAPP_STATE__=${JSON.stringify(state ?? {})};
(function(){
  var state = window.__GAPP_STATE__;
  var listeners = [];
  var rpcWaiters = {};
  function emit(){ for (var i=0;i<listeners.length;i++) try{listeners[i](state)}catch(e){} }
  function wireSend(payload){
    payload.v = payload.v || "0.1";
    payload.id = payload.id || window.__GAPP_ID__;
    payload.ts = payload.ts || new Date().toISOString();
    if (window.glimpse && typeof window.glimpse.send === "function") window.glimpse.send(payload);
    else if (window.parent && window.parent !== window) window.parent.postMessage({ __gappEvent: true, event: payload }, "*");
  }
  function persist(reason){ wireSend({ type: "gapp_state", state: state, reason: reason || "set" }); }
  window.GappStore = {
    get: function(){ return state; },
    set: function(partial){
      if (!partial || typeof partial !== "object" || Array.isArray(partial)) throw new Error("GappStore.set expects a plain object");
      state = Object.assign({}, state && typeof state === "object" && !Array.isArray(state) ? state : {}, partial);
      window.__GAPP_STATE__ = state;
      emit(); persist("set");
      return state;
    },
    replace: function(next){
      state = next;
      window.__GAPP_STATE__ = state;
      emit(); persist("replace");
      return state;
    },
    subscribe: function(fn){ if (typeof fn === "function") listeners.push(fn); return function(){ listeners = listeners.filter(function(x){ return x !== fn; }); }; },
    persist: function(){ persist("manual"); }
  };
  window.GappHost = {
    version: "0.1",
    connected: true,
    rpc: function(method, args, options){
      options = options || {};
      if (typeof method !== "string" || !method.trim()) return Promise.reject(new Error("RPC method required"));
      if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) return Promise.reject(new Error("RPC arguments must be an object"));
      var requestId = "rpc_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
      return new Promise(function(resolve, reject){
        var timer = setTimeout(function(){
          if (!rpcWaiters[requestId]) return;
          delete rpcWaiters[requestId];
          reject(new Error("Host RPC timeout"));
        }, options.timeoutMs || 360000);
        rpcWaiters[requestId] = { resolve: resolve, reject: reject, timer: timer };
        wireSend({ type: "gapp_host_request", requestId: requestId, method: method.trim(), arguments: args || {} });
      });
    },
    __dispatch: function(msg){
      if (!msg || msg.type !== "gapp_host_result") return;
      var waiter = rpcWaiters[msg.requestId];
      if (!waiter) return;
      delete rpcWaiters[msg.requestId];
      clearTimeout(waiter.timer);
      if (msg.ok) waiter.resolve(msg.result);
      else waiter.reject(new Error((msg.error && msg.error.message) || "Host RPC failed"));
    }
  };
})();
</script>`;

  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head[^>]*>/i, (m) => m + bridge);
  }
  if (/<html[^>]*>/i.test(html)) {
    return html.replace(/<html[^>]*>/i, (m) => m + `<head>${bridge}</head>`);
  }
  return bridge + html;
}
