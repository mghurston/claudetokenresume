/**
 * The Studio token is kept in localStorage, not sessionStorage.
 *
 * sessionStorage dies with the tab, and the launch handoff used to be
 * single-use — so closing the tab and reopening 127.0.0.1 left the app 401ing
 * with no way to authenticate. localStorage survives the tab; the server keeps
 * its launch route redeemable so a restarted server can re-issue.
 */
const TOKEN_KEY = "claude-cli-studio-token";
const launchToken = new URLSearchParams(window.location.hash.slice(1)).get(
  "studio-token",
);
if (launchToken) {
  localStorage.setItem(TOKEN_KEY, launchToken);
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}
let studioToken =
  launchToken || localStorage.getItem(TOKEN_KEY) || sessionStorage.getItem(TOKEN_KEY) || "";

const state = {
  bootstrap: null,
  activeSessionId: null,
  activeProjectId: "general",
  activeSessionTitle: "New chat",
  attachments: [],
  uploading: 0,
  sending: false,
  navigationEpoch: 0,
  pendingNavigationSends: new Set(),
  pendingSessionSends: new Set(),
  runningSessions: new Set(),
  terminalSessions: new Set(),
  streamSnapshots: new Map(),
  renderedSessionId: null,
  renderedEventIds: new Set(),
  sessionLoadToken: 0,
  liveMessages: new Map(),
  activities: new Map(),
  currentPermission: null,
  permissionQueue: [],
  collapsedProjects: new Set(),
  limit: null,
  queue: [],
  queueForReset: false,
  pendingMessages: new Map(),
  suggestion: null,
};

const elements = {
  activeProjectPill: document.querySelector("#activeProjectPill"),
  activeRepoLink: document.querySelector("#activeRepoLink"),
  addProjectButton: document.querySelector("#addProjectButton"),
  approveOnceButton: document.querySelector("#approveOnceButton"),
  approveSessionButton: document.querySelector("#approveSessionButton"),
  attachmentStrip: document.querySelector("#attachmentStrip"),
  attachButton: document.querySelector("#attachButton"),
  closeSidebarButton: document.querySelector("#closeSidebarButton"),
  composer: document.querySelector("#composer"),
  composerNote: document.querySelector("#composerNote"),
  connectionDetail: document.querySelector("#connectionDetail"),
  connectionLabel: document.querySelector("#connectionLabel"),
  conversationArea: document.querySelector("#conversationArea"),
  conversationTitle: document.querySelector("#conversationTitle"),
  deleteButton: document.querySelector("#deleteButton"),
  denyPermissionButton: document.querySelector("#denyPermissionButton"),
  dropOverlay: document.querySelector("#dropOverlay"),
  browseChoose: document.querySelector("#browseChoose"),
  browseDialog: document.querySelector("#browseDialog"),
  browseError: document.querySelector("#browseError"),
  browseForm: document.querySelector("#browseForm"),
  browseList: document.querySelector("#browseList"),
  browsePath: document.querySelector("#browsePath"),
  browseRoots: document.querySelector("#browseRoots"),
  browseUp: document.querySelector("#browseUp"),
  usageDialog: document.querySelector("#usageDialog"),
  usageNote: document.querySelector("#usageNote"),
  usageRefresh: document.querySelector("#usageRefresh"),
  usageWindows: document.querySelector("#usageWindows"),
  alertsButton: document.querySelector("#alertsButton"),
  sidebarResizer: document.querySelector("#sidebarResizer"),
  quitButton: document.querySelector("#quitButton"),
  quitConfirm: document.querySelector("#quitConfirm"),
  quitLogPath: document.querySelector("#quitLogPath"),
  quitDialog: document.querySelector("#quitDialog"),
  quitForm: document.querySelector("#quitForm"),
  quitOverlay: document.querySelector("#quitOverlay"),
  quitWarning: document.querySelector("#quitWarning"),
  restartButton: document.querySelector("#restartButton"),
  restartConfirm: document.querySelector("#restartConfirm"),
  restartDialog: document.querySelector("#restartDialog"),
  restartForm: document.querySelector("#restartForm"),
  restartOverlay: document.querySelector("#restartOverlay"),
  restartReload: document.querySelector("#restartReload"),
  restartStatus: document.querySelector("#restartStatus"),
  restartWarning: document.querySelector("#restartWarning"),
  signinOverlay: document.querySelector("#signinOverlay"),
  signinReason: document.querySelector("#signinReason"),
  signinRetry: document.querySelector("#signinRetry"),
  effortSelect: document.querySelector("#effortSelect"),
  fileInput: document.querySelector("#fileInput"),
  ghostSuggestion: document.querySelector("#ghostSuggestion"),
  ghostText: document.querySelector("#ghostText"),
  limitBar: document.querySelector("#limitBar"),
  limitDetail: document.querySelector("#limitDetail"),
  limitLabel: document.querySelector("#limitLabel"),
  limitMeter: document.querySelector("#limitMeter"),
  limitValue: document.querySelector("#limitValue"),
  messageInput: document.querySelector("#messageInput"),
  messages: document.querySelector("#messages"),
  modeSelect: document.querySelector("#modeSelect"),
  modelSelect: document.querySelector("#modelSelect"),
  newChatButton: document.querySelector("#newChatButton"),
  openSidebarButton: document.querySelector("#openSidebarButton"),
  permissionDetails: document.querySelector("#permissionDetails"),
  permissionDialog: document.querySelector("#permissionDialog"),
  permissionFeedback: document.querySelector("#permissionFeedback"),
  permissionIntention: document.querySelector("#permissionIntention"),
  projectDialog: document.querySelector("#projectDialog"),
  projectForm: document.querySelector("#projectForm"),
  projectKeywordsInput: document.querySelector("#projectKeywordsInput"),
  projectNameInput: document.querySelector("#projectNameInput"),
  projectPathInput: document.querySelector("#projectPathInput"),
  projectSelect: document.querySelector("#projectSelect"),
  renameButton: document.querySelector("#renameButton"),
  renameDialog: document.querySelector("#renameDialog"),
  renameForm: document.querySelector("#renameForm"),
  renameInput: document.querySelector("#renameInput"),
  runScanButton: document.querySelector("#runScanButton"),
  saveProjectButton: document.querySelector("#saveProjectButton"),
  saveRenameButton: document.querySelector("#saveRenameButton"),
  scanDialog: document.querySelector("#scanDialog"),
  scanForm: document.querySelector("#scanForm"),
  scanLocalButton: document.querySelector("#scanLocalButton"),
  scanPathInput: document.querySelector("#scanPathInput"),
  sendButton: document.querySelector("#sendButton"),
  sessionNav: document.querySelector("#sessionNav"),
  sessionSearch: document.querySelector("#sessionSearch"),
  sidebarBackdrop: document.querySelector("#sidebarBackdrop"),
  statusDot: document.querySelector("#statusDot"),
  stopButton: document.querySelector("#stopButton"),
  themeButton: document.querySelector("#themeButton"),
  toastRegion: document.querySelector("#toastRegion"),
  uploadStatus: document.querySelector("#uploadStatus"),
  watchButton: document.querySelector("#watchButton"),
  welcome: document.querySelector("#welcome"),
};

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const iconDefinitions = {
  chevron: { className: "chevron", paths: [{ d: "m7 9 5 5 5-5" }] },
  file: { paths: [{ d: "M6 3h8l4 4v14H6V3Z" }, { d: "M14 3v5h5" }] },
  folder: { paths: [{ d: "M3 6h7l2 2h9v11H3V6Z" }] },
  github: {
    paths: [
      {
        d: "M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1 1.6 1 .9 1.6 2.4 1.1 2.9.9.1-.7.4-1.1.7-1.3-2.2-.3-4.6-1.1-4.6-5A3.9 3.9 0 0 1 6.8 8c-.1-.3-.5-1.3.1-2.7 0 0 .9-.3 2.8 1.1A9.7 9.7 0 0 1 12 6.1c.8 0 1.6.1 2.4.3 1.9-1.4 2.8-1.1 2.8-1.1.6 1.4.2 2.4.1 2.7a3.9 3.9 0 0 1 1 2.7c0 3.9-2.4 4.7-4.6 5 .4.3.7 1 .7 2v3c0 .3.2.6.7.5A10 10 0 0 0 12 2Z",
      },
    ],
  },
  plus: { paths: [{ d: "M12 5v14M5 12h14" }] },
  remove: { paths: [{ d: "m7 7 10 10M17 7 7 17" }] },
  robot: {
    paths: [{ d: "M12 2.6 4.2 19.4h3.3l1.6-3.7h5.8l1.6 3.7h3.3L12 2.6Zm-1.7 10.2L12 8.6l1.7 4.2h-3.4Z" }],
  },
  tool: {
    paths: [
      { d: "M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.4 2.4-3-3 2.4-2.4Z" },
    ],
  },
};

function iconNode(name) {
  const definition = iconDefinitions[name];
  const svg = document.createElementNS(SVG_NAMESPACE, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  if (definition.className) {
    svg.classList.add(definition.className);
  }
  for (const pathDefinition of definition.paths) {
    const pathNode = document.createElementNS(SVG_NAMESPACE, "path");
    pathNode.setAttribute("d", pathDefinition.d);
    if (pathDefinition.className) {
      pathNode.classList.add(pathDefinition.className);
    }
    svg.append(pathNode);
  }
  return svg;
}

function indicatorNode(className) {
  const indicator = document.createElement("span");
  indicator.className = className;
  indicator.append(
    document.createElement("span"),
    document.createElement("span"),
    document.createElement("span"),
  );
  return indicator;
}

async function api(url, options = {}) {
  const requestOptions = {
    ...options,
    headers: {
      ...(studioToken ? { Authorization: `Bearer ${studioToken}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  };
  let response;
  try {
    response = await fetch(url, requestOptions);
  } catch {
    // fetch only rejects when the request never completed, and on loopback
    // that means the server is gone. "Failed to fetch" tells the user nothing.
    setServerUnreachable();
    const error = new Error(
      "Studio's server isn't running. Start Claude Studio again, then use the tab it opens.",
    );
    error.offline = true;
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) {
      showSigninOverlay(
        studioToken
          ? "The token this tab holds belongs to an earlier run of the server."
          : "This tab was opened without a Studio token.",
      );
    }
    const error = new Error(payload.error || `Request failed with status ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

/**
 * Says the server is gone, rather than leaving the page looking merely idle.
 * A dimmed status dot is far too quiet for "nothing you do will work".
 */
function setServerUnreachable() {
  elements.statusDot.classList.remove("connected");
  elements.statusDot.classList.add("error");
  elements.connectionLabel.textContent = "Studio's server is not running";
  elements.connectionDetail.textContent = "Start Claude Studio again";
}

/**
 * A 401 means the token is stale or absent, and the browser cannot mint a new
 * one — only the server can, through the launch handoff. So drop the dead
 * token and say plainly what to do, instead of leaving a dead-looking UI.
 */
function showSigninOverlay(reason) {
  if (studioToken) {
    localStorage.removeItem(TOKEN_KEY);
    sessionStorage.removeItem(TOKEN_KEY);
    studioToken = "";
  }
  // Whatever else is on screen, this is the only actionable thing left.
  elements.restartOverlay?.classList.add("hidden");
  // Several requests fail together on a dead token. The first reason is the
  // accurate one — by the second call the token has already been cleared, so
  // it would wrongly report the tab as having opened without one.
  if (elements.signinOverlay.classList.contains("hidden")) {
    elements.signinReason.textContent = reason;
    elements.signinOverlay.classList.remove("hidden");
  }
}

elements.signinRetry?.addEventListener("click", () => {
  window.location.reload();
});

elements.restartReload?.addEventListener("click", () => {
  window.location.reload();
});

/**
 * A folder picker that walks the real filesystem.
 *
 * Typing an absolute path from memory is a poor ask, and the browser cannot
 * help: `showDirectoryPicker` yields a handle with only a name, and a
 * directory file input yields relative paths. Neither can produce the absolute
 * path the server needs. So the server lists directories and this walks them.
 * The text field stays — browsing is the addition, not the replacement.
 */
const browseState = { target: null, path: null, parent: null };

function browseEntryNode(label, targetPath, { isFolder = true } = {}) {
  const item = document.createElement("li");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "browse-entry";
  if (isFolder) {
    button.append(iconNode("folder"));
  }
  const text = document.createElement("span");
  text.textContent = label;
  button.append(text);
  button.addEventListener("click", () => loadBrowseDirectory(targetPath));
  item.append(button);
  return item;
}

async function loadBrowseDirectory(directory) {
  elements.browseError.classList.add("hidden");
  let payload;
  try {
    payload = await api(
      `/api/browse${directory ? `?path=${encodeURIComponent(directory)}` : ""}`,
    );
  } catch (error) {
    elements.browseError.textContent = error.message;
    elements.browseError.classList.remove("hidden");
    // A path that does not resolve must not leave a dialog with nothing in it.
    // Fall back to the drive list so there is always somewhere to go next.
    if (directory) {
      await loadBrowseDirectory(null);
      elements.browseError.textContent = error.message;
      elements.browseError.classList.remove("hidden");
    }
    return;
  }

  browseState.path = payload.path;
  browseState.parent = payload.parent;
  elements.browsePath.textContent = payload.path || "Select a drive to start";
  elements.browseChoose.disabled = !payload.path;
  elements.browseUp.disabled = !payload.parent;

  elements.browseRoots.replaceChildren();
  for (const root of payload.roots) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary browse-root";
    button.textContent = root.name;
    button.addEventListener("click", () => loadBrowseDirectory(root.path));
    elements.browseRoots.append(button);
  }

  elements.browseList.replaceChildren();
  if (payload.parent) {
    elements.browseList.append(browseEntryNode("..", payload.parent, { isFolder: false }));
  }
  for (const folder of payload.folders) {
    elements.browseList.append(browseEntryNode(folder.name, folder.path));
  }
  if (payload.path && payload.folders.length === 0) {
    const empty = document.createElement("li");
    empty.className = "browse-empty";
    empty.textContent = "No sub-folders here. You can still use this one.";
    elements.browseList.append(empty);
  }
  elements.browseList.scrollTop = 0;
}

document.querySelectorAll("[data-browse-for]").forEach((button) => {
  button.addEventListener("click", () => {
    browseState.target = document.querySelector(`#${button.dataset.browseFor}`);
    elements.browseDialog.showModal();
    // Start where the field already points, so reopening resumes rather than
    // sending you back to the drive list.
    loadBrowseDirectory(browseState.target?.value.trim() || null);
  });
});

// The server decides what "up" means — a drive root has no parent, and
// re-deriving it from the string would get that wrong on Windows.
elements.browseUp?.addEventListener("click", () => {
  loadBrowseDirectory(browseState.parent);
});

elements.browseForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (browseState.path && browseState.target) {
    browseState.target.value = browseState.path;
    browseState.target.dispatchEvent(new Event("input", { bubbles: true }));
  }
  elements.browseDialog.close();
});

/**
 * Restarts Studio's server from the UI, so upgrading or clearing a wedged
 * server never means finding a terminal.
 *
 * The server carries both tokens across the restart, so this tab stays signed
 * in — it only has to wait for the port to answer again and reload. `/api/ping`
 * is unauthenticated, which is what makes the wait pollable.
 */
async function restartStudio() {
  elements.restartOverlay.classList.remove("hidden");
  elements.restartStatus.textContent = "Waiting for the server to come back.";
  try {
    await api("/api/restart", { method: "POST" });
  } catch (error) {
    // A 401 means the request was never authorized, so nothing restarted —
    // waiting for a server that was never asked to go down is a dead end, and
    // it is what left this overlay spinning forever. `api` has already raised
    // the sign-in card; get out of its way.
    if (error.status === 401) {
      elements.restartOverlay.classList.add("hidden");
      return;
    }
    // Any other definite HTTP status is a real refusal, not the connection
    // being torn down under its own response.
    if (error.status) {
      elements.restartOverlay.classList.add("hidden");
      showToast(error.message, "error");
      return;
    }
  }

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 700));
    let probe;
    try {
      probe = await fetch("/api/ping", { cache: "no-store" });
    } catch {
      // Genuinely down mid-restart; keep waiting.
      continue;
    }
    const body = await probe.json().catch(() => null);
    if (body?.app === "claude-cli-studio") {
      elements.restartStatus.textContent = "Back up. Reloading…";
      window.location.reload();
      return;
    }
    // Something answered but it is not a Studio that knows this route — an
    // older build still holding the port. Waiting will not change that.
    elements.restartStatus.textContent =
      "The server on this port is not the Studio this page came from. Close the launcher window, start Claude Studio again, then reload.";
    elements.restartReload.classList.remove("hidden");
    return;
  }
  elements.restartStatus.textContent =
    "Studio has not come back. Check the launcher window, then reload this page.";
  elements.restartReload.classList.remove("hidden");
}

elements.restartButton?.addEventListener("click", () => {
  const running = state.runningSessions.size;
  const queued = state.queue.length;
  const warnings = [];
  if (running) {
    warnings.push(`${running} ${running === 1 ? "turn is" : "turns are"} still running and will be stopped`);
  }
  if (queued) {
    // The queue is deliberately in-memory only, so a restart is where it goes.
    warnings.push(`${queued} queued ${queued === 1 ? "message" : "messages"} will be discarded`);
  }
  elements.restartWarning.textContent = warnings.length
    ? `${warnings.join(", and ")}.`
    : "";
  elements.restartWarning.classList.toggle("hidden", warnings.length === 0);
  elements.restartDialog.showModal();
});

elements.restartForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  elements.restartDialog.close();
  restartStudio();
});

/**
 * Stops the server for good.
 *
 * This exists because Studio now outlives the window that launched it: closing
 * that window is no longer a way to stop it, so there has to be one here. The
 * overlay stays up afterwards rather than retrying — unlike Restart, nothing is
 * coming back.
 */
async function quitStudio() {
  try {
    await api("/api/shutdown", { method: "POST" });
  } catch (error) {
    // A 401 is never a retry — `api` has already raised the sign-in card.
    if (error.status === 401) {
      return;
    }
    if (error.status) {
      showToast(error.message, "error");
      return;
    }
    // No status: the connection died under its own response, which is what
    // stopping looks like from here.
  }
  elements.quitOverlay?.classList.remove("hidden");
}

elements.quitButton?.addEventListener("click", () => {
  const running = state.runningSessions.size;
  const queued = state.queue.length;
  const warnings = [];
  if (running) {
    warnings.push(
      `${running} ${running === 1 ? "turn is" : "turns are"} still running and will be stopped`,
    );
  }
  if (queued) {
    warnings.push(
      `${queued} queued ${queued === 1 ? "message" : "messages"} will be discarded`,
    );
  }
  if (elements.quitLogPath && state.bootstrap?.logFile) {
    elements.quitLogPath.textContent = state.bootstrap.logFile;
  }
  elements.quitWarning.textContent = warnings.length ? `${warnings.join(", and ")}.` : "";
  elements.quitWarning.classList.toggle("hidden", warnings.length === 0);
  elements.quitDialog.showModal();
});

elements.quitForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  elements.quitDialog.close();
  quitStudio();
});

function showToast(message, type = "info") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  toast.textContent = message;
  elements.toastRegion.append(toast);
  setTimeout(() => toast.remove(), 5200);
}

function formatRelativeTime(value) {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) {
    return "";
  }
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(
    new Date(timestamp),
  );
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function activeProject() {
  return (
    state.bootstrap?.projects.find((project) => project.id === state.activeProjectId) ||
    state.bootstrap?.projects[0] ||
    null
  );
}

function sessionById(sessionId) {
  for (const project of state.bootstrap?.projects || []) {
    const session = project.sessions.find((candidate) => candidate.id === sessionId);
    if (session) return session;
  }
  return null;
}

function updateTopbar() {
  const project = activeProject();
  elements.activeProjectPill.textContent = project?.name || "General";
  elements.activeProjectPill.title = project?.path || "";
  elements.conversationTitle.textContent = state.activeSessionTitle || "New chat";
  elements.renameButton.classList.toggle("hidden", !state.activeSessionId);
  elements.deleteButton.classList.toggle("hidden", !state.activeSessionId);
  elements.projectSelect.value = state.activeProjectId;

  if (project?.repoUrl) {
    elements.activeRepoLink.href = project.repoUrl;
    elements.activeRepoLink.classList.remove("hidden");
  } else {
    elements.activeRepoLink.classList.add("hidden");
    elements.activeRepoLink.removeAttribute("href");
  }
}

function renderProjectOptions() {
  const previous = state.activeProjectId;
  elements.projectSelect.replaceChildren();
  for (const project of state.bootstrap?.projects || []) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = project.name;
    elements.projectSelect.append(option);
  }
  if ([...elements.projectSelect.options].some((option) => option.value === previous)) {
    elements.projectSelect.value = previous;
  }
}

function renderModels() {
  const previous = elements.modelSelect.value;
  elements.modelSelect.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "CLI default model";
  elements.modelSelect.append(defaultOption);

  for (const model of state.bootstrap?.models || []) {
    const option = document.createElement("option");
    option.value = model.id;
    option.textContent = model.name || model.id;
    option.title = model.description || "";
    elements.modelSelect.append(option);
  }

  if ([...elements.modelSelect.options].some((option) => option.value === previous)) {
    elements.modelSelect.value = previous;
  }
}

function renderEfforts() {
  const previous = elements.effortSelect.value;
  const labels = {
    low: "Low effort",
    medium: "Medium effort",
    high: "High effort",
    xhigh: "Extra-high effort",
    max: "Maximum effort",
  };

  elements.effortSelect.replaceChildren();
  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Default effort";
  elements.effortSelect.append(defaultOption);
  for (const effort of state.bootstrap?.efforts || []) {
    const option = document.createElement("option");
    option.value = effort;
    option.textContent = labels[effort] || effort;
    elements.effortSelect.append(option);
  }
  elements.effortSelect.value = (state.bootstrap?.efforts || []).includes(previous)
    ? previous
    : "";
}

const MODE_KEY = "claude-cli-studio-permission-mode";

/**
 * The mode is remembered across reloads on purpose.
 *
 * It used to reset to Ask every time the tab was reopened, silently — so
 * "I set it to Autopilot and left" became "it asked me anyway" the moment the
 * page was refreshed, with nothing on screen to say the choice had been thrown
 * away.
 */
function renderPermissionModes() {
  const previous = elements.modeSelect.value || localStorage.getItem(MODE_KEY) || "";
  elements.modeSelect.replaceChildren();
  for (const mode of state.bootstrap?.permissionModes || []) {
    const option = document.createElement("option");
    option.value = mode.id;
    option.textContent = mode.name;
    option.title = mode.description || "";
    elements.modeSelect.append(option);
  }
  const modes = (state.bootstrap?.permissionModes || []).map((mode) => mode.id);
  elements.modeSelect.value = modes.includes(previous) ? previous : modes[0] || "default";
  updateComposerNote();
}

/**
 * Pushes the chosen mode at the session that is running right now.
 *
 * The mode also rides along with every message, which covers the idle case; the
 * call below is what makes the choice mean anything *during* a turn — including
 * answering the prompt already on screen, which is exactly when someone reaches
 * for this dropdown.
 */
async function applyPermissionMode() {
  const permissionMode = elements.modeSelect.value;
  localStorage.setItem(MODE_KEY, permissionMode);
  updateComposerNote();

  const sessionId = state.activeSessionId;
  if (!sessionId || !state.runningSessions.has(sessionId)) {
    return;
  }
  try {
    const result = await api(`/api/sessions/${sessionId}/permission-mode`, {
      method: "POST",
      body: JSON.stringify({ permissionMode }),
    });
    if (result.approved > 0) {
      showToast(
        result.approved === 1
          ? `${modeName(permissionMode)} — approved the request that was waiting.`
          : `${modeName(permissionMode)} — approved ${result.approved} requests that were waiting.`,
      );
    } else if (result.applied) {
      showToast(`${modeName(permissionMode)} applies to this turn now.`);
    }
  } catch (error) {
    showToast(error.message, "error");
  }
}

function modeName(modeId) {
  return (
    (state.bootstrap?.permissionModes || []).find((item) => item.id === modeId)?.name ||
    modeId
  );
}

function queuedTurnFor(sessionId) {
  return state.queue.find((entry) => entry.sessionId === sessionId) || null;
}

function formatClockTime(epochMs) {
  return new Date(epochMs).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatCountdown(epochMs) {
  const remaining = Math.max(0, epochMs - Date.now());
  const minutes = Math.round(remaining / 60000);
  if (minutes < 1) {
    return "any moment";
  }
  if (minutes < 60) {
    return `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * The note under the composer carries three things, most urgent first: a turn
 * parked for this conversation, the Autopilot warning, then the plain
 * description of the selected mode.
 *
 * A queued turn always states the permission mode it will run under. It fires
 * unattended, possibly hours later, so "what is it allowed to do when it wakes
 * up" must never be something you have to remember.
 */
function updateComposerNote() {
  const queued = state.activeSessionId ? queuedTurnFor(state.activeSessionId) : null;
  elements.composerNote.classList.remove("warning", "queued");

  if (queued) {
    const reset = state.limit?.resetAt;
    const when =
      state.limit?.status === "capped" && reset
        ? `runs at ${formatClockTime(reset)} (in ${formatCountdown(reset)})`
        : "runs as soon as a usage window resets";
    elements.composerNote.replaceChildren(
      document.createTextNode(
        `Queued — ${when}, using ${modeName(queued.permissionMode)}. `,
      ),
    );
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "link-button";
    cancel.dataset.cancelQueued = queued.sessionId;
    cancel.textContent = "Cancel";
    elements.composerNote.append(cancel);
    elements.composerNote.classList.add("queued");
    return;
  }

  const mode = (state.bootstrap?.permissionModes || []).find(
    (item) => item.id === elements.modeSelect.value,
  );
  elements.composerNote.textContent =
    elements.modeSelect.value === "bypassPermissions"
      ? "Autopilot is on — Claude will not ask before editing files or running commands."
      : mode?.description || "File edits, commands, and network access still ask for your approval.";
  elements.composerNote.classList.toggle(
    "warning",
    elements.modeSelect.value === "bypassPermissions",
  );
}

function updateWatchButton() {
  elements.watchButton.classList.toggle("active", state.queueForReset);
  elements.watchButton.setAttribute("aria-pressed", String(state.queueForReset));
}

/**
 * The 5-hour window is what actually gates work, so it drives the bar; the
 * weekly number rides along as detail text when the CLI reports it.
 */
function renderLimitMeter() {
  const limit = state.limit;
  const utilization = typeof limit?.utilization === "number" ? limit.utilization : null;
  const capped = limit?.status === "capped";

  // The meter stays up even with nothing to draw yet. It used to hide itself
  // whenever utilization was unknown, which was almost always — the numbers
  // only arrive from a live turn or a probe — so the one thing people wanted to
  // glance at was missing precisely when nothing was running.
  elements.limitMeter.classList.remove("hidden");
  elements.limitMeter.classList.toggle("capped", capped);

  if (!limit || (utilization === null && !capped)) {
    elements.limitLabel.textContent = "Usage";
    elements.limitValue.textContent = "—";
    elements.limitBar.style.width = "0%";
    elements.limitDetail.textContent = "Click to check";
    return;
  }

  const percent = capped ? 100 : Math.max(0, Math.min(100, Math.round(utilization)));
  elements.limitLabel.textContent = capped ? "Usage limit reached" : "5-hour usage";
  elements.limitValue.textContent = capped
    ? limit.resetAt
      ? `resets ${formatClockTime(limit.resetAt)}`
      : "waiting for reset"
    : `${percent}%`;
  elements.limitBar.style.width = `${percent}%`;

  const details = [];
  if (typeof limit.weeklyUtilization === "number") {
    details.push(`Weekly ${Math.round(limit.weeklyUtilization)}%`);
  }
  if (limit.usingOverage) {
    details.push("on overage");
  }
  if (state.queue.length) {
    details.push(
      `${state.queue.length} turn${state.queue.length === 1 ? "" : "s"} queued`,
    );
  }
  if (limit.polling) {
    details.push("watching");
  }
  elements.limitDetail.textContent = details.join(" · ");
  if (elements.usageDialog?.open) {
    renderUsageDialog();
  }
}

function formatAgo(epochMs) {
  if (!epochMs) {
    return "not checked yet";
  }
  const minutes = Math.round((Date.now() - epochMs) / 60000);
  if (minutes < 1) {
    return "updated just now";
  }
  if (minutes < 60) {
    return `updated ${minutes} min ago`;
  }
  return `updated ${Math.floor(minutes / 60)}h ago`;
}

/**
 * Both usage windows, side by side.
 *
 * The sidebar meter can only show one number; this is where "which window is
 * actually about to stop me, and when does it come back" gets answered. Each
 * window states its own reset clock time *and* a countdown, because "resets
 * 12:40pm" and "in 3h 20m" answer different questions.
 */
function renderUsageDialog() {
  const limit = state.limit || {};
  const windows = limit.windows || {};
  const rows = [
    { key: "fiveHour", name: "5-hour window", data: windows.fiveHour },
    { key: "weekly", name: "Weekly window", data: windows.weekly },
  ];

  elements.usageWindows.replaceChildren();
  for (const row of rows) {
    const percent =
      typeof row.data?.utilization === "number"
        ? Math.max(0, Math.min(100, Math.round(row.data.utilization)))
        : null;
    const rejected = String(row.data?.status || "").toLowerCase() === "rejected";

    const block = document.createElement("div");
    block.className = `usage-window${rejected ? " capped" : ""}`;

    const head = document.createElement("div");
    head.className = "usage-window-head";
    const name = document.createElement("span");
    name.textContent = row.name;
    const value = document.createElement("strong");
    value.textContent = percent === null ? "—" : `${percent}%`;
    head.append(name, value);

    const bar = document.createElement("div");
    bar.className = "limit-bar";
    const fill = document.createElement("span");
    fill.style.width = `${percent ?? 0}%`;
    bar.append(fill);

    const note = document.createElement("small");
    if (row.data?.resetAt) {
      note.textContent = `Resets ${formatClockTime(row.data.resetAt)} · in ${formatCountdown(row.data.resetAt)}`;
    } else if (percent === null) {
      note.textContent = "No reading yet.";
    } else {
      note.textContent = rejected ? "Spent — waiting for a reset time." : "Not constrained.";
    }

    block.append(head, bar, note);
    elements.usageWindows.append(block);
  }

  const notes = [formatAgo(limit.lastCheckedAt)];
  if (limit.usingOverage) {
    notes.push("Overage credits are covering requests right now.");
  }
  if (limit.status === "capped") {
    notes.push("Work is being refused.");
  }
  elements.usageNote.textContent = notes.join(" · ");
}

elements.limitMeter?.addEventListener("click", () => {
  renderUsageDialog();
  elements.usageDialog.showModal();
  // A meter with no reading is the reason most people click it, so make the
  // click do the obvious thing rather than showing two empty bars.
  if (!state.limit || state.limit.lastCheckedAt === null) {
    refreshUsage();
  }
});

async function refreshUsage() {
  elements.usageRefresh.disabled = true;
  elements.usageRefresh.textContent = "Checking…";
  try {
    const result = await api("/api/limit/refresh", { method: "POST" });
    state.limit = result.limit;
    renderLimitMeter();
    renderUsageDialog();
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.usageRefresh.disabled = false;
    elements.usageRefresh.textContent = "Refresh";
  }
}

elements.usageRefresh?.addEventListener("click", refreshUsage);

function applyWatchState({ limit, queue }) {
  if (limit) {
    state.limit = limit;
  }
  if (Array.isArray(queue)) {
    state.queue = queue;
  }
  renderLimitMeter();
  updateComposerNote();
  renderSidebar();
}

async function cancelQueuedTurn(sessionId) {
  try {
    await api(`/api/watch/queue/${sessionId}`, { method: "DELETE" });
    state.queue = state.queue.filter((entry) => entry.sessionId !== sessionId);
    applyWatchState({});
    showToast("Queued message cancelled.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

/**
 * Best-effort desktop notification when parked work wakes up. The tab is often
 * in the background for hours by then, which is the whole point.
 */
/**
 * Getting the user's attention when they are not looking at Studio.
 *
 * Everything below only fires while the page is hidden or unfocused. A
 * notification for something you are already watching happen is noise, and
 * noise is how people turn notifications off — after which the one that
 * mattered never arrives either.
 *
 * Three channels, because any one of them can be off: a system notification, a
 * short tone, and the tab/window title. The title is the one that always works.
 */
const BASE_TITLE = "Claude CLI Studio";
let attentionCount = 0;

function isWatching() {
  return document.visibilityState === "visible" && document.hasFocus();
}

function updateTitleBadge() {
  document.title = attentionCount ? `(${attentionCount}) ${BASE_TITLE}` : BASE_TITLE;
}

function clearAttention() {
  if (attentionCount) {
    attentionCount = 0;
    updateTitleBadge();
  }
}

/** A short two-note chime, synthesized so there is no audio file to ship. */
function playChime() {
  if (localStorage.getItem("claude-cli-studio-sound") === "off") {
    return;
  }
  try {
    const context = new (window.AudioContext || window.webkitAudioContext)();
    const now = context.currentTime;
    for (const [index, frequency] of [880, 1174.7].entries()) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      const start = now + index * 0.13;
      // Ramp rather than switch, or the tone clicks at both ends.
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.13, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.12);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.14);
    }
    setTimeout(() => context.close().catch(() => {}), 800);
  } catch {
    /* no audio device, or autoplay is blocked until the user interacts */
  }
}

function alertAway(title, body, { attention = false, force = false } = {}) {
  if (isWatching() && !force) {
    return;
  }
  if (attention) {
    attentionCount += 1;
    updateTitleBadge();
  }
  playChime();
  if (window.Notification?.permission === "granted") {
    try {
      const notification = new Notification(title, { body: body || "", tag: title });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
    } catch {
      /* some platforms refuse constructed notifications */
    }
  }
}

function sessionTitleFor(sessionId) {
  for (const project of state.bootstrap?.projects || []) {
    const session = project.sessions.find((item) => item.id === sessionId);
    if (session) {
      return session.title || "Untitled conversation";
    }
  }
  return sessionId === state.activeSessionId
    ? state.activeSessionTitle || "Your conversation"
    : "A conversation";
}

document.addEventListener("visibilitychange", () => {
  if (isWatching()) clearAttention();
});
window.addEventListener("focus", clearAttention);

/**
 * Closing the window stops Studio, the way closing an application does.
 *
 * `pagehide` also fires on a reload and on following a link, so this never
 * decides anything on its own — it tells the server the window is going, and
 * the server waits a few seconds to see whether a tab comes back.
 *
 * `keepalive` is what makes the request survive the page it was sent from;
 * without it the browser cancels in-flight requests on unload and the message
 * never arrives. It also carries headers, which `sendBeacon` cannot, and this
 * route is authenticated.
 *
 * When work is in flight Studio deliberately stays up, so say so out loud —
 * otherwise it is a background process nobody knows is running.
 */
/**
 * Ask before closing while Claude is mid-turn.
 *
 * The browser owns the wording — Chrome and Edge show their own generic "Leave
 * site?" text and ignore anything we put in the message, because scam sites
 * abused custom copy. All we control is whether the question is asked at all.
 * Setting `returnValue` is what asks it.
 *
 * Only for a turn actually in flight. Prompting every time someone reloads with
 * something parked would train the reflex to dismiss it without reading, and
 * then the one that mattered gets dismissed too.
 */
window.addEventListener("beforeunload", (event) => {
  if (state.runningSessions.size === 0) {
    return;
  }
  event.preventDefault();
  event.returnValue = "";
});

window.addEventListener("pagehide", () => {
  // Parked turns are the exception, and the only one. The watch exists to fire
  // them hours later when the usage window resets, which cannot happen if
  // closing a window takes the server down — so Studio stays up and says so.
  // A turn in flight does NOT get this treatment: you were just asked.
  if (state.runningSessions.size === 0 && state.queue.length > 0) {
    if (window.Notification?.permission === "granted") {
      try {
        new Notification("Claude CLI Studio is still running", {
          body: "Messages are parked, waiting for your usage window to reset.",
          tag: "studio-still-running",
        });
      } catch {
        /* nothing more we can do from a page that is going away */
      }
    }
    return;
  }
  try {
    fetch("/api/window-closed", {
      method: "POST",
      keepalive: true,
      headers: { Authorization: `Bearer ${studioToken}`, "Content-Type": "application/json" },
      body: "{}",
    }).catch(() => {});
  } catch {
    /* the page is unloading; there is nothing to report to */
  }
});

const SOUND_KEY = "claude-cli-studio-sound";

function alertsEnabled() {
  return localStorage.getItem(SOUND_KEY) !== "off";
}

function renderAlertsButton() {
  const on = alertsEnabled();
  elements.alertsButton?.setAttribute("aria-pressed", String(on));
  elements.alertsButton?.setAttribute(
    "title",
    on ? "Alerts on — click to silence" : "Alerts silenced — click to turn on",
  );
}

/**
 * Asked for once, the first time the user does something whose ending they
 * would want to hear about — not on page load, where "Studio wants to send
 * notifications" arrives before Studio has done anything worth announcing and
 * gets denied out of reflex.
 */
function requestAlertPermission() {
  if (alertsEnabled() && window.Notification?.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

elements.alertsButton?.addEventListener("click", () => {
  const next = !alertsEnabled();
  localStorage.setItem(SOUND_KEY, next ? "on" : "off");
  renderAlertsButton();
  if (next) {
    requestAlertPermission();
    // Play it so "on" is something you hear, not just something you read.
    playChime();
    showToast("Alerts on — you'll be told when Claude finishes or needs you.");
  } else {
    showToast("Alerts silenced.");
  }
});

function notifyReleased(released) {
  const count = released.length;
  const body =
    count === 1
      ? released[0].prompt.slice(0, 120)
      : `${count} conversations picked up where they left off.`;
  showToast(
    count === 1 ? "Usage window reset — your queued message was sent." : `Usage window reset — ${count} queued messages sent.`,
  );
  alertAway("Claude picked up your queued work", body, { attention: true });
}

function renderSidebar() {
  const query = elements.sessionSearch.value.trim().toLowerCase();
  elements.sessionNav.replaceChildren();
  let visibleSessions = 0;

  for (const project of state.bootstrap?.projects || []) {
    const sessions = project.sessions.filter((session) => {
      if (!query) return true;
      return `${session.title} ${session.preview} ${project.name}`.toLowerCase().includes(query);
    });
    if (query && sessions.length === 0) {
      continue;
    }

    visibleSessions += sessions.length;
    const section = document.createElement("section");
    section.className = "project-group";
    section.dataset.projectId = project.id;
    if (state.collapsedProjects.has(project.id) && !query) {
      section.classList.add("collapsed");
    }

    const header = document.createElement("div");
    header.className = "project-header";

    const toggle = document.createElement("button");
    toggle.className = "project-toggle";
    toggle.type = "button";
    toggle.dataset.toggleProject = project.id;
    toggle.title = project.path;
    const projectIcon = document.createElement("span");
    projectIcon.className = "project-icon";
    projectIcon.append(iconNode("folder"));
    toggle.append(iconNode("chevron"), projectIcon);

    const name = document.createElement("span");
    name.className = "project-name";
    name.textContent = project.name;
    const count = document.createElement("span");
    count.className = "project-count";
    count.textContent = project.sessions.length;
    toggle.append(name, count);
    header.append(toggle);

    if (project.repoUrl) {
      const repo = document.createElement("a");
      repo.className = "project-action";
      repo.href = project.repoUrl;
      repo.target = "_blank";
      repo.rel = "noreferrer";
      repo.title = "Open repository";
      repo.append(iconNode("github"));
      header.append(repo);
    }

    const newChat = document.createElement("button");
    newChat.className = "project-action";
    newChat.type = "button";
    newChat.dataset.newProject = project.id;
    newChat.title = `New chat in ${project.name}`;
    newChat.append(iconNode("plus"));
    header.append(newChat);
    section.append(header);

    const list = document.createElement("div");
    list.className = "project-sessions";
    if (sessions.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty-project";
      empty.textContent = "No sessions yet";
      list.append(empty);
    } else {
      for (const session of sessions) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "session-item";
        button.dataset.sessionId = session.id;
        button.dataset.projectId = project.id;
        button.title = session.preview || session.title;
        if (session.id === state.activeSessionId) {
          button.classList.add("active");
        }

        const title = document.createElement("span");
        title.className = "session-item-title";
        title.textContent = session.title;
        const meta = document.createElement("span");
        meta.className = "session-item-meta";
        meta.textContent = formatRelativeTime(session.updatedAt);
        button.append(title, meta);
        if (queuedTurnFor(session.id)) {
          const badge = document.createElement("span");
          badge.className = "session-queued-badge";
          badge.textContent = "Queued";
          badge.title = "Waiting for the usage window to reset";
          button.append(badge);
          button.classList.add("has-queued");
        }
        list.append(button);
      }
    }
    section.append(list);
    elements.sessionNav.append(section);
  }

  if (!visibleSessions && query) {
    const empty = document.createElement("div");
    empty.className = "no-results";
    empty.textContent = `No sessions match “${elements.sessionSearch.value.trim()}”.`;
    elements.sessionNav.append(empty);
  }
}

function setConnectionState() {
  const cli = state.bootstrap?.cli;
  elements.statusDot.classList.remove("connected", "error");
  if (cli?.available) {
    elements.statusDot.classList.add("connected");
    elements.connectionLabel.textContent = "Claude Code connected";
    elements.connectionDetail.textContent = `CLI ${cli.version} · localhost only`;
    elements.messageInput.disabled = false;
  } else {
    elements.statusDot.classList.add("error");
    elements.connectionLabel.textContent = "Claude Code CLI not found";
    elements.connectionDetail.textContent =
      cli?.message || "Install Claude Code and run claude /login";
    elements.messageInput.disabled = true;
  }
}

async function refreshBootstrap({ quiet = false } = {}) {
  try {
    state.bootstrap = await api("/api/bootstrap");
    if (!state.bootstrap.projects.some((project) => project.id === state.activeProjectId)) {
      state.activeProjectId = state.bootstrap.projects[0]?.id || "general";
    }
    renderProjectOptions();
    renderModels();
    renderEfforts();
    renderPermissionModes();
    applyWatchState(state.bootstrap);
    updateTopbar();
    setConnectionState();
  } catch (error) {
    elements.statusDot.classList.add("error");
    elements.connectionLabel.textContent = "Studio connection failed";
    elements.connectionDetail.textContent = error.message;
    if (!quiet) showToast(error.message, "error");
  }
}

function startNewChat(projectId = state.activeProjectId) {
  if (state.uploading > 0) {
    showToast("Wait for the current upload to finish before switching chats.");
    return;
  }
  state.navigationEpoch += 1;
  state.sessionLoadToken += 1;
  clearAttachments();
  setSuggestion(null);
  state.activeSessionId = null;
  state.activeProjectId = projectId || "general";
  state.activeSessionTitle = "New chat";
  resetRenderedEvents();
  state.liveMessages.clear();
  state.activities.clear();
  elements.messages.replaceChildren();
  elements.messages.classList.add("hidden");
  elements.welcome.classList.remove("hidden");
  elements.messageInput.value = "";
  autoSizeTextarea();
  renderSidebar();
  updateTopbar();
  updateSendControls();
  closeSidebar();
  setTimeout(() => elements.messageInput.focus(), 50);
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

function findInlineToken(value, start) {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "[") {
      const labelEnd = value.indexOf("](", index + 1);
      const urlEnd = labelEnd >= 0 ? value.indexOf(")", labelEnd + 2) : -1;
      if (labelEnd > index + 1 && urlEnd > labelEnd + 2) {
        const href = safeHttpUrl(value.slice(labelEnd + 2, urlEnd));
        if (href) {
          return {
            type: "link",
            start: index,
            end: urlEnd + 1,
            content: value.slice(index + 1, labelEnd),
            href,
          };
        }
      }
    }

    if (value[index] === "`") {
      const end = value.indexOf("`", index + 1);
      const content = end > index + 1 ? value.slice(index + 1, end) : "";
      if (content && !content.includes("\n")) {
        return { type: "code", start: index, end: end + 1, content };
      }
    }

    if (value.startsWith("**", index)) {
      const end = value.indexOf("**", index + 2);
      const content = end > index + 2 ? value.slice(index + 2, end) : "";
      if (content && !content.includes("*") && !content.includes("\n")) {
        return { type: "strong", start: index, end: end + 2, content };
      }
    }
  }
  return null;
}

function appendInlineMarkdown(parent, value) {
  const text = String(value || "");
  let cursor = 0;
  while (cursor < text.length) {
    const token = findInlineToken(text, cursor);
    if (!token) {
      parent.append(document.createTextNode(text.slice(cursor)));
      break;
    }
    if (token.start > cursor) {
      parent.append(document.createTextNode(text.slice(cursor, token.start)));
    }

    if (token.type === "link") {
      const link = document.createElement("a");
      link.href = token.href;
      link.target = "_blank";
      link.rel = "noreferrer";
      appendInlineMarkdown(link, token.content);
      parent.append(link);
    } else {
      const node = document.createElement(token.type);
      if (token.type === "strong") {
        appendInlineMarkdown(node, token.content);
      } else {
        node.textContent = token.content;
      }
      parent.append(node);
    }
    cursor = token.end;
  }
}

function renderProse(value) {
  const fragment = document.createDocumentFragment();
  let list = null;
  let listType = null;

  for (const line of value.split("\n")) {
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? "ul" : "ol";
      if (listType !== nextType) {
        list = document.createElement(nextType);
        listType = nextType;
        fragment.append(list);
      }
      const item = document.createElement("li");
      appendInlineMarkdown(item, (unordered || ordered)[1]);
      list.append(item);
      continue;
    }

    list = null;
    listType = null;
    if (!line.trim()) {
      continue;
    }
    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    const node = document.createElement(headingMatch ? `h${headingMatch[1].length}` : "p");
    appendInlineMarkdown(node, headingMatch ? headingMatch[2] : line);
    fragment.append(node);
  }
  return fragment;
}

function renderMarkdown(value) {
  const fragment = document.createDocumentFragment();
  const segments = String(value || "").split("```");
  segments.forEach((segment, index) => {
    if (index % 2 === 0) {
      fragment.append(renderProse(segment));
      return;
    }
    const newline = segment.indexOf("\n");
    const code = newline >= 0 ? segment.slice(newline + 1) : segment;
    const pre = document.createElement("pre");
    const codeNode = document.createElement("code");
    codeNode.textContent = code.replace(/\n$/, "");
    pre.append(codeNode);
    fragment.append(pre);
  });
  return fragment;
}

function attachmentNode(attachment) {
  if (attachment.kind === "image" && attachment.dataUrl) {
    const image = document.createElement("img");
    image.className = "transcript-image";
    image.src = attachment.dataUrl;
    image.alt = attachment.name || "Attached image";
    image.loading = "lazy";
    return image;
  }

  const chip = document.createElement("span");
  chip.className = "transcript-attachment";
  chip.append(iconNode("file"));
  const name = document.createElement("span");
  name.textContent = attachment.oversized
    ? `${attachment.name} (too large to preview)`
    : attachment.name;
  chip.append(name);
  return chip;
}

function toolChipNode(tool) {
  const chip = document.createElement("div");
  chip.className = "activity-card complete";
  chip.dataset.toolCallId = tool.id || "";
  chip.append(iconNode("tool"));
  const label = document.createElement("span");
  label.textContent = tool.detail ? `${tool.name} · ${tool.detail}` : tool.name;
  chip.append(label);
  return chip;
}

function messageNode(message) {
  const article = document.createElement("article");
  article.className = `message ${message.role}`;
  article.dataset.messageId = message.id || "";

  if (message.role === "assistant") {
    const avatar = document.createElement("div");
    avatar.className = "message-avatar";
    avatar.append(iconNode("robot"));
    article.append(avatar);
  }

  const body = document.createElement("div");
  body.className = "message-body";
  if (message.attachments?.length) {
    const attachments = document.createElement("div");
    attachments.className = "message-attachments";
    for (const attachment of message.attachments) {
      attachments.append(attachmentNode(attachment));
    }
    body.append(attachments);
  }

  const content = document.createElement("div");
  content.className = "message-content";
  if (message.role === "assistant") {
    content.append(renderMarkdown(message.content));
  } else {
    content.textContent = message.content;
  }
  body.append(content);

  for (const tool of message.tools || []) {
    body.append(toolChipNode(tool));
  }

  if (message.timestamp) {
    const meta = document.createElement("div");
    meta.className = "message-meta";
    meta.textContent = new Intl.DateTimeFormat(undefined, {
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(message.timestamp));
    body.append(meta);
  }

  article.append(body);
  return article;
}

function showMessages() {
  elements.welcome.classList.add("hidden");
  elements.messages.classList.remove("hidden");
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    elements.conversationArea.scrollTop = elements.conversationArea.scrollHeight;
  });
}

function resetRenderedEvents(sessionId = null) {
  state.renderedSessionId = sessionId;
  state.renderedEventIds.clear();
}

function renderTranscript(messages, sessionId = null) {
  resetRenderedEvents(sessionId);
  elements.messages.replaceChildren();
  state.liveMessages.clear();
  state.activities.clear();
  for (const message of messages) {
    elements.messages.append(messageNode(message));
  }
  if (messages.length) {
    showMessages();
  } else {
    elements.messages.classList.add("hidden");
    elements.welcome.classList.remove("hidden");
  }
  scrollToBottom();
}

async function selectSession(sessionId, projectId) {
  if (state.uploading > 0) {
    showToast("Wait for the current upload to finish before switching chats.");
    return;
  }
  const epoch = ++state.navigationEpoch;
  const token = ++state.sessionLoadToken;
  state.activeSessionId = sessionId;
  state.activeProjectId = projectId;
  const sidebarSession = sessionById(sessionId);
  state.activeSessionTitle = sidebarSession?.title || "Loading…";
  resetRenderedEvents(sessionId);
  updateSendControls();
  renderSidebar();
  updateTopbar();
  closeSidebar();

  elements.welcome.classList.add("hidden");
  elements.messages.classList.remove("hidden");
  const loading = indicatorNode("sidebar-loading");
  loading.setAttribute("role", "status");
  loading.setAttribute("aria-label", "Loading conversation");
  elements.messages.replaceChildren(loading);

  try {
    const payload = await api(`/api/sessions/${sessionId}`);
    if (token !== state.sessionLoadToken || epoch !== state.navigationEpoch) return;
    state.activeProjectId = payload.session.projectId || projectId;
    state.activeSessionTitle = payload.session.title;
    const messages = [...payload.messages];
    if (
      payload.stream?.userMessage &&
      messages.filter((message) => message.role === "user").at(-1)?.content !==
        payload.stream.userMessage.content
    ) {
      messages.push(payload.stream.userMessage);
    }
    renderTranscript(messages, sessionId);
    if (payload.stream) {
      state.streamSnapshots.set(sessionId, payload.stream);
      if (payload.stream.running) {
        state.runningSessions.add(sessionId);
      } else {
        state.runningSessions.delete(sessionId);
      }
      replayStream({ ...payload.stream, sessionId }, messages);
    } else {
      state.runningSessions.delete(sessionId);
      state.streamSnapshots.delete(sessionId);
    }
    updateSendControls();
    updateTopbar();
    renderSidebar();
  } catch (error) {
    if (token !== state.sessionLoadToken) return;
    showToast(error.message, "error");
    startNewChat(projectId);
  }
}

function appendOptimisticUserMessage(prompt, attachments, { pending = false, label = "Queued" } = {}) {
  showMessages();
  const node = messageNode({
    role: "user",
    content: prompt,
    attachments,
    timestamp: new Date().toISOString(),
  });
  if (pending) {
    node.classList.add("pending");
    const tag = document.createElement("span");
    tag.className = "pending-tag";
    tag.textContent = label;
    node.append(tag);
  }
  elements.messages.append(node);
  scrollToBottom();
  return node;
}

function ensureLiveMessage(messageId) {
  if (state.liveMessages.has(messageId)) {
    return state.liveMessages.get(messageId);
  }

  showMessages();
  const node = messageNode({ id: messageId, role: "assistant", content: "" });
  const content = node.querySelector(".message-content");
  content.replaceChildren(indicatorNode("typing-indicator"));
  elements.messages.append(node);
  const live = { node, content, text: "" };
  state.liveMessages.set(messageId, live);
  scrollToBottom();
  return live;
}

function completeLiveMessage(messageId, content) {
  const live = ensureLiveMessage(messageId);
  live.text = content || live.text;
  live.content.replaceChildren(renderMarkdown(live.text));
  scrollToBottom();
}

function renderToolStart(event) {
  const { toolCallId, name, detail } = event.data || {};
  const activityId = toolCallId || event.id;
  let activity = state.activities.get(activityId);

  if (!activity) {
    activity = document.createElement("div");
    activity.className = "activity-card";
    activity.append(iconNode("tool"));
    activity.append(document.createElement("span"));
    state.activities.set(activityId, activity);

    const lastAssistant = [...elements.messages.querySelectorAll(".message.assistant")].at(-1);
    const body = lastAssistant?.querySelector(".message-body");
    (body || elements.messages).append(activity);
  }

  activity.querySelector("span").textContent = detail ? `${name} · ${detail}` : name;
  scrollToBottom();
}

function renderToolEnd(event) {
  const { toolCallId, ok, denied } = event.data || {};
  const activity = state.activities.get(toolCallId);
  if (!activity) {
    return;
  }
  activity.classList.toggle("complete", ok !== false);
  activity.classList.toggle("failed", ok === false);
  if (denied) {
    activity.querySelector("span").textContent += " · denied";
  }
}

function updateSendControls() {
  const activeRunning = Boolean(
    state.activeSessionId &&
      (state.runningSessions.has(state.activeSessionId) ||
        state.pendingSessionSends.has(state.activeSessionId)),
  );
  // A running turn no longer blocks the composer — typing ahead is queued the
  // way the terminal queues it. Only a brand-new chat that has not come back
  // with a session id yet has nowhere to put the message.
  state.sending = state.pendingNavigationSends.has(state.navigationEpoch);
  elements.sendButton.classList.toggle("hidden", state.sending);
  elements.stopButton.classList.toggle("hidden", !activeRunning);
  elements.sendButton.disabled = state.uploading > 0;
  elements.messageInput.placeholder = activeRunning
    ? "Send another message — it runs when this turn finishes (/btw to interject)"
    : "Ask anything, use /commands, or drop several files here…";
}

/**
 * The CLI's suggested next prompt, shown the way the terminal shows it: ghost
 * text you take with Tab. It only appears while the composer is empty, so it
 * can never get in the way of something you are actually writing.
 */
function setSuggestion(suggestion) {
  state.suggestion = suggestion || null;
  renderSuggestion();
}

function renderSuggestion() {
  const visible = Boolean(state.suggestion) && elements.messageInput.value === "";
  elements.ghostSuggestion.classList.toggle("hidden", !visible);
  if (visible) {
    elements.ghostText.textContent = state.suggestion;
  }
}

function acceptSuggestion() {
  if (!state.suggestion || elements.messageInput.value !== "") {
    return false;
  }
  elements.messageInput.value = state.suggestion;
  setSuggestion(null);
  autoSizeTextarea();
  elements.messageInput.focus();
  return true;
}

/**
 * `/btw <question>` mirrors the terminal: the note folds into the turn already
 * running rather than waiting for it, so the answer accounts for what you said.
 */
function parseBtw(prompt) {
  const match = prompt.match(/^\/btw\b\s*([\s\S]*)$/i);
  if (!match) {
    return null;
  }
  return match[1].trim();
}

/**
 * Renders a Studio-side card into the transcript — used for the commands the
 * CLI answers for the terminal rather than for us.
 */
function systemCardNode(title) {
  const article = document.createElement("article");
  article.className = "message assistant";
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.append(iconNode("robot"));
  const body = document.createElement("div");
  body.className = "message-body";
  const card = document.createElement("div");
  card.className = "system-card";
  const heading = document.createElement("strong");
  heading.textContent = title;
  card.append(heading);
  body.append(card);
  article.append(avatar, body);
  showMessages();
  elements.messages.append(article);
  scrollToBottom();
  return card;
}

function describeAccount(account) {
  if (!account?.email) {
    return "Signed in.";
  }
  const plan = account.subscriptionType ? ` · ${account.subscriptionType}` : "";
  const org = account.organization ? ` · ${account.organization}` : "";
  return `Signed in as ${account.email}${plan}${org}`;
}

/**
 * `/login` cannot be forwarded to the CLI: it is not in the SDK's command list,
 * and sending it verbatim just gets "/login isn't available in this
 * environment" because the flow belongs to the interactive terminal. Studio
 * drives the same OAuth exchange itself over the control channel instead.
 */
async function runLoginCommand() {
  const card = systemCardNode("Sign in to Claude");
  const status = document.createElement("p");
  status.textContent = "Starting the sign-in flow…";
  card.append(status);

  let urls;
  try {
    urls = await api("/api/auth/login", { method: "POST" });
  } catch (error) {
    status.textContent = error.message;
    return;
  }

  const target = urls.automaticUrl || urls.manualUrl;
  if (!target) {
    status.textContent = "Claude Code did not return an authorization URL.";
    return;
  }

  status.textContent =
    "Approve the sign-in in the tab that just opened. This card updates by itself when you are done.";

  const openLink = document.createElement("a");
  openLink.className = "primary button-link";
  openLink.href = target;
  openLink.target = "_blank";
  openLink.rel = "noopener noreferrer";
  openLink.textContent = "Open the authorization page";
  card.append(openLink);
  window.open(target, "_blank", "noopener");

  // Manual fallback, for when the CLI's loopback listener cannot be reached
  // (a different browser profile, a redirect that never lands).
  const manual = document.createElement("details");
  manual.className = "system-card-manual";
  const summary = document.createElement("summary");
  summary.textContent = "Paste the code instead";
  const manualRow = document.createElement("div");
  manualRow.className = "system-card-row";
  const codeInput = document.createElement("input");
  codeInput.type = "text";
  codeInput.placeholder = "code#state";
  codeInput.autocomplete = "off";
  codeInput.spellcheck = false;
  const submit = document.createElement("button");
  submit.type = "button";
  submit.className = "primary";
  submit.textContent = "Submit";
  manualRow.append(codeInput, submit);
  if (urls.manualUrl) {
    const manualLink = document.createElement("a");
    manualLink.href = urls.manualUrl;
    manualLink.target = "_blank";
    manualLink.rel = "noopener noreferrer";
    manualLink.textContent = "Open the manual authorization page";
    manual.append(summary, manualLink, manualRow);
  } else {
    manual.append(summary, manualRow);
  }
  card.append(manual);

  const fallbackState = (() => {
    try {
      return new URL(urls.manualUrl || target).searchParams.get("state");
    } catch {
      return null;
    }
  })();

  let settled = false;
  const finish = (account) => {
    settled = true;
    card.replaceChildren();
    const heading = document.createElement("strong");
    heading.textContent = "Signed in";
    const detail = document.createElement("p");
    detail.textContent = describeAccount(account);
    card.append(heading, detail);
    scrollToBottom();
    showToast("Signed in to Claude.");
  };

  const complete = async (body) => {
    const result = await api("/api/auth/complete", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (!settled) {
      finish(result.account);
    }
  };

  submit.addEventListener("click", async () => {
    const pasted = codeInput.value.trim();
    if (!pasted) {
      return;
    }
    // The manual page hands back `code#state`; accept a bare code too.
    const [code, pastedState] = pasted.split("#");
    submit.disabled = true;
    try {
      await complete({ code: code.trim(), state: (pastedState || fallbackState || "").trim() });
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  });

  // Meanwhile, wait on the CLI's own loopback listener. Whichever path lands
  // first wins; `settled` keeps the other from redrawing the card.
  complete({}).catch((error) => {
    if (!settled) {
      status.textContent = `${error.message} You can still paste the code below.`;
      manual.open = true;
    }
  });
}

/**
 * There is no logout control request in the SDK, and Studio will not delete
 * `~/.claude/.credentials.json` itself — the CLI rotates refresh tokens and
 * owns that file. So say where to do it rather than half-doing it here.
 */
function runLogoutCommand() {
  const card = systemCardNode("Signing out happens in the terminal");
  const detail = document.createElement("p");
  detail.textContent =
    "Claude Code does not expose logout to Studio, and Studio will not edit your credentials file itself. Run `claude /logout` in a terminal, then use /login here to sign back in.";
  card.append(detail);
}

async function runWhoamiCommand() {
  const card = systemCardNode("Claude account");
  const detail = document.createElement("p");
  detail.textContent = "Checking…";
  card.append(detail);
  try {
    const { account } = await api("/api/auth");
    detail.textContent = account
      ? describeAccount(account)
      : "Claude Code could not report an account. Use /login to sign in.";
  } catch (error) {
    detail.textContent = error.message;
  }
}

/**
 * Account commands Studio answers itself. Everything else — /context, /model,
 * /usage, /compact and the rest — already reaches the CLI as ordinary prompt
 * text and comes back as an assistant message, so it is deliberately not
 * intercepted here.
 */
const studioCommands = new Map([
  ["/login", runLoginCommand],
  ["/logout", runLogoutCommand],
  ["/whoami", runWhoamiCommand],
]);

async function sendMessage() {
  const prompt = elements.messageInput.value.trim();
  const readyAttachments = state.attachments.filter((attachment) => attachment.id);
  if ((!prompt && readyAttachments.length === 0) || state.sending || state.uploading > 0) {
    return;
  }

  // Account commands are Studio's to run, not the CLI's — take them before any
  // of the send bookkeeping so they cost no turn and no session.
  const studioCommand = studioCommands.get(prompt.toLowerCase());
  if (studioCommand) {
    elements.messageInput.value = "";
    autoSizeTextarea();
    await studioCommand();
    return;
  }

  const displayPrompt = prompt || "Please review the attached files.";
  const originEpoch = state.navigationEpoch;
  const originalSessionId = state.activeSessionId;
  const originalProjectId = state.activeProjectId;
  const uploadIds = readyAttachments.map((attachment) => attachment.id);
  const attachmentMetadata = readyAttachments.map(({ id, name, type, size, kind }) => ({
    id,
    name,
    type,
    size,
    kind,
  }));

  // A queued turn is not in flight, so it gets none of the optimistic "running"
  // bookkeeping — the composer just empties and the note explains the wait.
  if (state.queueForReset) {
    try {
      const result = await api("/api/messages", {
        method: "POST",
        body: JSON.stringify({
          sessionId: originalSessionId,
          projectId: originalProjectId,
          prompt,
          uploadIds,
          model: elements.modelSelect.value || null,
          effort: elements.effortSelect.value || null,
          permissionMode: elements.modeSelect.value,
          queueForReset: true,
        }),
      });
      elements.messageInput.value = "";
      autoSizeTextarea();
      clearAttachments({ deleteRemote: false });
      state.queueForReset = false;
      updateWatchButton();
      if (originalSessionId === null && state.navigationEpoch === originEpoch) {
        state.activeSessionId = result.sessionId;
        state.activeSessionTitle = displayPrompt.slice(0, 72);
        updateTopbar();
      }
      applyWatchState({ limit: result.limit, queue: [...state.queue, result.queued] });
      showToast(
        result.limit?.status === "capped" && result.limit?.resetAt
          ? `Queued — sends at ${formatClockTime(result.limit.resetAt)}.`
          : "Queued — sends when the usage window resets.",
      );
    } catch (error) {
      showToast(error.message, "error");
    }
    return;
  }

  const btwNote = parseBtw(prompt);
  const turnInFlight = Boolean(
    originalSessionId && state.runningSessions.has(originalSessionId),
  );
  if (btwNote !== null && !turnInFlight) {
    showToast("/btw interjects while Claude is working — nothing is running.");
    return;
  }
  const outgoingPrompt = btwNote !== null ? btwNote : prompt;
  // Sending is the moment "tell me when this is done" starts to mean something.
  requestAlertPermission();
  // A suggestion belongs to the turn that produced it; once you send, it is stale.
  setSuggestion(null);

  const bubble = appendOptimisticUserMessage(displayPrompt, attachmentMetadata, {
    pending: turnInFlight,
    label: btwNote !== null ? "Interjecting" : "Queued",
  });
  elements.messageInput.value = "";
  autoSizeTextarea();
  clearAttachments({ deleteRemote: false });
  if (originalSessionId) {
    state.terminalSessions.delete(originalSessionId);
    state.pendingSessionSends.add(originalSessionId);
    state.runningSessions.add(originalSessionId);
  } else {
    state.pendingNavigationSends.add(originEpoch);
  }
  updateSendControls();

  try {
    const result = await api("/api/messages", {
      method: "POST",
      body: JSON.stringify({
        sessionId: originalSessionId,
        projectId: originalProjectId,
        prompt: outgoingPrompt,
        uploadIds,
        model: elements.modelSelect.value || null,
        effort: elements.effortSelect.value || null,
        permissionMode: elements.modeSelect.value,
        priority: btwNote !== null ? "now" : null,
      }),
    });

    // Tag the bubble so session.pending_cleared can promote it when the CLI
    // takes the message off its queue.
    if (result.queued && result.messageUuid && bubble) {
      bubble.dataset.pendingUuid = result.messageUuid;
      state.pendingMessages.set(result.sessionId, result.messageUuid);
    } else if (bubble) {
      bubble.classList.remove("pending");
    }

    state.pendingNavigationSends.delete(originEpoch);
    if (originalSessionId) {
      state.pendingSessionSends.delete(originalSessionId);
    }
    if (
      originalSessionId === null &&
      state.navigationEpoch === originEpoch &&
      state.activeSessionId === null
    ) {
      state.activeSessionId = result.sessionId;
      state.activeSessionTitle = displayPrompt.slice(0, 72);
      state.renderedSessionId = result.sessionId;
      updateTopbar();
    }
    if (state.terminalSessions.has(result.sessionId)) {
      state.runningSessions.delete(result.sessionId);
    } else {
      state.runningSessions.add(result.sessionId);
    }
    updateSendControls();
    renderSidebar();
  } catch (error) {
    state.pendingNavigationSends.delete(originEpoch);
    if (originalSessionId) {
      state.pendingSessionSends.delete(originalSessionId);
      state.runningSessions.delete(originalSessionId);
    }
    updateSendControls();
    deleteUploads(uploadIds);
    showToast(error.message, "error");
    showMessages();
    elements.messages.append(
      messageNode({ role: "assistant", content: `**Studio error:** ${error.message}` }),
    );
    scrollToBottom();
  }
}

function autoSizeTextarea() {
  elements.messageInput.style.height = "auto";
  elements.messageInput.style.height = `${Math.min(elements.messageInput.scrollHeight, 220)}px`;
}

function renderAttachments() {
  elements.attachmentStrip.replaceChildren();
  elements.attachmentStrip.classList.toggle("hidden", state.attachments.length === 0);

  for (const attachment of state.attachments) {
    const pill = document.createElement("div");
    pill.className = `attachment-pill ${attachment.uploading ? "uploading" : ""}`;
    const fileIcon = document.createElement("span");
    fileIcon.className = "file-icon";
    fileIcon.append(iconNode("file"));
    pill.append(fileIcon);
    const copy = document.createElement("span");
    copy.className = "file-copy";
    const name = document.createElement("strong");
    name.textContent = attachment.name;
    const size = document.createElement("small");
    size.textContent = attachment.uploading ? "Uploading…" : formatBytes(attachment.size);
    copy.append(name, size);
    pill.append(copy);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.ariaLabel = `Remove ${attachment.name}`;
    remove.dataset.removeAttachment = attachment.localId;
    remove.append(iconNode("remove"));
    pill.append(remove);
    elements.attachmentStrip.append(pill);
  }

  elements.uploadStatus.textContent = state.uploading > 0 ? `Uploading ${state.uploading}…` : "";
  elements.sendButton.disabled = state.uploading > 0;
}

async function deleteUploads(uploadIds) {
  await Promise.all(
    uploadIds.map((uploadId) =>
      api(`/api/uploads/${uploadId}`, { method: "DELETE" }).catch(() => null),
    ),
  );
}

function clearAttachments({ deleteRemote = true } = {}) {
  const uploadIds = state.attachments.map((attachment) => attachment.id).filter(Boolean);
  for (const attachment of state.attachments) {
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
  }
  state.attachments = [];
  renderAttachments();
  if (deleteRemote && uploadIds.length) {
    deleteUploads(uploadIds);
  }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

async function uploadFiles(fileList) {
  const files = [...fileList];
  if (!files.length) return;
  if (state.attachments.length + files.length > 12) {
    showToast("A conversation can have up to 12 pending files.", "error");
    return;
  }
  const existingBytes = state.attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  const total = existingBytes + files.reduce((sum, file) => sum + file.size, 0);
  if (total > 30 * 1024 * 1024) {
    showToast("The selected files exceed the 30 MB combined limit.", "error");
    return;
  }
  const tooLarge = files.find((file) => file.size > 12 * 1024 * 1024);
  if (tooLarge) {
    showToast(`${tooLarge.name} is larger than 12 MB.`, "error");
    return;
  }

  const pending = files.map((file) => ({
    localId: crypto.randomUUID(),
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    uploading: true,
    file,
    previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
  }));
  state.attachments.push(...pending);
  state.uploading += pending.length;
  renderAttachments();

  try {
    const encodedFiles = await Promise.all(
      pending.map(async (attachment) => ({
        name: attachment.name,
        type: attachment.type,
        size: attachment.size,
        data: await fileToBase64(attachment.file),
      })),
    );
    const payload = await api("/api/uploads", {
      method: "POST",
      body: JSON.stringify({ files: encodedFiles }),
    });

    const orphanUploadIds = [];
    payload.uploads.forEach((upload, index) => {
      const target = state.attachments.find(
        (attachment) => attachment.localId === pending[index].localId,
      );
      if (target) {
        Object.assign(target, upload, { uploading: false, file: undefined });
      } else {
        orphanUploadIds.push(upload.id);
      }
    });
    if (orphanUploadIds.length) {
      deleteUploads(orphanUploadIds);
    }
  } catch (error) {
    const pendingIds = new Set(pending.map((attachment) => attachment.localId));
    state.attachments = state.attachments.filter(
      (attachment) => !pendingIds.has(attachment.localId),
    );
    showToast(error.message, "error");
  } finally {
    state.uploading -= pending.length;
    renderAttachments();
  }
}

function formatPermission(request) {
  const lines = [];
  if (request.description) {
    lines.push(request.description, "");
  }
  lines.push(`Tool: ${request.toolName}`);
  if (request.blockedPath) {
    lines.push(`Blocked path: ${request.blockedPath}`);
  }
  if (request.decisionReason) {
    lines.push(`Reason: ${request.decisionReason}`);
  }
  if (request.input && Object.keys(request.input).length) {
    lines.push("", JSON.stringify(request.input, null, 2));
  }
  return lines.join("\n");
}

function showPermissionDialog(payload) {
  state.currentPermission = payload;
  const request = payload.request;
  elements.permissionIntention.textContent =
    request.title || `Claude wants to use ${request.displayName || request.toolName}.`;
  elements.permissionDetails.textContent = formatPermission(request);
  elements.permissionFeedback.value = "";
  elements.approveSessionButton.classList.toggle(
    "hidden",
    payload.canApproveForSession !== true,
  );
  elements.permissionDialog.showModal();
}

function enqueuePermission(payload) {
  if (
    state.currentPermission?.requestId === payload.requestId ||
    state.permissionQueue.some((item) => item.requestId === payload.requestId)
  ) {
    return;
  }
  state.permissionQueue.push(payload);
  // A prompt nobody sees is the failure this app keeps rediscovering: the turn
  // sits there waiting on a click that is not coming.
  alertAway(
    "Claude needs your permission",
    payload.request.title || `It wants to use ${payload.request.displayName || payload.request.toolName}.`,
    { attention: true },
  );
  showNextPermission();
}

function showNextPermission() {
  if (state.currentPermission || state.permissionQueue.length === 0) {
    return;
  }
  showPermissionDialog(state.permissionQueue.shift());
}

/**
 * Takes down a prompt somebody else answered — another tab, or a switch to a
 * mode that auto-approves it. Leaving the modal up would strand the user on a
 * dialog whose buttons can only 404.
 */
function dismissPermission(requestId) {
  state.permissionQueue = state.permissionQueue.filter(
    (item) => item.requestId !== requestId,
  );
  if (state.currentPermission?.requestId === requestId) {
    elements.permissionDialog.close();
    state.currentPermission = null;
  }
  showNextPermission();
}

async function resolvePermission(decision) {
  if (!state.currentPermission) return;
  try {
    await api(`/api/permissions/${state.currentPermission.requestId}`, {
      method: "POST",
      body: JSON.stringify({ decision, feedback: elements.permissionFeedback.value }),
    });
    elements.permissionDialog.close();
    state.currentPermission = null;
    showNextPermission();
  } catch (error) {
    if (error.status === 404) {
      elements.permissionDialog.close();
      state.currentPermission = null;
      showNextPermission();
      return;
    }
    showToast(error.message, "error");
  }
}

function handleClaudeEvent(payload) {
  const { sessionId, event } = payload;
  if (event.type === "session.running") {
    state.terminalSessions.delete(sessionId);
    state.runningSessions.add(sessionId);
    if (sessionId === state.activeSessionId) {
      updateSendControls();
    }
  }
  if (event.type === "session.suggestion" && sessionId === state.activeSessionId) {
    setSuggestion(event.data?.suggestion);
    return;
  }

  // The parked message has been taken off the CLI's queue and is running now,
  // so its pending bubble becomes an ordinary one.
  if (event.type === "session.pending_cleared") {
    for (const messageUuid of event.data?.messageUuids || []) {
      document
        .querySelector(`[data-pending-uuid="${messageUuid}"]`)
        ?.classList.remove("pending");
    }
    state.pendingMessages.delete(sessionId);
  }

  const terminalEvent = event.type === "session.idle" || event.type === "session.error";
  if (terminalEvent) {
    state.terminalSessions.add(sessionId);
    state.pendingSessionSends.delete(sessionId);
    state.runningSessions.delete(sessionId);
    if (sessionId === state.activeSessionId) {
      updateSendControls();
    }
    // The point of this app is that you can start something and go do
    // something else, so finishing has to be able to reach you.
    alertAway(
      event.type === "session.error" ? "A Claude session failed" : "Claude is done",
      event.type === "session.error"
        ? event.data.message || "The session stopped with an error."
        : sessionTitleFor(sessionId),
      { attention: true },
    );
    setTimeout(() => refreshBootstrap({ quiet: true }), 250);
  }

  if (sessionId !== state.activeSessionId) {
    if (event.type === "session.error") {
      showToast(event.data.message || "A background Claude session failed.", "error");
    }
    return;
  }

  if (state.renderedSessionId !== sessionId) {
    resetRenderedEvents(sessionId);
  }
  if (event.id && state.renderedEventIds.has(event.id)) {
    return;
  }
  if (event.id) {
    state.renderedEventIds.add(event.id);
    if (state.renderedEventIds.size > 3000) {
      state.renderedEventIds.delete(state.renderedEventIds.values().next().value);
    }
  }

  if (event.type === "assistant.message_start") {
    ensureLiveMessage(event.data.messageId || event.id);
  } else if (event.type === "assistant.message_delta") {
    const messageId = event.data.messageId || event.id;
    const live = ensureLiveMessage(messageId);
    live.text += event.data.deltaContent || "";
    live.content.replaceChildren(renderMarkdown(live.text));
    scrollToBottom();
  } else if (event.type === "assistant.message") {
    completeLiveMessage(event.data.messageId || event.id, event.data.content || "");
  } else if (event.type === "tool.start") {
    renderToolStart(event);
  } else if (event.type === "tool.end") {
    renderToolEnd(event);
  } else if (event.type === "session.error") {
    showToast(event.data.message || "Claude Code reported an error.", "error");
  }
}

function replayStream(stream, persistedMessages = []) {
  if (!stream) return;
  if (stream.running) {
    state.runningSessions.add(stream.sessionId);
  } else {
    state.runningSessions.delete(stream.sessionId);
  }
  const persistedAssistantContent = new Set(
    persistedMessages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content),
  );
  const persistedCompletedMessageIds = new Set(
    (stream.events || [])
      .filter(
        (event) =>
          event.type === "assistant.message" &&
          persistedAssistantContent.has(event.data?.content || ""),
      )
      .map((event) => event.data?.messageId || event.id),
  );
  for (const event of stream.events || []) {
    const messageId = event.data?.messageId || event.id;
    if (
      (event.type === "assistant.message" &&
        persistedAssistantContent.has(event.data?.content || "")) ||
      ((event.type === "assistant.message_start" ||
        event.type === "assistant.message_delta") &&
        persistedCompletedMessageIds.has(messageId))
    ) {
      if (event.id) {
        state.renderedEventIds.add(event.id);
      }
      continue;
    }
    handleClaudeEvent({ sessionId: stream.sessionId, event });
  }
}

function handleStreamPayload(payload) {
  if (payload.type === "connected") {
    elements.statusDot.classList.add("connected");
    const streams = payload.streams || [];
    state.runningSessions = new Set(
      streams.filter((stream) => stream.running).map((stream) => stream.sessionId),
    );
    for (const sessionId of state.pendingSessionSends) {
      state.runningSessions.add(sessionId);
    }
    state.streamSnapshots = new Map(streams.map((stream) => [stream.sessionId, stream]));
    for (const stream of streams) {
      if (stream.running) {
        state.terminalSessions.delete(stream.sessionId);
      } else {
        state.terminalSessions.add(stream.sessionId);
      }
      if (stream.sessionId === state.activeSessionId) {
        replayStream(stream);
      }
    }
    updateSendControls();
    applyWatchState(payload);
  } else if (payload.type === "claude-event") {
    handleClaudeEvent(payload);
  } else if (payload.type === "permission-request") {
    enqueuePermission(payload);
  } else if (payload.type === "permission-resolved") {
    dismissPermission(payload.requestId);
  } else if (payload.type === "sessions-changed") {
    setTimeout(() => refreshBootstrap({ quiet: true }), 300);
  } else if (payload.type === "watch-changed") {
    applyWatchState(payload);
  } else if (payload.type === "watch-released") {
    for (const item of payload.released || []) {
      state.runningSessions.add(item.sessionId);
      state.terminalSessions.delete(item.sessionId);
    }
    for (const item of payload.failed || []) {
      showToast(`Queued message could not be sent: ${item.error}`, "error");
    }
    if (payload.released?.length) {
      notifyReleased(payload.released);
    }
    updateSendControls();
    setTimeout(() => refreshBootstrap({ quiet: true }), 300);
  }
}

function handleSseFrame(frame) {
  const data = frame
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (data) {
    handleStreamPayload(JSON.parse(data));
  }
}

async function connectEventStream() {
  let retryDelay = 500;
  let failures = 0;
  while (true) {
    try {
      const response = await fetch("/api/events", {
        cache: "no-store",
        headers: studioToken ? { Authorization: `Bearer ${studioToken}` } : {},
      });
      // A 401 is not a transport hiccup and retrying cannot fix it: the token
      // is dead and only a fresh launch can mint another. Retrying anyway is
      // what filled the console with hundreds of silent 401s while the page
      // sat there looking merely disconnected.
      if (response.status === 401) {
        showSigninOverlay("This tab's token no longer matches the running Studio.");
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed with status ${response.status}.`);
      }
      retryDelay = 500;
      failures = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary;
        while ((boundary = buffer.indexOf("\n\n")) >= 0) {
          handleSseFrame(buffer.slice(0, boundary));
          buffer = buffer.slice(boundary + 2);
        }
      }
    } catch {
      elements.statusDot.classList.remove("connected");
      // A blip is worth retrying quietly; a server that stays gone is not, and
      // the page should stop pretending it is merely between reconnects.
      failures += 1;
      if (failures >= 3) {
        setServerUnreachable();
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 5000);
    } finally {
      elements.statusDot.classList.remove("connected");
    }
  }
}

function closeSidebar() {
  document.body.classList.remove("sidebar-open");
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem("claude-cli-studio-theme", theme);
}

function initializeTheme() {
  const stored = localStorage.getItem("claude-cli-studio-theme");
  const preferred = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  setTheme(stored || preferred);
}

/**
 * A draggable sidebar edge.
 *
 * Only `--sidebar-width` moves; the shell stays a two-column grid, so nothing
 * else in the layout has to know this happened. The width is clamped rather
 * than free: past the lower bound session titles are unreadable, and past the
 * upper one the conversation — the reason the window is open — gets squeezed.
 */
const SIDEBAR_WIDTH_KEY = "claude-cli-studio-sidebar-width";
const SIDEBAR_MIN = 210;
const SIDEBAR_DEFAULT = 310;

function sidebarMax() {
  // Never let the sidebar take more than half the window, however wide the
  // stored value was when it was saved on a bigger screen.
  return Math.max(SIDEBAR_MIN, Math.min(620, Math.round(window.innerWidth * 0.5)));
}

function setSidebarWidth(width, { persist = true } = {}) {
  const clamped = Math.round(Math.max(SIDEBAR_MIN, Math.min(sidebarMax(), width)));
  document.documentElement.style.setProperty("--sidebar-width", `${clamped}px`);
  elements.sidebarResizer?.setAttribute("aria-valuenow", String(clamped));
  if (persist) {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(clamped));
  }
  return clamped;
}

function initializeSidebarWidth() {
  const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY));
  setSidebarWidth(Number.isFinite(stored) && stored > 0 ? stored : SIDEBAR_DEFAULT, {
    persist: false,
  });

  const resizer = elements.sidebarResizer;
  if (!resizer) {
    return;
  }
  resizer.setAttribute("aria-valuemin", String(SIDEBAR_MIN));

  const shell = document.querySelector(".app-shell");
  let pointerId = null;

  resizer.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    pointerId = event.pointerId;
    // Capture so the drag keeps tracking once the pointer leaves the 7px
    // handle, which it does immediately.
    resizer.setPointerCapture(pointerId);
    shell?.classList.add("resizing");
    event.preventDefault();
  });

  resizer.addEventListener("pointermove", (event) => {
    if (pointerId === null) {
      return;
    }
    // The sidebar starts at the viewport's left edge, so the pointer's x is the
    // width outright.
    setSidebarWidth(event.clientX, { persist: false });
  });

  const endDrag = () => {
    if (pointerId === null) {
      return;
    }
    resizer.releasePointerCapture?.(pointerId);
    pointerId = null;
    shell?.classList.remove("resizing");
    // Persist once, at the end — not on every pointermove.
    const current = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"),
      10,
    );
    if (Number.isFinite(current)) {
      setSidebarWidth(current);
    }
  };
  resizer.addEventListener("pointerup", endDrag);
  resizer.addEventListener("pointercancel", endDrag);

  resizer.addEventListener("dblclick", () => setSidebarWidth(SIDEBAR_DEFAULT));

  // Keyboard, because a drag handle that only takes a mouse is not reachable.
  resizer.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 40 : 12;
    const current = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"),
      10,
    );
    if (event.key === "ArrowLeft") {
      setSidebarWidth(current - step);
    } else if (event.key === "ArrowRight") {
      setSidebarWidth(current + step);
    } else if (event.key === "Home") {
      setSidebarWidth(SIDEBAR_DEFAULT);
    } else {
      return;
    }
    event.preventDefault();
  });

  // A window that shrinks can leave a stored width taking most of it.
  window.addEventListener("resize", () => {
    const current = parseInt(
      getComputedStyle(document.documentElement).getPropertyValue("--sidebar-width"),
      10,
    );
    if (Number.isFinite(current) && current > sidebarMax()) {
      setSidebarWidth(current, { persist: false });
    }
  });
}

elements.newChatButton.addEventListener("click", () => startNewChat());
elements.openSidebarButton.addEventListener("click", () =>
  document.body.classList.add("sidebar-open"),
);
elements.closeSidebarButton.addEventListener("click", closeSidebar);
elements.sidebarBackdrop.addEventListener("click", closeSidebar);
elements.sessionSearch.addEventListener("input", renderSidebar);
elements.modeSelect.addEventListener("change", applyPermissionMode);
elements.watchButton.addEventListener("click", () => {
  state.queueForReset = !state.queueForReset;
  updateWatchButton();
  if (state.queueForReset) {
    requestAlertPermission();
    showToast("This message will wait for the usage window to reset.");
  }
});
elements.composerNote.addEventListener("click", (event) => {
  const sessionId = event.target.closest("[data-cancel-queued]")?.dataset.cancelQueued;
  if (sessionId) {
    cancelQueuedTurn(sessionId);
  }
});
elements.attachButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  uploadFiles(elements.fileInput.files);
  elements.fileInput.value = "";
});
elements.messageInput.addEventListener("input", () => {
  autoSizeTextarea();
  renderSuggestion();
});
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Tab" && !event.shiftKey && acceptSuggestion()) {
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && state.suggestion) {
    setSuggestion(null);
    return;
  }
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
elements.ghostSuggestion.addEventListener("click", acceptSuggestion);
elements.sendButton.addEventListener("click", sendMessage);
elements.stopButton.addEventListener("click", async () => {
  if (!state.activeSessionId) return;
  const sessionId = state.activeSessionId;
  try {
    await api(`/api/sessions/${sessionId}/abort`, { method: "POST" });
    state.pendingSessionSends.delete(sessionId);
    state.runningSessions.delete(sessionId);
    updateSendControls();
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.sessionNav.addEventListener("click", (event) => {
  const session = event.target.closest("[data-session-id]");
  if (session) {
    selectSession(session.dataset.sessionId, session.dataset.projectId);
    return;
  }
  const newProject = event.target.closest("[data-new-project]");
  if (newProject) {
    startNewChat(newProject.dataset.newProject);
    return;
  }
  const toggle = event.target.closest("[data-toggle-project]");
  if (toggle) {
    const projectId = toggle.dataset.toggleProject;
    if (state.collapsedProjects.has(projectId)) {
      state.collapsedProjects.delete(projectId);
    } else {
      state.collapsedProjects.add(projectId);
    }
    renderSidebar();
  }
});

elements.attachmentStrip.addEventListener("click", (event) => {
  const remove = event.target.closest("[data-remove-attachment]");
  if (!remove) return;
  const index = state.attachments.findIndex(
    (attachment) => attachment.localId === remove.dataset.removeAttachment,
  );
  if (index >= 0) {
    const [attachment] = state.attachments.splice(index, 1);
    if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
    if (attachment.id) {
      deleteUploads([attachment.id]);
    }
    renderAttachments();
  }
});

elements.projectSelect.addEventListener("change", async () => {
  const projectId = elements.projectSelect.value;
  state.activeProjectId = projectId;
  updateTopbar();
  if (!state.activeSessionId) return;
  try {
    await api(`/api/sessions/${state.activeSessionId}/organize`, {
      method: "POST",
      body: JSON.stringify({ projectId }),
    });
    await refreshBootstrap({ quiet: true });
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.renameButton.addEventListener("click", () => {
  elements.renameInput.value = state.activeSessionTitle;
  elements.renameDialog.showModal();
  setTimeout(() => elements.renameInput.select(), 0);
});
elements.renameForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.activeSessionId || !elements.renameInput.value.trim()) return;
  try {
    await api(`/api/sessions/${state.activeSessionId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: elements.renameInput.value }),
    });
    state.activeSessionTitle = elements.renameInput.value.trim();
    elements.renameDialog.close();
    await refreshBootstrap({ quiet: true });
    updateTopbar();
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.deleteButton.addEventListener("click", async () => {
  if (!state.activeSessionId) return;
  const confirmed = confirm(
    `Delete “${state.activeSessionTitle}” from your local Claude Code history? This deletes the transcript file and cannot be undone.`,
  );
  if (!confirmed) return;
  try {
    await api(`/api/sessions/${state.activeSessionId}`, { method: "DELETE" });
    startNewChat(state.activeProjectId);
    await refreshBootstrap({ quiet: true });
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.addProjectButton.addEventListener("click", () => {
  elements.projectNameInput.value = "";
  elements.projectPathInput.value =
    state.bootstrap?.app.scanRoots?.at(-1) || state.bootstrap?.app.workspaceRoot || "";
  elements.projectKeywordsInput.value = "";
  elements.projectDialog.showModal();
});
elements.projectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  try {
    await api("/api/projects", {
      method: "POST",
      body: JSON.stringify({
        name: elements.projectNameInput.value,
        path: elements.projectPathInput.value,
        keywords: elements.projectKeywordsInput.value,
      }),
    });
    elements.projectDialog.close();
    await refreshBootstrap({ quiet: true });
  } catch (error) {
    showToast(error.message, "error");
  }
});

elements.scanLocalButton.addEventListener("click", () => {
  elements.scanPathInput.value =
    state.bootstrap?.app.scanRoots?.at(-1) || state.bootstrap?.app.workspaceRoot || "";
  elements.scanDialog.showModal();
  setTimeout(() => elements.scanPathInput.select(), 0);
});
elements.scanForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const originalLabel = elements.runScanButton.textContent;
  elements.runScanButton.disabled = true;
  elements.runScanButton.textContent = "Scanning…";
  try {
    const result = await api("/api/scans", {
      method: "POST",
      body: JSON.stringify({ path: elements.scanPathInput.value }),
    });
    elements.scanDialog.close();
    await refreshBootstrap({ quiet: true });
    if (result.sessionCount > 0) {
      showToast(
        `Found ${result.sessionCount} session${result.sessionCount === 1 ? "" : "s"} across ` +
          `${result.projectCount} project folder${result.projectCount === 1 ? "" : "s"}.`,
      );
    } else {
      showToast("Folder saved. No matching local Claude Code sessions were found yet.");
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    elements.runScanButton.disabled = false;
    elements.runScanButton.textContent = originalLabel;
  }
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog")?.close());
});
for (const form of [elements.renameForm, elements.scanForm, elements.projectForm]) {
  form.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
}

elements.approveOnceButton.addEventListener("click", (event) => {
  event.preventDefault();
  resolvePermission("approve-once");
});
elements.approveSessionButton.addEventListener("click", (event) => {
  event.preventDefault();
  resolvePermission("approve-for-session");
});
elements.denyPermissionButton.addEventListener("click", (event) => {
  event.preventDefault();
  resolvePermission("reject");
});
elements.permissionDialog.addEventListener("cancel", (event) => {
  event.preventDefault();
  showToast("Choose Allow or Deny so Claude can continue.");
});

elements.themeButton.addEventListener("click", () => {
  setTheme(document.documentElement.dataset.theme === "dark" ? "light" : "dark");
});

document.querySelectorAll("[data-starter]").forEach((button) => {
  button.addEventListener("click", () => {
    elements.messageInput.value = button.dataset.starter;
    autoSizeTextarea();
    elements.messageInput.focus();
  });
});

document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.body.classList.add("sidebar-open");
    elements.sessionSearch.focus();
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    startNewChat();
  }
});

let dragDepth = 0;
window.addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth += 1;
  if ([...event.dataTransfer.types].includes("Files")) {
    elements.dropOverlay.classList.remove("hidden");
  }
});
window.addEventListener("dragover", (event) => event.preventDefault());
window.addEventListener("dragleave", (event) => {
  event.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) elements.dropOverlay.classList.add("hidden");
});
window.addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  elements.dropOverlay.classList.add("hidden");
  uploadFiles(event.dataTransfer.files);
});

// The queued banner counts down to the reset, so redraw it while anything is
// parked. Idle cost is one comparison a minute.
setInterval(() => {
  if (state.queue.length) {
    updateComposerNote();
    renderLimitMeter();
  }
}, 60 * 1000);

initializeTheme();
initializeSidebarWidth();
renderAlertsButton();
updateTitleBadge();
connectEventStream();
await refreshBootstrap();
startNewChat(state.bootstrap?.projects[0]?.id || "general");
