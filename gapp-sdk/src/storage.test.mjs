import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadGappState, setGappState, upsertGapp } from "./storage.mjs";

test("setGappState serializes concurrent merges and atomically replaces JSON", async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), "glimpse-gapp-state-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));

  const id = "state-race";
  await upsertGapp({
    id,
    name: "State Race",
    scope: "project",
    cwd,
    html: "<main></main>",
    state: { base: true },
    skipSnapshot: true,
  });

  const patches = Array.from({ length: 64 }, (_, index) => ({
    [`key${index}`]: `${index}:${"x".repeat(4096)}`,
  }));
  await Promise.all(
    patches.map((patch) => setGappState(id, patch, { scope: "project", cwd, merge: true })),
  );

  const state = await loadGappState("project", id, cwd);
  assert.equal(state.base, true);
  for (let index = 0; index < patches.length; index += 1) {
    assert.equal(state[`key${index}`], patches[index][`key${index}`]);
  }

  const dir = join(cwd, ".pi", "gapp", id);
  const raw = await readFile(join(dir, "state.json"), "utf-8");
  assert.deepEqual(JSON.parse(raw), state);
  assert.deepEqual(
    (await readdir(dir)).filter((name) => name.startsWith("state.json.") && name.endsWith(".tmp")),
    [],
  );
});
