import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { StateStore } from "../src/state-store.mjs";

async function freshStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-studio-state-"));
  const workspaceRoot = path.join(directory, "workspace");
  const store = new StateStore(path.join(directory, "state.json"), workspaceRoot);
  await store.init();
  return { store, workspaceRoot };
}

test("seeds a General project pointed at the workspace root", async () => {
  const { store, workspaceRoot } = await freshStore();
  const snapshot = store.snapshot();
  assert.deepEqual(snapshot.projects.map((project) => project.id), ["general"]);
  assert.equal(snapshot.projects[0].path, workspaceRoot);
  assert.deepEqual(snapshot.scanRoots, [workspaceRoot]);
});

test("snapshots are copies, so callers cannot mutate stored state", async () => {
  const { store } = await freshStore();
  const snapshot = store.snapshot();
  snapshot.projects.push({ id: "injected" });
  assert.equal(store.snapshot().projects.length, 1);
});

test("persists project moves across restarts", async () => {
  const { store } = await freshStore();
  await store.setSessionProject("session-1", "general");
  assert.equal(store.snapshot().sessionProjectOverrides["session-1"], "general");

  const reopened = new StateStore(store.filePath, store.workspaceRoot);
  await reopened.init();
  assert.equal(reopened.snapshot().sessionProjectOverrides["session-1"], "general");
});

test("rejects a duplicate project folder", async () => {
  const { store, workspaceRoot } = await freshStore();
  const projectPath = path.join(workspaceRoot, "api");
  await store.addProject({ id: "api", name: "API", path: projectPath, keywords: [] });
  await assert.rejects(
    () => store.addProject({ id: "api-2", name: "API again", path: projectPath, keywords: [] }),
    /already configured/,
  );
});

test("registering a scan root is idempotent and can seed a project", async () => {
  const { store, workspaceRoot } = await freshStore();
  const scanRoot = path.join(workspaceRoot, "repos");

  await store.registerScanRoot(scanRoot, {
    id: "repos",
    name: "Repos",
    path: scanRoot,
    pinned: true,
    keywords: [],
  });
  await store.registerScanRoot(scanRoot);

  const snapshot = store.snapshot();
  assert.equal(snapshot.scanRoots.filter((root) => root === scanRoot).length, 1);
  assert.equal(snapshot.projects.filter((project) => project.id === "repos").length, 1);
});

test("forgetting a session clears its project override", async () => {
  const { store } = await freshStore();
  await store.setSessionProject("session-1", "general");
  await store.forgetSession("session-1");
  assert.equal(store.snapshot().sessionProjectOverrides["session-1"], undefined);
});

test("writes state atomically as valid JSON", async () => {
  const { store } = await freshStore();
  await store.setSessionProject("session-1", "general");
  const written = JSON.parse(await readFile(store.filePath, "utf8"));
  assert.equal(written.sessionProjectOverrides["session-1"], "general");
});

test("first run adopts drives that already hold Claude sessions", async () => {
  const { store, workspaceRoot } = await freshStore();
  const homeRoot = path.parse(workspaceRoot).root;

  const seeded = await store.seedScanRootsFromSessions([
    path.join(workspaceRoot, "projects", "api"),
    path.join("G:", path.sep, "repos", "alpha"),
    path.join("G:", path.sep, "repos", "beta"),
    null,
  ]);

  const expected = process.platform === "win32" ? ["G:\\"] : [];
  assert.deepEqual(seeded, expected);
  for (const root of expected) {
    assert.ok(store.snapshot().scanRoots.includes(root));
  }
  assert.ok(!seeded.includes(homeRoot), "the home drive is already covered");
});

test("later runs never re-seed scan roots the user may have removed", async () => {
  const { store, workspaceRoot } = await freshStore();
  await store.seedScanRootsFromSessions([path.join(workspaceRoot, "a")]);

  const reopened = new StateStore(store.filePath, store.workspaceRoot);
  await reopened.init();
  assert.equal(reopened.isFirstRun, false);
  assert.deepEqual(
    await reopened.seedScanRootsFromSessions([path.join("G:", path.sep, "repos")]),
    [],
  );
});
