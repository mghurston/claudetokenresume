import { execFile, spawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
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
import { LimitWatch } from "./src/limit-watch.mjs";
import {
  canApproveForSession,
  modeAutoApproves,
  permissionResultFor,
} from "./src/permission-decisions.mjs";
import {
  askChoice,
  findFreePort as guardFindFreePort,
  findPortOwner as guardFindPortOwner,
  probePortHolder as guardProbePortHolder,
  runningStudioLaunchHref as guardRunningStudioLaunchHref,
  stopProcessAndWait,
} from "./src/port-guard.mjs";
import { isWithin, ProjectCatalog, slugifyProjectId } from "./src/project-catalog.mjs";
import { isSessionId, SessionCatalog } from "./src/session-catalog.mjs";
import { StateStore } from "./src/state-store.mjs";
import { TurnQueue } from "./src/turn-queue.mjs";
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
// Inherited only across a Restart, so the tab that asked for it stays signed
// in. Nothing else should ever set this.
const SESSION_TOKEN =
  process.env.CLAUDE_STUDIO_SESSION_TOKEN || randomBytes(32).toString("base64url");
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
const RUNTIME_FILE = path.join(DATA_DIRECTORY, "runtime.json");

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

/**
 * The launch token stays redeemable for as long as the server runs.
 *
 * It used to be single-use with a two-minute expiry, which locked you out of
 * your own Studio: the session token lives in the browser, so closing the tab
 * (or opening 127.0.0.1 from history, or a second browser) left every request
 * 401ing with no way to authenticate and no login surface to offer one. The
 * only cure was restarting the server. The token is a 256-bit secret in a
 * 0700 directory on loopback — re-redeeming it is no weaker than the session
 * token it hands out, and it is what makes reopening the tab just work.
 */
function consumeLaunchToken(candidate) {
  return tokenMatches(candidate, LAUNCH_TOKEN);
}

/**
 * Points a second launcher at the Studio that already owns the port.
 *
 * Written only after `listen` succeeds, so a process that loses the race never
 * clobbers the winner's entry.
 */
async function writeRuntimeFile() {
  await writeFile(
    RUNTIME_FILE,
    `${JSON.stringify(
      { pid: process.pid, port: PORT, origin: EXPECTED_ORIGIN, launchToken: LAUNCH_TOKEN },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

// These four are the shared port-guard logic, bound to this server's port so
// the rest of the file reads as it did. `start.mjs` uses the same module, which
// is what keeps the two entry points classifying a port holder identically.
const probePortHolder = () => guardProbePortHolder(EXPECTED_ORIGIN);
const findPortOwner = () => guardFindPortOwner(PORT);
const runningStudioLaunchHref = () =>
  guardRunningStudioLaunchHref(RUNTIME_FILE, PORT, EXPECTED_ORIGIN);
const findFreePort = (from) => guardFindFreePort(from, HOST);

/**
 * Clears `launch-<pid>` directories left by servers that were killed rather
 * than shut down. Without this they pile up in the data directory forever.
 */
async function pruneStaleLaunchDirectories() {
  let entries;
  try {
    entries = await readdir(DATA_DIRECTORY, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const match = entry.isDirectory() && /^launch-(\d+)$/.exec(entry.name);
    if (!match || Number(match[1]) === process.pid) {
      continue;
    }
    try {
      process.kill(Number(match[1]), 0);
    } catch (error) {
      // ESRCH means no such process; EPERM means it exists but is not ours,
      // so leave that one alone.
      if (error.code === "ESRCH") {
        await rm(path.join(DATA_DIRECTORY, entry.name), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
    }
  }
}

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
      clearInterval(timeout);
      pendingPermissions.delete(requestId);
      signal?.removeEventListener?.("abort", onAbort);
      resolve(result);
    };
    const onAbort = () =>
      settle({ behavior: "deny", message: "The request was cancelled." });

    // The clock only runs while a browser is actually connected.
    //
    // A flat ten-minute deny was a trap: with the tab closed there is nobody to
    // ask, so denying is guaranteed and Claude usually stops — the run dies of a
    // question that was never delivered. Waiting is the honest answer, because a
    // reconnecting tab is re-sent every pending prompt. If someone *is* watching
    // and still says nothing for ten minutes, denying is fair.
    let unansweredMs = 0;
    const tick = 15 * 1000;
    const timeout = setInterval(() => {
      if (eventClients.size === 0) {
        unansweredMs = 0;
        return;
      }
      unansweredMs += tick;
      if (unansweredMs >= 10 * 60 * 1000) {
        settle({
          behavior: "deny",
          message: "Nobody answered the permission prompt in Claude CLI Studio.",
        });
      }
    }, tick);
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
    pendingPermissions.set(requestId, { sessionId, settle, payload, request });
    broadcast(payload);
  });
}

/**
 * Settles a prompt and tells every tab to take the dialog down.
 *
 * Without the broadcast a second tab — or the tab that raised the dialog before
 * a mode switch answered it for them — keeps a modal on screen for a request
 * the server has already forgotten, and clicking it just 404s.
 */
function settlePermission(requestId, pending, result) {
  pending.settle(result);
  broadcast({ type: "permission-resolved", requestId, sessionId: pending.sessionId });
}

/**
 * Answers the prompts a newly chosen mode would never have raised.
 *
 * See `modeAutoApproves` — the SDK asks once and never re-asks, so anything
 * already waiting has to be resolved here or it hangs until it times out.
 */
function applyModeToPendingPermissions(sessionId, permissionMode) {
  let approved = 0;
  for (const [requestId, pending] of pendingPermissions) {
    if (pending.sessionId !== sessionId) {
      continue;
    }
    if (!modeAutoApproves(permissionMode, pending.request.toolName)) {
      continue;
    }
    settlePermission(requestId, pending, { behavior: "allow" });
    approved += 1;
  }
  return approved;
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
  onRateLimit: (info) => limitWatch.observe(info),
});

/**
 * The parked-turn file: its own file, 0600, removed as soon as the queue is
 * empty. Written after every change so a Quit, a Restart, or a reboot cannot
 * eat a turn that has been waiting hours for a usage window.
 */
const QUEUE_FILE = path.join(DATA_DIRECTORY, "queue.json");

const turnQueue = new TurnQueue({
  persist: (entries) => {
    if (!entries) {
      rm(QUEUE_FILE, { force: true }).catch(() => {});
      return;
    }
    writeFile(QUEUE_FILE, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 }).catch(
      (error) => console.error(`Could not save the parked turns: ${error.message}`),
    );
  },
});

/** Reloads turns parked by a previous run. */
async function restoreTurnQueue() {
  let raw;
  try {
    raw = await readFile(QUEUE_FILE, "utf8");
  } catch {
    return 0;
  }
  let entries;
  try {
    entries = JSON.parse(raw);
  } catch {
    await rm(QUEUE_FILE, { force: true }).catch(() => {});
    return 0;
  }
  const restored = turnQueue.restore(entries);
  if (restored) {
    // Whatever the cap was doing when we went down, we no longer know — start
    // watching again so these can be released on the next real lift.
    limitWatch.setPendingCount(turnQueue.size());
  }
  return restored;
}
const limitWatch = new LimitWatch({
  onChange: () => broadcast(watchPayload()),
  onRelease: () => {
    releaseQueuedTurns().catch((error) => {
      console.error(`Could not release queued turns: ${error.message}`);
    });
  },
});

function watchPayload() {
  return { type: "watch-changed", limit: limitWatch.snapshot(), queue: turnQueue.list() };
}

/**
 * Sends one turn to Claude Code. Shared by the composer and by the watch, so a
 * turn released hours later goes through exactly the same path — same project
 * resolution, same attachment handling, same stream bookkeeping — as one you
 * send by hand.
 */
async function deliverTurn({
  sessionId,
  isNewSession,
  project,
  prompt,
  uploadIds,
  model,
  effort,
  permissionMode,
  priority = null,
}) {
  const displayPrompt = prompt || "Please review the attached files.";
  const uploads = uploadStore
    .getMany(uploadIds)
    .map((upload) => uploadStore.publicMetadata(upload));

  let sent;
  pendingMessageSessions.add(sessionId);
  try {
    const attachmentBlocks = await uploadStore.toContentBlocks(uploadIds);
    sent = await claude.sendMessage({
      sessionId,
      isNewSession,
      cwd: project.path,
      content: [{ type: "text", text: displayPrompt }, ...attachmentBlocks],
      model,
      effort,
      permissionMode,
      priority,
    });
    await stateStore.setSessionProject(sessionId, project.id);
    if (uploadIds.length) {
      await uploadStore.markAttached(uploadIds, sessionId);
    }
  } finally {
    pendingMessageSessions.delete(sessionId);
  }

  // A parked message must not replace the user message the running turn is
  // still answering — the browser shows it as a separate pending bubble.
  if (!sent?.queued) {
    setStreamUserMessage(sessionId, {
      role: "user",
      content: displayPrompt,
      attachments: uploads,
      timestamp: new Date().toISOString(),
    });
  }

  sessionCatalog.invalidate();
  broadcast({ type: "sessions-changed" });
  return { sessionId, prompt: displayPrompt, ...sent };
}

/**
 * Fires every parked turn now that the window has reset. Draining first means a
 * second lift signal arriving mid-release finds an empty queue and cannot send
 * anything twice. One failure does not strand the rest.
 */
async function releaseQueuedTurns() {
  const parked = turnQueue.drain();
  if (!parked.length) {
    limitWatch.setPendingCount(0);
    return;
  }

  const projects = await catalog();
  const released = [];
  const failed = [];

  for (const entry of parked) {
    const project = projectById(projects, entry.projectId);
    if (!project) {
      failed.push({ sessionId: entry.sessionId, error: "That project is no longer configured." });
      continue;
    }
    try {
      await deliverTurn({
        sessionId: entry.sessionId,
        isNewSession: entry.isNewSession,
        project,
        prompt: entry.prompt,
        uploadIds: entry.uploadIds,
        model: entry.model,
        effort: entry.effort,
        permissionMode: entry.permissionMode,
      });
      released.push({ sessionId: entry.sessionId, prompt: entry.prompt });
    } catch (error) {
      failed.push({ sessionId: entry.sessionId, error: error.message });
    }
  }

  limitWatch.setPendingCount(turnQueue.size());
  broadcast({ type: "watch-released", released, failed });
  broadcast(watchPayload());
  console.log(
    `Usage window reset — released ${released.length} queued turn(s)` +
      (failed.length ? `, ${failed.length} failed` : ""),
  );
}

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
 * The starting points for browsing: home, plus every drive that answers.
 *
 * A browser cannot hand back a real absolute path — `showDirectoryPicker`
 * gives a handle with only a name, and a file input gives relative paths — so
 * a local app that needs a real path has to do the walking server-side.
 */
async function browseRoots() {
  const home = { name: "Home", path: os.homedir() };
  if (process.platform !== "win32") {
    return [home, { name: "/", path: "/" }];
  }
  // Probed in parallel: a disconnected network drive can take a while to
  // answer, and there is no reason to let it hold up the others.
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const drives = await Promise.all(
    letters.map(async (letter) => {
      const root = `${letter}:\\`;
      try {
        return (await stat(root)).isDirectory() ? { name: root, path: root } : null;
      } catch {
        return null;
      }
    }),
  );
  return [home, ...drives.filter(Boolean)];
}

/** Sub-directories of `directory`, for the folder picker. */
async function browseDirectory(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const folders = [];
  for (const entry of entries) {
    // Windows puts machine-level bookkeeping at drive roots that nobody is
    // ever picking as a project folder.
    if (entry.name.startsWith("$") || entry.name === "System Volume Information") {
      continue;
    }
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      try {
        if (!(await stat(full)).isDirectory()) {
          continue;
        }
      } catch {
        continue;
      }
    }
    folders.push({ name: entry.name, path: full });
  }
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return folders;
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

function bearerToken(request) {
  return String(request.headers.authorization || "").match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
}

function requestIsAuthenticated(request) {
  return tokenMatches(bearerToken(request), SESSION_TOKEN);
}

/**
 * Shutdown also accepts the launch token.
 *
 * A second launcher offering "Stop it" has the launch token from
 * `runtime.json` and no way to get a session token — and asking politely over
 * HTTP is how a detached server gets to dispose its `claude` runners instead of
 * having them orphaned by a signal.
 */
function requestMayShutDown(request) {
  const token = bearerToken(request);
  return tokenMatches(token, SESSION_TOKEN) || tokenMatches(token, LAUNCH_TOKEN);
}

function authorizeBrowser(response) {
  applySecurityHeaders(response);
  response.writeHead(303, {
    "Cache-Control": "no-store",
    "Location": `/#studio-token=${encodeURIComponent(SESSION_TOKEN)}`,
  });
  response.end();
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
    // Studio runs detached with no console, so this file is the only place a
    // failure is written down. The UI shows the path rather than making people
    // guess it.
    logFile: path.join(DATA_DIRECTORY, "studio.log"),
    projects,
    limit: limitWatch.snapshot(),
    queue: turnQueue.list(),
  };
}

function projectById(projects, projectId) {
  return projects.find((project) => project.id === projectId) || null;
}

function parseSessionPath(pathname) {
  const match = pathname.match(
    /^\/api\/sessions\/([^/]+)(?:\/(abort|organize|permission-mode))?$/i,
  );
  if (!match || !isSessionId(match[1])) {
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
      limit: limitWatch.snapshot(),
      queue: turnQueue.list(),
    })}\n\n`,
  );
  // A window came back — this was a reload, not a close.
  cancelCloseWithLastWindow();
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

  // Backs the folder picker. Listing directory names is well inside what this
  // authenticated loopback client can already do — it reads your transcripts
  // and drives a Claude session with tool access — and it never returns files.
  if (request.method === "GET" && url.pathname === "/api/browse") {
    const requested = url.searchParams.get("path");
    const roots = await browseRoots();
    if (!requested) {
      json(response, 200, { path: null, parent: null, roots, folders: [] });
      return true;
    }
    const directory = canonicalDirectory(requested);
    if (!directory) {
      json(response, 404, { error: "That folder does not exist." });
      return true;
    }
    try {
      const parent = path.dirname(directory);
      json(response, 200, {
        path: directory,
        parent: parent === directory ? null : parent,
        roots,
        folders: await browseDirectory(directory),
      });
    } catch (error) {
      json(response, 403, {
        error:
          error.code === "EPERM" || error.code === "EACCES"
            ? "Windows will not let Studio read that folder."
            : `Could not read that folder: ${error.message}`,
      });
    }
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/auth") {
    const account = await claude.accountInfo({ cwd: WORKSPACE_ROOT });
    json(response, 200, { account });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    try {
      json(response, 200, await claude.beginLogin({ cwd: WORKSPACE_ROOT }));
    } catch (error) {
      json(response, error.unsupported ? 501 : 500, { error: error.message });
    }
    return true;
  }

  // No code: wait for the CLI's own loopback listener to catch the redirect.
  // With one: submit what the user pasted from the manual page.
  if (request.method === "POST" && url.pathname === "/api/auth/complete") {
    const body = await readJson(request);
    try {
      await claude.completeLogin({
        code: typeof body.code === "string" && body.code ? body.code : null,
        state: typeof body.state === "string" && body.state ? body.state : null,
      });
      const account = await claude.accountInfo({ cwd: WORKSPACE_ROOT });
      broadcast({ type: "auth.changed", data: { account } });
      json(response, 200, { account });
    } catch (error) {
      json(response, error.unsupported ? 501 : 400, { error: error.message });
    }
    return true;
  }

  // Answer before restarting: the response rides a connection this is about to
  // close, and the browser needs the 202 to start polling /api/ping.
  // Backs the Refresh button in the Usage dialog. On demand only — see the
  // startup probe for why this is never on a timer.
  if (request.method === "POST" && url.pathname === "/api/limit/refresh") {
    json(response, 200, { limit: await limitWatch.check() });
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/restart") {
    json(response, 202, { restarting: true });
    setTimeout(() => {
      restartStudio().catch((error) => {
        console.error("Restart failed:", error);
        process.exit(1);
      });
    }, 150);
    return true;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/cancel") {
    claude.cancelLogin();
    json(response, 200, { ok: true });
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
    // A parked turn for a session that no longer exists must not wake up later.
    if (turnQueue.cancel(sessionPath.sessionId)) {
      limitWatch.setPendingCount(turnQueue.size());
      broadcast(watchPayload());
    }
    broadcast({ type: "sessions-changed" });
    json(response, 200, { ok: true });
    return true;
  }

  if (request.method === "POST" && sessionPath?.action === "abort") {
    await claude.abort(sessionPath.sessionId);
    json(response, 200, { ok: true });
    return true;
  }

  // The permission dropdown, applied to the session that is running *now*.
  // Deferring this to the next message is what made Autopilot look broken.
  if (request.method === "POST" && sessionPath?.action === "permission-mode") {
    const body = await readJson(request);
    const permissionMode = String(body.permissionMode || "");
    if (!isKnownPermissionMode(permissionMode)) {
      json(response, 400, { error: "Choose a valid permission mode." });
      return true;
    }
    let applied = false;
    try {
      applied = await claude.setPermissionMode(sessionPath.sessionId, permissionMode);
    } catch (error) {
      json(response, 409, {
        error: `Claude Code would not switch to that mode: ${error.message}`,
      });
      return true;
    }
    const approved = applyModeToPendingPermissions(sessionPath.sessionId, permissionMode);
    json(response, 200, { ok: true, applied, approved });
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
    // The id becomes a transcript filename, so reject anything that is not a
    // real session id rather than letting a malformed client mint one.
    if (requestedSessionId !== null && !isSessionId(requestedSessionId)) {
      json(response, 400, { error: "That conversation id is not valid." });
      return true;
    }
    // Typing while Claude works is not an error — it is how the terminal
    // behaves. The message rides the CLI's own command queue: 'next' runs when
    // the current turn finishes, 'now' (/btw) folds into the turn in flight.
    const turnInFlight = Boolean(
      requestedSessionId &&
        (pendingMessageSessions.has(requestedSessionId) ||
          sessionStreams.get(requestedSessionId)?.running),
    );
    const priority = body.priority === "now" ? "now" : turnInFlight ? "next" : null;
    if (priority && !claude.isRunning(requestedSessionId)) {
      json(response, 409, {
        error: "That conversation is busy in another window. Try again in a moment.",
      });
      return true;
    }

    const sessionId = requestedSessionId || crypto.randomUUID();

    // Park the turn instead of sending it. Attachments are marked against the
    // session right away so the pending-upload pruner cannot delete them out
    // from under a turn that waits hours for the window to reset.
    if (body.queueForReset) {
      if (uploadIds.length) {
        await uploadStore.markAttached(uploadIds, sessionId);
      }
      await stateStore.setSessionProject(sessionId, selectedProject.id);
      const entry = turnQueue.add({
        sessionId,
        projectId: selectedProject.id,
        isNewSession: !requestedSessionId,
        prompt,
        uploadIds,
        model: body.model || null,
        effort: body.effort || null,
        permissionMode,
      });
      limitWatch.setPendingCount(turnQueue.size());
      broadcast(watchPayload());
      json(response, 202, { sessionId, queued: entry, limit: limitWatch.snapshot() });
      return true;
    }

    let sent;
    try {
      sent = await deliverTurn({
        sessionId,
        isNewSession: !requestedSessionId,
        project: selectedProject,
        prompt,
        uploadIds,
        model: body.model || null,
        effort: body.effort || null,
        permissionMode,
        priority,
      });
    } catch (error) {
      json(response, 500, { error: error.message });
      return true;
    }

    json(response, 202, {
      sessionId,
      queued: Boolean(sent?.queued),
      priority: sent?.queued ? priority : null,
      messageUuid: sent?.messageUuid || null,
    });
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/watch") {
    json(response, 200, { limit: limitWatch.snapshot(), queue: turnQueue.list() });
    return true;
  }

  // A manual "check now", for when you want to know where you stand without
  // waiting for the next poll or for a session to report in.
  if (request.method === "POST" && url.pathname === "/api/watch/check") {
    const limit = await limitWatch.check();
    json(response, 200, { limit, queue: turnQueue.list() });
    return true;
  }

  const queueMatch = url.pathname.match(/^\/api\/watch\/queue\/([^/]+)$/i);
  if (request.method === "DELETE" && queueMatch && isSessionId(queueMatch[1])) {
    const cancelled = turnQueue.cancel(queueMatch[1]);
    if (!cancelled) {
      json(response, 404, { error: "Nothing is queued for that conversation." });
      return true;
    }
    limitWatch.setPendingCount(turnQueue.size());
    broadcast(watchPayload());
    json(response, 200, { cancelled });
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
    settlePermission(permissionMatch[1], pending, result);
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
    // Unauthenticated on purpose, and says nothing a caller on this loopback
    // port could not already infer: it exists so a second launcher can tell
    // "Studio already owns this port" from "something else does".
    if (request.method === "GET" && url.pathname === "/api/ping") {
      // `windows` lets a second launcher tell "Studio is running with a window
      // already open" from "Studio is running headless". Without it every
      // launch opened another window, and they stack up until the taskbar is
      // full of Studios where only the newest is connected to anything.
      json(response, 200, { app: "claude-cli-studio", windows: eventClients.size });
      return;
    }
    // The window is going away. Studio behaves like an application — closing it
    // stops it — but never at the cost of work in flight.
    if (request.method === "POST" && url.pathname === "/api/window-closed") {
      enforceSameOrigin(request, ALLOWED_ORIGINS);
      if (!requestIsAuthenticated(request)) {
        json(response, 401, { error: "Studio authentication is required." });
        return;
      }
      json(response, 202, { stopping: scheduleCloseWithLastWindow() });
      return;
    }

    // Quitting is the one thing a launcher can ask for with only the launch
    // token, so it is gated before the session-token wall rather than behind it.
    if (request.method === "POST" && url.pathname === "/api/shutdown") {
      enforceSameOrigin(request, ALLOWED_ORIGINS);
      if (!requestMayShutDown(request)) {
        json(response, 401, { error: "Studio authentication is required." });
        return;
      }
      json(response, 202, { stopping: true });
      setTimeout(() => {
        quitStudio().catch(() => process.exit(1));
      }, 150);
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
    // `cmd /c start` flashes a console window without this.
    windowsHide: true,
  });
  child.on("error", () => {});
  child.unref();
}

/**
 * Leaves no launch directory behind on an exit path. The restart path
 * deliberately does NOT call this — that process goes on to serve, and the
 * files it already wrote are the ones the browser is about to be sent to.
 */
async function exitAfterCleanup(code) {
  await removeLaunchFiles().catch(() => {});
  process.exit(code);
}

/** Restarts this script on another port, keeping the launcher's console. */
function relaunchOnPort(port) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: { ...process.env, CLAUDE_STUDIO_PORT: String(port) },
    stdio: "inherit",
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/**
 * Decides what a second launch should do about the port being busy.
 *
 * Double-clicking the launcher while one is already up used to die on
 * EADDRINUSE before printing anything useful — the window flashed and closed.
 * Now it identifies what holds the port and offers the choice, because the
 * person who double-clicked an icon should never have to open a terminal to
 * get out of this.
 *
 * Stopping a process is only ever offered for something we positively
 * identified as Studio, and never by default. An unrecognised process gets a
 * free port instead — taking a guess and killing it could take out a database
 * or someone's dev server.
 */
async function resolvePortConflict() {
  const [holder, owner] = await Promise.all([probePortHolder(), findPortOwner()]);
  const launchHref = await runningStudioLaunchHref();
  const ownerLabel = owner ? `${owner.name}, pid ${owner.pid}` : "unidentified process";
  const preset = (process.env.CLAUDE_STUDIO_ON_CONFLICT || "").trim().toLowerCase();
  const isStudio = holder === "current" || holder === "legacy";

  if (isStudio) {
    console.log(
      `\nClaude CLI Studio is already running on port ${PORT} (${ownerLabel}).` +
        (holder === "legacy" ? "\nIt is an older version than this one." : ""),
    );
    const choices = [];
    if (launchHref) {
      choices.push({
        key: "o",
        label: "Open the one already running",
        default: holder === "current",
      });
    }
    if (owner) {
      choices.push({
        key: "r",
        label: "Close it and start this version instead",
        default: !launchHref,
      });
    }
    choices.push({ key: "q", label: "Quit" });

    const choice =
      ["open", "restart", "quit"].includes(preset)
        ? preset[0]
        : await askChoice("What would you like to do?", choices);

    if (choice === "o" && launchHref) {
      console.log("Opening the running Studio in your browser.");
      openBrowser(launchHref);
      await exitAfterCleanup(0);
    }
    if (choice === "r" && owner) {
      console.log(`Closing the running Studio (pid ${owner.pid})…`);
      if (!(await stopProcessAndWait(owner.pid))) {
        console.error("It would not close. Close its window by hand, then try again.");
        await exitAfterCleanup(1);
      }
      console.log("Closed. Starting this version.");
      server.listen(PORT, HOST);
      return;
    }
    if (choice === "q") {
      await exitAfterCleanup(0);
    }
    // Nobody was there to answer: keep the old unattended behaviour.
    if (launchHref) {
      console.log("Opening the running Studio in your browser.");
      openBrowser(launchHref);
      await exitAfterCleanup(0);
    }
    console.error(`Port ${PORT} is held by Claude CLI Studio, but it could not be opened.`);
    console.error("Close that window and start Studio again.");
    await exitAfterCleanup(1);
  }

  console.log(`\nPort ${PORT} is being used by another program (${ownerLabel}).`);
  console.log("That is not Claude Studio, so it will be left alone.");
  const free = await findFreePort(PORT + 1);
  const choice =
    ["port", "fail"].includes(preset)
      ? preset
      : await askChoice("What would you like to do?", [
          ...(free
            ? [{ key: "p", label: `Start Studio on port ${free} instead`, default: true }]
            : []),
          { key: "q", label: "Quit" },
        ]);

  if ((choice === "p" || choice === "port") && free) {
    console.log(`Starting Studio on port ${free}.`);
    await removeLaunchFiles().catch(() => {});
    relaunchOnPort(free);
    return;
  }
  if (choice === "q") {
    await exitAfterCleanup(0);
  }
  console.error(
    free
      ? `Set CLAUDE_STUDIO_PORT=${free} to use a free port.`
      : "Set CLAUDE_STUDIO_PORT to a free port and try again.",
  );
  await exitAfterCleanup(1);
}

let conflictHandled = false;
server.on("error", async (error) => {
  // Anything else is a genuine failure. Report it and stop — rethrowing from
  // an async handler would only surface as an unhandled rejection.
  if (error.code !== "EADDRINUSE") {
    console.error(error);
    process.exit(1);
  }
  if (conflictHandled) {
    console.error(`Port ${PORT} is still busy. Nothing further to try.`);
    process.exit(1);
  }
  conflictHandled = true;
  await resolvePortConflict();
});

server.listen(PORT, HOST, async () => {
  await writeRuntimeFile().catch(() => {});
  await pruneStaleLaunchDirectories();
  // One probe at startup so the usage meter has numbers to draw immediately.
  // Without it the sidebar stays blank until a turn happens to report a
  // rate_limit_event, which is exactly when you are least likely to be looking.
  // It is not repeated on a timer: a probe is a real /v1/messages call against
  // the user's own window, so polling it to keep a bar fresh would be
  // self-defeating. The Refresh button in the Usage dialog asks for more.
  limitWatch.check().catch(() => {});

  const restored = await restoreTurnQueue().catch(() => 0);
  if (restored) {
    console.log(
      `${restored} parked turn${restored === 1 ? "" : "s"} restored — waiting for the usage window.`,
    );
    broadcast(watchPayload());
  }
  console.log(`Claude CLI Studio is running at ${EXPECTED_ORIGIN}`);
  console.log(`Workspace root: ${WORKSPACE_ROOT}`);
  const cli = await cliInfo();
  if (cli.available) {
    console.log(`Claude Code ${cli.version} · sessions read from ~/.claude`);
  } else {
    console.log(`Claude Code CLI not found. ${cli.message}`);
  }
  // A restart keeps the tab that asked for it — it reloads itself once this
  // server answers again — so opening a second one would be a surprise.
  if (process.env.CLAUDE_STUDIO_RESTARTED === "1") {
    console.log("Restarted. The tab you clicked Restart in will reconnect itself.");
  } else if (process.env.CLAUDE_STUDIO_OPEN === "0") {
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
  limitWatch.dispose();
  await removeLaunchFiles().catch(() => {});
  await rm(RUNTIME_FILE, { force: true }).catch(() => {});
  for (const timeout of streamCleanupTimers.values()) {
    clearTimeout(timeout);
  }
  // SSE clients hold connections open forever, so close() alone would never
  // resolve — which matters for restart, where the port has to be free before
  // the replacement can bind it.
  for (const client of eventClients) {
    client.end();
  }
  eventClients.clear();
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  await claude.stop();
}

/**
 * Closing the last window stops Studio — after a short grace period, and never
 * while there is work to lose.
 *
 * The grace period is what separates "closed" from "reloaded": a reload, an F5,
 * or following a link all fire the same page-is-going-away event, and all
 * reconnect within a second or two. Any new event-stream client cancels the
 * countdown.
 *
 * Work in flight always wins. A running turn or a parked turn means Studio was
 * deliberately left to work alone, and tidying up a window must not kill it —
 * that is the entire reason it was made to survive its launcher in the first
 * place. `CLAUDE_STUDIO_KEEP_ALIVE=1` opts out of closing altogether.
 */
const CLOSE_GRACE_MS = 8000;
let closeTimer = null;

/**
 * What outranks a window close.
 *
 * Only parked turns. They are the whole point of the watch — it fires them
 * hours later when the usage window resets, which cannot happen if closing a
 * window takes the server down with it.
 *
 * A turn in flight deliberately does NOT count. The browser asks before closing
 * while Claude is working, so a close that gets this far is an answered
 * question, and second-guessing it would make the dialog a lie.
 */
function workInFlight() {
  return turnQueue.size() > 0;
}

function cancelCloseWithLastWindow() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

function scheduleCloseWithLastWindow() {
  if (process.env.CLAUDE_STUDIO_KEEP_ALIVE === "1" || workInFlight()) {
    return false;
  }
  cancelCloseWithLastWindow();
  closeTimer = setTimeout(() => {
    closeTimer = null;
    // Re-check everything at the moment of truth: a tab may have reconnected,
    // or the watch may have released a parked turn while we counted down.
    if (eventClients.size > 0 || workInFlight()) {
      return;
    }
    console.log("Last window closed. Stopping.");
    quitStudio().catch(() => process.exit(1));
  }, CLOSE_GRACE_MS);
  closeTimer.unref?.();
  return true;
}

/**
 * Stops Studio for good, at the user's request.
 *
 * This is what the sidebar's Quit button and the launcher's "Stop it" both
 * reach. It matters more now than it used to: once Studio survives the window
 * that launched it, closing that window is no longer a way to stop it, so there
 * has to be one that is.
 */
async function quitStudio() {
  console.log("Stopping at your request…");
  await shutdown();
  process.exit(0);
}

/**
 * Replaces this server with a fresh one, in place.
 *
 * The point of a Restart button is that the tab you clicked it from keeps
 * working, so both tokens are carried across: a new session token would leave
 * that tab holding a dead one and staring at the sign-in card, which is the
 * lockout this whole change set exists to remove.
 *
 * The replacement inherits stdio rather than detaching, so the launcher window
 * still owns it and "close this window to stop it" stays true.
 */
async function restartStudio() {
  console.log("Restarting at your request…");
  await shutdown();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    env: {
      ...process.env,
      CLAUDE_STUDIO_TOKEN: LAUNCH_TOKEN,
      CLAUDE_STUDIO_SESSION_TOKEN: SESSION_TOKEN,
      CLAUDE_STUDIO_RESTARTED: "1",
    },
    stdio: "inherit",
  });

  // Without this handler a failed spawn raises an unhandled 'error' event,
  // which kills this process with a stack trace — the browser is left polling
  // a port nothing will ever answer on, with no clue why.
  const stranded = (reason) => {
    console.error(`\nStudio could not restart: ${reason}`);
    console.error("Close this window and start Claude Studio again.");
    process.exit(1);
  };
  child.on("error", (error) => stranded(error.message));
  child.on("exit", (code) => {
    if (code) {
      stranded(`the replacement exited with code ${code}`);
    }
    process.exit(0);
  });
}

process.on("SIGINT", async () => {
  await shutdown();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await shutdown();
  process.exit(0);
});
