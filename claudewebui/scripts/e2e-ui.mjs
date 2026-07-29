/**
 * Drives the real UI in a real browser.
 *
 * Covers the things that can only break in the browser: the permission
 * dropdown reaching the server and surviving a reload, the usage meter being
 * visible and openable, and Quit actually stopping the server. Everything here
 * failed silently before — a dropdown that repainted a caption, a meter that
 * hid itself, a window whose only stop button was its own title bar.
 *
 * Run with: node scripts/e2e-ui.mjs   (needs `npx playwright install chromium`)
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const PORT = 4182;
const TOKEN = "e2e-ui-token-00000000000000000000000000";
const BASE = `http://127.0.0.1:${PORT}`;
const DATA_DIR = path.join(os.tmpdir(), "studio-e2e-ui");

fs.rmSync(DATA_DIR, { recursive: true, force: true });

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
    CLAUDE_STUDIO_DATA_DIR: DATA_DIR,
    CLAUDE_STUDIO_OPEN: "0",
    CLAUDE_STUDIO_ON_CONFLICT: "fail",
  },
  cwd: ROOT,
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
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
  const page = await browser.newPage();
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(String(error)));

  // Sign in the way the launcher page does: hand the token to localStorage.
  await page.addInitScript((token) => {
    localStorage.setItem("claude-cli-studio-token", token);
  }, TOKEN);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll("#modeSelect option").length > 0,
    { timeout: 20000 },
  );

  check(
    "the app loaded without the sign-in card",
    await page.locator("#signinOverlay.hidden").count() === 1,
  );

  // --- permission mode -----------------------------------------------------
  const modes = await page.locator("#modeSelect option").evaluateAll((nodes) =>
    nodes.map((node) => node.value),
  );
  check("Autopilot is offered", modes.includes("bypassPermissions"), modes.join(", "));

  await page.selectOption("#modeSelect", "bypassPermissions");
  await page.waitForTimeout(300);
  check(
    "the composer warns while Autopilot is on",
    await page.locator("#composerNote.warning").count() === 1,
    await page.locator("#composerNote").innerText(),
  );
  check(
    "the choice was written to localStorage",
    (await page.evaluate(() => localStorage.getItem("claude-cli-studio-permission-mode"))) ===
      "bypassPermissions",
  );

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll("#modeSelect option").length > 0,
    { timeout: 20000 },
  );
  check(
    "Autopilot survives a reload",
    (await page.locator("#modeSelect").inputValue()) === "bypassPermissions",
    await page.locator("#modeSelect").inputValue(),
  );

  // The mode endpoint is a no-op with nothing running, but it must not 404 or
  // 500 — that is the call the dropdown makes on every change.
  const modeCall = await page.evaluate(async (token) => {
    const response = await fetch(
      "/api/sessions/00000000-0000-4000-8000-000000000000/permission-mode",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ permissionMode: "bypassPermissions" }),
      },
    );
    return { status: response.status, body: await response.json() };
  }, TOKEN);
  check(
    "the permission-mode endpoint answers",
    modeCall.status === 200 && modeCall.body.applied === false,
    JSON.stringify(modeCall),
  );

  const badMode = await page.evaluate(async (token) => {
    const response = await fetch(
      "/api/sessions/00000000-0000-4000-8000-000000000000/permission-mode",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ permissionMode: "nonsense" }),
      },
    );
    return response.status;
  }, TOKEN);
  check("an unknown mode is rejected", badMode === 400, String(badMode));

  // --- usage meter ---------------------------------------------------------
  check(
    "the usage meter is visible with nothing running",
    await page.locator("#limitMeter").isVisible(),
  );
  await page.click("#limitMeter");
  await page.waitForSelector("#usageDialog[open]", { timeout: 10000 });
  check("clicking the meter opens the usage dialog", true);

  await page.waitForFunction(
    () => document.querySelectorAll("#usageWindows .usage-window").length === 2,
    { timeout: 10000 },
  );
  const windowText = await page.locator("#usageWindows").innerText();
  check(
    "both windows are shown",
    /5-hour window/.test(windowText) && /Weekly window/.test(windowText),
    windowText.replace(/\n/g, " | "),
  );

  await page.click("#usageRefresh");
  await page.waitForFunction(
    () => document.querySelector("#usageRefresh")?.textContent?.trim() === "Refresh",
    { timeout: 30000 },
  );
  const afterRefresh = await page.locator("#usageWindows").innerText();
  check(
    "Refresh produced a real reading",
    /%/.test(afterRefresh),
    afterRefresh.replace(/\n/g, " | "),
  );
  check(
    "the dialog says when it was updated",
    /updated/i.test(await page.locator("#usageNote").innerText()),
    await page.locator("#usageNote").innerText(),
  );
  await page.evaluate(() => document.querySelector("#usageDialog").close());

  // --- resizable sidebar ---------------------------------------------------
  const sidebarWidth = () =>
    page.evaluate(() =>
      Math.round(document.querySelector("#sidebar").getBoundingClientRect().width),
    );
  const handle = page.locator("#sidebarResizer");
  check("the sidebar has a drag handle", await handle.isVisible());

  const startWidth = await sidebarWidth();
  const dragTo = async (x) => {
    const box = await handle.boundingBox();
    await page.mouse.move(box.x + box.width / 2, 400);
    await page.mouse.down();
    await page.mouse.move(x, 400, { steps: 12 });
    await page.mouse.up();
  };

  await dragTo(480);
  const wider = await sidebarWidth();
  check("dragging right widens it", wider > startWidth + 100, `${startWidth} -> ${wider}`);

  await dragTo(240);
  const narrower = await sidebarWidth();
  check("dragging left narrows it", narrower < wider - 100, `${wider} -> ${narrower}`);

  // The clamps matter: below the minimum session titles are unreadable, above
  // the maximum the conversation gets squeezed out of its own window.
  await dragTo(20);
  check("it will not collapse past the minimum", (await sidebarWidth()) === 210);
  await dragTo(1260);
  const clampedHigh = await sidebarWidth();
  check("it will not swallow the conversation", clampedHigh === 620, String(clampedHigh));

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => document.querySelectorAll("#modeSelect option").length > 0,
    { timeout: 20000 },
  );
  check(
    "the width survives a reload",
    (await sidebarWidth()) === clampedHigh,
    String(await sidebarWidth()),
  );

  await handle.dblclick();
  await page.waitForTimeout(200);
  check("double-click resets it", (await sidebarWidth()) === 310);

  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await page.waitForTimeout(150);
  check("arrow keys resize it", (await sidebarWidth()) === 322, String(await sidebarWidth()));

  check(
    "no horizontal overflow at any width",
    await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1),
  );

  // --- quit ----------------------------------------------------------------
  await page.click("#quitButton");
  await page.waitForSelector("#quitDialog[open]", { timeout: 10000 });
  check("Quit asks first", true);
  await page.click("#quitConfirm");
  await page.waitForSelector("#quitOverlay:not(.hidden)", { timeout: 20000 });
  check("the browser is told Studio has stopped", true);

  let stillUp = true;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await wait(300);
    try {
      await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(1000) });
    } catch {
      stillUp = false;
      break;
    }
  }
  check("Quit actually stopped the server", !stillUp);

  // The bad-mode probe above deliberately provokes a 400, which the browser
  // logs as a failed resource. Anything else is a real fault.
  const unexpected = consoleErrors.filter((text) => !/status of 400/.test(text));
  check(
    `no unexpected console errors (${unexpected.length})`,
    unexpected.length === 0,
    unexpected.slice(0, 3).join(" | "),
  );

  console.log(`\n${failed ? "UI E2E FAILED" : "UI E2E PASSED"}`);
} catch (error) {
  console.error("UI E2E ERROR:", error.stack || error.message);
  failed = true;
} finally {
  await browser?.close().catch(() => {});
  server.kill();
  await wait(500);
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
}
