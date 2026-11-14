#!/usr/bin/env node
// The web inspector, end to end: the REAL extension (folder "extension") in a Brave (or Chrome/Edge)
// with an empty throw-away profile - never your own browser profile - a local test page, the AI Brain
// server on a spare port with throw-away data, and the brain's tool server (server.mjs) calling the
// web_ tools the way Claude does.
// Run: node test/inspect-test.mjs
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4797, PAGE_PORT = 4798, CDP_PORT = 9562;
const BASE = `http://127.0.0.1:${PORT}`, PAGE = `http://127.0.0.1:${PAGE_PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ai-brain-inspect-"));
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), "ai-brain-inspect-browser-"));
const H = { Origin: BASE, "Content-Type": "application/json" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (cond, name, extra = "") => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${String(extra).slice(0, 600)}`); } };
const post = async (p, body) => { const r = await fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const get = async (p) => (await fetch(BASE + p)).json();
async function until(fn, ms = 15000) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn().catch(() => null); if (v) return v; await sleep(250); } return null; }

const BROWSERS = [
  path.join(process.env.ProgramFiles || "C:\\Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
  path.join(process.env.ProgramFiles || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
  path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
];
const browserExe = process.env.BRAIN_INSPECT_BROWSER || BROWSERS.find((p) => fs.existsSync(p));

// ---------- a test page: console messages, an error, two requests, cookies, a styled box ----------
const PAGE_HTML = `<!doctype html><html><head><title>Inspector test page</title></head><body>
<div id="box" style="width:120px;height:40px;color:rgb(255, 0, 0);display:flex">Box</div>
<p class="note">first</p><p class="note">second</p>
<script>
  console.log("hello from page", 42);
  console.warn("careful");
  document.cookie = "visible=yes; path=/";
  fetch("/api/data?x=1").then((r) => r.json()).then((d) => { window.got = d; });
  fetch("/api/save", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ a: 1 }) });
  setTimeout(() => { throw new Error("boom in page"); }, 50);
</script></body></html>`;
const pageServer = http.createServer((q, r) => {
  if (q.url.startsWith("/page.html")) { r.writeHead(200, { "Content-Type": "text/html", "Set-Cookie": "secretcookie=topsecret; HttpOnly; Path=/" }); return r.end(PAGE_HTML); }
  if (q.url.startsWith("/api/data")) { r.writeHead(200, { "Content-Type": "application/json" }); return r.end(JSON.stringify({ answer: 42 })); }
  if (q.url === "/api/save") { let s = ""; q.on("data", (d) => { s += d; }); q.on("end", () => { r.writeHead(201, { "Content-Type": "application/json" }); r.end(JSON.stringify({ saved: JSON.parse(s || "{}") })); }); return; }
  r.writeHead(404); r.end();
});
await new Promise((res) => pageServer.listen(PAGE_PORT, "127.0.0.1", res));

// ---------- AI Brain's server ----------
const server = spawn(process.execPath, [path.join(ROOT, "app", "app-server.mjs")], {
  env: { ...process.env, BRAIN_PORT: String(PORT), BRAIN_DATA_DIR: DATA, BRAIN_NO_OPEN: "1", BRAIN_FAKE_DISCORD: "stopped", BRAIN_FAKE_CLAUDE: path.join(ROOT, "test", "fake-claude.mjs"), BRAIN_FAKE_HELPERS: "1" },
  stdio: "ignore",
});
await until(async () => (await fetch(`${BASE}/api/ping`)).ok);

// The brain's tool server, started like Claude starts it (env from brain-mcp.json).
function toolServer(env) {
  const p = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = "", n = 10;
  const waiting = new Map();
  p.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); waiting.get(m.id)?.(m.result); } catch { /* not a message */ }
    }
  });
  const rpc = (method, params) => new Promise((res, rej) => {
    const id = ++n;
    const t = setTimeout(() => rej(new Error(`no answer to ${method}`)), 90000);
    waiting.set(id, (r) => { clearTimeout(t); res(r); });
    p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
  return {
    async start() { await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "inspect-test", version: "1" } }); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); },
    names: async () => ((await rpc("tools/list", {})).tools || []).map((t) => t.name),
    call: async (name, args = {}) => { const r = await rpc("tools/call", { name, arguments: args }); return { error: !!r.isError, text: r.content?.find((c) => c.type === "text")?.text || "", image: r.content?.find((c) => c.type === "image") }; },
    stop: () => p.kill(),
  };
}

let browser = null, brave = null, mcp = null;
try {
  console.log("pairing");
  const v0 = await get("/api/inspect");
  ok(v0.paired === false && v0.connected === false && v0.folder.endsWith("extension"), "not paired at first; Settings knows the extension folder", JSON.stringify(v0));
  const c1 = await post("/api/inspect/code", {});
  ok(/^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/.test(c1.body?.code || ""), "a pairing code is made when asked", c1.body?.code);
  ok((await post("/api/inspect/code", {})).body.code === c1.body.code, "asking again shows the same code");
  ok(!fs.readFileSync(path.join(DATA, "brain-mcp.json"), "utf8").includes(c1.body.code), "the code is never handed to the brain");
  const code = c1.body.code;

  if (!browserExe) throw new Error("no Brave, Chrome or Edge found");
  console.log(`browser: ${path.basename(browserExe)} (empty test profile)`);
  brave = spawn(browserExe, [`--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${CDP_PORT}`,
    `--load-extension=${path.join(ROOT, "extension")}`, `--disable-extensions-except=${path.join(ROOT, "extension")}`, `${PAGE}/page.html`], { stdio: "ignore" });
  browser = await until(() => puppeteer.connect({ browserURL: `http://127.0.0.1:${CDP_PORT}`, defaultViewport: null }), 20000);
  const swTarget = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20000 });
  const extId = new URL(swTarget.url()).host;
  const sw = async () => (await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 20000 })).worker();
  const inSW = async (code) => (await sw()).evaluate(code);

  // Pair through the popup page, as a person would (with the test server's address).
  const popup = await browser.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForSelector("#pair:not([hidden])");
  ok(/Not paired/.test(await popup.$eval("#state", (e) => e.textContent)), "the popup asks for the pairing code");
  // A wrong code is refused (asked of the test server only, never a real AI Brain).
  const wrong = await inSW(`(async () => { cfg = { url: ${JSON.stringify(BASE)}, code: "WRONG-CODE0-00000-00000" }; return (await hello()).state; })()`);
  ok(wrong === "wrong-code", "a wrong pairing code is refused", wrong);
  await popup.type("#code", code.toLowerCase().replace(/-/g, " "));
  await popup.evaluate((u) => { // the popup pairs with the test server's address
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m) => orig(m.what === "pair" ? { ...m, url: u } : m);
  }, BASE);
  await popup.click("#pair-btn");
  const paired = await until(async () => (await get("/api/inspect")).connected, 20000);
  ok(!!paired, "after pairing (typed in any case, with spaces) the extension connects to AI Brain");
  await popup.reload();
  await popup.waitForSelector("#state");
  const stText = await until(async () => { const t = await popup.$eval("#state", (e) => e.textContent); return /AI Brain/.test(t) && !/Connecting/.test(t) ? t : null; });
  ok(/not allowed to inspect yet/.test(stText || ""), "the popup says the brain is not allowed yet while the setting is off", stText);
  ok((await get("/api/inspect")).browser.length > 0, "AI Brain knows which browser it is");

  console.log("the brain inspects");
  await post("/api/settings", { inspectBrain: true });
  await post("/api/task", { text: "Inspect it [hang]" });
  const env = await until(async () => { const e = JSON.parse(fs.readFileSync(path.join(DATA, "brain-mcp.json"), "utf8")).mcpServers["ai-brain"].env; return e.AI_BRAIN_CONTROL_KEY ? e : null; });
  ok(env?.AI_BRAIN_INSPECT === "1" && env.AI_BRAIN_APPS === "0", "a task gets the web tools (and not the program tools)", JSON.stringify(env));
  mcp = toolServer(env);
  await mcp.start();
  const names = await mcp.names();
  ok(["web_tabs", "web_html", "web_eval", "web_network", "web_response", "web_console", "web_cookies", "web_styles", "web_screenshot", "web_go"].every((n) => names.includes(n)) && !names.some((n) => n.startsWith("app_")), "the brain has the ten web tools", names.join());
  let r = await mcp.call("web_tabs");
  ok(!r.error && /No tab is shared/.test(r.text), "nothing is shared yet: the brain is told to ask the user", r.text);
  r = await mcp.call("web_html");
  ok(r.error && /No tab is shared/.test(r.text), "and it cannot read any tab");

  // The user shares the test page (what "Share this tab" does).
  const shareR = await inSW(`(async () => { const [t] = await chrome.tabs.query({ url: ${JSON.stringify(`${PAGE}/*`)} }); return share(t.id); })()`);
  ok(shareR?.ok, "the test page is shared", JSON.stringify(shareR));
  ok(await until(async () => (await get("/api/inspect")).tabs.some((t) => t.title === "Inspector test page")), "Settings shows the shared tab");
  r = await mcp.call("web_tabs");
  const tabId = Number((r.text.match(/tab (\d+):/) || [])[1]);
  ok(/Inspector test page/.test(r.text) && tabId > 0, "the brain sees the shared tab", r.text);

  r = await mcp.call("web_go", {});
  ok(!r.error && /Reloaded\. The page finished loading/.test(r.text), "it reloads the page and waits for it", r.text);
  await sleep(800);
  r = await mcp.call("web_network", {});
  ok(/GET 200 Document http:\/\/127\.0\.0\.1:4798\/page\.html/.test(r.text) && /GET 200 Fetch http:\/\/127\.0\.0\.1:4798\/api\/data\?x=1/.test(r.text) && /POST 201 Fetch .*\/api\/save/.test(r.text), "it lists the page's requests with method, status and type", r.text);
  const saveN = Number((r.text.match(/#(\d+) POST 201/) || [])[1]);
  r = await mcp.call("web_network", { filter: "data" });
  ok(/api\/data/.test(r.text) && !/api\/save/.test(r.text), "the list can be filtered");
  r = await mcp.call("web_response", { request: saveN });
  ok(/Status: 201/.test(r.text) && /Request body:\n\{"a":1\}/.test(r.text) && /"saved":\{"a":1\}/.test(r.text) && /content-type: application\/json/i.test(r.text), "one request in full: headers, request body and response body", r.text);
  r = await mcp.call("web_response", { request: 9999 });
  ok(r.error && /no request #9999/.test(r.text), "an unknown request number is explained");

  r = await mcp.call("web_console", {});
  ok(/\[log\] hello from page 42/.test(r.text) && /\[warning\] careful/.test(r.text) && /\[error\] .*boom in page/.test(r.text), "the console shows logs, warnings and errors", r.text);
  r = await mcp.call("web_console", { level: "errors" });
  ok(/boom in page/.test(r.text) && !/careful/.test(r.text), "it can show errors only");

  r = await mcp.call("web_html", { selector: "#box" });
  ok(/<div id="box"[^>]*>Box<\/div>/.test(r.text), "it reads one part of the page by selector", r.text);
  r = await mcp.call("web_html", { selector: ".note" });
  ok(/first of 2 matches/.test(r.text) && /first<\/p>/.test(r.text), "it says when a selector matches more than one");
  r = await mcp.call("web_html", {});
  ok(/<html>[\s\S]*Inspector test page[\s\S]*<\/html>/.test(r.text), "and the whole live page");
  r = await mcp.call("web_html", { selector: "#nothing" });
  ok(r.error && /Nothing on the page matches #nothing/.test(r.text), "a selector that matches nothing is explained");

  r = await mcp.call("web_eval", { expression: "window.got.answer + 1" });
  ok(/Result \(number\):\n43/.test(r.text), "it runs JavaScript and gets the result (the page's own data)", r.text);
  r = await mcp.call("web_eval", { expression: "fetch('/api/data').then((x) => x.json())" });
  ok(/"answer": 42/.test(r.text), "promises are awaited and objects come back as JSON", r.text);
  r = await mcp.call("web_eval", { expression: "nope()" });
  ok(/ERROR: ReferenceError: nope is not defined/.test(r.text), "JavaScript errors are reported", r.text);

  r = await mcp.call("web_cookies", {});
  ok(/secretcookie  domain=127\.0\.0\.1 path=\/ HttpOnly/.test(r.text) && /visible  domain/.test(r.text) && !/topsecret/.test(r.text), "cookies are listed with their flags, values hidden", r.text);
  r = await mcp.call("web_cookies", { include_values: true });
  ok(/secretcookie=topsecret/.test(r.text), "values only when asked for");

  r = await mcp.call("web_styles", { selector: "#box" });
  ok(/box \d+,\d+ 120x40/.test(r.text) && /color: rgb\(255, 0, 0\)/.test(r.text) && /display: flex/.test(r.text), "it reads computed styles and the box", r.text);
  r = await mcp.call("web_screenshot", {});
  ok(!r.error && r.image?.mimeType === "image/png" && Buffer.from(r.image.data, "base64").subarray(1, 4).toString() === "PNG", "a screenshot of the tab reaches the brain", r.text);

  r = await mcp.call("web_go", { url: `${PAGE}/page.html?second=1` });
  ok(/Opened .*second=1\. The page finished loading/.test(r.text) && /second=1/.test(r.text.split("\n")[0]), "it can open another address in the shared tab", r.text);
  r = await mcp.call("web_go", { url: "file:///C:/Windows/win.ini" });
  ok(r.error && /Only http and https/.test(r.text), "only web addresses can be opened");
  r = await mcp.call("web_html", { tab: 123456 });
  ok(r.error && /Tab 123456 is not shared/.test(r.text), "a tab that is not shared cannot be read");

  // A browser page cannot be shared.
  const settingsShare = await inSW(`(async () => { const t = await chrome.tabs.create({ url: "chrome://version", active: false }); const r = await share(t.id); chrome.tabs.remove(t.id); return r; })()`);
  ok(settingsShare && !settingsShare.ok && /Only normal web pages/.test(settingsShare.why), "browser pages can never be shared", JSON.stringify(settingsShare));

  // Switching the setting off refuses the brain; Stop sharing ends the tab.
  await post("/api/settings", { inspectBrain: false });
  r = await mcp.call("web_tabs");
  ok(r.error && /switched off/.test(r.text), "with the setting off the brain is refused", r.text);
  await post("/api/settings", { inspectBrain: true });
  await inSW(`(async () => { const [t] = await chrome.tabs.query({ url: ${JSON.stringify(`${PAGE}/*`)} }); await unshare(t.id); return true; })()`);
  r = await mcp.call("web_tabs");
  ok(/No tab is shared/.test(r.text), "after Stop sharing the tab is gone for the brain");
  // (The test's own browser connection stays; the extension's must be gone.)
  const attached = await inSW(`(async () => { const [t] = await chrome.tabs.query({ url: ${JSON.stringify(`${PAGE}/*`)} }); try { await chrome.debugger.sendCommand({ tabId: t.id }, "Runtime.evaluate", { expression: "1" }); return "still attached"; } catch (e) { return e.message; } })()`);
  ok(/not attached/i.test(attached), "and the extension's debugger has let go of it (the browser's bar goes away)", attached);

  // The key dies with the task.
  await post("/api/stop");
  await sleep(1500);
  r = await mcp.call("web_tabs");
  ok(r.error && /wrong key/.test(r.text), "after the task the brain's key no longer works", r.text);

  // A new pairing code locks the old one out.
  await post("/api/inspect/code", { renew: true });
  const locked = await inSW(`(async () => (await hello()).state)()`);
  ok(locked === "wrong-code", "a new pairing code locks the extension out until it is paired again", locked);
} catch (e) {
  failed++;
  console.log("  CRASH", e.stack || e);
} finally {
  mcp?.stop();
  try { await browser?.close(); } catch { /* gone */ }
  brave?.kill();
  server.kill();
  pageServer.close();
  await sleep(1500);
  for (const d of [DATA, PROFILE]) { for (let i = 0; i < 5; i++) { try { fs.rmSync(d, { recursive: true, force: true }); break; } catch { await sleep(700); } } }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
