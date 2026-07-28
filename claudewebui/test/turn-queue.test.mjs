import assert from "node:assert/strict";
import test from "node:test";
import { TurnQueue } from "../src/turn-queue.mjs";

function entry(overrides = {}) {
  return {
    sessionId: "session-a",
    projectId: "general",
    isNewSession: false,
    prompt: "keep going",
    uploadIds: [],
    model: null,
    effort: null,
    permissionMode: "acceptEdits",
    ...overrides,
  };
}

test("queueing twice on one session replaces rather than stacks", () => {
  const queue = new TurnQueue();
  queue.add(entry({ prompt: "first" }));
  queue.add(entry({ prompt: "second" }));

  assert.equal(queue.size(), 1, "a waking session must not fire a backlog");
  assert.equal(queue.get("session-a").prompt, "second");
});

test("draining empties the queue so a second lift cannot double-send", () => {
  const queue = new TurnQueue();
  queue.add(entry({ sessionId: "session-a" }));
  queue.add(entry({ sessionId: "session-b" }));

  const parked = queue.drain();
  assert.equal(parked.length, 2);
  assert.equal(queue.size(), 0);
  assert.deepEqual(queue.drain(), []);
});

test("cancelling reports what was dropped and leaves the rest alone", () => {
  const queue = new TurnQueue();
  queue.add(entry({ sessionId: "session-a" }));
  queue.add(entry({ sessionId: "session-b" }));

  assert.equal(queue.cancel("session-a").sessionId, "session-a");
  assert.equal(queue.cancel("session-a"), null);
  assert.equal(queue.size(), 1);
  assert.equal(queue.has("session-b"), true);
});

test("the public entry carries the mode but never attachment bytes", () => {
  const queue = new TurnQueue();
  const added = queue.add(entry({ uploadIds: ["upload-1", "upload-2"] }));

  assert.equal(added.permissionMode, "acceptEdits");
  assert.equal(added.attachmentCount, 2);
  assert.equal(added.uploadIds, undefined);
  assert.ok(added.queuedAt);
});

test("stored upload ids are copied so a caller cannot mutate the queue", () => {
  const queue = new TurnQueue();
  const uploadIds = ["upload-1"];
  queue.add(entry({ uploadIds }));
  uploadIds.push("upload-2");

  assert.deepEqual(queue.get("session-a").uploadIds, ["upload-1"]);
});
