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

test("parked turns are written out so Quit and Restart cannot eat them", () => {
  // A turn can wait hours for a 5-hour window. Losing it to a button click, or
  // to a machine that reboots overnight, is worse than the file it costs.
  const written = [];
  const queue = new TurnQueue({ persist: (entries) => written.push(entries) });

  queue.add({ sessionId: "s1", projectId: "p", prompt: "hi", uploadIds: [] });
  assert.equal(written.length, 1);
  assert.equal(written.at(-1).length, 1);
  assert.equal(written.at(-1)[0].prompt, "hi");

  queue.add({ sessionId: "s2", projectId: "p", prompt: "there", uploadIds: [] });
  assert.equal(written.at(-1).length, 2);

  queue.cancel("s1");
  assert.equal(written.at(-1).length, 1);

  // Null means "the queue is empty" — the file is removed, not left holding a
  // prompt nobody is waiting on any more.
  queue.drain();
  assert.equal(written.at(-1), null);
});

test("a failing write never breaks the queue", () => {
  const queue = new TurnQueue({
    persist: () => {
      throw new Error("disk full");
    },
  });
  assert.doesNotThrow(() =>
    queue.add({ sessionId: "s1", projectId: "p", prompt: "hi", uploadIds: [] }),
  );
  assert.equal(queue.size(), 1);
});

test("restoring picks up where the last run left off", () => {
  const queue = new TurnQueue();
  const restored = queue.restore([
    { sessionId: "s1", projectId: "p", prompt: "waiting", uploadIds: ["u1"] },
    { sessionId: "s2", projectId: "p", prompt: "also waiting", uploadIds: [] },
    null,
    { prompt: "no session id" },
  ]);

  assert.equal(restored, 2);
  assert.equal(queue.get("s1").prompt, "waiting");
  assert.deepEqual(queue.get("s1").uploadIds, ["u1"]);
  assert.equal(queue.restore("not an array"), 0);
});
