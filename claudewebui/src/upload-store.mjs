import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_FILES = 12;
const MAX_FILE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_BYTES = 30 * 1024 * 1024;
// Text pasted inline is what Claude actually reads; anything larger is left on
// disk and referenced by path so Claude can decide how much of it to open.
const MAX_INLINE_TEXT_BYTES = 256 * 1024;

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".tsv", ".log", ".json", ".jsonl",
  ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf", ".env", ".xml", ".html",
  ".htm", ".css", ".scss", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".py", ".rb", ".go", ".rs", ".java", ".kt", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".php", ".sh", ".bash", ".zsh", ".ps1", ".psm1", ".sql", ".graphql",
  ".vue", ".svelte", ".patch", ".diff", ".gitignore", ".dockerfile",
]);

function safeName(name) {
  const base = path.basename(String(name || "attachment"));
  return base.replace(/[^a-zA-Z0-9._ -]/g, "_").slice(0, 180) || "attachment";
}

function safeMimeType(value) {
  const mimeType = String(value || "application/octet-stream").trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeType)
    ? mimeType
    : "application/octet-stream";
}

export function attachmentKind(upload) {
  if (IMAGE_MEDIA_TYPES.has(upload.type)) {
    return "image";
  }
  if (upload.type === "application/pdf") {
    return "document";
  }
  const extension = path.extname(upload.name).toLowerCase();
  if (
    upload.type.startsWith("text/") ||
    TEXT_EXTENSIONS.has(extension) ||
    upload.type === "application/json" ||
    upload.type === "application/xml"
  ) {
    return upload.size <= MAX_INLINE_TEXT_BYTES ? "text" : "path";
  }
  return "path";
}

export class UploadStore {
  constructor(dataDirectory) {
    this.directory = path.join(dataDirectory, "uploads");
    this.manifestPath = path.join(this.directory, "manifest.json");
    this.manifest = { version: 1, uploads: {} };
    this.operationQueue = Promise.resolve();
  }

  async init() {
    await mkdir(this.directory, { recursive: true });
    try {
      this.manifest = JSON.parse(await readFile(this.manifestPath, "utf8"));
      this.manifest.uploads ??= {};
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Could not read upload manifest: ${error.message}`);
      }
      await this.persist();
    }
  }

  async save(files) {
    return this.enqueue(() => this.saveInternal(files));
  }

  async saveInternal(files) {
    if (!Array.isArray(files) || files.length === 0) {
      throw new Error("Choose at least one file.");
    }
    if (files.length > MAX_FILES) {
      throw new Error(`Upload no more than ${MAX_FILES} files at once.`);
    }

    const decoded = files.map((file) => {
      const name = safeName(file.name);
      const type = safeMimeType(file.type);
      const data = Buffer.from(String(file.data || ""), "base64");
      if (!data.length && Number(file.size) > 0) {
        throw new Error(`${name} could not be decoded.`);
      }
      if (data.length > MAX_FILE_BYTES) {
        throw new Error(`${name} exceeds the ${MAX_FILE_BYTES / 1024 / 1024} MB limit.`);
      }
      return { name, type, data };
    });

    const totalBytes = decoded.reduce((total, file) => total + file.data.length, 0);
    if (totalBytes > MAX_TOTAL_BYTES) {
      throw new Error(
        `The combined upload exceeds the ${MAX_TOTAL_BYTES / 1024 / 1024} MB limit.`,
      );
    }

    const nextManifest = structuredClone(this.manifest);
    const stored = [];
    const createdPaths = [];
    try {
      for (const file of decoded) {
        const id = crypto.randomUUID();
        const filePath = path.join(this.directory, `${id}-${file.name}`);
        await writeFile(filePath, file.data, { mode: 0o600 });
        createdPaths.push(filePath);
        const metadata = {
          id,
          name: file.name,
          type: file.type,
          size: file.data.length,
          path: filePath,
          sessionIds: [],
          createdAt: new Date().toISOString(),
        };
        nextManifest.uploads[id] = metadata;
        stored.push(this.publicMetadata(metadata));
      }
      await this.persist(nextManifest);
      this.manifest = nextManifest;
    } catch (error) {
      await Promise.all(
        createdPaths.map((filePath) => unlink(filePath).catch(() => {})),
      );
      throw error;
    }
    return stored;
  }

  get(uploadId) {
    return this.manifest.uploads[uploadId] ?? null;
  }

  getMany(uploadIds) {
    return uploadIds.map((uploadId) => this.get(uploadId)).filter(Boolean);
  }

  async markAttached(uploadIds, sessionId) {
    await this.enqueue(async () => {
      const nextManifest = structuredClone(this.manifest);
      for (const uploadId of uploadIds) {
        const upload = nextManifest.uploads[uploadId];
        if (!upload) {
          continue;
        }
        upload.sessionIds = [...new Set([...(upload.sessionIds || []), sessionId])];
      }
      await this.persist(nextManifest);
      this.manifest = nextManifest;
    });
  }

  async delete(uploadId, { force = false } = {}) {
    return this.enqueue(async () => {
      const upload = this.manifest.uploads[uploadId];
      if (!upload || (!force && (upload.sessionIds || []).length > 0)) {
        return false;
      }
      const nextManifest = structuredClone(this.manifest);
      delete nextManifest.uploads[uploadId];
      await this.persist(nextManifest);
      this.manifest = nextManifest;
      await unlink(upload.path).catch((error) => {
        if (error.code !== "ENOENT") {
          throw error;
        }
      });
      return true;
    });
  }

  async deleteForSession(sessionId) {
    await this.enqueue(async () => {
      const nextManifest = structuredClone(this.manifest);
      const pathsToDelete = [];
      for (const [uploadId, upload] of Object.entries(nextManifest.uploads)) {
        const sessionIds = upload.sessionIds || [];
        if (!sessionIds.includes(sessionId)) {
          continue;
        }
        upload.sessionIds = sessionIds.filter((id) => id !== sessionId);
        if (upload.sessionIds.length === 0) {
          pathsToDelete.push(upload.path);
          delete nextManifest.uploads[uploadId];
        }
      }
      await this.persist(nextManifest);
      this.manifest = nextManifest;
      await Promise.all(
        pathsToDelete.map((filePath) =>
          unlink(filePath).catch((error) => {
            if (error.code !== "ENOENT") {
              throw error;
            }
          }),
        ),
      );
    });
  }

  async prunePending(maximumAgeMs = 24 * 60 * 60 * 1000) {
    const cutoff = Date.now() - maximumAgeMs;
    await this.enqueue(async () => {
      const nextManifest = structuredClone(this.manifest);
      const pathsToDelete = [];
      for (const [uploadId, upload] of Object.entries(nextManifest.uploads)) {
        const isPending = (upload.sessionIds || []).length === 0;
        if (isPending && new Date(upload.createdAt).getTime() < cutoff) {
          pathsToDelete.push(upload.path);
          delete nextManifest.uploads[uploadId];
        }
      }
      if (pathsToDelete.length === 0) {
        return;
      }
      await this.persist(nextManifest);
      this.manifest = nextManifest;
      await Promise.all(pathsToDelete.map((filePath) => unlink(filePath).catch(() => {})));
    });
  }

  /**
   * Turns pending uploads into Claude content blocks. Images and PDFs ride
   * along as native blocks; text is inlined so Claude sees it without a Read
   * round-trip; anything else is named by path for Claude to open on demand.
   */
  async toContentBlocks(uploadIds) {
    const blocks = [];
    for (const uploadId of uploadIds) {
      const upload = this.get(uploadId);
      if (!upload) {
        throw new Error(`Attachment ${uploadId} is no longer available.`);
      }

      const kind = attachmentKind(upload);
      if (kind === "image") {
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: upload.type,
            data: (await readFile(upload.path)).toString("base64"),
          },
        });
        continue;
      }

      if (kind === "document") {
        blocks.push({
          type: "document",
          title: upload.name,
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: (await readFile(upload.path)).toString("base64"),
          },
        });
        continue;
      }

      if (kind === "text") {
        const text = await readFile(upload.path, "utf8");
        blocks.push({
          type: "text",
          text: `Attached file: ${upload.name}\n\n\`\`\`\n${text}\n\`\`\``,
        });
        continue;
      }

      blocks.push({
        type: "text",
        text: `Attached file: ${upload.name} (${upload.type}, ${upload.size} bytes) saved at ${upload.path}`,
      });
    }
    return blocks;
  }

  publicMetadata(upload) {
    return {
      id: upload.id,
      name: upload.name,
      type: upload.type,
      size: upload.size,
      kind: attachmentKind(upload),
      createdAt: upload.createdAt,
    };
  }

  enqueue(operation) {
    const queued = this.operationQueue.then(operation);
    this.operationQueue = queued.catch(() => {});
    return queued;
  }

  async persist(snapshot = this.manifest) {
    const temporaryPath = `${this.manifestPath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.manifestPath);
  }
}
