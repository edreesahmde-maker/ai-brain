// AI Brain - the desktop window (Electron). It makes sure the local app server is running,
// opens the workstation in a frameless window that can go full screen, and can lay the
// installed Discord app out beside it. Discord stays its own program: this only moves its
// window (see discord-window.ps1) and never reads anything inside it.
// Start: node_modules\electron\dist\electron.exe shell\main.cjs
"use strict";
const { app, BrowserWindow, ipcMain, shell, session, Menu, nativeImage, dialog, screen } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { spawn, execFile, execFileSync } = require("node:child_process");
const { serverState, stopOld, commandLine } = require("./server-check.cjs");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.BRAIN_PORT) || 4777;
const BASE = `http://127.0.0.1:${PORT}`;
const ICON = path.join(__dirname, "icon.png");
const CONTROLS_W = 138; // the three window buttons on Windows
const WINDOW_HELPER = path.join(__dirname, "discord-window.ps1");
const DISCORD_UPDATER = path.join(process.env.LOCALAPPDATA || "", "Discord", "Update.exe");
const BRAIN_MIN_W = 760;

app.setName("AI Brain");
app.setPath("userData", process.env.BRAIN_SHELL_DATA || path.join(app.getPath("appData"), "AI Brain"));
if (process.platform === "win32") app.setAppUserModelId("AIBrain.Workstation");
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

let win = null;
let version = "";

// ---------- the local server ----------
async function ping() {
  try {
    const r = await fetch(`${BASE}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    if (j.app === "ai-brain") { version = j.version || ""; return true; }
  } catch { /* not running */ }
  return false;
}
function findNode() {
  if (process.env.BRAIN_NODE && fs.existsSync(process.env.BRAIN_NODE)) return process.env.BRAIN_NODE;
  try {
    const out = execFileSync("where.exe", ["node"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const first = out.split(/\r?\n/).map((s) => s.trim()).find((s) => s && fs.existsSync(s));
    if (first) return first;
  } catch { /* not on PATH */ }
  for (const p of [path.join(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe")]) if (fs.existsSync(p)) return p;
  return "";
}
async function ensureServer() {
  const st = await serverState(BASE, ROOT);
  if (st.state === "fresh") { version = st.info.version || ""; return true; }
  if (st.state === "old") {
    // An older AI Brain server is still running in the background (closing the window does not stop it).
    // Using it with the newer page makes new settings fail, so replace it.
    const r = await stopOld(BASE, PORT, ROOT);
    console.log(`SERVER REPLACED ${JSON.stringify({ was: st.info.version || "", build: st.info.build || "", ...r })}`);
    if (!r.ok) {
      dialog.showErrorBox("AI Brain", `An older AI Brain server (version ${st.info.version || "?"}) is still running and could not be stopped.

Restart your computer, then open AI Brain again.`);
      version = st.info.version || "";
      return true;
    }
  }
  const node = findNode();
  if (!node) {
    dialog.showErrorBox("AI Brain", "Node.js was not found, so the AI Brain server cannot start.\n\nInstall Node.js from nodejs.org, then open AI Brain again.");
    return false;
  }
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  spawn(node, [path.join(ROOT, "app", "app-server.mjs")], { cwd: ROOT, env, detached: true, stdio: "ignore", windowsHide: true }).unref();
  for (let i = 0; i < 80; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await ping()) return true;
  }
  dialog.showErrorBox("AI Brain", `The AI Brain server did not start.\n\nLook at ${path.join(ROOT, "app.log")} for the reason.`);
  return false;
}

// ---------- window position ----------
const STATE_FILE = () => path.join(app.getPath("userData"), "window.json");
function loadBounds() {
  try {
    const s = JSON.parse(fs.readFileSync(STATE_FILE(), "utf8"));
    const b = s.bounds;
    const visible = b && screen.getAllDisplays().some((d) => {
      const a = d.workArea;
      return b.x + 100 < a.x + a.width && b.x + b.width - 100 > a.x && b.y >= a.y - 20 && b.y + 40 < a.y + a.height;
    });
    return { bounds: visible ? b : null, maximized: !!s.maximized, fullscreen: !!s.fullscreen };
  } catch { return { bounds: null, maximized: true, fullscreen: false }; }
}
let saveTimer = null;
function saveBounds() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    // While Discord is beside AI Brain the narrow size is temporary; keep the size from before.
    if (!win || win.isDestroyed() || besideSaved) return;
    const s = { bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
    try { fs.writeFileSync(STATE_FILE(), JSON.stringify(s)); } catch { /* not important */ }
  }, 400);
}

// ---------- safety ----------
const isApp = (url) => { try { return new URL(url).origin === BASE; } catch { return false; } };
const isWeb = (url) => /^https?:\/\//i.test(url);
function openOutside(url) { if (isWeb(url)) shell.openExternal(url).catch(() => {}); }

function editMenu(wc, params) {
  const items = [];
  if (params.isEditable) {
    items.push({ role: "undo", label: "Undo" }, { role: "redo", label: "Redo" }, { type: "separator" },
      { role: "cut", label: "Cut", enabled: params.editFlags.canCut }, { role: "copy", label: "Copy", enabled: params.editFlags.canCopy },
      { role: "paste", label: "Paste", enabled: params.editFlags.canPaste }, { type: "separator" }, { role: "selectAll", label: "Select all" });
  } else if (params.selectionText) {
    items.push({ role: "copy", label: "Copy" });
  }
  if (params.linkURL && isWeb(params.linkURL)) {
    if (items.length) items.push({ type: "separator" });
    items.push({ label: "Open link in browser", click: () => openOutside(params.linkURL) });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(wc) || win });
}

app.on("web-contents-created", (_e, wc) => {
  wc.on("context-menu", (_ev, params) => editMenu(wc, params));
  wc.setWindowOpenHandler(({ url }) => { openOutside(url); return { action: "deny" }; });
  wc.on("will-navigate", (ev, url) => { if (!isApp(url)) { ev.preventDefault(); openOutside(url); } });
  // Nothing may be embedded in the window.
  wc.on("will-attach-webview", (ev) => ev.preventDefault());
});

function setupSessions() {
  const appAllowed = new Set(["clipboard-sanitized-write", "clipboard-read", "notifications", "fullscreen"]);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb, details) => cb(appAllowed.has(perm) && isApp(details.requestingUrl || wc.getURL())));
  session.defaultSession.setPermissionCheckHandler((_wc, perm, origin) => appAllowed.has(perm) && isApp(origin || ""));
}

// ---------- the window ----------
async function createWindow() {
  const st = loadBounds();
  const icon = fs.existsSync(ICON) ? nativeImage.createFromPath(ICON) : undefined;
  win = new BrowserWindow({
    ...(st.bounds || { width: 1600, height: 940 }),
    minWidth: 760, minHeight: 520,
    show: false, backgroundColor: "#0e0f12", icon, title: "AI Brain",
    titleBarStyle: "hidden",
    titleBarOverlay: { color: "#151619", symbolColor: "#9a9fa9", height: 38 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false, spellcheck: true,
    },
  });
  if (!st.bounds) win.center();
  win.once("ready-to-show", () => {
    if (st.maximized) win.maximize();
    win.show();
    if (st.fullscreen) win.setFullScreen(true);
  });
  for (const ev of ["resize", "move", "maximize", "unmaximize"]) win.on(ev, saveBounds);
  const fsChanged = (on) => { saveBounds(); if (!win.isDestroyed()) win.webContents.send("station:fullscreen", on); };
  win.on("enter-full-screen", () => fsChanged(true));
  win.on("leave-full-screen", () => fsChanged(false));
  win.on("closed", () => { win = null; });
  // Closing while Discord is beside AI Brain or a program is docked: put the windows back
  // first, then close.
  let closingBack = false;
  win.on("close", (e) => {
    if ((!besideSaved && !docked) || closingBack) return;
    e.preventDefault();
    closingBack = true;
    const w = win;
    Promise.race([Promise.all([putDiscordBack(), releaseDocked()]), sleep(8000)]).catch(() => {})
      .finally(() => { if (dockProc) try { dockProc.stdin.end(); } catch { /* gone */ } if (!w.isDestroyed()) w.close(); });
  });
  win.on("closed", () => { if (dockProc) try { dockProc.stdin.end(); } catch { /* gone */ } });
  win.webContents.on("before-input-event", (ev, input) => {
    if (input.type === "keyDown" && input.key === "F11") { ev.preventDefault(); win.setFullScreen(!win.isFullScreen()); }
  });
  await win.loadURL(BASE);
}

ipcMain.on("station:state", (e) => {
  e.returnValue = { version, fullscreen: !!win?.isFullScreen(), controlsWidth: CONTROLS_W };
});
ipcMain.on("station:toggle-fullscreen", (e) => {
  if (win && e.sender === win.webContents) win.setFullScreen(!win.isFullScreen());
});
ipcMain.on("station:colors", (e, c) => {
  if (!win || e.sender !== win.webContents || process.platform !== "win32") return;
  const hex = /^#[0-9a-f]{6}$/i;
  try {
    win.setTitleBarOverlay({
      color: hex.test(c.color) ? c.color : "#151619",
      symbolColor: hex.test(c.symbol) ? c.symbol : "#9a9fa9",
      height: Math.max(28, Math.min(64, Math.round(c.height) || 38)),
    });
  } catch { /* older Windows */ }
});

app.on("second-instance", () => {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
app.on("window-all-closed", () => app.quit());

// ---------- Discord beside AI Brain ----------
// The Discord app keeps its own window. "Beside" only moves it to one side of the screen and
// AI Brain to the other; "back" puts both where they were. It never reparents Discord's window,
// never makes it topmost and never reads anything inside it.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function windowHelper(args) {
  return new Promise((resolve) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", WINDOW_HELPER, ...args.map(String)],
      { windowsHide: true, timeout: 20000 }, (err, out) => {
        const last = String(out || "").trim().split(/\r?\n/).pop();
        try { resolve(JSON.parse(last)); } catch { resolve({ ok: false, why: err ? err.message : "the window helper did not answer" }); }
      });
  });
}
let besideSaved = null; // { discord: {x,y,w,h,state}, brain: {bounds, maximized, fullscreen} } while side by side
let besideBusy = false;
const toScreen = (r) => screen.dipToScreenRect(win, r);
const toDip = (r) => screen.screenToDipRect(win, r);

// The main window, not the small "checking for updates" box Discord shows while it starts:
// a normal window must be big, and when Discord was just started the same window must still
// be there a moment later.
const bigEnough = (i) => i.ok && (i.state !== "normal" || toDip({ x: i.x, y: i.y, width: i.w, height: i.h }).width >= 500);
async function discordWindowReady() {
  let info = await windowHelper(["info"]);
  if (bigEnough(info)) return info;
  // Not running, or hidden in the tray: Discord's own updater starts it or shows its window.
  if (!fs.existsSync(DISCORD_UPDATER)) return { ok: false, why: "not-installed" };
  spawn(DISCORD_UPDATER, ["--processStart", "Discord.exe"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  let last = null;
  for (let i = 0; i < 40; i++) {
    await sleep(1000);
    info = await windowHelper(["info"]);
    if (bigEnough(info) && last && last.hwnd === info.hwnd) return info;
    last = bigEnough(info) ? info : null;
  }
  return info.ok ? { ok: false, why: "no-window" } : info;
}

async function putDiscordBeside() {
  if (!win || win.isDestroyed()) return { ok: false, why: "no-window" };
  const ready = await discordWindowReady();
  if (!ready.ok) return { ok: false, why: ready.why };
  const area = screen.getDisplayMatching(win.getBounds()).workArea; // in app pixels
  // Discord will not get narrower than about 940 px; AI Brain needs at least BRAIN_MIN_W.
  const want = Math.min(1000, area.width - BRAIN_MIN_W);
  if (want < 900) return { ok: false, why: "screen-too-small" };
  const brainBefore = { bounds: win.getNormalBounds(), maximized: win.isMaximized(), fullscreen: win.isFullScreen() };
  const target = (w) => toScreen({ x: area.x + area.width - w, y: area.y, width: w, height: area.height });
  let t = target(want);
  let r = await windowHelper(["place", t.x, t.y, t.width, t.height]);
  if (!r.ok) return { ok: false, why: r.why };
  const discordBefore = r.before;
  // If Discord kept itself wider than asked, slide it so it still ends at the screen edge.
  let got = toDip({ x: r.now.x, y: r.now.y, width: r.now.w, height: r.now.h }).width;
  if (got > want + 2) {
    if (area.width - got < BRAIN_MIN_W) {
      await windowHelper(["restore", discordBefore.x, discordBefore.y, discordBefore.w, discordBefore.h, discordBefore.state]);
      return { ok: false, why: "screen-too-small" };
    }
    t = target(got);
    r = await windowHelper(["place", t.x, t.y, t.width, t.height]);
    if (r.ok) got = toDip({ x: r.now.x, y: r.now.y, width: r.now.w, height: r.now.h }).width;
  }
  if (!besideSaved) besideSaved = { discord: discordBefore, brain: brainBefore };
  if (win.isFullScreen()) { win.setFullScreen(false); await sleep(700); }
  if (win.isMaximized()) { win.unmaximize(); await sleep(200); }
  win.setBounds({ x: area.x, y: area.y, width: area.width - got, height: area.height });
  return { ok: true, beside: true };
}

async function putDiscordBack() {
  if (!besideSaved) return { ok: true, beside: false };
  const { discord: d, brain: b } = besideSaved;
  besideSaved = null;
  const r = await windowHelper(["restore", d.x, d.y, d.w, d.h, d.state]);
  if (win && !win.isDestroyed()) {
    win.setBounds(b.bounds);
    if (b.maximized) win.maximize();
    if (b.fullscreen) win.setFullScreen(true);
  }
  return { ok: !!r.ok || r.why === "not-running" || r.why === "no-window", beside: false, why: r.ok ? undefined : r.why };
}

// A pinned chat's link, rebuilt from its two numbers only.
const DISCORD_ID = /^\d{15,22}$/;
function discordChatLink(c) {
  const place = String(c?.place ?? ""), chat = String(c?.chat ?? "");
  if (!(place === "@me" || DISCORD_ID.test(place)) || !DISCORD_ID.test(chat)) return null;
  return `discord://-/channels/${place}/${chat}`;
}

// Opens Discord at one chat and keeps it next to AI Brain, at Discord's smallest width.
async function openDiscordChat(c) {
  const link = discordChatLink(c);
  if (!link) return { ok: false, why: "bad-chat" };
  const ready = await discordWindowReady(); // start it first, or the link may land on the last chat
  if (!ready.ok) return { ok: false, why: ready.why };
  if (process.env.BRAIN_NO_OPEN !== "1" || process.env.BRAIN_SHELL_DISCORD) await shell.openExternal(link);
  await sleep(600);
  const placed = besideSaved ? { ok: true } : await putDiscordBeside();
  await windowHelper(["front"]);
  return { ok: true, beside: !!besideSaved, placed: !!placed.ok, why: placed.ok ? undefined : placed.why };
}

ipcMain.handle("station:discord", async (e, what, chat) => {
  if (!win || e.sender !== win.webContents) return { ok: false, why: "not-allowed" };
  if (what === "state") return { ok: true, beside: !!besideSaved, installed: fs.existsSync(DISCORD_UPDATER) };
  if (besideBusy) return { ok: false, why: "busy" };
  besideBusy = true;
  try {
    if (what === "beside") return await putDiscordBeside();
    if (what === "back") return await putDiscordBack();
    if (what === "chat") return await openDiscordChat(chat);
    if (what === "front") {
      // Opened from here (not from the server) because Windows only lets the window you are
      // using bring another program to the front; otherwise Discord opens hidden behind AI Brain.
      const ready = await discordWindowReady();
      if (!ready.ok) return { ok: false, why: ready.why };
      const r = await windowHelper(["front"]);
      return { ok: true, front: !!r.ok, beside: !!besideSaved };
    }
    return { ok: false, why: "unknown" };
  } catch (err) {
    return { ok: false, why: String(err?.message || err) };
  } finally {
    besideBusy = false;
  }
});

// ---------- a program docked in the middle (Blender, Godot, Chrome, ...) ----------
// The program keeps its own window. app-dock.cs (compiled once with the C# compiler that comes
// with Windows) glues that window to the slot in the middle of the page: it follows AI Brain,
// sits just above it, and is put back where it was on release, on quit and after a crash.
// Program paths only come from the Windows file picker here, never from the page.
const DOCK_SRC = path.join(__dirname, "app-dock.cs");
const CSC = path.join(process.env.WINDIR || "C:\\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
const PINS_FILE = () => path.join(app.getPath("userData"), "apps.json");
const DOCKED_FILE = () => path.join(app.getPath("userData"), "docked.json");
const isDiscordExe = (p) => /^discord/i.test(path.basename(String(p || "")));

let dockProc = null, dockReady = null, dockSeq = 0;
const dockWaiting = new Map();
let docked = null;      // { hwnd, name, exe, pinId, title } while a program is in the slot
let dockBusy = false;
let lastWindows = [];   // the list last shown in the page: only these may be docked by number
let slotPage = null;    // { x, y, w, h, show } in page pixels, last sent by the page

function dockExe() {
  const src = fs.readFileSync(DOCK_SRC);
  const tag = require("node:crypto").createHash("sha1").update(src).digest("hex").slice(0, 10);
  const dir = path.join(app.getPath("userData"), "helpers");
  const exe = path.join(dir, `app-dock-${tag}.exe`);
  if (fs.existsSync(exe)) return exe;
  fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(CSC)) throw new Error("The C# compiler that comes with Windows (.NET Framework 4) was not found.");
  execFileSync(CSC, ["-nologo", "-optimize", "-target:exe", `-out:${exe}`, DOCK_SRC], { windowsHide: true, timeout: 60000 });
  for (const f of fs.readdirSync(dir)) if (/^app-dock-.*\.exe$/.test(f) && path.join(dir, f) !== exe) { try { fs.rmSync(path.join(dir, f)); } catch { /* still running */ } }
  return exe;
}

function startDock() {
  if (dockReady) return dockReady;
  dockReady = new Promise((resolve) => {
    let exe;
    try { exe = dockExe(); } catch (e) { dockReady = null; resolve({ ok: false, why: String(e.message || e) }); return; }
    // Detached, so it outlives an AI Brain crash for long enough to put the program back.
    const p = spawn(exe, [], { detached: true, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    dockProc = p;
    let buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let j; try { j = JSON.parse(line); } catch { continue; }
        if (j.ev === "ready") { dockCmd("brain", win.getNativeWindowHandle().readBigUInt64LE(0)).then(() => resolve({ ok: true })); continue; }
        if (j.ev) { onDockEvent(j); continue; }
        const done = dockWaiting.get(j.id);
        if (done) { dockWaiting.delete(j.id); done(j); }
      }
    });
    p.on("exit", () => {
      dockProc = null; dockReady = null;
      for (const done of dockWaiting.values()) done({ ok: false, why: "helper-stopped" });
      dockWaiting.clear();
      if (docked) { docked = null; tellPage({ ev: "released" }); }
      resolve({ ok: false, why: "helper-stopped" });
    });
    p.on("error", (e) => { dockReady = null; resolve({ ok: false, why: String(e.message || e) }); });
  });
  return dockReady;
}
function dockCmd(...args) {
  if (!dockProc) return Promise.resolve({ ok: false, why: "helper-stopped" });
  return new Promise((resolve) => {
    const id = ++dockSeq;
    const t = setTimeout(() => { dockWaiting.delete(id); resolve({ ok: false, why: "no-answer" }); }, 10000);
    dockWaiting.set(id, (j) => { clearTimeout(t); resolve(j); });
    dockProc.stdin.write(`${id} ${args.map(String).join(" ")}\n`);
  });
}
const tellPage = (msg) => { if (win && !win.isDestroyed()) win.webContents.send("station:apps-event", msg); };
function forgetDocked() {
  docked = null;
  try { fs.rmSync(DOCKED_FILE(), { force: true }); } catch { /* not important */ }
}
function onDockEvent(j) {
  if (j.ev === "closed" && docked) {
    const was = docked;
    forgetDocked();
    tellPage({ ev: "closed", name: was.name });
    // Some programs swap windows (Godot's project list opens the editor): follow the new one.
    if (was.pinId) followNewWindow(was);
  } else if (j.ev === "moved-away" && docked) {
    const was = docked;
    forgetDocked();
    tellPage({ ev: "moved-away", name: was.name });
  }
}

// ----- pinned programs -----
function loadPins() {
  try {
    const list = JSON.parse(fs.readFileSync(PINS_FILE(), "utf8"));
    return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && typeof p.target === "string") : [];
  } catch { return []; }
}
function savePins(list) { fs.writeFileSync(PINS_FILE(), JSON.stringify(list, null, 2)); }
const iconCache = new Map();
async function pinsForPage() {
  const out = [];
  for (const p of loadPins()) {
    let icon = iconCache.get(p.target);
    if (icon === undefined) {
      try { icon = (await app.getFileIcon(p.target, { size: "normal" })).toDataURL(); } catch { icon = ""; }
      iconCache.set(p.target, icon);
    }
    out.push({ id: p.id, name: p.name, icon, found: fs.existsSync(p.target) });
  }
  return out;
}
const niceName = (file) => {
  const base = path.basename(file).replace(/\.(exe|lnk)$/i, "").replace(/[-_]?launcher$/i, "").replace(/[_-]+/g, " ").trim();
  return (base.charAt(0).toUpperCase() + base.slice(1)).slice(0, 40) || "Program";
};
async function addPin() {
  const r = await dialog.showOpenDialog(win, {
    title: "Pick a program to show in AI Brain",
    defaultPath: process.env.ProgramFiles || "C:\\Program Files",
    filters: [{ name: "Programs and shortcuts", extensions: ["exe", "lnk"] }],
    properties: ["openFile"],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, why: "canceled" };
  const file = r.filePaths[0];
  let target = file, args = "", cwd = "";
  if (/\.lnk$/i.test(file)) {
    try { const l = shell.readShortcutLink(file); target = l.target; args = l.args || ""; cwd = l.cwd || ""; } catch { return { ok: false, why: "bad-shortcut" }; }
  }
  if (!/\.exe$/i.test(target) || !fs.existsSync(target)) return { ok: false, why: "not-a-program" };
  if (isDiscordExe(target)) return { ok: false, why: "discord" };
  if (path.resolve(target).toLowerCase() === path.resolve(process.execPath).toLowerCase()) return { ok: false, why: "ai-brain" };
  const list = loadPins();
  if (list.length >= 24) return { ok: false, why: "too-many" };
  const pin = { id: require("node:crypto").randomBytes(6).toString("hex"), name: niceName(file), target, args, cwd };
  list.push(pin);
  savePins(list);
  return { ok: true, id: pin.id };
}

// ----- docking -----
const lower = (p) => String(p || "").toLowerCase();
// A pinned program's own windows: the same exe file name, or the exe it really ran last time
// (a launcher such as blender-launcher.exe starts blender.exe).
const pinExe = (pin) => {
  const name = lower(path.basename(pin.target)), ran = lower(pin.ran);
  return (w) => { const e = lower(w.exe); return !!e && (path.basename(e) === name || (!!ran && e === ran)); };
};
// Right after a launch, a new window from the program's own folder counts too (the launcher
// case), but never from shared folders such as Windows or Program Files itself.
const SHARED_DIRS = [process.env.WINDIR || "C:\\Windows", process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA, process.env.APPDATA].filter(Boolean).map(lower);
const pinLaunched = (pin) => {
  const own = pinExe(pin), dir = lower(path.dirname(path.normalize(pin.target)));
  const shared = SHARED_DIRS.includes(dir) || dir.startsWith(SHARED_DIRS[0] + "\\");
  return (w) => own(w) || (!shared && !!w.exe && lower(path.dirname(w.exe)) === dir);
};
// A real main window (not a splash screen): big enough, and still there a moment later.
const bigEnoughWin = (w) => !w.min && w.w >= 420 && w.h >= 300;
const biggest = (list) => list.slice().sort((a, b) => (b.min ? 0 : b.w * b.h) - (a.min ? 0 : a.w * a.h))[0];

async function dockWindow(hwnd, name, pinId) {
  const r = await dockCmd("dock", hwnd);
  if (!r.ok) return r;
  docked = { hwnd: r.hwnd, name: name || niceName(r.exe), exe: r.exe, pinId: pinId || "", title: r.title };
  try { fs.writeFileSync(DOCKED_FILE(), JSON.stringify({ hwnd: r.hwnd, exe: r.exe, before: r.before })); } catch { /* not important */ }
  if (pinId && r.exe) {
    // Remember the exe that really showed the window, so a running copy is found next time.
    const list = loadPins(), p = list.find((x) => x.id === pinId);
    if (p && lower(p.ran) !== lower(r.exe) && lower(p.target) !== lower(r.exe)) { p.ran = r.exe; savePins(list); }
  }
  if (slotPage) await sendSlot();
  tellPage({ ev: "docked", name: docked.name, title: docked.title, pin: docked.pinId });
  return { ok: true, name: docked.name };
}

async function waitForWindow(match, before, ms) {
  const known = new Set(before.map((w) => w.hwnd));
  let last = null;
  for (let t = 0; t < ms; t += 700) {
    await sleep(700);
    const list = ((await dockCmd("list")).windows || []).filter(match);
    const fresh = list.filter((w) => !known.has(w.hwnd) && bigEnoughWin(w));
    const pick = biggest(fresh);
    if (pick && last && last === pick.hwnd) return pick;
    last = pick ? pick.hwnd : null;
  }
  return null;
}

async function openPin(id) {
  const pin = loadPins().find((p) => p.id === id);
  if (!pin) return { ok: false, why: "no-pin" };
  if (!fs.existsSync(pin.target)) return { ok: false, why: "not-found" };
  const match = pinExe(pin);
  const before = ((await dockCmd("list")).windows || []);
  const open = before.filter((w) => match(w) && (!docked || w.hwnd !== docked.hwnd));
  // Already running: use its window (the biggest one).
  if (open.length) return dockWindow(biggest(open).hwnd, pin.name, pin.id);
  tellPage({ ev: "starting", name: pin.name });
  const argv = (pin.args.match(/"[^"]*"|\S+/g) || []).map((a) => a.replace(/^"|"$/g, ""));
  try {
    spawn(pin.target, argv, { cwd: pin.cwd && fs.existsSync(pin.cwd) ? pin.cwd : path.dirname(pin.target), detached: true, stdio: "ignore" }).unref();
  } catch (e) { return { ok: false, why: String(e.message || e) }; }
  // Big programs (Blender, Godot) can take a while to show their window.
  const got = await waitForWindow(pinLaunched(pin), before, 90000);
  if (!got) return { ok: false, why: "no-window" };
  return dockWindow(got.hwnd, pin.name, pin.id);
}

// ----- Google Flow -----
// Google's video maker has no way in for other programs. So AI Brain opens it as a small browser
// window of its own (your browser, your Google sign-in) and shows that window in the middle.
// The address is fixed here: the page can only say "open Flow". Browser windows you already
// have open are never moved - only the one window this opens.
const FLOW_ID = "builtin-flow", FLOW_NAME = "Google Flow";
const FLOW_TEST = !!(process.env.BRAIN_SHELL_TEST && process.env.BRAIN_SHELL_FLOW_URL);
const FLOW_URL = FLOW_TEST ? process.env.BRAIN_SHELL_FLOW_URL : "https://labs.google/fx/tools/flow";
let flowWin = null; // { hwnd, exe, pid, port }: the Flow window AI Brain opened (port: opened with the brain's control port)
// Flow opens with a browser profile of its own (never your normal one) and a control port on this
// computer only, so the brain can use it (flow.mjs). You sign in to Google there once.
const FLOW_PORT = Number(process.env.BRAIN_FLOW_PORT || (FLOW_TEST ? 9448 : 9447));
const flowProfile = () => path.join(app.getPath("userData"), FLOW_TEST ? "flow-test-profile" : "flow-profile");
const BROWSERS = {
  chrome: "Google\\Chrome\\Application\\chrome.exe",
  msedge: "Microsoft\\Edge\\Application\\msedge.exe",
  brave: "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
};
// The browser to use: your default one when it is Chrome, Edge or Brave (that is where you are
// signed in to Google). "" = some other browser is the default: Flow opens there, on its own.
function flowBrowser() {
  const dirs = [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean);
  const find = (k) => dirs.map((d) => path.join(d, BROWSERS[k])).find((p) => fs.existsSync(p)) || "";
  let id = "";
  try {
    id = execFileSync("reg.exe", ["query", "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice", "/v", "ProgId"], { encoding: "utf8", windowsHide: true, timeout: 5000 });
    id = (id.match(/ProgId\s+REG_SZ\s+(\S+)/) || [])[1] || "";
  } catch { /* not set: try the known browsers */ }
  const def = /^Brave/i.test(id) ? "brave" : /^MSEdge/i.test(id) ? "msedge" : /^Chrome/i.test(id) ? "chrome" : "";
  if (id && !def) return "";
  for (const k of [def, "chrome", "msedge", "brave"]) { const p = k && find(k); if (p) return p; }
  return "";
}
// An ordinary browser window ends with the browser's name; a window opened for one site does not.
const browserTitle = (t) => /[-\u2013\u2014] (Brave|Google Chrome|Chromium|Microsoft Edge)\s*$/.test(String(t || "").replace(/\u200b/g, ""));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/**
 * Closes the Flow browser - but ONLY if that process uses Flow's own profile (never the user's browser).
 * It is asked to close like the X button would, so a sign-in made a moment ago is written to disk;
 * it is only forced when it has not closed after 10 seconds.
 */
async function closeFlowBrowser(pid) {
  if (!lower(commandLine(pid)).includes(lower(flowProfile()))) return false;
  try { execFileSync("taskkill.exe", ["/PID", String(pid)], { windowsHide: true, stdio: "ignore", timeout: 8000 }); } catch { /* reported below */ }
  for (let i = 0; i < 40 && alive(pid); i++) await sleep(250);
  if (alive(pid)) { try { execFileSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 8000 }); } catch { /* gone */ } }
  for (let i = 0; i < 20 && alive(pid); i++) await sleep(250);
  await sleep(500); // the browser lets go of its profile folder
  return true;
}
async function openFlow(signIn = false) {
  let before = ((await dockCmd("list")).windows || []);
  // The Flow window from last time is still open: use it again instead of opening a second one -
  // unless it was opened the other way (with or without the brain's control port). Then that window,
  // which uses Flow's own browser profile and nothing else, is closed and opened again the right way.
  if (flowWin) {
    const w = before.find((x) => x.hwnd === flowWin.hwnd && lower(x.exe) === lower(flowWin.exe) && !browserTitle(x.title));
    if (w && flowWin.port === !signIn) return dockWindow(w.hwnd, FLOW_NAME, FLOW_ID);
    if (w && w.pid === flowWin.pid && (await closeFlowBrowser(w.pid))) before = ((await dockCmd("list")).windows || []);
    flowWin = null;
  }
  const exe = flowBrowser();
  if (!exe) { openOutside(FLOW_URL); return { ok: true, outside: true }; }
  tellPage({ ev: "starting", name: FLOW_NAME });
  // The test uses an empty browser profile of its own, so it never opens your browser session.
  const extra = [`--user-data-dir=${flowProfile()}`, "--no-first-run", "--no-default-browser-check", ...(signIn ? [] : [`--remote-debugging-port=${FLOW_PORT}`])];
  try { spawn(exe, [`--app=${FLOW_URL}`, ...extra], { detached: true, stdio: "ignore" }).unref(); }
  catch (e) { return { ok: false, why: String(e.message || e) }; }
  const base = lower(path.basename(exe));
  const got = await waitForWindow((w) => lower(path.basename(w.exe)) === base && !browserTitle(w.title), before, 30000);
  if (!got) return { ok: false, why: "flow-window" };
  flowWin = { hwnd: got.hwnd, exe: got.exe, pid: got.pid, port: !signIn };
  return dockWindow(got.hwnd, FLOW_NAME, FLOW_ID);
}

async function followNewWindow(was) {
  if (was.pinId === FLOW_ID) return; // never pick up another browser window
  const pin = loadPins().find((p) => p.id === was.pinId);
  if (!pin) return;
  const before = ((await dockCmd("list")).windows || []);
  const same = lower(was.exe);
  const got = await waitForWindow((w) => !!same && lower(w.exe) === same, before, 15000);
  if (got && !docked) await dockWindow(got.hwnd, pin.name, pin.id);
}

async function releaseDocked() {
  if (!docked) return { ok: true };
  const r = await dockCmd("release");
  forgetDocked();
  tellPage({ ev: "released" });
  return { ok: !!r.ok };
}

// The slot comes from the page in page pixels. It is turned into screen pixels when it is sent,
// so a slot sent after AI Brain was moved still lands in the right place.
function slotOnScreen() {
  if (!slotPage || !win || win.isDestroyed()) return null;
  const r = slotPage, z = win.webContents.getZoomFactor() || 1, cb = win.getContentBounds();
  const scr = screen.dipToScreenRect(win, { x: cb.x + Math.round(r.x * z), y: cb.y + Math.round(r.y * z), width: Math.max(1, Math.round(r.w * z)), height: Math.max(1, Math.round(r.h * z)) });
  return { x: scr.x, y: scr.y, w: scr.width, h: scr.height, show: r.show && !win.isMinimized() };
}
async function sendSlot() {
  const s = slotOnScreen();
  if (!s || !dockProc || slotPage.w < 40 || slotPage.h < 40) return; // not laid out yet
  return dockCmd("slot", s.x, s.y, s.w, s.h, s.show ? 1 : 0);
}
function setSlot(r) {
  const n = (v) => Math.round(Number(v) || 0);
  const next = { x: n(r?.x), y: n(r?.y), w: n(r?.w), h: n(r?.h), show: !!r?.show };
  const same = slotPage && Object.keys(next).every((k) => next[k] === slotPage[k]);
  slotPage = next;
  if (!same && docked) sendSlot();
}

// After a crash, a program may still sit where the slot was: put it back.
async function putBackAfterCrash() {
  let rec;
  try { rec = JSON.parse(fs.readFileSync(DOCKED_FILE(), "utf8")); } catch { return; }
  try { fs.rmSync(DOCKED_FILE(), { force: true }); } catch { /* not important */ }
  if (!rec?.hwnd || !rec.before) return;
  if (!(await startDock()).ok) return;
  const w = ((await dockCmd("list")).windows || []).find((x) => x.hwnd === rec.hwnd && x.exe === rec.exe);
  if (w) { const b = rec.before; await dockCmd("put", rec.hwnd, b.show, b.l, b.t, b.r, b.b); }
}

ipcMain.handle("station:apps", async (e, what, arg) => {
  if (!win || e.sender !== win.webContents) return { ok: false, why: "not-allowed" };
  try {
    if (what === "slot") { setSlot(arg); return { ok: true }; }
    if (what === "state") return { ok: true, docked: docked ? { name: docked.name, title: docked.title, pin: docked.pinId } : null, pins: await pinsForPage() };
    if (what === "remove") {
      savePins(loadPins().filter((p) => p.id !== String(arg)));
      return { ok: true, pins: await pinsForPage() };
    }
    if (what === "rename") {
      const list = loadPins(), p = list.find((x) => x.id === String(arg?.id));
      const name = String(arg?.name || "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40);
      if (p && name) { p.name = name; savePins(list); }
      return { ok: true, pins: await pinsForPage() };
    }
    if (dockBusy) return { ok: false, why: "busy" };
    dockBusy = true;
    try {
      if (what === "add") { const r = await addPin(); return { ...r, pins: await pinsForPage() }; }
      const up = await startDock();
      if (!up.ok) return up;
      if (what === "windows") {
        lastWindows = ((await dockCmd("list")).windows || []).filter((w) => !docked || w.hwnd !== docked.hwnd);
        return { ok: true, windows: lastWindows.map((w) => ({ hwnd: w.hwnd, title: w.title, app: niceName(w.exe), min: w.min })) };
      }
      if (what === "dock") {
        const w = lastWindows.find((x) => x.hwnd === Number(arg));
        if (!w) return { ok: false, why: "gone" };
        if (docked) await releaseDocked();
        return await dockWindow(w.hwnd, niceName(w.exe), "");
      }
      if (what === "open") {
        if (docked) await releaseDocked();
        return await openPin(String(arg));
      }
      if (what === "flow" || what === "flow-signin") {
        // Already in the middle and opened the asked way (with or without the brain's control port): just show it.
        if (docked && docked.pinId === FLOW_ID && flowWin && flowWin.port === (what === "flow")) return await dockCmd("front");
        if (docked) await releaseDocked();
        return await openFlow(what === "flow-signin");
      }
      if (what === "release") return await releaseDocked();
      if (what === "front") return docked ? await dockCmd("front") : { ok: false, why: "none" };
      if (what === "info") return await dockCmd("info");
      return { ok: false, why: "unknown" };
    } finally { dockBusy = false; }
  } catch (err) {
    return { ok: false, why: String(err?.message || err) };
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  setupSessions();
  if (!(await ensureServer())) { app.quit(); return; }
  await createWindow();
  putBackAfterCrash().catch(() => {});
  if (process.env.BRAIN_SHELL_TEST) selfTest(process.env.BRAIN_SHELL_TEST).catch((e) => { console.log("SELFTEST ERROR", e.message); app.quit(); });
});

// Used by the tests only: take pictures of the window, optionally put the real Discord app
// beside it and back (BRAIN_SHELL_DISCORD=1), report and quit.
async function selfTest(dir) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  await wait(3000);
  const js = (code) => win.webContents.executeJavaScript(code);
  console.log("SHELL", JSON.stringify(await js("({ shell: !!window.station?.shell, gap: getComputedStyle(document.documentElement).getPropertyValue('--win-gap'), title: document.title, webviews: document.querySelectorAll('webview').length })")));
  fs.writeFileSync(path.join(dir, "shell-1.png"), (await win.webContents.capturePage()).toPNG());
  await js("window.Station.show('discord'); true");
  await wait(2500);
  console.log("PANEL", JSON.stringify(await js("({ state: document.querySelector('#discord-state').textContent, start: document.querySelector('#discord-start').textContent, beside: !document.querySelector('#discord-beside').hidden })")));
  if (process.env.BRAIN_SHELL_DISCORD) {
    const start = await windowHelper(["info"]);
    // Hide Discord first so the button really has to bring it back.
    if (start.ok) await windowHelper(["restore", start.x, start.y, start.w, start.h, "min"]);
    win.focus();
    await wait(800);
    const behind = await windowHelper(["info"]);
    await js("document.querySelector('#discord-start').click(); true");
    await wait(6000);
    console.log("OPEN BUTTON", JSON.stringify({ behind, now: await windowHelper(["info"]) }));
    // A pinned chat (a made-up number, so Discord falls back to its friends list). Discord is put on
    // its Shop page first, so the window title shows whether the chat link really reached it.
    const title = () => { try { return execFileSync("powershell.exe", ["-NoProfile", "-Command", "(Get-Process Discord | Where-Object MainWindowTitle).MainWindowTitle"], { encoding: "utf8", windowsHide: true }).trim(); } catch { return ""; } };
    await shell.openExternal("discord://-/shop");
    await wait(4000);
    const titleBefore = title();
    const chatR = await js("window.station.discord('chat', { place: '@me', chat: '100000000000000001' })");
    await wait(2500);
    console.log("CHAT TITLE", JSON.stringify({ before: titleBefore, after: title() }));
    const chatAt = await windowHelper(["info"]);
    const chatBrain = win.getBounds();
    const chatBack = await js("window.station.discord('back')");
    console.log("CHAT", JSON.stringify({ chatR, chatAt, chatBrain, chatBack, after: await windowHelper(["info"]) }));
    win.focus();
    await wait(500);
    win.focus();
    await wait(500);
    const before = await windowHelper(["info"]);
    const brainBefore = win.getBounds();
    await js("document.querySelector('#discord-beside').click(); true");
    for (let i = 0; i < 40 && !besideSaved; i++) await wait(500);
    await wait(1500);
    const during = await windowHelper(["info"]);
    console.log("BESIDE", JSON.stringify({ before, during, brain: win.getBounds(), area: screen.getDisplayMatching(win.getBounds()).workArea, back: await js("!document.querySelector('#discord-back').hidden") }));
    fs.writeFileSync(path.join(dir, "shell-2.png"), (await win.webContents.capturePage()).toPNG());
    await js("document.querySelector('#discord-back').click(); true");
    for (let i = 0; i < 40 && besideSaved; i++) await wait(500);
    await wait(1500);
    console.log("BACK", JSON.stringify({ after: await windowHelper(["info"]), brainBefore, brainAfter: win.getBounds() }));
  }
  if (FLOW_TEST) {
    // Google Flow, with a local test page instead of Google and an empty browser profile of its
    // own. Only the window this opens is touched.
    await startDock();
    const exe = flowBrowser();
    if (!exe) console.log("FLOW SKIP", JSON.stringify({ why: "no Chrome, Edge or Brave to open it with" }));
    else {
      const base = lower(path.basename(exe));
      const old = new Set(((await dockCmd("list")).windows || []).map((w) => w.hwnd));
      const mine = async () => ((await dockCmd("list")).windows || []).filter((w) => !old.has(w.hwnd) && lower(path.basename(w.exe)) === base);
      await js("window.Station.show('apps'); true");
      await wait(500);
      const r1 = await js("document.querySelector('#apps-flow').click(); new Promise((res) => { const t = setInterval(() => { if (!document.querySelector('#appview').hidden && !document.querySelector('#av-front').disabled) { clearInterval(t); res(true); } }, 200); setTimeout(() => { clearInterval(t); res(false); }, 45000); })");
      await wait(1500);
      win.focus();
      await wait(800);
      const at = await dockCmd("info");
      // The brain's control port answers, and lists only the Flow page of this window.
      let cdp = null;
      try { const l = await (await fetch(`http://127.0.0.1:${FLOW_PORT}/json/list`)).json(); cdp = { flowPage: l.some((x) => x.type === "page" && x.url.startsWith(FLOW_URL)) }; } catch (e) { cdp = { error: String(e.message || e) }; }
      const s = slotOnScreen();
      const onSlot = !!at.frame && !!s && Math.abs(at.frame.x - s.x) <= 2 && Math.abs(at.frame.y - s.y) <= 2 && Math.abs(at.frame.w - s.w) <= 2 && Math.abs(at.frame.h - s.h) <= 2;
      console.log("FLOW OPEN", JSON.stringify({ cdp, r1, hwnd: at.hwnd || 0, fresh: !!at.hwnd && !old.has(at.hwnd), state: (await js("window.station.apps('state')")).docked, name: await js("document.querySelector('#av-name').textContent"), kind: await js("document.querySelector('#apps-flow-kind').textContent"), onSlot, pins: loadPins().length, count: (await mine()).length }));
      fs.writeFileSync(path.join(dir, "shell-flow.png"), (await win.webContents.capturePage()).toPNG());
      // A second click only brings it to the front; after "Put it back" a click uses the same window.
      const r2 = await js("window.station.apps('flow')");
      await wait(1000);
      const rel = await js("window.station.apps('release')");
      await wait(1000);
      const r3 = await js("window.station.apps('flow')");
      await wait(1500);
      const at3 = await dockCmd("info");
      console.log("FLOW AGAIN", JSON.stringify({ r2: !!r2?.ok, rel: !!rel?.ok, r3, sameWindow: !!at.hwnd && at3.hwnd === at.hwnd, count: (await mine()).length }));
      // "Open only to sign in" reopens Flow without the control port; the normal button brings it back.
      const port = async () => { try { return (await fetch(`http://127.0.0.1:${FLOW_PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };
      // Runs a line in the Flow test page through the control port (like a sign-in cookie being saved).
      const inFlow = async (expr) => {
        for (let i = 0; i < 20; i++) {
          try {
            const l = await (await fetch(`http://127.0.0.1:${FLOW_PORT}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
            const t = l.find((x) => x.type === "page" && x.url.startsWith(FLOW_URL));
            if (t) {
              const ws = new WebSocket(t.webSocketDebuggerUrl);
              await new Promise((ok, no) => { ws.onopen = ok; ws.onerror = no; setTimeout(no, 3000); });
              const v = await new Promise((ok, no) => { ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id === 1) ok(d.result?.result?.value); }; setTimeout(no, 3000);
                ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } })); });
              ws.close();
              return v;
            }
          } catch { /* not ready yet */ }
          await wait(500);
        }
        return null;
      };
      const set = await inFlow(`localStorage.setItem("brainKept", "yes"); document.cookie = "brainKept=yes; max-age=86400; path=/"; "set"`);
      const s1 = await js("window.station.apps('flow-signin')");
      await wait(1500);
      const atS = await dockCmd("info");
      const signIn = { ok: !!s1?.ok, docked: !!atS.hwnd && atS.hwnd !== at3.hwnd, port: await port(), count: (await mine()).length };
      const s2 = await js("window.station.apps('flow')");
      await wait(1500);
      const atB = await dockCmd("info");
      const back = { ok: !!s2?.ok, docked: !!atB.hwnd && atB.hwnd !== atS.hwnd, port: await port(), count: (await mine()).length,
        kept: set === "set" ? await inFlow(`(localStorage.getItem("brainKept") || "-") + "|" + /brainKept=yes/.test(document.cookie)`) : "not set" };
      console.log("FLOW SIGNIN", JSON.stringify({ signIn, back }));
      await js("window.station.apps('release')");
      await wait(800);
      for (const w of await mine()) { try { process.kill(w.pid); } catch { /* already gone */ } }
      await wait(2000);
      console.log("FLOW CLOSED", JSON.stringify({ left: (await mine()).length, docked: (await dockCmd("info")).docked }));
      // The usual case at home: the browser is already running when Flow is opened, so the new
      // window belongs to that running browser. Its ordinary window (here a second test window
      // on the same empty profile) must be left alone, and only the new Flow window is used.
      const prof = [`--user-data-dir=${path.join(app.getPath("userData"), "flow-test-profile")}`, "--no-first-run", "--no-default-browser-check"];
      try { spawn(exe, [...prof, "--new-window", `${FLOW_URL}?holder`], { detached: true, stdio: "ignore" }).unref(); } catch { /* reported below as holder: false */ }
      let holder = null;
      for (let t = 0; t < 30000 && !holder; t += 700) { await wait(700); holder = (await mine()).find((w) => browserTitle(w.title)) || null; }
      await wait(1500);
      const r4 = holder ? await js("window.station.apps('flow')") : null;
      await wait(1500);
      const at4 = await dockCmd("info");
      const all4 = await mine();
      const flow4 = all4.find((w) => w.hwnd === at4.hwnd);
      console.log("FLOW WARM", JSON.stringify({ holder: !!holder, holderTitle: holder ? holder.title : "", r4, other: !!holder && !!at4.hwnd && at4.hwnd !== holder.hwnd, samePid: !!holder && !!flow4 && flow4.pid === holder.pid,
        holderStays: !!holder && all4.some((w) => w.hwnd === holder.hwnd), count: all4.length, state: (await js("window.station.apps('state')")).docked }));
      await js("window.station.apps('release')");
      await wait(800);
      for (const w of await mine()) { try { process.kill(w.pid); } catch { /* already gone */ } }
      await wait(2000);
      console.log("FLOW WARMDONE", JSON.stringify({ left: (await mine()).length, docked: (await dockCmd("info")).docked }));
    }
  }
  if (process.env.BRAIN_SHELL_APPS) {
    // A program in the middle, opened the way a click on a pinned program opens it. System
    // Information (msinfo32) stands in for Blender unless BRAIN_SHELL_APP_EXE names another
    // program. The test stops if that program already has a window, so it never touches yours.
    const up = await startDock();
    const exeP = process.env.BRAIN_SHELL_APP_EXE || path.join(process.env.WINDIR || "C:\\Windows", "System32", "msinfo32.exe");
    const mine = (w) => lower(path.basename(w.exe)) === lower(path.basename(exeP));
    const already = ((await dockCmd("list")).windows || []).filter(mine);
    if (already.length) {
      console.log("APPS SKIP", JSON.stringify({ why: "the test program already has a window open", titles: already.map((w) => w.title) }));
    } else {
      savePins([{ id: "testpin", name: "Test program", target: exeP, args: "", cwd: "" }]);
      const t0 = Date.now();
      const openR = await js("window.station.apps('open', 'testpin')");
      const openMs = Date.now() - t0;
      await wait(1500);
      const same = (a, b) => !!a && !!b && Math.abs(a.x - b.x) <= 2 && Math.abs(a.y - b.y) <= 2 && Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2;
      const slot = () => { const s = slotOnScreen(); return s && { x: s.x, y: s.y, w: s.w, h: s.h }; };
      win.focus();
      await wait(800);
      const at = await dockCmd("info");
      const hwnd = at.hwnd || 0;
      let before = null;
      try { before = JSON.parse(fs.readFileSync(DOCKED_FILE(), "utf8")).before; } catch { /* checked below */ }
      const pre = before && { w: before.r - before.l, h: before.b - before.t };
      console.log("APPS OPEN", JSON.stringify({ up, openR, openMs, hwnd, pin: (await js("window.station.apps('state')")).docked, page: await js("({ view: !document.querySelector('#appview').hidden, name: document.querySelector('#av-name').textContent })"), onSlot: same(at.frame, slot()), stack: at.stack, frame: at.frame, slot: slot() }));
      fs.writeFileSync(path.join(dir, "shell-apps.png"), (await win.webContents.capturePage()).toPNG());
      // It follows AI Brain when AI Brain moves or changes size.
      if (win.isMaximized()) { win.unmaximize(); await wait(800); }
      win.setBounds({ x: 80, y: 60, width: 1500, height: 900 });
      await wait(1500);
      const at2 = await dockCmd("info");
      const b0 = win.getBounds();
      win.setBounds({ ...b0, x: b0.x + 60, y: b0.y + 40 });
      await wait(1200);
      const moved = await dockCmd("info");
      console.log("APPS FOLLOW", JSON.stringify({ onSlot: same(moved.frame, slot()), resizedOnSlot: same(at2.frame, at2.target), dx: moved.frame.x - at2.frame.x, dy: moved.frame.y - at2.frame.y }));
      win.setBounds(b0);
      await wait(800);
      // A dialog in AI Brain sends it behind AI Brain, and it comes back after.
      await js("document.querySelector('#btn-help').click(); true");
      await wait(1000);
      const dlg = await dockCmd("info");
      await js("document.querySelector('#dlg-help').close(); true");
      await wait(1000);
      win.focus();
      await wait(800);
      const after = await dockCmd("info");
      console.log("APPS DIALOG", JSON.stringify({ underDialog: dlg.stack, shownWhileDialog: dlg.show, afterDialog: after.stack, shownAfter: after.show }));
      // AI Brain comes to the front (Windows does not always say so) and you type in the chat:
      // the program must come back on top of AI Brain by itself.
      {
        win.setAlwaysOnTop(true); win.focus(); win.setAlwaysOnTop(false); win.webContents.focus();
        const p = await js("(() => { const b = document.querySelector('#task').getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }; })()");
        win.webContents.sendInputEvent({ type: "mouseDown", x: p.x, y: p.y, button: "left", clickCount: 1 });
        win.webContents.sendInputEvent({ type: "mouseUp", x: p.x, y: p.y, button: "left", clickCount: 1 });
        for (const ch of "hello") { win.webContents.sendInputEvent({ type: "keyDown", keyCode: ch }); win.webContents.sendInputEvent({ type: "char", keyCode: ch }); win.webContents.sendInputEvent({ type: "keyUp", keyCode: ch }); await wait(50); }
        await wait(1200);
        const typed = await dockCmd("info");
        console.log("APPS TYPING", JSON.stringify({ stack: typed.stack, show: typed.show, text: await js("document.querySelector('#task').value") }));
        await js("document.querySelector('#task').value = ''; true");
      }
      // Put it back: its own size again.
      const back = await js("window.station.apps('release')");
      await wait(1000);
      const gone = await dockCmd("info");
      const w1 = ((await dockCmd("list")).windows || []).find((x) => x.hwnd === hwnd);
      console.log("APPS RELEASE", JSON.stringify({ back, docked: gone.docked, size: w1 && { w: w1.w, h: w1.h }, page: await js("document.querySelector('#appview').hidden"), file: fs.existsSync(DOCKED_FILE()), pre }));
      // Clicking the pin again finds the running copy instead of starting a second one.
      const again = await js("window.station.apps('open', 'testpin')");
      await wait(1000);
      const at3 = await dockCmd("info");
      console.log("APPS REOPEN", JSON.stringify({ again, sameWindow: at3.hwnd === hwnd, count: ((await dockCmd("list")).windows || []).filter(pinExe(loadPins()[0])).length }));
      // The "Use a window that is open" list offers it too (released first, so it is in the list).
      await js("window.station.apps('release')");
      const listed = await js("window.station.apps('windows')");
      const dockR = await js(`window.station.apps('dock', ${hwnd})`);
      await wait(1000);
      console.log("APPS REDOCK", JSON.stringify({ listed: (listed.windows || []).some((w) => w.hwnd === hwnd), dockR, docked: (await dockCmd("info")).docked, file: fs.existsSync(DOCKED_FILE()) }));
      // Closing AI Brain now must put it back too; the runner checks that and closes the program.
    }
  }
  win.setFullScreen(true);
  await wait(1500);
  console.log("FULL", JSON.stringify(await js("({ gap: getComputedStyle(document.documentElement).getPropertyValue('--win-gap'), on: document.querySelector('#btn-full').classList.contains('on') })")));
  fs.writeFileSync(path.join(dir, "shell-3.png"), (await win.webContents.capturePage()).toPNG());
  for (const ev of ["before-quit", "will-quit", "quit"]) app.on(ev, () => console.log("EVENT", ev));
  win.on("close", () => console.log("EVENT win-close"));
  win.on("closed", () => console.log("EVENT win-closed"));
  if (process.env.BRAIN_SHELL_DISCORD) {
    // Close while side by side: both windows must go back first.
    await js("document.querySelector('#discord-beside').click(); true");
    for (let i = 0; i < 40 && !besideSaved; i++) await wait(500);
    await wait(1000);
    console.log("CLOSING WHILE BESIDE", JSON.stringify(await windowHelper(["info"])));
  }
  win.close();
}
