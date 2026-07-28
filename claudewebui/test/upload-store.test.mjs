import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { attachmentKind, UploadStore } from "../src/upload-store.mjs";

async function freshStore() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "claude-studio-uploads-"));
  const store = new UploadStore(directory);
  await store.init();
  return store;
}

function file(name, type, text) {
  const data = Buffer.from(text, "utf8");
  return { name, type, size: data.length, data: data.toString("base64") };
}

test("classifies attachments by how Claude should receive them", () => {
  assert.equal(attachmentKind({ name: "a.png", type: "image/png", size: 10 }), "image");
  assert.equal(attachmentKind({ name: "a.pdf", type: "application/pdf", size: 10 }), "document");
  assert.equal(attachmentKind({ name: "a.ts", type: "", size: 10 }), "text");
  assert.equal(attachmentKind({ name: "a.zip", type: "application/zip", size: 10 }), "path");
});

test("a large text file is referenced by path instead of inlined", () => {
  const kind = attachmentKind({ name: "huge.log", type: "text/plain", size: 5 * 1024 * 1024 });
  assert.equal(kind, "path");
});

test("strips directory traversal from file names before writing to disk", async () => {
  const store = await freshStore();
  const [upload] = await store.save([file("../../evil name.txt", "text/plain", "hi")]);
  assert.equal(upload.name, "evil name.txt");
  assert.equal(path.dirname(store.get(upload.id).path), store.directory);
});

test("replaces shell-significant characters in file names", async () => {
  const store = await freshStore();
  const [upload] = await store.save([file("we;ird$name.txt", "text/plain", "hi")]);
  assert.equal(upload.name, "we_ird_name.txt");
});

test("inlines text attachments so Claude sees them without a Read call", async () => {
  const store = await freshStore();
  const [upload] = await store.save([file("notes.md", "text/markdown", "# Title")]);
  const blocks = await store.toContentBlocks([upload.id]);

  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /Attached file: notes\.md/);
  assert.match(blocks[0].text, /# Title/);
});

test("images become native image blocks", async () => {
  const store = await freshStore();
  const [upload] = await store.save([file("shot.png", "image/png", "not-really-png")]);
  const blocks = await store.toContentBlocks([upload.id]);

  assert.equal(blocks[0].type, "image");
  assert.equal(blocks[0].source.media_type, "image/png");
  assert.equal(
    Buffer.from(blocks[0].source.data, "base64").toString("utf8"),
    "not-really-png",
  );
});

test("unknown binary types are handed over as a path for Claude to open", async () => {
  const store = await freshStore();
  const [upload] = await store.save([file("bundle.zip", "application/zip", "PK")]);
  const blocks = await store.toContentBlocks([upload.id]);

  assert.equal(blocks[0].type, "text");
  assert.match(blocks[0].text, /saved at/);
});

test("rejects an upload over the per-file limit", async () => {
  const store = await freshStore();
  const huge = Buffer.alloc(13 * 1024 * 1024).toString("base64");
  await assert.rejects(
    () => store.save([{ name: "big.bin", type: "application/octet-stream", size: 13 * 1024 * 1024, data: huge }]),
    /exceeds the 12 MB limit/,
  );
});

test("attached uploads survive cleanup until their session is deleted", async () => {
  const store = await freshStore();
  const [upload] = await store.save([file("notes.txt", "text/plain", "hi")]);

  await store.markAttached([upload.id], "session-1");
  assert.equal(await store.delete(upload.id), false, "attached uploads are not deletable");

  await store.deleteForSession("session-1");
  assert.equal(store.get(upload.id), null);
});

test("pending uploads are pruned once they age out", async () => {
  const store = await freshStore();
  const [upload] = await store.save([file("notes.txt", "text/plain", "hi")]);
  await store.prunePending(-1);
  assert.equal(store.get(upload.id), null);
});

test("missing attachments fail loudly rather than sending an empty turn", async () => {
  const store = await freshStore();
  await assert.rejects(() => store.toContentBlocks(["nope"]), /no longer available/);
});
