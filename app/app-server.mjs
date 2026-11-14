#!/usr/bin/env node
// AI Brain app server. Runs Claude (headless, subscription login) as the brain;
// Claude calls the helper AIs through the ai-brain MCP server. Every real event is
// streamed to the dashboard over Server-Sent Events and saved per session.
// Local only: binds 127.0.0.1 and rejects requests from other origins.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  askChatGPT, askGemini, generateImage, listGeminiModels, loadState, updateState, runExe, readGeminiUsage, readChatGPTUsage,
  generateVideo, googleKeyState, saveGoogleKey, removeGoogleKey, listVideoModels, readVideoUsage, NO_VIDEO_KEY, VIDEO_MODELS, isVeo,
  loadSettings, saveSettings, readJson, writeJson,
  HERE as ROOT, DATA, WORK, MEDIA, LOGS, MEDIA_RE, CODEX_JS, AGY_EXE,
  isDiscordChat,
} from "../lib.mjs";
import { musicStatus, musicCommand, musicArt, openApp, stopMusic } from "./music.mjs";
import buildStamp from "../build-stamp.cjs";
import { discordStatus, openDiscord, openDiscordChat } from "./discord.mjs";

const VERSION = "3.1.0";
// Fingerprint of this server's own files when it started (see build-stamp.cjs).
const BUILD = buildStamp(path.join(path.dirname(fileURLToPath(import.meta.url)), ".."));
const APP = path.dirname(fileURLToPath(import.meta.url));
const PUB = path.join(APP, "public");
const UPLOADS = path.join(WORK, "uploads");
const SESSIONS = path.join(DATA, "sessions");
const CUSTOM = path.join(DATA, "custom");
const PROMPTS_FILE = path.join(DATA, "prompts.json");
const SAVED_FILE = path.join(DATA, "saved.json");
const PORT = Number(process.env.BRAIN_PORT || 4777);
const HOST = "127.0.0.1";
const BRAIN_TIMEOUT_MS = Number(process.env.BRAIN_TASK_TIMEOUT_MS || 20 * 60_000);
const SERVER_LOG = path.join(DATA, "app.log");
// Test hooks: a script that plays the part of Claude, and "do not open Explorer windows".
const FAKE_BRAIN = process.env.BRAIN_FAKE_CLAUDE || null;
const NO_OPEN = process.env.BRAIN_NO_OPEN === "1";
for (const d of [UPLOADS, SESSIONS, CUSTOM]) fs.mkdirSync(d, { recursive: true });

const slog = (...a) => { try { fs.appendFileSync(SERVER_LOG, `[${new Date().toISOString()}] ${a.join(" ")}\n`); } catch {} };
const inside = (dir, file) => path.resolve(file).startsWith(path.resolve(dir) + path.sep);

function findClaude() {
  if (process.env.CLAUDE_EXE) return process.env.CLAUDE_EXE;
  const c = [
    path.join(os.homedir(), ".local", "bin", "claude.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "claude.exe"),
  ];
  return c.find((p) => fs.existsSync(p)) || "claude";
}
const CLAUDE_EXE = findClaude();

// MCP config handed to the brain: only our ai-brain server (nothing else the user has installed).
const MCP_CFG = path.join(DATA, "brain-mcp.json");
// key = the one-task key that lets the approve tool ask the user (only while access is "ask" or "auto").
// It can only ASK; the answer always comes from a click in the window.
// ctlKey = the one-task key that lets the brain's app_ tools use the program in the middle, and its
// web_ tools inspect the tabs shared with the AI Brain browser extension (only while those settings
// are on). It ends with the task.
let ctlKey = null, ctlTask = "";
function writeMcpConfig(s = loadSettings(), key = null) {
  const env = { AI_BRAIN_CHATGPT: s.chatgptEnabled ? "1" : "0", BRAIN_DATA_DIR: DATA, AI_BRAIN_FLOW: s.flowBrain ? "1" : "0", AI_BRAIN_APPS: s.appsBrain && ctlKey ? "1" : "0",
    AI_BRAIN_INSPECT: s.inspectBrain && ctlKey ? "1" : "0", AI_BRAIN_APP_URL: `http://${HOST}:${PORT}` };
  for (const k of ["BRAIN_FLOW_PORT", "BRAIN_FLOW_ORIGIN"]) if (process.env[k]) env[k] = process.env[k];
  if (key) Object.assign(env, { AI_BRAIN_APPROVE_URL: `http://${HOST}:${PORT}/api/approval/ask`, AI_BRAIN_APPROVE_KEY: key });
  if ((s.appsBrain || s.inspectBrain) && ctlKey) env.AI_BRAIN_CONTROL_KEY = ctlKey;
  writeJson(MCP_CFG, { mcpServers: { "ai-brain": { command: process.execPath, args: [path.join(ROOT, "server.mjs")], env } } });
}

// ---------- folders the brain may work in (access "ask") ----------
const HOME = os.homedir();
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const within = (child, parent) => { const r = path.relative(path.resolve(parent).toLowerCase(), path.resolve(child).toLowerCase()); return r === "" || (!!r && !r.startsWith("..") && !path.isAbsolute(r)); };
/** Why a folder cannot be given to the brain, or "" when it is fine. */
function folderProblem(f) {
  if (typeof f !== "string" || !/^[A-Za-z]:[\\/]/.test(f)) return "Use a full folder path, like C:\\Users\\you\\Documents\\notes.";
  const p = path.resolve(f);
  if (samePath(p, path.parse(p).root)) return "A whole drive is too much. Pick a folder inside it.";
  if (within(HOME, p)) return "Your whole user folder is too much (it holds app data and sign-ins). Pick a folder inside it.";
  for (const no of [path.join(HOME, "AppData"), path.join(HOME, ".claude"), path.join(HOME, ".codex"), path.join(HOME, ".gemini"), process.env.WINDIR || "C:\\Windows"]) {
    if (within(p, no) && !within(p, os.tmpdir())) return "That folder holds app data or system files. Pick one of your own folders.";
  }
  try { if (!fs.statSync(p).isDirectory()) return "That is not a folder."; } catch { return "That folder does not exist."; }
  return "";
}
const usableFolders = (s) => [...new Set(s.folders.map((f) => path.resolve(f)))].filter((f) => !folderProblem(f));
const HELPER_TOOLS = new Set(["ask_gemini", "ask_chatgpt", "ask_both", "generate_image", "generate_video", "flow_make_video", "flow_save_videos"]);
const FLOW_TOOLS = ["flow_make_video", "flow_look", "flow_click", "flow_type", "flow_wait", "flow_save_videos"];
// app_python is left out on purpose: running Python inside Blender or Krita can do anything a program
// can, so it goes through the approve tool like a command (asks in "ask", runs in "auto", refused in "read").
const APP_TOOLS = ["app_open", "app_look", "app_click", "app_type", "app_key", "app_scroll", "app_drag", "app_act", "app_commands", "app_command"];
const WEB_TOOLS = ["web_tabs", "web_html", "web_eval", "web_network", "web_response", "web_console", "web_cookies", "web_styles", "web_screenshot", "web_go"];
const ASK_RULES = JSON.stringify({ permissions: { ask: ["PowerShell", "Bash", "Write", "Edit", "NotebookEdit"] } });
const brainTools = (s) =>
  [...(s.chatgptEnabled ? ["ask_chatgpt", "ask_gemini", "ask_both", "generate_image"] : ["ask_gemini", "generate_image"]),
    ...(googleKeyState().connected ? ["generate_video"] : []), ...(s.flowBrain ? FLOW_TOOLS : []), ...(s.appsBrain ? APP_TOOLS : []),
    ...(s.inspectBrain ? WEB_TOOLS : [])].map((t) => `mcp__ai-brain__${t}`);
const videoName = (id) => VIDEO_MODELS.find((m) => m.id === id)?.label.replace(/ \(.*/, "") || String(id).replace(/^models\//, "");

function systemPrompt(s) {
  const lines = ['You are the BRAIN of the "AI Brain" desktop app. The user types tasks into the app; you coordinate helper AIs:'];
  if (s.chatgptEnabled) lines.push("- ChatGPT (tool ask_chatgpt) - the user's ChatGPT subscription.");
  lines.push("- Gemini (tool ask_gemini) - the user's Google subscription. Gemini can GENERATE IMAGES (tool generate_image, or ask it). Gemini itself cannot make video or audio.");
  if (googleKeyState().connected) lines.push(`- VIDEO (tool generate_video) - Google ${videoName(s.videoModel)} makes one short clip (about 8 seconds, with sound) from a description. It costs the user money for every clip and takes a few minutes. Use it only when the user asks for a video, and make exactly as many clips as they asked for (one unless they say otherwise). Write a rich prompt: subject, action, camera movement, style, lighting, sounds. Never retry a failed video more than once.`);
  else if (!s.flowBrain) lines.push("- Video is not connected: if the user asks for a video, tell them to add their Google API key in Settings > Video (or to open Google Flow from the Apps panel).");
  if (s.flowBrain) lines.push(`- GOOGLE FLOW (tools flow_make_video, flow_look, flow_click, flow_type, flow_wait, flow_save_videos) - Google's video maker (Veo 3.1) in a window inside AI Brain, using the user's own Google plan (no API key; it uses their Flow credits). ${googleKeyState().connected ? "Prefer generate_video; use Flow when the user asks for Flow or when generate_video fails." : "Use it when the user asks for a video."} Start with flow_make_video (one call per video). If it reports a problem, use flow_look to read the page, then flow_click / flow_type / flow_wait / flow_save_videos like a person would. If Flow asks the user to sign in or to accept something, stop and tell the user. Make only as many videos as the user asked for. You cannot watch the saved video: say what you asked Flow for, never describe sounds or details as if you had seen them.`);
  if (s.appsBrain) lines.push([
    "- PROGRAMS (tools app_open, app_look, app_commands, app_command, app_python, app_act, app_click, app_type, app_key, app_scroll, app_drag) - you can USE the program shown in the middle of AI Brain (Blender, Krita, the Craft apps, an editor, a browser...).",
    "  app_open opens one of the programs the user added to the Apps panel; app_look gives a picture of the program and a numbered list of its buttons, menus and boxes (positions are picture pixels).",
    "  Use the best way the program offers, in this order:",
    "  1. BRIDGE (no mouse, works inside the program; best): the Craft apps (PhotoCraft, VectorCraft, FilmCraft, LightCraft, DesignCraft, FigCraft, DeckCraft, WordCraft, GridCraft, CADCraft, SoundCraft...) take commands - app_commands lists them (filter by a word; name gives one command's full parameters) and app_command runs one; their results can include pictures. AniCraft, EffectCraft, MaterialCraft, TextureCraft and Craft Anything have a HEADLESS bridge: it works on files, not on the window - make or edit a file, save it, then open it in the app. Blender and Krita run Python inside the live program with app_python (bpy in Blender; Krita.instance() as `app` in Krita); the value of a last expression comes back, and so does what you print. app_python is checked like a command: the user may have to allow it, and it is refused while File and command access is off in Settings (then say so, and use the other ways). The bridge only exists when AI Brain opened the program (app_open or the Apps panel); if it says the program was opened outside AI Brain, ask the user to close it and open it again with app_open.",
    "  2. BACKGROUND CONTROLS (no mouse): app_act presses, fills in (set), ticks, picks, opens or shows a thing from the app_look list through Windows accessibility - for normal programs (editors, settings, Office, many web apps). Prefer it to clicking whenever the thing is listed.",
    "  3. MOUSE AND KEYBOARD (last resort; the user sees the pointer move): app_click, app_type, app_key, app_scroll, app_drag. Click by the number from the list when the thing is listed, otherwise by x and y in the picture. Programs that draw everything themselves list almost nothing: use the picture and their keyboard shortcuts then.",
    "  Every step returns what happened (and most return a new picture): check it before the next step.",
    "  Rules: use the program only for what the user asked. Never type passwords or sign in for the user, never buy, pay, send messages or post anything, and never delete, close without saving or overwrite the user's work unless the user asked for exactly that; when the program asks about any of those, stop and ask the user. If the user moves the mouse, you stop: the user is taking over; say what you did and what is left. Work in clear steps and tell the user briefly what you did in the program.",
  ].join("\n"));
  if (s.inspectBrain) lines.push([
    "- WEB INSPECTOR (tools web_tabs, web_html, web_eval, web_network, web_response, web_console, web_cookies, web_styles, web_screenshot, web_go) - like a web developer's DevTools, on the tabs the user SHARED with the AI Brain extension in their own browser (Brave), signed in as the user.",
    "  Start with web_tabs. Each tool works on one shared tab (the last one shared, unless you give tab). web_html reads the live page code (or one part, by CSS selector); web_eval runs JavaScript in the page and returns the result; web_network lists the requests the page made since it was shared (reload with web_go to see a page load from the start), web_response shows one of them in full; web_console shows console messages and errors; web_cookies, web_styles and web_screenshot do what they say.",
    "  Rules: these tabs are the user's real accounts. Only inspect for what the user asked. Read, but do not change anything (no web_eval that clicks, submits, buys, posts, sends, deletes or changes settings) unless the user asked for exactly that. Never put passwords, cookie values, tokens or personal data in your answer unless the user asked for that exact item. If a tab is not shared, ask the user to open it and click the AI Brain extension button there.",
  ].join("\n"));
  if (s.chatgptEnabled) {
    lines.push("How to work: decide what each helper is best at, delegate sub-tasks (in parallel with ask_both when useful), compare and combine their answers, check their work, and give the user one clear final answer.");
    lines.push("If a helper fails (for example it is not signed in), carry on with the other one and tell the user briefly.");
  } else {
    lines.push("ChatGPT is switched off in the app's settings, so Gemini is your only helper. Do not mention ChatGPT unless the user asks; if they ask, tell them it can be switched on in Settings.");
    lines.push("How to work: delegate sub-tasks to Gemini when a second opinion, extra ideas or an image helps; check its work; then give the user one clear final answer. If Gemini fails, carry on alone and tell the user briefly.");
  }
  lines.push("For image requests, write a strong detailed image prompt and use generate_image. You may also answer directly when a helper is not needed.");
  lines.push("You run non-interactively: do not ask follow-up questions unless truly necessary. Your answer is shown to the user as Markdown; keep it well formatted and reasonably concise. When files were created, list their full paths (the app shows those images automatically).");
  lines.push("You can use the Read tool to look at files the user attached (their paths are given in the task).");
  if (s.access === "ask" || s.access === "auto") {
    const folders = usableFolders(s);
    if (s.access === "ask") lines.push(`You MAY create and edit files (Write, Edit) and run PowerShell commands. Every change and every command first waits for the user to click Allow in the app, so work in a few clear steps and say briefly what each step is for. If the user denies a step, do not try the same thing another way; tell them what you wanted to do and why.`);
    else lines.push(`You MAY create and edit files (Write, Edit) and run PowerShell commands. The user switched on "Always allow", so nothing waits for a click: every change and command runs right away. That is trust, so be careful: work in a few clear steps, say briefly what each step does, never delete or overwrite anything the task did not ask for, and when a step could lose the user's work, make a copy first. If a step is refused, do not try the same thing another way; tell the user what you wanted to do and why.`);
    lines.push(`Your working folder is ${WORK}.${folders.length ? ` The user also gave you these folders: ${folders.join("; ")}.` : ""} The Write and Edit tools only work inside those folders; anywhere else you need a PowerShell command (which also needs the user's OK).`);
    lines.push("Never read or change Discord's data, the .claude, .codex or .gemini folders, or AI Brain's brain-mcp.json, google-key.json and inspect-key.json. Those requests are always refused.");
  } else {
    lines.push("You can NOT change files or run commands in this app right now. If a task needs that, say so and tell the user they can switch it on in Settings > The brain > File and command access (the app then asks them before every change).");
  }
  if (s.answerStyle === "short") lines.push("The user prefers SHORT answers: get to the point in a few sentences or a short list, unless they ask for more.");
  if (s.answerStyle === "detailed") lines.push("The user prefers DETAILED answers: explain step by step and include examples.");
  if (s.instructions.trim()) lines.push(`The user's standing instructions (follow them in every answer):\n${s.instructions.trim()}`);
  return lines.join("\n");
}

// Work modes: an extra instruction added to one task (the user picks it next to the task box).
const MODES = {
  solo: "Work mode for this task: SOLO. Answer it yourself. Do not call the helper tools, unless the task clearly asks for a picture.",
  team: "Work mode for this task: TEAM. Before your final answer, ask the helper AIs for their own answer to this task, compare it with yours, and combine the best of both. End with one short line on where you agreed or disagreed.",
  debate: "Work mode for this task: DEBATE. 1) State your own position briefly. 2) Ask a helper AI to argue the strongest opposing view and to point out weaknesses in yours. 3) Send it your rebuttal once and get its reply. 4) Give the user a balanced verdict with a short summary of each side.",
  extreme: "Work mode for this task: EXTREME (most careful). 1) Write a short plan. 2) Ask the helper AIs for their own answer or approach. 3) Write a full draft that uses the best ideas. 4) Send the draft to a helper AI and ask it to find mistakes, gaps and anything that would not work. 5) Fix every real problem it found, and check facts, numbers and code yourself. 6) Give the final answer, then one short line saying what the review changed.",
};
const modeOf = (m) => (Object.hasOwn(MODES, m) ? m : "auto");

// ---------- event stream ----------
// emit() = part of the session (saved, replayed).  send() = live only (status, streaming text).
const clients = new Set();
const MAX_EVENTS = 2000;
function write(res, ev) { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch {} }
function send(ev) { ev.t = ev.t || Date.now(); for (const c of clients) write(c, ev); }
function emit(ev) {
  ev.t = Date.now();
  session.events.push(ev);
  if (session.events.length > MAX_EVENTS) session.events = session.events.slice(-MAX_EVENTS + 200);
  touchSession();
  for (const c of clients) write(c, ev);
}

// ---------- sessions ----------
const ID_KEYS = ["claudeSession", "geminiConversation", "chatgptThread"];
const ID_RE = /^[a-z0-9]{8,24}$/;
const index = new Map(); // id -> meta
let session = null;      // the active session: { id, title, createdAt, updatedAt, pinned, ids, events }
let saveTimer = null;

const sessionFile = (id) => path.join(SESSIONS, `${id}.json`);
const newId = () => Date.now().toString(36) + crypto.randomBytes(4).toString("hex");
const pickIds = (st) => Object.fromEntries(ID_KEYS.filter((k) => st[k]).map((k) => [k, st[k]]));

function metaOf(s) {
  let tasks = 0;
  const parts = [s.title || ""];
  for (const e of s.events) {
    if (e.type === "task") { tasks++; parts.push(e.text); }
    else if (e.type === "final") parts.push(e.text);
    else if (e.type === "call" && e.from === "you") parts.push(e.prompt);
  }
  return {
    id: s.id, title: s.title || "Untitled session", createdAt: s.createdAt, updatedAt: s.updatedAt,
    pinned: !!s.pinned, tasks, hay: parts.join("\n").toLowerCase().slice(0, 30_000),
  };
}
// A session that was cut off (app closed mid-task) must not show spinners forever.
function closeDangling(events) {
  const open = new Map();
  let taskOpen = false, lastT = Date.now();
  for (const e of events) {
    if (e.t) lastT = e.t;
    if (e.type === "call") open.set(e.id, e.to);
    else if (e.type === "reply" || e.type === "reply_cancel") open.delete(e.id);
    else if (e.type === "task") taskOpen = true;
    else if (e.type === "final") taskOpen = false;
  }
  for (const [id, to] of open) events.push({ type: "reply_cancel", id, to, t: lastT });
  if (taskOpen) events.push({ type: "final", text: "This task was interrupted because the app was closed.", isError: true, images: [], t: lastT });
  return events;
}
function readSession(id) {
  if (!ID_RE.test(String(id))) return null;
  const s = readJson(sessionFile(id), null);
  if (!s || s.id !== id || !Array.isArray(s.events)) return null;
  s.ids = s.ids || {};
  return s;
}
function blankSession() {
  const now = Date.now();
  return { id: newId(), title: "", createdAt: now, updatedAt: now, pinned: false, ids: {}, events: [] };
}
function flushSession() {
  clearTimeout(saveTimer); saveTimer = null;
  if (!session || !session.events.length) return;
  session.ids = pickIds(loadState());
  writeJson(sessionFile(session.id), session, false);
  index.set(session.id, metaOf(session));
}
function touchSession() {
  session.updatedAt = Date.now();
  if (!saveTimer) saveTimer = setTimeout(flushSession, 400);
}
function activate(s) {
  session = s;
  const patch = { activeSession: s.id };
  for (const k of ID_KEYS) patch[k] = s.ids?.[k] || null;
  updateState(patch);
}
function listSessions(q) {
  const needle = String(q || "").trim().toLowerCase();
  let items = [...index.values()];
  if (session.events.length && !index.has(session.id)) items.push(metaOf(session));
  if (needle) items = items.filter((m) => m.hay.includes(needle));
  return items
    .sort((a, b) => (b.pinned - a.pinned) || (b.updatedAt - a.updatedAt))
    .map(({ hay, ...m }) => ({ ...m, active: m.id === session.id }));
}
/** Totals over every saved session, plus tasks per day for the last 14 days. */
function lifetimeStats() {
  const all = [];
  for (const id of index.keys()) { const s = id === session.id ? session : readSession(id); if (s) all.push(s); }
  if (!index.has(session.id)) all.push(session);
  const tok = () => ({ tasks: 0, in: 0, cached: 0, out: 0, cost: 0 });
  const out = {
    sessions: 0, tasks: 0, answers: 0, helperCalls: 0, gemini: 0, chatgpt: 0, seconds: 0, pictures: 0, saved: 0, days: [],
    claude: { all: tok(), today: tok(), session: tok(), last: null },
    geminiUse: { all: { calls: 0, failed: 0, tokens: 0, pictures: 0 }, today: { calls: 0, failed: 0, tokens: 0, pictures: 0 }, lastQuota: null },
    videoUse: readVideoUsage(),
    chatgptUse: { all: { calls: 0, failed: 0, in: 0, cached: 0, out: 0 }, today: { calls: 0, failed: 0, in: 0, cached: 0, out: 0 }, limits: null },
  };
  const two = (n) => String(n).padStart(2, "0");
  const dayKey = (t) => { const d = new Date(t); return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`; };
  const today = dayKey(Date.now());
  const perDay = new Map(), perDayGemini = new Map(), perDayChatGPT = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  const add = (b, u) => { b.in += u.in || 0; b.cached += u.cached || 0; b.out += u.out || 0; b.cost += u.cost || 0; };
  for (const s of all) {
    if (s.events.length) out.sessions++;
    for (const ev of s.events) {
      if (ev.type === "task") {
        out.tasks++; bump(perDay, dayKey(ev.t));
        out.claude.all.tasks++;
        if (dayKey(ev.t) === today) out.claude.today.tasks++;
        if (s === session) out.claude.session.tasks++;
      } else if (ev.type === "call") {
        out.helperCalls++;
        if (ev.to === "chatgpt") out.chatgpt++; else if (ev.to === "gemini") out.gemini++;
      } else if (ev.type === "final") {
        if (!ev.stopped && !ev.isError) { out.answers++; out.seconds += Number(ev.seconds) || 0; }
        if (ev.usage) {
          add(out.claude.all, ev.usage);
          if (dayKey(ev.t) === today) add(out.claude.today, ev.usage);
          if (s === session) add(out.claude.session, ev.usage);
          if (!out.claude.last || ev.t > out.claude.last.t) out.claude.last = { t: ev.t, seconds: Number(ev.seconds) || 0, ...ev.usage };
        }
      }
    }
  }
  for (const g of readGeminiUsage()) {
    if (g.kind === "quota") { out.geminiUse.lastQuota = { t: g.t, what: g.what || "pictures", resets: String(g.resets || "").slice(0, 60) }; continue; }
    const isToday = dayKey(g.t) === today;
    for (const b of isToday ? [out.geminiUse.all, out.geminiUse.today] : [out.geminiUse.all]) {
      b.calls++;
      if (!g.ok) b.failed++;
      b.tokens += g.total || 0;
      b.pictures += g.pictures || 0;
    }
    bump(perDayGemini, dayKey(g.t));
  }
  for (const c of readChatGPTUsage()) {
    const isToday = dayKey(c.t) === today;
    for (const b of isToday ? [out.chatgptUse.all, out.chatgptUse.today] : [out.chatgptUse.all]) {
      b.calls++;
      if (!c.ok) b.failed++;
      b.in += c.in || 0; b.cached += c.cached || 0; b.out += c.out || 0;
    }
    if (c.limits && typeof c.limits === "object") out.chatgptUse.limits = { t: c.t, short: c.limits.short || null, long: c.limits.long || null };
    bump(perDayChatGPT, dayKey(c.t));
  }
  for (const b of [out.claude.all, out.claude.today, out.claude.session]) b.cost = Math.round(b.cost * 10000) / 10000;
  for (let i = 13; i >= 0; i--) {
    const k = dayKey(Date.now() - i * 86_400_000);
    out.days.push({ day: k, tasks: perDay.get(k) || 0, gemini: perDayGemini.get(k) || 0, chatgpt: perDayChatGPT.get(k) || 0 });
  }
  out.pictures = listMediaFiles().length;
  out.saved = loadSaved().length;
  return out;
}
/** Tokens and API-price value of one finished Claude run, from the CLI's result line. */
function claudeUsage(ev) {
  const n = (v) => Number(v) || 0;
  const u = { in: 0, cached: 0, out: 0, cost: n(ev.total_cost_usd), turns: n(ev.num_turns) };
  const models = ev.modelUsage && typeof ev.modelUsage === "object" ? Object.values(ev.modelUsage) : [];
  if (models.length) {
    for (const m of models) { u.in += n(m.inputTokens) + n(m.cacheCreationInputTokens); u.cached += n(m.cacheReadInputTokens); u.out += n(m.outputTokens); }
  } else if (ev.usage) {
    u.in = n(ev.usage.input_tokens) + n(ev.usage.cache_creation_input_tokens);
    u.cached = n(ev.usage.cache_read_input_tokens);
    u.out = n(ev.usage.output_tokens);
  } else if (!u.cost) return null;
  u.cost = Math.round(u.cost * 10000) / 10000;
  return u;
}
function setTitleFrom(text) {
  if (session.title) return;
  session.title = String(text).replace(/\s+/g, " ").trim().slice(0, 70) || "Untitled session";
  send({ type: "sessions" });
}
function initSessions() {
  for (const f of fs.readdirSync(SESSIONS)) {
    if (!f.endsWith(".json")) continue;
    const s = readSession(f.slice(0, -5));
    if (s && s.events.length) index.set(s.id, metaOf(s));
  }
  const active = readSession(loadState().activeSession);
  if (active) { closeDangling(active.events); session = active; }
  else activate(blankSession());
}

function exportMarkdown(s) {
  const when = (t) => new Date(t).toLocaleString();
  const name = { claude: "Claude", chatgpt: "ChatGPT", gemini: "Gemini" };
  const out = [`# ${s.title || "AI Brain session"}`, "", `_Exported from AI Brain on ${when(Date.now())}_`, ""];
  for (const e of s.events) {
    if (e.type === "task") out.push(`## You - ${when(e.t)}`, "", e.text, "");
    else if (e.type === "call") out.push(`### ${e.from === "you" ? "You" : "Claude"} to ${name[e.to]}`, "", e.prompt, "");
    else if (e.type === "reply") out.push(`### ${name[e.to]}${e.isError ? " (error)" : ""}`, "", e.text, "");
    else if (e.type === "final") out.push(`## Claude${e.isError ? " (error)" : ""} - ${when(e.t)}`, "", e.text, "");
  }
  return out.join("\n");
}

// ---------- media helpers ----------
function mediaFrom(text) {
  const out = new Set();
  const re = /[\\/](media|uploads)[\\/]([\w.\-]+)/gi;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const name = m[2].replace(/[.]+$/, ""), dir = m[1].toLowerCase() === "media" ? MEDIA : UPLOADS;
    if (MEDIA_RE.test(name) && fs.existsSync(path.join(dir, name))) out.add(`/${m[1].toLowerCase()}/${encodeURIComponent(name)}`);
  }
  return [...out];
}
const toUrls = (paths) => paths.map((p) => `/media/${encodeURIComponent(path.basename(p))}`);
function listMediaFiles() {
  return fs.readdirSync(MEDIA).filter((f) => MEDIA_RE.test(f))
    .map((f) => { const st = fs.statSync(path.join(MEDIA, f)); return { name: f, url: `/media/${encodeURIComponent(f)}`, path: path.join(MEDIA, f), mtime: st.mtimeMs, size: st.size }; })
    .sort((a, b) => b.mtime - a.mtime);
}

const lastOk = { chatgpt: null, gemini: null, claude: null };
function noteResult(who, ok) { lastOk[who] = ok; send({ type: "helper_state", who, ok }); }
let lastUsage = loadState().usage || null;

// ---------- the brain (Claude) ----------
let brain = null;
let stoppedByUser = false;
let live = "";            // the text Claude is writing right now (for windows that connect mid-answer)
let phase = "idle";       // idle | starting | thinking | writing | helpers
let streamTimer = null;
let queue = [];           // tasks waiting for the brain: { id, text, files }

function killTree(child) {
  if (!child?.pid) return;
  spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
}
function setPhase(p) { if (phase !== p) { phase = p; send({ type: "phase", phase }); } }
function pushStream(now) {
  if (now) { clearTimeout(streamTimer); streamTimer = null; send({ type: "stream", text: live }); return; }
  if (!streamTimer) streamTimer = setTimeout(() => { streamTimer = null; send({ type: "stream", text: live }); }, 70);
}
const sendQueue = () => send({ type: "queue", items: queue.map(({ id, text }) => ({ id, text })) });
const directActive = () => !!(direct.chatgpt || direct.gemini);
function nextFromQueue() {
  if (brain || directActive() || !queue.length) return;
  const q = queue.shift();
  sendQueue();
  try { startBrain(q.text, q.files, false, q.mode); } catch (e) { slog("queue start failed", e.message); }
}

// ---------- asking the user before the brain changes something (access "ask") ----------
// Claude's approve tool posts each request to /api/approval/ask and waits. The window shows it; the
// first click wins. Anything else - no window open, no answer in time, Stop, the task ending, a wrong
// key, access switched back to "read" - means NO. Requests are live only: a replay never reopens one.
const APPROVAL_MS = Number(process.env.BRAIN_APPROVAL_MS || 10 * 60_000); // below MCP_TOOL_TIMEOUT
let runKey = null;              // the key of the brain task that is running now (access "ask")
let allowFilesThisRun = false;  // "Allow all file changes for this task" was clicked
const approvals = new Map();    // id -> { id, tool, kind, title, path, detail, note, t, done }
const FILE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["PowerShell", "Bash"]);
// Never allowed, whatever the user clicks: sign-in data and the approval key itself.
function forbidden(input) {
  const all = [];
  const walk = (v) => { if (typeof v === "string") all.push(v); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(input);
  const t = all.join("\n").toLowerCase().replace(/\\+/g, "/");
  if (t.includes("discord") && /appdata|leveldb|local storage|token/.test(t)) return true;
  return /[/~]\.(claude|codex|gemini)\b|brain-mcp\.json|google-key|inspect-key|gemini_api_key|google_api_key/.test(t);
}
function describe(tool, input = {}) {
  const clip = (v, n) => { const s = String(v ?? ""); return s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s; };
  if (SHELL_TOOLS.has(tool)) return { kind: "command", title: "Claude wants to run a command", path: "", detail: clip(input.command, 20_000), note: String(input.description || "").slice(0, 300) };
  if (/(^|__)app_python$/.test(tool)) return { kind: "command", title: "Claude wants to run Python in the program in the middle", path: "", detail: clip(input.code, 20_000), note: "It runs inside the program (Blender or Krita) and can do anything that program can, including saving and deleting files." };
  if (tool === "Write") return { kind: "file", title: "Claude wants to write a file", path: String(input.file_path || ""), detail: clip(input.content, 20_000), note: "The whole file will be replaced with this text." };
  if (tool === "Edit") return { kind: "file", title: "Claude wants to change a file", path: String(input.file_path || ""), detail: `REPLACE:\n${clip(input.old_string, 10_000)}\n\nWITH:\n${clip(input.new_string, 10_000)}`, note: input.replace_all ? "Every match in the file will be replaced." : "" };
  return { kind: "other", title: `Claude wants to use ${tool}`, path: String(input.file_path || input.notebook_path || input.path || ""), detail: clip(JSON.stringify(input, null, 2), 20_000), note: "" };
}
const approvalView = (a) => ({ id: a.id, tool: a.tool, kind: a.kind, title: a.title, path: a.path, detail: a.detail, note: a.note, cwd: WORK, canAll: a.kind === "file", t: a.t });
const oneLine = (a) => `${a.tool}${a.path ? ` ${a.path}` : a.kind === "command" ? `: ${a.detail.replace(/\s+/g, " ").slice(0, 140)}` : ""}`;
function finishApproval(a, allow, why = "") {
  if (a.done) return;
  a.done = true;
  clearTimeout(a.timer);
  approvals.delete(a.id);
  send({ type: "approval_done", id: a.id, allow });
  emit({ type: "log", level: allow ? "info" : "warn", text: `${allow ? "Allowed" : "Not allowed"}: ${oneLine(a)}${why ? ` (${why})` : ""}` });
  a.resolve(allow ? { behavior: "allow" } : { behavior: "deny", message: why ? `Not allowed: ${why}` : "The user clicked Deny." });
}
function denyAllApprovals(why) { for (const a of [...approvals.values()]) finishApproval(a, false, why); }
function askApproval(body) {
  const tool = String(body?.tool_name || "").slice(0, 80);
  const input = body?.input && typeof body.input === "object" ? body.input : {};
  const d = describe(tool, input);
  const a = { id: newId(), tool, ...d, t: Date.now(), done: false };
  a.answer = new Promise((resolve) => {
    a.resolve = resolve;
    if (!brain) return finishApproval(a, false, "no task is running");
    const access = loadSettings().access;
    if (access !== "ask" && access !== "auto") return finishApproval(a, false, "file and command access is switched off in Settings");
    if (forbidden(input)) return finishApproval(a, false, "AI Brain never lets the brain touch sign-in data or its own approval key");
    // "Always allow": no question, but it still goes through here so the two checks above and the log apply.
    if (access === "auto") { a.done = true; emit({ type: "log", level: "info", text: `Allowed (always allow is on): ${oneLine(a)}` }); return resolve({ behavior: "allow" }); }
    if (allowFilesThisRun && FILE_TOOLS.has(tool)) { a.done = true; emit({ type: "log", level: "info", text: `Allowed (all file changes for this task): ${oneLine(a)}` }); return resolve({ behavior: "allow" }); }
    if (!clients.size) return finishApproval(a, false, "the AI Brain window was not open to ask you");
    approvals.set(a.id, a);
    a.timer = setTimeout(() => finishApproval(a, false, `no answer within ${Math.round(APPROVAL_MS / 60000)} minutes`), APPROVAL_MS);
    send({ type: "approval", ...approvalView(a) });
    emit({ type: "log", level: "warn", text: `Waiting for your OK: ${oneLine(a)}` });
  });
  return a;
}
// ---------- the brain uses the program in the middle ("Let the brain use the program in the middle") ----------
// The brain's app_ tools post each step to /api/apps/control with the task's key and wait. The step
// goes to the page (SSE "app-control"), the desktop window does it, and the page posts the answer to
// /api/apps/control/answer. A plain browser tab answers "no" softly: that only counts when no desktop
// window answers within a few seconds. Stop, the task ending or the setting going off ends every step.
const CONTROL_CMDS = new Set(["state", "open", "look", "click", "type", "key", "scroll", "drag", "act", "bridge", "bridge-call", "python"]);
const CONTROL_MS = Number(process.env.BRAIN_CONTROL_MS || 60_000);
const controls = new Map(); // id -> { id, resolve, timer, soft }
function finishControl(c, result) {
  if (!controls.has(c.id)) return;
  controls.delete(c.id);
  clearTimeout(c.timer); clearTimeout(c.softTimer);
  c.resolve(result);
}
function endControls(why) { for (const c of [...controls.values()]) finishControl(c, { ok: false, why: `Stopped: ${why}.` }); }
function askControl(cmd, args) {
  return new Promise((resolve) => {
    if (!clients.size) return resolve({ ok: false, why: "The AI Brain window is not open, so no program can be used." });
    const c = { id: newId(), resolve, soft: null };
    controls.set(c.id, c);
    // Opening a big program can take a while (Blender, Godot).
    c.timer = setTimeout(() => finishControl(c, { ok: false, why: "AI Brain's window did not answer in time." }), cmd === "open" ? Math.max(CONTROL_MS, 120_000) : CONTROL_MS);
    send({ type: "app-control", id: c.id, cmd, args, task: ctlTask });
  });
}
function controlLine(tool, a) {
  const at = a.target !== undefined ? `#${a.target}` : a.x !== undefined ? `(${a.x}, ${a.y})` : "";
  const clip = (t) => { const s = String(t ?? "").replace(/\s+/g, " "); return s.length > 80 ? `${s.slice(0, 80)}…` : s; };
  switch (tool) {
    case "app_open": return `open ${clip(a.name)}`;
    case "app_look": return "look";
    case "app_click": return `${a.count === 2 ? "double-click" : a.button === "right" ? "right-click" : a.button === "none" ? "move to" : "click"} ${at}`;
    case "app_type": return `type "${clip(a.text)}"`;
    case "app_key": return `press ${clip(a.keys)}${a.times > 1 ? ` x${a.times}` : ""}`;
    case "app_scroll": return `scroll ${a.amount > 0 ? "up" : "down"} ${Math.abs(Number(a.amount) || 0)} at ${at}`;
    case "app_drag": return `drag ${a.from_target !== undefined ? `#${a.from_target}` : `(${a.from_x}, ${a.from_y})`} to ${a.to_target !== undefined ? `#${a.to_target}` : `(${a.to_x}, ${a.to_y})`}`;
    case "app_act": return `${a.action || "press"} #${a.target}${a.action === "set" ? ` = "${clip(a.value)}"` : ""} (no mouse)`;
    case "app_commands": return `list commands${a.name ? ` (${clip(a.name)})` : a.filter ? ` matching "${clip(a.filter)}"` : ""}`;
    case "app_command": return `run ${clip(a.command)}`;
    case "app_python": return `Python: ${clip(a.code)}`;
    default: return tool;
  }
}

// ---------- web inspector: tabs shared with the AI Brain extension in the user's own browser ----------
// The extension (folder "extension") is paired once with a code from Settings. It asks for work with
// /api/inspect/ext/next (held open up to 25 s), does it with the browser's debugger on tabs the user
// shared (clicked its button on), and answers with /api/inspect/ext/answer. The brain's web_ tools post
// to /api/inspect/request with the task's key. Only while "Let the brain inspect your shared tabs" is on.
const INSPECT_KEY_FILE = path.join(DATA, "inspect-key.json");
const INSPECT_CMDS = new Set(["tabs", "html", "eval", "network", "response", "console", "cookies", "styles", "screenshot", "go"]);
const INSPECT_MS = Number(process.env.BRAIN_INSPECT_MS || 45_000);
const inspectQueue = [];          // steps waiting for the extension to ask
const inspectSent = new Map();    // id -> step the extension has, waiting for its answer
let inspectPoll = null;           // the extension's open /next request
const ext = { seen: 0, tabs: [], version: "", browser: "" };
const extConnected = () => Date.now() - ext.seen < 40_000;
const inspectCode = () => readJson(INSPECT_KEY_FILE, null)?.code || "";
function newInspectCode() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const b = crypto.randomBytes(20);
  const code = [...b].map((x) => abc[x % abc.length]).join("").replace(/(.{5})(?!$)/g, "$1-");
  writeJson(INSPECT_KEY_FILE, { code });
  ext.seen = 0; ext.tabs = [];
  endInspects("the extension was paired again");
  return code;
}
const sameKey = (a, b) => !!a && !!b && a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
const inspectView = () => ({ paired: !!inspectCode(), connected: extConnected(), tabs: extConnected() ? ext.tabs : [], version: ext.version, browser: ext.browser, folder: path.join(ROOT, "extension") });
function finishInspect(st, result) {
  if (st.done) return;
  st.done = true;
  clearTimeout(st.timer);
  inspectSent.delete(st.id);
  const i = inspectQueue.indexOf(st);
  if (i >= 0) inspectQueue.splice(i, 1);
  st.resolve(result);
}
function endInspects(why) { for (const st of [...inspectQueue, ...inspectSent.values()]) finishInspect(st, { ok: false, why: `Stopped: ${why}.` }); }
function handOut() {
  if (!inspectPoll || !inspectQueue.length) return;
  const st = inspectQueue.shift(), res = inspectPoll;
  inspectPoll = null;
  inspectSent.set(st.id, st);
  json(res, 200, { id: st.id, cmd: st.cmd, args: st.args });
}
function askInspect(cmd, args) {
  return new Promise((resolve) => {
    if (!inspectCode()) return resolve({ ok: false, why: "The AI Brain browser extension is not paired yet. Ask the user to set it up: Settings > Web inspector." });
    if (!extConnected()) return resolve({ ok: false, why: "The AI Brain browser extension is not connected. Ask the user to open their browser (with the extension installed and paired) and click the extension's button on the tab to inspect." });
    const st = { id: newId(), cmd, args, resolve, done: false };
    st.timer = setTimeout(() => finishInspect(st, { ok: false, why: "The browser extension did not answer in time." }), cmd === "go" ? Math.max(INSPECT_MS, 60_000) : INSPECT_MS);
    inspectQueue.push(st);
    handOut();
  });
}
// What the extension says about itself: its version, browser and shared tabs. Tells the window when that changes.
let extShown = "";
function extSeen(body) {
  ext.seen = Date.now();
  if (Array.isArray(body?.tabs)) ext.tabs = body.tabs.slice(0, 50).map((t) => ({ id: Number(t?.id) || 0, title: String(t?.title || "").slice(0, 200), url: String(t?.url || "").slice(0, 500) }));
  if (body?.version) ext.version = String(body.version).slice(0, 20);
  if (body?.browser) ext.browser = String(body.browser).slice(0, 40);
  const now = JSON.stringify(inspectView());
  if (now !== extShown) { extShown = now; send({ type: "inspect", ...inspectView() }); }
}
// Notices the extension going away (no request for a while).
setInterval(() => { if (extShown && JSON.stringify(inspectView()) !== extShown) { extShown = JSON.stringify(inspectView()); send({ type: "inspect", ...inspectView() }); } }, 10_000).unref();

async function extRoute(req, res, p) {
  const origin = String(req.headers.origin || "");
  const head = { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Headers": "Content-Type, X-Brain-Key", "Access-Control-Allow-Methods": "POST" };
  const out = (code, obj) => { res.writeHead(code, head); res.end(JSON.stringify(obj)); };
  if (!/^chrome-extension:\/\/[a-p]{32}$/.test(origin) && !(process.env.BRAIN_TEST_EXT_ORIGIN && origin === process.env.BRAIN_TEST_EXT_ORIGIN)) { res.writeHead(403); res.end("Forbidden"); return; }
  if (req.method === "OPTIONS") { res.writeHead(204, head); res.end(); return; }
  if (req.method !== "POST") return out(405, { error: "POST only" });
  const code = inspectCode();
  const given = String(req.headers["x-brain-key"] || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(.{5})(?!$)/g, "$1-");
  if (!code || !sameKey(given, code)) return out(403, { error: "Wrong pairing code. Copy the code from AI Brain: Settings > Web inspector." });
  let body;
  try { body = JSON.parse((await readBody(req, (p === "/api/inspect/ext/answer" ? 16 : 1) * 1024 * 1024)).toString() || "{}"); }
  catch { return out(400, { error: "Bad request" }); }
  if (p === "/api/inspect/ext/hello") { extSeen(body); return out(200, { ok: true, app: "ai-brain", version: VERSION, enabled: loadSettings().inspectBrain }); }
  if (p === "/api/inspect/ext/next") {
    extSeen(body);
    if (inspectPoll) { const old = inspectPoll; inspectPoll = null; try { old.writeHead(200, head); old.end(JSON.stringify({ none: true })); } catch { /* gone */ } }
    // Answers carry the extension's origin (it reads them with fetch).
    inspectPoll = { writeHead: (c) => res.writeHead(c, head), end: (s) => res.end(s), res };
    const mine = inspectPoll;
    res.on("close", () => { if (inspectPoll === mine) inspectPoll = null; });
    handOut();
    setTimeout(() => { if (inspectPoll === mine) { inspectPoll = null; out(200, { none: true }); } }, 25_000);
    return;
  }
  if (p === "/api/inspect/ext/answer") {
    extSeen({});
    const st = inspectSent.get(String(body.id || ""));
    if (!st) return out(404, { error: "That step was already answered or has ended." });
    finishInspect(st, body.result && typeof body.result === "object" ? body.result : { ok: false, why: "no answer" });
    return out(200, { ok: true });
  }
  return out(404, { error: "Not found" });
}

// When the last window closes, give it a moment (a reload) and then say no to anything still waiting.
let noWindowTimer = null;
function windowsChanged() {
  clearTimeout(noWindowTimer);
  if (!clients.size && approvals.size) noWindowTimer = setTimeout(() => { if (!clients.size) denyAllApprovals("the AI Brain window was closed"); }, 15_000);
}

function startBrain(text, files = [], isRetry = false, mode = "auto") {
  if (brain) throw new Error("The brain is already working on a task.");
  stoppedByUser = false;
  const state = loadState();
  const s = loadSettings();
  const resumed = !!state.claudeSession;
  let prompt = text;
  if (files.length) prompt += `\n\nAttached files:\n${files.join("\n")}`;
  if (mode !== "auto") prompt += `\n\n[${MODES[mode]}]`;

  // The program in the middle: a new key (and a new task id, so the window starts fresh) for this task only.
  endControls("a new task started");
  endInspects("a new task started");
  ctlKey = s.appsBrain || s.inspectBrain ? crypto.randomBytes(24).toString("hex") : null;
  ctlTask = crypto.randomBytes(8).toString("hex");
  // access "ask" or "auto": a new key for this task only; old keys stop working.
  const ask = s.access === "ask" || s.access === "auto";
  runKey = ask ? crypto.randomBytes(24).toString("hex") : null;
  allowFilesThisRun = false;
  writeMcpConfig(s, runKey);
  const args = [
    // --restricted: file tools only work inside ./workspace (and the folders from --add-dir), command
    // tools only exist when --tools names them, and the user's own settings files are ignored.
    "-p", "--restricted", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--mcp-config", MCP_CFG, "--strict-mcp-config",
    "--tools", ask ? "Read,Glob,Grep,Write,Edit,PowerShell" : "Read",
    "--allowedTools", "Read", ...(ask ? ["Glob", "Grep"] : []), ...brainTools(s),
    "--append-system-prompt", systemPrompt(s),
  ];
  // Every change and every command goes to the approve tool, which asks the user in the window.
  if (ask) {
    args.push("--settings", ASK_RULES, "--permission-prompt-tool", "mcp__ai-brain__approve");
    for (const f of usableFolders(s)) args.push("--add-dir", f);
  }
  if (s.brainModel !== "auto") args.push("--model", s.brainModel);
  if (s.effort !== "auto") args.push("--effort", s.effort);
  if (resumed) args.push("--resume", state.claudeSession);

  if (!isRetry) {
    setTitleFrom(text);
    emit({ type: "task", text, mode, files: files.map((f) => ({ path: f, name: path.basename(f), url: mediaFrom(f)[0] || null })) });
    send({ type: "busy", value: true });
  }
  emit({ type: "log", level: "info", text: resumed ? "Continuing the conversation with Claude..." : "Starting a new Claude session..." });

  const env = { ...process.env, MCP_TOOL_TIMEOUT: "900000", NO_COLOR: "1" };
  const child = FAKE_BRAIN
    ? spawn(process.execPath, [FAKE_BRAIN, ...args], { cwd: WORK, windowsHide: true, env })
    : spawn(CLAUDE_EXE, args, { cwd: WORK, windowsHide: true, env });
  brain = child;
  live = ""; setPhase("starting");
  const started = Date.now();
  const calls = new Map(); // tool_use_id -> { to }
  let gotResult = false, gotInit = false, buf = "", errTail = "", pendingSay = null;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  const timer = setTimeout(() => {
    emit({ type: "log", level: "error", text: `Task took longer than ${BRAIN_TIMEOUT_MS / 60000} minutes, stopping it.` });
    killTree(child);
  }, BRAIN_TIMEOUT_MS);
  const flushSay = () => { if (pendingSay) { emit({ type: "claude_say", text: pendingSay }); pendingSay = null; } };
  const norm = (t) => String(t || "").replace(/\s+/g, " ").trim();

  const handle = (line) => {
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.type === "stream_event") { // live typing
      if (ev.parent_tool_use_id) return;
      const e = ev.event || {};
      if (e.type === "content_block_start") {
        const kind = e.content_block?.type;
        if (kind === "text") { live = ""; setPhase("writing"); pushStream(true); }
        else if (kind === "thinking") setPhase("thinking");
      } else if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
        live += e.delta.text || "";
        pushStream();
      }
    } else if (ev.type === "system" && ev.subtype === "init") {
      gotInit = true;
      if (ev.session_id) updateState({ claudeSession: ev.session_id });
      const link = (ev.mcp_servers || []).find((m) => m.name === "ai-brain")?.status;
      emit({ type: "log", level: "info", text: `Claude online - model ${ev.model}${link ? `; helpers link: ${link}` : ""}` });
      setPhase("thinking");
    } else if (ev.type === "assistant") {
      for (const c of ev.message?.content || []) {
        if (c.type === "text" && c.text.trim()) { flushSay(); pendingSay = c.text; }
        else if (c.type === "tool_use") {
          flushSay();
          live = ""; pushStream(true);
          const tool = String(c.name).replace("mcp__ai-brain__", "");
          if (tool === "Read") { emit({ type: "log", level: "info", text: `Reading file ${c.input?.file_path || ""}` }); continue; }
          if (tool.startsWith("app_")) { emit({ type: "log", level: "info", text: `Program: ${controlLine(tool, c.input || {})}` }); continue; }
          if (tool.startsWith("web_")) {
            const a = c.input || {}, what = a.url || a.selector || a.expression || a.filter || (a.request ? `#${a.request}` : "");
            emit({ type: "log", level: "info", text: `Web inspector: ${tool.slice(4)}${what ? ` ${String(what).replace(/\s+/g, " ").slice(0, 100)}` : ""}` });
            continue;
          }
          if (!HELPER_TOOLS.has(tool)) { // its own tools (files, search, commands): a line in the log
            const what = c.input?.command || c.input?.file_path || c.input?.pattern || "";
            emit({ type: "log", level: "info", text: `${tool}${what ? `: ${String(what).replace(/\s+/g, " ").slice(0, 160)}` : ""}` });
            continue;
          }
          const p = c.input?.prompt || c.input?.description || "";
          setPhase("helpers");
          if (tool === "ask_both") {
            calls.set(c.id, { to: "both" });
            emit({ type: "call", id: c.id + ":c", from: "claude", to: "chatgpt", prompt: p });
            emit({ type: "call", id: c.id + ":g", from: "claude", to: "gemini", prompt: p });
          } else {
            const to = tool === "ask_chatgpt" ? "chatgpt" : "gemini";
            const video = tool === "generate_video" || tool.startsWith("flow_");
            calls.set(c.id, { to, video });
            emit({ type: "call", id: c.id, from: "claude", to, video, prompt: tool === "generate_image" ? `Generate image: ${p}` : tool === "flow_save_videos" ? "Save the new video from Google Flow" : tool === "flow_make_video" ? `Google Flow video: ${p}` : video ? `Generate video: ${p}` : p });
          }
        }
      }
    } else if (ev.type === "user") {
      for (const c of ev.message?.content || []) {
        if (c.type !== "tool_result") continue;
        const call = calls.get(c.tool_use_id);
        if (!call) continue;
        calls.delete(c.tool_use_id);
        const txt = Array.isArray(c.content) ? c.content.map((x) => x.text || "").join("\n") : String(c.content || "");
        const isError = !!c.is_error;
        if (call.to === "both") {
          const g = txt.indexOf("=== Gemini ===");
          const ct = txt.slice(0, g < 0 ? undefined : g).replace("=== ChatGPT ===", "").trim();
          const gt = g < 0 ? "" : txt.slice(g + 14).trim();
          const ce = ct.startsWith("ERROR:"), ge = gt.startsWith("ERROR:");
          emit({ type: "reply", id: c.tool_use_id + ":c", to: "chatgpt", text: ct, isError: ce, images: mediaFrom(ct) });
          emit({ type: "reply", id: c.tool_use_id + ":g", to: "gemini", text: gt, isError: ge, images: mediaFrom(gt) });
          noteResult("chatgpt", !ce); noteResult("gemini", !ge);
        } else {
          const images = mediaFrom(txt);
          emit({ type: "reply", id: c.tool_use_id, to: call.to, text: txt, isError, images, video: !!call.video });
          if (!call.video) noteResult(call.to, !isError); // a video problem says nothing about Gemini itself
          if (images.length) send({ type: "media" });
        }
        if (!calls.size) setPhase("thinking");
      }
    } else if (ev.type === "rate_limit_event") {
      const w = ev.rate_limit_info?.unifiedWindows || {};
      lastUsage = {
        five_hour: w.five_hour?.utilization ?? null, five_hour_resets: w.five_hour?.resetsAt ?? null,
        seven_day: w.seven_day?.utilization ?? null, seven_day_resets: w.seven_day?.resetsAt ?? null,
        at: Date.now(),
      };
      updateState({ usage: lastUsage });
      send({ type: "usage", ...lastUsage });
    } else if (ev.type === "result") {
      if (ev.is_error && resumed && !gotInit && !isRetry) { // the saved session could not be resumed
        errTail += JSON.stringify(ev.errors || ev.result || "");
        return;
      }
      gotResult = true;
      if (ev.session_id) updateState({ claudeSession: ev.session_id });
      if (pendingSay && norm(pendingSay) !== norm(ev.result)) flushSay();
      pendingSay = null;
      const fallback = ev.is_error ? `Claude reported an error.${ev.errors ? `\n${[].concat(ev.errors).join("\n")}` : ""}` : "";
      emit({
        type: "final", text: ev.result || fallback, isError: !!ev.is_error, images: mediaFrom(ev.result),
        seconds: Math.round((Date.now() - started) / 1000), usage: claudeUsage(ev),
      });
      noteResult("claude", !ev.is_error);
    }
  };

  child.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(line);
    }
  });
  child.stderr.on("data", (d) => { errTail = (errTail + d).slice(-2000); });
  child.stdin.on("error", () => { /* Claude exited before reading the task */ });
  child.on("error", (e) => { errTail += String(e); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (buf.trim()) handle(buf.trim());
    brain = null;
    ctlKey = null;
    endControls("the task ended");
    endInspects("the task ended");
    runKey = null; allowFilesThisRun = false;
    denyAllApprovals("the task ended");
    live = ""; pushStream(true);
    for (const [id, call] of calls) { // close any calls that never got an answer
      const ids = call.to === "both" ? [[id + ":c", "chatgpt"], [id + ":g", "gemini"]] : [[id, call.to]];
      for (const [i2, to] of ids) emit({ type: "reply_cancel", id: i2, to });
    }
    if (!gotResult && resumed && !gotInit && !stoppedByUser && !isRetry) {
      // The saved Claude session could not be resumed - start a fresh one once.
      slog("resume failed, retrying fresh", errTail);
      updateState({ claudeSession: null });
      emit({ type: "log", level: "warn", text: "Could not continue the previous Claude session - starting a fresh one." });
      try { startBrain(text, files, true, mode); return; } catch { /* fall through */ }
    }
    if (!gotResult) {
      flushSay();
      const why = errTail.trim().split(/\r?\n/).slice(-5).join("\n") || `exit code ${code}`;
      emit({
        type: "final", stopped: stoppedByUser, isError: !stoppedByUser, images: [],
        text: stoppedByUser ? "Stopped." : `The task stopped before Claude finished.\n${why}`,
        seconds: Math.round((Date.now() - started) / 1000),
      });
      if (!stoppedByUser) slog("brain exit", code, errTail);
    }
    setPhase("idle");
    send({ type: "busy", value: false });
    flushSession();
    setImmediate(nextFromQueue);
  });
  child.stdin.end(prompt);
}

// ---------- direct messages to one helper ----------
const direct = { chatgpt: null, gemini: null, video: null }; // AbortController while a direct message (or a video) is running
function directAsk(to, text, { image = false } = {}) {
  const ac = new AbortController();
  direct[to] = ac;
  const id = `direct-${newId()}`;
  setTitleFrom(text);
  emit({ type: "call", id, from: "you", to, prompt: image ? `Generate image: ${text}` : text });
  send({ type: "direct", who: to, value: true });
  (async () => {
    try {
      const opts = { signal: ac.signal };
      const r = image ? await generateImage(text, opts) : to === "chatgpt" ? await askChatGPT(text, opts) : await askGemini(text, opts);
      emit({ type: "reply", id, to, text: r.text, isError: false, images: toUrls(r.images) });
      if (r.images.length) send({ type: "media" });
      noteResult(to, true);
    } catch (e) {
      if (ac.signal.aborted || e?.stopped) emit({ type: "reply", id, to, text: "Stopped.", isError: false, stopped: true, images: [] });
      else { emit({ type: "reply", id, to, text: String(e?.message || e), isError: true, images: [] }); noteResult(to, false); }
    } finally {
      direct[to] = null;
      send({ type: "direct", who: to, value: false });
      flushSession();
      setImmediate(nextFromQueue);
    }
  })();
  return id;
}

// A video made from the Video Studio. It does not use the helpers' conversations, so it can run next to a task.
function directVideo(text, opts) {
  const ac = new AbortController();
  direct.video = ac;
  const id = `direct-${newId()}`;
  setTitleFrom(text);
  emit({ type: "call", id, from: "you", to: "gemini", video: true, prompt: `Generate video: ${text}` });
  emit({ type: "log", level: "info", text: `Video: asking Google ${videoName(opts.model || loadSettings().videoModel)}. This takes a few minutes.` });
  send({ type: "direct", who: "video", value: true });
  (async () => {
    try {
      const r = await generateVideo(text, { ...opts, signal: ac.signal });
      emit({ type: "reply", id, to: "gemini", text: r.text, isError: false, images: toUrls(r.images), video: true });
      send({ type: "media" });
    } catch (e) {
      if (ac.signal.aborted || e?.stopped) emit({ type: "reply", id, to: "gemini", text: "Stopped.", isError: false, stopped: true, images: [], video: true });
      else emit({ type: "reply", id, to: "gemini", text: String(e?.message || e), isError: true, images: [], video: true });
    } finally {
      direct.video = null;
      send({ type: "direct", who: "video", value: false });
      flushSession();
    }
  })();
  return id;
}
let videoModels = null, videoModelsAt = 0;
async function videoInfo() {
  const key = googleKeyState();
  if (!videoModels || Date.now() - videoModelsAt > 10 * 60_000) { videoModels = await listVideoModels(); videoModelsAt = Date.now(); }
  const s = loadSettings();
  const models = videoModels.some((m) => m.id === s.videoModel) ? videoModels : [...videoModels, { id: s.videoModel, label: s.videoModel }];
  return { ...key, models, model: s.videoModel, limit: s.videoDailyLimit, usage: readVideoUsage(), busy: !!direct.video };
}

// ---------- sign-in status ----------
let statusCache = null, statusAt = 0;
async function getStatus(force) {
  if (!force && statusCache && Date.now() - statusAt < 30_000) return statusCache;
  const s = loadSettings();
  const [cl, cx] = await Promise.all([
    FAKE_BRAIN ? { stdout: '{"loggedIn":true}' } : runExe(CLAUDE_EXE, ["auth", "status"], { timeoutMs: 30_000 }),
    s.chatgptEnabled ? runExe(process.execPath, [CODEX_JS, "login", "status"], { timeoutMs: 30_000 }, CODEX_JS) : null,
  ]);
  let claudeOk = false;
  try { claudeOk = !!JSON.parse(cl.stdout.slice(cl.stdout.indexOf("{"))).loggedIn; } catch {}
  const cxOut = cx ? (cx.stdout + cx.stderr).trim() : "";
  const chatgptOk = !!cx && /logged in/i.test(cxOut) && !/not logged in/i.test(cxOut);
  const geminiInstalled = process.env.BRAIN_FAKE_HELPERS === "1" || fs.existsSync(AGY_EXE);
  statusCache = {
    claude: { ok: claudeOk, detail: claudeOk ? "Signed in" : "Not signed in - run: claude auth login" },
    chatgpt: !s.chatgptEnabled
      ? { ok: false, off: true, detail: "Switched off - turn it on in Settings" }
      : { ok: chatgptOk, detail: chatgptOk ? cxOut.split(/\r?\n/)[0] : "Not signed in" },
    gemini: {
      ok: geminiInstalled && lastOk.gemini !== false,
      detail: !geminiInstalled ? "Antigravity CLI (agy) not found" : lastOk.gemini === false ? "Last request failed" : "Ready (Antigravity)",
    },
    video: googleKeyState().connected ? { ok: true, detail: `Ready (${videoName(s.videoModel)})` } : { ok: false, off: true, detail: "Not connected - add your Google API key in Settings" },
    about: { version: VERSION, node: process.version, dataDir: DATA, test: !!FAKE_BRAIN },
  };
  statusAt = Date.now();
  return statusCache;
}
let geminiModels = null, geminiModelsAt = 0;
async function getGeminiModels() {
  if (geminiModels?.length && Date.now() - geminiModelsAt < 10 * 60_000) return geminiModels;
  geminiModels = await listGeminiModels();
  geminiModelsAt = Date.now();
  return geminiModels;
}

// ---------- saved prompts and saved answers ----------
const clip = (v, n) => String(v ?? "").slice(0, n);
function loadPrompts() {
  const list = readJson(PROMPTS_FILE, []);
  return Array.isArray(list) ? list.filter((p) => p && p.id && p.text) : [];
}
function loadSaved() {
  const list = readJson(SAVED_FILE, []);
  return Array.isArray(list) ? list : [];
}

function openInExplorer(target, name) {
  const dirs = { media: MEDIA, workspace: WORK, transcripts: LOGS, uploads: UPLOADS, data: DATA };
  const dir = dirs[target];
  if (!dir) throw new Error("Unknown folder");
  let args = [dir];
  if (name) {
    const file = path.join(MEDIA, path.basename(String(name)));
    if (!inside(MEDIA, file) || !fs.existsSync(file)) throw new Error("File not found");
    args = [`/select,"${file}"`];
  }
  if (NO_OPEN) return;
  spawn("explorer.exe", args, { detached: true, stdio: "ignore", windowsVerbatimArguments: true }).unref();
}

// ---------- http ----------
const ORIGINS = new Set([`http://${HOST}:${PORT}`, `http://localhost:${PORT}`]);
const HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`]);
const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif",
  ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime", ".svg": "image/svg+xml", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".json": "application/json",
};
// The page may only load its own files: nothing remote can be pulled in by an AI reply.
const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
const BASE_HEADERS = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };

class HttpError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const json = (res, code, obj) => { res.writeHead(code, { ...BASE_HEADERS, "Content-Type": "application/json", "Cache-Control": "no-store" }); res.end(JSON.stringify(obj)); };
function readBody(req, limit = 30 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0, over = false;
    req.on("data", (c) => { n += c.length; if (n > limit) over = true; else chunks.push(c); });
    req.on("end", () => (over ? reject(new HttpError(413, "That file is too large (limit 30 MB).")) : resolve(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}
function sendFile(res, dir, rel, extra = {}, range = "") {
  const file = path.resolve(dir, rel);
  if (!inside(dir, file) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, BASE_HEADERS); res.end("Not found"); return;
  }
  const head = { ...BASE_HEADERS, "Content-Type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "Cache-Control": "no-cache", "Accept-Ranges": "bytes", ...extra };
  // A part of the file (the video player asks for these when you jump around in a video).
  const size = fs.statSync(file).size;
  const m = /^bytes=(\d*)-(\d*)$/.exec(range || "");
  if (m && (m[1] || m[2]) && size > 0) {
    let from = m[1] ? Number(m[1]) : Math.max(0, size - Number(m[2]));
    let to = m[1] && m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (from > to || from >= size) { res.writeHead(416, { ...BASE_HEADERS, "Content-Range": `bytes */${size}` }); res.end(); return; }
    res.writeHead(206, { ...head, "Content-Range": `bytes ${from}-${to}/${size}`, "Content-Length": to - from + 1 });
    fs.createReadStream(file, { start: from, end: to }).pipe(res);
    return;
  }
  res.writeHead(200, { ...head, "Content-Length": size });
  fs.createReadStream(file).pipe(res);
}
const hello = () => ({
  type: "hello", busy: !!brain, session: { id: session.id, title: session.title || "" }, t: Date.now(),
});
const ready = () => ({
  type: "ready", busy: !!brain, phase, live, usage: lastUsage,
  queue: queue.map(({ id, text }) => ({ id, text })),
  direct: { chatgpt: !!direct.chatgpt, gemini: !!direct.gemini, video: !!direct.video },
  approvals: [...approvals.values()].map(approvalView), t: Date.now(),
});
// Pictures that were deleted since are left out of a replay, so the page never asks for a missing file.
function urlAlive(u) {
  try {
    const dir = u.startsWith("/media/") ? MEDIA : u.startsWith("/uploads/") ? UPLOADS : null;
    return !dir || fs.existsSync(path.join(dir, path.basename(decodeURIComponent(u.split("?")[0].split("/").pop()))));
  } catch { return false; }
}
function forReplay(ev) {
  if (ev.images?.some((u) => !urlAlive(u))) return { ...ev, images: ev.images.filter(urlAlive) };
  if (ev.type === "task" && ev.files?.some((f) => f.url && !urlAlive(f.url))) return { ...ev, files: ev.files.map((f) => (f.url && !urlAlive(f.url) ? { ...f, url: null } : f)) };
  return ev;
}
function replayTo(res) {
  write(res, hello());
  for (const ev of session.events) write(res, forReplay(ev));
  write(res, ready());
}
const idle = () => !brain && !directActive() && !direct.video && !queue.length;

const server = http.createServer(async (req, res) => {
  try {
    if (!HOSTS.has(req.headers.host)) { res.writeHead(403); res.end("Forbidden"); return; }
    // The browser extension comes from its own origin; it is let in only with the pairing code.
    if (req.url.startsWith("/api/inspect/ext/")) { await extRoute(req, res, req.url.split("?")[0]); return; }
    if (req.method !== "GET" && !ORIGINS.has(req.headers.origin)) { res.writeHead(403); res.end("Forbidden"); return; }
    const url = new URL(req.url, `http://${req.headers.host}`);
    const p = url.pathname;

    if (req.method === "GET") {
      if (p === "/api/ping") return json(res, 200, { app: "ai-brain", version: VERSION, build: BUILD });
      if (p === "/events") {
        res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        replayTo(res);
        clients.add(res);
        windowsChanged();
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 25_000);
        req.on("close", () => { clients.delete(res); clearInterval(ping); windowsChanged(); });
        return;
      }
      if (p === "/api/history") return json(res, 200, [hello(), ...session.events, ready()]);
      if (p === "/api/status") return json(res, 200, await getStatus(url.searchParams.has("force")));
      if (p === "/api/settings") return json(res, 200, loadSettings());
      if (p === "/api/gemini-models") return json(res, 200, await getGeminiModels());
      if (p === "/api/video") return json(res, 200, await videoInfo());
      if (p === "/api/sessions") return json(res, 200, listSessions(url.searchParams.get("q")));
      if (p === "/api/session/export") {
        const id = url.searchParams.get("id") || session.id;
        const s = id === session.id ? session : readSession(id);
        if (!s) return json(res, 404, { error: "Session not found" });
        const name = (s.title || "session").replace(/[^\w\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 50) || "session";
        res.writeHead(200, { ...BASE_HEADERS, "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename="ai-brain-${name}.md"` });
        res.end(exportMarkdown(s));
        return;
      }
      if (p === "/api/media") return json(res, 200, listMediaFiles());
      if (p === "/api/prompts") return json(res, 200, loadPrompts());
      if (p === "/api/saved") return json(res, 200, loadSaved().map(forReplay));
      if (p === "/api/stats") return json(res, 200, lifetimeStats());
      if (p === "/api/music") return json(res, 200, await musicStatus());
      if (p === "/api/discord") return json(res, 200, await discordStatus());
      if (p === "/api/inspect") return json(res, 200, inspectView());
      if (p === "/api/music/art") {
        const a = await musicArt();
        if (!a) { res.writeHead(404, BASE_HEADERS); return res.end(); }
        res.writeHead(200, { ...BASE_HEADERS, "Content-Type": a.mime, "Cache-Control": "no-store" });
        return res.end(a.buf);
      }
      if (p.startsWith("/media/")) return sendFile(res, MEDIA, decodeURIComponent(p.slice(7)), url.searchParams.has("download") ? { "Content-Disposition": "attachment" } : {}, req.headers.range);
      if (p.startsWith("/uploads/")) return sendFile(res, UPLOADS, decodeURIComponent(p.slice(9)), {}, req.headers.range);
      if (p.startsWith("/custom/")) return sendFile(res, CUSTOM, decodeURIComponent(p.slice(8)));
      return sendFile(res, PUB, p === "/" ? "index.html" : decodeURIComponent(p.slice(1)));
    }

    if (req.method === "POST") {
      if (p === "/api/upload") {
        const name = path.basename(url.searchParams.get("name") || "file").replace(/[^\w.\-]/g, "_").slice(-80);
        const dest = path.join(UPLOADS, `${Date.now().toString(36)}-${name}`);
        fs.writeFileSync(dest, await readBody(req));
        return json(res, 200, { path: dest, name, url: MEDIA_RE.test(dest) ? `/uploads/${encodeURIComponent(path.basename(dest))}` : null });
      }
      if (p === "/api/background") {
        const ext = path.extname(url.searchParams.get("name") || "").toLowerCase();
        if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) return json(res, 400, { error: "Use a PNG, JPG or WEBP picture." });
        const data = await readBody(req, 20 * 1024 * 1024);
        for (const f of fs.readdirSync(CUSTOM)) { try { fs.unlinkSync(path.join(CUSTOM, f)); } catch {} }
        const name = `bg-${Date.now().toString(36)}${ext}`;
        fs.writeFileSync(path.join(CUSTOM, name), data);
        const settings = saveSettings({ customBg: name });
        send({ type: "settings", settings });
        return json(res, 200, settings);
      }

      let body;
      // A picture of the program comes back with the answer to a step: allow more for that one.
      try { body = JSON.parse((await readBody(req, (p === "/api/apps/control/answer" ? 16 : 2) * 1024 * 1024)).toString() || "{}"); }
      catch (e) { if (e instanceof HttpError) throw e; return json(res, 400, { error: "Bad request" }); }
      if (!body || typeof body !== "object") return json(res, 400, { error: "Bad request" });

      if (p === "/api/inspect/request") { // from the brain's web_ tools; waits for the browser extension
        const key = String(req.headers["x-brain-key"] || "");
        if (!ctlKey || !brain || !sameKey(key, ctlKey)) return json(res, 403, { ok: false, why: "Not allowed: wrong key, or no task is running." });
        if (!loadSettings().inspectBrain) return json(res, 200, { ok: false, why: "The user switched off \"Let the brain inspect your shared tabs\" in Settings." });
        const cmd = String(body.cmd || "");
        if (!INSPECT_CMDS.has(cmd)) return json(res, 400, { ok: false, why: "Unknown step." });
        const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
        let gone = false;
        res.on("close", () => { gone = !res.writableEnded; });
        const r = await askInspect(cmd, args);
        if (gone) return;
        return json(res, 200, r && typeof r === "object" ? r : { ok: false, why: "no answer" });
      }
      if (p === "/api/inspect/code") { // Settings: show the pairing code, or make a new one
        const code = body.renew === true || !inspectCode() ? newInspectCode() : inspectCode();
        send({ type: "inspect", ...inspectView() });
        return json(res, 200, { code, ...inspectView() });
      }
      if (p === "/api/apps/control") { // from the brain's app_ tools; waits for the desktop window
        const key = String(req.headers["x-brain-key"] || "");
        const ok = !!ctlKey && !!brain && key.length === ctlKey.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(ctlKey));
        if (!ok) return json(res, 403, { ok: false, why: "Not allowed: wrong key, or no task is running." });
        if (!loadSettings().appsBrain) return json(res, 200, { ok: false, why: "The user switched off \"Let the brain use the program in the middle\" in Settings." });
        const cmd = String(body.cmd || "");
        if (!CONTROL_CMDS.has(cmd)) return json(res, 400, { ok: false, why: "Unknown step." });
        const args = body.args && typeof body.args === "object" && !Array.isArray(body.args) ? body.args : {};
        let gone = false;
        res.on("close", () => { gone = !res.writableEnded; });
        const r = await askControl(cmd, args);
        if (gone) return;
        return json(res, 200, r && typeof r === "object" ? r : { ok: false, why: "no answer" });
      }
      if (p === "/api/apps/control/answer") { // from the page; the first real answer wins
        const c = controls.get(String(body.id || ""));
        if (!c) return json(res, 404, { error: "That step was already answered or has ended." });
        const result = body.result && typeof body.result === "object" ? body.result : { ok: false, why: "no answer" };
        if (body.soft === true) {
          // A window that cannot do it: wait a little for one that can.
          if (!c.soft) { c.soft = result; c.softTimer = setTimeout(() => finishControl(c, c.soft), 4000); }
        } else finishControl(c, result);
        return json(res, 200, { ok: true });
      }
      if (p === "/api/approval/ask") { // from the brain's approve tool; waits for the user's click
        const key = String(req.headers["x-brain-key"] || "");
        const ok = !!runKey && key.length === runKey.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(runKey));
        if (!ok) return json(res, 403, { behavior: "deny", message: "Not allowed: wrong key." });
        const a = askApproval(body);
        res.on("close", () => { if (!res.writableEnded) finishApproval(a, false, "Claude stopped waiting"); });
        return json(res, 200, await a.answer);
      }
      if (p === "/api/approval/answer") { // from the window; the first answer wins
        const a = approvals.get(String(body.id || ""));
        if (!a) return json(res, 404, { error: "That request was already answered or has ended." });
        if (body.allow === true && body.all === true && FILE_TOOLS.has(a.tool)) allowFilesThisRun = true;
        finishApproval(a, body.allow === true);
        return json(res, 200, { ok: true });
      }

      if (p === "/api/task") {
        const text = String(body.text || "").trim();
        if (!text) return json(res, 400, { error: "Type a task first." });
        const mode = modeOf(body.mode);
        if (text.length > 100_000) return json(res, 413, { error: "That task is too long." });
        const files = (Array.isArray(body.files) ? body.files : []).map((f) => path.resolve(String(f)))
          .filter((f) => (inside(UPLOADS, f) || inside(MEDIA, f)) && fs.existsSync(f)).slice(0, 20);
        if (brain || directActive()) {
          if (queue.length >= 20) return json(res, 409, { error: "The queue is full (20 tasks)." });
          queue.push({ id: newId(), text, files, mode });
          sendQueue();
          return json(res, 200, { ok: true, queued: true });
        }
        try { startBrain(text, files, false, mode); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 409, { error: e.message }); }
      }
      if (p === "/api/queue/remove") {
        queue = queue.filter((q) => q.id !== body.id);
        sendQueue();
        return json(res, 200, { ok: true });
      }
      if (p === "/api/ask" || p === "/api/image") {
        const image = p === "/api/image";
        const to = image ? "gemini" : body.to === "chatgpt" ? "chatgpt" : body.to === "gemini" ? "gemini" : null;
        const text = String(body.text || "").trim();
        if (!to || !text) return json(res, 400, { error: "Type a message first." });
        if (text.length > 100_000) return json(res, 413, { error: "That message is too long." });
        if (to === "chatgpt" && !loadSettings().chatgptEnabled) return json(res, 409, { error: "ChatGPT is switched off. Turn it on in Settings." });
        if (direct[to]) return json(res, 409, { error: "Still waiting for the previous reply." });
        if (brain) return json(res, 409, { error: "The brain is using the helpers right now - wait until the task finishes." });
        return json(res, 200, { ok: true, id: directAsk(to, text, { image }) });
      }
      if (p === "/api/video") {
        const text = String(body.text || "").trim();
        if (!text) return json(res, 400, { error: "Describe the video first." });
        if (text.length > 8000) return json(res, 413, { error: "That description is too long." });
        if (!googleKeyState().connected) return json(res, 409, { error: NO_VIDEO_KEY, nokey: true });
        if (direct.video) return json(res, 409, { error: "A video is still being made. Wait for it, or stop it first." });
        const s = loadSettings();
        const limit = s.videoDailyLimit;
        if (limit && readVideoUsage().today >= limit) return json(res, 409, { error: `Today's video limit (${limit}) is reached. You can raise it in Settings, under Video.` });
        const opts = {
          model: typeof body.model === "string" && body.model ? body.model : undefined,
          aspect: body.aspect === "9:16" ? "9:16" : "16:9",
          seconds: Number.isInteger(body.seconds) ? body.seconds : undefined,
          resolution: body.resolution === "1080p" ? "1080p" : "720p",
        };
        if (body.image) {
          // A picture from the Gallery or an attachment as the first frame.
          const m = /^\/(media|uploads)\/([^/?#]+)$/.exec(String(body.image));
          const file = m ? path.join(m[1] === "media" ? MEDIA : UPLOADS, decodeURIComponent(m[2])) : "";
          if (!m || !inside(m[1] === "media" ? MEDIA : UPLOADS, file) || !/\.(png|jpe?g|webp)$/i.test(file) || !fs.existsSync(file)) return json(res, 400, { error: "That picture cannot be used as the start of a video." });
          if (!isVeo(opts.model || s.videoModel)) return json(res, 400, { error: "Starting from a picture needs a Veo model. Pick one in Settings, under Video." });
          opts.imagePath = file;
        }
        return json(res, 200, { ok: true, id: directVideo(text, opts) });
      }
      if (p === "/api/google-key") {
        if (direct.video) return json(res, 409, { error: "A video is being made. Wait for it, or stop it first." });
        let state;
        if (body.remove) state = removeGoogleKey();
        else { try { state = await saveGoogleKey(body.key); } catch (e) { return json(res, 400, { error: String(e?.message || e) }); } }
        videoModels = null;
        statusAt = 0;
        writeMcpConfig();
        emit({ type: "log", level: "info", text: state.connected ? "Video: the Google key was saved." : "Video: the Google key was removed." });
        send({ type: "video_state" });
        return json(res, 200, await videoInfo());
      }
      if (p === "/api/ask/stop") {
        if (body.to === "video") { direct.video?.abort(); return json(res, 200, { ok: true }); }
        const to = body.to === "chatgpt" ? "chatgpt" : "gemini";
        direct[to]?.abort();
        return json(res, 200, { ok: true });
      }
      if (p === "/api/stop") {
        if (queue.length) { queue = []; sendQueue(); }
        denyAllApprovals("you pressed Stop");
        endControls("the user pressed Stop");
        endInspects("the user pressed Stop");
        if (brain) { stoppedByUser = true; emit({ type: "log", level: "warn", text: "Stopped by you." }); killTree(brain); }
        return json(res, 200, { ok: true });
      }

      if (p === "/api/session/new" || p === "/api/session/switch") {
        if (!idle()) return json(res, 409, { error: "Wait for the current work to finish (or press Stop) first." });
        let next;
        if (p === "/api/session/switch") {
          if (body.id === session.id) return json(res, 200, { ok: true });
          next = readSession(body.id);
          if (!next) return json(res, 404, { error: "That session no longer exists." });
          closeDangling(next.events);
        } else {
          if (!session.events.length) return json(res, 200, { ok: true }); // already a fresh one
          next = blankSession();
        }
        flushSession();
        activate(next);
        for (const c of clients) replayTo(c);
        send({ type: "sessions" });
        return json(res, 200, { ok: true, id: next.id });
      }
      if (p === "/api/session/rename" || p === "/api/session/pin") {
        const s = body.id === session.id ? session : readSession(body.id);
        if (!s) return json(res, 404, { error: "That session no longer exists." });
        if (p === "/api/session/rename") {
          const title = clip(body.title, 70).replace(/\s+/g, " ").trim();
          if (!title) return json(res, 400, { error: "Give it a name." });
          s.title = title;
        } else s.pinned = !!body.pinned;
        if (s === session) { flushSession(); if (!s.events.length) index.delete(s.id); }
        else { writeJson(sessionFile(s.id), s, false); index.set(s.id, metaOf(s)); }
        send({ type: "sessions" });
        if (s === session) send({ type: "title", title: s.title });
        return json(res, 200, { ok: true });
      }
      if (p === "/api/session/delete") {
        if (!ID_RE.test(String(body.id))) return json(res, 400, { error: "Bad request" });
        if (body.id === session.id) {
          if (!idle()) return json(res, 409, { error: "Wait for the current work to finish (or press Stop) first." });
          clearTimeout(saveTimer); saveTimer = null;
          try { fs.unlinkSync(sessionFile(session.id)); } catch {}
          index.delete(session.id);
          activate(blankSession());
          for (const c of clients) replayTo(c);
        } else {
          try { fs.unlinkSync(sessionFile(body.id)); } catch {}
          index.delete(body.id);
        }
        send({ type: "sessions" });
        return json(res, 200, { ok: true });
      }

      if (p === "/api/settings") {
        if ("folders" in body) {
          if (!Array.isArray(body.folders) || body.folders.length > 8) return json(res, 400, { error: "Up to 8 folders." });
          for (const f of body.folders) { const why = folderProblem(f); if (why) return json(res, 400, { error: why }); }
          body.folders = [...new Set(body.folders.map((f) => path.resolve(f)))];
        }
        if ("discordChats" in body && !(Array.isArray(body.discordChats) && body.discordChats.length <= 24 && body.discordChats.every(isDiscordChat)))
          return json(res, 400, { error: "That chat could not be pinned. Use a name and a Discord chat link." });
        const settings = saveSettings(body);
        if (settings.access === "auto") { for (const a of [...approvals.values()]) finishApproval(a, true, "always allow was switched on"); }
        else if (settings.access !== "ask") denyAllApprovals("file and command access was switched off");
        if (!settings.appsBrain) endControls("the user switched off \"Let the brain use the program in the middle\"");
        if (!settings.inspectBrain) endInspects("the user switched off \"Let the brain inspect your shared tabs\"");
        if (body.customBg === null) for (const f of fs.readdirSync(CUSTOM)) { try { fs.unlinkSync(path.join(CUSTOM, f)); } catch {} }
        writeMcpConfig(settings);
        statusAt = 0;
        send({ type: "settings", settings });
        return json(res, 200, settings);
      }
      if (p === "/api/prompts") {
        if (!Array.isArray(body.prompts)) return json(res, 400, { error: "Bad request" });
        const list = body.prompts.slice(0, 200)
          .map((x) => ({ id: clip(x?.id, 40) || newId(), title: clip(x?.title, 80).trim(), text: clip(x?.text, 20_000) }))
          .filter((x) => x.title && x.text.trim());
        writeJson(PROMPTS_FILE, list);
        send({ type: "prompts" });
        return json(res, 200, list);
      }
      if (p === "/api/saved/add") {
        const text = clip(body.text, 200_000);
        if (!text.trim()) return json(res, 400, { error: "Nothing to save." });
        const item = {
          id: newId(), t: Date.now(), who: clip(body.who, 20) || "claude", text,
          images: (Array.isArray(body.images) ? body.images : []).map(String).filter((u) => /^\/(media|uploads)\/[\w.\-%]+$/.test(u)).slice(0, 20),
          session: session.title || "",
        };
        const list = [item, ...loadSaved()].slice(0, 500);
        writeJson(SAVED_FILE, list);
        send({ type: "saved" });
        return json(res, 200, item);
      }
      if (p === "/api/saved/delete") {
        writeJson(SAVED_FILE, loadSaved().filter((x) => x.id !== body.id));
        send({ type: "saved" });
        return json(res, 200, { ok: true });
      }
      if (p === "/api/media/delete") {
        const file = path.join(MEDIA, path.basename(String(body.name || "")));
        if (!inside(MEDIA, file) || !MEDIA_RE.test(file) || !fs.existsSync(file)) return json(res, 404, { error: "File not found" });
        fs.unlinkSync(file);
        send({ type: "media" });
        return json(res, 200, { ok: true });
      }
      if (p === "/api/music/cmd") return json(res, 200, await musicCommand(String(body.cmd || ""), body.arg));
      if (p === "/api/discord/open") {
        if (body.chat === undefined) return json(res, 200, openDiscord());
        const r = openDiscordChat(body.chat);
        return json(res, r.ok ? 200 : 400, r.ok ? r : { error: r.error });
      }
      if (p === "/api/open-app") {
        try { return json(res, 200, { ok: true, uri: openApp(String(body.app || ""), body.q ? String(body.q) : "") }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (p === "/api/open") {
        try { openInExplorer(String(body.target || ""), body.name); return json(res, 200, { ok: true }); }
        catch (e) { return json(res, 400, { error: e.message }); }
      }
      if (p === "/api/login/chatgpt") {
        // Opens a terminal window running "codex login" (it opens the browser to sign in).
        if (!NO_OPEN) spawn("cmd.exe", ["/c", `start "ChatGPT sign-in" "${process.execPath}" "${CODEX_JS}" login`], {
          windowsVerbatimArguments: true, detached: true, stdio: "ignore",
        }).unref();
        statusAt = 0;
        return json(res, 200, { ok: true });
      }
      // The brain's Flow tools ask the window to open Google Flow (the window decides; it only opens Flow).
      if (p === "/api/flow/open") {
        send({ type: "flow-open" });
        return json(res, 200, { ok: true, windows: clients.size });
      }
      if (p === "/api/shutdown") {
        json(res, 200, { ok: true });
        shutdown();
        return;
      }
    }
    res.writeHead(404, BASE_HEADERS); res.end("Not found");
  } catch (e) {
    if (!(e instanceof HttpError)) slog("request error", e.stack || e);
    if (!res.headersSent) json(res, e instanceof HttpError ? e.code : 500, { error: String(e.message || e) });
  }
});

function shutdown() {
  stopMusic();
  queue = [];
  if (brain) { stoppedByUser = true; killTree(brain); }
  for (const who of ["chatgpt", "gemini", "video"]) direct[who]?.abort();
  try { flushSession(); } catch {}
  setTimeout(() => process.exit(0), 400);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("uncaughtException", (e) => slog("uncaught", e.stack || e));
process.on("unhandledRejection", (e) => slog("unhandled", e?.stack || e));

initSessions();
writeMcpConfig();
server.on("error", (e) => { slog("server error", e.code || e); process.exit(e.code === "EADDRINUSE" ? 0 : 1); });
server.listen(PORT, HOST, () => slog(`AI Brain ${VERSION} running at http://${HOST}:${PORT} (claude: ${FAKE_BRAIN ? "TEST SCRIPT" : CLAUDE_EXE})`));
