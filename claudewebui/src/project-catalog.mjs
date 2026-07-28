import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);
const UMBRELLA_DIRECTORIES = new Set([
  "Desktop",
  "Documents",
  "Projects",
  "Code",
  "src",
  "repos",
  "source",
  "dev",
]);
const IGNORED_DIRECTORIES = new Set([
  "AppData",
  "Applications",
  "Downloads",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Public",
  "Windows",
  ".cache",
  ".claude",
  ".git",
  ".vscode",
]);
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "Makefile",
  "CLAUDE.md",
];

function normalize(candidate) {
  return path.resolve(candidate);
}

export function isWithin(root, candidate) {
  const relative = path.relative(normalize(root), normalize(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function autoProjectId(projectPath) {
  const base = path.basename(projectPath).toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const digest = createHash("sha1").update(projectPath).digest("hex").slice(0, 8);
  return `auto-${base || "project"}-${digest}`;
}

function titleCase(value) {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
    .replace(/\bUi\b/g, "UI")
    .replace(/\bApi\b/g, "API")
    .replace(/\bCli\b/g, "CLI");
}

function candidateProjectPath(workspaceRoot, candidatePath) {
  if (!candidatePath || !isWithin(workspaceRoot, candidatePath)) {
    return null;
  }

  const relative = path.relative(workspaceRoot, candidatePath);
  if (!relative) {
    return workspaceRoot;
  }

  const segments = relative.split(path.sep).filter(Boolean);
  if (!segments.length || segments[0].startsWith(".") || IGNORED_DIRECTORIES.has(segments[0])) {
    return null;
  }

  const projectSegments =
    UMBRELLA_DIRECTORIES.has(segments[0]) && segments.length > 1
      ? segments.slice(0, 2)
      : segments.slice(0, 1);
  return path.join(workspaceRoot, ...projectSegments);
}

async function directoryExists(directory) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function looksLikeProjectDirectory(directory) {
  for (const marker of PROJECT_MARKERS) {
    try {
      await stat(path.join(directory, marker));
      return true;
    } catch {
      // Try the next common project marker.
    }
  }
  return false;
}

export function githubUrl(remote) {
  const trimmed = remote.trim().replace(/\.git$/, "");
  const sshMatch = trimmed.match(/^git@([^:]+):(.+)$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }
  if (/^ssh:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      return `https://${parsed.hostname}${parsed.pathname}`;
    } catch {
      return null;
    }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      parsed.username = "";
      parsed.password = "";
      parsed.search = "";
      parsed.hash = "";
      return parsed.href.replace(/\/$/, "");
    } catch {
      return null;
    }
  }
  return null;
}

export class ProjectCatalog {
  constructor(workspaceRoot) {
    this.workspaceRoot = normalize(workspaceRoot);
    this.repoUrlCache = new Map();
  }

  /**
   * Groups Claude Code sessions under the project folders they ran in.
   * Discovery is bounded by the configured scan roots — a session whose cwd
   * lives outside every root lands in General rather than creating a project
   * folder for, say, a drive root or a system directory.
   */
  async build(sessionRows, state) {
    const scanRoots = [
      ...new Set(
        [this.workspaceRoot, ...(Array.isArray(state.scanRoots) ? state.scanRoots : [])].map(
          normalize,
        ),
      ),
    ].sort((left, right) => right.length - left.length);

    const configured = state.projects
      .filter(
        (project) =>
          project.path && scanRoots.some((scanRoot) => isWithin(scanRoot, project.path)),
      )
      .map((project, index) => ({
        ...project,
        path: normalize(project.path),
        configured: true,
        order: index,
      }));

    const byPath = new Map(configured.map((project) => [project.path, project]));
    const discoveredPaths = new Set();

    for (const session of sessionRows) {
      for (const scanRoot of scanRoots) {
        const candidate = candidateProjectPath(scanRoot, session.cwd);
        if (candidate && candidate !== scanRoot) {
          discoveredPaths.add(candidate);
        }
      }
    }

    for (const projectPath of discoveredPaths) {
      if (byPath.has(projectPath) || !(await directoryExists(projectPath))) {
        continue;
      }
      const configuredOwner = configured
        .filter(
          (project) => project.id !== "general" && isWithin(project.path, projectPath),
        )
        .sort((left, right) => right.path.length - left.path.length)[0];
      if (
        configuredOwner &&
        configuredOwner.path !== projectPath &&
        !(await looksLikeProjectDirectory(projectPath))
      ) {
        continue;
      }
      const project = {
        id: autoProjectId(projectPath),
        name: titleCase(path.basename(projectPath)),
        path: projectPath,
        pinned: false,
        keywords: [],
        configured: false,
        order: Number.MAX_SAFE_INTEGER,
      };
      configured.push(project);
      byPath.set(projectPath, project);
    }

    const projects = await Promise.all(
      configured.map(async (project) => ({
        ...project,
        repoUrl: await this.repoUrl(project.path),
        sessions: [],
      })),
    );

    const projectMap = new Map(projects.map((project) => [project.id, project]));

    for (const session of sessionRows) {
      if ((state.hiddenSessionIds || []).includes(session.id)) {
        continue;
      }
      const projectId = this.assignProject(
        session,
        projects,
        state.sessionProjectOverrides,
      );
      const project = projectMap.get(projectId) ?? projectMap.get("general") ?? projects[0];
      if (!project) {
        continue;
      }

      project.sessions.push({ ...session, projectId: project.id });
    }

    for (const project of projects) {
      project.sessions.sort(
        (left, right) =>
          new Date(right.updatedAt).getTime() - new Date(left.updatedAt).getTime(),
      );
    }

    return projects
      .filter((project) => project.configured || project.sessions.length > 0)
      .sort((left, right) => {
        if (left.order !== right.order) {
          return left.order - right.order;
        }
        return left.name.localeCompare(right.name);
      });
  }

  async suggestProjectForScanRoot(scanRoot, sessionRows) {
    const normalizedRoot = normalize(scanRoot);
    if (normalizedRoot === this.workspaceRoot) {
      return null;
    }
    const hasDirectSession = sessionRows.some(
      (session) => session.cwd && normalize(session.cwd) === normalizedRoot,
    );
    if (!hasDirectSession && !(await looksLikeProjectDirectory(normalizedRoot))) {
      return null;
    }
    const basename = path.basename(normalizedRoot);
    return {
      id: autoProjectId(normalizedRoot),
      // A drive root has no basename to title-case ("G:\" -> ""), so name it
      // after the drive rather than showing a bare path in the sidebar.
      name: basename ? titleCase(basename) : `${normalizedRoot.replace(/[\\/]+$/, "")} drive`,
      path: normalizedRoot,
      pinned: true,
      keywords: [],
    };
  }

  assignProject(session, projects, overrides) {
    const override = overrides[session.id];
    if (override && projects.some((project) => project.id === override)) {
      return override;
    }

    const nonGeneral = projects.filter((project) => project.id !== "general");
    const cwdMatches = nonGeneral
      .filter((project) => session.cwd && isWithin(project.path, session.cwd))
      .sort((left, right) => right.path.length - left.path.length);
    if (cwdMatches.length) {
      return cwdMatches[0].id;
    }

    const keywordProjects = nonGeneral.filter((item) => item.keywords?.length);
    const haystack = `${session.title} ${session.preview}`.toLowerCase();
    const keywordMatches = keywordProjects.filter((project) =>
      project.keywords.some((keyword) => haystack.includes(keyword.toLowerCase())),
    );
    if (keywordMatches.length === 1) {
      return keywordMatches[0].id;
    }

    return projects.find((project) => project.id === "general")?.id ?? projects[0]?.id;
  }

  async repoUrl(projectPath) {
    if (this.repoUrlCache.has(projectPath)) {
      return this.repoUrlCache.get(projectPath);
    }

    let repoUrl = null;
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", projectPath, "remote", "get-url", "origin"],
        { timeout: 3000 },
      );
      repoUrl = githubUrl(stdout);
    } catch {
      repoUrl = null;
    }

    this.repoUrlCache.set(projectPath, repoUrl);
    return repoUrl;
  }
}

export function slugifyProjectId(name) {
  const slug = name.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || `project-${Date.now()}`;
}
