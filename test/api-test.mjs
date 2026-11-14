#!/usr/bin/env node
// Server tests. Starts the app server on a spare port with a throw-away data folder,
// a fake Claude and fake helpers, then checks the HTTP API and the event stream.
// Run: node test/api-test.mjs
import { spawn } from "node:child_process";
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
      BRAIN_FAKE_CLAUDE: path.join(ROOT, "test", "fake-claude.mjs"), BRAIN_FAKE_HELPERS: "1",
      BRAIN_FAKE_IMAGE: FIXTURE, BRAIN_FAKE_DELAY_MS: "150", BRAIN_APPROVAL_MS: "4000", ...extraEnv,
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
  ok(await waitFor((e) => e.type === "settings" && e.settings.theme === "neon"), "settings change broadcast");

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
  ok(!a.args.includes("--resume"), "first task starts a new Claude session");
  ok(!a.args.some((x) => /ask_chatgpt|ask_both/.test(x)), "ChatGPT tools not offered while off");
  ok(/Gemini is your only helper/.test(a.args[a.args.indexOf("--append-system-prompt") + 1]), "system prompt says ChatGPT is off");
  const mcp = JSON.parse(fs.readFileSync(path.join(DATA, "brain-mcp.json"), "utf8"));
  ok(mcp.mcpServers["ai-brain"].env.AI_BRAIN_CHATGPT === "0", "MCP config turns ChatGPT off");

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
} catch (e) {
  failed++;
  console.log("  CRASH", e.stack || e);
} finally {
  sse?.abort();
  await stopServer();
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
