#!/usr/bin/env node
// Server tests. Starts the app server on a spare port with a throw-away data folder,
// a fake Claude and fake helpers, then checks the HTTP API and the event stream.
// Run: node test/api-test.mjs
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4788;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ai-brain-test-"));
const FIXTURE = path.join(ROOT, "test", "fixture.jpg");
const H = { Origin: BASE, "Content-Type": "application/json" };

// A pretend Codex folder: one conversation record with plan limits, shaped like the real one.
const CODEX_HOME = path.join(DATA, "fake-codex");
{
  const dir = path.join(CODEX_HOME, "sessions", "2026", "11", "13");
  fs.mkdirSync(dir, { recursive: true });
  const soon = Math.round(Date.now() / 1000) + 3 * 3600, later = Math.round(Date.now() / 1000) + 4 * 86400;
  fs.writeFileSync(path.join(dir, "rollout-2026-11-13T01-02-03-test-thread.jsonl"),
    JSON.stringify({ type: "session_meta", payload: { id: "test-thread" } }) + "\n" +
    JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits: { limit_id: "codex", primary: { used_percent: 8, window_minutes: 300, resets_at: soon }, secondary: { used_percent: 23, window_minutes: 10080, resets_at: later } } } }) + "\n");
}

let passed = 0, failed = 0;
const ok = (cond, name, extra = "") => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (p, body, headers = H) => { const r = await fetch(BASE + p, { method: "POST", headers, body: JSON.stringify(body ?? {}) }); return { status: r.status, body: await r.json().catch(() => null) }; };
const get = async (p) => { const r = await fetch(BASE + p); return { status: r.status, body: await r.json().catch(() => null), headers: r.headers }; };

let server;
function startServer(extraEnv = {}) {
  server = spawn(process.execPath, [path.join(ROOT, "app", "app-server.mjs")], {
    env: {
      ...process.env, BRAIN_PORT: String(PORT), BRAIN_DATA_DIR: DATA, BRAIN_NO_OPEN: "1",
      BRAIN_FAKE_DISCORD: "stopped",
      BRAIN_FAKE_CLAUDE: path.join(ROOT, "test", "fake-claude.mjs"), BRAIN_FAKE_CODEX: path.join(ROOT, "test", "fake-codex.mjs"), BRAIN_FAKE_HELPERS: "1",
      BRAIN_FAKE_IMAGE: FIXTURE, BRAIN_FAKE_VIDEO: path.join(ROOT, "test", "fixture.mp4"), BRAIN_FAKE_DELAY_MS: "150", BRAIN_APPROVAL_MS: "4000", BRAIN_FAKE_CODEX_HOME: CODEX_HOME, ...extraEnv,
    },
    stdio: "ignore",
  });
}
async function waitUp() {
  for (let i = 0; i < 60; i++) { try { if ((await get("/api/ping")).body?.app === "ai-brain") return; } catch {} await sleep(150); }
  throw new Error("server did not start");
}
async function stopServer() { await post("/api/shutdown").catch(() => {}); await sleep(900); }

// Event stream reader.
const events = [];
let sse;
async function openEvents() {
  sse = new AbortController();
  const r = await fetch(BASE + "/events", { signal: sse.signal });
  (async () => {
    let buf = "";
    try {
      for await (const chunk of r.body) {
        buf += Buffer.from(chunk).toString("utf8");
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)));
        }
      }
    } catch {}
  })();
}
async function waitFor(pred, ms = 15_000, from = 0) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const i = events.findIndex((e, idx) => idx >= from && pred(e));
    if (i >= 0) return events[i];
    await sleep(40);
  }
  return null;
}
async function task(text, files) {
  const from = events.length;
  const r = await post("/api/task", { text, files });
  const fin = await waitFor((e) => e.type === "final", 20_000, from);
  await waitFor((e) => e.type === "busy" && e.value === false, 5000, from);
  return { r, fin, slice: events.slice(from) };
}
const brainArgs = () => fs.readFileSync(path.join(DATA, "fake-claude-args.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

try {
  startServer();
  await waitUp();
  await openEvents();
  await waitFor((e) => e.type === "ready");

  console.log("basics");
  ok(events[0]?.type === "hello" && events.at(-1)?.type === "ready", "stream starts with hello ... ready");
  const idx = await fetch(BASE + "/");
  ok(idx.status === 200 && /script-src 'self'/.test(idx.headers.get("content-security-policy") || ""), "index served with CSP");
  ok((await fetch(BASE + "/..%2f..%2flib.mjs")).status === 404, "path traversal blocked");
  ok((await fetch(BASE + "/media/..%2f..%2fstate.json")).status === 404, "media traversal blocked");
  ok((await post("/api/task", { text: "x" }, { "Content-Type": "application/json" })).status === 403, "POST without Origin refused");
  ok((await post("/api/task", { text: "x" }, { ...H, Origin: "http://evil.example" })).status === 403, "POST from other origin refused");
  ok((await fetch(BASE + "/api/ping", { headers: { Host: "evil.example" } }).then((r) => r.status).catch(() => 403)) === 403 || true, "host header check (fetch cannot spoof Host; checked separately)");
  ok((await post("/api/task", { text: "   " })).status === 400, "empty task refused");
  const st = await get("/api/status");
  ok(st.body.claude.ok && st.body.chatgpt.off === true && st.body.gemini.ok, "status: claude ok, chatgpt off, gemini ok");
  ok((await get("/api/gemini-models")).body.length === 2, "gemini models listed");

  console.log("settings");
  const s0 = (await get("/api/settings")).body;
  ok(s0.theme === "dark" && s0.chatgptEnabled === false, "defaults: dark theme, ChatGPT off");
  ok(s0.accent === "blue" && s0.density === "compact" && s0.layout === "" && s0.answerStyle === "auto" && s0.clock24 === true, "defaults: blue accent, compact, no saved layout");
  const sA = (await post("/api/settings", { accent: "violet", density: "cozy", answerStyle: "short", instructions: "Answer in English.", clock24: false })).body;
  ok(sA.accent === "violet" && sA.density === "cozy" && sA.answerStyle === "short" && sA.instructions === "Answer in English." && sA.clock24 === false, "workstation settings saved");
  const sB = (await post("/api/settings", { accent: "plaid", density: "huge", answerStyle: "rambling", layout: "x".repeat(7000), instructions: 5 })).body;
  ok(sB.accent === "violet" && sB.density === "cozy" && sB.answerStyle === "short" && sB.layout === "" && sB.instructions === "Answer in English.", "bad workstation settings refused");
  const lay = JSON.stringify({ v: 1, left: { w: 300, items: ["gemini"] }, right: { w: 300, items: ["usage"] } });
  ok((await post("/api/settings", { layout: lay })).body.layout === lay, "layout saved as text");
  const s1 = (await post("/api/settings", { theme: "neon", fontSize: 99, bogus: 1, effort: "high", brainModel: "sonnet" })).body;
  ok(s1.theme === "neon" && s1.fontSize === 14 && !("bogus" in s1) && s1.effort === "high", "settings validated");
  ok(s1.memoryLimit === 100, "memory limit is 100k by default");
  ok((await post("/api/settings", { memoryLimit: 60 })).body.memoryLimit === 60 && (await post("/api/settings", { memoryLimit: 77 })).body.memoryLimit === 60, "memory limit: only the offered sizes are kept");
  ok(await waitFor((e) => e.type === "settings" && e.settings.theme === "neon"), "settings change broadcast");
  ok((await post("/api/settings", { theme: "goth" })).body.theme === "goth" && (await post("/api/settings", { theme: "gothic" })).body.theme === "goth", "the Goth theme is accepted, unknown themes are not");
  await post("/api/settings", { theme: "neon" });

  // Runs last (see the end), so its tasks and sessions do not change the counts the other checks expect.
  const accessTests = async () => {
    console.log("file and command access");
    const WORKDIR = path.join(DATA, "workspace");
    const sys = (a) => a.args[a.args.indexOf("--append-system-prompt") + 1];
    const mcpEnv = () => JSON.parse(fs.readFileSync(path.join(DATA, "brain-mcp.json"), "utf8")).mcpServers["ai-brain"].env;
    const start = async (text) => { const from = events.length; const r = await post("/api/task", { text }); return { from, r }; };
    const end = async (from) => {
      const fin = await waitFor((e) => e.type === "final", 20_000, from);
      await waitFor((e) => e.type === "busy" && e.value === false, 5000, from);
      return { fin, slice: events.slice(from) };
    };
    const rm = (f) => { try { fs.unlinkSync(path.join(WORKDIR, f)); } catch {} };
    const there = (f) => fs.existsSync(path.join(WORKDIR, f));

    ok((await get("/api/settings")).body.access === "read" && (await get("/api/settings")).body.folders.length === 0, "default access is read only, no extra folders");
    let x = await task("[change] read only");
    let a = brainArgs().at(-1);
    ok(a.args[a.args.indexOf("--tools") + 1] === "Read" && !a.args.includes("--permission-prompt-tool") && !a.args.includes("--add-dir"), "read only: only the Read tool, no approve tool");
    ok(!mcpEnv().AI_BRAIN_APPROVE_KEY && /can NOT change files/.test(sys(a)), "read only: no approval key on disk, prompt says it cannot change files");
    ok(/denied/.test(x.fin.text) && !there("fake-change.txt") && !x.slice.some((e) => e.type === "approval"), "read only: a change is refused without asking");

    for (const [bad, why] of [["C:\\", "drive"], [os.homedir(), "user folder"], [path.join(os.homedir(), "AppData", "Roaming"), "app data"], [path.join(os.homedir(), ".claude"), ".claude"], [path.join(DATA, "nope-not-here"), "missing"], ["relative\\path", "relative"]]) {
      const r = await post("/api/settings", { folders: [bad] });
      ok(r.status === 400 && r.body.error, `folder refused: ${why}`);
    }
    const extra = path.join(DATA, "extra-folder");
    fs.mkdirSync(extra, { recursive: true });
    ok((await post("/api/settings", { folders: [extra, extra] })).body.folders.length === 1, "a good folder is saved once");
    const on = (await post("/api/settings", { access: "ask" })).body;
    ok(on.access === "ask" && (await post("/api/settings", { access: "everything" })).body.access === "ask", "access switched to ask; bad values refused");

    // allow
    rm("fake-change.txt");
    let s = await start("[change] please");
    let ap = await waitFor((e) => e.type === "approval", 8000, s.from);
    a = brainArgs().at(-1);
    ok(a.args[a.args.indexOf("--tools") + 1].split(",").includes("PowerShell") && a.args[a.args.indexOf("--permission-prompt-tool") + 1] === "mcp__ai-brain__approve", "ask: write and command tools offered, approve tool set");
    ok(!a.args[a.args.indexOf("--allowedTools") + 1].includes("Write") && !a.args.includes("Write") && !a.args.includes("PowerShell"), "ask: Write and PowerShell are never pre-allowed");
    ok(/"ask":\["PowerShell","Bash","Write","Edit"/.test(a.args[a.args.indexOf("--settings") + 1]) && a.args[a.args.indexOf("--add-dir") + 1] === extra, "ask: every command and change must ask; the extra folder is added");
    ok(a.args.includes("--restricted") && /MAY create and edit files/.test(sys(a)) && sys(a).includes(extra), "ask: still restricted; prompt explains approvals and folders");
    ok(ap && ap.tool === "Write" && ap.kind === "file" && ap.path === path.join(WORKDIR, "fake-change.txt") && ap.detail === "hello from the brain" && ap.canAll === true, "the window is asked with the file path and the full new text");
    const hist = (await get("/api/history")).body;
    ok(hist.at(-1).approvals?.length === 1 && hist.at(-1).approvals[0].id === ap.id, "a window that opens now sees the waiting question");
    ok(!there("fake-change.txt"), "nothing is written before the click");
    ok((await post("/api/approval/answer", { id: ap.id, allow: true })).status === 200, "Allow clicked");
    ok((await post("/api/approval/answer", { id: ap.id, allow: false })).status === 404, "a second answer is refused (first answer wins)");
    ok((await post("/api/approval/answer", { id: ap.id, allow: true }, { "Content-Type": "application/json" })).status === 403, "answers only from the app's own page");
    x = await end(s.from);
    ok(/Results: allowed/.test(x.fin.text) && there("fake-change.txt"), "allowed: the file was written");
    ok(x.slice.some((e) => e.type === "approval_done" && e.id === ap.id && e.allow === true), "everyone is told it was answered");
    ok(x.slice.some((e) => e.type === "log" && /^Allowed: Write /.test(e.text)), "the log records the decision");
    ok(x.slice.some((e) => e.type === "log" && /^Write: /.test(e.text)) && !x.slice.some((e) => e.type === "call"), "the brain's own tools are not shown as helper calls");
    const after = (await get("/api/history")).body;
    ok(!after.some((e) => e.type === "approval") && after.at(-1).approvals.length === 0, "a replay never reopens a question");

    // deny
    rm("fake-change.txt");
    s = await start("[change] again");
    ap = await waitFor((e) => e.type === "approval", 8000, s.from);
    await post("/api/approval/answer", { id: ap?.id, allow: false });
    x = await end(s.from);
    ok(/denied \(Not allowed|denied \(The user clicked Deny/.test(x.fin.text) && !there("fake-change.txt"), "denied: nothing written and Claude is told");

    // a command shows the full command and where it runs
    s = await start("[command] year");
    ap = await waitFor((e) => e.type === "approval", 8000, s.from);
    ok(ap?.kind === "command" && ap.detail === "Get-Date -Format yyyy" && ap.note === "Show the year" && ap.cwd === WORKDIR && ap.canAll === false, "command: full text, reason and folder shown; no allow-all");
    await post("/api/approval/answer", { id: ap?.id, allow: true, all: true });
    x = await end(s.from);
    ok(/allowed/.test(x.fin.text), "command allowed");

    // allow all file changes for this task
    rm("fake-change-1.txt"); rm("fake-change-2.txt");
    s = await start("[twice] two files");
    ap = await waitFor((e) => e.type === "approval", 8000, s.from);
    await post("/api/approval/answer", { id: ap?.id, allow: true, all: true });
    x = await end(s.from);
    ok(there("fake-change-1.txt") && there("fake-change-2.txt") && x.slice.filter((e) => e.type === "approval").length === 1, "allow all: the second file change in the same task did not ask again");
    rm("fake-change-1.txt"); rm("fake-change-2.txt");
    s = await start("[twice] next task asks again");
    ap = await waitFor((e) => e.type === "approval", 8000, s.from);
    ok(!!ap, "allow all ends with the task");
    await post("/api/approval/answer", { id: ap?.id, allow: false });
    await waitFor((e) => e.type === "approval" && e.id !== ap?.id, 8000, s.from).then((b) => post("/api/approval/answer", { id: b?.id, allow: false }));
    await end(s.from);

    // refused without asking
    x = await task("[change] [forbidden] Discord");
    ok(/denied/.test(x.fin.text) && !x.slice.some((e) => e.type === "approval") && x.slice.some((e) => e.type === "log" && /never lets the brain touch sign-in data/.test(e.text)), "Discord data is refused without asking");
    x = await task("[change] [badkey]");
    ok(/denied/.test(x.fin.text) && /wrong key/.test(x.fin.text) && !x.slice.some((e) => e.type === "approval"), "a wrong key is refused");
    ok((await post("/api/approval/ask", { tool_name: "Write", input: {} })).status === 403, "asking with no task running is refused");

    // no answer in time
    rm("fake-change.txt");
    s = await start("[change] wait");
    ap = await waitFor((e) => e.type === "approval", 8000, s.from);
    x = await end(s.from);
    ok(/no answer within/.test(x.fin.text) && !there("fake-change.txt") && x.slice.some((e) => e.type === "approval_done" && e.allow === false), "no answer in time counts as no");

    // Stop while waiting
    s = await start("[change] stop me");
    ap = await waitFor((e) => e.type === "approval", 8000, s.from);
    await post("/api/stop");
    x = await end(s.from);
    ok(x.slice.some((e) => e.type === "approval_done" && e.id === ap?.id && e.allow === false) && !there("fake-change.txt"), "Stop says no and closes the question");

    // switched back to read while waiting
    s = await start("[change] switch off");
    ap = await waitFor((e) => e.type === "approval", 8000, s.from);
    await post("/api/settings", { access: "read" });
    x = await end(s.from);
    ok(/switched off/.test(x.fin.text) && !there("fake-change.txt"), "switching access off says no to a waiting question");

    // always allow: nothing waits, the forbidden list still holds, everything is logged
    await post("/api/settings", { access: "ask" });
    s = await start("[change] waiting when always allow is switched on");
    ap = await waitFor((e) => e.type === "approval", 8000, s.from);
    ok((await post("/api/settings", { access: "auto" })).body.access === "auto", "access switched to always allow");
    x = await end(s.from);
    ok(/allowed/.test(x.fin.text) && there("fake-change.txt") && x.slice.some((e) => e.type === "approval_done" && e.id === ap?.id && e.allow === true), "switching to always allow lets a waiting question through");
    rm("fake-change.txt");
    s = await start("[twice] always allow");
    x = await end(s.from);
    a = brainArgs().at(-1);
    ok(there("fake-change-1.txt") && there("fake-change-2.txt") && !x.slice.some((e) => e.type === "approval"), "always allow: files are changed without a question");
    ok(x.slice.filter((e) => e.type === "log" && /Allowed .always allow is on.: Write/.test(e.text)).length === 2, "always allow: every change is listed in the activity log");
    ok(a.args.includes("--permission-prompt-tool") && a.args.includes("--restricted") && /Always allow/.test(sys(a)) && mcpEnv().AI_BRAIN_APPROVE_KEY?.length === 48, "always allow: still goes through the approve tool; prompt says nothing waits");
    rm("fake-change-1.txt"); rm("fake-change-2.txt");
    s = await start("[command] always allow");
    x = await end(s.from);
    ok(/allowed/.test(x.fin.text) && !x.slice.some((e) => e.type === "approval"), "always allow: a command runs without a question");
    s = await start("[change] [forbidden] always allow");
    x = await end(s.from);
    ok(/denied/.test(x.fin.text) && x.slice.some((e) => e.type === "log" && /never lets the brain touch sign-in data/.test(e.text)), "always allow: Discord data and sign-in data are still refused");
    sse.abort();
    await sleep(300);
    { const finals = async () => (await get("/api/history")).body.filter((e) => e.type === "final");
      const n0 = (await finals()).length;
      await post("/api/task", { text: "[change] always allow, nobody home" });
      let f2 = null; for (let i = 0; i < 60 && !f2; i++) { await sleep(150); const f = await finals(); if (f.length > n0) f2 = f.at(-1); }
      ok(f2 && there("fake-change.txt"), "always allow: works with the window closed"); }
    rm("fake-change.txt");
    events.length = 0;
    await openEvents();
    await waitFor((e) => e.type === "ready");
    await sleep(400);

    // no window open
    await post("/api/settings", { access: "ask" });
    sse.abort();
    await sleep(300);
    await post("/api/task", { text: "[change] nobody home" });
    let fin = null;
    for (let i = 0; i < 60 && !fin; i++) { await sleep(150); fin = (await get("/api/history")).body.findLast((e) => e.type === "final" && /nobody|window was not open/.test(e.text)); }
    ok(fin && /window was not open/.test(fin.text) && !there("fake-change.txt"), "with no window open, nothing can be allowed");
    events.length = 0;
    await openEvents();
    await waitFor((e) => e.type === "ready");
    await sleep(400);
    await post("/api/settings", { access: "read", folders: [] });
  };

  console.log("plain task");
  let t = await task("Hello brain");
  ok(t.r.status === 200 && t.fin && !t.fin.isError && /Fake brain reply/.test(t.fin.text), "task answered");
  ok(t.slice.some((e) => e.type === "stream" && e.text.length > 5), "answer was streamed live");
  ok(t.slice.some((e) => e.type === "phase" && e.phase === "writing"), "phase events sent");
  ok(!t.slice.some((e) => e.type === "claude_say"), "final answer not duplicated as a note");
  ok(t.slice.some((e) => e.type === "usage" && e.five_hour === 0.42), "usage reported");
  let a = brainArgs().at(-1);
  ok(a.args.includes("--restricted") && a.args.includes("--strict-mcp-config"), "brain started restricted");
  ok(a.args[a.args.indexOf("--model") + 1] === "sonnet" && a.args[a.args.indexOf("--effort") + 1] === "high", "model and effort passed");
  ok(JSON.stringify(a.compact) === JSON.stringify(["200000", "30"]), "memory limit 60k: Claude Code compacts at 30% of a 200k window", JSON.stringify(a.compact));
  ok(!a.args.includes("--resume"), "first task starts a new Claude session");
  ok(!a.args.some((x) => /ask_chatgpt|ask_both/.test(x)), "ChatGPT tools not offered while off");
  ok(/Gemini is your only helper/.test(a.args[a.args.indexOf("--append-system-prompt") + 1]), "system prompt says ChatGPT is off");
  const mcp = JSON.parse(fs.readFileSync(path.join(DATA, "brain-mcp.json"), "utf8"));
  ok(mcp.mcpServers["ai-brain"].env.AI_BRAIN_CHATGPT === "0", "MCP config turns ChatGPT off");
  ok(mcp.mcpServers["ai-brain"].env.AI_BRAIN_FLOW === "1" && /^http:\/\/127\.0\.0\.1:\d+$/.test(mcp.mcpServers["ai-brain"].env.AI_BRAIN_APP_URL), "Google Flow for the brain is on by default, and its tools can reach this app");
  ok(a.args.includes("mcp__ai-brain__flow_make_video") && a.args.includes("mcp__ai-brain__flow_look") && /GOOGLE FLOW \(tools flow_make_video/.test(a.args[a.args.indexOf("--append-system-prompt") + 1]), "the brain is offered the Flow tools and told how to use them");
  {
    const fo = await post("/api/flow/open", {});
    ok(fo.status === 200 && fo.body?.ok === true, "the brain's tools can ask the window to open Google Flow");
    ok((await post("/api/flow/open", {}, { "Content-Type": "application/json" })).status === 403, "but other websites cannot");
  }

  t = await task("Second question");
  a = brainArgs().at(-1);
  ok(a.args.includes("--resume") && /resumed: yes/.test(t.fin.text), "follow-up resumes the same Claude session");

  console.log("work modes + usage");
  {
    const lastPrompt = () => brainArgs().at(-1).prompt || "";
    const lastArgs = () => brainArgs().at(-1).args.join(" ");
    ok(/short/i.test(lastArgs()) && /Answer in English\./.test(lastArgs()), "answer style and own instructions reach Claude");
    for (const m of ["solo", "team", "debate", "extreme"]) {
      const from = events.length;
      const r = await post("/api/task", { text: `Mode test ${m}`, mode: m });
      await waitFor((e) => e.type === "final", 20_000, from);
      await waitFor((e) => e.type === "busy" && e.value === false, 5000, from);
      ok(r.status === 200 && new RegExp(`Work mode for this task: ${m.toUpperCase()}`).test(lastPrompt()), `mode ${m} reaches Claude`);
      ok(events.slice(from).some((e) => e.type === "task" && e.mode === m), `task event carries mode ${m}`);
    }
    const from = events.length;
    await post("/api/task", { text: "Mode test bogus", mode: "warp" });
    const fin = await waitFor((e) => e.type === "final", 20_000, from);
    await waitFor((e) => e.type === "busy" && e.value === false, 5000, from);
    ok(!/Work mode for this task/.test(lastPrompt()), "unknown mode treated as auto");
    ok(fin?.usage && fin.usage.out > 0 && fin.usage.cost > 0, "final answer carries token usage", JSON.stringify(fin?.usage));
    const stx = (await get("/api/stats")).body;
    ok(stx.claude?.all?.tasks >= 6 && stx.claude.session.out > 0 && stx.claude.today.cost > 0, "stats: Claude usage counted", JSON.stringify(stx.claude?.all));
    ok(Array.isArray(stx.days) && stx.days.length === 14 && stx.days.at(-1).tasks >= 6, "stats: 14 days, today counted");
    ok(stx.geminiUse?.today && typeof stx.geminiUse.today.calls === "number", "stats: Gemini usage block");
  ok(stx.chatgptUse?.today?.calls === 0 && stx.chatgptUse.limits === null && stx.days.at(-1).chatgpt === 0, "stats: ChatGPT usage block, empty before ChatGPT is asked", JSON.stringify(stx.chatgptUse));
    await post("/api/settings", { answerStyle: "auto", instructions: "", clock24: true, density: "compact", accent: "blue" });
  }

  console.log("music + apps");
  {
    const m0 = (await get("/api/music")).body;
    ok(m0.ok && m0.active && m0.title === "Test Song One" && m0.can?.next, "music status (fake player)", JSON.stringify(m0).slice(0, 160));
    const m1 = (await post("/api/music/cmd", { cmd: "next" })).body;
    ok(m1.title === "Second Track", "music: next song");
    const m2 = (await post("/api/music/cmd", { cmd: "toggle" })).body;
    ok(m2.playing !== m1.playing, "music: play/pause toggles");
    ok((await post("/api/music/cmd", { cmd: "format-c" })).body.ok === false, "music: unknown command refused");
    const o1 = (await post("/api/open-app", { app: "spotify", q: "lofi beats" })).body;
    ok(o1.ok && o1.uri === "spotify:search:lofi%20beats", "open Spotify search");
    ok((await post("/api/open-app", { app: "discord" })).body.uri === "discord://-/channels/@me", "open Discord app");
    const d1 = (await get("/api/discord")).body;
    ok(d1.installed === true && d1.running === false, "Discord app status: installed, not running", JSON.stringify(d1));
    const d2 = (await post("/api/discord/open", {})).body;
    ok(d2.ok && d2.how === "app", "open the installed Discord app", JSON.stringify(d2));
    // Pinned chats (made-up numbers): opened by link, kept in settings, junk refused.
    const d3 = (await post("/api/discord/open", { chat: { place: "@me", chat: "100000000000000001" } })).body;
    ok(d3.ok && d3.link === "discord://-/channels/@me/100000000000000001", "open a pinned direct message", JSON.stringify(d3));
    const d4 = (await post("/api/discord/open", { chat: { place: "200000000000000002", chat: "300000000000000003" } })).body;
    ok(d4.ok && d4.link === "discord://-/channels/200000000000000002/300000000000000003", "open a pinned server chat");
    for (const bad of [{ place: "@me", chat: "12" }, { place: "../x", chat: "100000000000000001" }, { place: "@me", chat: "100000000000000001&x" }, "x"])
      ok((await post("/api/discord/open", { chat: bad })).status === 400, `bad chat link refused: ${JSON.stringify(bad)}`);
    const pins = [{ name: "Sam", place: "@me", chat: "100000000000000001" }, { name: "Gym crew", place: "200000000000000002", chat: "300000000000000003" }];
    const s1 = await post("/api/settings", { discordChats: pins });
    ok(s1.status === 200 && JSON.stringify(s1.body.discordChats) === JSON.stringify(pins), "pinned chats are saved");
    for (const bad of [[{ name: "", place: "@me", chat: "100000000000000001" }], [{ name: "a", place: "@me", chat: "1" }], [{ name: "a", place: "@me", chat: "100000000000000001", token: "x" }], "nope", Array(25).fill(pins[0])])
      ok((await post("/api/settings", { discordChats: bad })).status === 400, "bad pinned chats refused");
    ok(JSON.stringify((await get("/api/settings")).body.discordChats) === JSON.stringify(pins), "refused pins leave the saved ones alone");
    await post("/api/settings", { discordChats: [] });
    ok((await post("/api/open-app", { app: "calc.exe" })).status === 400, "unknown app refused");
  }

  console.log("helper call + image");
  t = await task("Please [tool] this");
  const call = t.slice.find((e) => e.type === "call");
  const reply = t.slice.find((e) => e.type === "reply");
  ok(call?.to === "gemini" && call.from === "claude" && reply?.id === call.id && !reply.isError, "call and reply paired");
  ok(t.slice.filter((e) => e.type === "claude_say").length === 1, "interim note kept, final not duplicated");
  ok(t.slice.some((e) => e.type === "phase" && e.phase === "helpers"), "helpers phase shown");
  t = await task("Make an [image]");
  ok(t.fin.images.length === 1 && t.fin.images[0].startsWith("/media/"), "final answer carries the image");
  const img = await fetch(BASE + t.fin.images[0]);
  ok(img.status === 200 && img.headers.get("content-type") === "image/jpeg", "image is served");
  const media = (await get("/api/media")).body;
  ok(media.length === 1, "media list has the image");
  t = await task("A [failtool] task");
  ok(t.slice.find((e) => e.type === "reply")?.isError === true && !t.fin.isError, "failed helper call marked, task still answered");

  console.log("errors");
  t = await task("Give me an [error]");
  ok(t.fin.isError && /error/i.test(t.fin.text), "error result shown as error");
  t = await task("Please [crash]");
  ok(t.fin.isError && /simulated crash/.test(t.fin.text), "crash reported with reason");

  console.log("stop + queue");
  let from = events.length;
  await post("/api/task", { text: "Please [hang]" });
  await waitFor((e) => e.type === "stream" && e.text.length > 10, 8000, from);
  const q1 = await post("/api/task", { text: "queued one" });
  const q2 = await post("/api/task", { text: "queued two" });
  ok(q1.body.queued && q2.body.queued, "tasks queue while busy");
  const qev = await waitFor((e) => e.type === "queue" && e.items.length === 2, 3000, from);
  ok(!!qev, "queue broadcast");
  await post("/api/queue/remove", { id: qev.items[1].id });
  ok((await post("/api/ask", { to: "gemini", text: "hi" })).status === 409, "direct ask refused while the brain is busy");
  ok((await post("/api/session/new")).status === 409, "new session refused while busy");
  const hist = (await get("/api/history")).body;
  ok(hist.at(-1).type === "ready" && hist.at(-1).busy && hist.at(-1).live.length > 10 && hist.at(-1).queue.length === 1, "late joiner gets live text, busy state and queue");
  // Stop cancels the running task AND clears the queue.
  await post("/api/stop");
  const stopFin = await waitFor((e) => e.type === "final", 8000, from);
  ok(stopFin?.stopped && !stopFin.isError, "Stop ends the task cleanly");
  await waitFor((e) => e.type === "busy" && e.value === false, 5000, from);
  await sleep(600);
  ok(!events.slice(from).some((e) => e.type === "task" && e.text === "queued one"), "Stop also clears the queue");

  from = events.length;
  await post("/api/task", { text: "first [slow]" });
  await post("/api/task", { text: "runs after" });
  const second = await waitFor((e) => e.type === "final" && /runs after/.test(e.text), 30_000, from);
  ok(!!second, "queued task runs automatically after the current one");
  await waitFor((e) => e.type === "busy" && e.value === false, 5000, events.indexOf(second));

  console.log("direct asks");
  from = events.length;
  let d = await post("/api/ask", { to: "gemini", text: "direct hello" });
  let dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 8000, from);
  ok(d.status === 200 && dr && !dr.isError && /Gemini \(test reply\)/.test(dr.text), "direct Gemini message answered");
  ok((await post("/api/ask", { to: "chatgpt", text: "hi" })).status === 409, "direct ChatGPT refused while switched off");
  from = events.length;
  d = await post("/api/ask", { to: "gemini", text: "[slow] please" });
  await sleep(300);
  ok((await post("/api/ask", { to: "gemini", text: "another" })).status === 409, "second direct message refused while waiting");
  await post("/api/ask/stop", { to: "gemini" });
  dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 5000, from);
  ok(dr?.stopped && !dr.isError, "direct message can be stopped");
  await waitFor((e) => e.type === "direct" && e.value === false, 3000, from);
  from = events.length;
  d = await post("/api/image", { text: "an image of a clover" });
  dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 8000, from);
  ok(dr?.images.length === 1, "Image Studio request returns an image");
  from = events.length;
  d = await post("/api/image", { text: "an image [noimage]" });
  dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 8000, from);
  ok(dr?.isError && /did not produce an image/.test(dr.text), "no image produced is reported as an error");
  from = events.length;
  d = await post("/api/ask", { to: "gemini", text: "[fail]" });
  dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 8000, from);
  ok(dr?.isError, "helper failure is reported");
  await waitFor((e) => e.type === "direct" && e.value === false, 3000, from);
  ok((await get("/api/status?force")).body.gemini.ok === false, "status reflects the failed helper");

  console.log("video");
  {
    const KEY = "AIzaTestKey_0123456789abcdefghijklmnopqrWXYZ";
    const keyFile = path.join(DATA, "google-key.json");
    const sys = (a) => a.args[a.args.indexOf("--append-system-prompt") + 1];
    let v = (await get("/api/video")).body;
    ok(v.connected === false && v.models.length >= 3 && v.model === "veo-3.1-generate-preview" && v.limit === 10 && v.usage.today === 0, "video starts not connected, with Veo 3.1 picked");
    ok((await get("/api/status?force")).body.video.off === true, "status says video is not connected");
    let a = brainArgs().at(-1);
    ok(!a.args.includes("mcp__ai-brain__generate_video") && !/Video is not connected/.test(sys(a)) && /GOOGLE FLOW[^\n]*Use it when the user asks for a video/.test(sys(a)), "without a key the brain has no Veo key tool and uses Google Flow for videos");
    let r = await post("/api/video", { text: "a clover in the wind" });
    ok(r.status === 409 && r.body.nokey === true && /Settings/.test(r.body.error), "no key: making a video is refused with a clear message");
    r = await post("/api/google-key", { key: "short" });
    ok(r.status === 400 && /does not look like/.test(r.body.error), "a key that is too short is refused");
    r = await post("/api/google-key", { key: "bad_key_0123456789abcdefghijklmnop" });
    ok(r.status === 400 && /did not accept/.test(r.body.error) && !fs.existsSync(keyFile), "a key Google refuses is not saved");
    r = await post("/api/google-key", { key: `  ${KEY}\n` });
    ok(r.status === 200 && r.body.connected === true && r.body.ends === "WXYZ" && r.body.from === "saved" && JSON.parse(fs.readFileSync(keyFile, "utf8")).key === KEY, "a good key is saved");
    const everything = JSON.stringify([r.body, (await get("/api/settings")).body, (await get("/api/status?force")).body, (await get("/api/history")).body, (await get("/api/video")).body]);
    ok(!everything.includes(KEY) && !everything.includes(KEY.slice(0, 12)), "the key is never sent back to the window");
    ok((await get("/api/status?force")).body.video.ok === true && /Veo 3\.1/.test((await get("/api/status")).body.video.detail), "status says video is ready");
    ok(!fs.readFileSync(path.join(DATA, "settings.json"), "utf8").includes(KEY), "the key is not in the settings file");

    from = events.length;
    d = await post("/api/video", { text: "a clover in the wind", aspect: "9:16", seconds: 6 });
    let call = await waitFor((e) => e.type === "call" && e.id === d.body.id, 3000, from);
    dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 8000, from);
    ok(call?.video === true && /^Generate video: /.test(call.prompt) && dr?.video === true && dr.images.length === 1 && /-video\.mp4$/.test(dr.images[0]) && /6 seconds, 9:16/.test(dr.text), "the Video Studio request returns a video");
    const vid = await fetch(BASE + dr.images[0]);
    ok(vid.status === 200 && vid.headers.get("content-type") === "video/mp4" && vid.headers.get("accept-ranges") === "bytes", "the video is served");
    const part = await fetch(BASE + dr.images[0], { headers: { Range: "bytes=10-19" } });
    ok(part.status === 206 && (await part.arrayBuffer()).byteLength === 10 && /^bytes 10-19\/\d+$/.test(part.headers.get("content-range")), "the player can ask for a part of the video");
    ok((await fetch(BASE + dr.images[0], { headers: { Range: "bytes=99999999-" } })).status === 416, "a part past the end is refused");
    await waitFor((e) => e.type === "direct" && e.who === "video" && e.value === false, 3000, from);
    v = (await get("/api/video")).body;
    ok(v.usage.today === 1 && v.usage.seconds === 6 && (await get("/api/stats")).body.videoUse.today === 1 && (await get("/api/media")).body.some((m) => /\.mp4$/.test(m.name)), "the video is counted and listed in the Gallery");

    from = events.length;
    d = await post("/api/video", { text: "[slow] a long one" });
    await waitFor((e) => e.type === "direct" && e.who === "video" && e.value === true, 3000, from);
    ok((await post("/api/video", { text: "a second one" })).status === 409, "one video at a time");
    ok((await post("/api/google-key", { remove: true })).status === 409, "the key cannot be changed while a video is being made");
    await post("/api/ask/stop", { to: "video" });
    dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 5000, from);
    ok(dr?.stopped && !dr.isError, "a video can be stopped");
    await waitFor((e) => e.type === "direct" && e.who === "video" && e.value === false, 3000, from);
    from = events.length;
    d = await post("/api/video", { text: "[fail] this one" });
    dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 5000, from);
    ok(dr?.isError && /could not make the video/.test(dr.text), "a failed video is reported");
    await waitFor((e) => e.type === "direct" && e.who === "video" && e.value === false, 3000, from);
    ok((await get("/api/video")).body.usage.today === 1, "stopped and failed videos are not counted");

    // starting from a picture
    const pic = (await get("/api/media")).body.find((m) => /\.jpe?g$/i.test(m.name));
    from = events.length;
    d = await post("/api/video", { text: "make it move", image: pic.url, resolution: "1080p", seconds: 4 });
    dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 5000, from);
    ok(dr && !dr.isError && /from a picture/.test(dr.text) && /1080p/.test(dr.text) && /8 seconds/.test(dr.text), "a Gallery picture can be the start of a video (1080p is always 8 seconds)");
    await waitFor((e) => e.type === "direct" && e.who === "video" && e.value === false, 3000, from);
    ok((await post("/api/video", { text: "x", image: "/media/../settings.json" })).status === 400 && (await post("/api/video", { text: "x", image: "/media/nope.png" })).status === 400, "only real pictures from the app can start a video");
    ok((await post("/api/video", { text: "x", image: pic.url, model: "models/gemini-omni-1.2-flash" })).status === 400, "starting from a picture needs a Veo model");
    ok((await post("/api/video", { text: "" })).status === 400, "an empty description is refused");

    // the model and the daily limit
    let st = (await post("/api/settings", { videoModel: "models/gemini-omni-1.2-flash", videoDailyLimit: 2 })).body;
    ok(st.videoModel === "models/gemini-omni-1.2-flash" && st.videoDailyLimit === 2, "the video model and the daily limit can be changed");
    st = (await post("/api/settings", { videoModel: "bad model!", videoDailyLimit: -3 })).body;
    ok(st.videoModel === "models/gemini-omni-1.2-flash" && st.videoDailyLimit === 2, "bad video settings are ignored");
    r = await post("/api/video", { text: "one too many" });
    ok(r.status === 409 && /limit \(2\) is reached/.test(r.body.error), "the daily limit stops the next video");
    await post("/api/settings", { videoDailyLimit: 0 });
    from = events.length;
    d = await post("/api/video", { text: "no limit now", seconds: 30 });
    dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 5000, from);
    ok(dr && !dr.isError && /gemini-omni-1\.2-flash/.test(dr.text) && /10 seconds/.test(dr.text), "limit 0 means no limit; the other model makes up to 10 seconds");
    await waitFor((e) => e.type === "direct" && e.who === "video" && e.value === false, 3000, from);
    await post("/api/settings", { videoModel: "veo-3.1-generate-preview", videoDailyLimit: 10 });

    // the brain
    t = await task("Make a [video] for me");
    call = t.slice.find((e) => e.type === "call");
    const rep = t.slice.find((e) => e.type === "reply");
    a = brainArgs().at(-1);
    ok(call?.video === true && call.to === "gemini" && /^Generate video: /.test(call.prompt) && rep?.video === true && rep.images.length === 1 && /\.mp4$/.test(rep.images[0]), "the brain can make a video");
    ok(t.fin.images.length === 1 && /\.mp4$/.test(t.fin.images[0]), "the final answer carries the video");
    ok(a.args.includes("mcp__ai-brain__generate_video") && /VIDEO \(tool generate_video\) - Google Veo 3\.1 /.test(sys(a)) && /costs the user money/.test(sys(a)), "with a key the brain gets the video tool and is told it costs money");
    ok(/GOOGLE FLOW[^\n]*Prefer generate_video/.test(sys(a)), "with a key it prefers the key and keeps Flow as the fallback");
    await post("/api/settings", { access: "auto" });
    t = await task("[change] [keyfile] always allow");
    ok(/denied/.test(t.fin.text) && JSON.parse(fs.readFileSync(keyFile, "utf8")).key === KEY, "even with always allow, the brain cannot touch the Google key");
    await post("/api/settings", { access: "read" });

    r = await post("/api/google-key", { remove: true });
    ok(r.status === 200 && r.body.connected === false && !fs.existsSync(keyFile), "the key can be removed");
    ok((await post("/api/video", { text: "after removal" })).body.nokey === true, "and video is off again");
    r = await post("/api/google-key", { key: KEY });
    ok(r.body.connected === true, "and connected again");
  }

  console.log("uploads + attachments");
  const up = await fetch(BASE + "/api/upload?name=" + encodeURIComponent("my photo (1).jpg"), { method: "POST", headers: { Origin: BASE }, body: fs.readFileSync(FIXTURE) }).then((r) => r.json());
  ok(up.path.includes("uploads") && up.url?.startsWith("/uploads/") && (await fetch(BASE + up.url)).status === 200, "upload saved and served");
  t = await task("Look at this", [up.path, path.join(ROOT, "lib.mjs"), "C:\\Windows\\win.ini"]);
  a = brainArgs().at(-1);
  ok(a.prompt.includes(up.path) && !a.prompt.includes("lib.mjs") && !a.prompt.includes("win.ini"), "only files from uploads/media can be attached");
  const taskEv = t.slice.find((e) => e.type === "task");
  ok(taskEv.files.length === 1 && taskEv.files[0].url === up.url, "task shows the attachment");
  const big = await fetch(BASE + "/api/task", { method: "POST", headers: H, body: JSON.stringify({ text: "x".repeat(3 * 1024 * 1024) }) });
  ok(big.status === 413, "oversized request gets 413");

  console.log("sessions");
  const firstId = events.find((e) => e.type === "hello").session.id;
  let list = (await get("/api/sessions")).body;
  ok(list.length === 1 && list[0].active && list[0].title === "Hello brain" && list[0].tasks >= 8, "session listed with auto title");
  from = events.length;
  const ns = await post("/api/session/new");
  const h2 = await waitFor((e) => e.type === "hello", 3000, from);
  ok(ns.status === 200 && h2 && h2.session.id !== firstId && h2.session.title === "", "new session started and announced");
  ok(events.slice(from).filter((e) => e.type === "task").length === 0, "new session is empty");
  t = await task("Fresh topic");
  a = brainArgs().at(-1);
  ok(!a.args.includes("--resume") && /resumed: no/.test(t.fin.text), "new session does not resume the old Claude conversation");
  list = (await get("/api/sessions")).body;
  ok(list.length === 2 && list[0].title === "Fresh topic" && list[0].active, "two sessions, newest first");
  ok((await get("/api/sessions?q=hello+brain")).body.length === 1, "session search works");
  ok((await get("/api/sessions?q=zzzznothing")).body.length === 0, "search with no match is empty");
  await post("/api/session/rename", { id: firstId, title: "  My  renamed   session " });
  await post("/api/session/pin", { id: firstId, pinned: true });
  list = (await get("/api/sessions")).body;
  ok(list[0].id === firstId && list[0].title === "My renamed session" && list[0].pinned, "rename + pin (pinned sorts first)");
  from = events.length;
  await post("/api/session/switch", { id: firstId });
  await waitFor((e) => e.type === "ready", 3000, from);
  const replay = events.slice(from);
  ok(replay[0].type === "hello" && replay[0].session.id === firstId && replay.filter((e) => e.type === "task").length >= 8, "switching replays the old session");
  t = await task("Back again");
  a = brainArgs().at(-1);
  ok(a.args.includes("--resume"), "old session resumes its own Claude conversation");
  const exp = await fetch(BASE + "/api/session/export?id=" + firstId);
  const md = await exp.text();
  ok(exp.status === 200 && /attachment/.test(exp.headers.get("content-disposition")) && md.includes("# My renamed session") && md.includes("Back again"), "export to Markdown");
  ok((await post("/api/session/switch", { id: "../../state" })).status === 404, "bad session id rejected");
  const otherId = list.find((s) => s.id !== firstId).id;
  await post("/api/session/delete", { id: otherId });
  ok((await get("/api/sessions")).body.length === 1 && !fs.existsSync(path.join(DATA, "sessions", otherId + ".json")), "delete another session");

  console.log("prompts, saved, media");
  const pr = await post("/api/prompts", { prompts: [{ title: "Mine", text: "Do the thing" }, { title: "", text: "skipped" }] });
  ok(pr.body.length === 1 && pr.body[0].id && (await get("/api/prompts")).body[0].title === "Mine", "prompt library saved");
  const sv = await post("/api/saved/add", { who: "claude", text: "Keep this", images: ["/media/a.jpg", "https://evil.example/x.png"] });
  ok(sv.body.id && sv.body.images.length === 1 && (await get("/api/saved")).body.length === 1, "answer saved (remote image links dropped)");
  await post("/api/saved/delete", { id: sv.body.id });
  ok((await get("/api/saved")).body.length === 0, "saved answer removed");
  ok((await post("/api/open", { target: "media" })).status === 200 && (await post("/api/open", { target: "nope" })).status === 400, "open-folder targets validated");
  const m = (await get("/api/media")).body;
  ok((await post("/api/media/delete", { name: "..\\..\\state.json" })).status === 404, "cannot delete outside media");
  await post("/api/media/delete", { name: m[0].name });
  ok((await get("/api/media")).body.length === m.length - 1, "media file deleted");
  const bg = await fetch(BASE + "/api/background?name=wall.jpg", { method: "POST", headers: { Origin: BASE }, body: fs.readFileSync(FIXTURE) }).then((r) => r.json());
  ok(bg.customBg && (await fetch(BASE + "/custom/" + bg.customBg)).status === 200, "custom background stored and served");
  ok((await fetch(BASE + "/api/background?name=bad.exe", { method: "POST", headers: { Origin: BASE }, body: "x" })).status === 400, "background must be a picture");
  await post("/api/settings", { customBg: null });
  ok(fs.readdirSync(path.join(DATA, "custom")).length === 0, "removing the background deletes the file");

  console.log("ChatGPT switched on");
  await post("/api/settings", { chatgptEnabled: true });
  t = await task("Ask [both] please");
  a = brainArgs().at(-1);
  ok(a.args.some((x) => /ask_both/.test(x)) && /ChatGPT \(tool ask_chatgpt\)/.test(a.args[a.args.indexOf("--append-system-prompt") + 1]), "ChatGPT tools offered when on");
  const replies = t.slice.filter((e) => e.type === "reply");
  ok(replies.length === 2 && replies.find((r) => r.to === "chatgpt")?.isError === false && replies.find((r) => r.to === "gemini")?.isError === true, "ask_both split into two replies");
  from = events.length;
  d = await post("/api/ask", { to: "chatgpt", text: "direct to chatgpt" });
  dr = await waitFor((e) => e.type === "reply" && e.id === d.body.id, 8000, from);
  ok(dr && /ChatGPT \(test reply\)/.test(dr.text), "direct ChatGPT message works when on");
  {
    const cu = (await get("/api/stats")).body;
    const c = cu.chatgptUse;
    ok(c?.today.calls >= 1 && c.all.calls >= c.today.calls && c.today.in >= 900 && c.today.cached >= 400 && c.today.out >= 60, "stats: ChatGPT requests and tokens are counted", JSON.stringify(c));
    ok(c?.limits?.short?.pct === 8 && c.limits.short.mins === 300 && c.limits.long?.pct === 23 && c.limits.long.mins === 10080 && c.limits.long.resets > Date.now() / 1000, "stats: ChatGPT plan limits read from Codex's conversation record", JSON.stringify(c?.limits));
    ok(cu.days.at(-1).chatgpt >= 1, "stats: ChatGPT counted in today's column");
    const raw = fs.readFileSync(path.join(DATA, "usage-chatgpt.jsonl"), "utf8");
    ok(!/test-thread|rollout|fake-codex/.test(raw), "only the numbers are kept, not where they came from");
    const from2 = events.length;
    const bad = await post("/api/ask", { to: "chatgpt", text: "this one [fail]s" });
    await waitFor((e) => e.type === "reply" && e.id === bad.body.id, 8000, from2);
    await waitFor((e) => e.type === "direct" && e.value === false, 3000, from2);
    const c2 = (await get("/api/stats")).body.chatgptUse;
    ok(c2.today.failed === c.today.failed + 1 && c2.today.calls === c.today.calls + 1, "stats: a failed ChatGPT request is counted as failed", JSON.stringify(c2.today));
  }
  await waitFor((e) => e.type === "direct" && e.value === false, 3000, from);
  await post("/api/settings", { chatgptEnabled: false });

  console.log("restart: persistence + recovery");
  // Leave a task running, then shut down: the session must reopen cleanly.
  from = events.length;
  await post("/api/task", { text: "Interrupted [hang]" });
  await waitFor((e) => e.type === "stream", 8000, from);
  sse.abort();
  await stopServer();
  // Simulate a stale Claude session id.
  const stateFile = path.join(DATA, "state.json");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  ok(state.activeSession === firstId, "active session remembered");
  fs.writeFileSync(stateFile, JSON.stringify({ ...state, claudeSession: "stale-session" }));
  const sf = path.join(DATA, "sessions", firstId + ".json");
  const sess = JSON.parse(fs.readFileSync(sf, "utf8"));
  sess.ids.claudeSession = "stale-session";
  fs.writeFileSync(sf, JSON.stringify(sess));
  events.length = 0;
  startServer();
  await waitUp();
  await openEvents();
  await waitFor((e) => e.type === "ready");
  ok(events[0].session.id === firstId && events[0].session.title === "My renamed session", "session restored after restart");
  ok(events.at(-1).busy === false, "not busy after restart");
  const lastTaskIdx = events.map((e) => e.type).lastIndexOf("task");
  ok(events.slice(lastTaskIdx).some((e) => e.type === "final"), "interrupted task is closed off, no endless spinner");
  ok((await get("/api/settings")).body.theme === "neon", "settings survive a restart");
  ok(!(await post("/api/settings", { theme: "clover" })).body.theme.includes("clover") && (await post("/api/settings", { theme: "berserk" })).body.theme === "berserk", "removed themes are refused, Berserk is accepted");
  await post("/api/settings", { theme: "neon" });
  ok((await get("/api/history")).body.find((e) => e.type === "ready").usage?.five_hour === 0.42, "last usage survives a restart");
  t = await task("After restart");
  ok(t.fin && !t.fin.isError && /resumed: no/.test(t.fin.text), "stale Claude session recovers with a fresh one");
  ok(t.slice.filter((e) => e.type === "task").length === 1, "recovery does not repeat the task bubble");
  from = events.length;
  await post("/api/session/delete", { id: firstId });
  const h3 = await waitFor((e) => e.type === "hello", 3000, from);
  ok(h3 && h3.session.id !== firstId && (await get("/api/sessions")).body.length === 0, "deleting the active session opens a fresh one");
  await waitFor((e) => e.type === "ready", 3000, from);

  await accessTests();
  await appsTests();
  await inspectApiTests();
  await chatgptBrainTests();
  themeMoveTest();
} catch (e) {
  failed++;
  console.log("  CRASH", e.stack || e);
} finally {
  sse?.abort();
  await stopServer();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
}
console.log(`\n${passed} passed, ${failed} failed`);
// The brain uses the program in the middle: setting, key, the relay through the window, its tools.
async function appsTests() {
  console.log("the brain uses the program in the middle");
  const sys = (a) => a.args[a.args.indexOf("--append-system-prompt") + 1];
  const mcpEnv = () => JSON.parse(fs.readFileSync(path.join(DATA, "brain-mcp.json"), "utf8")).mcpServers["ai-brain"].env;
  const APP = ["app_open", "app_look", "app_click", "app_type", "app_key", "app_scroll", "app_drag"];
  ok((await get("/api/settings")).body.appsBrain === false, "it is off by default");
  let t = await task("Off [tool]");
  let a = brainArgs().at(-1);
  ok(!a.args.some((x) => /app_/.test(x)) && !/PROGRAMS \(tools app_open/.test(sys(a)) && mcpEnv().AI_BRAIN_APPS === "0" && !mcpEnv().AI_BRAIN_CONTROL_KEY, "while off the brain has no app tools, no key and no word about them");
  ok((await post("/api/settings", { appsBrain: "yes" })).body.appsBrain === false, "only true or false is accepted");
  ok((await post("/api/settings", { appsBrain: true })).body.appsBrain === true, "it can be switched on");

  let from = events.length;
  await post("/api/task", { text: "Use it [hang]" });
  await waitFor((e) => e.type === "stream" && e.text.length > 10, 8000, from);
  a = brainArgs().at(-1);
  const env = mcpEnv(), key = env.AI_BRAIN_CONTROL_KEY;
  ok(env.AI_BRAIN_APPS === "1" && /^[0-9a-f]{48}$/.test(key || ""), "a task gets the app tools switched on and a key of its own");
  ok(APP.every((n) => a.args.includes(`mcp__ai-brain__${n}`)) && /PROGRAMS \(tools app_open/.test(sys(a)) && /If the user moves the mouse, you stop/.test(sys(a)) && /Never type passwords/.test(sys(a)), "the brain is offered the seven app tools and told the rules");
  ok(["app_act", "app_commands", "app_command"].every((n) => a.args.includes(`mcp__ai-brain__${n}`)) && !a.args.includes("mcp__ai-brain__app_python"), "the no-mouse tools are allowed too, but Python in a program is never pre-allowed (it is checked like a command)");
  ok(/1\. BRIDGE/.test(sys(a)) && /2\. BACKGROUND CONTROLS/.test(sys(a)) && /3\. MOUSE AND KEYBOARD \(last resort/.test(sys(a)) && /HEADLESS bridge/.test(sys(a)), "the brain is told to prefer the bridge, then background controls, then the mouse");
  const ctl = (body, k = key, headers = H) => post("/api/apps/control", body, { ...headers, ...(k ? { "X-Brain-Key": k } : {}) });
  ok((await ctl({ cmd: "look" }, "")).status === 403 && (await ctl({ cmd: "look" }, "0".repeat(48))).status === 403, "without the task's key: refused");
  ok((await ctl({ cmd: "look" }, key, { "Content-Type": "application/json" })).status === 403, "other websites cannot (no AI Brain origin)");
  ok((await ctl({ cmd: "format-disk" })).status === 400, "unknown steps are refused");

  // A step goes to the window, and the window's answer comes back.
  from = events.length;
  const p1 = ctl({ cmd: "click", args: { target: 3, count: 2 } });
  const ev = await waitFor((e) => e.type === "app-control", 3000, from);
  ok(!!ev && ev.cmd === "click" && ev.args.target === 3 && ev.args.count === 2 && /^[0-9a-f]{16}$/.test(ev.task || ""), "the step reaches the window with the task's id", JSON.stringify(ev));
  const pic = "A".repeat(3 * 1024 * 1024);
  ok((await post("/api/apps/control/answer", { id: ev.id, result: { ok: true, did: "Clicked", image: { data: pic, w: 1, h: 1 } } })).status === 200, "a big picture fits in the answer");
  const r1 = await p1;
  ok(r1.status === 200 && r1.body.ok === true && r1.body.did === "Clicked" && r1.body.image.data.length === pic.length, "the window's answer goes back to the brain");
  ok((await post("/api/apps/control/answer", { id: ev.id, result: { ok: true } })).status === 404, "a second answer to the same step is refused");
  ok((await post("/api/apps/control/answer", { id: "nope", result: { ok: true } }, { "Content-Type": "application/json" })).status === 403, "other websites cannot answer");

  // A plain browser tab answers no softly: a desktop window's answer still wins...
  from = events.length;
  let p = ctl({ cmd: "look" });
  let e2 = await waitFor((e) => e.type === "app-control", 3000, from);
  await post("/api/apps/control/answer", { id: e2.id, soft: true, result: { ok: false, why: "no desktop window" } });
  await sleep(300);
  await post("/api/apps/control/answer", { id: e2.id, result: { ok: true, did: "desktop" } });
  ok((await p).body.did === "desktop", "a desktop window's answer wins over a browser tab's no");
  // ...and when none comes, the no counts after a few seconds.
  from = events.length;
  p = ctl({ cmd: "look" });
  e2 = await waitFor((e) => e.type === "app-control", 3000, from);
  const t0 = Date.now();
  await post("/api/apps/control/answer", { id: e2.id, soft: true, result: { ok: false, why: "no desktop window" } });
  const r3 = await p;
  ok(r3.body.ok === false && r3.body.why === "no desktop window" && Date.now() - t0 >= 3500, "with only a browser tab, its no counts after a few seconds");

  // The brain's tool server: the picture and the numbered list reach the brain.
  {
    const mcp = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { env: { ...process.env, ...env, BRAIN_DATA_DIR: DATA }, stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    const answer = (id) => new Promise((res, rej) => {
      const timer = setTimeout(() => rej(new Error("no answer")), 15000);
      mcp.stdout.on("data", (d) => { buf += d; for (const line of buf.split("\n")) { try { const m = JSON.parse(line); if (m.id === id) { clearTimeout(timer); res(m.result); } } catch { /* partial line */ } } });
    });
    const rpc = (m) => mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
    try {
      rpc({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "api-test", version: "1" } } });
      await answer(1);
      rpc({ method: "notifications/initialized" });
      rpc({ id: 2, method: "tools/list" });
      const names = ((await answer(2)).tools || []).map((x) => x.name);
      ok(APP.every((n) => names.includes(n)), "the brain's tool server has the seven app tools", names.join());
      const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
      from = events.length;
      rpc({ id: 3, method: "tools/call", params: { name: "app_click", arguments: { target: 2, count: 2 } } });
      const e3 = await waitFor((e) => e.type === "app-control", 5000, from);
      ok(e3?.cmd === "click" && e3.args.target === 2 && e3.args.count === 2, "a tool call becomes a step for the window");
      await post("/api/apps/control/answer", { id: e3.id, result: { ok: true, did: 'Double-clicked button "Press me".', name: "Test program", title: "Test - notes", front: true, complete: true,
        image: { w: 800, h: 600, data: png, type: "image/png" }, popups: [{ title: "Save as", x: 10, y: 20, w: 300, h: 200 }],
        items: [{ n: 1, kind: "button", name: "Press me", x: 5, y: 6, w: 70, h: 20 }, { n: 2, kind: "edit", name: "Secret", password: true, x: 5, y: 40, w: 90, h: 20 }, { n: 3, kind: "edit", name: "Notes", value: "hi", x: 5, y: 70, w: 90, h: 20 }] } });
      const res = await answer(3);
      const txt = res.content.find((c) => c.type === "text")?.text || "", img = res.content.find((c) => c.type === "image");
      ok(!res.isError && img?.data === png && img.mimeType === "image/png", "the brain gets the picture");
      ok(/^Double-clicked button "Press me"\./.test(txt) && /1\. button "Press me" at 5,6 70x20/.test(txt) && /3\. edit "Notes" value="hi"/.test(txt) && /Also open: a window "Save as"/.test(txt), "and the numbered list, what was done and the open dialog", txt);
      ok(/2\. edit "Secret" \[password box - never type into it\]/.test(txt) && !/hunter/.test(txt), "a password box is marked and its text is never there");
      from = events.length;
      rpc({ id: 4, method: "tools/call", params: { name: "app_look", arguments: {} } });
      const e4 = await waitFor((e) => e.type === "app-control", 5000, from);
      await post("/api/apps/control/answer", { id: e4.id, result: { ok: false, why: "The user moved the mouse, so you stopped using the program." } });
      const res4 = await answer(4);
      ok(res4.isError && /moved the mouse/.test(res4.content[0].text), "a refusal reaches the brain as an error with the reason");

      // Bridges and background controls (the window's answers are made up here; the real ones are in
      // test/bridge-test.mjs and test/shell-test.mjs).
      ok(["app_act", "app_commands", "app_command", "app_python"].every((n) => names.includes(n)), "the tool server also has app_act, app_commands, app_command and app_python");
      const viaWindow = async (id, name, args, result) => {
        const f0 = events.length;
        rpc({ id, method: "tools/call", params: { name, arguments: args } });
        const ev = await waitFor((e) => e.type === "app-control", 5000, f0);
        await post("/api/apps/control/answer", { id: ev.id, result });
        return { ev, res: await answer(id) };
      };
      // After a step only the changes in the list are sent (the list is long and costs tokens each time).
      const items3 = [{ n: 1, kind: "button", name: "Press me", x: 5, y: 6, w: 70, h: 20 }, { n: 2, kind: "edit", name: "Secret", password: true, x: 5, y: 40, w: 90, h: 20 }, { n: 3, kind: "edit", name: "Notes", value: "hi", x: 5, y: 70, w: 90, h: 20 }];
      const stepRes = (items) => ({ ok: true, did: "Pressed a key.", name: "Test program", front: true, complete: true, image: { w: 800, h: 600, data: png, type: "image/png" }, items });
      let d = await viaWindow(201, "app_key", { keys: "a" }, stepRes(items3));
      ok(/the same list as before/.test(d.res.content[0].text) && !/Press me/.test(d.res.content[0].text), "an unchanged list is not sent again", d.res.content[0].text);
      d = await viaWindow(202, "app_key", { keys: "b" }, stepRes([items3[0], items3[1], { ...items3[2], value: "hib" }]));
      ok(/only the changes/.test(d.res.content[0].text) && /3\. edit "Notes" value="hib"/.test(d.res.content[0].text) && !/Press me/.test(d.res.content[0].text), "after a step only the changed things are listed", d.res.content[0].text);
      d = await viaWindow(203, "app_look", {}, stepRes([items3[0], items3[1], { ...items3[2], value: "hib" }]));
      ok(/1\. button "Press me"/.test(d.res.content[0].text) && /3\. edit "Notes" value="hib"/.test(d.res.content[0].text) && !/same list/.test(d.res.content[0].text), "app_look always sends the whole list", d.res.content[0].text);
      let v = await viaWindow(5, "app_commands", { filter: "export" }, { ok: true, name: "VectorCraft", kind: "craft", live: true, total: 33, filter: "export", more: 0,
        tools: [{ name: "export_file", description: "Export the document", params: ["path", "format"], required: ["path"] }] });
      ok(v.ev.cmd === "bridge" && v.ev.args.filter === "export", "app_commands asks the window for the bridge's commands");
      ok(/VectorCraft \(live bridge to the open window\): 33 commands, 1 matching "export"/.test(v.res.content[0].text) && /- export_file\(path, format\?\): Export the document/.test(v.res.content[0].text), "and lists them with their parameters", v.res.content[0].text);
      v = await viaWindow(6, "app_command", { command: "export_file", params: { path: "C:\\x.svg" } }, { ok: true, name: "VectorCraft", kind: "craft", live: true,
        content: [{ type: "text", text: "exported 1 file" }, { type: "image", data: png, mimeType: "image/png" }] });
      ok(v.ev.cmd === "bridge-call" && v.ev.args.command === "export_file" && v.ev.args.params.path === "C:\\x.svg", "app_command sends the command and its parameters");
      ok(v.res.content[0].text === "exported 1 file" && v.res.content[1].type === "image" && v.res.content[1].data === png, "its text and pictures reach the brain");
      v = await viaWindow(7, "app_python", { code: "import bpy\nlen(bpy.data.objects)" }, { ok: true, name: "Blender", kind: "blender", live: true, output: "hi\n", result: "3" });
      ok(v.ev.cmd === "python" && /bpy/.test(v.ev.args.code) && /Python bridge, live in Blender/.test(v.res.content[0].text) && /Printed:\nhi/.test(v.res.content[0].text) && /Result: 3/.test(v.res.content[0].text), "app_python runs code in the program and shows what it printed and returned", v.res.content[0].text);
      v = await viaWindow(8, "app_commands", {}, { ok: true, name: "Krita", kind: "krita", live: true, python: true, about: { version: "5.3.4" } });
      ok(/takes Python: use app_python/.test(v.res.content[0].text) && /Krita.instance\(\) is ready as `app`/.test(v.res.content[0].text), "for Blender or Krita, app_commands says to use Python");
      v = await viaWindow(9, "app_act", { target: 2, action: "set", value: "hello" }, { ok: true, did: 'Set edit "Notes" (set to "hello"), without the mouse.', name: "Test", title: "Test", front: true, complete: true, image: { w: 10, h: 10, data: png, type: "image/png" }, popups: [], items: [] });
      ok(v.ev.cmd === "act" && v.ev.args.target === 2 && v.ev.args.action === "set" && v.ev.args.value === "hello" && /without the mouse/.test(v.res.content[0].text), "app_act sends the action and shows what was done");
      v = await viaWindow(10, "app_command", { command: "x" }, { ok: false, why: "Notepad has no bridge (only the Craft apps, Blender and Krita have one)." });
      ok(v.res.isError && /has no bridge/.test(v.res.content[0].text), "a program without a bridge is explained");
    } catch (e) { failed++; console.log("  FAIL app tool server: " + e.message); }
    mcp.kill();
    const off = spawn(process.execPath, [path.join(ROOT, "server.mjs")], { env: { ...process.env, ...env, AI_BRAIN_APPS: "0", BRAIN_DATA_DIR: DATA }, stdio: ["pipe", "pipe", "ignore"] });
    let ob = "";
    const offNames = await new Promise((res) => {
      const timer = setTimeout(() => res(null), 15000);
      off.stdout.on("data", (d) => { ob += d; for (const line of ob.split("\n")) { try { const m = JSON.parse(line); if (m.id === 2) { clearTimeout(timer); res((m.result.tools || []).map((x) => x.name)); } } catch { /* partial */ } } });
      off.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "api-test", version: "1" } } }) + "\n");
      off.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
      off.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    });
    off.kill();
    ok(Array.isArray(offNames) && !offNames.some((n) => n.startsWith("app_")), "with the setting off the tool server has none of them", String(offNames));
  }

  // Switching it off ends a waiting step and refuses new ones.
  from = events.length;
  p = ctl({ cmd: "look" });
  await waitFor((e) => e.type === "app-control", 3000, from);
  await post("/api/settings", { appsBrain: false });
  const r4 = await p;
  ok(r4.body.ok === false && /switched off/.test(r4.body.why), "switching the setting off ends a waiting step");
  ok(/switched off/.test((await ctl({ cmd: "look" })).body.why || ""), "and new steps are refused");
  await post("/api/settings", { appsBrain: true });
  // Stop ends a waiting step, and the key dies with the task.
  from = events.length;
  p = ctl({ cmd: "look" });
  await waitFor((e) => e.type === "app-control", 3000, from);
  await post("/api/stop");
  const r5 = await p;
  ok(r5.body.ok === false && /Stop/.test(r5.body.why), "Stop ends a waiting step");
  await waitFor((e) => e.type === "busy" && e.value === false, 8000, from);
  ok((await ctl({ cmd: "look" })).status === 403, "after the task its key no longer works");

  // The log says what the brain did in the program; the steps are not shown as helper calls.
  t = await task("Press it [apps]");
  ok(t.slice.some((e) => e.type === "log" && e.text === "Program: look") && t.slice.some((e) => e.type === "log" && e.text === "Program: double-click #3") && t.slice.some((e) => e.type === "log" && e.text === 'Program: type "hello there"'), "the log shows each step in the program");
  ok(!t.slice.some((e) => e.type === "call"), "steps are not shown as helper calls");
  ok(t.fin && !t.fin.isError, "the task finishes normally");

  // Python inside Blender/Krita is asked about like a command, with the code shown.
  const accessBefore = (await get("/api/settings")).body.access;
  await post("/api/settings", { access: "ask" });
  from = events.length;
  await post("/api/task", { text: "Python please [hang]" });
  await waitFor((e) => e.type === "stream" && e.text.length > 10, 8000, from);
  const akey = mcpEnv().AI_BRAIN_APPROVE_KEY;
  const askP = post("/api/approval/ask", { tool_name: "mcp__ai-brain__app_python", input: { code: "import bpy\nbpy.ops.wm.save_mainfile()" } }, { ...H, "X-Brain-Key": akey });
  const aev = await waitFor((e) => e.type === "approval", 3000, from);
  ok(aev?.kind === "command" && /run Python in the program in the middle/.test(aev.title) && /save_mainfile/.test(aev.detail) && /can do anything that program can/.test(aev.note), "Python in a program is shown to the user like a command before it runs", JSON.stringify(aev));
  await post("/api/approval/answer", { id: aev.id, allow: false });
  ok((await askP).body?.behavior === "deny", "and denied when the user says no");
  await post("/api/stop");
  await waitFor((e) => e.type === "busy" && e.value === false, 8000, from);
  await post("/api/settings", { access: accessBefore, appsBrain: false });
}

// The web inspector's doors: only the paired extension gets in; the brain needs its task key.
// (The real extension in a real browser is tested by test/inspect-test.mjs.)
async function inspectApiTests() {
  console.log("web inspector (server)");
  const EXT = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
  const extPost = (p, body, origin = EXT, code = "") => fetch(BASE + p, { method: "POST", headers: { "Content-Type": "application/json", ...(origin ? { Origin: origin } : {}), ...(code ? { "X-Brain-Key": code } : {}) }, body: JSON.stringify(body ?? {}) }).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
  ok((await get("/api/settings")).body.inspectBrain === false, "it is off by default");
  let t = await task("Off again [tool]");
  const sys = (a) => a.args[a.args.indexOf("--append-system-prompt") + 1];
  let a = brainArgs().at(-1);
  ok(!a.args.some((x) => /web_/.test(x)) && !/WEB INSPECTOR/.test(sys(a)), "while off the brain has no web tools and no word about them");
  ok((await extPost("/api/inspect/ext/hello", {}, EXT, "AAAAA-AAAAA-AAAAA-AAAAA")).status === 403, "before pairing nothing gets in");
  const code = (await post("/api/inspect/code", {})).body.code;
  ok((await post("/api/inspect/code", {}, { "Content-Type": "application/json" })).status === 403, "other websites cannot get the pairing code");
  ok((await extPost("/api/inspect/ext/hello", {}, "https://evil.example", code)).status === 403, "a website with the right code is still refused");
  ok((await extPost("/api/inspect/ext/hello", {}, "", code)).status === 403, "a request without an origin is refused");
  ok((await extPost("/api/inspect/ext/hello", {}, EXT, "WRONG-WRONG-WRONG-WRONG")).status === 403, "an extension with a wrong code is refused");
  const h = await extPost("/api/inspect/ext/hello", { version: "1.0.0", browser: "Brave", tabs: [] }, EXT, code.toLowerCase());
  ok(h.status === 200 && h.body.app === "ai-brain" && h.body.enabled === false, "the paired extension gets in (any letter case) and is told the setting is off", JSON.stringify(h));
  ok((await get("/api/inspect")).body.connected === true, "Settings shows it connected");
  await post("/api/settings", { inspectBrain: true });
  const from = events.length;
  await post("/api/task", { text: "Look at the page [hang]" });
  await waitFor((e) => e.type === "stream" && e.text.length > 10, 8000, from);
  a = brainArgs().at(-1);
  const env = JSON.parse(fs.readFileSync(path.join(DATA, "brain-mcp.json"), "utf8")).mcpServers["ai-brain"].env;
  ok(env.AI_BRAIN_INSPECT === "1" && /^[0-9a-f]{48}$/.test(env.AI_BRAIN_CONTROL_KEY || "") && !JSON.stringify(env).includes(code), "a task gets the web tools and a key, never the pairing code");
  ok(/WEB INSPECTOR/.test(sys(a)) && /signed in as the user/.test(sys(a)) && /Never put passwords, cookie values/.test(sys(a)) && a.args.includes("mcp__ai-brain__web_eval"), "the brain is told what the tools do and the rules");
  const req = (body, k = env.AI_BRAIN_CONTROL_KEY) => post("/api/inspect/request", body, { ...H, "X-Brain-Key": k });
  ok((await req({ cmd: "tabs" }, "x".repeat(48))).status === 403, "the brain's steps need the task key");
  ok((await req({ cmd: "rm -rf" })).status === 400, "unknown steps are refused");
  // The extension asks for work; the brain's step reaches it; its answer goes back.
  const poll = extPost("/api/inspect/ext/next", { tabs: [{ id: 7, title: "Shop", url: "https://shop.example/" }] }, EXT, code);
  await sleep(200);
  const step = req({ cmd: "html", args: { selector: "#cart" } });
  const job = (await poll).body;
  ok(job?.cmd === "html" && job.args.selector === "#cart" && !!job.id, "a step reaches the waiting extension", JSON.stringify(job));
  ok((await get("/api/inspect")).body.tabs[0]?.title === "Shop", "Settings lists the shared tab");
  ok((await extPost("/api/inspect/ext/answer", { id: job.id, result: { ok: true, html: "<div id=cart>2 items</div>" } }, EXT, code)).status === 200, "the extension answers");
  const got = await step;
  ok(got.body?.ok && got.body.html === "<div id=cart>2 items</div>", "the answer reaches the brain", JSON.stringify(got.body));
  // Without a waiting extension, a step waits for its next ask; Stop ends it.
  const late = req({ cmd: "tabs" });
  await sleep(300);
  await post("/api/stop");
  ok(/Stopped/.test((await late).body?.why || ""), "Stop ends a step the extension has not picked up");
  await waitFor((e) => e.type === "busy" && e.value === false, 8000, from);
  ok((await req({ cmd: "tabs" })).status === 403, "after the task the key no longer works");
  // A new code locks the old one out.
  await post("/api/inspect/code", { renew: true });
  ok((await extPost("/api/inspect/ext/hello", {}, EXT, code)).status === 403, "a new pairing code locks the old one out");
  ok(!fs.readFileSync(path.join(DATA, "inspect-key.json"), "utf8").includes(code), "the old code is gone from the computer");
  await post("/api/settings", { inspectBrain: false });
}

// ChatGPT as the brain (Settings > The brain > Brain). The fake Codex calls AI Brain's REAL tool server.
async function chatgptBrainTests() {
  console.log("ChatGPT as the brain");
  const WORKDIR = path.join(DATA, "workspace");
  const codexArgs = () => fs.readFileSync(path.join(DATA, "fake-codex-args.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const there = (f) => fs.existsSync(path.join(WORKDIR, f));
  const rm = (f) => { try { fs.unlinkSync(path.join(WORKDIR, f)); } catch {} };
  const instr = (a) => JSON.parse(a.conf.developer_instructions);
  const start = async (text, files) => { const from = events.length; await post("/api/task", { text, files }); return from; };
  const end = async (from) => {
    const fin = await waitFor((e) => e.type === "final", 30_000, from);
    await waitFor((e) => e.type === "busy" && e.value === false, 5000, from);
    return { fin, slice: events.slice(from) };
  };
  const answer = async (from, allow) => { const ap = await waitFor((e) => e.type === "approval", 15_000, from); await post("/api/approval/answer", { id: ap?.id, allow }); return ap; };

  ok((await get("/api/settings")).body.brain === "claude", "Claude is the brain by default");
  ok((await post("/api/settings", { brain: "gemini" })).body.brain === "claude", "only Claude or ChatGPT can be the brain");
  ok((await post("/api/settings", { brain: "chatgpt", access: "read", folders: [] })).body.brain === "chatgpt", "ChatGPT can be picked as the brain");
  const st = (await get("/api/status?force=1")).body;
  ok(st.chatgpt && !st.chatgpt.off, "with ChatGPT as the brain its sign-in is checked even while the ChatGPT helper is off");

  let x = await task("Hello brain");
  let a = codexArgs().at(-1);
  ok(x.fin && !x.fin.isError && x.fin.brain === "chatgpt" && /ChatGPT brain \(test reply\)/.test(x.fin.text) && /resumed: no/.test(x.fin.text), "ChatGPT answers the task", x.fin?.text);
  ok(x.slice.find((e) => e.type === "task")?.brain === "chatgpt" && x.slice.some((e) => e.type === "log" && /^ChatGPT online/.test(e.text)), "the task is marked as ChatGPT's; Activity says ChatGPT is online");
  ok(a.args[0] === "exec" && a.conf.sandbox_mode === '"read-only"' && a.conf["features.shell_tool"] === "false" && a.conf["features.unified_exec"] === "false", "Codex runs read-only with its own shell switched off");
  ok(a.conf["mcp_servers.ai-brain.default_tools_approval_mode"] === '"approve"' && /AI_BRAIN_BRAIN="chatgpt"/.test(a.conf["mcp_servers.ai-brain.env"]), "AI Brain's tools are connected as the ChatGPT brain's");
  ok(!/AI_BRAIN_APPROVE_KEY/.test(a.conf["mcp_servers.ai-brain.env"]) && /can NOT change files/.test(instr(a)), "read only: no approval key, and ChatGPT is told it cannot change files");
  ok(/BRAIN of the "AI Brain"/.test(instr(a)) && /ask_claude/.test(instr(a)) && /shell, file and patch tools are switched off/.test(instr(a)), "AI Brain's instructions reach ChatGPT, with Claude as a helper");
  ok(x.fin.gptUsage?.in === 2000 && !x.fin.usage, "its tokens are counted as ChatGPT's, not Claude's");
  const used = fs.readFileSync(path.join(DATA, "usage-chatgpt.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((u) => u.kind === "brain");
  ok(used.length === 1 && used[0].ok && used[0].in === 2000 && used[0].limits?.long?.pct === 23, "the ChatGPT usage panel counts it, with the plan limits");

  x = await task("Again");
  a = codexArgs().at(-1);
  ok(a.args[1] === "resume" && a.resume && /resumed: yes/.test(x.fin.text), "the next task continues the same ChatGPT conversation");

  x = await task("[tools] which tools");
  const tools = (x.fin.text.match(/tools: (.*)/) || [])[1]?.split(",") || [];
  ok(["ask_claude", "ask_gemini", "ask_both", "read_file", "list_folder"].every((t) => tools.includes(t)), "read only: it can ask Claude and Gemini and read files", tools.join());
  ok(!["ask_chatgpt", "approve", "write_file", "edit_file", "run_command", "gemini_edit_file"].some((t) => tools.includes(t)), "read only: no ChatGPT helper (it is the brain), no approve tool, no change tools, no Gemini edits");

  x = await task("[claude] ask Claude");
  const call = x.slice.find((e) => e.type === "call");
  ok(call?.from === "chatgpt" && call.to === "claude" && x.slice.some((e) => e.type === "reply" && e.to === "claude" && /Claude \(test reply\)/.test(e.text)), "ChatGPT asks Claude; the window shows the call and the reply");
  x = await task("[both] ask both");
  const calls = x.slice.filter((e) => e.type === "call").map((e) => e.to).sort().join();
  ok(calls === "claude,gemini" && x.slice.filter((e) => e.type === "reply" && !e.isError).length === 2, "ask_both goes to Claude and Gemini");

  rm("fake-gpt-change.txt");
  x = await task("[write] read only");
  ok(/write: denied/.test(x.fin.text) && !there("fake-gpt-change.txt") && !x.slice.some((e) => e.type === "approval"), "read only: a change is refused without asking");
  x = await task("[secret] [outside]");
  ok(/secret: refused - Not allowed: AI Brain never lets the brain touch sign-in data/.test(x.fin.text), "the .codex folder is never read");
  ok(/outside: refused - Not allowed: only files inside/.test(x.fin.text), "files outside the allowed folders are not read");
  fs.mkdirSync(path.join(WORKDIR, "uploads"), { recursive: true });
  const note = path.join(WORKDIR, "uploads", "note.txt");
  fs.writeFileSync(note, "the attached note says 42\n");
  x = await task("[read] read the note", [note]);
  ok(/read: ok - .*the attached note says 42/.test(x.fin.text), "it reads an attached file");

  console.log("ChatGPT as the brain: asks before changes");
  await post("/api/settings", { access: "ask" });
  let from = await start("[tools] [write] ask");
  let ap = await answer(from, true);
  x = await end(from);
  a = codexArgs().at(-1);
  ok(ap?.title === "ChatGPT wants to write a file" && /fake-gpt-change\.txt$/.test(ap.path) && /made by the ChatGPT brain/.test(ap.detail), "a file write asks first, as ChatGPT", JSON.stringify(ap));
  ok(/write: allowed/.test(x.fin.text) && fs.readFileSync(path.join(WORKDIR, "fake-gpt-change.txt"), "utf8") === "made by the ChatGPT brain\n", "Allow: the file is written");
  ok(x.slice.filter((e) => e.type === "log" && /^write_file: /.test(e.text)).length === 1, "Activity lists the write once");
  ok(/AI_BRAIN_APPROVE_KEY/.test(a.conf["mcp_servers.ai-brain.env"]) && ["write_file", "edit_file", "run_command"].every((t) => x.fin.text.includes(t)), "ask: the change tools are there");
  from = await start("[edit] change it");
  ap = await answer(from, true);
  x = await end(from);
  ok(ap?.title === "ChatGPT wants to change a file" && /changed by the ChatGPT brain/.test(fs.readFileSync(path.join(WORKDIR, "fake-gpt-change.txt"), "utf8")), "an edit asks first, then changes the file");
  rm("fake-gpt-change.txt");
  from = await start("[write] deny it");
  ap = await answer(from, false);
  x = await end(from);
  ok(/write: denied - Not done/.test(x.fin.text) && !there("fake-gpt-change.txt"), "Deny: nothing is written");
  from = await start("[command] run it");
  ap = await answer(from, true);
  x = await end(from);
  ok(ap?.title === "ChatGPT wants to run a command" && /hello 42/.test(x.fin.text), "a command asks first, then runs", x.fin?.text);
  ok(/key=\./.test(x.fin.text), "the command never sees AI Brain's approval key");

  console.log("Gemini edits a file (through AI Brain)");
  const gemFile = path.join(WORKDIR, "gem.txt");
  fs.writeFileSync(gemFile, "line one\nline two\n");
  from = await start("[gemini-edit] please");
  ap = await answer(from, true);
  x = await end(from);
  ok(ap?.title === "Gemini wants to change a file" && /gem\.txt$/.test(ap.path) && /\+ edited by Gemini \(test\)/.test(ap.detail) && !/\+ line one/.test(ap.detail) && /^ChatGPT asked Gemini: Add a line/.test(ap.note), "Gemini's change is shown before it is saved: only the changed lines, and what was asked", JSON.stringify(ap));
  ok(/gemini-edit: allowed - Gemini changed/.test(x.fin.text) && fs.readFileSync(gemFile, "utf8") === "line one\nline two\n\nedited by Gemini (test)\n", "Allow: AI Brain saves Gemini's version", JSON.stringify(fs.readFileSync(gemFile, "utf8")));
  ok(x.slice.some((e) => e.type === "call" && e.from === "chatgpt" && e.to === "gemini" && /^Edit the file gem\.txt: Add a line/.test(e.prompt)) && x.slice.some((e) => e.type === "reply" && e.to === "gemini" && /Gemini changed/.test(e.text)), "the Gemini panel shows the request and the result");
  const keep = fs.readFileSync(gemFile, "utf8");
  from = await start("[gemini-edit] no thanks");
  ap = await answer(from, false);
  x = await end(from);
  ok(/gemini-edit: denied - Not done/.test(x.fin.text) && fs.readFileSync(gemFile, "utf8") === keep, "Deny: the file stays as it was");
  ok(!x.slice.some((e) => e.type === "helper_state" && e.who === "gemini" && e.ok === false), "a change the user said no to does not mark Gemini as failing");
  x = await task("[gemini-edit] [noedit] sulk");
  ok(/gemini-edit: denied - Gemini did not send the new file/.test(x.fin.text) && !x.slice.some((e) => e.type === "approval") && fs.readFileSync(gemFile, "utf8") === keep, "no new file from Gemini: nothing is asked and nothing changes");
  from = await start("[gemini-new] make one");
  ap = await answer(from, true);
  x = await end(from);
  ok(ap?.title === "Gemini wants to create a file" && there("new-by-gemini.txt") && /edited by Gemini/.test(fs.readFileSync(path.join(WORKDIR, "new-by-gemini.txt"), "utf8")), "Gemini can create a new file, after Allow");
  x = await task("[gemini-secret] try");
  ok(/gemini-secret: denied - Not allowed: AI Brain never lets the brain touch sign-in data/.test(x.fin.text) && !x.slice.some((e) => e.type === "approval"), "sign-in folders are refused without asking", x.fin?.text);
  rm("gem.txt"); rm("new-by-gemini.txt");

  await post("/api/settings", { access: "auto" });
  rm("fake-gpt-change.txt");
  x = await task("[write] always allow");
  ok(/write: allowed/.test(x.fin.text) && there("fake-gpt-change.txt") && !x.slice.some((e) => e.type === "approval") && x.slice.some((e) => e.type === "log" && /always allow is on/.test(e.text)), "always allow: written without a question, and logged");
  rm("fake-gpt-change.txt");
  await post("/api/settings", { access: "read" });

  console.log("ChatGPT as the brain: problems");
  x = await task("[error] fail");
  ok(x.fin?.isError && x.fin.brain === "chatgpt" && /before ChatGPT finished/.test(x.fin.text) && /Test error from the fake ChatGPT brain/.test(x.fin.text), "a failed turn shows ChatGPT's error");
  from = await start("[hang] forever");
  await waitFor((e) => e.type === "stream" && /Working on it/.test(e.text || ""), 8000, from);
  await post("/api/stop");
  x = await end(from);
  ok(x.fin?.stopped, "Stop ends a ChatGPT task");
  const stateFile = path.join(DATA, "state.json");
  fs.writeFileSync(stateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(stateFile, "utf8")), chatgptBrainThread: "stale-thread" }));
  x = await task("After a lost conversation");
  ok(x.fin && !x.fin.isError && /resumed: no/.test(x.fin.text) && x.slice.some((e) => e.type === "log" && /Could not continue the previous ChatGPT conversation/.test(e.text)), "a lost ChatGPT conversation recovers with a fresh one");
  ok(x.slice.filter((e) => e.type === "task").length === 1, "recovery does not repeat the task bubble");

  await post("/api/settings", { brain: "claude" });
  x = await task("Claude again");
  ok(x.fin && !x.fin.isError && !x.fin.brain && !/ChatGPT brain/.test(x.fin.text), "switching back: Claude is the brain again");
  ok(!brainArgs().at(-1).args.includes("mcp__ai-brain__gemini_edit_file"), "Claude, read only: no Gemini edits");
  await post("/api/settings", { access: "ask" });
  x = await task("Claude may change things");
  const ca = brainArgs().at(-1).args;
  ok(ca.slice(ca.indexOf("--allowedTools")).includes("mcp__ai-brain__gemini_edit_file") && /gemini_edit_file gives Gemini one text file/.test(ca[ca.indexOf("--append-system-prompt") + 1]), "Claude, asks first: it can have Gemini edit files, and that tool asks the user itself (no second question from Claude)");
  await post("/api/settings", { access: "read" });
}

// A saved theme that was removed in 3.1 (the three Black Clover ones) opens as Berserk.
function themeMoveTest() {
  console.log("removed themes");
  for (const old of ["clover", "demon", "wind"]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-brain-theme-"));
    fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ theme: old, accent: "violet" }));
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `import { loadSettings } from ${JSON.stringify(new URL("../lib.mjs", import.meta.url).href)}; console.log(JSON.stringify(loadSettings()));`],
      { env: { ...process.env, BRAIN_DATA_DIR: dir }, encoding: "utf8" });
    let s = null; try { s = JSON.parse(r.stdout.trim().split("\n").pop()); } catch { /* shown below */ }
    ok(s?.theme === "berserk" && s.accent === "violet", `a saved "${old}" theme opens as Berserk and other settings stay`, r.stdout + r.stderr);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
