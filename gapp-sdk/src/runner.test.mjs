import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createServer } from "node:http";
import { injectGappRuntime } from "./storage.mjs";
import { attachMessageRouter, gappWindowOptions, acquireRunnerLease } from "./runner.mjs";

test("GAPP window metadata reaches Glimpse open options", () => {
  assert.deepEqual(
    gappWindowOptions(
      {
        width: 1180,
        height: 820,
        transparent: true,
        frameless: false,
        floating: true,
        clickThrough: true,
        autoClose: true,
        openLinks: true,
        openLinksApp: "/Applications/Safari.app",
      },
      "Glaze SDK Gallery",
    ),
    {
      width: 1180,
      height: 820,
      title: "Glaze SDK Gallery",
      frameless: false,
      transparent: true,
      floating: true,
      clickThrough: true,
      autoClose: true,
      openLinks: true,
      openLinksApp: "/Applications/Safari.app",
    },
  );
});

async function waitFor(check, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for condition");
}

test("injected runtime exposes native Host RPC", async () => {
  const html = injectGappRuntime("<main></main>", { id: "demo", name: "Demo", scope: "project" }, {});
  const script = html.match(/<script id="gapp-runtime">([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);

  const messages = [];
  const window = { glimpse: { send: (message) => messages.push(message) } };
  vm.runInContext(script, vm.createContext({ window, setTimeout, clearTimeout, Date, Math, Promise, Error, Object, Array, String }));

  const resultPromise = window.GappHost.rpc("echo", { value: 7 }, { timeoutMs: 1000 });
  const request = messages.at(-1);
  assert.equal(request.type, "gapp_host_request");
  assert.equal(request.method, "echo");
  assert.deepEqual(request.arguments, { value: 7 });

  window.GappHost.__dispatch({
    type: "gapp_host_result",
    requestId: request.requestId,
    ok: true,
    result: { value: 7 },
  });
  assert.deepEqual(await resultPromise, { value: 7 });
});

test("isolated runner forwards Host RPC through Node", async (t) => {
  process.env.GAPP_HOST_TOKEN = "test-runner-token";
  t.after(() => delete process.env.GAPP_HOST_TOKEN);
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = {
      url: request.url,
      auth: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: { frames: [] } }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;

  const handlers = {};
  const scripts = [];
  const win = {
    on: (event, handler) => { handlers[event] = handler; },
    send: (script) => scripts.push(script),
  };
  attachMessageRouter(
    win,
    { id: "ngrok-native-inspector", scope: "project" },
    "/tmp/project",
    `http://127.0.0.1:${port}`,
  );

  handlers.message({
    type: "gapp_host_request",
    id: "ngrok-native-inspector",
    requestId: "rpc-test",
    method: "ngrok.unary",
    arguments: { method: "Preloaded" },
  });

  await waitFor(() => scripts[0]);
  assert.equal(received.url, "/v1/gapp/apps/ngrok-native-inspector/rpc");
  // The host rejects tokenless calls with 401; the runner must carry the bearer token.
  assert.equal(received.auth, "Bearer test-runner-token");
  assert.equal(received.body.method, "ngrok.unary");
  assert.equal(received.body.cwd, "/tmp/project");

  const dispatched = JSON.parse(scripts[0].match(/__dispatch\((.*)\)$/s)[1]);
  assert.equal(dispatched.requestId, "rpc-test");
  assert.equal(dispatched.ok, true);
  assert.deepEqual(dispatched.result, { frames: [] });
});

test("runner lease: already_connected rejects, no host degrades", async (t) => {
  process.env.GAPP_HOST_TOKEN = "lease-token";
  t.after(() => delete process.env.GAPP_HOST_TOKEN);

  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      auth: request.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"),
    });
    response.writeHead(409, { "Content-Type": "application/json" });
    response.end(
      JSON.stringify({
        ok: false,
        code: "already_connected",
        message: "GAPP \"demo\" is already live in another session",
        lease: { appId: "demo", sessionId: "other-session" },
      }),
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const bundle = { meta: { id: "demo", scope: "global", instances: "single" } };
  await assert.rejects(
    () => acquireRunnerLease(bundle, "/tmp", base, "sdk-1"),
    (error) =>
      error.name === "GappLeaseError" &&
      error.code === "already_connected" &&
      error.lease.sessionId === "other-session",
  );
  assert.equal(requests[0].method, "PUT");
  assert.equal(requests[0].auth, "Bearer lease-token");
  assert.equal(requests[0].body.instances, "single");

  // Unreachable host must not block an isolated run.
  await new Promise((resolve) => server.close(resolve));
  const degraded = await acquireRunnerLease(bundle, "/tmp", base, "sdk-1");
  assert.equal(typeof degraded.release, "function");
  await degraded.release();
});
