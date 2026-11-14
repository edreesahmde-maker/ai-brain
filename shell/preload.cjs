// AI Brain desktop window - the small, fixed bridge the page may use. Nothing else from
// Electron or Node reaches the page.
const { contextBridge, ipcRenderer } = require("electron");

const state = ipcRenderer.sendSync("station:state") || {};
const listeners = new Set();
ipcRenderer.on("station:fullscreen", (_e, on) => { for (const fn of listeners) { try { fn(!!on); } catch { /* page bug */ } } });
const appListeners = new Set();
ipcRenderer.on("station:apps-event", (_e, msg) => { for (const fn of appListeners) { try { fn({ ...msg }); } catch { /* page bug */ } } });

contextBridge.exposeInMainWorld("station", {
  shell: true,
  version: String(state.version || ""),
  isFullscreen: !!state.fullscreen,
  controlsWidth: Number(state.controlsWidth) || 140,
  toggleFullscreen: () => ipcRenderer.send("station:toggle-fullscreen"),
  onFullscreen: (fn) => { if (typeof fn === "function") listeners.add(fn); },
  // The installed Discord app: bring it to the front, open a pinned chat beside AI Brain, or put both back.
  discord: (what, chat) => what === "chat"
    ? ipcRenderer.invoke("station:discord", "chat", { place: String(chat?.place ?? "").slice(0, 22), chat: String(chat?.chat ?? "").slice(0, 22) })
    : ipcRenderer.invoke("station:discord", ["state", "beside", "back", "front"].includes(what) ? what : "state"),
  // A program (Blender, Godot, Chrome, ...) shown in the middle of AI Brain. Programs are only
  // added through the Windows file picker; the page passes ids and numbers, never paths.
  apps: (what, arg) => {
    const ok = ["state", "add", "remove", "rename", "open", "flow", "flow-signin", "windows", "dock", "release", "front", "slot", "info"];
    if (!ok.includes(what)) return Promise.resolve({ ok: false, why: "unknown" });
    let a;
    if (what === "slot") a = { x: +arg?.x || 0, y: +arg?.y || 0, w: +arg?.w || 0, h: +arg?.h || 0, show: !!arg?.show };
    else if (what === "rename") a = { id: String(arg?.id ?? "").slice(0, 40), name: String(arg?.name ?? "").slice(0, 60) };
    else if (what === "dock") a = Number(arg) || 0;
    else a = String(arg ?? "").slice(0, 40);
    return ipcRenderer.invoke("station:apps", what, a);
  },
  onApps: (fn) => { if (typeof fn === "function") appListeners.add(fn); },
  setColors: (c) => ipcRenderer.send("station:colors", {
    color: String(c?.color || ""), symbol: String(c?.symbol || ""), height: Number(c?.height) || 0,
  }),
});
