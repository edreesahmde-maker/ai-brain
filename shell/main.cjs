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
  if (await ping()) return true;
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
  // Closing while Discord is beside AI Brain: put both windows back first, then close.
  let closingBack = false;
  win.on("close", (e) => {
    if (!besideSaved || closingBack) return;
    e.preventDefault();
    closingBack = true;
    const w = win;
    Promise.race([putDiscordBack(), sleep(8000)]).catch(() => {}).finally(() => { if (!w.isDestroyed()) w.close(); });
  });
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

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  setupSessions();
  if (!(await ensureServer())) { app.quit(); return; }
  await createWindow();
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
