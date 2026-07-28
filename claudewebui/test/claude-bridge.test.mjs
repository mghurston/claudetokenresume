import assert from "node:assert/strict";
import test from "node:test";
import { MessageQueue } from "../src/claude-bridge.mjs";

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
