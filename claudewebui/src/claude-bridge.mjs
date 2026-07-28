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

    this.query = query({
      prompt: this.queue,
      options: {
        cwd: options.cwd,
        model: options.model || undefined,
        effort: options.effort || undefined,
        permissionMode: options.permissionMode,
        // Autopilot is the one mode the CLI refuses to enter without an
        // explicit opt-in flag.
        allowDangerouslySkipPermissions:
          options.permissionMode === "bypassPermissions" || undefined,
        includePartialMessages: true,
        // Behave like the terminal: same CLAUDE.md, same settings, same
        // system prompt. Without these the SDK runs a bare agent instead.
        systemPrompt: { type: "preset", preset: "claude_code" },
        settingSources: ["user", "project", "local"],
        // Studio has no in-band question surface, so let Claude ask in prose
        // rather than stalling on a dialog the browser cannot render.
        disallowedTools: ["AskUserQuestion"],
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

    if (message.type === "result") {
      this.currentMessageId = null;
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
      this.emit(
        studioEvent("session.idle", {
          stopReason: message.stop_reason ?? null,
          costUsd: message.total_cost_usd ?? null,
          durationMs: message.duration_ms ?? null,
          numTurns: message.num_turns ?? null,
        }),
      );
      this.scheduleIdleDisposal();
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

  async send({ content, model, effort, permissionMode }) {
    this.clearIdleTimer();

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

    this.emit(studioEvent("session.running", {}));
    this.queue.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: this.sessionId,
    });
  }

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

export class ClaudeBridge {
  constructor({ onEvent, onPermissionRequest }) {
    this.onEvent = onEvent;
    this.onPermissionRequest = onPermissionRequest;
    this.runners = new Map();
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

    await runner.send({ content, model, effort, permissionMode });
    return { sessionId };
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
    for (const runner of [...this.runners.values()]) {
      runner.dispose();
    }
    this.runners.clear();
  }
}
