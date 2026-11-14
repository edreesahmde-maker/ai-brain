#!/usr/bin/env node
// App bridges with the REAL programs: a Craft app (live MCP bridge), Blender and Krita (Python
// bridges). Each program is started the way AI Brain starts it, used through its bridge (no mouse),
// checked, and closed. Programs that are not installed are skipped. Blender runs with factory settings;
// Krita uses your Krita settings (the AI Brain plugin is copied in and switched on, as in real use).
//   node test/bridge-test.mjs
// Program paths: BRAIN_TEST_ANICRAFT, BRAIN_TEST_VECTORCRAFT, BRAIN_TEST_BLENDER, BRAIN_TEST_KRITA.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { kindOf, prepare, Bridge } = require("../shell/bridges.cjs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0, failed = 0;
const ok = (cond, name, extra = "") => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${String(extra).slice(0, 700)}`); } };
const L = process.env.LOCALAPPDATA || "";
const find = (...c) => c.find((p) => p && fs.existsSync(p)) || "";
const firstIn = (dir, exe) => { try { for (const d of fs.readdirSync(dir)) { const p = path.join(dir, d, exe); if (fs.existsSync(p)) return p; } } catch { /* no folder */ } return ""; };
const ANI = process.env.BRAIN_TEST_ANICRAFT || find(path.join(L, "Programs", "ArtCraft", "AniCraft", "anicraft.exe"), "D:\\Apps\\AniCraft\\anicraft.exe");
const VEC = process.env.BRAIN_TEST_VECTORCRAFT || firstIn("D:\\Apps\\VectorCraft", "vectorcraft.exe") || find(path.join(L, "Programs", "ArtCraft", "VectorCraft", "vectorcraft.exe"));
const BLENDER = process.env.BRAIN_TEST_BLENDER || find("D:\\Apps\\Blender\\blender-launcher.exe", "C:\\Program Files\\Blender Foundation\\Blender 5.3\\blender-launcher.exe");
const KRITA = process.env.BRAIN_TEST_KRITA || find("D:\\Apps\\Krita\\bin\\krita.exe", "C:\\Program Files\\Krita (x64)\\bin\\krita.exe");

console.log("what can be bridged");
ok(kindOf("D:\\x\\blender-launcher.exe") === "blender" && kindOf("D:\\x\\blender.exe") === "blender", "Blender is recognised");
ok(kindOf("D:\\x\\bin\\krita.exe") === "krita", "Krita is recognised");
ok(!ANI || kindOf(ANI) === "craft", "a Craft app with its -cli next to it is recognised", kindOf(ANI));
ok(kindOf("D:\\nowhere\\fakecraft.exe") === "", "a 'craft' name without its CLI is not");
ok(kindOf("C:\\Windows\\notepad.exe") === "", "other programs have no bridge");

const started = [];
async function launch(target, argv = []) {
  const l = await prepare(target, argv);
  const p = spawn(l.target, l.argv, { env: { ...process.env, ...l.env }, detached: true, stdio: "ignore", cwd: path.dirname(l.target) });
  p.unref();
  started.push(p);
  return { l, p, bridge: new Bridge(l.bridge) };
}
function stop(p) { try { process.kill(p.pid); } catch { /* gone */ } }

try {
  // ---------- every Craft app: its own MCP server, attached to the live window where the app can ----------
  const CRAFTS = [];
  for (const dir of [path.join(L, "Programs", "ArtCraft"), "D:\\Apps"]) {
    try {
      for (const d of fs.readdirSync(dir)) {
        const exe = [path.join(dir, d), ...(() => { try { return fs.readdirSync(path.join(dir, d)).map((s) => path.join(dir, d, s)); } catch { return []; } })()]
          .map((folder) => { try { return fs.readdirSync(folder).filter((f) => /^[a-z-]*craft(-anything)?\.exe$/i.test(f) || /^craft-anything\.exe$/i.test(f)).map((f) => path.join(folder, f)); } catch { return []; } }).flat()
          .find((f) => kindOf(f) === "craft");
        if (exe && !CRAFTS.some((c) => path.basename(c).toLowerCase() === path.basename(exe).toLowerCase())) CRAFTS.push(exe);
      }
    } catch { /* folder not there */ }
  }
  const only = process.env.BRAIN_TEST_CRAFTS ? process.env.BRAIN_TEST_CRAFTS.split(",") : null;
  console.log(`Craft apps (${CRAFTS.length} found)`);
  for (const exe of CRAFTS) {
    const app = path.basename(exe, ".exe").toLowerCase();
    if (only && !only.includes(app)) continue;
    const { l, p, bridge } = await launch(exe);
    const live = !!l.bridge.live;
    const r = await bridge.ready(60000);
    const c = r.ok ? await bridge.commands() : { ok: false };
    const portOpen = live ? await new Promise((res) => { const s = require("node:net").connect({ host: "127.0.0.1", port: l.bridge.port }, () => { s.destroy(); res(true); }); s.on("error", () => res(false)); }) : null;
    ok(r.ok && c.ok && c.tools.length > 0 && (!live || portOpen), `${app}: ${live ? "LIVE bridge to the open window" : "headless bridge (files)"}, ${c.tools?.length || 0} tools`, JSON.stringify({ r, why: c.why, portOpen }).slice(0, 300));
    if (app === "anicraft") {
      const list = await bridge.call("anicraft_commands", {});
      ok(list.ok && /draw\.rect/.test(JSON.stringify(list.content)), "  anicraft: it lists the app's commands (draw.rect among them)");
      const draw = await bridge.call("anicraft_run", { command: "draw.rect", params: { x: 20, y: 20, w: 80, h: 50 } });
      ok(draw.ok, "  anicraft: it draws a rectangle", JSON.stringify(draw).slice(0, 300));
      const pic = await bridge.call("anicraft_render", {});
      ok(pic.ok && pic.content.some((x) => x.type === "image"), "  anicraft: it renders a frame as a picture");
      const bad = await bridge.call("anicraft_run", { command: "no.such.command" });
      ok(!bad.ok && bad.why, "  anicraft: an unknown command is an error with a reason", JSON.stringify(bad).slice(0, 200));
    }
    bridge.close();
    stop(p);
    await sleep(1200);
  }

  // ---------- Blender: Python in the live app ----------
  if (!BLENDER) console.log("Blender: not installed, skipped");
  else {
    console.log("Blender (Python bridge)");
    const { l, p, bridge } = await launch(BLENDER, ["--factory-startup"]);
    ok(path.basename(l.target).toLowerCase() === "blender.exe" && l.argv.includes("--python") && l.env.AIBRAIN_BRIDGE_TOKEN.length === 48, "it is started as blender.exe with the bridge script and a one-time key", JSON.stringify(l.argv));
    const r = await bridge.ready(90000);
    ok(r.ok, "its bridge answers", JSON.stringify(r));
    const info = await bridge.about();
    ok(info.ok && /^5\./.test(info.version) && info.objects.some((o) => o.name === "Cube"), "it describes Blender and the scene", JSON.stringify(info).slice(0, 300));
    const py = await bridge.python("import bpy\nbpy.ops.mesh.primitive_monkey_add(location=(3, 0, 0))\nprint('added', bpy.context.object.name)\nsorted(o.name for o in bpy.data.objects)");
    ok(py.ok && /added Suzanne/.test(py.output) && /Suzanne/.test(py.result), "Python runs in the live Blender (adds a monkey) and returns printout and result", JSON.stringify(py));
    const keep = await bridge.python("x = 41");
    const keep2 = await bridge.python("x + 1");
    ok(keep.ok && keep2.result === "42", "variables are kept between calls");
    const err = await bridge.python("1/0");
    ok(!err.ok && /ZeroDivisionError/.test(err.why), "errors come back with the traceback", JSON.stringify(err).slice(0, 200));
    const wrong = await new Bridge({ ...l.bridge, token: "x".repeat(48) }).python("print('should not run')");
    ok(!wrong.ok && /wrong token/.test(wrong.why), "without the right key nothing runs");
    stop(p);
    await sleep(1500);
  }

  // ---------- Krita: Python in the live app (the AI Brain plugin) ----------
  if (!KRITA) console.log("Krita: not installed, skipped");
  else {
    console.log("Krita (Python bridge)");
    const { l, p, bridge } = await launch(KRITA, ["--nosplash"]);
    const pyk = path.join(process.env.APPDATA || "", "krita", "pykrita");
    ok(fs.existsSync(path.join(pyk, "aibrain_bridge", "__init__.py")) && fs.existsSync(path.join(pyk, "aibrain_bridge.desktop")), "the plugin is in Krita's pykrita folder");
    ok(/enable_aibrain_bridge=true/.test(fs.readFileSync(path.join(process.env.LOCALAPPDATA || "", "kritarc"), "utf8")), "and switched on in kritarc");
    const r = await bridge.ready(120000);
    ok(r.ok, "its bridge answers", JSON.stringify(r));
    const info = await bridge.about();
    ok(info.ok && /^5\./.test(info.version), "it describes Krita", JSON.stringify(info));
    const py = await bridge.python("d = app.createDocument(320, 200, 'AI Brain test', 'RGBA', 'U8', '', 72.0)\napp.activeWindow().addView(d)\nprint('made', d.name())\n[x.name() for x in app.documents()]");
    ok(py.ok && /made AI Brain test/.test(py.output) && /AI Brain test/.test(py.result || ""), "Python runs in the live Krita (makes a document)", JSON.stringify(py));
    const wrong = await new Bridge({ ...l.bridge, token: "x".repeat(48) }).python("print(1)");
    ok(!wrong.ok && /wrong token/.test(wrong.why), "without the right key nothing runs");
    stop(p);
    await sleep(1500);
  }
} catch (e) {
  failed++;
  console.log("  CRASH", e.stack || e);
} finally {
  for (const p of started) stop(p);
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
