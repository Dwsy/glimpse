/**
 * Multi-project GAPP registry — enables Raycast / CLI to list apps across projects
 * without requiring the Pi agent runtime.
 *
 * File: ~/.pi/gapp/_registry.json
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { gappGlobalRoot, gappProjectRoot, listScope } from "./storage.mjs";

const REGISTRY_VERSION = 1;

function registryPath() {
  return join(gappGlobalRoot(), "_registry.json");
}

async function ensureGlobalRoot() {
  await mkdir(gappGlobalRoot(), { recursive: true });
}

async function readRegistry() {
  try {
    const data = JSON.parse(await readFile(registryPath(), "utf-8"));
    if (!data || typeof data !== "object") throw new Error("bad");
    return {
      version: REGISTRY_VERSION,
      projects: Array.isArray(data.projects) ? data.projects : [],
      updated: data.updated || null,
    };
  } catch {
    return { version: REGISTRY_VERSION, projects: [], updated: null };
  }
}

async function writeRegistry(reg) {
  await ensureGlobalRoot();
  reg.version = REGISTRY_VERSION;
  reg.updated = new Date().toISOString();
  await writeFile(registryPath(), JSON.stringify(reg, null, 2) + "\n", "utf-8");
  return reg;
}

/**
 * Remember a project cwd that has GAPPs (call on upsert/open).
 */
export async function touchProject(cwd, meta = {}) {
  if (!cwd) return readRegistry();
  const reg = await readRegistry();
  const now = new Date().toISOString();
  const abs = cwd;
  const existing = reg.projects.find((p) => p.cwd === abs);
  if (existing) {
    existing.lastSeen = now;
    if (meta.name) existing.name = meta.name;
    existing.hitCount = (existing.hitCount || 0) + 1;
  } else {
    reg.projects.push({
      cwd: abs,
      name: meta.name || abs.split("/").pop() || abs,
      firstSeen: now,
      lastSeen: now,
      hitCount: 1,
    });
  }
  reg.projects.sort((a, b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
  reg.projects = reg.projects.slice(0, 200);
  return writeRegistry(reg);
}

export async function listRegisteredProjects() {
  const reg = await readRegistry();
  return reg.projects.filter((p) => p.cwd && existsSync(p.cwd));
}

function filterApps(apps, options = {}) {
  const includeArchived = options.includeArchived === true;
  const includeDisabled = options.includeDisabled === true;
  return apps.filter((m) => {
    if (!includeArchived && m.archived) return false;
    if (!includeDisabled && !m.enabled && !m.archived) return false;
    return true;
  });
}

/**
 * Catalog: group GAPPs by project (cwd) + global.
 * Each entry: { key, label, cwd|null, scope, apps: GappMeta[] }
 */
export async function catalogGapps(options = {}) {
  const sections = [];

  const pureGlobal = filterApps(await listScope("global"), options);
  if (pureGlobal.length || options.includeEmpty) {
    sections.push({
      key: "global",
      label: "Global",
      cwd: null,
      scope: "global",
      apps: pureGlobal.sort((a, b) => (b.updated || "").localeCompare(a.updated || "")),
    });
  }

  const projects = await listRegisteredProjects();
  const cwdSet = new Set(projects.map((p) => p.cwd));
  const current = options.cwd || process.cwd();
  if (current && !cwdSet.has(current) && existsSync(gappProjectRoot(current))) {
    projects.unshift({
      cwd: current,
      name: current.split("/").pop() || current,
      lastSeen: new Date().toISOString(),
      hitCount: 0,
    });
  }

  for (const proj of projects) {
    if (!existsSync(proj.cwd)) continue;
    const apps = filterApps(await listScope("project", proj.cwd), options);
    if (!apps.length && !options.includeEmpty) continue;
    sections.push({
      key: `project:${proj.cwd}`,
      label: proj.name || proj.cwd.split("/").pop() || proj.cwd,
      cwd: proj.cwd,
      scope: "project",
      lastSeen: proj.lastSeen,
      apps: apps.sort((a, b) => (b.updated || "").localeCompare(a.updated || "")),
    });
  }

  return sections;
}
