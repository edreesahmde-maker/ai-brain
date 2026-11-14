// Tests the brain's Google Flow control (flow.mjs) against a fake Flow page on this computer.
// It opens its own browser with an empty temporary profile and its own control port, so it never
// touches the real Google Flow, your browser or your Google account.
//   node test/flow-test.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = fs.readFileSync(path.join(ROOT, "test", "fixture.mp4"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (cond, name, extra = "") => { if (cond) { passed++; console.log("  ok  " + name); } else { failed++; console.log("  FAIL " + name + (extra ? "\n       " + String(extra).slice(0, 400) : "")); } };
const throwsLike = async (fn, re) => { try { await fn(); return false; } catch (e) { return re.test(String(e.message)); } };

// ---------- the fake Flow page, and another site that must never be touched ----------
const FLOW_HTML = `<!doctype html><title>Flow (test)</title><body>
<h1>Flow test page</h1><p id="state">Ready</p>
<input id="tiny" size="3"><textarea aria-label="Prompt" placeholder="Describe your video" rows="4" cols="60"></textarea>
<button id="go" aria-label="Create">Create</button><button disabled>Upgrade</button>
<div id="echo"></div><div id="out"></div>
<script>
let n = 0;
const ta = document.querySelector("textarea");
ta.addEventListener("input", () => { document.querySelector("#echo").textContent = "Typed: " + ta.value; });
document.querySelector("#go").addEventListener("click", () => {
  if (!ta.value.trim()) { document.querySelector("#state").textContent = "Nothing to make"; return; }
  document.querySelector("#state").textContent = "Generating: " + ta.value;
  const k = ++n;
  setTimeout(() => { const v = document.createElement("video"); v.src = "/clip.mp4?n=" + k; v.muted = true; document.querySelector("#out").append(v);
    document.querySelector("#state").textContent = "Done " + k; }, 2500);
});
</script>`;
const OTHER_HTML = `<!doctype html><title>Other site</title><body><textarea aria-label="Prompt"></textarea><button aria-label="Create">Create</button>
<p id="hits">0</p><script>let h = 0; for (const ev of ["input","click","keydown"]) document.addEventListener(ev, () => { document.querySelector("#hits").textContent = String(++h); }, true);</script>`;

const serve = (handler) => new Promise((ok) => { const s = http.createServer(handler); s.listen(0, "127.0.0.1", () => ok(s)); });
const flowSrv = await serve((req, res) => {
  if (req.url.startsWith("/clip.mp4")) { res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": FIXTURE.length }); return res.end(FIXTURE); }
  res.writeHead(200, { "Content-Type": "text/html" }); res.end(FLOW_HTML);
});
const otherSrv = await serve((req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end(OTHER_HTML); });
const FLOW_URL = `http://127.0.0.1:${flowSrv.address().port}`;
const OTHER_URL = `http://127.0.0.1:${otherSrv.address().port}`;

// ---------- a browser of the test's own ----------
const BROWSERS = [
  process.env.BRAIN_FLOW_TEST_BROWSER,
  "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe",
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
].filter(Boolean);
const exe = BROWSERS.find((b) => fs.existsSync(b));
if (!exe) { console.log("No Brave, Chrome or Edge found: skipped."); process.exit(0); }
const PORT = 9461;
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ai-brain-flowtest-"));
const data = fs.mkdtempSync(path.join(os.tmpdir(), "ai-brain-flowdata-"));
const browser = spawn(exe, [`--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--window-size=900,700", FLOW_URL + "/fx/tools/flow", OTHER_URL], { stdio: "ignore" });

process.env.BRAIN_FLOW_PORT = String(PORT);
process.env.BRAIN_FLOW_ORIGIN = FLOW_URL;
process.env.BRAIN_DATA_DIR = data;
delete process.env.AI_BRAIN_APP_URL;
const tabs = async () => { try { return await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); } catch { return []; } };

let lib, flow;
try {
  for (let i = 0; i < 60 && (await tabs()).filter((t) => t.type === "page" && /^http:\/\/127/.test(t.url)).length < 2; i++) await sleep(500);
  ok((await tabs()).some((t) => t.url.startsWith(FLOW_URL)), "the test browser opened the fake Flow page and another site");
  lib = await import("../lib.mjs");
  flow = await import("../flow.mjs");

  // A small CDP helper for the test itself, to read a page.
  const read = async (prefix, expr) => {
    const t = (await tabs()).find((x) => x.type === "page" && x.url.startsWith(prefix));
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r) => ws.addEventListener("open", r, { once: true }));
    const got = new Promise((r) => ws.addEventListener("message", (e) => { const m = JSON.parse(e.data); if (m.id === 1) r(m.result?.result?.value); }));
    ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } }));
    const v = await got; ws.close(); return v;
  };

  console.log("look");
  const look = await flow.flowLook();
  ok(/Flow test page/.test(look) && /\[field\] Prompt/.test(look) && /\[button\] Create/.test(look), "flow_look reads the page text and lists the controls", look);
  ok(/\[button, disabled\] Upgrade/.test(look), "greyed-out buttons are marked as disabled");
  ok(!/Other site/.test(look), "flow_look never reads the other site");

  console.log("type, click, wait, save");
  await flow.flowType("a red fox running through snow");
  ok(/Typed: a red fox running through snow/.test(await read(FLOW_URL, "document.body.innerText")), "flow_type types into the prompt box like a person");
  await flow.flowType("a red fox at night");
  ok(await read(FLOW_URL, "document.querySelector('textarea').value") === "a red fox at night", "flow_type replaces what was in the box");
  ok(await throwsLike(() => flow.flowClick("Upgrade"), /greyed out/), "a greyed-out button is not clicked");
  ok(await throwsLike(() => flow.flowClick("Teleport"), /Nothing called "Teleport"/), "a button that is not there gives a clear message");
  ok(/Clicked "Create"/.test(await flow.flowClick("Create")), "flow_click clicks a button by its words");
  ok(/Generating: a red fox at night/.test(await read(FLOW_URL, "document.body.innerText")), "the click reached the page");
  ok(/new video is on the page/.test(await flow.flowWait(20)), "flow_wait notices the new video");
  const saved1 = await flow.flowSaveVideos(1);
  const file1 = saved1.split("\n").find((l) => l.endsWith(".mp4"));
  ok(file1 && fs.existsSync(file1) && fs.readFileSync(file1).equals(FIXTURE) && file1.startsWith(lib.MEDIA), "flow_save_videos saves the exact video into the gallery folder", saved1);
  ok(/saved already/.test(await flow.flowSaveVideos(1)), "the same video is not saved twice");
  ok(lib.readVideoUsage().today === 1, "a video saved step by step counts towards today's video limit (once)");
  ok(await read(FLOW_URL, "document.querySelector('#tiny').value") === "", "without a box name it types into the big prompt box, not a small box with no label");
  ok(/"Done 1" is on the page/.test(await flow.flowWait(5, "Done 1")), "flow_wait can wait for words");

  console.log("make a video in one step");
  const before = lib.readVideoUsage().today;
  const made = await flow.flowMakeVideo("a blue whale under the ice", 60);
  const file2 = made.split("\n").find((l) => l.endsWith(".mp4"));
  ok(file2 && file2 !== file1 && fs.readFileSync(file2).equals(FIXTURE), "flow_make_video types, starts, waits and saves the new video", made);
  ok(/Typed: a blue whale under the ice/.test(await read(FLOW_URL, "document.body.innerText")) && /Done 2/.test(await read(FLOW_URL, "document.body.innerText")), "it used the description it was given");
  ok(lib.readVideoUsage().today === before + 1, "the video counts towards today's video limit");
  fs.writeFileSync(path.join(data, "settings.json"), JSON.stringify({ videoDailyLimit: before + 1 }));
  ok(await throwsLike(() => flow.flowMakeVideo("one more", 30), /video limit/), "the daily video limit stops Flow videos too");
  ok(await throwsLike(() => flow.flowType("one more"), /video limit/) && await throwsLike(() => flow.flowClick("Create"), /video limit/), "and it stops typing and clicking in Flow step by step");
  ok(await read(FLOW_URL, "document.querySelectorAll('video').length") === 2, "and nothing was started in Flow");

  console.log("only the Flow page");
  ok(await read(OTHER_URL, "document.querySelector('#hits').textContent") === "0" && await read(OTHER_URL, "document.querySelector('textarea').value") === "", "the other site was never clicked or typed in");
  const t = (await tabs()).find((x) => x.type === "page" && x.url.startsWith(FLOW_URL));
  await fetch(`http://127.0.0.1:${PORT}/json/close/${t.id}`);
  await sleep(800);
  ok(await throwsLike(() => flow.flowLook(), /Google Flow is not open in AI Brain/), "with Flow closed it says so, and does not use the other site");
} catch (e) {
  failed++; console.log("  FAIL the test stopped: " + (e?.stack || e));
} finally {
  try { const v = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json(); const ws = new WebSocket(v.webSocketDebuggerUrl); await new Promise((r) => ws.addEventListener("open", r, { once: true })); ws.send(JSON.stringify({ id: 1, method: "Browser.close" })); await sleep(1500); } catch { browser.kill(); }
  flowSrv.close(); otherSrv.close();
}

// ---------- the brain only gets the Flow tools when the setting is on ----------
console.log("brain tools");
async function toolNames(flowOn) {
  const p = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { env: { ...process.env, AI_BRAIN_FLOW: flowOn ? "1" : "0", BRAIN_DATA_DIR: data }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "";
  const answer = (id) => new Promise((ok, bad) => {
    const timer = setTimeout(() => bad(new Error("no answer")), 15000);
    p.stdout.on("data", (d) => { buf += d; for (const line of buf.split("\n")) { try { const m = JSON.parse(line); if (m.id === id) { clearTimeout(timer); ok(m.result); } } catch { /* partial line */ } } });
  });
  const send = (m) => p.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "flow-test", version: "1" } } });
  await answer(1);
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });
  const r = await answer(2);
  p.kill();
  return (r.tools || []).map((t) => t.name);
}
try {
  const on = await toolNames(true), off = await toolNames(false);
  ok(["flow_make_video", "flow_look", "flow_click", "flow_type", "flow_wait", "flow_save_videos"].every((n) => on.includes(n)), "with the setting on, the brain has the six Flow tools", on.join());
  ok(!off.some((n) => n.startsWith("flow_")), "with it off, it has none of them", off.join());
} catch (e) { failed++; console.log("  FAIL tools list: " + e.message); }

for (const d of [profile, data]) { for (let i = 0; i < 5; i++) { try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { await sleep(700); } } }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
