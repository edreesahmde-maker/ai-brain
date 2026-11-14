#!/usr/bin/env node
// TEST ONLY. Plays the part of the Codex CLI when ChatGPT is the brain ("codex exec --json ... -").
// Reads the task from stdin and prints events shaped like the real ones. Unlike fake-claude.mjs, its
// tool calls are REAL: it starts AI Brain's tool server (server.mjs) exactly as the -c mcp_servers.ai-brain
// settings say and calls it over MCP, so the approvals, folder rules and refusals are the real ones.
// Markers in the task pick the scenario:
//   [claude]  ask Claude (ask_claude)          [both]   ask Claude and Gemini (ask_both)
//   [write]   write_file fake-gpt-change.txt   [edit]   edit_file on that file
//   [command] run_command                      [read]   read_file on an attached file
//   [secret]  read_file in the .codex folder   [outside] read_file outside the allowed folders
//   [error]   the turn fails                   [crash]  exit before anything
//   [hang]    start, never end
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const DATA = process.env.BRAIN_DATA_DIR || process.cwd();
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;
const has = (m) => prompt.toLowerCase().includes(`[${m}]`);

// The -c settings, as Codex would read them (values are TOML; the app writes JSON-style strings).
const conf = {};
for (let i = 0; i < args.length; i++) if (args[i] === "-c") { const kv = args[++i]; const eq = kv.indexOf("="); conf[kv.slice(0, eq)] = kv.slice(eq + 1); }
const resume = args[1] === "resume" ? args.at(-2) : null;
try { fs.appendFileSync(path.join(DATA, "fake-codex-args.jsonl"), JSON.stringify({ args, conf, resume, prompt }) + "\n"); } catch {}

if (has("crash")) { process.stderr.write("fake codex: simulated crash\n"); process.exit(3); }
if (resume === "stale-thread") { out({ type: "error", message: "thread stale-thread not found" }); process.exit(1); }

const thread = resume || `fake-thread-${crypto.randomBytes(5).toString("hex")}`;
out({ type: "thread.started", thread_id: thread });
out({ type: "turn.started" });
await sleep(60);
let n = 0;
const item = (o) => ({ id: `item_${n++}`, ...o });
const say = (text) => out({ type: "item.completed", item: item({ type: "agent_message", text }) });
out({ type: "item.completed", item: item({ type: "reasoning", text: "Thinking about it." }) });

// ---- a real MCP client for the ai-brain tool server ----
let mcp = null, buf = "", nextId = 1;
const waits = new Map();
function startMcp() {
  const command = JSON.parse(conf["mcp_servers.ai-brain.command"]);
  const margs = JSON.parse(conf["mcp_servers.ai-brain.args"]);
  const env = {};
  for (const m of conf["mcp_servers.ai-brain.env"].matchAll(/([A-Za-z_][\w-]*)=("(?:[^"\\]|\\.)*")/g)) env[m[1]] = JSON.parse(m[2]);
  mcp = spawn(command, margs, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "ignore"] });
  mcp.stdout.setEncoding("utf8");
  mcp.stdout.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { const m = JSON.parse(line); if (waits.has(m.id)) { waits.get(m.id)(m); waits.delete(m.id); } } catch { /* not ours */ }
    }
  });
}
const rpc = (method, params) => new Promise((res) => { const id = nextId++; waits.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
async function mcpReady() {
  if (mcp) return;
  startMcp();
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fake-codex", version: "1" } });
  mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
}
async function tool(name, args) {
  await mcpReady();
  const it = item({ type: "mcp_tool_call", server: "ai-brain", tool: name, arguments: args, result: null, error: null, status: "in_progress" });
  out({ type: "item.started", item: it });
  const r = await rpc("tools/call", { name, arguments: args });
  const res = r.result || {};
  const textOf = (res.content || []).map((c) => c.text || "").join("\n");
  out({ type: "item.completed", item: { ...it, result: { content: res.content || [], structured_content: null }, status: res.isError ? "failed" : "completed", ...(r.error ? { error: { message: r.error.message } } : {}) } });
  return { text: textOf || r.error?.message || "", isError: !!res.isError || !!r.error };
}

const done = [];
if (has("hang")) { say("Working on it…"); await sleep(10 * 60_000); }
if (has("claude")) done.push(`claude: ${(await tool("ask_claude", { prompt: "What do you think? [from the ChatGPT brain]" })).text}`);
if (has("both")) done.push(`both: ${(await tool("ask_both", { prompt: "Both of you: ideas please" })).text.replace(/\n+/g, " | ")}`);
if (has("write")) { say("I will write the file now."); const r = await tool("write_file", { path: "fake-gpt-change.txt", content: "made by the ChatGPT brain\n" }); done.push(`write: ${r.isError ? "denied" : "allowed"} - ${r.text}`); }
if (has("edit")) { const r = await tool("edit_file", { path: "fake-gpt-change.txt", old_string: "made by", new_string: "changed by" }); done.push(`edit: ${r.isError ? "denied" : "allowed"} - ${r.text}`); }
if (has("command")) { const r = await tool("run_command", { command: "Write-Output ('hello ' + (6*7)); Write-Output \"key=$env:AI_BRAIN_APPROVE_KEY.\"", description: "say hello" }); done.push(`command: ${r.isError ? "denied" : "allowed"} - ${r.text.replace(/\s+/g, " ")}`); }
if (has("read")) { const f = (prompt.match(/Attached files:\n(.+)/) || [])[1] || "missing.txt"; const r = await tool("read_file", { path: f.trim() }); done.push(`read: ${r.isError ? "refused" : "ok"} - ${r.text.slice(0, 200).replace(/\s+/g, " ")}`); }
if (has("secret")) { const r = await tool("read_file", { path: path.join(process.env.USERPROFILE || "C:\\Users\\x", ".codex", "auth.json") }); done.push(`secret: ${r.isError ? "refused" : "ok"} - ${r.text}`); }
if (has("outside")) { const r = await tool("read_file", { path: path.join(DATA, "settings.json") }); done.push(`outside: ${r.isError ? "refused" : "ok"} - ${r.text.slice(0, 120)}`); }
if (has("tools")) { await mcpReady(); const r = await rpc("tools/list", {}); done.push(`tools: ${(r.result?.tools || []).map((t) => t.name).sort().join(",")}`); }
mcp?.kill();

if (has("error")) {
  out({ type: "turn.failed", error: { message: "Test error from the fake ChatGPT brain." } });
  process.exit(1);
}
say(`**ChatGPT brain (test reply)** to: ${prompt.split("\n")[0].slice(0, 120)}\nresumed: ${resume ? "yes" : "no"}${done.length ? `\n\n${done.join("\n")}` : ""}`);
out({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 120, reasoning_output_tokens: 10 } });
