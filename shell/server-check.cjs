// Is the AI Brain server on this port the one built from these files? If not, stop it so a new one starts.
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const buildStamp = require("../build-stamp.cjs");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pingInfo(base) {
  try {
    const r = await fetch(`${base}/api/ping`, { signal: AbortSignal.timeout(1500) });
    const j = await r.json();
    return j && j.app === "ai-brain" ? j : null;
  } catch { return null; }
}

// The process listening on the port (Windows), or 0.
function portOwner(port) {
  try {
    const out = execFileSync("netstat.exe", ["-ano", "-p", "TCP"], { encoding: "utf8", windowsHide: true, timeout: 8000 });
    const re = new RegExp(`^\\s*TCP\\s+127\\.0\\.0\\.1:${port}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "m");
    return Number((out.match(re) || [])[1]) || 0;
  } catch { return 0; }
}
function commandLine(pid) {
  try {
    return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true, timeout: 15000 }).trim();
  } catch { return ""; }
}
const norm = (p) => String(p).replace(/\//g, "\\").toLowerCase();

/** Stops an outdated server: first politely, then (only if it is this project's own app-server.mjs) by ending it. */
async function stopOld(base, port, root) {
  try {
    await fetch(`${base}/api/shutdown`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{}", signal: AbortSignal.timeout(3000) });
  } catch { /* it may close before answering */ }
  for (let i = 0; i < 40; i++) { await sleep(150); if (!(await pingInfo(base))) return { ok: true, how: "asked" }; }
  const pid = portOwner(port);
  if (!pid) return { ok: !(await pingInfo(base)), how: "gone" };
  const cl = norm(commandLine(pid));
  if (!cl.includes(norm(path.join(root, "app", "app-server.mjs")))) return { ok: false, how: "not-ours" };
  try { process.kill(pid); } catch { /* already gone */ }
  for (let i = 0; i < 40; i++) { await sleep(150); if (!(await pingInfo(base))) return { ok: true, how: "ended" }; }
  return { ok: false, how: "stuck" };
}

/** "fresh" = the running server matches these files, "none" = nothing is running, "old" = something older is running. */
async function serverState(base, root) {
  const info = await pingInfo(base);
  if (!info) return { state: "none" };
  return { state: info.build && info.build === buildStamp(root) ? "fresh" : "old", info };
}

module.exports = { pingInfo, stopOld, serverState, buildStamp, commandLine };
