/**
 * Proves a parked turn survives the server dying.
 *
 * A turn can wait hours for a usage window; Quit, Restart and an overnight
 * reboot all used to eat it silently. Uses SIGKILL deliberately — the worst
 * case, with no graceful shutdown to help.
 *
 * Run with: node scripts/e2e-queue.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
const PORT = 4184, TOKEN = "e2e-queue-token-000000000000000000000000";
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.join(os.tmpdir(), "studio-e2e-queue");
fs.rmSync(DATA, { recursive: true, force: true });
let failed = false;
const check = (l, ok, d="") => { console.log(`${ok?"PASS":"FAIL"}  ${l}${d?` — ${d}`:""}`); if(!ok) failed=true; };
const wait = ms => new Promise(r=>setTimeout(r,ms));
const env = { ...process.env, CLAUDE_STUDIO_PORT:String(PORT), CLAUDE_STUDIO_SESSION_TOKEN:TOKEN,
  CLAUDE_STUDIO_DATA_DIR:DATA, CLAUDE_STUDIO_OPEN:"0", CLAUDE_STUDIO_ON_CONFLICT:"fail" };
const boot = async () => {
  const p = spawn(process.execPath, [path.resolve(import.meta.dirname, "..", "server.mjs")], { env, stdio:["ignore","pipe","pipe"] });
  p.stdout.on("data", d => { const s=String(d); if(/parked turn/.test(s)) console.log(`  [server] ${s.trim()}`); });
  for (let i=0;i<60;i++){ try{ await fetch(`${BASE}/api/ping`); return p; }catch{ await wait(500);} }
  return p;
};
const api = async (r, init={}) => {
  const res = await fetch(BASE+r, { ...init, headers:{Authorization:`Bearer ${TOKEN}`,"Content-Type":"application/json",Origin:BASE,...(init.headers||{})} });
  const b = await res.json().catch(()=>({}));
  if(!res.ok) throw new Error(`${r} ${res.status} ${JSON.stringify(b)}`);
  return b;
};
let server;
try {
  server = await boot();
  const bootstrap = await api("/api/bootstrap");
  const project = bootstrap.projects.find(p=>p.id!=="general") || bootstrap.projects[0];
  await api("/api/messages", { method:"POST", body: JSON.stringify({
    sessionId:null, projectId:project.id, prompt:"a turn parked for the reset",
    uploadIds:[], model:null, effort:null, permissionMode:"acceptEdits", queueForReset:true })});
  const before = (await api("/api/bootstrap")).queue;
  check("the turn is queued", before.length === 1, JSON.stringify(before.map(e=>e.prompt)));

  const queueFile = path.join(DATA, "queue.json");
  check("it was written to disk", fs.existsSync(queueFile));
  const mode = (fs.statSync(queueFile).mode & 0o777).toString(8);
  console.log(`  queue.json mode: ${mode}`);

  // Hard kill — the worst case, no graceful shutdown at all.
  server.kill("SIGKILL");
  await wait(1500);
  server = await boot();
  const after = (await api("/api/bootstrap")).queue;
  check("it survived a hard kill and restart", after.length === 1, JSON.stringify(after.map(e=>e.prompt)));
  check("the prompt text came back intact", after[0]?.prompt === "a turn parked for the reset");
  check("the permission mode came back", after[0]?.permissionMode === "acceptEdits");

  // Cancelling empties the file rather than leaving a prompt lying around.
  await api(`/api/watch/queue/${after[0].sessionId}`, { method:"DELETE" });
  await wait(300);
  check("the file is removed once the queue empties", !fs.existsSync(queueFile));
  console.log(`\n${failed?"QUEUE FAILED":"QUEUE PASSED"}`);
} catch(e) { console.error("ERROR:", e.message); failed = true; }
finally { server?.kill(); await wait(400); fs.rmSync(DATA,{recursive:true,force:true}); process.exit(failed?1:0); }
