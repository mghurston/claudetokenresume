import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { ClaudeBridge } from "./src/claude-bridge.mjs";
import {
  applySecurityHeaders,
  enforceSameOrigin,
  errorJson,
  json,
  readJson,
  serveStatic,
} from "./src/http-utils.mjs";
import {
  effortLevels,
  isKnownEffort,
  isKnownModel,
  isKnownPermissionMode,
  modelCatalog,
  permissionModes,
} from "./src/model-info.mjs";
import { canApproveForSession, permissionResultFor } from "./src/permission-decisions.mjs";
import { isWithin, ProjectCatalog, slugifyProjectId } from "./src/project-catalog.mjs";
import { SessionCatalog } from "./src/session-catalog.mjs";
import { StateStore } from "./src/state-store.mjs";
import { UploadStore } from "./src/upload-store.mjs";

const execFileAsync = promisify(execFile);

const APP_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIRECTORY = path.join(APP_DIRECTORY, "public");
const HOST = process.env.CLAUDE_STUDIO_HOST || "127.0.0.1";
const PORT = Number(process.env.CLAUDE_STUDIO_PORT || 4174);
const WORKSPACE_ROOT = path.resolve(process.env.CLAUDE_STUDIO_ROOT || os.homedir());
const DATA_DIRECTORY = path.resolve(
  process.env.CLAUDE_STUDIO_DATA_DIR || path.join(os.homedir(), ".claude-cli-studio"),
);
const LAUNCH_TOKEN =
  process.env.CLAUDE_STUDIO_TOKEN || randomBytes(32).toString("base64url");
const SESSION_TOKEN = randomBytes(32).toString("base64url");
const URL_HOST = HOST === "::1" ? "[::1]" : HOST;
const EXPECTED_ORIGIN = `http://${URL_HOST}:${PORT}`;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);
if (!LOOPBACK_HOSTS.has(HOST)) {
  throw new Error("CLAUDE_STUDIO_HOST must be a loopback address.");
}
const ALLOWED_HOST_HEADERS = new Set([
  `127.0.0.1:${PORT}`,
  `localhost:${PORT}`,
  `[::1]:${PORT}`,
]);
const ALLOWED_ORIGINS = new Set(
  [...ALLOWED_HOST_HEADERS].map((hostHeader) => `http://${hostHeader}`),
);
const LAUNCH_DIRECTORY = path.join(DATA_DIRECTORY, `launch-${process.pid}`);
const LAUNCH_FILE = path.join(LAUNCH_DIRECTORY, "index.html");
const LAUNCH_SCRIPT = path.join(LAUNCH_DIRECTORY, "launch.js");
const LAUNCH_EXPIRES_AT = Date.now() + 2 * 60 * 1000;
let launchAvailable = true;

await mkdir(DATA_DIRECTORY, { recursive: true, mode: 0o700 });
await chmod(DATA_DIRECTORY, 0o700);
await mkdir(LAUNCH_DIRECTORY, { recursive: true, mode: 0o700 });
await writeFile(
  LAUNCH_FILE,
  '<!doctype html><meta charset="utf-8"><title>Opening Claude CLI Studio</title><script src="./launch.js"></script>',
  { mode: 0o600 },
);
const launchUrl = new URL("/", EXPECTED_ORIGIN);
launchUrl.searchParams.set("launch", LAUNCH_TOKEN);
await writeFile(
  LAUNCH_SCRIPT,
  `window.location.replace(${JSON.stringify(launchUrl.href)});\n`,
  { mode: 0o600 },
);

function removeLaunchFiles() {
  return rm(LAUNCH_DIRECTORY, { recursive: true, force: true });
}

const launchExpiryTimer = setTimeout(() => {
  launchAvailable = false;
  removeLaunchFiles().catch(() => {});
}, Math.max(0, LAUNCH_EXPIRES_AT - Date.now()));
launchExpiryTimer.unref();

const sessionCatalog = new SessionCatalog();
const stateStore = new StateStore(path.join(DATA_DIRECTORY, "state.json"), WORKSPACE_ROOT);
const uploadStore = new UploadStore(DATA_DIRECTORY);
const projectCatalog = new ProjectCatalog(WORKSPACE_ROOT);
const eventClients = new Set();
const pendingPermissions = new Map();
const sessionStreams = new Map();
const streamCleanupTimers = new Map();
const pendingMessageSessions = new Set();

await Promise.all([stateStore.init(), uploadStore.init()]);
if (stateStore.isFirstRun) {
  const sessions = await sessionCatalog.listSessions().catch(() => []);
  const seeded = await stateStore.seedScanRootsFromSessions(
    sessions.map((session) => session.cwd),
  );
  if (seeded.length) {
    console.log(`Adopted existing Claude Code drives as scan roots: ${seeded.join(", ")}`);
  }
}
await uploadStore.prunePending(30 * 60 * 1000);
const uploadPruneTimer = setInterval(
  () => uploadStore.prunePending(30 * 60 * 1000).catch(() => {}),
  10 * 60 * 1000,
);
uploadPruneTimer.unref();

function broadcast(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`;
  for (const response of eventClients) {
    response.write(frame);
  }
}

function streamSnapshot(sessionId) {
  const stream = sessionStreams.get(sessionId);
  if (!stream) {
    return null;
  }
  return {
    sessionId,
    running: stream.running,
    userMessage: stream.userMessage || null,
    events: stream.events,
  };
}

function recordStreamEvent(sessionId, event) {
  const existingCleanup = streamCleanupTimers.get(sessionId);
  if (existingCleanup) {
    clearTimeout(existingCleanup);
    streamCleanupTimers.delete(sessionId);
  }

  const stream = sessionStreams.get(sessionId) || {
    running: false,
    userMessage: null,
    events: [],
  };

  if (event.type === "session.running") {
    stream.running = true;
    stream.userMessage = null;
    stream.events = [];
  } else {
    stream.events.push(event);
    stream.events = stream.events.slice(-400);
    if (event.type === "session.idle" || event.type === "session.error") {
      stream.running = false;
      const cleanup = setTimeout(() => {
        streamCleanupTimers.delete(sessionId);
        sessionStreams.delete(sessionId);
      }, 60 * 1000);
      cleanup.unref();
      streamCleanupTimers.set(sessionId, cleanup);
    }
  }

  sessionStreams.set(sessionId, stream);
}

function setStreamUserMessage(sessionId, userMessage) {
  const stream = sessionStreams.get(sessionId) || {
    running: true,
    userMessage: null,
    events: [],
  };
  stream.userMessage = userMessage;
  sessionStreams.set(sessionId, stream);
}

function waitForPermission({ sessionId, request, signal }) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const settle = (result) => {
      clearTimeout(timeout);
      pendingPermissions.delete(requestId);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };
    const onAbort = () =>
      settle({ behavior: "deny", message: "The request was cancelled." });

    const timeout = setTimeout(
      () =>
        settle({
          behavior: "deny",
          message: "Nobody answered the permission prompt in Claude CLI Studio.",
        }),
      10 * 60 * 1000,
    );
    timeout.unref();
    signal?.addEventListener?.("abort", onAbort, { once: true });

    const payload = {
      type: "permission-request",
      requestId,
      sessionId,
      request: {
        toolName: request.toolName,
        input: request.input,
        title: request.title || null,
        displayName: request.displayName || null,
        description: request.description || null,
        blockedPath: request.blockedPath || null,
        decisionReason: request.decisionReason || null,
      },
      canApproveForSession: canApproveForSession(request),
    };
    pendingPermissions.set(requestId, { settle, payload, request });
    broadcast(payload);
  });
}

const claude = new ClaudeBridge({
  onEvent: ({ sessionId, event }) => {
    recordStreamEvent(sessionId, event);
    broadcast({ type: "claude-event", sessionId, event });
    if (event.type === "session.idle") {
      sessionCatalog.invalidate();
      broadcast({ type: "sessions-changed" });
    }
  },
  onPermissionRequest: waitForPermission,
});

function expandHomePath(candidate) {
  const value = String(candidate || "").trim();
  if (value === "~") {
    return os.homedir();
  }
  if (/^~[\\/]/.test(value)) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

function canonicalDirectory(candidate) {
  const expanded = expandHomePath(candidate);
  if (!expanded) {
    return null;
  }
  const resolved = path.resolve(expanded);
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    return null;
  }
  return realpathSync(resolved);
}

/**
 * Blocks scanning a root that would swallow the whole machine — `/` or the
 * drive holding the home directory. A separate projects drive (`D:\`, `G:\`)
 * is a legitimate scan root and stays allowed.
 */
function isOverbroadRoot(directory) {
  if (path.parse(directory).root !== directory) {
    return false;
  }
  return isWithin(directory, os.homedir());
}

function uniqueProjectId(name, projects) {
  const base = slugifyProjectId(name);
  if (base !== "general" && !projects.some((project) => project.id === base)) {
    return base;
  }
  const prefix = base === "general" ? "project" : base;
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

function tokenMatches(candidate, expectedToken) {
  if (typeof candidate !== "string") {
    return false;
  }
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(candidate);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function requestIsAuthenticated(request) {
  const match = String(request.headers.authorization || "").match(
    /^Bearer ([A-Za-z0-9_-]+)$/,
  );
  return tokenMatches(match?.[1], SESSION_TOKEN);
}

function authorizeBrowser(response) {
  launchAvailable = false;
  clearTimeout(launchExpiryTimer);
  removeLaunchFiles().catch(() => {});
  applySecurityHeaders(response);
  response.writeHead(303, {
    "Cache-Control": "no-store",
    "Location": `/#studio-token=${encodeURIComponent(SESSION_TOKEN)}`,
  });
  response.end();
}

function consumeLaunchToken(candidate) {
  if (
    !launchAvailable ||
    Date.now() > LAUNCH_EXPIRES_AT ||
    !tokenMatches(candidate, LAUNCH_TOKEN)
  ) {
    return false;
  }
  launchAvailable = false;
  return true;
}

let cachedCliInfo = null;
async function cliInfo() {
  if (cachedCliInfo) {
    return cachedCliInfo;
  }
  const executable = process.env.CLAUDE_CODE_PATH || "claude";
  try {
    const { stdout } = await execFileAsync(executable, ["--version"], {
      timeout: 10000,
      windowsHide: true,
    });
    cachedCliInfo = {
      available: true,
      version: stdout.trim().split(/\s+/)[0] || stdout.trim(),
      executable,
    };
  } catch (error) {
    cachedCliInfo = {
      available: false,
      version: null,
      executable,
      message: `Could not run "${executable} --version": ${error.message}`,
    };
  }
  return cachedCliInfo;
}

async function catalog() {
  return projectCatalog.build(await sessionCatalog.listSessions(), stateStore.snapshot());
}

function flattenProjects(projects) {
  return projects.map(({ sessions, ...project }) => project);
}

async function bootstrapPayload() {
  const [projects, cli] = await Promise.all([catalog(), cliInfo()]);

  return {
    app: {
      name: "Claude CLI Studio",
      version: "0.1.0",
      workspaceRoot: WORKSPACE_ROOT,
      scanRoots: stateStore.snapshot().scanRoots,
      dataDirectory: DATA_DIRECTORY,
      localOnly: HOST === "127.0.0.1" || HOST === "localhost",
    },
    cli,
    models: modelCatalog(),
    efforts: effortLevels(),
    permissionModes: permissionModes(),
    projects,
  };
}

function projectById(projects, projectId) {
  return projects.find((project) => project.id === projectId) || null;
}

function parseSessionPath(pathname) {
  const match = pathname.match(
    /^\/api\/sessions\/([0-9a-f-]{8,})(?:\/(abort|organize))?$/i,
  );
  if (!match) {
    return null;
  }
  return { sessionId: match[1], action: match[2] || null };
}

function beginEventStream(request, response) {
  applySecurityHeaders(response);
  response.writeHead(200, {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "Content-Type": "text/event-stream",
    "X-Accel-Buffering": "no",
  });
  response.write(
    `data: ${JSON.stringify({
      type: "connected",
      streams: [...sessionStreams.keys()].map(streamSnapshot).filter(Boolean),
    })}\n\n`,
  );
  eventClients.add(response);
  for (const pending of pendingPermissions.values()) {
    response.write(`data: ${JSON.stringify(pending.payload)}\n\n`);
  }

  const heartbeat = setInterval(() => {
    response.write(": heartbeat\n\n");
  }, 20000);
  heartbeat.unref();

  request.on("close", () => {
    clearInterval(heartbeat);
    eventClients.delete(response);
  });
}

async function handleApi(request, response, url) {
  if (request.method !== "GET") {
    enforceSameOrigin(request, ALLOWED_ORIGINS);
  }

  if (request.method === "GET" && url.pathname === "/api/health") {
    const cli = await cliInfo();
    json(response, 200, {
      ok: cli.available,
      version: cli.version,
      workspaceRoot: WORKSPACE_ROOT,
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    json(response, 200, await bootstrapPayload());
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    beginEventStream(request, response);
    return true;
  }

  const sessionPath = parseSessionPath(url.pathname);

  if (request.method === "GET" && sessionPath && !sessionPath.action) {
    const session = await sessionCatalog.getSession(sessionPath.sessionId);
    if (!session) {
      json(response, 404, { error: "Session not found." });
      return true;
    }
    const projects = await catalog();
    const project = projects.find((item) =>
      item.sessions.some((candidate) => candidate.id === sessionPath.sessionId),
    );
    json(response, 200, {
      session: { ...session, projectId: project?.id || "general" },
      messages: await sessionCatalog.getMessages(sessionPath.sessionId),
      stream: streamSnapshot(sessionPath.sessionId),
    });
    return true;
  }

  if (request.method === "PATCH" && sessionPath && !sessionPath.action) {
    const body = await readJson(request);
    const title = String(body.title || "").trim();
    if (!title) {
      json(response, 400, { error: "A title is required." });
      return true;
    }
    await sessionCatalog.rename(sessionPath.sessionId, title);
    broadcast({ type: "sessions-changed" });
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === "DELETE" && sessionPath && !sessionPath.action) {
    claude.release(sessionPath.sessionId);
    try {
      await sessionCatalog.delete(sessionPath.sessionId);
    } catch (error) {
      if (!/not found|does not exist|no session|ENOENT/i.test(error.message)) {
        throw error;
      }
    }
    await uploadStore.deleteForSession(sessionPath.sessionId);
    await stateStore.forgetSession(sessionPath.sessionId);
    sessionStreams.delete(sessionPath.sessionId);
    broadcast({ type: "sessions-changed" });
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && sessionPath?.action === "abort") {
    await claude.abort(sessionPath.sessionId);
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && sessionPath?.action === "organize") {
    const body = await readJson(request);
    const projects = await catalog();
    if (!projectById(projects, body.projectId)) {
      json(response, 400, { error: "Choose a valid project." });
      return true;
    }
    await stateStore.setSessionProject(sessionPath.sessionId, body.projectId);
    broadcast({ type: "sessions-changed" });
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/messages") {
    const body = await readJson(request, 2 * 1024 * 1024);
    const prompt = String(body.prompt || "").trim();
    const uploadIds = Array.isArray(body.uploadIds)
      ? [...new Set(body.uploadIds.map((uploadId) => String(uploadId)))]
      : [];
    if (!prompt && uploadIds.length === 0) {
      json(response, 400, { error: "Write a message or attach at least one file." });
      return true;
    }
    if (uploadIds.length > 12) {
      json(response, 400, { error: "Attach no more than 12 files to one message." });
      return true;
    }
    const selectedUploads = uploadStore.getMany(uploadIds);
    if (selectedUploads.length !== uploadIds.length) {
      json(response, 400, { error: "One or more attachments are no longer available." });
      return true;
    }
    if (body.model && !isKnownModel(body.model)) {
      json(response, 400, { error: "Choose a model from the list." });
      return true;
    }
    if (body.effort && !isKnownEffort(body.effort)) {
      json(response, 400, { error: "Choose a valid effort level." });
      return true;
    }
    const permissionMode = body.permissionMode || "default";
    if (!isKnownPermissionMode(permissionMode)) {
      json(response, 400, { error: "Choose a valid permission mode." });
      return true;
    }

    const projects = await catalog();
    const selectedProject = projectById(projects, body.projectId || "general");
    if (!selectedProject) {
      json(response, 400, { error: "Choose a valid project." });
      return true;
    }

    const requestedSessionId = body.sessionId || null;
    if (
      requestedSessionId &&
      (pendingMessageSessions.has(requestedSessionId) ||
        sessionStreams.get(requestedSessionId)?.running)
    ) {
      json(response, 409, {
        error: "Wait for the current response to finish before sending another message.",
      });
      return true;
    }

    const sessionId = requestedSessionId || crypto.randomUUID();
    pendingMessageSessions.add(sessionId);
    const displayPrompt = prompt || "Please review the attached files.";
    const uploads = selectedUploads.map((upload) => uploadStore.publicMetadata(upload));

    try {
      const attachmentBlocks = await uploadStore.toContentBlocks(uploadIds);
      const content = [{ type: "text", text: displayPrompt }, ...attachmentBlocks];

      await claude.sendMessage({
        sessionId,
        isNewSession: !requestedSessionId,
        cwd: selectedProject.path,
        content,
        model: body.model || null,
        effort: body.effort || null,
        permissionMode,
      });

      await stateStore.setSessionProject(sessionId, selectedProject.id);
      if (uploadIds.length) {
        await uploadStore.markAttached(uploadIds, sessionId);
      }
    } catch (error) {
      json(response, 500, { error: error.message });
      return true;
    } finally {
      pendingMessageSessions.delete(sessionId);
    }

    setStreamUserMessage(sessionId, {
      role: "user",
      content: displayPrompt,
      attachments: uploads,
      timestamp: new Date().toISOString(),
    });

    sessionCatalog.invalidate();
    broadcast({ type: "sessions-changed" });
    json(response, 202, { sessionId });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/uploads") {
    const body = await readJson(request, 42 * 1024 * 1024);
    json(response, 201, { uploads: await uploadStore.save(body.files) });
    return true;
  }

  const uploadMatch = url.pathname.match(/^\/api\/uploads\/([0-9a-f-]+)$/i);
  if (request.method === "DELETE" && uploadMatch) {
    json(response, 200, { deleted: await uploadStore.delete(uploadMatch[1]) });
    return true;
  }

  const permissionMatch = url.pathname.match(/^\/api\/permissions\/([0-9a-f-]+)$/i);
  if (request.method === "POST" && permissionMatch) {
    const pending = pendingPermissions.get(permissionMatch[1]);
    if (!pending) {
      json(response, 404, { error: "That permission request is no longer pending." });
      return true;
    }
    const body = await readJson(request);
    const result = permissionResultFor(body.decision, pending.request, body.feedback);
    if (!result) {
      json(response, 400, { error: "Choose a valid permission decision." });
      return true;
    }
    pending.settle(result);
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/scans") {
    const body = await readJson(request);
    const scanRoot = canonicalDirectory(body.path);
    if (!scanRoot) {
      json(response, 400, { error: "Choose an existing local folder." });
      return true;
    }
    if (isOverbroadRoot(scanRoot)) {
      json(response, 400, {
        error: "Choose a project folder or parent folder, not the root of your system drive.",
      });
      return true;
    }

    const sessions = await sessionCatalog.listSessions();
    const suggestedProject = await projectCatalog.suggestProjectForScanRoot(
      scanRoot,
      sessions,
    );
    await stateStore.registerScanRoot(scanRoot, suggestedProject);
    const projects = await catalog();
    const matchingProjects = projects.filter(
      (project) => project.id !== "general" && isWithin(scanRoot, project.path),
    );
    const matchedSessionIds = new Set(
      matchingProjects.flatMap((project) => project.sessions.map((session) => session.id)),
    );

    broadcast({ type: "sessions-changed" });
    json(response, 201, {
      scanRoot,
      projectCount: matchingProjects.length,
      sessionCount: matchedSessionIds.size,
      projects: flattenProjects(matchingProjects),
    });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/projects") {
    const body = await readJson(request);
    const name = String(body.name || "").trim();
    const projectPath = canonicalDirectory(body.path);
    if (!name || !body.path) {
      json(response, 400, { error: "Project name and folder path are required." });
      return true;
    }
    const scanRoots = stateStore.snapshot().scanRoots || [WORKSPACE_ROOT];
    if (!projectPath || !scanRoots.some((scanRoot) => isWithin(scanRoot, projectPath))) {
      json(response, 400, {
        error: "Project folders must exist beneath a scanned local folder.",
      });
      return true;
    }
    const keywords = String(body.keywords || "")
      .split(",")
      .map((keyword) => keyword.trim())
      .filter(Boolean);
    const configuredProjects = stateStore.snapshot().projects;
    if (
      configuredProjects.some(
        (project) =>
          project.path && path.resolve(project.path) === path.resolve(projectPath),
      )
    ) {
      json(response, 409, { error: "That project folder is already configured." });
      return true;
    }
    await stateStore.addProject({
      id: uniqueProjectId(name, configuredProjects),
      name,
      path: projectPath,
      pinned: true,
      keywords,
    });
    broadcast({ type: "sessions-changed" });
    json(response, 201, { ok: true });
    return true;
  }

  return false;
}

const server = http.createServer(async (request, response) => {
  try {
    if (!ALLOWED_HOST_HEADERS.has(String(request.headers.host || "").toLowerCase())) {
      const error = new Error("Invalid Host header.");
      error.statusCode = 421;
      throw error;
    }
    const url = new URL(request.url, EXPECTED_ORIGIN);
    if (request.method === "GET" && url.pathname === "/" && url.searchParams.has("launch")) {
      if (!consumeLaunchToken(url.searchParams.get("launch"))) {
        json(response, 401, { error: "Invalid Studio launch token." });
        return;
      }
      authorizeBrowser(response);
      return;
    }
    if (url.pathname.startsWith("/api/")) {
      if (!requestIsAuthenticated(request)) {
        json(response, 401, { error: "Studio authentication is required." });
        return;
      }
      if (!(await handleApi(request, response, url))) {
        json(response, 404, { error: "API route not found." });
      }
      return;
    }

    if (!(await serveStatic(response, PUBLIC_DIRECTORY, decodeURIComponent(url.pathname)))) {
      json(response, 404, { error: "Not found." });
    }
  } catch (error) {
    errorJson(response, error, error.statusCode || 500);
  }
});

function openBrowser(url) {
  if (process.env.CLAUDE_STUDIO_OPEN === "0") {
    return;
  }
  const command =
    process.platform === "darwin"
      ? { executable: "open", args: [url] }
      : process.platform === "win32"
        ? { executable: "cmd", args: ["/c", "start", "", url] }
        : { executable: "xdg-open", args: [url] };
  const child = spawn(command.executable, command.args, {
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

server.listen(PORT, HOST, async () => {
  console.log(`Claude CLI Studio is running at ${EXPECTED_ORIGIN}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
  const cli = await cliInfo();
  if (cli.available) {
    console.log(`Claude Code ${cli.version} · sessions read from ~/.claude`);
  } else {
    console.log(`Claude Code CLI not found. ${cli.message}`);
  }
  if (process.env.CLAUDE_STUDIO_OPEN === "0") {
    console.log(`Browser auto-open is disabled. Open ${LAUNCH_FILE}`);
  } else {
    openBrowser(pathToFileURL(LAUNCH_FILE).href);
  }
});

let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  clearInterval(uploadPruneTimer);
  clearTimeout(launchExpiryTimer);
  await removeLaunchFiles().catch(() => {});
  for (const timeout of streamCleanupTimers.values()) {
    clearTimeout(timeout);
  }
  server.close();
  await claude.stop();
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
