/**
 * Raycast-side GAPP client (no Pi runtime).
 *
 * Disk stays SSOT for catalog, version history and run history, but `gapp-sdk`
 * is bundled into every command at build time: Tinycast runs bundles on
 * JavaScriptCore, which has no ESM loader, so a runtime `import()` of
 * `gapp-sdk/src/index.mjs` fails with "No module loader provided".
 *
 * Window lifecycle goes through the GAPP host daemon so windows outlive the
 * Raycast command process and honor `instances` leases.
 */
import {
  listGlobalRuns as sdkListGlobalRuns,
  listRuns as sdkListRuns,
  listVersions as sdkListVersions,
  restoreVersion as sdkRestoreVersion,
  setGappStatus as sdkSetGappStatus,
} from "../../../gapp-sdk/src/storage.mjs";
import { catalogGapps as sdkCatalogGapps } from "../../../gapp-sdk/src/registry.mjs";
import { hostOpen } from "./host";

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

export type GappRun = {
  at: string;
  id: string;
  name?: string;
  scope?: string;
  cwd?: string;
  version?: number | null;
  contentHash?: string;
  source?: string;
};

export async function catalogGapps(opts?: {
  includeArchived?: boolean;
  includeDisabled?: boolean;
}): Promise<CatalogSection[]> {
  return sdkCatalogGapps({
    includeArchived: opts?.includeArchived === true,
    includeDisabled: opts?.includeDisabled === true,
  });
}

export async function runGapp(
  id: string,
  opts?: { cwd?: string; scope?: string; versionId?: string },
): Promise<void> {
  // Daemon-owned window: lease-checked, and still focusable after this command
  // process exits.
  await hostOpen(id, {
    cwd: opts?.cwd,
    scope: opts?.scope,
    versionId: opts?.versionId,
    source: "raycast",
  });
}

export async function listVersions(id: string, cwd?: string): Promise<VersionEntry[]> {
  return sdkListVersions(id, { cwd });
}

export async function restoreVersion(id: string, versionId: string, cwd?: string) {
  return sdkRestoreVersion(id, versionId, { cwd });
}

export async function setGappStatus(
  id: string,
  status: { enabled?: boolean; archived?: boolean },
  cwd?: string,
) {
  return sdkSetGappStatus(id, status, { cwd });
}

export async function listGlobalRuns(limit = 50): Promise<GappRun[]> {
  return sdkListGlobalRuns(limit);
}

export async function listRuns(id: string, cwd?: string): Promise<GappRun[]> {
  return sdkListRuns(id, { cwd });
}

export function projectLabel(cwd: string | null | undefined): string {
  if (!cwd) return "Global";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || cwd;
}
