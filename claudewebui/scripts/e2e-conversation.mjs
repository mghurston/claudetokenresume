/**
 * The core loop, driven through the real UI: type a message, get an answer.
 *
 * Everything else is tested around this — permissions, queueing, closing — but
 * the thing the app is actually for had no coverage at all. Uses a real server,
 * a real browser and a real CLI, so it spends tokens; keep the prompts trivial.
 *
 * Run with: node scripts/e2e-conversation.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 4187;
const TOKEN = "e2e-conv-token-0000000000000000000000000";
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), "studio-e2e-conv");

fs.rmSync(DATA, { recursive: true, force: true });

let failed = false;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed = true;
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const server = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  env: {
    ...process.env,
    CLAUDE_STUDIO_PORT: String(PORT),
    CLAUDE_STUDIO_SESSION_TOKEN: TOKEN,
    CLAUDE_STUDIO_DATA_DIR: DATA,
    CLAUDE_STUDIO_OPEN: "0",
    CLAUDE_STUDIO_ON_CONFLICT: "fail",
  },
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`));

let browser;
try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${BASE}/api/ping`);
      break;
    } catch {
      await wait(500);
    }
  }

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.addInitScript((token) => {
    localStorage.setItem("claude-cli-studio-token", token);
    // Autopilot, so a tool prompt cannot stall the run.
    localStorage.setItem("claude-cli-studio-permission-mode", "bypassPermissions");
  }, TOKEN);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll("#modeSelect option").length > 0,
    { timeout: 20000 },
  );

  check(
    "the sidebar lists projects",
    (await page.locator("#sessionNav .project-group").count()) > 0,
    `${await page.locator("#sessionNav .project-group").count()} groups`,
  );
  check(
    "Autopilot was restored from storage",
    (await page.locator("#modeSelect").inputValue()) === "bypassPermissions",
  );

  // --- send a message and get an answer ------------------------------------
  const marker = `qa-${Date.now().toString(36)}`;
  await page.fill("#messageInput", `Reply with exactly this and nothing else: ${marker}`);
  await page.click("#sendButton");

  await page.waitForFunction(
    () => document.querySelectorAll(".message.user").length > 0,
    { timeout: 15000 },
  );
  check("the message appears immediately", true);

  await page.waitForFunction(
    (needle) => document.querySelector("#messages")?.innerText.includes(needle),
    marker,
    { timeout: 180000 },
  );
  const assistantText = await page.locator("#messages").innerText();
  check(
    "Claude answered, and the answer rendered",
    assistantText.includes(marker),
    marker,
  );

  await page.waitForFunction(
    () => !document.querySelector("#sendButton")?.disabled,
    { timeout: 60000 },
  );
  check("the composer is usable again once the turn ends", true);

  // The conversation must survive a reload — that is the whole promise of
  // sessions living in ~/.claude rather than in the page.
  //
  // Wait for the transcript to be readable first. Claude Code writes the jsonl
  // itself, a moment after the answer streams, and racing that would be testing
  // the CLI's flush timing rather than anything Studio promises.
  let sessionId = null;
  for (let attempt = 0; attempt < 20 && !sessionId; attempt += 1) {
    sessionId = await page.evaluate(() => {
      try {
        return JSON.parse(localStorage.getItem("claude-cli-studio-last-session") || "{}")
          .sessionId || null;
      } catch {
        return null;
      }
    });
    if (!sessionId) await wait(250);
  }
  check("the open conversation was remembered", Boolean(sessionId), sessionId || "(none)");
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const response = await fetch(`${BASE}/api/sessions/${sessionId}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    const body = await response.json().catch(() => ({}));
    if (response.ok && (body.messages || []).length > 0) {
      break;
    }
    await wait(500);
  }

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    (needle) => document.querySelector("#messages")?.innerText.includes(needle),
    marker,
    { timeout: 60000 },
  );
  check("the conversation is still there after a reload", true);

  const title = await page.locator("#conversationTitle").innerText().catch(() => "");
  check("the new session is titled, not left as 'New chat'", title.trim() !== "" && title !== "New chat", title);

  // --- follow-up in the same session ---------------------------------------
  const second = `qa2-${Date.now().toString(36)}`;
  await page.fill("#messageInput", `Reply with exactly this and nothing else: ${second}`);
  await page.click("#sendButton");
  await page.waitForFunction(
    (needle) => document.querySelector("#messages")?.innerText.includes(needle),
    second,
    { timeout: 180000 },
  );
  check("a follow-up lands in the same conversation", true);
  check(
    "the first answer is still on screen",
    (await page.locator("#messages").innerText()).includes(marker),
  );

  // --- the session shows up in the sidebar ---------------------------------
  await wait(1500);
  const sidebarText = await page.locator("#sessionNav").innerText();
  check("the conversation is listed in the sidebar", sidebarText.length > 0);

  // --- search --------------------------------------------------------------
  await page.fill("#sessionSearch", "zzz-no-such-session-zzz");
  await wait(400);
  const emptyCount = await page.locator("#sessionNav .session-item:visible").count();
  check("search filters the list down", emptyCount === 0, `${emptyCount} visible`);
  await page.fill("#sessionSearch", "");
  await wait(400);
  check(
    "clearing search brings the list back",
    (await page.locator("#sessionNav .session-item").count()) > 0,
  );

  const unexpected = errors.filter((text) => !/status of 40[03]/.test(text));
  check(
    `no unexpected console errors (${unexpected.length})`,
    unexpected.length === 0,
    unexpected.slice(0, 3).join(" | "),
  );

  console.log(`\n${failed ? "CONVERSATION FAILED" : "CONVERSATION PASSED"}`);
} catch (error) {
  console.error("ERROR:", error.stack || error.message);
  failed = true;
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await wait(600);
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
