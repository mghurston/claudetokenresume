import assert from "node:assert/strict";
import test from "node:test";
import { ClaudeBridge, MessageQueue, sessionQueryOptions } from "../src/claude-bridge.mjs";

/**
 * Stands in for a CLI process during the login flow. `methods` names which of
 * the undocumented control requests this fake "build" exposes, so a test can
 * pretend an SDK release dropped one.
 */
function fakeAuthChannel({ methods = [], calls = [], result = {} } = {}) {
  const query = {};
  for (const method of methods) {
    query[method] = async (...args) => {
      calls.push([method, ...args]);
      return result[method] ?? null;
    };
  }
  return {
    query,
    disposed: false,
    lastError: null,
    supports(method) {
      return typeof query[method] === "function";
    },
    dispose() {
      this.disposed = true;
    },
  };
}

function bridgeWith(channel) {
  return new ClaudeBridge({
    onEvent: () => {},
    onPermissionRequest: () => {},
    openAuthChannel: () => channel,
  });
}

test("delivers messages pushed before iteration starts", async () => {
  const queue = new MessageQueue();
  queue.push("first");
  queue.push("second");
  queue.close();

  const seen = [];
  for await (const message of queue) {
    seen.push(message);
  }
  assert.deepEqual(seen, ["first", "second"]);
});

test("resolves a waiting consumer when a later turn arrives", async () => {
  const queue = new MessageQueue();
  const iterator = queue[Symbol.asyncIterator]();

  const pending = iterator.next();
  queue.push("late");
  assert.deepEqual(await pending, { value: "late", done: false });
});

test("closing wakes a waiting consumer", async () => {
  const queue = new MessageQueue();
  const iterator = queue[Symbol.asyncIterator]();

  const pending = iterator.next();
  queue.close();
  assert.deepEqual(await pending, { value: undefined, done: true });
});

test("ignores pushes after close so a disposed runner cannot be revived", async () => {
  const queue = new MessageQueue();
  queue.close();
  queue.push("ignored");

  const iterator = queue[Symbol.asyncIterator]();
  assert.deepEqual(await iterator.next(), { value: undefined, done: true });
});

test("breaking out of the loop closes the queue", async () => {
  const queue = new MessageQueue();
  queue.push("only");

  for await (const message of queue) {
    assert.equal(message, "only");
    break;
  }

  assert.equal(queue.closed, true);
});

test("unlocks Autopilot even when the session starts in another mode", () => {
  // A runner outlives the turn that created it, so the unlock cannot depend on
  // the first turn's mode or switching to Autopilot later throws.
  for (const mode of ["default", "plan", "acceptEdits", "bypassPermissions"]) {
    const options = sessionQueryOptions({ cwd: "C:/proj", permissionMode: mode });
    assert.equal(options.allowDangerouslySkipPermissions, true);
    assert.equal(options.permissionMode, mode);
  }
});

test("keeps the terminal's context and hides the dialog-only tool", () => {
  const options = sessionQueryOptions({
    cwd: "C:/proj",
    model: "",
    effort: "",
    permissionMode: "default",
  });
  assert.deepEqual(options.systemPrompt, { type: "preset", preset: "claude_code" });
  assert.deepEqual(options.settingSources, ["user", "project", "local"]);
  assert.deepEqual(options.disallowedTools, ["AskUserQuestion"]);
  // Empty strings from the composer must not reach the CLI as real values.
  assert.equal(options.model, undefined);
  assert.equal(options.effort, undefined);
});

test("login hands back both authorize URLs", async () => {
  const calls = [];
  const channel = fakeAuthChannel({
    methods: ["claudeAuthenticate"],
    calls,
    result: {
      claudeAuthenticate: { manualUrl: "https://claude.com/manual", automaticUrl: "https://claude.com/auto" },
    },
  });

  const urls = await bridgeWith(channel).beginLogin({ cwd: "C:/proj" });

  assert.deepEqual(urls, {
    manualUrl: "https://claude.com/manual",
    automaticUrl: "https://claude.com/auto",
  });
  // loginWithClaudeAi must be true or the CLI runs the Console billing flow.
  assert.deepEqual(calls, [["claudeAuthenticate", true]]);
});

test("a build without the login control says so instead of throwing SDK noise", async () => {
  // claudeAuthenticate / claudeOAuthCallback are absent from sdk.d.ts, so an
  // SDK bump could remove them. That must read as a plain instruction.
  const bridge = bridgeWith(fakeAuthChannel({ methods: [] }));
  await assert.rejects(bridge.beginLogin({ cwd: "C:/proj" }), (error) => {
    assert.equal(error.unsupported, true);
    assert.match(error.message, /claude \/login/);
    return true;
  });
  assert.equal(bridge.authChannel, null);
});

test("completing a login without starting one is refused", async () => {
  const bridge = bridgeWith(fakeAuthChannel({ methods: ["claudeAuthenticate"] }));
  await assert.rejects(bridge.completeLogin({ code: "abc", state: "xyz" }), /No login is in progress/);
});

test("a pasted code goes to the callback, and a bare wait does not", async () => {
  const calls = [];
  const channel = fakeAuthChannel({
    methods: ["claudeAuthenticate", "claudeOAuthCallback", "claudeOAuthWaitForCompletion"],
    calls,
    result: { claudeAuthenticate: { manualUrl: "m", automaticUrl: "a" } },
  });
  const bridge = bridgeWith(channel);

  await bridge.beginLogin({ cwd: "C:/proj" });
  await bridge.completeLogin({ code: "abc", state: "xyz" });

  assert.deepEqual(calls[1], ["claudeOAuthCallback", "abc", "xyz"]);
  // The channel holds the PKCE verifier for one exchange only.
  assert.equal(channel.disposed, true);
  assert.equal(bridge.authChannel, null);
});

test("no code means wait for the CLI's own redirect listener", async () => {
  const calls = [];
  const channel = fakeAuthChannel({
    methods: ["claudeAuthenticate", "claudeOAuthCallback", "claudeOAuthWaitForCompletion"],
    calls,
    result: { claudeAuthenticate: { manualUrl: "m", automaticUrl: "a" } },
  });
  const bridge = bridgeWith(channel);

  await bridge.beginLogin({ cwd: "C:/proj" });
  await bridge.completeLogin({});

  assert.deepEqual(calls[1], ["claudeOAuthWaitForCompletion"]);
});

test("a finished login drops runners still holding the old identity", async () => {
  const channel = fakeAuthChannel({
    methods: ["claudeAuthenticate", "claudeOAuthWaitForCompletion"],
    result: { claudeAuthenticate: { manualUrl: "m", automaticUrl: "a" } },
  });
  const bridge = bridgeWith(channel);
  let disposed = false;
  // A runner authenticated when its CLI process spawned, so it would keep
  // using the previous account until it is replaced.
  bridge.runners.set("session-1", { dispose: () => (disposed = true) });

  await bridge.beginLogin({ cwd: "C:/proj" });
  await bridge.completeLogin({});

  assert.equal(disposed, true);
  assert.equal(bridge.runners.size, 0);
});

test("account lookup rides an existing runner rather than spawning a process", async () => {
  let spawned = 0;
  const bridge = new ClaudeBridge({
    onEvent: () => {},
    onPermissionRequest: () => {},
    openAuthChannel: () => {
      spawned += 1;
      return fakeAuthChannel({ methods: ["accountInfo"] });
    },
  });
  bridge.runners.set("session-1", {
    query: { accountInfo: async () => ({ email: "someone@example.com" }) },
  });

  assert.deepEqual(await bridge.accountInfo({ cwd: "C:/proj" }), {
    email: "someone@example.com",
  });
  assert.equal(spawned, 0);
});

test("account lookup reports null rather than failing the page", async () => {
  const channel = fakeAuthChannel({ methods: [] });
  assert.equal(await bridgeWith(channel).accountInfo({ cwd: "C:/proj" }), null);
  assert.equal(channel.disposed, true);
});
