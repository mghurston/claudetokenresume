/**
 * End-to-end check for the Autopilot fix, against a real server + real CLI.
 *
 * Sends a turn under "Ask", waits for the permission prompt to arrive over SSE,
 * then does what the dropdown now does — POST the new mode at the running
 * session — and asserts that the waiting prompt is answered and the rest of the
 * turn runs without asking again.
 *
 * Run with: node scripts/e2e-permission-mode.mjs (spends real tokens, so it is
 * NOT part of `npm test`).
 */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const PORT = 4179;
const TOKEN = "e2e-test-token-000000000000000000000000";
const BASE = `http://127.0.0.1:${PORT}`;
const SCRATCH = path.join(os.tmpdir(), "studio-e2e-autopilot");

fs.rmSync(SCRATCH, { recursive: true, force: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const server = spawn(process.execPath, [path.resolve(import.meta.dirname, "..", "server.mjs")], {
  env: {
    ...process.env,
    CLAUDE_STUDIO_PORT: String(PORT),
    CLAUDE_STUDIO_SESSION_TOKEN: TOKEN,
    CLAUDE_STUDIO_OPEN: "0",
    CLAUDE_STUDIO_ON_CONFLICT: "fail",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stdout.on("data", (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on("data", (d) => process.stderr.write(`[server:err] ${d}`));

const api = async (route, init = {}) => {
  const response = await fetch(BASE + route, {
    ...init,
    headers: {
      "Authorization": `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "Origin": BASE,
      ...(init.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${route} -> ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let failed = false;
const check = (label, ok) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failed = true;
};

try {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await fetch(`${BASE}/api/ping`);
      break;
    } catch {
      await wait(500);
    }
  }

  const bootstrap = await api("/api/bootstrap");
  const project =
    bootstrap.projects.find((item) => item.id !== "general") || bootstrap.projects[0];
  console.log(`Using project: ${project.id} (${project.path})`);

  // Listen to the event stream the way the browser does.
  const seen = { permissionRequests: [], resolved: [], idle: false };
  const stream = await fetch(`${BASE}/api/events`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of stream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop();
      for (const frame of frames) {
        const line = frame.split("\n").find((item) => item.startsWith("data: "));
        if (!line) continue;
        const payload = JSON.parse(line.slice(6));
        if (payload.type === "permission-request") {
          console.log(`  <- permission-request: ${payload.request.toolName}`);
          seen.permissionRequests.push(payload);
        }
        if (payload.type === "permission-resolved") {
          console.log(`  <- permission-resolved: ${payload.requestId}`);
          seen.resolved.push(payload);
        }
        if (payload.type === "claude-event" && payload.event.type === "session.idle") {
          seen.idle = true;
        }
      }
    }
  })().catch(() => {});

  const targets = ["one", "two", "three"].map((name) =>
    path.join(SCRATCH, `${name}.txt`).replaceAll("\\", "/"),
  );

  console.log("\nSending a turn under Ask (default)...");
  const sent = await api("/api/messages", {
    method: "POST",
    body: JSON.stringify({
      sessionId: null,
      projectId: project.id,
      prompt:
        `Using the Write tool, create these three files one at a time, in order, ` +
        `each containing its own name: ${targets.join(", ")}. Then reply DONE.`,
      uploadIds: [],
      model: null,
      effort: null,
      permissionMode: "default",
    }),
  });
  const sessionId = sent.sessionId;
  console.log(`session: ${sessionId}`);

  console.log("Waiting for the first permission prompt...");
  for (let attempt = 0; attempt < 120 && seen.permissionRequests.length === 0; attempt += 1) {
    await wait(1000);
  }
  check("a prompt was raised under Ask", seen.permissionRequests.length > 0);

  console.log("\nSwitching the running session to Autopilot (what the dropdown now does)...");
  const applied = await api(`/api/sessions/${sessionId}/permission-mode`, {
    method: "POST",
    body: JSON.stringify({ permissionMode: "bypassPermissions" }),
  });
  console.log("  ->", JSON.stringify(applied));
  check("the mode reached the live session", applied.applied === true);
  check("the waiting prompt was approved by the switch", applied.approved >= 1);

  console.log("\nWaiting for the turn to finish...");
  for (let attempt = 0; attempt < 180 && !seen.idle; attempt += 1) {
    await wait(1000);
  }
  check("the turn completed", seen.idle);

  const written = targets.filter((target) => fs.existsSync(target));
  check(`all three files were written (${written.length}/3)`, written.length === 3);
  check(
    `no further prompts after the switch (total ${seen.permissionRequests.length})`,
    seen.permissionRequests.length === 1,
  );
  check("every prompt was resolved, none timed out", seen.resolved.length >= 1);

  console.log(`\n${failed ? "E2E FAILED" : "E2E PASSED"}`);
} catch (error) {
  console.error("E2E ERROR:", error.message);
  failed = true;
} finally {
  server.kill();
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  await wait(500);
  process.exit(failed ? 1 : 0);
}
