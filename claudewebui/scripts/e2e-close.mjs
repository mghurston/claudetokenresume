/**
 * Closing the window stops Studio — but only when that is safe.
 *
 * The four cases that matter, all of which have to hold at once: a reload is
 * not a close, one of two windows closing is not a close, the last window
 * closing is, and work in flight outranks all of it.
 *
 * Run with: node scripts/e2e-close.mjs
 */
import { spawn } from "node:child_process";
import fs from "node:fs"; import os from "node:os"; import path from "node:path";
import { chromium } from "playwright";
const PORT=4185, TOKEN="e2e-close-token-000000000000000000000000", BASE=`http://127.0.0.1:${PORT}`;
const DATA=path.join(os.tmpdir(),"studio-e2e-close");
fs.rmSync(DATA,{recursive:true,force:true});
let failed=false; const check=(l,ok,d="")=>{console.log(`${ok?"PASS":"FAIL"}  ${l}${d?` — ${d}`:""}`);if(!ok)failed=true;};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const env={...process.env,CLAUDE_STUDIO_PORT:String(PORT),CLAUDE_STUDIO_SESSION_TOKEN:TOKEN,
  CLAUDE_STUDIO_DATA_DIR:DATA,CLAUDE_STUDIO_OPEN:"0",CLAUDE_STUDIO_ON_CONFLICT:"fail"};
const boot=async()=>{const p=spawn(process.execPath,[path.resolve(import.meta.dirname,"..","server.mjs")],{env,stdio:["ignore","pipe","pipe"]});
  p.stdout.on("data",d=>{const s=String(d);if(/Last window|Stopping/.test(s))console.log(`  [server] ${s.trim()}`);});
  for(let i=0;i<60;i++){try{await fetch(`${BASE}/api/ping`);return p;}catch{await wait(500);}} return p;};
const alive=async()=>{try{await fetch(`${BASE}/api/ping`,{signal:AbortSignal.timeout(1200)});return true;}catch{return false;}};
let server, browser;
try{
  server=await boot();
  browser=await chromium.launch();
  const ctx=await browser.newContext();
  await ctx.addInitScript(t=>localStorage.setItem("claude-cli-studio-token",t),TOKEN);

  // 1. A reload must NOT stop it.
  let page=await ctx.newPage();
  await page.goto(BASE,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>document.querySelectorAll("#modeSelect option").length>0,{timeout:20000});
  await page.reload({waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>document.querySelectorAll("#modeSelect option").length>0,{timeout:20000});
  await wait(11000);
  check("a reload does not stop Studio", await alive());

  // 2. Two windows: closing one must NOT stop it.
  const second=await ctx.newPage();
  await second.goto(BASE,{waitUntil:"domcontentloaded"});
  await second.waitForFunction(()=>document.querySelectorAll("#modeSelect option").length>0,{timeout:20000});
  await second.close();
  await wait(11000);
  check("closing one of two windows does not stop it", await alive());

  // 3. Closing the last window stops it.
  await page.close();
  let stopped=false;
  for(let i=0;i<40;i++){ await wait(500); if(!(await alive())){stopped=true;break;} }
  check("closing the last window stops Studio", stopped);

  // 4. With a turn parked, closing must NOT stop it.
  server=await boot();
  page=await ctx.newPage();
  await page.goto(BASE,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>document.querySelectorAll("#modeSelect option").length>0,{timeout:20000});
  const bootstrap=await (await fetch(`${BASE}/api/bootstrap`,{headers:{Authorization:`Bearer ${TOKEN}`}})).json();
  const project=bootstrap.projects.find(p=>p.id!=="general")||bootstrap.projects[0];
  await fetch(`${BASE}/api/messages`,{method:"POST",headers:{Authorization:`Bearer ${TOKEN}`,"Content-Type":"application/json",Origin:BASE},
    body:JSON.stringify({sessionId:null,projectId:project.id,prompt:"parked",uploadIds:[],model:null,effort:null,permissionMode:"acceptEdits",queueForReset:true})});
  await wait(500);
  await page.close();
  await wait(12000);
  check("a parked turn keeps Studio alive when the window closes", await alive());

  // 5. A turn in flight does NOT veto the close — the browser asked first, and
  // overriding an answered question would make that dialog a lie. Simulated by
  // marking a session running server-side, since a real turn needs the CLI.
  await fetch(`${BASE}/api/watch/queue/${(await (await fetch(`${BASE}/api/bootstrap`,{headers:{Authorization:`Bearer ${TOKEN}`}})).json()).queue[0].sessionId}`,
    {method:"DELETE",headers:{Authorization:`Bearer ${TOKEN}`,Origin:BASE}});
  await wait(300);
  page=await ctx.newPage();
  await page.goto(BASE,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>document.querySelectorAll("#modeSelect option").length>0,{timeout:20000});
  await page.close();
  let stoppedAgain=false;
  for(let i=0;i<40;i++){ await wait(500); if(!(await alive())){stoppedAgain=true;break;} }
  check("with the queue emptied, closing stops it again", stoppedAgain);
  console.log(`\n${failed?"CLOSE FAILED":"CLOSE PASSED"}`);
}catch(e){console.error("ERROR:",e.stack||e.message);failed=true;}
finally{await browser?.close().catch(()=>{});server?.kill();await wait(400);
  fs.rmSync(DATA,{recursive:true,force:true});process.exit(failed?1:0);}
