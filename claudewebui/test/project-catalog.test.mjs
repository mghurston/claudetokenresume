import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { githubUrl, isWithin, ProjectCatalog, slugifyProjectId } from "../src/project-catalog.mjs";

function session(id, cwd, extra = {}) {
  return {
    id,
    title: extra.title || `Session ${id}`,
    preview: extra.preview || "",
    cwd,
    branch: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: extra.updatedAt || "2026-07-01T00:00:00.000Z",
  };
}

function baseState(workspaceRoot, overrides = {}) {
  return {
    projects: [
      { id: "general", name: "General", path: workspaceRoot, pinned: true, keywords: [] },
    ],
    scanRoots: [workspaceRoot],
    sessionProjectOverrides: {},
    ...overrides,
  };
}

test("isWithin handles the directory itself and rejects siblings", () => {
  assert.equal(isWithin("/a/b", "/a/b"), true);
  assert.equal(isWithin("/a/b", "/a/b/c"), true);
  assert.equal(isWithin("/a/b", "/a/bc"), false);
  assert.equal(isWithin("/a/b", "/a"), false);
});

test("groups sessions under the project folder they ran in", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-studio-"));
  const projectPath = path.join(root, "acme-api");
  await mkdir(projectPath, { recursive: true });

  const catalog = new ProjectCatalog(root);
  catalog.repoUrlCache.set(projectPath, null);
  catalog.repoUrlCache.set(root, null);

  const projects = await catalog.build(
    [session("s1", projectPath), session("s2", root)],
    baseState(root),
  );

  const discovered = projects.find((project) => project.path === projectPath);
  assert.ok(discovered, "expected a project for the session cwd");
  assert.deepEqual(
    discovered.sessions.map((item) => item.id),
    ["s1"],
  );

  const general = projects.find((project) => project.id === "general");
  assert.deepEqual(
    general.sessions.map((item) => item.id),
    ["s2"],
  );
});

test("sessions outside every scan root land in General", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-studio-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "claude-elsewhere-"));

  const catalog = new ProjectCatalog(root);
  catalog.repoUrlCache.set(root, null);

  const projects = await catalog.build([session("s1", outside)], baseState(root));
  assert.deepEqual(projects.map((project) => project.id), ["general"]);
  assert.deepEqual(projects[0].sessions.map((item) => item.id), ["s1"]);
});

test("a manual move beats the cwd match", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-studio-"));
  const projectPath = path.join(root, "acme-api");
  await mkdir(projectPath, { recursive: true });

  const catalog = new ProjectCatalog(root);
  catalog.repoUrlCache.set(projectPath, null);
  catalog.repoUrlCache.set(root, null);

  const projects = await catalog.build(
    [session("s1", projectPath)],
    baseState(root, { sessionProjectOverrides: { s1: "general" } }),
  );

  const general = projects.find((project) => project.id === "general");
  assert.deepEqual(general.sessions.map((item) => item.id), ["s1"]);
});

test("keyword matching only applies when exactly one project claims the session", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-studio-"));
  const alpha = path.join(root, "alpha");
  const beta = path.join(root, "beta");
  await mkdir(alpha, { recursive: true });
  await mkdir(beta, { recursive: true });

  const catalog = new ProjectCatalog(root);
  for (const item of [root, alpha, beta]) {
    catalog.repoUrlCache.set(item, null);
  }

  const state = baseState(root, {
    projects: [
      { id: "general", name: "General", path: root, pinned: true, keywords: [] },
      { id: "alpha", name: "Alpha", path: alpha, pinned: true, keywords: ["billing"] },
      { id: "beta", name: "Beta", path: beta, pinned: true, keywords: ["billing"] },
    ],
  });

  const outside = await mkdtemp(path.join(os.tmpdir(), "claude-elsewhere-"));
  const ambiguous = await catalog.build(
    [session("s1", outside, { title: "billing rollup" })],
    state,
  );
  assert.equal(
    ambiguous.find((project) => project.id === "general").sessions.length,
    1,
    "two keyword matches should stay in General",
  );

  state.projects[2].keywords = ["shipping"];
  const resolved = await catalog.build(
    [session("s2", outside, { title: "billing rollup" })],
    state,
  );
  assert.deepEqual(
    resolved.find((project) => project.id === "alpha").sessions.map((item) => item.id),
    ["s2"],
  );
});

test("sessions are newest first inside a project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "claude-studio-"));
  const catalog = new ProjectCatalog(root);
  catalog.repoUrlCache.set(root, null);

  const projects = await catalog.build(
    [
      session("old", root, { updatedAt: "2026-01-01T00:00:00.000Z" }),
      session("new", root, { updatedAt: "2026-07-01T00:00:00.000Z" }),
    ],
    baseState(root),
  );

  assert.deepEqual(
    projects[0].sessions.map((item) => item.id),
    ["new", "old"],
  );
});

test("normalizes git remotes to browsable URLs", () => {
  assert.equal(githubUrl("git@github.com:acme/api.git"), "https://github.com/acme/api");
  assert.equal(
    githubUrl("https://user:pass@github.com/acme/api.git"),
    "https://github.com/acme/api",
  );
  assert.equal(githubUrl("not a remote"), null);
});

test("slugifies project ids", () => {
  assert.equal(slugifyProjectId("  Acme API  "), "acme-api");
  assert.match(slugifyProjectId("***"), /^project-\d+$/);
});
