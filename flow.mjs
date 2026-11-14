// Google Flow for the brain (experimental, no API key).
// Google Flow has no way in for other programs, so AI Brain opens it in a browser window with a
// browser profile of its own (never your normal one) and a local control port. These functions
// use that port (the browser's DevTools protocol) to read the Flow page, click and type on it, and
// save the videos it makes. They only ever touch pages on labs.google - never other tabs, never
// cookies or passwords. Flow's page can change at any time, so nothing here depends on how it is
// built: the brain reads the page and decides what to click, like a person would.
import fs from "node:fs";
import path from "node:path";
import { MEDIA, loadSettings, readVideoUsage, recordVideo } from "./lib.mjs";

export const FLOW_PORT = Number(process.env.BRAIN_FLOW_PORT || 9447);
// Only pages that start with this are ever touched (a local test page in the tests).
const ORIGIN = (process.env.BRAIN_FLOW_ORIGIN || "https://labs.google").replace(/\/+$/, "");
const BASE = `http://127.0.0.1:${FLOW_PORT}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isFlow = (t) => t?.type === "page" && typeof t.url === "string" && (t.url === ORIGIN || t.url.startsWith(ORIGIN + "/"));

export const NOT_OPEN = "Google Flow is not open in AI Brain, or it was opened in a way the brain cannot use. Ask the user to close the Flow window, click Google Flow in the Apps panel (and sign in to Google there the first time), then try again.";

export const SIGN_IN = "Google Flow is waiting for the user to sign in to Google in the Flow window inside AI Brain. Ask the user to sign in there (only needed once), then try again.";
async function targets() {
  let list;
  try { list = await (await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(2500) })).json(); } catch { return { t: null, signIn: false } }
  list = Array.isArray(list) ? list : [];
  // Only the address is looked at: a Google sign-in page itself is never read or touched.
  return { t: list.find(isFlow) || null, signIn: list.some((x) => x?.type === "page" && /^https:\/\/accounts\.google\.com\//.test(String(x.url))) };
}
async function flowTarget() {
  for (let end = Date.now() + 8000; ; await sleep(1000)) {
    const { t, signIn } = await targets();
    if (t || !signIn) return t;
    if (Date.now() > end) throw new Error(SIGN_IN);
  }
}

/** Asks the AI Brain window to open Google Flow, then waits for its page. */
async function openAndWait(ms = 45000) {
  let t = await flowTarget();
  if (t) return t;
  const app = process.env.AI_BRAIN_APP_URL;
  if (app) {
    try { await fetch(`${app}/api/flow/open`, { method: "POST", headers: { Origin: app, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(5000) }); }
    catch { /* the window will not open it: reported below */ }
    for (let end = Date.now() + ms; Date.now() < end; ) { await sleep(1000); if ((t = await flowTarget())) return t; }
  }
  throw new Error(NOT_OPEN);
}

// One DevTools connection to the Flow page.
class Page {
  static async open() {
    const t = await openAndWait();
    const p = new Page();
    p.url = t.url;
    p.ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((ok, bad) => { p.ws.addEventListener("open", ok, { once: true }); p.ws.addEventListener("error", () => bad(new Error("Could not connect to the Google Flow window.")), { once: true }); });
    p.n = 0; p.wait = new Map();
    p.ws.addEventListener("message", (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      const w = m.id && p.wait.get(m.id);
      if (w) { p.wait.delete(m.id); m.error ? w.bad(new Error(m.error.message || "Flow page error")) : w.ok(m.result); }
    });
    p.ws.addEventListener("close", () => { for (const w of p.wait.values()) w.bad(new Error("The Google Flow window closed.")); p.wait.clear(); });
    return p;
  }
  call(method, params = {}, ms = 30000) {
    const id = ++this.n;
    return new Promise((ok, bad) => {
      const timer = setTimeout(() => { this.wait.delete(id); bad(new Error(`Google Flow did not answer (${method}).`)); }, ms);
      this.wait.set(id, { ok: (r) => { clearTimeout(timer); ok(r); }, bad: (e) => { clearTimeout(timer); bad(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Runs a function in the page with JSON arguments and returns its JSON result. */
  async run(fn, ...args) {
    // Functions given as arguments go in as code, everything else as JSON (no eval inside the page).
    const list = args.map((a) => (typeof a === "function" ? a.toString() : JSON.stringify(a ?? null))).join(", ");
    const r = await this.call("Runtime.evaluate", { expression: `(${fn})(${list})`, awaitPromise: true, returnByValue: true, userGesture: true }, 120000);
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "Flow page error");
    return r.result?.value;
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}
async function withPage(fn) {
  const p = await Page.open();
  try {
    // The page may have moved somewhere else since it was found (for example a Google sign-in page).
    let href = "";
    for (let end = Date.now() + 15000; Date.now() < end; await sleep(400)) {
      const s = await p.run(() => ({ href: location.href, ready: document.readyState }));
      href = s.href;
      if (href !== "about:blank" && s.ready !== "loading") break;
    }
    if (!(href === ORIGIN || href.startsWith(ORIGIN + "/"))) throw new Error(`The Flow window is showing another site (${new URL(href).host}). Ask the user to finish there (for example signing in), then try again.`);
    return await fn(p);
  } finally { p.close(); }
}

// ---------- in-page helpers (run inside the Flow page) ----------
// Everything you can click or type in, numbered in page order, with the words a person sees.
const CONTROLS = () => {
  const vis = (el) => { const r = el.getBoundingClientRect(), s = getComputedStyle(el); return r.width > 2 && r.height > 2 && s.visibility !== "hidden" && s.display !== "none" && +s.opacity !== 0; };
  const label = (el) => (el.getAttribute("aria-label") || el.innerText || el.value || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") || "").replace(/\s+/g, " ").trim().slice(0, 90);
  const sel = 'button, a[href], [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], input, textarea, select, [contenteditable="true"], [contenteditable=""]';
  const out = [];
  for (const el of document.querySelectorAll(sel)) {
    if (!vis(el) || el.closest("[aria-hidden='true']")) continue;
    const kind = el.matches("textarea, [contenteditable], input:not([type]), input[type=text], input[type=search]") ? "field" : el.tagName === "SELECT" ? "list" : el.tagName === "INPUT" ? `input-${el.type}` : "button";
    out.push({ el, kind, label: label(el), disabled: !!(el.disabled || el.getAttribute("aria-disabled") === "true") });
  }
  return out;
};
const VIDEOS = () => [...document.querySelectorAll("video")].map((v) => v.currentSrc || v.src || v.querySelector("source")?.src || "").filter(Boolean);

function lookFn(controlsFn, videosFn) {
  const controls = controlsFn(), videos = videosFn();
  const text = (document.body?.innerText || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return {
    url: location.href, title: document.title,
    text: text.length > 5000 ? text.slice(0, 5000) + "\n[...]" : text,
    controls: controls.slice(0, 120).map((c, i) => `${i + 1}. [${c.kind}${c.disabled ? ", disabled" : ""}] ${c.label || "(no label)"}`),
    videos: videos.length,
  };
}
// Finds a control by its number from flow_look or by its words (exact first, then "contains").
function findFn(controlsFn, what, kind) {
  const every = controlsFn();
  const all = every.filter((c) => !kind || c.kind === kind || (kind === "button" && c.kind !== "field"));
  let c = null;
  if (/^\d+$/.test(String(what))) c = every[Number(what) - 1] || null;
  else {
    const w = String(what || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (w) c = all.find((x) => x.label.toLowerCase() === w) || all.find((x) => x.label.toLowerCase().includes(w)) || null;
    else if (kind === "field") c = all.filter((x) => x.kind === "field").sort((a, b) => { const r = (e) => e.el.getBoundingClientRect(); return r(b).width * r(b).height - r(a).width * r(a).height; })[0] || null;
  }
  if (!c) return null;
  c.el.scrollIntoView({ block: "center", inline: "center" });
  const r = c.el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, label: c.label, kind: c.kind, disabled: c.disabled };
}

async function clickAt(p, x, y) {
  for (const type of ["mouseMoved", "mousePressed", "mouseReleased"])
    await p.call("Input.dispatchMouseEvent", { type, x, y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: type === "mouseMoved" ? 0 : 1 });
}
async function key(p, k, code, vk, modifiers = 0, text, commands) {
  await p.call("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, modifiers, ...(text ? { text } : {}), ...(commands ? { commands } : {}) });
  await p.call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers });
}

// ---------- what the brain can do ----------
export async function flowLook() {
  return withPage(async (p) => {
    const r = await p.run(lookFn, CONTROLS, VIDEOS);
    return `Google Flow page: ${r.title}\n${r.url}\n\nWhat the page says:\n${r.text}\n\nThings you can click or type in (use the number or the words with flow_click / flow_type):\n${r.controls.join("\n") || "(none)"}\n\nVideos on the page: ${r.videos}`;
  });
}

export async function flowClick(what) {
  checkLimit();
  return withPage(async (p) => {
    const at = await p.run(findFn, CONTROLS, what, "button");
    if (!at) throw new Error(`Nothing called "${what}" is on the Flow page. Use flow_look to see what is there.`);
    if (at.disabled) throw new Error(`"${at.label}" is greyed out on the Flow page right now.`);
    await sleep(150);
    await clickAt(p, at.x, at.y);
    await sleep(800);
    return `Clicked "${at.label || what}".`;
  });
}

export async function flowType(text, field = "", enter = false) {
  checkLimit();
  return withPage(async (p) => {
    const at = await p.run(findFn, CONTROLS, field, "field");
    if (!at) throw new Error(field ? `No text box called "${field}" is on the Flow page.` : "No text box is on the Flow page. Use flow_look to see what is there.");
    await clickAt(p, at.x, at.y);
    await sleep(150);
    await key(p, "a", "KeyA", 65, 2, undefined, ["selectAll"]); // Ctrl+A: replace what is there
    await key(p, "Delete", "Delete", 46);
    await p.call("Input.insertText", { text: String(text) });
    if (enter) { await sleep(200); await key(p, "Enter", "Enter", 13, 0, "\r"); }
    await sleep(500);
    return `Typed into "${at.label || "the text box"}"${enter ? " and pressed Enter" : ""}.`;
  });
}

async function videoList(p) { return (await p.run(VIDEOS)) || []; }

/** Waits up to `seconds` until the words appear on the page or a new video shows up. */
export async function flowWait(seconds = 60, words = "") {
  return withPage(async (p) => {
    const start = new Set(await videoList(p));
    const end = Date.now() + Math.min(900, Math.max(2, seconds)) * 1000;
    const w = String(words || "").toLowerCase();
    while (Date.now() < end) {
      await sleep(2000);
      if (w && (await p.run(() => document.body.innerText.toLowerCase())).includes(w)) return `"${words}" is on the page now.`;
      const now = await videoList(p);
      if (!w && now.some((v) => !start.has(v))) return `A new video is on the page (${now.length} in total). Save it with flow_save_videos.`;
    }
    return `Waited ${seconds} seconds; ${w ? `"${words}" did not appear` : "no new video appeared"}. Use flow_look to see the page.`;
  });
}

// Reads one video's bytes inside the page (it may need the user's Google sign-in), in parts.
async function grab(p, src) {
  const size = await p.run(async (u) => {
    const r = await fetch(u, { credentials: "include" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    window.__brainVideo = new Uint8Array(await r.arrayBuffer());
    return window.__brainVideo.length;
  }, src).catch(() => 0);
  if (size) {
    const parts = [];
    for (let at = 0; at < size; at += 3 << 20) {
      const b64 = await p.run((from, to) => { const a = window.__brainVideo.subarray(from, to); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode.apply(null, a.subarray(i, i + 0x8000)); return btoa(s); }, at, Math.min(size, at + (3 << 20)));
      parts.push(Buffer.from(b64, "base64"));
    }
    await p.run(() => { delete window.__brainVideo; return true; });
    return Buffer.concat(parts);
  }
  // A plain web address of a video file (no sign-in needed) can be fetched directly.
  if (/^https:\/\//.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(120000) });
    if (r.ok) return Buffer.from(await r.arrayBuffer());
  }
  throw new Error("Could not read that video from the Flow page. The user can download it in Flow instead.");
}

const SAVED = new Set(); // videos already saved by this helper (by address), so they are not saved twice
let counted = 0;         // videos flow_make_video already counted toward the daily limit, not saved yet
export async function flowSaveVideos(count = 1, skip = []) {
  return withPage(async (p) => {
    const all = [...new Set(await videoList(p))].filter((v) => !skip.includes(v));
    const pick = all.filter((v) => !SAVED.has(v)).slice(-Math.max(1, Math.min(8, count)));
    if (!pick.length) return all.length ? "Those videos were saved already." : "There is no video on the Flow page yet.";
    fs.mkdirSync(MEDIA, { recursive: true });
    const saved = [];
    for (const src of pick) {
      const buf = await grab(p, src);
      if (buf.length < 1000) continue;
      const ext = buf.subarray(4, 8).toString("latin1") === "ftyp" ? ".mp4" : buf.subarray(0, 4).toString("hex") === "1a45dfa3" ? ".webm" : ".mp4";
      const dest = path.join(MEDIA, `${Date.now().toString(36)}-flow${ext}`);
      fs.writeFileSync(dest, buf);
      SAVED.add(src);
      saved.push(dest);
      // Every saved video counts toward "Videos per day at most" (once).
      if (counted > 0) counted--; else recordVideo({ model: "google-flow", seconds: 8, ok: true });
    }
    if (!saved.length) throw new Error("No video could be saved from the Flow page.");
    return `Saved from Google Flow:\n${saved.join("\n")}`;
  });
}

export function checkLimit() {
  const s = loadSettings();
  if (s.videoDailyLimit && readVideoUsage().today >= s.videoDailyLimit)
    throw new Error(`Today's video limit (${s.videoDailyLimit}) is reached. You can raise it in Settings, under Video.`);
}

/**
 * The whole job in one step: types the description into Flow's prompt box, starts it, waits for the
 * new video and saves it. Flow's page can change; if a step fails, the brain can use the small tools.
 */
export async function flowMakeVideo(prompt, waitSeconds = 480) {
  checkLimit();
  const before = await withPage((p) => videoList(p));
  await flowType(prompt, "", false);
  // Start it: a button that says create / generate / send (or an arrow icon), else Enter.
  const start = await withPage(async (p) => {
    for (const w of ["create", "generate", "send", "submit", "arrow_forward", "make"]) {
      const at = await p.run(findFn, CONTROLS, w, "button");
      if (at && !at.disabled) { await clickAt(p, at.x, at.y); return at.label || w; }
    }
    await key(p, "Enter", "Enter", 13, 0, "\r");
    return "Enter";
  });
  recordVideo({ model: "google-flow", seconds: 8, ok: true });
  counted++;
  const end = Date.now() + Math.min(900, Math.max(30, waitSeconds)) * 1000;
  let fresh = [];
  while (Date.now() < end && !fresh.length) {
    await sleep(3000);
    fresh = (await withPage((p) => videoList(p))).filter((v) => !before.includes(v));
  }
  if (!fresh.length) return `Started it in Google Flow (with "${start}"), but no new video appeared within ${Math.round(waitSeconds / 60)} minutes. Use flow_look to see the page, flow_wait to wait longer, then flow_save_videos.`;
  await sleep(1500); // let the new video finish loading
  return flowSaveVideos(fresh.length, before);
}
