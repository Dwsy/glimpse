/**
 * GAPP host daemon client — the single control plane for GAPP windows.
 *
 * This replaces the old Unix control-socket client in `control.ts`: that socket
 * only existed when Glimpse ran in `--host` mode, which nothing ever enabled.
 * The daemon owns the windows it opens, so they outlive the Raycast command
 * process and stay focusable/closeable from later invocations.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type HostLiveApp = {
  appId: string;
  sessionId: string;
  cwd?: string;
  scope?: string;
  instances?: string;
  tools?: string[];
  hasWindow?: boolean;
  source?: "local" | "pi-bridge";
};

export type HostLease = {
  appId: string;
  sessionId: string;
  pid: number;
  openedAt: string;
  instances?: string;
};

export type HostCatalog = {
  ok: true;
  port: number;
  live: HostLiveApp[];
  leases: HostLease[];
  sessions: { sessionId: string; cwd?: string; bridgeBase?: string }[];
};

export function hostBaseUrl(): string {
  return process.env.GAPP_HOST_BASE || "http://127.0.0.1:54888";
}

/** Same bearer token the daemon issues (0600, ~/.pi/gapp/host-token). */
export function readHostToken(): string | null {
  const fromEnv = (process.env.GAPP_HOST_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    const path = process.env.GAPP_HOST_TOKEN_PATH || join(homedir(), ".pi", "gapp", "host-token");
    return readFileSync(path, "utf8").trim() || null;
  } catch {
    return null;
  }
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = readHostToken();
  const hasBody = init?.body !== undefined;
  const response = await fetch(`${hostBaseUrl()}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      ...(hasBody ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: hasBody ? JSON.stringify(init?.body) : undefined,
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || `GAPP host HTTP ${response.status}`);
  }
  return payload as T;
}

export async function hostCatalog(): Promise<HostCatalog> {
  return request<HostCatalog>("/v1/gapp");
}

/** Open (or reopen) a GAPP window owned by the daemon. */
export async function hostOpen(
  appId: string,
  options: { cwd?: string; scope?: string; versionId?: string; source?: string } = {},
): Promise<void> {
  await request(`/v1/gapp/apps/${encodeURIComponent(appId)}/open`, {
    method: "POST",
    body: {
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.versionId ? { versionId: options.versionId } : {}),
      source: options.source || "raycast",
    },
  });
}

export async function hostWindow(appId: string, action: "focus" | "close"): Promise<void> {
  await request(`/v1/gapp/apps/${encodeURIComponent(appId)}/window`, {
    method: "POST",
    body: { action },
  });
}
