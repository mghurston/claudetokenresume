const launchToken = new URLSearchParams(window.location.hash.slice(1)).get(
  "studio-token",
);
if (launchToken) {
  sessionStorage.setItem("claude-cli-studio-token", launchToken);
  history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
}
const studioToken = sessionStorage.getItem("claude-cli-studio-token") || "";

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
  effortSelect: document.querySelector("#effortSelect"),
  fileInput: document.querySelector("#fileInput"),
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
  const response = await fetch(url, requestOptions);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `Request failed with status ${response.status}.`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

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

function renderPermissionModes() {
  const previous = elements.modeSelect.value;
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

function updateComposerNote() {
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
    renderSidebar();
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

function appendOptimisticUserMessage(prompt, attachments) {
  showMessages();
  elements.messages.append(
    messageNode({
      role: "user",
      content: prompt,
      attachments,
      timestamp: new Date().toISOString(),
    }),
  );
  scrollToBottom();
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
  state.sending = activeRunning || state.pendingNavigationSends.has(state.navigationEpoch);
  elements.sendButton.classList.toggle("hidden", state.sending);
  elements.stopButton.classList.toggle("hidden", !activeRunning);
  elements.sendButton.disabled = state.uploading > 0;
}

async function sendMessage() {
  const prompt = elements.messageInput.value.trim();
  const readyAttachments = state.attachments.filter((attachment) => attachment.id);
  if ((!prompt && readyAttachments.length === 0) || state.sending || state.uploading > 0) {
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

  appendOptimisticUserMessage(displayPrompt, attachmentMetadata);
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
        prompt,
        uploadIds,
        model: elements.modelSelect.value || null,
        effort: elements.effortSelect.value || null,
        permissionMode: elements.modeSelect.value,
      }),
    });

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
  showNextPermission();
}

function showNextPermission() {
  if (state.currentPermission || state.permissionQueue.length === 0) {
    return;
  }
  showPermissionDialog(state.permissionQueue.shift());
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
  const terminalEvent = event.type === "session.idle" || event.type === "session.error";
  if (terminalEvent) {
    state.terminalSessions.add(sessionId);
    state.pendingSessionSends.delete(sessionId);
    state.runningSessions.delete(sessionId);
    if (sessionId === state.activeSessionId) {
      updateSendControls();
    }
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
  } else if (payload.type === "claude-event") {
    handleClaudeEvent(payload);
  } else if (payload.type === "permission-request") {
    enqueuePermission(payload);
  } else if (payload.type === "sessions-changed") {
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
  while (true) {
    try {
      const response = await fetch("/api/events", {
        cache: "no-store",
        headers: studioToken ? { Authorization: `Bearer ${studioToken}` } : {},
      });
      if (!response.ok || !response.body) {
        throw new Error(`Event stream failed with status ${response.status}.`);
      }
      retryDelay = 500;
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

elements.newChatButton.addEventListener("click", () => startNewChat());
elements.openSidebarButton.addEventListener("click", () =>
  document.body.classList.add("sidebar-open"),
);
elements.closeSidebarButton.addEventListener("click", closeSidebar);
elements.sidebarBackdrop.addEventListener("click", closeSidebar);
elements.sessionSearch.addEventListener("input", renderSidebar);
elements.modeSelect.addEventListener("change", updateComposerNote);
elements.attachButton.addEventListener("click", () => elements.fileInput.click());
elements.fileInput.addEventListener("change", () => {
  uploadFiles(elements.fileInput.files);
  elements.fileInput.value = "";
});
elements.messageInput.addEventListener("input", autoSizeTextarea);
elements.messageInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    sendMessage();
  }
});
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

initializeTheme();
connectEventStream();
await refreshBootstrap();
startNewChat(state.bootstrap?.projects[0]?.id || "general");
