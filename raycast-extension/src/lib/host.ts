/**
 * GAPP host daemon client — the single control plane for GAPP windows.
 *
 * This replaces the old Unix control-socket client in `control.ts`: that socket
 * only existed when Glimpse ran in `--host` mode, which nothing ever enabled.
 * The daemon owns the windows it opens, so they outlive the Raycast command
 * process and stay focusable/closeable from later invocations.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
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

async function requestOnce<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const token = readHostToken();
  const hasBody = init?.body !== undefined;
  let response: Response;
  try {
    response = await fetch(`${hostBaseUrl()}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        ...(hasBody ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: hasBody ? JSON.stringify(init?.body) : undefined,
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new DaemonUnreachable(error instanceof Error ? error.message : String(error));
  }
  const payload = (await response.json().catch(() => null)) as {
    ok?: boolean;
    error?: { message?: string };
  } | null;
  if (!response.ok || payload?.ok !== true) {
    throw new Error(payload?.error?.message || `GAPP host HTTP ${response.status}`);
  }
  return payload as T;
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  try {
    return await requestOnce<T>(path, init);
  } catch (error) {
    if (!(error instanceof DaemonUnreachable)) throw error;
    // Nothing is listening: bring the control plane up and retry once.
    await ensureDaemon();
    return await requestOnce<T>(path, init);
  }
}

/** Thrown only for "no one is listening" — response errors never trigger a spawn. */
class DaemonUnreachable extends Error {}

function resolveBun(): string {
  const configured = (process.env.GAPP_BUN_BIN || "").trim();
  if (configured) return configured;
  try {
    const resolved = execFileSync("/usr/bin/which", ["bun"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (resolved) return resolved;
  } catch {
    // fall through to the conventional install path
  }
  return join(homedir(), ".bun", "bin", "bun");
}

async function probeHealth(): Promise<boolean> {
  try {
    const response = await fetch(`${hostBaseUrl()}/health`, {
      signal: AbortSignal.timeout(500),
      // @types/node 20.8 omits undici's `cache` option; the runtime honours it.
      cache: "no-store",
    } as RequestInit);
    const body = (await response.json()) as { service?: string };
    return response.ok && body.service === "gapp-host";
  } catch {
    return false;
  }
}

/**
 * Start the detached host daemon when nothing is listening — same contract the
 * Pi extension uses (`gapp/daemon-manager.ts`), so Raycast can open GAPPs
 * without a Pi session hosting the control plane.
 */
export async function ensureDaemon(): Promise<void> {
  if (await probeHealth()) return;
  const daemonDir =
    process.env.GAPP_DAEMON_DIR || join(homedir(), ".pi", "agent", "extensions", "generative-ui", "gapp");
  const supervisor = join(daemonDir, "daemon-supervisor.ts");
  if (!existsSync(supervisor)) {
    throw new Error(`GAPP host daemon is not running and ${supervisor} is missing`);
  }
  const stateDir = join(homedir(), ".pi", "gapp", "_host");
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const logFd = openSync(join(stateDir, "gapp-host.log"), "a", 0o600);
  const bun = resolveBun();
  const child = spawn(bun, [supervisor], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      GAPP_HOST_STATE_DIR: stateDir,
      GAPP_BUN_BIN: bun,
    },
  });
  // A failed detached spawn would otherwise surface as an unhandled error.
  child.once("error", () => {});
  child.unref();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await probeHealth()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`GAPP host daemon did not become healthy; see ${join(stateDir, "gapp-host.log")}`);
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
