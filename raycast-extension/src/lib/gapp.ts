/**
 * Thin client over @glimpse/gapp-sdk for Raycast (no Pi runtime).
 */
import { pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export type GappMeta = {
  id: string;
  name: string;
  description?: string;
  scope: "project" | "global";
  enabled: boolean;
  archived: boolean;
  version?: number;
  runCount?: number;
  lastRunAt?: string | null;
  updated?: string;
  cwd?: string;
  width?: number;
  height?: number;
};

export type CatalogSection = {
  key: string;
  label: string;
  cwd: string | null;
  scope: string;
  lastSeen?: string;
  apps: GappMeta[];
};

export type VersionEntry = {
  id: string;
  at: string;
  reason: string;
  contentHash?: string;
  name?: string;
  version?: number | null;
};

let sdkPromise: Promise<any> | null = null;

function sdkEntryCandidates(): string[] {
  const list = [
    process.env.GAPP_SDK_PATH,
    join(homedir(), "Dev/AI/glimpse/gapp-sdk/src/index.mjs"),
    join(homedir(), "Dev/glimpse/gapp-sdk/src/index.mjs"),
  ].filter(Boolean) as string[];
  return list;
}

export async function loadGappSdk(): Promise<any> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = (async () => {
    for (const c of sdkEntryCandidates()) {
      if (existsSync(c)) {
        return import(pathToFileURL(c).href);
      }
    }
    throw new Error(
      "gapp-sdk not found. Expected ~/Dev/AI/glimpse/gapp-sdk (set GAPP_SDK_PATH to override).",
    );
  })();
  return sdkPromise;
}

export async function catalogGapps(opts?: {
  includeArchived?: boolean;
  includeDisabled?: boolean;
}): Promise<CatalogSection[]> {
  const sdk = await loadGappSdk();
  return sdk.catalogGapps({
    includeArchived: opts?.includeArchived === true,
    includeDisabled: opts?.includeDisabled === true,
  });
}

export async function runGapp(
  id: string,
  opts?: { cwd?: string; scope?: string; versionId?: string },
): Promise<void> {
  const sdk = await loadGappSdk();
  // Fire-and-forget open; do not block Raycast on window close
  const { win } = await sdk.runGapp(id, {
    cwd: opts?.cwd,
    scope: opts?.scope,
    versionId: opts?.versionId,
    source: "raycast",
  });
  // Detach — Raycast command can exit while window stays open
  win.on("closed", () => {});
}

export async function listVersions(id: string, cwd?: string): Promise<VersionEntry[]> {
  const sdk = await loadGappSdk();
  return sdk.listVersions(id, { cwd });
}

export async function restoreVersion(id: string, versionId: string, cwd?: string) {
  const sdk = await loadGappSdk();
  return sdk.restoreVersion(id, versionId, { cwd });
}

export async function setGappStatus(
  id: string,
  status: { enabled?: boolean; archived?: boolean },
  cwd?: string,
) {
  const sdk = await loadGappSdk();
  return sdk.setGappStatus(id, status, { cwd });
}

export async function listGlobalRuns(limit = 50) {
  const sdk = await loadGappSdk();
  return sdk.listGlobalRuns(limit);
}

export async function listRuns(id: string, cwd?: string) {
  const sdk = await loadGappSdk();
  return sdk.listRuns(id, { cwd });
}

export function projectLabel(cwd: string | null | undefined): string {
  if (!cwd) return "Global";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
