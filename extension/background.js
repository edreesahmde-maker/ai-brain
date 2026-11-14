// AI Brain inspector - background worker.
// Talks ONLY to the AI Brain app on this computer (http://127.0.0.1), with the pairing code from
// AI Brain's Settings. It uses the browser's debugger ONLY on tabs you shared (popup > Share this tab);
// the browser shows its "debugging" bar while a tab is shared. Cancel on that bar, closing the tab or
// "Stop sharing" ends it. Network requests and console messages are kept (in memory) from the moment
// a tab is shared, so the brain can list them.
"use strict";

const DEF_URL = "http://127.0.0.1:4777";
const VERSION = chrome.runtime.getManifest().version;
const MAX_REQ = 500, MAX_LOG = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let cfg = { url: DEF_URL, code: "" };
let status = { state: "unpaired", why: "" }; // unpaired | connecting | connected | offline | wrong-code
const shared = new Map(); // tabId -> { at, reqs: Map(requestId -> entry), list: [entries], n, logs: [], logTotal, loadWaiters: [] }
let polling = false;
const ready = load();

async function load() {
  const c = await chrome.storage.local.get({ url: DEF_URL, code: "" });
  cfg = { url: String(c.url || DEF_URL).replace(/\/+$/, ""), code: String(c.code || "") };
  status.state = cfg.code ? "connecting" : "unpaired";
  // After the worker slept, tabs that are still attached stay shared (their lists start again).
  const { tabs = [] } = await chrome.storage.session.get({ tabs: [] });
  const targets = await chrome.debugger.getTargets();
  for (const id of tabs) {
    if (targets.some((t) => t.tabId === id && t.attached)) shared.set(id, fresh());
  }
  await saveShared();
}
const fresh = () => ({ at: Date.now(), reqs: new Map(), list: [], n: 0, logs: [], logTotal: 0, loadWaiters: [] });
const saveShared = () => chrome.storage.session.set({ tabs: [...shared.keys()] });
const browserName = () => (navigator.brave ? "Brave" : (navigator.userAgentData?.brands || []).map((b) => b.brand).find((b) => /Edge|Chrome|Opera|Vivaldi/.test(b)) || "Chromium");

// ---------- sharing a tab ----------
const dbg = (tabId, method, params = {}) => chrome.debugger.sendCommand({ tabId }, method, params);
async function share(tabId) {
  if (shared.has(tabId)) return { ok: true };
  const tab = await chrome.tabs.get(tabId);
  if (!/^https?:|^file:/.test(tab.url || "")) return { ok: false, why: "Only normal web pages can be shared (not browser pages like settings or the extension store)." };
  try { await chrome.debugger.attach({ tabId }, "1.3"); }
  catch (e) { return { ok: false, why: String(e.message || e) }; }
  shared.set(tabId, fresh());
  try {
    await dbg(tabId, "Network.enable", { maxPostDataSize: 65536 });
    await dbg(tabId, "Runtime.enable");
    await dbg(tabId, "Log.enable");
    await dbg(tabId, "Page.enable");
  } catch { /* some pages refuse one of these; the rest still works */ }
  await saveShared();
  badge(tabId, true);
  loop();
  hello();
  return { ok: true };
}
async function unshare(tabId) {
  if (!shared.has(tabId)) return;
  shared.delete(tabId);
  await saveShared();
  try { await chrome.debugger.detach({ tabId }); } catch { /* already gone */ }
  badge(tabId, false);
  hello();
}
function badge(tabId, on) {
  chrome.action.setBadgeText({ tabId, text: on ? "ON" : "" }).catch(() => {});
  if (on) chrome.action.setBadgeBackgroundColor({ tabId, color: "#c8282f" }).catch(() => {});
}
chrome.debugger.onDetach.addListener((src) => { // Cancel on the browser's bar, or the tab went away
  if (shared.has(src.tabId)) { shared.delete(src.tabId); saveShared(); badge(src.tabId, false); hello(); }
});
chrome.tabs.onRemoved.addListener((tabId) => { if (shared.has(tabId)) { shared.delete(tabId); saveShared(); hello(); } });
chrome.tabs.onUpdated.addListener((tabId, info) => { if (shared.has(tabId) && (info.title || info.url)) hello(); });

// ---------- what a shared tab does: requests and console ----------
const text = (a) => a.value !== undefined ? (typeof a.value === "string" ? a.value : JSON.stringify(a.value)) : a.unserializableValue ?? a.description ?? a.type;
function addLog(t, level, txt, where) {
  t.logTotal++;
  t.logs.push({ level, text: String(txt).slice(0, 4000), where });
  if (t.logs.length > MAX_LOG) t.logs.shift();
}
chrome.debugger.onEvent.addListener((src, method, p) => {
  const t = shared.get(src.tabId);
  if (!t) return;
  if (method === "Network.requestWillBeSent") {
    const old = t.reqs.get(p.requestId);
    if (old && p.redirectResponse) { old.status = p.redirectResponse.status; old.statusText = p.redirectResponse.statusText; old.responseHeaders = p.redirectResponse.headers; old.redirected = true; }
    const e = { n: ++t.n, id: p.requestId, method: p.request.method, url: p.request.url, type: p.type || "", start: p.timestamp, requestHeaders: p.request.headers || {}, postData: p.request.postData || "", hasPostData: !!p.request.hasPostData };
    t.reqs.set(p.requestId, e);
    t.list.push(e);
    if (t.list.length > MAX_REQ) { const gone = t.list.shift(); if (t.reqs.get(gone.id) === gone) t.reqs.delete(gone.id); }
  } else if (method === "Network.responseReceived") {
    const e = t.reqs.get(p.requestId);
    if (e) { e.status = p.response.status; e.statusText = p.response.statusText; e.responseHeaders = p.response.headers || {}; e.mime = p.response.mimeType; e.type = p.type || e.type; }
  } else if (method === "Network.loadingFinished") {
    const e = t.reqs.get(p.requestId);
    if (e) { e.size = p.encodedDataLength; e.ms = Math.round((p.timestamp - e.start) * 1000); e.done = true; }
  } else if (method === "Network.loadingFailed") {
    const e = t.reqs.get(p.requestId);
    if (e) { e.failed = p.blockedReason ? `blocked: ${p.blockedReason}` : p.canceled ? "canceled" : p.errorText || "failed"; e.ms = Math.round((p.timestamp - e.start) * 1000); }
  } else if (method === "Runtime.consoleAPICalled") {
    const f = p.stackTrace?.callFrames?.[0];
    addLog(t, p.type === "warning" ? "warning" : p.type, (p.args || []).map(text).join(" "), f ? `${f.url}:${f.lineNumber + 1}` : "");
  } else if (method === "Runtime.exceptionThrown") {
    const d = p.exceptionDetails || {};
    addLog(t, "error", d.exception?.description || d.text || "Uncaught error", d.url ? `${d.url}:${(d.lineNumber || 0) + 1}` : "");
  } else if (method === "Log.entryAdded") {
    const e = p.entry || {};
    addLog(t, e.level === "warning" ? "warning" : e.level, e.text, e.url ? `${e.url}${e.lineNumber != null ? `:${e.lineNumber + 1}` : ""}` : e.source || "");
  } else if (method === "Page.loadEventFired") {
    for (const w of t.loadWaiters.splice(0)) w();
  }
});

// ---------- the brain's steps ----------
async function tabInfo(id) { try { const t = await chrome.tabs.get(id); return { id, title: t.title || "", url: t.url || "" }; } catch { return { id, title: "", url: "" }; } }
async function tabList() { return Promise.all([...shared.entries()].sort((a, b) => b[1].at - a[1].at).map(([id]) => tabInfo(id))); }
function pickTab(a) {
  if (!shared.size) return { why: "No tab is shared. Ask the user to open the page and click the AI Brain extension button there, then Share this tab." };
  if (a.tab !== undefined && a.tab !== null) {
    if (!shared.has(Number(a.tab))) return { why: `Tab ${a.tab} is not shared. Use web_tabs to see the shared tabs.` };
    return { id: Number(a.tab) };
  }
  return { id: [...shared.entries()].sort((x, y) => y[1].at - x[1].at)[0][0] };
}
async function evaluate(id, expression, awaitPromise = true) {
  const r = await dbg(id, "Runtime.evaluate", { expression, returnByValue: true, awaitPromise, replMode: true, userGesture: false, timeout: 15000 });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "error");
  return r.result;
}
// Like the DevTools console: statements and top-level await work, a promise that comes back is awaited,
// and objects come back as values (JSON).
async function evalFull(id, expression) {
  const group = "ai-brain";
  try {
    const r = await dbg(id, "Runtime.evaluate", { expression, objectGroup: group, awaitPromise: true, replMode: true, userGesture: false, timeout: 15000 });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "error");
    let res = r.result;
    if (res.subtype === "promise" && res.objectId) {
      const w = await dbg(id, "Runtime.awaitPromise", { promiseObjectId: res.objectId, returnByValue: true });
      if (w.exceptionDetails) throw new Error(w.exceptionDetails.exception?.description || w.exceptionDetails.text || "the promise failed");
      return w.result;
    }
    if (res.objectId) {
      try {
        const v = await dbg(id, "Runtime.callFunctionOn", { objectId: res.objectId, functionDeclaration: "function () { return this; }", returnByValue: true });
        if (!v.exceptionDetails && v.result.value !== undefined) return { ...v.result, subtype: res.subtype };
      } catch { /* not serializable (a DOM node, a window): its description below */ }
    }
    return res;
  } finally { dbg(id, "Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {}); }
}
const DEFAULT_STYLES = ["display", "position", "top", "left", "right", "bottom", "width", "height", "margin", "padding", "border", "box-sizing", "overflow", "z-index",
  "flex", "flex-direction", "justify-content", "align-items", "gap", "grid-template-columns", "color", "background-color", "background-image", "opacity", "visibility",
  "font-family", "font-size", "font-weight", "line-height", "text-align", "transform", "transition", "cursor", "pointer-events"];

async function run(cmd, a) {
  if (cmd === "tabs") return { ok: true, tabs: await tabList() };
  const p = pickTab(a);
  if (p.why) return { ok: false, why: p.why };
  const id = p.id, t = shared.get(id), tab = await tabInfo(id);
  if (cmd === "html") {
    const sel = a.selector ? String(a.selector) : "";
    const v = (await evaluate(id, `(() => { const s = ${JSON.stringify(sel)}; if (!s) return { html: document.documentElement.outerHTML, count: 1 }; const all = document.querySelectorAll(s); return { html: all[0] ? all[0].outerHTML : null, count: all.length }; })()`)).value;
    if (v?.html == null) return { ok: false, why: `Nothing on the page matches ${sel}.` };
    return { ok: true, tab, selector: sel, count: v.count, html: v.html, max: Number(a.max) || 60000 };
  }
  if (cmd === "eval") {
    try {
      const r = await evalFull(id, String(a.expression || ""));
      let value;
      if (r.type === "undefined") value = "undefined";
      else if (r.value !== undefined) value = typeof r.value === "string" ? r.value : JSON.stringify(r.value, null, 2);
      else value = r.unserializableValue ?? r.description ?? String(r.type);
      return { ok: true, tab, type: r.subtype || r.type, value };
    } catch (e) { return { ok: true, tab, error: String(e.message || e) }; }
  }
  if (cmd === "network") {
    const f = String(a.filter || "").toLowerCase();
    const all = t.list.filter((e) => !f || e.url.toLowerCase().includes(f));
    const limit = Math.max(1, Math.min(300, Number(a.limit) || 80));
    return { ok: true, tab, filter: f, total: all.length, requests: all.slice(-limit).map((e) => ({ n: e.n, method: e.method, status: e.status, type: e.type, url: e.url.slice(0, 600), size: e.size, ms: e.ms, failed: e.failed })) };
  }
  if (cmd === "response") {
    const e = t.list.find((x) => x.n === Number(a.request));
    if (!e) return { ok: false, why: `There is no request #${a.request} (the list keeps the last ${MAX_REQ}). Use web_network.` };
    let body = null, base64 = false, bodyWhy = "";
    if (e.redirected) bodyWhy = "a redirect has no body";
    else {
      try { const b = await dbg(id, "Network.getResponseBody", { requestId: e.id }); body = b.body; base64 = !!b.base64Encoded; }
      catch (err) { bodyWhy = `not kept by the browser (${err.message || err})`; }
    }
    let postData = e.postData;
    if (!postData && e.hasPostData) { try { postData = (await dbg(id, "Network.getRequestPostData", { requestId: e.id })).postData; } catch { /* gone */ } }
    return { ok: true, tab, n: e.n, method: e.method, url: e.url, status: e.status, statusText: e.statusText, requestHeaders: e.requestHeaders, responseHeaders: e.responseHeaders, postData, body, base64, bodyWhy };
  }
  if (cmd === "console") {
    const lv = a.level === "errors" ? ["error"] : a.level === "warnings" ? ["warning", "error"] : null;
    const all = t.logs.filter((m) => !lv || lv.includes(m.level));
    const limit = Math.max(1, Math.min(300, Number(a.limit) || 100));
    return { ok: true, tab, total: t.logTotal, messages: all.slice(-limit) };
  }
  if (cmd === "cookies") {
    const r = await dbg(id, "Network.getCookies", { urls: [tab.url] });
    const values = a.include_values === true;
    return { ok: true, tab, values, cookies: (r.cookies || []).map((c) => ({ name: c.name, ...(values ? { value: c.value } : {}), domain: c.domain, path: c.path, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite || "", session: c.session, expires: c.expires })) };
  }
  if (cmd === "styles") {
    const props = Array.isArray(a.properties) && a.properties.length ? a.properties.map(String).slice(0, 60) : DEFAULT_STYLES;
    const v = (await evaluate(id, `(() => { const all = document.querySelectorAll(${JSON.stringify(String(a.selector || ""))}); const el = all[0]; if (!el) return null; const cs = getComputedStyle(el), b = el.getBoundingClientRect(); const out = {}; for (const p of ${JSON.stringify(props)}) out[p] = cs.getPropertyValue(p); return { count: all.length, styles: out, box: { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }; })()`)).value;
    if (!v) return { ok: false, why: `Nothing on the page matches ${a.selector}.` };
    return { ok: true, tab, selector: String(a.selector), ...v };
  }
  if (cmd === "screenshot") {
    let shot = await dbg(id, "Page.captureScreenshot", { format: "png" }), type = "image/png";
    if (shot.data.length > 5_000_000) { shot = await dbg(id, "Page.captureScreenshot", { format: "jpeg", quality: 80 }); type = "image/jpeg"; }
    let w = 0, h = 0;
    try { const m = await dbg(id, "Page.getLayoutMetrics"); w = m.cssVisualViewport.clientWidth; h = m.cssVisualViewport.clientHeight; } catch { /* unknown */ }
    return { ok: true, tab, w: Math.round(w), h: Math.round(h), image: { data: shot.data, type } };
  }
  if (cmd === "go") {
    const url = a.url ? String(a.url) : "";
    if (url && !/^https?:\/\//i.test(url)) return { ok: false, why: "Only http and https addresses can be opened." };
    const loaded = new Promise((res) => { t.loadWaiters.push(() => res(true)); setTimeout(() => res(false), 20000); });
    if (url) await dbg(id, "Page.navigate", { url });
    else await dbg(id, "Page.reload", { ignoreCache: a.bypass_cache === true });
    const ok = await loaded;
    return { ok: true, tab: await tabInfo(id), loaded: ok, did: url ? `Opened ${url}.` : a.bypass_cache ? "Reloaded without the cache." : "Reloaded." };
  }
  return { ok: false, why: "unknown step" };
}

// ---------- talking to AI Brain ----------
async function post(path, body) {
  const r = await fetch(cfg.url + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Brain-Key": cfg.code }, body: JSON.stringify(body) });
  let j = null;
  try { j = await r.json(); } catch { /* no body */ }
  return { status: r.status, body: j };
}
async function hello() {
  await ready;
  if (!cfg.code) { status = { state: "unpaired", why: "" }; return status; }
  try {
    const r = await post("/api/inspect/ext/hello", { version: VERSION, browser: browserName(), tabs: await tabList() });
    if (r.status === 403) status = { state: "wrong-code", why: r.body?.error || "Wrong pairing code." };
    else if (r.status === 200 && r.body?.app === "ai-brain") status = { state: "connected", why: r.body.enabled ? "" : "The brain is not allowed to inspect yet: switch it on in AI Brain (Settings > Web inspector)." };
    else status = { state: "offline", why: `AI Brain answered ${r.status}.` };
  } catch { status = { state: "offline", why: "AI Brain is not running on this computer." }; }
  return status;
}
// Asks AI Brain for work again and again (each ask waits up to 25 s). Stops when AI Brain is gone for
// a while; an alarm starts it again every minute.
async function loop() {
  await ready;
  if (polling || !cfg.code) return;
  polling = true;
  let misses = 0;
  try {
    while (cfg.code) {
      let r;
      try { r = await post("/api/inspect/ext/next", { version: VERSION, browser: browserName(), tabs: await tabList() }); }
      catch { status = { state: "offline", why: "AI Brain is not running on this computer." }; if (++misses > 5) break; await sleep(4000); continue; }
      misses = 0;
      if (r.status === 403) { status = { state: "wrong-code", why: r.body?.error || "Wrong pairing code." }; break; }
      if (r.status !== 200) { await sleep(3000); continue; }
      if (status.state !== "connected") status = { state: "connected", why: "" };
      const job = r.body;
      if (!job?.id) continue;
      let result;
      try { result = await run(String(job.cmd), job.args || {}); }
      catch (e) { result = { ok: false, why: String(e.message || e) }; }
      try { await post("/api/inspect/ext/answer", { id: job.id, result }); } catch { /* AI Brain went away */ }
    }
  } finally { polling = false; }
}
chrome.alarms.create("ai-brain", { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(() => loop());
chrome.runtime.onStartup.addListener(() => loop());
chrome.runtime.onInstalled.addListener(() => loop());
loop();

// ---------- the popup ----------
chrome.runtime.onMessage.addListener((m, _s, reply) => {
  (async () => {
    await ready;
    if (m.what === "state") {
      const tab = m.tabId ? await tabInfo(m.tabId) : null;
      return { status, paired: !!cfg.code, url: cfg.url, tab, sharedHere: !!m.tabId && shared.has(m.tabId), tabs: await tabList() };
    }
    if (m.what === "pair") {
      const code = String(m.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{5})(?!$)/g, "$1-");
      const url = /^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(String(m.url || "")) ? String(m.url) : DEF_URL;
      cfg = { url, code };
      await chrome.storage.local.set(cfg);
      const s = await hello();
      if (s.state === "connected") loop();
      return { status: s };
    }
    if (m.what === "unpair") { for (const id of [...shared.keys()]) await unshare(id); cfg.code = ""; await chrome.storage.local.set({ code: "" }); status = { state: "unpaired", why: "" }; return { status }; }
    if (m.what === "share") return share(Number(m.tabId));
    if (m.what === "unshare") { await unshare(Number(m.tabId)); return { ok: true }; }
    return { ok: false };
  })().then(reply, (e) => reply({ ok: false, why: String(e.message || e) }));
  return true;
});
