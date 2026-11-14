// Core logic: run ChatGPT (Codex CLI) and Gemini (Antigravity CLI, agy) headlessly,
// using the user's subscription logins. No API keys. Both run read-only in ./workspace.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
// All user data lives under DATA (the project folder by default). Tests point this elsewhere.
export const DATA = process.env.BRAIN_DATA_DIR ? path.resolve(process.env.BRAIN_DATA_DIR) : HERE;
const NPM_ROOT =
  process.env.NPM_GLOBAL_ROOT ||
  path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "npm", "node_modules");

export const CODEX_JS = path.join(NPM_ROOT, "@openai", "codex", "bin", "codex.js");
// Gemini: Google retired Gemini CLI login for personal accounts, so we use the
// Antigravity CLI (agy), which signs in with the user's Google account.
export const AGY_EXE =
  process.env.AGY_EXE || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "agy", "bin", "agy.exe");
// Where Antigravity saves the images it generates (one folder per conversation).
const AGY_BRAIN = process.env.AGY_BRAIN_DIR || path.join(os.homedir(), ".gemini", "antigravity-cli", "brain");

export const WORK = path.join(DATA, "workspace");
export const MEDIA = path.join(WORK, "media");
export const LOGS = path.join(DATA, "conversations");
const STATE_FILE = path.join(DATA, "state.json");
const SETTINGS_FILE = path.join(DATA, "settings.json");
const TIMEOUT_MS = Number(process.env.BRAIN_TIMEOUT_MS || 300_000);
export const MEDIA_RE = /\.(png|jpe?g|webp|gif|mp4|webm|mov)$/i;
// Test mode: canned helper replies instead of calling the real CLIs.
const FAKE_HELPERS = process.env.BRAIN_FAKE_HELPERS === "1";

fs.mkdirSync(MEDIA, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

// ---------- small json files ----------
export function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
// Write through a temp file so a crash can never leave a half-written file behind.
export function writeJson(file, obj, pretty = true) {
  const data = JSON.stringify(obj, null, pretty ? 2 : 0);
  const tmp = `${file}.${process.pid}.tmp`;
  try { fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }
  catch {
    try { fs.writeFileSync(file, data); } catch { /* disk problem - nothing more we can do */ }
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
  }
}

export function loadState() { return readJson(STATE_FILE, {}) || {}; }
// Re-read just before writing so the app and the MCP server never erase each other's IDs.
export function updateState(patch) {
  const s = { ...loadState(), ...patch };
  for (const k of Object.keys(s)) if (s[k] === undefined || s[k] === null) delete s[k];
  writeJson(STATE_FILE, s);
}

// ---------- settings ----------
export const THEMES = ["dark", "clover", "neon", "demon", "wind"];
export const ACCENTS = ["blue", "violet", "green", "amber", "rose", "mono"];
export const DEFAULT_SETTINGS = {
  theme: "dark",          // one of THEMES
  accent: "blue",         // one of ACCENTS (used by the dark theme)
  density: "compact",     // compact | cozy
  layout: "",             // the workstation layout as JSON text (panel places and sizes); "" = the default
  clock24: true,          // 24-hour clock in the status bar
  animations: true,
  customBg: null,         // file name inside DATA/custom, or null
  bgDim: 70,              // how dark the overlay on a custom background is (0-95)
  brainModel: "opus",     // auto | fable | opus | sonnet | haiku
  effort: "auto",         // auto | low | medium | high
  geminiModel: "auto",    // auto | a model id from "agy models"
  chatgptEnabled: false,
  sounds: true,
  notify: false,
  fontSize: 14,           // 12-18
  answerStyle: "auto",    // auto | short | detailed
  instructions: "",       // the user's standing instructions for the brain (max 2000 characters)
  access: "read",         // read = the brain can only read; ask = it may also write files and run commands, after you click Allow
  folders: [],            // extra folders (absolute paths) the brain may work in when access is "ask"
  discordChats: [],       // chats pinned in the Discord panel: { name, place: "@me" or a server id, chat: a channel id }
};
// A pinned Discord chat holds only a name you typed and the two numbers from its link.
const DISCORD_ID = /^\d{15,22}$/;
export function isDiscordChat(c) {
  return !!c && typeof c === "object" && !Array.isArray(c) && Object.keys(c).length === 3
    && typeof c.name === "string" && c.name.trim().length >= 1 && c.name.length <= 40 && !/[\u0000-\u001f\u007f]/.test(c.name)
    && (c.place === "@me" || (typeof c.place === "string" && DISCORD_ID.test(c.place)))
    && typeof c.chat === "string" && DISCORD_ID.test(c.chat);
}
const RULES = {
  theme: (v) => THEMES.includes(v),
  accent: (v) => ACCENTS.includes(v),
  density: (v) => ["compact", "cozy"].includes(v),
  layout: (v) => typeof v === "string" && v.length <= 6000,
  clock24: (v) => typeof v === "boolean",
  animations: (v) => typeof v === "boolean",
  customBg: (v) => v === null || (typeof v === "string" && /^[\w.\-]{1,120}$/.test(v)),
  bgDim: (v) => Number.isInteger(v) && v >= 0 && v <= 95,
  brainModel: (v) => ["auto", "fable", "opus", "sonnet", "haiku"].includes(v),
  effort: (v) => ["auto", "low", "medium", "high"].includes(v),
  geminiModel: (v) => typeof v === "string" && /^[\w.\-]{1,60}$/.test(v),
  chatgptEnabled: (v) => typeof v === "boolean",
  sounds: (v) => typeof v === "boolean",
  notify: (v) => typeof v === "boolean",
  fontSize: (v) => Number.isInteger(v) && v >= 12 && v <= 18,
  answerStyle: (v) => ["auto", "short", "detailed"].includes(v),
  instructions: (v) => typeof v === "string" && v.length <= 2000,
  access: (v) => ["read", "ask"].includes(v),
  folders: (v) => Array.isArray(v) && v.length <= 8 && v.every((f) => typeof f === "string" && f.length <= 260 && /^[A-Za-z]:[\\/]/.test(f)),
  discordChats: (v) => Array.isArray(v) && v.length <= 24 && v.every(isDiscordChat),
};
export function loadSettings() {
  const saved = readJson(SETTINGS_FILE, {}) || {};
  const out = { ...DEFAULT_SETTINGS };
  for (const k of Object.keys(RULES)) if (k in saved && RULES[k](saved[k])) out[k] = saved[k];
  return out;
}
/** Apply a partial change. Unknown keys and invalid values are ignored. Returns the new settings. */
export function saveSettings(patch) {
  const next = loadSettings();
  for (const k of Object.keys(RULES)) if (patch && k in patch && RULES[k](patch[k])) next[k] = patch[k];
  writeJson(SETTINGS_FILE, next);
  return next;
}

// ---------- running the CLIs ----------
function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
  else child.kill();
}

// Run a node CLI entry file directly (no shell, so prompts need no escaping).
function runNode(entry, args, opts) {
  return runExe(process.execPath, [entry, ...args], opts, entry);
}

// Run an executable directly (no shell). opts.signal (AbortSignal) stops it early.
export function runExe(exe, args, { stdin, timeoutMs = TIMEOUT_MS, signal } = {}, mustExist = exe) {
  return new Promise((resolve) => {
    if (path.isAbsolute(mustExist) && !fs.existsSync(mustExist)) {
      resolve({ code: -1, stdout: "", stderr: `Not installed: ${mustExist}` });
      return;
    }
    if (signal?.aborted) { resolve({ code: -1, stdout: "", stderr: "Stopped.", aborted: true }); return; }
    const child = spawn(exe, args, {
      cwd: WORK,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      windowsHide: true,
    });
    let stdout = "", stderr = "", timedOut = false, aborted = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    const timer = setTimeout(() => { timedOut = true; killTree(child); }, timeoutMs);
    const onAbort = () => { aborted = true; killTree(child); };
    signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.stdin.on("error", () => { /* the process ended before reading its input */ });
    child.on("error", (e) => { stderr += String(e); });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (timedOut) stderr += `\n[timed out after ${timeoutMs / 1000}s]`;
      resolve({ code, stdout, stderr, aborted });
    });
    if (stdin !== undefined) child.stdin.end(stdin); else child.stdin.end();
  });
}

function log(who, prompt, reply) {
  const day = new Date().toISOString().slice(0, 10);
  const time = new Date().toLocaleTimeString();
  const entry = `\n## ${time} - ${who}\n\n${prompt}\n\n### ${who} replied\n\n${reply}\n`;
  try { fs.appendFileSync(path.join(LOGS, `${day}.md`), entry); } catch { /* transcript is best-effort */ }
}

const stopped = () => Object.assign(new Error("Stopped."), { stopped: true });

// Canned replies for tests (BRAIN_FAKE_HELPERS=1) - never used in the real app.
async function fakeHelper(who, prompt, signal) {
  const wait = Number(process.env.BRAIN_FAKE_DELAY_MS || 500);
  await new Promise((ok) => {
    const t = setTimeout(ok, /\[slow\]/i.test(prompt) ? 60_000 : wait);
    signal?.addEventListener("abort", () => { clearTimeout(t); ok(); }, { once: true });
  });
  if (signal?.aborted) throw stopped();
  if (/\[fail\]/i.test(prompt)) throw new Error(`${who} test failure.`);
  const images = [];
  let text = `**${who} (test reply)** to: ${prompt.slice(0, 200)}`;
  if (/image/i.test(prompt) && process.env.BRAIN_FAKE_IMAGE && !/\[noimage\]/i.test(prompt)) {
    const dest = path.join(MEDIA, `${Date.now().toString(36)}-test_image${path.extname(process.env.BRAIN_FAKE_IMAGE)}`);
    fs.copyFileSync(process.env.BRAIN_FAKE_IMAGE, dest);
    images.push(dest);
    text += `\n\nSaved files:\n${dest}`;
  }
  return { text, images };
}

/** Ask ChatGPT via the Codex CLI. Returns { text, images }. */
export async function askChatGPT(prompt, { newConversation = false, imagePaths = [], model, signal } = {}) {
  if (FAKE_HELPERS) return fakeHelper("ChatGPT", prompt, signal);
  const state = loadState();
  const outFile = path.join(os.tmpdir(), `ai-brain-codex-${process.pid}-${Date.now()}.txt`);
  const common = ["--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', "-o", outFile];
  if (model) common.push("-m", model);
  for (const img of imagePaths) common.push("-i", img);

  // Fail fast (instead of ~70s of reconnect retries) when not signed in.
  const st = await runNode(CODEX_JS, ["login", "status"], { timeoutMs: 30_000, signal });
  if (st.aborted) throw stopped();
  if (/not logged in/i.test(st.stdout + st.stderr)) {
    throw new Error('ChatGPT is not signed in. Sign in with "codex login" (or press Sign in in the AI Brain app).');
  }

  const resume = !newConversation && state.chatgptThread;
  const args = resume
    ? ["exec", "resume", ...common, state.chatgptThread, "-"]
    : ["exec", ...common, "-"];

  const r = await runNode(CODEX_JS, args, { stdin: prompt, signal });
  if (r.aborted) { try { fs.unlinkSync(outFile); } catch {} throw stopped(); }

  let threadId = resume ? state.chatgptThread : undefined;
  let lastMsg = "", errors = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.thread_id) threadId = ev.thread_id;
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") lastMsg = ev.item.text ?? lastMsg;
      if (ev.type === "error" || ev.type === "turn.failed") errors.push(ev.message || ev.error?.message || line);
    } catch { /* ignore non-JSON */ }
  }
  try { lastMsg = fs.readFileSync(outFile, "utf8").trim() || lastMsg; fs.unlinkSync(outFile); } catch {}

  if (!lastMsg) {
    let why = errors.join("\n") || r.stderr.trim().split(/\r?\n/).slice(-8).join("\n") || `exit code ${r.code}`;
    if (/log ?in|auth|401|unauthori/i.test(why)) why = `Not signed in to ChatGPT. Run "codex login" (or press Sign in in the app).\n${why}`;
    throw new Error(`ChatGPT (Codex CLI) gave no reply.\n${why}`);
  }
  if (threadId) updateState({ chatgptThread: threadId });
  log("ChatGPT", prompt, lastMsg);
  return { text: lastMsg, images: [] };
}

function listMedia(dir) {
  try { return new Set(fs.readdirSync(dir).filter((f) => MEDIA_RE.test(f))); } catch { return new Set(); }
}

// Gemini calls run one at a time: they share one conversation, and new images
// are matched to the call that made them.
let geminiQueue = Promise.resolve();
/** Ask Gemini via the Antigravity CLI (agy). Returns { text, images } - images are copied into workspace/media. */
export function askGemini(prompt, opts) {
  const run = geminiQueue.then(async () => {
    const t0 = Date.now();
    try {
      const r = await askGeminiNow(prompt, opts);
      const u = r.usage || (FAKE_HELPERS ? { in: 120, out: 30, total: 150 } : {});
      recordGemini({ kind: "call", ok: true, ms: Date.now() - t0, in: u.in || 0, out: u.out || 0, total: u.total || 0, pictures: r.images.length });
      return r;
    } catch (e) {
      if (!e?.stopped) {
        const quota = QUOTA_RE.test(String(e?.message || ""));
        recordGemini({ kind: "call", ok: false, ms: Date.now() - t0, quota });
      }
      throw e;
    }
  });
  geminiQueue = run.catch(() => {});
  return run;
}

// ---------- Gemini usage (counted on this PC; the app server and the MCP server both write here) ----------
const GEMINI_USAGE_FILE = path.join(DATA, "usage-gemini.jsonl");
const QUOTA_RE = /RESOURCE_EXHAUSTED|\b429\b|quota|capacity exhausted/i;
function recordGemini(entry) {
  try { fs.appendFileSync(GEMINI_USAGE_FILE, JSON.stringify({ t: Date.now(), ...entry }) + "\n"); } catch { /* best-effort */ }
}
/** Every recorded Gemini call, oldest first: [{ t, kind, ok, ms, in, out, total, pictures, quota, resets }]. */
export function readGeminiUsage() {
  let raw = "";
  try { raw = fs.readFileSync(GEMINI_USAGE_FILE, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { const j = JSON.parse(line); if (j && typeof j.t === "number") out.push(j); } catch { /* skip a broken line */ }
  }
  if (out.length > 20_000) { // keep the file small
    const keep = out.slice(-10_000);
    try { fs.writeFileSync(GEMINI_USAGE_FILE, keep.map((j) => JSON.stringify(j)).join("\n") + "\n"); } catch { /* ignore */ }
    return keep;
  }
  return out;
}

async function askGeminiNow(prompt, { newConversation = false, model, signal } = {}) {
  if (signal?.aborted) throw stopped();
  if (FAKE_HELPERS) return fakeHelper("Gemini", prompt, signal);
  const state = loadState();
  const resumeId = !newConversation && state.geminiConversation;
  const chosen = model || loadSettings().geminiModel;
  // --mode plan = read-only: it can think, answer and generate images, but not change files.
  const args = ["-p", prompt, "--output-format", "json", "--mode", "plan", "--print-timeout", `${Math.floor(TIMEOUT_MS / 1000)}s`];
  if (chosen && chosen !== "auto") args.push("--model", chosen);
  if (resumeId) args.push("--conversation", resumeId);

  const before = resumeId ? listMedia(path.join(AGY_BRAIN, resumeId)) : new Set();
  const r = await runExe(AGY_EXE, args, { signal });
  if (r.aborted) throw stopped();

  let reply = "", j = null;
  const start = r.stdout.indexOf("{");
  if (start >= 0) {
    try { j = JSON.parse(r.stdout.slice(start, r.stdout.lastIndexOf("}") + 1)); } catch { /* not JSON */ }
  }
  if (j) {
    if (j.status && j.status !== "SUCCESS" && !j.response) {
      throw new Error(`Gemini (Antigravity) returned status ${j.status}: ${j.error?.message || j.error || ""}`);
    }
    reply = String(j.response ?? "").trim();
  } else {
    reply = r.stdout.trim();
  }
  if (!reply) {
    const why = r.stderr.trim().split(/\r?\n/).slice(-8).join("\n") || `exit code ${r.code}`;
    throw new Error(`Gemini (Antigravity CLI) gave no reply.\n${why}`);
  }

  // Collect any images/videos Gemini generated during this turn.
  const images = [];
  const convId = j?.conversation_id || resumeId;
  if (convId) {
    const dir = path.join(AGY_BRAIN, convId);
    for (const f of listMedia(dir)) {
      if (before.has(f)) continue;
      const dest = path.join(MEDIA, `${Date.now().toString(36)}-${f}`);
      try {
        fs.copyFileSync(path.join(dir, f), dest);
        images.push(dest);
        reply = reply.split(path.join(dir, f)).join(dest);
      } catch { /* skip */ }
    }
    updateState({ geminiConversation: convId });
  }
  if (images.length) reply += `\n\nSaved files:\n${images.join("\n")}`;
  log("Gemini", prompt, reply);
  const u = j?.usage;
  const usage = u ? { in: Number(u.input_tokens) || 0, out: (Number(u.output_tokens) || 0) + (Number(u.thinking_tokens) || 0), total: Number(u.total_tokens) || 0 } : null;
  return { text: reply, images, usage };
}

/** Have Gemini generate an image. Fails if no image file was produced. */
/** Why no picture came back, in plain words (quota problems get their own clear line). */
export function noImageMessage(said) {
  const text = String(said || "").trim();
  if (/RESOURCE_EXHAUSTED|\b429\b|quota|capacity exhausted/i.test(text)) {
    const when = text.match(/resets? in (?:about |~)?([^).\n]{1,40})/i);
    return `Gemini's picture limit is used up for now${when ? ` - it resets in about ${when[1].trim()}` : ""}. ` +
      `Text answers still work. Try the picture again later.\n\nGemini said:\n${text}`;
  }
  return `Gemini did not produce an image. It said:\n${text}`;
}

export async function generateImage(description, opts) {
  const r = await askGemini(
    "Generate an image with your image generation tool. Do not write or copy any files yourself. " +
      `Generate it right away: do not write a plan and do not ask for confirmation first.\n\nImage: ${description}`,
    opts
  );
  if (!r.images.length) {
    if (QUOTA_RE.test(r.text)) {
      const when = r.text.match(/resets? in (?:about |~)?([^).\n]{1,40})/i);
      recordGemini({ kind: "quota", what: "pictures", resets: when ? when[1].trim() : "" });
    }
    throw new Error(noImageMessage(r.text));
  }
  return r;
}

/** The Gemini models the Antigravity CLI offers: [{ id, label }]. */
export async function listGeminiModels() {
  if (FAKE_HELPERS) return [{ id: "gemini-test-high", label: "Gemini Test (High)" }, { id: "gemini-test-low", label: "Gemini Test (Low)" }];
  const r = await runExe(AGY_EXE, ["models"], { timeoutMs: 30_000 });
  const out = [];
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^(gemini[\w.\-]+)\s+(.+)$/i);
    if (m) out.push({ id: m[1], label: m[2].trim() });
  }
  return out;
}

export function resetConversations() {
  updateState({ chatgptThread: null, geminiConversation: null, claudeSession: null });
}
