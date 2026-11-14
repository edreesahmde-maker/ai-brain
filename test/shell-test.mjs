#!/usr/bin/env node
// The desktop window's own test: opens AI Brain's Electron window against a test server (never
// your real AI Brain data) and runs the self-test in shell/main.cjs.
//   node test/shell-test.mjs                    program in the middle with System Information
//   BRAIN_SHELL_APP_EXE="C:\...\blender.exe" node test/shell-test.mjs   the same with another program
// The test program is opened by the test and closed afterwards. If it already has a window open,
// that part is skipped, so your own windows are never moved.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4793;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ai-brain-shell-"));
const SHELL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ai-brain-shelldata-"));
const OUT = path.join(ROOT, "test", "shots");
let passed = 0, failed = 0;
const ok = (cond, name, extra = "") => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); } };

// ---------- an older server left running is replaced (stub servers on a spare port, never yours) ----------
{
  const { createRequire } = await import("node:module");
  const check = createRequire(import.meta.url)("../shell/server-check.cjs");
  const http = await import("node:http");
  const SP = 4794, SB = `http://127.0.0.1:${SP}`;
  const stub = (obeys) => new Promise((res) => {
    const s = http.createServer((q, r) => {
      if (q.url === "/api/ping") { r.setHeader("Content-Type", "application/json"); return r.end(JSON.stringify({ app: "ai-brain", version: "2.2.0" })); }
      if (q.url === "/api/shutdown" && q.method === "POST") { r.end("{}"); if (obeys && q.headers.origin === SB) s.close(() => {}), s.closeAllConnections(); return; }
      r.statusCode = 404; r.end();
    });
    s.listen(SP, "127.0.0.1", () => res(s));
  });
  console.log("older server");
  let s = await stub(true);
  const st = await check.serverState(SB, ROOT);
  ok(st.state === "old" && st.info.version === "2.2.0", "an older server is recognised as old", JSON.stringify(st));
  const r1 = await check.stopOld(SB, SP, ROOT);
  ok(r1.ok && r1.how === "asked" && (await check.serverState(SB, ROOT)).state === "none", "it is asked to stop and stops", JSON.stringify(r1));
  s = await stub(false);
  const r2 = await check.stopOld(SB, SP, ROOT);
  ok(!r2.ok && r2.how === "not-ours" && (await check.serverState(SB, ROOT)).state === "old", "a program that is not this AI Brain server is never ended", JSON.stringify(r2));
  s.closeAllConnections(); s.close();
}

const server = spawn(process.execPath, [path.join(ROOT, "app", "app-server.mjs")], {
  env: { ...process.env, BRAIN_PORT: String(PORT), BRAIN_DATA_DIR: DATA, BRAIN_NO_OPEN: "1", BRAIN_FAKE_DISCORD: "running",
    BRAIN_FAKE_CLAUDE: path.join(ROOT, "test", "fake-claude.mjs"), BRAIN_FAKE_HELPERS: "1" },
  stdio: "ignore",
});
for (let i = 0; ; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/api/ping`)).ok) break; } catch { /* starting */ }
  if (i > 60) throw new Error("server did not start");
  await sleep(200);
}
const env = { ...process.env, BRAIN_PORT: String(PORT), BRAIN_SHELL_DATA: SHELL_DATA, BRAIN_SHELL_TEST: OUT, BRAIN_SHELL_APPS: "1",
  // Google Flow is tested with a page of the test server and an empty browser profile: never Google, never your browser session.
  BRAIN_SHELL_FLOW_URL: `http://127.0.0.1:${PORT}/api/ping` };
delete env.ELECTRON_RUN_AS_NODE;
const el = spawn(path.join(ROOT, "node_modules", "electron", "dist", "electron.exe"), [path.join(ROOT, "shell", "main.cjs")], { env, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
el.stdout.on("data", (d) => { log += d; });
el.stderr.on("data", () => {});
const timer = setTimeout(() => { console.log("  FAIL the desktop window did not finish in 6 minutes"); el.kill(); }, 360000);
await new Promise((r) => el.on("exit", r));
clearTimeout(timer);
server.kill();
await sleep(1500);

const line = (tag) => { const m = log.match(new RegExp(`^${tag} (.*)$`, "m")); try { return m ? JSON.parse(m[1]) : null; } catch { return null; } };
console.log("desktop window");
ok(!/SERVER REPLACED/.test(log), "the server started by the test counts as up to date and is used as it is");
const sh = line("SHELL");
ok(sh?.shell && sh.webviews === 0, "the page runs in the desktop window", JSON.stringify(sh));
ok(/SELFTEST ERROR/.test(log) === false, "the self-test ran without errors", (log.match(/SELFTEST ERROR.*/) || [""])[0]);
ok(/EVENT win-closed/.test(log), "the window closes");

console.log("Google Flow");
const fskip = line("FLOW SKIP");
if (fskip) console.log(`  skip ${fskip.why}`);
else {
  const fo = line("FLOW OPEN"), fa = line("FLOW AGAIN"), fc = line("FLOW CLOSED");
  ok(fo?.r1 && fo.hwnd && fo.fresh && fo.count === 1, "the Flow button opens one new browser window of its own", JSON.stringify(fo));
  ok(fo?.cdp?.flowPage === true, "Flow opens with the brain's control port (its own profile), showing the Flow page", JSON.stringify(fo?.cdp));
  ok(fo?.state?.pin === "builtin-flow" && fo.name === "Google Flow" && fo.kind === "In the middle now", "the page shows Google Flow in the middle", JSON.stringify(fo));
  ok(fo?.onSlot, "its window sits exactly on the slot");
  ok(fo?.pins === 0, "it is not saved as one of your programs");
  ok(fa?.r2 && fa.rel && fa.r3?.ok && fa.sameWindow && fa.count === 1, "clicking again uses the same window, no second one", JSON.stringify(fa));
  const fs1 = line("FLOW SIGNIN");
  ok(fs1?.signIn?.ok && fs1.signIn.docked && fs1.signIn.port === false && fs1.signIn.count === 1, "'Open only to sign in' reopens Flow without the brain's control port (still one window)", JSON.stringify(fs1));
  ok(fs1?.back?.ok && fs1.back.docked && fs1.back.port === true && fs1.back.count === 1, "the Flow button then reopens it with the control port again", JSON.stringify(fs1));
  ok(fs1?.back?.kept === "yes|true", "switching closes the Flow window gently: a cookie saved just before (like a fresh Google sign-in) is still there", JSON.stringify(fs1?.back));
  ok(fc?.left === 0 && fc.docked === false, "the test closed its own browser window", JSON.stringify(fc));
  const fw = line("FLOW WARM"), fd = line("FLOW WARMDONE");
  ok(fw?.holder && fw.r4?.ok && fw.state?.pin === "builtin-flow", "Flow also opens while that browser is already running", JSON.stringify(fw));
  ok(fw?.other && fw.holderStays && fw.count === 2, "it uses the new Flow window and leaves the browser's own window alone", JSON.stringify(fw));
  ok(fd?.left === 0 && fd.docked === false, "the test closed both of its browser windows", JSON.stringify(fd));
}

console.log("program in the middle");
const skip = line("APPS SKIP");
if (skip) {
  console.log(`  skip ${skip.why}: ${skip.titles.join(", ")}. Close it and run the test again.`);
} else {
  const o = line("APPS OPEN"), f = line("APPS FOLLOW"), d = line("APPS DIALOG"), r = line("APPS RELEASE"), ro = line("APPS REOPEN"), rd = line("APPS REDOCK");
  ok(o?.openR?.ok && o.hwnd && o.pin?.pin === "testpin", "a pinned program opens and is docked", JSON.stringify(o?.openR));
  ok(o?.page?.view && o.page.name === "Test program", "the page shows it in the middle");
  ok(o?.onSlot, "its window sits exactly on the slot", JSON.stringify({ frame: o?.frame, slot: o?.slot }));
  ok(o?.stack === "right-above", "it sits right above AI Brain", o?.stack);
  ok(f?.resizedOnSlot, "it follows when AI Brain changes size");
  ok(f?.onSlot && f.dx > 0 && f.dy > 0, "it follows when AI Brain moves", JSON.stringify(f));
  ok(d?.underDialog === "below" && d.shownWhileDialog === false, "a dialog in AI Brain sends it behind AI Brain", JSON.stringify(d));
  ok(d?.afterDialog === "right-above" && d.shownAfter, "it comes back after the dialog");
  const ty = line("APPS TYPING");
  ok(ty?.stack === "right-above" && ty.show && ty.text === "hello", "typing in the chat keeps it on top of AI Brain", JSON.stringify(ty));
  ok(r?.back?.ok && r.docked === false && r.page === true && r.file === false, "Put it back releases it", JSON.stringify(r));
  // The saved size is the outer window; the listed size is the visible frame (a few pixels smaller).
  ok(r?.size && r.pre && Math.abs(r.size.w - r.pre.w) <= 20 && Math.abs(r.size.h - r.pre.h) <= 20, "it gets its own size back", JSON.stringify({ size: r?.size, pre: r?.pre }));
  ok(ro?.again?.ok && ro.sameWindow && ro.count === 1, "clicking the pin again finds the running copy, no second copy", JSON.stringify(ro));
  ok(rd?.listed && rd.dockR?.ok && rd.docked && rd.file, "an open window can be docked from the list", JSON.stringify(rd));

  // After AI Brain closed: the program must be back at its own size. Then close it.
  const helpers = path.join(SHELL_DATA, "helpers");
  const exe = fs.existsSync(helpers) ? fs.readdirSync(helpers).find((x) => /^app-dock-.*\.exe$/.test(x)) : null;
  if (exe && o?.hwnd) {
    const h = spawn(path.join(helpers, exe), [], { stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    h.stdout.on("data", (x) => { buf += x; });
    await sleep(800);
    h.stdin.write("1 list\n");
    await sleep(1200);
    h.stdin.end();
    await sleep(300);
    const ans = buf.split("\n").find((l) => l.includes('"id":1'));
    const w = ans ? JSON.parse(ans).windows.find((x) => x.hwnd === o.hwnd) : null;
    ok(w && r?.pre && Math.abs(w.w - r.pre.w) <= 20 && Math.abs(w.h - r.pre.h) <= 20, "closing AI Brain puts it back first", JSON.stringify({ now: w && { w: w.w, h: w.h }, pre: r?.pre }));
    ok(!fs.existsSync(path.join(SHELL_DATA, "docked.json")), "nothing is left to put back after a crash");
    if (w) { try { process.kill(w.pid); } catch (e) { console.log(`  note: could not close the test program (${e.message})`); } }
  } else ok(false, "the window helper was built", String(exe));
}
try { fs.rmSync(DATA, { recursive: true, force: true }); fs.rmSync(SHELL_DATA, { recursive: true, force: true }); } catch { /* still in use */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
