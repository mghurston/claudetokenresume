/**
 * What `npm start` runs, and therefore what the double-click launcher runs.
 *
 * Its whole job is that closing the launcher window must not stop Studio.
 * Previously `npm start` *was* the server: it ran in the console the launcher
 * opened, so closing that window killed it mid-conversation. Now this script
 * resolves any port conflict here — in the console, where a prompt still works
 * and a person is still watching — then spawns `server.mjs` detached, waits for
 * it to answer, prints where it is, and exits.
 *
 * Detached means no console on Windows (`detached` + `windowsHide` + no
 * inherited stdio), so the close event that used to kill it never reaches it.
 * Its output goes to a log file instead, because nobody will be watching a
 * console that no longer exists.
 *
 * Because closing the window no longer stops Studio, two ways to stop it on
 * purpose exist: the Quit button in the sidebar, and the "Stop it" choice this
 * script offers when you launch it while one is already running.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, open, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  askChoice,
  findFreePort,
  findPortOwner,
  probePortHolder,
  runningStudioLaunchHref,
  stopRunningStudio,
} from "./src/port-guard.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, "server.mjs");
const HOST = process.env.CLAUDE_STUDIO_HOST || "127.0.0.1";
const PORT = Number(process.env.CLAUDE_STUDIO_PORT || 4174);
const ORIGIN = `http://${HOST}:${PORT}`;
// Must be the same variable server.mjs reads, or this script writes its log
// beside a runtime.json the server never wrote and every launch looks like a
// first launch.
const DATA_DIRECTORY = path.resolve(
  process.env.CLAUDE_STUDIO_DATA_DIR || path.join(os.homedir(), ".claude-cli-studio"),
);
const RUNTIME_FILE = path.join(DATA_DIRECTORY, "runtime.json");
const LOG_FILE = path.join(DATA_DIRECTORY, "studio.log");
const PRESET = (process.env.CLAUDE_STUDIO_ON_CONFLICT || "").trim().toLowerCase();

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Browsers that can host a page as a plain application window.
 *
 * `--app=<url>` opens the page in its own window with no tabs, no address bar
 * and its own taskbar entry — a Windows window, like the desktop watch, rather
 * than one tab among thirty. Nothing is installed for this: it is a flag on a
 * browser the machine already has.
 */
function appWindowCandidates() {
  const programFiles = [
    process.env["ProgramFiles(x86)"],
    process.env.ProgramFiles,
    process.env.LOCALAPPDATA,
  ].filter(Boolean);

  if (process.platform === "win32") {
    const relative = [
      "Microsoft/Edge/Application/msedge.exe",
      "Google/Chrome/Application/chrome.exe",
      "BraveSoftware/Brave-Browser/Application/brave.exe",
    ];
    return programFiles.flatMap((root) =>
      relative.map((tail) => path.join(root, tail.replaceAll("/", path.sep))),
    );
  }
  if (process.platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }
  return ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/microsoft-edge"];
}

/**
 * Opens Studio as its own window, falling back to an ordinary browser tab.
 *
 * The fallback is not optional: a machine with no Chromium-based browser must
 * still be able to open Studio, and `--app` silently produces nothing when the
 * binary is missing.
 */
function openStudioWindow(url) {
  if (process.env.CLAUDE_STUDIO_OPEN === "0") {
    return "suppressed";
  }

  if (process.env.CLAUDE_STUDIO_WINDOW !== "tab") {
    const browser = appWindowCandidates().find((candidate) => existsSync(candidate));
    if (browser) {
      const child = spawn(browser, [`--app=${url}`, "--window-size=1360,940"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.on("error", () => {});
      child.unref();
      return "window";
    }
  }

  const command =
    process.platform === "darwin"
      ? { file: "open", args: [url] }
      : process.platform === "win32"
        ? { file: "cmd", args: ["/c", "start", "", url.replace(/&/g, "^&")] }
        : { file: "xdg-open", args: [url] };
  spawn(command.file, command.args, { detached: true, stdio: "ignore", windowsHide: true })
    .on("error", () => {})
    .unref();
  return "tab";
}

const openBrowser = openStudioWindow;

/** True once the server on `port` answers its unauthenticated ping. */
async function waitForStudio(origin, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/api/ping", origin), {
        signal: AbortSignal.timeout(2000),
      });
      const body = await response.json().catch(() => null);
      if (body?.app === "claude-cli-studio") {
        return true;
      }
    } catch {
      /* not up yet */
    }
    await wait(400);
  }
  return false;
}

async function tailLog(lines = 12) {
  try {
    const text = await readFile(LOG_FILE, "utf8");
    return text.trim().split(/\r?\n/).slice(-lines).join("\n");
  } catch {
    return "";
  }
}

/**
 * Starts the server as a process that outlives this one.
 *
 * The launch nonce is generated here and handed down, so this script can open
 * the browser itself once the server is answering — the server can no longer be
 * relied on to do it, since with `CLAUDE_STUDIO_DETACHED=1` it has no console to
 * report a failure to either.
 */
async function startDetached(port) {
  await mkdir(DATA_DIRECTORY, { recursive: true, mode: 0o700 });
  const log = await open(LOG_FILE, "a");
  const child = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", SERVER], {
    env: {
      ...process.env,
      CLAUDE_STUDIO_PORT: String(port),
      CLAUDE_STUDIO_DETACHED: "1",
      // This script opens the browser once the server is confirmed up.
      CLAUDE_STUDIO_OPEN: "0",
    },
    detached: true,
    windowsHide: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  child.on("error", () => {});
  child.unref();
  await log.close();
  return child.pid;
}

/** Where to send the browser: the nonce URL the running server published. */
async function launchHrefFor(port, origin) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const href = await runningStudioLaunchHref(RUNTIME_FILE, port, origin);
    if (href) {
      return href;
    }
    await wait(200);
  }
  return null;
}

async function launch(port) {
  const origin = `http://${HOST}:${port}`;
  console.log(`Starting Claude CLI Studio on port ${port}…`);
  const pid = await startDetached(port);
  if (!(await waitForStudio(origin))) {
    console.error("\nStudio did not start. The last lines of its log:\n");
    console.error((await tailLog()) || `  (nothing was written to ${LOG_FILE})`);
    console.error(`\nFull log: ${LOG_FILE}`);
    process.exit(1);
  }

  const href = (await launchHrefFor(port, origin)) || origin;
  const opened = openStudioWindow(href);

  console.log("");
  if (opened === "tab") {
    console.log("  Opened in your browser (no Chrome or Edge found for an app window).");
  }
  console.log(`  Claude CLI Studio is running at ${origin}`);
  console.log(`  It keeps running after you close this window (pid ${pid}).`);
  console.log("");
  console.log("  Closing the Studio window stops it. If Claude is mid-answer");
  console.log("  your browser asks first. Messages parked for a usage reset");
  console.log("  keep it running. You can also press Quit in the sidebar.");
  console.log("");
  console.log(`  Log: ${LOG_FILE}`);
  console.log("");
  process.exit(0);
}

/**
 * Decides what a second launch should do about the port being busy.
 *
 * Stopping is only ever offered for something positively identified as Studio,
 * and never by default. An unrecognised holder is named and routed around with
 * a free port — killing a guess could take out a database or a dev server.
 */
async function main() {
  if (!existsSync(SERVER)) {
    console.error(`Could not find server.mjs next to this script (${SERVER}).`);
    process.exit(1);
  }

  const holder = await probePortHolder(ORIGIN);
  const free = holder === "foreign" ? await findFreePort(PORT, HOST) : null;
  const portIsFree = holder === "foreign" && free === PORT;

  if (portIsFree) {
    await launch(PORT);
    return;
  }

  if (holder === "current" || holder === "legacy") {
    const owner = await findPortOwner(PORT);
    const href = await runningStudioLaunchHref(RUNTIME_FILE, PORT, ORIGIN);
    console.log(
      `\nClaude CLI Studio is already running on port ${PORT}` +
        (owner ? ` (${owner.name}, pid ${owner.pid}).` : ".") +
        (holder === "legacy" ? "\nIt is an older version than this one." : ""),
    );

    const choices = [];
    if (href) {
      choices.push({ key: "o", label: "Open it", default: holder === "current" });
    }
    choices.push({
      key: "s",
      label: "Stop it",
      default: false,
    });
    choices.push({
      key: "r",
      label: "Stop it and start this version instead",
      default: !href,
    });
    choices.push({ key: "q", label: "Leave it running and close this window" });

    const preset = { open: "o", stop: "s", restart: "r", quit: "q" }[PRESET];
    const choice = preset || (await askChoice("What would you like to do?", choices));

    if (choice === "o" && href) {
      console.log("Opening it in your browser.");
      openBrowser(href);
      process.exit(0);
    }
    if (choice === "s" || choice === "r") {
      console.log("Stopping the running Studio…");
      const stopped = await stopRunningStudio({
        runtimeFile: RUNTIME_FILE,
        port: PORT,
        host: HOST,
        origin: ORIGIN,
        pid: owner?.pid,
      });
      if (!stopped) {
        console.error("It would not stop. Its log may say why:");
        console.error(`  ${LOG_FILE}`);
        process.exit(1);
      }
      console.log("Stopped.");
      if (choice === "s") {
        process.exit(0);
      }
      await launch(PORT);
      return;
    }
    if (choice === "q") {
      console.log("Left it running.");
      process.exit(0);
    }

    // Nobody was there to answer. Opening what is already up is the harmless
    // reading of "start Studio", and it is what the old launcher did.
    if (href) {
      openBrowser(href);
      console.log("Opened the Studio that was already running.");
      process.exit(0);
    }
    console.error(`Port ${PORT} is held by Studio, but it could not be opened.`);
    process.exit(1);
  }

  const owner = await findPortOwner(PORT);
  console.log(
    `\nPort ${PORT} is being used by another program` +
      (owner ? ` (${owner.name}, pid ${owner.pid}).` : "."),
  );
  console.log("That is not Claude Studio, so it will be left alone.");

  const preset = { port: "p", fail: "q" }[PRESET];
  const choice =
    preset ||
    (await askChoice("What would you like to do?", [
      ...(free ? [{ key: "p", label: `Start Studio on port ${free} instead`, default: true }] : []),
      { key: "q", label: "Quit" },
    ]));

  if (choice === "p" && free) {
    await launch(free);
    return;
  }
  console.error(
    free
      ? `Set CLAUDE_STUDIO_PORT=${free} to use a free port.`
      : "Set CLAUDE_STUDIO_PORT to a free port and try again.",
  );
  process.exit(1);
}

main().catch((error) => {
  console.error(`Studio could not start: ${error.message}`);
  process.exit(1);
});
