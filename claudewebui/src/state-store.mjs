import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Studio's own organization layer: which folders to look in, which projects to
 * pin, and manual session-to-project moves.
 *
 * Session titles and deletions are deliberately NOT stored here — those go
 * through the Agent SDK so they apply to the real transcript and show up in
 * `claude --resume` too.
 */
function createDefaultState(workspaceRoot) {
  return {
    version: 1,
    projects: [
      {
        id: "general",
        name: "General",
        path: workspaceRoot,
        pinned: true,
        keywords: [],
      },
    ],
    scanRoots: [workspaceRoot],
    sessionProjectOverrides: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export class StateStore {
  constructor(filePath, workspaceRoot) {
    this.filePath = filePath;
    this.workspaceRoot = workspaceRoot;
    this.state = createDefaultState(workspaceRoot);
    this.updateQueue = Promise.resolve();
    // True when init() had to create the file — the caller uses this to seed
    // first-run scan roots without overriding choices made on later runs.
    this.isFirstRun = false;
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });

    try {
      const stored = JSON.parse(await readFile(this.filePath, "utf8"));
      const defaults = createDefaultState(this.workspaceRoot);
      const configuredProjects = Array.isArray(stored.projects) ? stored.projects : [];
      const projectIds = new Set(configuredProjects.map((project) => project.id));
      for (const project of defaults.projects) {
        if (!projectIds.has(project.id)) {
          configuredProjects.push(project);
        }
      }

      this.state = {
        ...defaults,
        ...stored,
        version: defaults.version,
        projects: configuredProjects,
        scanRoots: [
          ...new Set(
            [
              this.workspaceRoot,
              ...(Array.isArray(stored.scanRoots) ? stored.scanRoots : []),
            ].map((scanRoot) => path.resolve(scanRoot)),
          ),
        ],
        sessionProjectOverrides: stored.sessionProjectOverrides ?? {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw new Error(`Could not read Studio state: ${error.message}`);
      }
      this.isFirstRun = true;
      await this.persist();
    }
  }

  /**
   * First-run convenience: if Claude Code sessions already exist on drives the
   * home directory does not cover (a dedicated projects drive, say), adopt
   * those drive roots so the sidebar groups by project instead of dumping
   * every session into General. Only drives the user has already run Claude in
   * are considered, and only on the very first launch.
   */
  async seedScanRootsFromSessions(sessionDirectories) {
    if (!this.isFirstRun) {
      return [];
    }
    const homeRoot = path.parse(this.workspaceRoot).root;
    const candidates = new Set();
    for (const directory of sessionDirectories) {
      if (!directory) {
        continue;
      }
      const root = path.parse(path.resolve(directory)).root;
      if (root && root !== homeRoot) {
        candidates.add(root);
      }
    }
    for (const root of candidates) {
      await this.registerScanRoot(root);
    }
    return [...candidates];
  }

  snapshot() {
    return structuredClone(this.state);
  }

  async update(mutator) {
    const operation = this.updateQueue.then(async () => {
      const next = structuredClone(this.state);
      mutator(next);
      next.updatedAt = new Date().toISOString();
      await this.persist(next);
      this.state = next;
      return this.snapshot();
    });
    this.updateQueue = operation.catch(() => {});
    return operation;
  }

  async persist(snapshot = this.state) {
    const temporaryPath = `${this.filePath}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporaryPath, this.filePath);
  }

  async setSessionProject(sessionId, projectId) {
    await this.update((state) => {
      state.sessionProjectOverrides[sessionId] = projectId;
    });
  }

  async addProject(project) {
    await this.update((state) => {
      const normalizedProjectPath = path.resolve(project.path);
      const conflicts = state.projects.some(
        (item) =>
          item.id === project.id ||
          (item.path && path.resolve(item.path) === normalizedProjectPath),
      );
      if (conflicts) {
        throw new Error("That project name or folder is already configured.");
      }
      state.projects.push(project);
    });
  }

  async registerScanRoot(scanRoot, project = null) {
    await this.update((state) => {
      state.scanRoots = [
        ...new Set([...(state.scanRoots || []), path.resolve(scanRoot)]),
      ];
      if (!project) {
        return;
      }
      const existingIndex = state.projects.findIndex((item) => item.id === project.id);
      if (existingIndex >= 0) {
        state.projects[existingIndex] = project;
        return;
      }
      const normalizedProjectPath = path.resolve(project.path);
      const existingPathIndex = state.projects.findIndex(
        (item) => item.path && path.resolve(item.path) === normalizedProjectPath,
      );
      if (existingPathIndex < 0) {
        state.projects.push(project);
      }
    });
  }

  async forgetSession(sessionId) {
    await this.update((state) => {
      delete state.sessionProjectOverrides[sessionId];
    });
  }
}
