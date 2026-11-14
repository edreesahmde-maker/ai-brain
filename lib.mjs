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
export const THEMES = ["dark", "neon", "goth", "berserk"];
// Themes that were removed in 3.1 and the theme that replaces them.
const OLD_THEMES = { clover: "berserk", demon: "berserk", wind: "berserk" };
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
  memoryLimit: 100,       // k tokens: past this Claude Code sums the conversation up (0 = never)
  geminiModel: "auto",    // auto | a model id from "agy models"
  chatgptEnabled: false,
  flowBrain: true,        // the brain may use the Google Flow window (open in AI Brain) to make videos
  appsBrain: false,       // the brain may use the program in the middle of AI Brain with the mouse and keyboard
  inspectBrain: false,    // the brain may inspect tabs the user shared with the AI Brain extension in their own browser
  sounds: true,
  notify: false,
  fontSize: 14,           // 12-18
  answerStyle: "auto",    // auto | short | detailed
  instructions: "",       // the user's standing instructions for the brain (max 2000 characters)
  access: "read",         // read = the brain can only read; ask = it may also write files and run commands, after you click Allow;
                          // auto = the same, but nothing waits for a click (always allow)
  folders: [],            // extra folders (absolute paths) the brain may work in when access is "ask" or "auto"
  discordChats: [],       // chats pinned in the Discord panel: { name, place: "@me" or a server id, chat: a channel id }
  videoModel: "veo-3.1-generate-preview", // the Google model that makes videos (Veo, or another video model id)
  videoDailyLimit: 10,    // videos per day at most (each one costs money on the Google key); 0 = no limit
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
  memoryLimit: (v) => [0, 60, 100, 150].includes(v),
  geminiModel: (v) => typeof v === "string" && /^[\w.\-]{1,60}$/.test(v),
  chatgptEnabled: (v) => typeof v === "boolean",
  flowBrain: (v) => typeof v === "boolean",
  appsBrain: (v) => typeof v === "boolean",
  inspectBrain: (v) => typeof v === "boolean",
  sounds: (v) => typeof v === "boolean",
  notify: (v) => typeof v === "boolean",
  fontSize: (v) => Number.isInteger(v) && v >= 12 && v <= 18,
  answerStyle: (v) => ["auto", "short", "detailed"].includes(v),
  instructions: (v) => typeof v === "string" && v.length <= 2000,
  access: (v) => ["read", "ask", "auto"].includes(v),
  folders: (v) => Array.isArray(v) && v.length <= 8 && v.every((f) => typeof f === "string" && f.length <= 260 && /^[A-Za-z]:[\\/]/.test(f)),
  discordChats: (v) => Array.isArray(v) && v.length <= 24 && v.every(isDiscordChat),
  videoModel: (v) => typeof v === "string" && v.length <= 80 && /^[\w.\-]+(\/[\w.\-]+)?$/.test(v),
  videoDailyLimit: (v) => Number.isInteger(v) && v >= 0 && v <= 200,
};
export function loadSettings() {
  const saved = readJson(SETTINGS_FILE, {}) || {};
  if (OLD_THEMES[saved.theme]) saved.theme = OLD_THEMES[saved.theme];
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

/** Ask ChatGPT via the Codex CLI. Returns { text, images }. Every call is counted (see "ChatGPT usage" below). */
export async function askChatGPT(prompt, opts) {
  const t0 = Date.now();
  try {
    const r = await askChatGPTNow(prompt, opts);
    const u = r.usage || {};
    const limits = FAKE_HELPERS
      ? (process.env.BRAIN_FAKE_CODEX_HOME ? codexLimits("test-thread", process.env.BRAIN_FAKE_CODEX_HOME) : null)
      : codexLimits(r.threadId);
    recordChatGPT({ kind: "call", ok: true, ms: Date.now() - t0, in: u.in || 0, cached: u.cached || 0, out: u.out || 0, ...(limits ? { limits } : {}) });
    return { text: r.text, images: r.images };
  } catch (e) {
    if (!e?.stopped) recordChatGPT({ kind: "call", ok: false, ms: Date.now() - t0 });
    throw e;
  }
}
let codexSignedInAt = 0;
// AI Brain only asks ChatGPT questions, so its Codex runs leave out the plugins switched on in
// ~/.codex/config.toml (browser, computer use, documents...) and the "notify" program run after
// each turn. Starting those took about 4 of the ~11 seconds of even a one-word answer. Only for
// AI Brain's runs: the config file itself is not changed.
function codexLean(home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  const out = ["-c", "notify=[]"];
  let toml = "";
  try { toml = fs.readFileSync(path.join(home, "config.toml"), "utf8"); } catch { return out; }
  for (const m of toml.matchAll(/^\s*\[plugins\.("[^"\r\n]+"|[\w-]+)\]\s*$/gm)) out.push("-c", `plugins.${m[1]}.enabled=false`);
  return out;
}
async function askChatGPTNow(prompt, { newConversation = false, imagePaths = [], model, signal } = {}) {
  if (FAKE_HELPERS) return { ...(await fakeHelper("ChatGPT", prompt, signal)), usage: { in: 900, cached: 400, out: 60 } };
  const state = loadState();
  const outFile = path.join(os.tmpdir(), `ai-brain-codex-${process.pid}-${Date.now()}.txt`);
  const common = ["--json", "--skip-git-repo-check", "-c", 'sandbox_mode="read-only"', ...codexLean(), "-o", outFile];
  if (model) common.push("-m", model);
  for (const img of imagePaths) common.push("-i", img);

  // Fail fast (instead of ~70s of reconnect retries) when not signed in. Checked at most every
  // 10 minutes (each check starts Codex once more); a failed call clears it so the next one checks.
  if (Date.now() - codexSignedInAt > 10 * 60_000) {
    const st = await runNode(CODEX_JS, ["login", "status"], { timeoutMs: 30_000, signal });
    if (st.aborted) throw stopped();
    if (/not logged in/i.test(st.stdout + st.stderr)) {
      codexSignedInAt = 0;
      throw new Error('ChatGPT is not signed in. Sign in with "codex login" (or press Sign in in the AI Brain app).');
    }
    codexSignedInAt = Date.now();
  }

  const resume = !newConversation && state.chatgptThread;
  const args = resume
    ? ["exec", "resume", ...common, state.chatgptThread, "-"]
    : ["exec", ...common, "-"];

  const r = await runNode(CODEX_JS, args, { stdin: prompt, signal });
  if (r.aborted) { try { fs.unlinkSync(outFile); } catch {} throw stopped(); }

  let threadId = resume ? state.chatgptThread : undefined;
  let lastMsg = "", errors = [];
  const usage = { in: 0, cached: 0, out: 0 };
  for (const line of r.stdout.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const ev = JSON.parse(line);
      if (ev.thread_id) threadId = ev.thread_id;
      if (ev.type === "turn.completed" && ev.usage) { // cached tokens are part of the input tokens
        usage.in += Number(ev.usage.input_tokens) || 0;
        usage.cached += Number(ev.usage.cached_input_tokens) || 0;
        usage.out += Number(ev.usage.output_tokens) || 0;
      }
      if (ev.type === "item.completed" && ev.item?.type === "agent_message") lastMsg = ev.item.text ?? lastMsg;
      if (ev.type === "error" || ev.type === "turn.failed") errors.push(ev.message || ev.error?.message || line);
    } catch { /* ignore non-JSON */ }
  }
  try { lastMsg = fs.readFileSync(outFile, "utf8").trim() || lastMsg; fs.unlinkSync(outFile); } catch {}

  if (!lastMsg) {
    codexSignedInAt = 0; // check the sign-in again next time
    let why = errors.join("\n") || r.stderr.trim().split(/\r?\n/).slice(-8).join("\n") || `exit code ${r.code}`;
    if (/log ?in|auth|401|unauthori/i.test(why)) why = `Not signed in to ChatGPT. Run "codex login" (or press Sign in in the app).\n${why}`;
    throw new Error(`ChatGPT (Codex CLI) gave no reply.\n${why}`);
  }
  if (threadId) updateState({ chatgptThread: threadId });
  log("ChatGPT", prompt, lastMsg);
  return { text: lastMsg, images: [], usage, threadId };
}

// ---------- ChatGPT usage (counted on this PC; the app server and the MCP server both write here) ----------
const CHATGPT_USAGE_FILE = path.join(DATA, "usage-chatgpt.jsonl");
function recordChatGPT(entry) {
  try { fs.appendFileSync(CHATGPT_USAGE_FILE, JSON.stringify({ t: Date.now(), ...entry }) + "\n"); } catch { /* best-effort */ }
}
/** Every recorded ChatGPT call, oldest first: [{ t, kind, ok, ms, in, cached, out, limits }]. */
export function readChatGPTUsage() { return readUsageFile(CHATGPT_USAGE_FILE); }

/**
 * ChatGPT's plan limits as Codex itself last wrote them for one conversation of ours.
 * Codex keeps a record of each conversation in its own folder; only the "rate_limits" numbers
 * of the conversation this app started are read - nothing else, and never the sign-in file.
 * Returns { short: { pct, mins, resets }, long: { pct, mins, resets } } or null when unknown.
 */
export function codexLimits(threadId, home = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")) {
  try {
    if (!/^[\w-]{6,80}$/.test(String(threadId || ""))) return null;
    const file = codexRollout(threadId, path.join(home, "sessions"));
    if (!file) return null;
    const size = fs.statSync(file).size, len = Math.min(size, 400_000);
    const buf = Buffer.alloc(len), fd = fs.openSync(file, "r");
    try { fs.readSync(fd, buf, 0, len, size - len); } finally { fs.closeSync(fd); }
    const lines = buf.toString("utf8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"rate_limits"')) continue;
      let rl = null;
      try { rl = findKey(JSON.parse(lines[i]), "rate_limits", 0); } catch { continue; } // a cut-off first line
      const win = (w) => (w && Number.isFinite(Number(w.used_percent))
        ? { pct: Math.max(0, Math.min(100, Number(w.used_percent))), mins: Number(w.window_minutes) || 0, resets: Number(w.resets_at) || 0 }
        : null);
      const all = [win(rl?.primary), win(rl?.secondary)].filter(Boolean).sort((a, b) => a.mins - b.mins);
      if (!all.length) continue;
      const out = {};
      for (const w of all) { if (w.mins > 24 * 60) out.long ??= w; else out.short ??= w; }
      return out;
    }
  } catch { /* an unknown format just means no limits are shown */ }
  return null;
}
function findKey(o, key, depth) {
  if (!o || typeof o !== "object" || depth > 5) return null;
  if (o[key] && typeof o[key] === "object") return o[key];
  for (const v of Object.values(o)) { const hit = findKey(v, key, depth + 1); if (hit) return hit; }
  return null;
}
// Finds sessions/YYYY/MM/DD/rollout-<time>-<threadId>.jsonl (newest folders first; remembered once found).
let rolloutSeen = { id: "", file: "" };
function codexRollout(threadId, root) {
  if (rolloutSeen.id === threadId && fs.existsSync(rolloutSeen.file)) return rolloutSeen.file;
  const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse(); } catch { return []; } };
  let looked = 0;
  for (const y of dirs(root)) for (const m of dirs(path.join(root, y))) for (const d of dirs(path.join(root, y, m))) {
    if (++looked > 800) return null;
    const dir = path.join(root, y, m, d);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    const hit = names.find((n) => n.startsWith("rollout-") && n.endsWith(`-${threadId}.jsonl`));
    if (hit) { rolloutSeen = { id: threadId, file: path.join(dir, hit) }; return rolloutSeen.file; }
  }
  return null;
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
export function readGeminiUsage() { return readUsageFile(GEMINI_USAGE_FILE); }
function readUsageFile(file) {
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try { const j = JSON.parse(line); if (j && typeof j.t === "number") out.push(j); } catch { /* skip a broken line */ }
  }
  if (out.length > 20_000) { // keep the file small
    const keep = out.slice(-10_000);
    try { fs.writeFileSync(file, keep.map((j) => JSON.stringify(j)).join("\n") + "\n"); } catch { /* ignore */ }
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

// ---------- video (Google Veo and other Google video models) ----------
// Video needs a Google API key (the Antigravity sign-in has no video model). The key lives in its own
// file next to settings.json: it is never sent to the window, never goes into git, and the brain is
// never allowed to touch it. GEMINI_API_KEY or GOOGLE_API_KEY in the environment work too.
// The key is kept under AppData, which can never be one of the folders the brain may work in.
// (With a data folder of its own - the tests, or BRAIN_DATA_DIR - it stays in that folder.)
const GOOGLE_KEY_FILE = path.resolve(DATA).toLowerCase() === path.resolve(HERE).toLowerCase() && process.env.APPDATA
  ? path.join(process.env.APPDATA, "ai-brain", "google-key.json")
  : path.join(DATA, "google-key.json");
const VIDEO_USAGE_FILE = path.join(DATA, "usage-video.jsonl");
const VIDEO_TIMEOUT_MS = Number(process.env.BRAIN_VIDEO_TIMEOUT_MS || 12 * 60_000);
const KEY_RE = /^[A-Za-z0-9_\-]{20,200}$/;
export const NO_VIDEO_KEY = "Video is not connected yet. Add your Google API key in Settings, under Video.";
export const VIDEO_MODELS = [
  { id: "veo-3.1-generate-preview", label: "Veo 3.1 (best quality)" },
  { id: "veo-3.1-fast-generate-preview", label: "Veo 3.1 Fast (cheaper)" },
  { id: "models/gemini-omni-1.2-flash", label: "Gemini Omni 1.2 Flash" },
];
export const isVeo = (model) => /(^|\/)veo/i.test(String(model || ""));
function googleKey() {
  const saved = readJson(GOOGLE_KEY_FILE, null)?.key;
  if (typeof saved === "string" && KEY_RE.test(saved)) return { key: saved, from: "saved" };
  const env = FAKE_HELPERS ? "" : process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  return KEY_RE.test(env) ? { key: env, from: "env" } : null;
}
/** Is a Google key there? Never returns the key itself, only its last four characters. */
export function googleKeyState() {
  const k = googleKey();
  return k ? { connected: true, from: k.from, ends: k.key.slice(-4) } : { connected: false };
}
const googleSays = (e) => {
  const m = String(e?.message || e || "");
  try { const j = JSON.parse(m.slice(m.indexOf("{"))); return String(j.error?.message || j.message || m); } catch { return m; }
};
async function google(key) {
  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI({ apiKey: key });
}
/** Save the key after Google accepted it. Throws a plain-language error when it is wrong. */
export async function saveGoogleKey(key) {
  key = String(key || "").trim();
  if (!KEY_RE.test(key)) throw new Error("That does not look like a Google API key. Copy the whole key and try again.");
  if (FAKE_HELPERS) { if (/bad/i.test(key)) throw new Error("Google did not accept that key."); }
  else {
    try { await (await google(key)).models.list({ config: { pageSize: 1 } }); }
    catch (e) {
      const said = googleSays(e);
      if (/api key|API_KEY|permission|unauthenticated|\b401\b|\b403\b/i.test(said)) throw new Error(`Google did not accept that key. It said: ${said.slice(0, 300)}`);
      throw new Error(`Could not reach Google to check the key. Are you online? (${said.slice(0, 200)})`);
    }
  }
  fs.mkdirSync(path.dirname(GOOGLE_KEY_FILE), { recursive: true });
  writeJson(GOOGLE_KEY_FILE, { key });
  if (readJson(GOOGLE_KEY_FILE, null)?.key !== key) throw new Error("The key could not be saved on this computer.");
  return googleKeyState();
}
export function removeGoogleKey() {
  try { fs.unlinkSync(GOOGLE_KEY_FILE); } catch { /* was not there */ }
  return googleKeyState();
}
/** The video models to pick from: the built-in ones, plus what Google lists for this key. */
export async function listVideoModels() {
  const out = VIDEO_MODELS.map((m) => ({ ...m }));
  const k = googleKey();
  if (!k || FAKE_HELPERS) return out;
  try {
    const pager = await (await google(k.key)).models.list({ config: { pageSize: 200 } });
    let n = 0;
    for await (const m of pager) {
      if (++n > 600) break;
      const id = String(m.name || "").replace(/^models\//, "");
      const video = /veo/i.test(id) || (m.supportedActions || []).some((a) => /generateVideos|predictLongRunning/i.test(a));
      if (!id || !video || out.some((o) => o.id.replace(/^models\//, "") === id)) continue;
      out.push({ id, label: m.displayName || id });
    }
  } catch { /* the built-in list is enough */ }
  return out.slice(0, 40);
}
export function readVideoUsage() {
  let lines = [];
  try { lines = fs.readFileSync(VIDEO_USAGE_FILE, "utf8").split("\n").filter(Boolean); } catch { /* none yet */ }
  const day = new Date().toDateString();
  const out = { all: 0, today: 0, seconds: 0 };
  for (const l of lines) {
    try {
      const v = JSON.parse(l);
      out.all++; out.seconds += Number(v.seconds) || 0;
      if (new Date(v.t).toDateString() === day) out.today++;
    } catch { /* skip a broken line */ }
  }
  return out;
}
export const recordVideo = (entry) => { try { fs.appendFileSync(VIDEO_USAGE_FILE, JSON.stringify({ t: Date.now(), ...entry }) + "\n"); } catch { /* best-effort */ } };
const pause = (ms, signal) => new Promise((ok) => {
  const t = setTimeout(ok, ms);
  signal?.addEventListener("abort", () => { clearTimeout(t); ok(); }, { once: true });
});
const PICTURE_MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/**
 * Make a short video. Returns { text, images: [path of the mp4], model, seconds }.
 * Veo models go through generateVideos (a job that is polled until it is done); any other model id
 * goes through the Interactions API with a video answer.
 * opts: model, aspect ("16:9" | "9:16"), seconds, resolution ("720p" | "1080p"), imagePath (first frame), signal.
 */
export async function generateVideo(description, { model, aspect = "16:9", seconds, resolution = "720p", imagePath, signal } = {}) {
  const prompt = String(description || "").trim();
  if (!prompt) throw new Error("Describe the video first.");
  const k = googleKey();
  if (!k) throw new Error(NO_VIDEO_KEY);
  const s = loadSettings();
  const id = model && RULES.videoModel(model) ? model : s.videoModel;
  const veo = isVeo(id);
  aspect = aspect === "9:16" ? "9:16" : "16:9";
  seconds = Number.isInteger(seconds) ? Math.min(veo ? 8 : 10, Math.max(4, seconds)) : veo ? 8 : 10;
  resolution = resolution === "1080p" ? "1080p" : "720p";
  if (veo && resolution === "1080p") seconds = 8; // Veo makes 1080p only at full length
  if (s.videoDailyLimit && readVideoUsage().today >= s.videoDailyLimit)
    throw new Error(`Today's video limit (${s.videoDailyLimit}) is reached. You can raise it in Settings, under Video.`);
  if (imagePath && !PICTURE_MIME[path.extname(imagePath).toLowerCase()]) throw new Error("The starting picture must be a PNG, JPG or WebP file.");
  const dest = path.join(MEDIA, `${Date.now().toString(36)}-video.mp4`);
  let plain = false; // the model refused the length and quality options: it chose them itself
  const done = (said) => {
    recordVideo({ model: id, seconds, ok: true });
    const text = `${said ? `${said}\n\n` : ""}Video saved (${plain ? "" : `${seconds} seconds, `}${aspect}):\n${dest}`;
    log("Video", prompt, text);
    return { text, images: [dest], model: id, seconds };
  };

  if (FAKE_HELPERS) {
    await pause(/\[slow\]/i.test(prompt) ? 60_000 : Number(process.env.BRAIN_FAKE_DELAY_MS || 500), signal);
    if (signal?.aborted) throw stopped();
    if (/\[fail\]/i.test(prompt)) throw new Error("Google could not make the video: test failure.");
    fs.copyFileSync(process.env.BRAIN_FAKE_VIDEO, dest);
    return done(`**Video (test)** ${id}, ${resolution}${imagePath ? ", from a picture" : ""}: ${prompt.slice(0, 120)}`);
  }

  const ai = await google(k.key);
  let started = false; // once Google accepted the job it is billed, even if we stop waiting
  try {
    if (!veo) {
      // The Interactions API: one call, the video comes back inside the answer.
      const interaction = await ai.interactions.create({
        model: id, input: prompt,
        generation_config: { max_output_tokens: 65536 },
        response_modalities: ["video"],
        response_format: { type: "video", duration: `${seconds}s`, aspect_ratio: aspect },
      }, { signal, timeout: VIDEO_TIMEOUT_MS });
      started = true;
      const said = [];
      let saved = false;
      for (const step of interaction.steps || []) {
        if (step.type !== "model_output") continue;
        for (const part of step.content || []) {
          if (part.type === "text" && part.text) said.push(part.text);
          if (part.type !== "video" || saved) continue;
          if (part.data) { fs.writeFileSync(dest, Buffer.from(part.data, "base64")); saved = true; }
          else if (part.uri) {
            const r = await fetch(part.uri, { headers: { "x-goog-api-key": k.key }, signal });
            if (!r.ok) throw new Error(`Google made the video but it could not be downloaded (${r.status}).`);
            fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer())); saved = true;
          }
        }
      }
      if (!saved) { started = false; throw new Error(`Google answered, but no video came back.${said.length ? ` It said:\n${said.join("\n").slice(0, 600)}` : " Try a different description."}`); }
      return done(said.join("\n").trim().slice(0, 2000));
    }

    // Veo: start a job, then ask every few seconds until it is done.
    const image = imagePath ? { imageBytes: fs.readFileSync(imagePath).toString("base64"), mimeType: PICTURE_MIME[path.extname(imagePath).toLowerCase()] } : undefined;
    const full = { numberOfVideos: 1, aspectRatio: aspect, durationSeconds: seconds, resolution, abortSignal: signal };
    let op;
    try { op = await ai.models.generateVideos({ model: id, prompt, image, config: full }); }
    catch (e) {
      // Some models refuse one of the extra options: try once more with only the shape.
      if (signal?.aborted || !/INVALID_ARGUMENT|\b400\b|not supported|unsupported/i.test(googleSays(e))) throw e;
      op = await ai.models.generateVideos({ model: id, prompt, image, config: { aspectRatio: aspect, abortSignal: signal } });
      plain = true;
    }
    started = true;
    const until = Date.now() + VIDEO_TIMEOUT_MS;
    while (!op.done) {
      if (signal?.aborted) throw stopped();
      if (Date.now() > until) throw new Error("Google is taking too long to make this video. Try again in a few minutes.");
      await pause(8000, signal);
      if (signal?.aborted) throw stopped();
      op = await ai.operations.getVideosOperation({ operation: op });
    }
    if (op.error) { started = false; throw new Error(`Google could not make the video: ${String(op.error.message || JSON.stringify(op.error)).slice(0, 500)}`); }
    const made = op.response?.generatedVideos?.[0]?.video;
    if (!made) {
      const why = op.response?.raiMediaFilteredReasons || [];
      started = false; // nothing was made
      throw new Error(why.length ? `Google blocked this video: ${why.join("; ").slice(0, 500)}` : "Google finished, but sent no video. Try a different description.");
    }
    if (made.videoBytes) fs.writeFileSync(dest, Buffer.from(made.videoBytes, "base64"));
    else await ai.files.download({ file: made, downloadPath: dest });
    // The download can return a moment before the file is complete: wait until its size stops changing.
    for (let i = 0, last = -1; i < 40; i++) {
      const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      if (size > 0 && size === last) break;
      last = size;
      await pause(500);
    }
    if (!fs.existsSync(dest) || !fs.statSync(dest).size) throw new Error("Google made the video, but saving it failed. Try again.");
    return done("");
  } catch (e) {
    if (signal?.aborted || e?.stopped) { if (started) recordVideo({ model: id, seconds, ok: false, stopped: true }); throw stopped(); }
    const said = googleSays(e);
    if (/RESOURCE_EXHAUSTED|\b429\b|quota/i.test(said)) throw new Error(`Google's video limit for this key is used up for now, or the key has no paid plan (video needs one). Google said:\n${said.slice(0, 400)}`);
    if (/NOT_FOUND|\b404\b|is not found|not supported for/i.test(said)) throw new Error(`Google does not offer the model "${id}" for this key. Pick another video model in Settings. Google said:\n${said.slice(0, 300)}`);
    if (/API key not valid|API_KEY_INVALID|UNAUTHENTICATED|PERMISSION_DENIED/i.test(said)) throw new Error(`Google did not accept the key. Check it in Settings, under Video. Google said:\n${said.slice(0, 300)}`);
    throw new Error(said.startsWith("Google") ? said : `Google could not make the video: ${said.slice(0, 600)}`);
  }
}

export function resetConversations() {
  updateState({ chatgptThread: null, geminiConversation: null, claudeSession: null });
}
