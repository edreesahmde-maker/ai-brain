// AI Brain desktop window - the small, fixed bridge the page may use. Nothing else from
// Electron or Node reaches the page.
const { contextBridge, ipcRenderer } = require("electron");

const state = ipcRenderer.sendSync("station:state") || {};
const listeners = new Set();
ipcRenderer.on("station:fullscreen", (_e, on) => { for (const fn of listeners) { try { fn(!!on); } catch { /* page bug */ } } });

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
  setColors: (c) => ipcRenderer.send("station:colors", {
    color: String(c?.color || ""), symbol: String(c?.symbol || ""), height: Number(c?.height) || 0,
  }),
});
