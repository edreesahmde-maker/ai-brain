// App bridges: the brain controls a program from the inside, with no mouse.
//   craft   - the ArtCraft apps (PhotoCraft, AniCraft, VectorCraft, ...). AI Brain starts the app with
//             `--control <port>` (loopback only) and runs `<app>-cli mcp --connect 127.0.0.1:<port>`:
//             the app's own MCP server, forwarded to the live window. Its tools are listed and called here.
//   blender - Blender started with `--python bridges/blender_bridge.py` and a one-time port + token.
//   krita   - Krita with the AI Brain plugin (bridges/krita, copied into Krita's pykrita folder and
//             switched on in kritarc), started with a one-time port + token.
// A bridge only exists for a program AI Brain opened itself, while it runs. Nothing here moves the mouse.
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const net = require("node:net");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const BLENDER_SCRIPT = path.join(ROOT, "bridges", "blender_bridge.py");
const KRITA_PLUGIN = path.join(ROOT, "bridges", "krita");

const lower = (s) => String(s || "").toLowerCase();

// How each Craft app's MCP server attaches to its running window (the app is started with --control PORT).
// Apps not listed here have no live bridge yet: their MCP server runs headless, on files (the brain
// makes or edits a file, and the user opens it in the app).
const CRAFT_LIVE = {
  vectorcraft: (p) => ["--connect", `127.0.0.1:${p}`],
  cadcraft: (p) => ["--connect", `127.0.0.1:${p}`],
  lightcraft: (p) => ["--connect", `127.0.0.1:${p}`],
  wordcraft: (p) => ["--connect", `127.0.0.1:${p}`],
  deckcraft: (p) => ["--connect", String(p)],
  designcraft: (p) => ["--connect", String(p)],
  gridcraft: (p) => ["--connect", String(p)],
  soundcraft: (p) => ["--connect", String(p)],
  figcraft: (p) => ["--attach", String(p)],
  filmcraft: (p) => ["--bridge", `127.0.0.1:${p}`],
  photocraft: (p) => ["--bridge", `127.0.0.1:${p}`],
};
// Apps whose control channel needs a token: a fresh one per session, handed to the app and its MCP
// server through the environment (never on a command line).
const CRAFT_TOKEN_ENV = { filmcraft: "FILMCRAFT_CONTROL_TOKEN", photocraft: "PHOTOCRAFT_CONTROL_TOKEN" };

/** What kind of bridge a program can have: "craft", "blender", "krita" or "" (none). */
function kindOf(target) {
  const base = lower(path.basename(String(target || "")));
  if (/^blender(-launcher)?\.exe$/.test(base)) return "blender";
  if (base === "krita.exe") return "krita";
  const m = base.match(/^([a-z]+craft|craft-anything)\.exe$/);
  if (m && fs.existsSync(path.join(path.dirname(target), `${m[1]}-cli.exe`))) return "craft";
  return "";
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// ---------- Krita: put the plugin in place and switch it on ----------
function kritaDirs() {
  const appdata = process.env.APPDATA || "", local = process.env.LOCALAPPDATA || "";
  return { pykrita: path.join(appdata, "krita", "pykrita"), kritarc: path.join(local, "kritarc") };
}
function ensureKritaPlugin() {
  const { pykrita, kritarc } = kritaDirs();
  fs.mkdirSync(path.join(pykrita, "aibrain_bridge"), { recursive: true });
  fs.copyFileSync(path.join(KRITA_PLUGIN, "aibrain_bridge.desktop"), path.join(pykrita, "aibrain_bridge.desktop"));
  fs.copyFileSync(path.join(KRITA_PLUGIN, "aibrain_bridge", "__init__.py"), path.join(pykrita, "aibrain_bridge", "__init__.py"));
  // [python] enable_aibrain_bridge=true (the plugin manager's switch), keeping everything else in kritarc.
  let text = "";
  try { text = fs.readFileSync(kritarc, "utf8"); } catch { /* Krita was never opened */ }
  if (/^\s*enable_aibrain_bridge\s*=\s*true\s*$/m.test(text)) return;
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === "[python]");
  if (at < 0) text = `${text.replace(/\s*$/, "")}${text.trim() ? "\n\n" : ""}[python]\nenable_aibrain_bridge=true\n`;
  else {
    const without = lines.filter((l, i) => !(i > at && /^\s*enable_aibrain_bridge\s*=/.test(l)));
    without.splice(at + 1, 0, "enable_aibrain_bridge=true");
    text = without.join("\n");
  }
  fs.writeFileSync(kritarc, text);
}

/**
 * How to start a pinned program with its bridge on.
 * @returns {Promise<{target: string, argv: string[], env: object, bridge: object|null}>}
 */
async function prepare(target, argv = []) {
  const kind = kindOf(target);
  if (!kind) return { target, argv, env: {}, bridge: null };
  if (kind === "craft") {
    const app = lower(path.basename(target)).replace(/\.exe$/, "");
    const cli = path.join(path.dirname(target), `${app}-cli.exe`);
    if (!CRAFT_LIVE[app]) return { target, argv, env: {}, bridge: { kind, app, live: false, cli, mcpArgs: ["mcp"] } };
    const port = await freePort();
    const env = CRAFT_TOKEN_ENV[app] ? { [CRAFT_TOKEN_ENV[app]]: crypto.randomBytes(32).toString("hex") } : {};
    return { target, argv: [...argv, "--control", String(port)], env, bridge: { kind, app, live: true, port, cli, mcpArgs: ["mcp", ...CRAFT_LIVE[app](port)], env } };
  }
  const port = await freePort();
  const token = crypto.randomBytes(24).toString("hex");
  const env = { AIBRAIN_BRIDGE_PORT: String(port), AIBRAIN_BRIDGE_TOKEN: token };
  if (kind === "blender") {
    // The launcher starts blender.exe without passing the script on: start blender.exe itself.
    const exe = path.join(path.dirname(target), "blender.exe");
    return { target: fs.existsSync(exe) ? exe : target, argv: [...argv, "--python", BLENDER_SCRIPT], env, bridge: { kind, app: "blender", port, token } };
  }
  ensureKritaPlugin();
  return { target, argv, env, bridge: { kind, app: "krita", port, token } };
}

// ---------- talking to a bridge ----------
function canConnect(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port }, () => { s.destroy(); resolve(true); });
    s.on("error", () => resolve(false));
    s.setTimeout(1500, () => { s.destroy(); resolve(false); });
  });
}

// One JSON line to a Blender/Krita bridge, one line back.
function ask(port, obj, ms = 120000) {
  return new Promise((resolve) => {
    let buf = "", done = false;
    const end = (r) => { if (!done) { done = true; s.destroy(); resolve(r); } };
    const s = net.connect({ host: "127.0.0.1", port }, () => s.write(JSON.stringify(obj) + "\n"));
    s.setEncoding("utf8");
    s.on("data", (d) => { buf += d; const i = buf.indexOf("\n"); if (i >= 0) { try { end(JSON.parse(buf.slice(0, i))); } catch { end({ ok: false, error: "bad answer" }); } } });
    s.on("error", (e) => end({ ok: false, error: `not reachable (${e.code || e.message})` }));
    s.on("close", () => end({ ok: false, error: "the program closed the connection" }));
    setTimeout(() => end({ ok: false, error: "no answer in time" }), ms);
  });
}

// A minimal MCP client over a child process's stdio (newline-delimited JSON-RPC).
class McpClient {
  constructor(exe, args, env = {}) {
    this.p = spawn(exe, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } });
    this.n = 0; this.waiting = new Map(); this.buf = ""; this.err = ""; this.closed = false;
    this.p.stdout.setEncoding("utf8");
    this.p.stdout.on("data", (d) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        const w = this.waiting.get(m.id);
        if (w) { this.waiting.delete(m.id); w(m); }
      }
    });
    this.p.stderr.on("data", (d) => { this.err = (this.err + d).slice(-4000); });
    const gone = () => { this.closed = true; for (const w of this.waiting.values()) w({ error: { message: `the bridge stopped${this.err ? `: ${this.err.trim().split("\n").pop()}` : ""}` } }); this.waiting.clear(); };
    this.p.on("exit", gone);
    this.p.on("error", (e) => { this.err += String(e.message); gone(); });
  }
  request(method, params = {}, ms = 120000) {
    if (this.closed) return Promise.resolve({ error: { message: "the bridge is not running" } });
    const id = ++this.n;
    return new Promise((resolve) => {
      const t = setTimeout(() => { this.waiting.delete(id); resolve({ error: { message: "no answer in time" } }); }, ms);
      this.waiting.set(id, (m) => { clearTimeout(t); resolve(m); });
      this.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  notify(method, params = {}) { if (!this.closed) this.p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); }
  close() { try { this.p.stdin.end(); this.p.kill(); } catch { /* gone */ } this.closed = true; }
}

class Bridge {
  constructor(info) { this.info = info; this.mcp = null; this.tools = null; }
  get kind() { return this.info.kind; }

  /** Waits until the program's bridge answers (big programs take a while to start). */
  async ready(ms = 60000) {
    const end = Date.now() + ms;
    if (this.kind === "craft" && !this.info.live) return this.connect(); // headless: nothing to wait for
    while (Date.now() < end) {
      if (this.kind === "craft") { if (await canConnect(this.info.port)) return this.connect(); }
      else { const r = await ask(this.info.port, { token: this.info.token, id: 0, cmd: "info" }, 3000); if (r.ok) return { ok: true }; }
      await new Promise((r) => setTimeout(r, 700));
    }
    return { ok: false, why: "the program's bridge did not answer" };
  }

  async connect() {
    if (this.mcp && !this.mcp.closed) return { ok: true };
    this.mcp = new McpClient(this.info.cli, this.info.mcpArgs || ["mcp"], this.info.env || {});
    const r = await this.mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ai-brain", version: "1" } }, 30000);
    if (r.error) return { ok: false, why: r.error.message };
    this.mcp.notify("notifications/initialized");
    this.tools = null;
    return { ok: true, server: r.result?.serverInfo };
  }

  /** The bridge's commands: for a Craft app its MCP tools; for Blender/Krita, Python. */
  async commands() {
    if (this.kind !== "craft") return { ok: true, kind: this.kind, python: true };
    const c = await this.connect();
    if (!c.ok) return c;
    if (!this.tools) {
      const r = await this.mcp.request("tools/list", {}, 30000);
      if (r.error) return { ok: false, why: r.error.message };
      this.tools = (r.result?.tools || []).map((t) => ({ name: t.name, description: t.description || "", input: t.inputSchema || {} }));
    }
    return { ok: true, kind: "craft", tools: this.tools };
  }

  /** Runs one of a Craft app's tools. Returns its MCP content (text and pictures). */
  async call(name, args = {}) {
    if (this.kind !== "craft") return { ok: false, why: "This program has no command list; use Python." };
    const c = await this.connect();
    if (!c.ok) return c;
    const r = await this.mcp.request("tools/call", { name, arguments: args && typeof args === "object" ? args : {} }, 180000);
    if (r.error) return { ok: false, why: r.error.message };
    return { ok: !r.result?.isError, content: r.result?.content || [], why: r.result?.isError ? (r.result.content || []).map((x) => x.text || "").join("\n") : undefined };
  }

  /** Runs Python inside Blender or Krita. */
  async python(code) {
    if (this.kind === "craft") return { ok: false, why: "This program takes commands, not Python." };
    const r = await ask(this.info.port, { token: this.info.token, id: 1, cmd: "python", code: String(code || "") }, 180000);
    return r.ok ? { ok: true, output: r.output || "", result: r.result ?? null } : { ok: false, why: r.error || "it did not work" };
  }

  async about() {
    if (this.kind === "craft") { const c = await this.connect(); return c.ok ? { ok: true, app: this.info.app, live: !!this.info.live, server: c.server } : c; }
    const r = await ask(this.info.port, { token: this.info.token, id: 2, cmd: "info" }, 10000);
    return r.ok ? { ok: true, ...r.result } : { ok: false, why: r.error };
  }

  close() { this.mcp?.close(); this.mcp = null; }
}

module.exports = { kindOf, prepare, Bridge, ensureKritaPlugin, freePort, BLENDER_SCRIPT, CRAFT_LIVE };
