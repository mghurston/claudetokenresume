import { query } from "@anthropic-ai/claude-agent-sdk";

/**
 * Owns the live Claude Code processes behind Studio.
 *
 * One `SessionRunner` wraps one long-lived `query()` in streaming-input mode,
 * which keeps the CLI warm between turns (a follow-up message costs no spawn)
 * and is the only mode where `interrupt()` / `setModel()` work. Runners are
 * keyed by session id and disposed after an idle timeout.
 */

const RUNNER_IDLE_MS = 15 * 60 * 1000;

/**
 * The static half of the `query()` options for one runner.
 *
 * `allowDangerouslySkipPermissions` is unconditional on purpose. It is only an
 * *unlock* — the SDK turns it into the CLI's `--allow-dangerously-skip-permissions`,
 * which permits a session to enter `bypassPermissions` but does not itself skip
 * anything; `permissionMode` still decides what actually happens. Because a
 * runner is long-lived, gating the flag on the mode of the *first* turn made
 * later `setPermissionMode("bypassPermissions")` calls throw "the session was
 * not launched with --dangerously-skip-permissions", so picking Autopilot
 * mid-conversation failed. The only caller that can flip the mode is the user's
 * own dropdown — `sessionPermissionUpdates` strips `setMode` suggestions, so
 * Claude can never widen the session on its own.
 */
export function sessionQueryOptions({ cwd, model, effort, permissionMode }) {
  return {
    cwd,
    model: model || undefined,
    effort: effort || undefined,
    permissionMode,
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    // Behave like the terminal: same CLAUDE.md, same settings, same
    // system prompt. Without these the SDK runs a bare agent instead.
    systemPrompt: { type: "preset", preset: "claude_code" },
    settingSources: ["user", "project", "local"],
    // Studio has no in-band question surface, so let Claude ask in prose
    // rather than stalling on a dialog the browser cannot render.
    disallowedTools: ["AskUserQuestion"],
  };
}

function nowIso() {
  return new Date().toISOString();
}

function studioEvent(type, data = {}) {
  return { type, id: crypto.randomUUID(), timestamp: nowIso(), data };
}

function toolDetail(input) {
  if (!input || typeof input !== "object") {
    return "";
  }
  const detail =
    input.file_path ||
    input.path ||
    input.command ||
    input.pattern ||
    input.url ||
    input.description ||
    input.prompt ||
    "";
  return String(detail).slice(0, 200);
}

/**
 * An async iterable the caller can push into after iteration has started —
 * this is what turns a one-shot query into a multi-turn conversation.
 */
export class MessageQueue {
  constructor() {
    this.pending = [];
    this.waiting = null;
    this.closed = false;
  }

  push(message) {
    if (this.closed) {
      return;
    }
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: message, done: false });
      return;
    }
    this.pending.push(message);
  }

  close() {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = null;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this.pending.length) {
          return Promise.resolve({ value: this.pending.shift(), done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
      return: () => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

class SessionRunner {
  constructor(bridge, sessionId, options) {
    this.bridge = bridge;
    this.sessionId = sessionId;
    this.cwd = options.cwd;
    this.model = options.model ?? null;
    this.effort = options.effort ?? null;
    this.permissionMode = options.permissionMode;
    this.queue = new MessageQueue();
    this.abortController = new AbortController();
    this.idleTimer = null;
    this.disposed = false;
    this.currentMessageId = null;
    this.stderrTail = [];
    // True between sending a turn and its result. Decides whether a new message
    // starts a turn or parks behind the one already running.
    this.running = false;
    this.pending = new Map();

    this.query = query({
      prompt: this.queue,
      options: {
        ...sessionQueryOptions(options),
        canUseTool: (toolName, input, context) =>
          this.bridge.handlePermission(this.sessionId, toolName, input, context),
        abortController: this.abortController,
        stderr: (data) => {
          this.stderrTail.push(String(data));
          if (this.stderrTail.length > 40) {
            this.stderrTail.shift();
          }
        },
        ...(options.resume
          ? { resume: this.sessionId }
          : { sessionId: this.sessionId }),
      },
    });

    this.pump = this.consume();
  }

  emit(event) {
    this.bridge.onEvent({ sessionId: this.sessionId, event });
  }

  async consume() {
    try {
      for await (const message of this.query) {
        this.handleMessage(message);
      }
    } catch (error) {
      if (!this.disposed) {
        const detail = this.stderrTail.join("").trim();
        this.emit(
          studioEvent("session.error", {
            message: detail
              ? `${error.message} — ${detail.slice(-400)}`
              : error.message,
          }),
        );
      }
    } finally {
      this.bridge.forgetRunner(this.sessionId, this);
    }
  }

  handleMessage(message) {
    if (message.type === "stream_event") {
      this.handleStreamEvent(message);
      return;
    }

    if (message.type === "assistant") {
      this.handleAssistantMessage(message);
      return;
    }

    if (message.type === "user") {
      this.handleToolResults(message);
      return;
    }

    // The CLI reports plan limit state on any live query — status, reset time,
    // and window utilization. Studio's watch rides on this instead of polling
    // whenever a session happens to be running.
    if (message.type === "rate_limit_event") {
      this.bridge.onRateLimit?.(message.rate_limit_info);
      return;
    }

    // The CLI's own suggested next prompt — what the terminal offers as ghost
    // text you accept with Tab.
    if (message.type === "prompt_suggestion") {
      this.emit(studioEvent("session.suggestion", { suggestion: message.suggestion }));
      return;
    }

    if (message.type === "result") {
      this.currentMessageId = null;

      // A `/btw` note folds into the turn already running by aborting it and
      // re-running with the note included. That abort surfaces as an
      // error_during_execution result which is bookkeeping, not a failure —
      // the real answer arrives in the turn that immediately follows. Report it
      // as an error and every side question would look like a crash.
      const foldingIn =
        [...this.pending.values()].includes("now") &&
        message.subtype === "error_during_execution";
      if (foldingIn) {
        this.clearPending("now");
        return;
      }

      if (message.subtype !== "success" || message.is_error) {
        this.emit(
          studioEvent("session.error", {
            message:
              typeof message.result === "string" && message.result
                ? message.result
                : `Claude Code stopped: ${message.subtype}`,
          }),
        );
      }
      this.running = false;
      this.emit(
        studioEvent("session.idle", {
          stopReason: message.stop_reason ?? null,
          costUsd: message.total_cost_usd ?? null,
          durationMs: message.duration_ms ?? null,
          numTurns: message.num_turns ?? null,
        }),
      );

      // The CLI dequeues anything parked and starts it straight away, so go
      // back to running rather than letting the composer look idle for a beat.
      if (this.pending.size) {
        this.clearPending();
        this.running = true;
        this.emit(studioEvent("session.running", {}));
      } else {
        this.scheduleIdleDisposal();
      }
      return;
    }

    if (message.type === "system" && message.subtype === "permission_denied") {
      this.emit(
        studioEvent("tool.end", {
          toolCallId: message.tool_use_id,
          ok: false,
          denied: true,
        }),
      );
    }
  }

  handleStreamEvent(message) {
    const event = message.event;
    if (!event || typeof event !== "object") {
      return;
    }

    if (event.type === "message_start") {
      this.currentMessageId = event.message?.id || message.uuid;
      this.emit(
        studioEvent("assistant.message_start", { messageId: this.currentMessageId }),
      );
      return;
    }

    if (event.type === "content_block_delta") {
      const messageId = this.currentMessageId || message.uuid;
      const delta = event.delta || {};
      if (delta.type === "text_delta" && delta.text) {
        this.emit(
          studioEvent("assistant.message_delta", {
            messageId,
            deltaContent: delta.text,
          }),
        );
      } else if (delta.type === "thinking_delta" && delta.thinking) {
        this.emit(
          studioEvent("assistant.thinking_delta", {
            messageId,
            deltaContent: delta.thinking,
          }),
        );
      }
    }
  }

  handleAssistantMessage(message) {
    const blocks = Array.isArray(message.message?.content)
      ? message.message.content
      : [];
    const text = blocks
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("");
    const messageId = message.message?.id || message.uuid;

    if (text) {
      this.emit(
        studioEvent("assistant.message", { messageId, content: text }),
      );
    }

    for (const block of blocks) {
      if (block?.type === "tool_use") {
        this.emit(
          studioEvent("tool.start", {
            toolCallId: block.id,
            name: block.name,
            detail: toolDetail(block.input),
          }),
        );
      }
    }

    if (message.error) {
      this.emit(
        studioEvent("session.error", {
          message: `Claude Code reported ${message.error}.`,
        }),
      );
    }
  }

  handleToolResults(message) {
    const blocks = Array.isArray(message.message?.content)
      ? message.message.content
      : [];
    for (const block of blocks) {
      if (block?.type === "tool_result") {
        this.emit(
          studioEvent("tool.end", {
            toolCallId: block.tool_use_id,
            ok: block.is_error !== true,
          }),
        );
      }
    }
  }

  clearIdleTimer() {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  scheduleIdleDisposal() {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => this.dispose(), RUNNER_IDLE_MS);
    this.idleTimer.unref?.();
  }

  /**
   * Sends one turn, or parks one behind the turn already running.
   *
   * `priority` maps straight onto the CLI's own command queue, which is what
   * the terminal uses when you type while Claude is working:
   *
   *   - undefined / 'next' — run after the current turn finishes. Typing ahead.
   *   - 'now' — fold into the turn already in flight. This is `/btw`: the CLI
   *     aborts the running turn and immediately re-runs it with your note
   *     included, so the answer accounts for what you just said.
   *
   * Model, effort and permission mode are session-wide settings that take
   * effect immediately, so they are only applied when nothing is running.
   * Changing them for a message that has not started yet would silently
   * re-steer the turn currently on screen.
   */
  async send({ content, model, effort, permissionMode, priority = null }) {
    this.clearIdleTimer();
    const queueing = Boolean(priority) && this.running;

    if (!queueing) {
      if (permissionMode && permissionMode !== this.permissionMode) {
        await this.query.setPermissionMode(permissionMode);
        this.permissionMode = permissionMode;
      }
      if ((model ?? null) !== this.model) {
        await this.query.setModel(model || undefined);
        this.model = model ?? null;
      }
      if ((effort ?? null) !== this.effort) {
        await this.query
          .applyFlagSettings({ effort: effort || null })
          .catch(() => {});
        this.effort = effort ?? null;
      }
    }

    const messageUuid = crypto.randomUUID();
    if (queueing) {
      this.pending.set(messageUuid, priority);
      this.emit(studioEvent("session.pending", { messageUuid, priority }));
    } else {
      this.running = true;
      this.emit(studioEvent("session.running", {}));
    }

    this.queue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.sessionId,
      ...(queueing ? { priority, uuid: messageUuid } : {}),
    });
    return { messageUuid, queued: queueing };
  }

  /** Forgets parked messages the CLI has taken off its queue, and tells the UI. */
  clearPending(priority = null) {
    const cleared = [];
    for (const [messageUuid, entry] of this.pending) {
      if (!priority || entry === priority) {
        cleared.push(messageUuid);
        this.pending.delete(messageUuid);
      }
    }
    if (cleared.length) {
      this.emit(studioEvent("session.pending_cleared", { messageUuids: cleared }));
    }
  }

  // Note: a parked message cannot be un-queued. The CLI protocol has
  // cancel_async_message and interrupt's cancel_queued, but the SDK's public
  // Query API exposes neither, so there is nothing honest to wire a Cancel
  // button to. Stop still aborts the running turn — the parked message then
  // runs, which is what the terminal does too.

  async interrupt() {
    await this.query.interrupt().catch(() => {});
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.clearIdleTimer();
    this.queue.close();
    this.abortController.abort();
    this.bridge.forgetRunner(this.sessionId, this);
  }
}

/**
 * A CLI process kept open purely to run the account login flow.
 *
 * `/login` is NOT a slash command the SDK can run: it is absent from
 * `supportedCommands()`, and sending it as a prompt makes the CLI answer
 * "/login isn't available in this environment" because the flow belongs to the
 * interactive terminal. The control requests underneath it are reachable
 * though — `claudeAuthenticate` returns an authorize URL, and either
 * `claudeOAuthWaitForCompletion` (the CLI listens on its own loopback port for
 * the redirect) or `claudeOAuthCallback` (the user pastes `code#state`)
 * finishes it.
 *
 * These three are undocumented — present on the runtime Query object but
 * absent from `sdk.d.ts` — so every call is capability-checked and turns a
 * missing method into a plain message rather than an SDK-shaped crash.
 *
 * The whole flow has to run against ONE CLI process: the PKCE verifier and the
 * `state` value live in the process that issued the URL, so a second process
 * would reject the callback. Hence one channel, held open between the two
 * calls and disposed on completion or timeout.
 *
 * Nothing here writes `~/.claude/.credentials.json`. The CLI owns that file;
 * Studio only asks it to run its own flow.
 */
const AUTH_CHANNEL_IDLE_MS = 10 * 60 * 1000;

class AuthChannel {
  constructor(cwd) {
    this.queue = new MessageQueue();
    this.abortController = new AbortController();
    this.lastError = null;
    this.disposed = false;

    this.query = query({
      prompt: this.queue,
      options: {
        cwd,
        permissionMode: "default",
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        abortController: this.abortController,
      },
    });

    this.pump = (async () => {
      for await (const message of this.query) {
        if (message.type === "auth_status" && message.error) {
          this.lastError = message.error;
        }
      }
    })().catch(() => {});

    this.idleTimer = setTimeout(() => this.dispose(), AUTH_CHANNEL_IDLE_MS);
    this.idleTimer.unref?.();
  }

  supports(method) {
    return typeof this.query?.[method] === "function";
  }

  dispose() {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    clearTimeout(this.idleTimer);
    this.queue.close();
    this.abortController.abort();
  }
}

class UnsupportedByCli extends Error {
  constructor(message) {
    super(message);
    this.unsupported = true;
  }
}

export class ClaudeBridge {
  constructor({
    onEvent,
    onPermissionRequest,
    onRateLimit = () => {},
    // Seam for tests: the real channel spawns a CLI process, and the guards
    // around the undocumented control requests are the part worth covering.
    openAuthChannel = (cwd) => new AuthChannel(cwd),
  }) {
    this.openAuthChannel = openAuthChannel;
    this.onEvent = onEvent;
    this.onPermissionRequest = onPermissionRequest;
    this.onRateLimit = onRateLimit;
    this.runners = new Map();
    this.authChannel = null;
  }

  /**
   * Who the CLI is logged in as, or null when it cannot say.
   *
   * Reads through any live session runner so the common case costs no process;
   * only falls back to a throwaway channel when nothing is running.
   */
  async accountInfo({ cwd }) {
    const existing = [...this.runners.values()].find((runner) =>
      typeof runner.query?.accountInfo === "function",
    );
    if (existing) {
      return existing.query.accountInfo().catch(() => null);
    }
    const channel = this.openAuthChannel(cwd);
    try {
      if (!channel.supports("accountInfo")) {
        return null;
      }
      return await channel.query.accountInfo();
    } catch {
      return null;
    } finally {
      channel.dispose();
    }
  }

  /** Starts a login and returns the URLs to send the browser to. */
  async beginLogin({ cwd }) {
    this.authChannel?.dispose();
    const channel = this.openAuthChannel(cwd);
    this.authChannel = channel;
    if (!channel.supports("claudeAuthenticate")) {
      channel.dispose();
      this.authChannel = null;
      throw new UnsupportedByCli(
        "This Claude Code build does not expose the login flow to Studio. Run `claude /login` in a terminal.",
      );
    }
    try {
      const urls = await channel.query.claudeAuthenticate(true);
      return {
        manualUrl: urls?.manualUrl || null,
        automaticUrl: urls?.automaticUrl || null,
      };
    } catch (error) {
      channel.dispose();
      this.authChannel = null;
      throw error;
    }
  }

  /**
   * Finishes a login. With no code, waits for the CLI's own loopback listener
   * to catch the redirect; with one, submits the pasted `code#state` pair.
   */
  async completeLogin({ code = null, state = null } = {}) {
    const channel = this.authChannel;
    if (!channel || channel.disposed) {
      throw new Error("No login is in progress. Run /login again.");
    }
    const method = code ? "claudeOAuthCallback" : "claudeOAuthWaitForCompletion";
    if (!channel.supports(method)) {
      throw new UnsupportedByCli(
        "This Claude Code build cannot finish a login from Studio. Run `claude /login` in a terminal.",
      );
    }
    try {
      if (code) {
        await channel.query.claudeOAuthCallback(code, state);
      } else {
        await channel.query.claudeOAuthWaitForCompletion();
      }
    } catch (error) {
      throw new Error(channel.lastError || error.message);
    } finally {
      channel.dispose();
      this.authChannel = null;
    }

    // Session runners hold a CLI process that authenticated at spawn time, so
    // they are still on the old identity. Drop them and let the next turn
    // start fresh under the new login.
    for (const runner of [...this.runners.values()]) {
      runner.dispose();
    }
    this.runners.clear();
  }

  cancelLogin() {
    this.authChannel?.dispose();
    this.authChannel = null;
  }

  forgetRunner(sessionId, runner) {
    if (this.runners.get(sessionId) === runner) {
      this.runners.delete(sessionId);
    }
  }

  handlePermission(sessionId, toolName, input, context) {
    return this.onPermissionRequest({
      sessionId,
      request: {
        toolName,
        input,
        title: context?.title,
        displayName: context?.displayName,
        description: context?.description,
        blockedPath: context?.blockedPath,
        decisionReason: context?.decisionReason,
        suggestions: context?.suggestions,
      },
      signal: context?.signal,
    });
  }

  isRunning(sessionId) {
    return this.runners.has(sessionId);
  }

  /**
   * Applies a permission mode to a live session immediately.
   *
   * `send()` also syncs the mode, but only when it starts a turn — which is
   * useless for the case that matters: a prompt appears mid-turn, the user
   * picks Autopilot to stop being asked, and walks away. Until this existed,
   * that choice reached the CLI only on the *next* message, so the running turn
   * kept asking and the user kept not being there to answer.
   *
   * Returns false when the session has no live runner (nothing is running, so
   * the mode the next turn is sent with is the only thing that matters).
   */
  async setPermissionMode(sessionId, permissionMode) {
    const runner = this.runners.get(sessionId);
    if (!runner || runner.disposed) {
      return false;
    }
    if (runner.permissionMode === permissionMode) {
      return true;
    }
    await runner.query.setPermissionMode(permissionMode);
    runner.permissionMode = permissionMode;
    return true;
  }

  /**
   * Sends one turn. `sessionId` must already be decided by the caller — for a
   * brand-new chat it is a fresh UUID handed to the CLI via the `sessionId`
   * option, which lets Studio show the conversation in the sidebar before
   * Claude has answered.
   */
  async sendMessage({
    sessionId,
    isNewSession,
    cwd,
    content,
    model,
    effort,
    permissionMode,
    priority = null,
  }) {
    let runner = this.runners.get(sessionId);

    if (runner && runner.cwd !== cwd) {
      runner.dispose();
      runner = null;
    }

    if (!runner) {
      runner = new SessionRunner(this, sessionId, {
        cwd,
        model,
        effort,
        permissionMode,
        resume: !isNewSession,
      });
      this.runners.set(sessionId, runner);
    }

    const sent = await runner.send({ content, model, effort, permissionMode, priority });
    return { sessionId, ...sent };
  }

  isPending(sessionId) {
    return (this.runners.get(sessionId)?.pending.size ?? 0) > 0;
  }

  async abort(sessionId) {
    const runner = this.runners.get(sessionId);
    if (runner) {
      await runner.interrupt();
    }
  }

  release(sessionId) {
    this.runners.get(sessionId)?.dispose();
  }

  async stop() {
    this.cancelLogin();
    for (const runner of [...this.runners.values()]) {
      runner.dispose();
    }
    this.runners.clear();
  }
}
