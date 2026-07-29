/**
 * Launching Studio while it is already open must not open another window.
 *
 * It used to, every time — so double-clicking the launcher twice, or a script
 * running it repeatedly, left a taskbar full of Studios where only the newest
 * was connected to anything and the rest were dead pages.
 *
 * The distinction that matters is "running with a window on screen" versus
 * "running with nothing on screen", which is what /api/ping's `windows` count
 * answers.
 *
 * Run with: node scripts/e2e-duplicate-windows.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 4186;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), "studio-e2e-dup");

fs.rmSync(DATA, { recursive: true, force: true });

let failed = false;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const env = {
  ...process.env,
  CLAUDE_STUDIO_PORT: String(PORT),
  CLAUDE_STUDIO_DATA_DIR: DATA,
  // Never actually open a browser during the test — what is asserted is what
  // the launcher decides, not what a browser does with it.
  CLAUDE_STUDIO_OPEN: "0",
  CLAUDE_STUDIO_ON_CONFLICT: "fail",
};

const runLauncher = () =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(ROOT, "start.mjs")], {
      env,
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("exit", (code) => resolve({ code, out }));
  });

const lastLine = (out) => out.trim().split("\n").filter(Boolean).pop() || "";

let browser;
try {
  const first = await runLauncher();
  check("the first launch starts it", /is running at/.test(first.out), lastLine(first.out));

  // Running, but nothing on screen: a second launch should put a window up.
  const headless = await runLauncher();
  check(
    "with no window open, launching opens one",
    /Opened the Studio that was already running/.test(headless.out),
    lastLine(headless.out),
  );

  browser = await chromium.launch();
  const context = await browser.newContext();
  const runtime = JSON.parse(fs.readFileSync(path.join(DATA, "runtime.json"), "utf8"));
  const href = new URL("/", runtime.origin);
  href.searchParams.set("launch", runtime.launchToken);
  const page = await context.newPage();
  await page.goto(href.href, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll("#modeSelect option").length > 0,
    { timeout: 20000 },
  );
  await wait(1000);

  const ping = await (await fetch(`${BASE}/api/ping`)).json();
  check("ping reports the connected window", ping.windows === 1, JSON.stringify(ping));

  const again = await runLauncher();
  check(
    "launching again does not open a duplicate",
    /already open/i.test(again.out) && !/Opened the Studio/.test(again.out),
    lastLine(again.out),
  );

  await fetch(`${BASE}/api/shutdown`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${runtime.launchToken}`,
      "Content-Type": "application/json",
      "Origin": BASE,
    },
    body: "{}",
  }).catch(() => {});

  console.log(`\n${failed ? "DUPLICATE-WINDOW FAILED" : "DUPLICATE-WINDOW PASSED"}`);
} catch (error) {
  console.error("ERROR:", error.stack || error.message);
  failed = true;
} finally {
  await browser?.close().catch(() => {});
  await wait(900);
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
