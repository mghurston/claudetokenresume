import assert from "node:assert/strict";
import test from "node:test";
import { isSessionId, normalizeMessage } from "../src/session-catalog.mjs";

test("only real session ids are accepted", () => {
  assert.equal(isSessionId("93906006-12fc-4f63-8e02-662649efab68"), true);
  assert.equal(isSessionId("93906006-12FC-4F63-8E02-662649EFAB68"), true);

  // A session id becomes a transcript filename, so anything that could create a
  // junk conversation — or escape the directory — has to be turned away.
  assert.equal(isSessionId("undefined"), false);
  assert.equal(isSessionId("null"), false);
  assert.equal(isSessionId(""), false);
  assert.equal(isSessionId("../../etc/passwd"), false);
  assert.equal(isSessionId("93906006-12fc-4f63-8e02-662649efab68.jsonl"), false);
  assert.equal(isSessionId("93906006-12fc-4f63-8e02"), false);
  assert.equal(isSessionId("g3906006-12fc-4f63-8e02-662649efab68"), false);
  assert.equal(isSessionId(undefined), false);
  assert.equal(isSessionId(null), false);
  assert.equal(isSessionId(12345), false);
});

function userEntry(content, extra = {}) {
  return {
    type: "user",
    uuid: "u1",
    session_id: "s1",
    parent_tool_use_id: null,
    message: { role: "user", content },
    ...extra,
  };
}

function assistantEntry(content) {
  return {
    type: "assistant",
    uuid: "a1",
    session_id: "s1",
    parent_tool_use_id: null,
    message: { role: "assistant", content },
  };
}

test("keeps plain user text", () => {
  const message = normalizeMessage(userEntry("Fix the failing test"));
  assert.equal(message.role, "user");
  assert.equal(message.content, "Fix the failing test");
});

test("strips system reminders from user text", () => {
  const message = normalizeMessage(
    userEntry([
      { type: "text", text: "Ship it<system-reminder>be careful</system-reminder>" },
    ]),
  );
  assert.equal(message.content, "Ship it");
});

test("drops slash-command echoes and local command output", () => {
  assert.equal(normalizeMessage(userEntry("<command-name>/clear</command-name>")), null);
  assert.equal(normalizeMessage(userEntry("<local-command-stdout>ok</local-command-stdout>")), null);
});

test("drops user turns that only carry tool results", () => {
  const entry = userEntry([
    { type: "tool_result", tool_use_id: "toolu_1", content: "done" },
  ]);
  assert.equal(normalizeMessage(entry), null);
});

test("summarizes assistant tool calls without dumping their input", () => {
  const message = normalizeMessage(
    assistantEntry([
      { type: "text", text: "Reading the file." },
      {
        type: "tool_use",
        id: "toolu_1",
        name: "Read",
        input: { file_path: "/repo/index.js", limit: 40 },
      },
    ]),
  );

  assert.equal(message.content, "Reading the file.");
  assert.deepEqual(message.tools, [
    { id: "toolu_1", name: "Read", detail: "/repo/index.js" },
  ]);
});

test("separates thinking from the visible answer", () => {
  const message = normalizeMessage(
    assistantEntry([
      { type: "thinking", thinking: "Consider the edge case." },
      { type: "text", text: "Done." },
    ]),
  );
  assert.equal(message.content, "Done.");
  assert.equal(message.thinking, "Consider the edge case.");
});

test("turns inline base64 images into data URLs", () => {
  const message = normalizeMessage(
    userEntry([
      { type: "text", text: "What is this?" },
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" },
      },
    ]),
  );

  assert.equal(message.attachments.length, 1);
  assert.equal(message.attachments[0].kind, "image");
  assert.equal(message.attachments[0].dataUrl, "data:image/png;base64,aGVsbG8=");
});

test("summarizes oversized image payloads instead of inlining them", () => {
  const huge = "a".repeat(6 * 1024 * 1024);
  const message = normalizeMessage(
    userEntry([
      { type: "text", text: "Look" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: huge } },
    ]),
  );

  assert.equal(message.attachments[0].oversized, true);
  assert.equal(message.attachments[0].dataUrl, undefined);
});

test("ignores non-conversational entries", () => {
  assert.equal(normalizeMessage({ type: "system", uuid: "x", message: {} }), null);
  assert.equal(normalizeMessage(null), null);
});
