// Music control for the app: talks to media-helper.ps1 (Windows media controls), which works with
// Spotify and anything else that shows up in the Windows media overlay. No account or key is needed.
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "media-helper.ps1");
const FAKE = process.env.BRAIN_FAKE_HELPERS === "1";
const NO_OPEN = process.env.BRAIN_NO_OPEN === "1";
export const MUSIC_COMMANDS = ["toggle", "play", "pause", "next", "prev", "shuffle", "repeat", "seek"];
const REPLY_TIMEOUT_MS = 8000;
const IDLE_MS = 5 * 60_000;

let proc = null, waiting = [], idleTimer = null;
let cached = null, cachedAt = 0, pendingStatus = null;
let art = { key: "", buf: null, mime: "" };

function stopHelper() {
  const p = proc;
  proc = null;
  if (p) { try { p.stdin.end("quit\n"); } catch {} setTimeout(() => { try { p.kill(); } catch {} }, 500).unref?.(); }
  for (const w of waiting.splice(0)) { clearTimeout(w.timer); w.done({ ok: false, error: "The music helper stopped." }); }
}
function startHelper() {
  if (proc) return;
  const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT], {
    windowsHide: true, stdio: ["pipe", "pipe", "ignore"],
  });
  proc = p;
  readline.createInterface({ input: p.stdout }).on("line", (line) => {
    const w = waiting.shift();
    if (!w) return;
    clearTimeout(w.timer);
    const start = line.indexOf("{");
    try { w.done(JSON.parse(line.slice(start))); }
    catch { w.done({ ok: false, error: "The music helper sent something unreadable." }); }
  });
  const dead = () => { if (proc === p) { proc = null; stopHelper(); } };
  p.on("exit", dead);
  p.on("error", dead);
  p.stdin.on("error", () => {});
}
function ask(line) {
  return new Promise((done) => {
    try { startHelper(); } catch { return done({ ok: false, error: "The music helper could not start." }); }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(stopHelper, IDLE_MS);
    idleTimer.unref?.();
    // A reply that never comes would shift every later answer by one, so restart the helper instead.
    const timer = setTimeout(() => { stopHelper(); done({ ok: false, error: "The music helper did not answer." }); }, REPLY_TIMEOUT_MS);
    waiting.push({ done, timer });
    try { proc.stdin.write(line + "\n"); } catch { /* the exit handler answers */ }
  });
}

// ----- test double -----
const FAKE_TRACKS = [
  { title: "Test Song One", artist: "The Fixtures", album: "Unit Tests", duration: 200 },
  { title: "Second Track", artist: "Mock & The Stubs", album: "Unit Tests", duration: 180 },
  { title: "Third Time", artist: "The Fixtures", album: "Regression", duration: 240 },
];
const fake = { i: 0, playing: false, position: 30, shuffle: false, repeat: "None", active: process.env.BRAIN_FAKE_MUSIC !== "off" };
function fakeStatus() {
  if (!fake.active) return { ok: true, active: false };
  const t = FAKE_TRACKS[fake.i];
  return {
    ok: true, active: true, app: "Spotify", ...t, playing: fake.playing, position: fake.position, shuffle: fake.shuffle, repeat: fake.repeat,
    can: { toggle: true, next: true, prev: true, shuffle: true, repeat: true, seek: true }, hasArt: false,
  };
}
function fakeCommand(cmd, arg) {
  if (!fake.active) return { ok: false, error: "Nothing is playing. Open Spotify and start a song first." };
  if (cmd === "toggle") fake.playing = !fake.playing;
  else if (cmd === "play") fake.playing = true;
  else if (cmd === "pause") fake.playing = false;
  else if (cmd === "next") { fake.i = (fake.i + 1) % FAKE_TRACKS.length; fake.position = 0; }
  else if (cmd === "prev") { fake.i = (fake.i + FAKE_TRACKS.length - 1) % FAKE_TRACKS.length; fake.position = 0; }
  else if (cmd === "shuffle") fake.shuffle = !fake.shuffle;
  else if (cmd === "repeat") fake.repeat = { None: "List", List: "Track", Track: "None" }[fake.repeat];
  else if (cmd === "seek") fake.position = Math.max(0, Math.min(FAKE_TRACKS[fake.i].duration, Number(arg) || 0));
  return fakeStatus();
}

const keyOf = (s) => (s?.active ? `${s.title}|${s.artist}|${s.album}` : "");
function remember(s) {
  if (s?.ok) { cached = { ...s, artKey: s.hasArt ? keyOf(s) : "" }; cachedAt = Date.now(); return cached; }
  return s;
}

/** What is playing now. Answers from a short cache so several windows do not each wake the helper. */
export async function musicStatus() {
  if (FAKE) return remember(fakeStatus());
  if (cached && Date.now() - cachedAt < 900) return cached;
  if (!pendingStatus) pendingStatus = ask("status").then(remember).finally(() => { pendingStatus = null; });
  return pendingStatus;
}

/** Press a control. Returns the new status, or { ok: false, error }. */
export async function musicCommand(cmd, arg) {
  if (!MUSIC_COMMANDS.includes(cmd)) return { ok: false, error: "Unknown music command." };
  let line = cmd;
  if (cmd === "seek") {
    const sec = Number(arg);
    if (!Number.isFinite(sec) || sec < 0 || sec > 86_400) return { ok: false, error: "That position is not valid." };
    line = `seek ${Math.round(sec)}`;
  }
  if (FAKE) return remember(fakeCommand(cmd, arg));
  return remember(await ask(line));
}

/** The cover picture of the current song: { buf, mime } or null. */
export async function musicArt() {
  if (FAKE) return null;
  const s = await musicStatus();
  const key = s?.hasArt ? keyOf(s) : "";
  if (!key) return null;
  if (art.key === key && art.buf) return art;
  const r = await ask("art");
  if (!r?.ok || !r.art) return null;
  art = { key, buf: Buffer.from(r.art, "base64"), mime: /^image\/[\w.+-]+$/.test(r.mime || "") ? r.mime : "image/jpeg" };
  return art;
}

/** Open Spotify or Discord (the installed desktop apps). q = an optional Spotify search. */
export function openApp(app, q) {
  let uri;
  if (app === "spotify") uri = q ? `spotify:search:${encodeURIComponent(String(q).slice(0, 120))}` : "spotify:";
  else if (app === "discord") uri = "discord://-/channels/@me";
  else throw new Error("Unknown app.");
  if (NO_OPEN) return uri;
  // explorer.exe hands the link to the app that registered it; no shell is involved.
  spawn("explorer.exe", [uri], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return uri;
}

export function stopMusic() { clearTimeout(idleTimer); stopHelper(); }
