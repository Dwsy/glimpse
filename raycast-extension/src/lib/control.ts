import net from "node:net";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface GlimpseWindow {
  id: string;
  title: string;
  active: boolean;
  visible: boolean;
  miniaturized: boolean;
  floating: boolean;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ListResponse {
  type: "list";
  pid: number;
  windows: GlimpseWindow[];
}

export function controlSocketPath(): string {
  if (process.env.GLIMPSE_CONTROL_SOCK) return process.env.GLIMPSE_CONTROL_SOCK;
  return join(homedir(), "Library/Application Support/dev.glimpse.ui/control.sock");
}

export function isHostRunning(): boolean {
  return existsSync(controlSocketPath());
}

function request(command: Record<string, unknown>, timeoutMs = 2000): Promise<Record<string, unknown>> {
  const socketPath = controlSocketPath();
  return new Promise((resolve, reject) => {
    if (!existsSync(socketPath)) {
      reject(new Error("Glimpse host is not running. Open a Glimpse window first."));
      return;
    }

    const client = net.createConnection(socketPath);
    let buf = "";
    let settled = false;

    const done = (err?: Error, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.destroy();
      if (err) reject(err);
      else resolve(value!);
    };

    const timer = setTimeout(() => done(new Error("Timed out talking to Glimpse host")), timeoutMs);

    client.on("connect", () => {
      client.write(JSON.stringify(command) + "\n");
    });

    client.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      try {
        done(undefined, JSON.parse(buf.slice(0, nl).trim()));
      } catch {
        done(new Error("Invalid response from Glimpse host"));
      }
    });

    client.on("error", (err) => done(err));
    client.on("end", () => {
      if (!settled && buf.trim()) {
        try {
          done(undefined, JSON.parse(buf.trim()));
        } catch {
          done(new Error("Connection closed before valid response"));
        }
      } else if (!settled) {
        done(new Error("Connection closed before response"));
      }
    });
  });
}

export async function listWindows(): Promise<ListResponse> {
  const res = await request({ type: "list" });
  if (res.type === "error") throw new Error(String(res.message || "list failed"));
  return res as unknown as ListResponse;
}

export async function focusWindow(id: string): Promise<void> {
  const res = await request({ type: "focus", id });
  if (res.type === "error") throw new Error(String(res.message || "focus failed"));
}

export async function closeWindow(id: string): Promise<void> {
  const res = await request({ type: "close", id });
  if (res.type === "error") throw new Error(String(res.message || "close failed"));
}
