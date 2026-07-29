import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Everything needed to work out who holds Studio's port, and what to do about
 * it — shared by `start.mjs` (which asks before it detaches a server) and
 * `server.mjs` (which still handles the race where the port goes busy between
 * the check and the bind).
 *
 * It lives here because the two entry points must classify the holder the same
 * way. The rule that matters is in `probePortHolder`: only a positively
 * identified Studio may ever be stopped. A `foreign` holder is named and routed
 * around, because killing a guess could take out a database or a dev server.
 */

/**
 * Asks whatever holds the port what it is.
 *
 * `current` — this build, which answers /api/ping.
 * `legacy`  — an older Studio: /api/ping predates it, so the request falls
 *             through to the auth gate and 401s with Studio's own wording.
 *             Worth recognising, because upgrading is exactly when someone
 *             double-clicks the launcher while the old one is still up.
 * `foreign` — HTTP, but not us. Never killed automatically.
 * `free`    — nothing answered at all.
 */
/** How many Studio windows are connected right now, or 0 if it cannot be asked. */
export async function countOpenWindows(origin) {
  try {
    const response = await fetch(new URL("/api/ping", origin), {
      signal: AbortSignal.timeout(2500),
    });
    const body = await response.json().catch(() => null);
    return Number.isInteger(body?.windows) ? body.windows : 0;
  } catch {
    return 0;
  }
}

export async function probePortHolder(origin) {
  let response;
  try {
    response = await fetch(new URL("/api/ping", origin), {
      signal: AbortSignal.timeout(2500),
    });
  } catch {
    return "foreign";
  }
  const body = await response.json().catch(() => null);
  if (body?.app === "claude-cli-studio") {
    return "current";
  }
  if (response.status === 401 && /Studio authentication/i.test(body?.error || "")) {
    return "legacy";
  }
  return "foreign";
}

/**
 * The pid listening on `port`, plus a human name for it.
 *
 * Only used to tell the user what they would be stopping, and to stop it once
 * they say so. A `legacy` Studio predates runtime.json, so asking the OS is the
 * only way to name it.
 */
export async function findPortOwner(port) {
  try {
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], {
        timeout: 8000,
        windowsHide: true,
      });
      const line = stdout
        .split(/\r?\n/)
        .find((row) => /LISTENING/i.test(row) && new RegExp(`[:.]${port}\\s`).test(row));
      const pid = Number(line?.trim().split(/\s+/).pop());
      if (!Number.isInteger(pid) || pid <= 0) {
        return null;
      }
      const { stdout: task } = await execFileAsync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { timeout: 8000, windowsHide: true },
      );
      return { pid, name: task.split(",")[0]?.replace(/"/g, "").trim() || "unknown" };
    }
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"],
      { timeout: 8000 },
    );
    const pid = Number(stdout.trim().split(/\s+/)[0]);
    if (!Number.isInteger(pid) || pid <= 0) {
      return null;
    }
    const { stdout: name } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], {
      timeout: 8000,
    });
    return { pid, name: name.trim() || "unknown" };
  } catch {
    return null;
  }
}

/** Reads the running server's record, or null when there isn't a usable one. */
export async function readRuntimeRecord(runtimeFile, port) {
  let record;
  try {
    record = JSON.parse(await readFile(runtimeFile, "utf8"));
  } catch {
    return null;
  }
  if (!record || record.port !== port || typeof record.launchToken !== "string") {
    return null;
  }
  return record;
}

/** The launch URL of the running Studio, when it left a readable record. */
export async function runningStudioLaunchHref(runtimeFile, port, origin) {
  const record = await readRuntimeRecord(runtimeFile, port);
  if (!record) {
    return null;
  }
  const href = new URL("/", String(record.origin || origin));
  href.searchParams.set("launch", record.launchToken);
  return href.href;
}

/**
 * Asks a running Studio to shut itself down, over HTTP, authenticating with the
 * launch token it published.
 *
 * This is tried before any signal. A detached server owns `claude` runners that
 * a hard kill would orphan — the old console-window teardown used to clean
 * those up for free, and once Studio survives its launcher window, nothing else
 * will.
 */
export async function requestStudioShutdown(runtimeFile, port, origin) {
  const record = await readRuntimeRecord(runtimeFile, port);
  if (!record) {
    return false;
  }
  try {
    const response = await fetch(new URL("/api/shutdown", record.origin || origin), {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${record.launchToken}`,
        "Content-Type": "application/json",
        "Origin": String(record.origin || origin),
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

/** True once nothing answers on the port any more. */
export async function waitForPortFree(port, host, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const free = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(port, host, () => probe.close(() => resolve(true)));
    });
    if (free) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Stops a process and waits for it to actually go away. */
export async function stopProcessAndWait(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error.code === "ESRCH") {
      return true;
    }
    if (error.code === "EPERM") {
      return false;
    }
  }
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    // Node on Windows treats SIGTERM as a hard kill, so one signal is enough
    // there; on POSIX a wedged process may need the stronger one.
    if (attempt === 12 && process.platform !== "win32") {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  }
  return false;
}

/**
 * Stops a running Studio the gentle way first.
 *
 * Asking over HTTP lets it dispose its `claude` runners and clean up its launch
 * files; the signal is the fallback for a server too wedged to answer.
 */
export async function stopRunningStudio({ runtimeFile, port, host, origin, pid }) {
  if (await requestStudioShutdown(runtimeFile, port, origin)) {
    if (await waitForPortFree(port, host)) {
      return true;
    }
  }
  if (!pid) {
    return false;
  }
  if (!(await stopProcessAndWait(pid))) {
    return false;
  }
  return waitForPortFree(port, host);
}

/** The first free port at or after `from`, so a clash needs no env var. */
export async function findFreePort(from, host) {
  for (let candidate = from; candidate < from + 25; candidate += 1) {
    const free = await new Promise((resolve) => {
      const probe = http.createServer();
      probe.once("error", () => resolve(false));
      probe.listen(candidate, host, () => probe.close(() => resolve(true)));
    });
    if (free) {
      return candidate;
    }
  }
  return null;
}

/**
 * Asks the person who double-clicked the launcher what to do. Returns null when
 * nobody is there to answer — a service, a CI run, an editor's task runner — so
 * an unattended start never blocks on a prompt.
 */
export async function askChoice(question, choices) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return null;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`\n${question}\n`);
    for (const choice of choices) {
      console.log(
        `  [${choice.key.toUpperCase()}] ${choice.label}${choice.default ? "  (press Enter)" : ""}`,
      );
    }
    const answer = (await rl.question("\nChoose: ")).trim().toLowerCase();
    if (!answer) {
      return choices.find((choice) => choice.default)?.key ?? null;
    }
    return choices.find((choice) => choice.key === answer)?.key ?? null;
  } catch {
    return null;
  } finally {
    rl.close();
  }
}
