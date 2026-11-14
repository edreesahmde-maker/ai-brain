#!/usr/bin/env node
// Browser tests. Starts the app server on a spare port with a throw-away data folder,
// a fake Claude and fake helpers, then drives the real page in headless Chrome.
// Run: node test/ui-test.mjs            (add --shots to keep screenshots in test/shots)
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 4789;
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "ai-brain-ui-"));
const FIXTURE = path.join(ROOT, "test", "fixture.jpg");
const SHOTS = path.join(ROOT, "test", "shots");

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
const CHROME = [
  process.env.CHROME_PATH,
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
].find((p) => p && fs.existsSync(p));
fs.mkdirSync(SHOTS, { recursive: true });

let passed = 0, failed = 0;
const ok = (cond, name, extra = "") => { if (cond) { passed++; console.log(`  ok   ${name}`); } else { failed++; console.log(`  FAIL ${name} ${extra}`); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(process.execPath, [path.join(ROOT, "app", "app-server.mjs")], {
  env: {
    ...process.env, BRAIN_PORT: String(PORT), BRAIN_DATA_DIR: DATA, BRAIN_NO_OPEN: "1", BRAIN_FAKE_DISCORD: "running",
    BRAIN_FAKE_CLAUDE: path.join(ROOT, "test", "fake-claude.mjs"), BRAIN_FAKE_HELPERS: "1",
    BRAIN_FAKE_IMAGE: FIXTURE, BRAIN_FAKE_VIDEO: path.join(ROOT, "test", "fixture.mp4"), BRAIN_FAKE_DELAY_MS: "400", BRAIN_FAKE_CODEX_HOME: CODEX_HOME,
  },
  stdio: "ignore",
});
for (let i = 0; ; i++) {
  try { if ((await (await fetch(`${BASE}/api/ping`)).json()).app === "ai-brain") break; } catch {}
  if (i > 60) throw new Error("server did not start");
  await sleep(150);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--window-size=1680,980", "--autoplay-policy=no-user-gesture-required"] });
const problems = [];
async function newPage(w = 1680, hh = 980) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: hh });
  page.on("console", (m) => { if (m.type() === "error") problems.push(`console: ${m.text()}`); });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => { if (!r.url().endsWith("/events") && !/ERR_ABORTED/.test(r.failure()?.errorText || "")) problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
  page.on("response", (r) => { if (r.status() >= 400 && r.status() !== 409) problems.push(`http ${r.status()}: ${r.url()}`); });
  page.on("dialog", (d) => { problems.push(`native dialog: ${d.message()}`); d.dismiss().catch(() => {}); });
  await page.evaluateOnNewDocument(() => {
    // Test helpers: the layout as station.js placed it (pixels inside #tiles).
    const lay = () => window.Station?.layout?.();
    window.__shown = (id) => !!lay()?.rects[id];
    window.__panels = () => Object.keys(lay()?.rects || {}).filter((k) => k !== "main" && k !== "app").length;
    // The panels along the left or right edge, top to bottom.
    window.__side = (side) => {
      const l = lay(), w = document.querySelector("#tiles")?.clientWidth || 0;
      if (!l) return "";
      return Object.entries(l.rects).filter(([k, r]) => k !== "main" && k !== "app" && (side === "left" ? r.x <= 10 : r.x + r.w >= w - 10))
        .sort((a, b) => a[1].y - b[1].y).map(([k]) => k).join();
    };
  });
  return page;
}
let page = await newPage();

const q = (sel) => page.$(sel);
const count = (sel) => page.$$eval(sel, (els) => els.length);
const text = (sel) => page.$eval(sel, (el) => el.textContent.trim()).catch(() => null);
const visible = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return !el.hidden && r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden"; }).catch(() => false);
async function until(fn, name, arg, timeout = 15000) {
  try { await page.waitForFunction(fn, { timeout, polling: 50 }, arg); ok(true, name); return true; }
  catch (e) { ok(false, name, `(${String(e.message).split("\n")[0]})`); return false; }
}
const idle = (name = "brain is idle again") => until(() => document.querySelector("#btn-stop").hidden && !document.querySelector(".msg.live"), name);
async function sendTask(t) {
  await page.click("#task");
  await page.$eval("#task", (el, v) => { el.value = v; el.dispatchEvent(new Event("input", { bubbles: true })); }, t);
  await page.keyboard.press("Enter");
}
const shot = async (name) => { await sleep(350); await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }); };
const closeTop = async () => { await page.keyboard.press("Escape"); await sleep(120); };
const openDialogs = () => page.$$eval("dialog[open]", (els) => els.map((d) => d.id));

try {
  // ---------- first load ----------
  console.log("first load");
  await page.goto(BASE, { waitUntil: "load" });
  await until(() => document.documentElement.dataset.theme === "dark" && document.documentElement.dataset.density === "compact", "dark theme is the default, compact");
  await until(() => /Ready/.test(document.querySelector("#phase-label").textContent), "stage says Ready");
  ok(await visible("#empty"), "empty state is shown");
  ok(await count("#ideas .idea") === 6 && await count("#ideas .idea .idea-ic svg") === 6, "six starter cards, each with an icon");
  ok(await count('#ideas .idea[data-idea="film"]') === 1, "one starter card makes a video");
  ok(await page.$eval("#mine-ideas", (b) => b.hidden), "no 'Your prompts' row before any prompt is saved");
  ok(!(await text("#ideas")).match(/road|million|bybit/i), "ideas do not mention private projects");
  await until(() => !window.__shown("chatgpt") && document.querySelector("#p-chatgpt").classList.contains("t-off") && document.querySelector("#rail-panels [data-toggle=chatgpt]").hidden, "ChatGPT panel is left out while off");
  ok(await page.$eval("#chips .chip[data-who='chatgpt']", (el) => el.hidden), "ChatGPT chip hidden while off");
  await until(() => document.querySelector("#chips .chip[data-who='gemini'] .dot").classList.contains("ok"), "Gemini chip is green");
  await until(() => /TEST MODE/.test(document.querySelector("#about").textContent), "about line shows test mode");
  await until(() => window.__side("left") === "gemini,activity" && window.__side("right") === "usage,music,stats", "Station layout: Gemini + Activity left, Usage + Music + Stats right");
  ok(await page.$eval("#presets [data-preset=station]", (b) => b.getAttribute("aria-pressed") === "true"), "Station preset is marked");
  ok(await page.evaluate(() => window.Station.layout().splits.filter((s) => !s.horiz).length === 3 && window.Station.layout().splits.filter((s) => s.horiz).length === 2 && document.querySelectorAll(".split:not([hidden])").length === 5), "splitters between panels");
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight), "page does not scroll at 1680x980");
  ok(await page.evaluate(() => document.activeElement?.id === "task"), "task box has focus");
  await page.click('#ideas .idea[data-idea="film"]');
  await until(() => document.querySelector("#dlg-studio").open && document.querySelector("#t-studio").textContent === "Video Studio" && /steam rising/.test(document.querySelector("#video-text").value), "the video card opens the Video Studio with the idea filled in");
  await page.$eval("#video-text", (t) => { t.value = ""; t.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.click('#studio-mode button[data-mode="picture"]');
  await closeTop();
  await until(() => !document.querySelector("#dlg-studio").open && document.querySelector("#task").value === "", "the studio closes and the task box stays empty");
  await shot("01-empty-dark-1680");

  // ---------- a plain task ----------
  console.log("plain task");
  await sendTask("Say hello [slow]");
  await until(() => document.querySelectorAll(".msg.you").length === 1, "task bubble appears");
  await until(() => !!document.querySelector(".msg.live"), "live answer bubble appears");
  await until(() => !document.querySelector("#btn-stop").hidden, "Stop button shows while working");
  await until(() => document.querySelector("#emblem").classList.contains("working"), "emblem animates while working");
  await until(() => document.querySelector(".msg.live .md").textContent.length > 10, "answer streams in live");
  ok((await text("#send-label")) === "Queue", "send button says Queue while busy");
  await shot("02-working");
  await idle();
  ok(await count(".msg.claude:not(.live):not(.note)") === 1, "final answer bubble");
  ok(await count(".msg.claude .md strong") >= 1, "Markdown bold is rendered");
  ok((await text("#session-title")) === "Say hello [slow]", "session title comes from the first task");
  ok((await text("#st-tasks")) === "1", "task counter is 1");
  await until(() => document.querySelector("#usage-5h").textContent === "42%", "usage shows 42%");
  ok((await text("#usage-7d")) === "17%", "weekly usage shows 17%");
  ok(await page.$eval("#usage-5h-bar", (el) => el.style.width === "42%"), "usage bar width");
  ok((await text("#send-label")) === "Send", "send button says Send when idle");
  ok(!(await visible("#empty")), "empty state hidden after a task");

  // ---------- helper call ----------
  console.log("helper call");
  await sendTask("Ideas please [tool]");
  await until(() => document.querySelectorAll("#gemini-log .hm.ask.from-claude").length === 1, "Claude's question shows in the Gemini panel");
  await until(() => document.querySelector("#p-gemini").classList.contains("calling"), "Gemini panel glows while asked");
  await until(() => document.querySelector("#rail-panels [data-toggle=gemini]").classList.contains("busy"), "Gemini rail button lights up");
  await until(() => /Asking Gemini/.test(document.querySelector("#phase-label").textContent), "stage says Asking Gemini");
  await idle();
  ok(await count("#gemini-log .hm.reply .md") === 1, "Gemini's reply is rendered");
  ok(await count("#gemini-log .typing") === 0, "no typing dots left");
  ok(!(await page.$eval("#p-gemini", (el) => el.classList.contains("calling"))), "glow stops after the reply");
  ok(await count(".msg.sys") === 1, "thread notes that Claude asked Gemini");
  ok(await count(".msg.note") >= 1, "Claude's mid-task note is shown");
  ok((await text("#st-calls")) === "1", "helper-call counter is 1");
  ok(await count("#log .log-line") >= 4, "activity log has lines");

  // ---------- unsafe content ----------
  console.log("unsafe content");
  await sendTask("Try it [xss]");
  await until(() => document.querySelectorAll(".msg.you").length === 3, "third task bubble");
  await idle();
  await sleep(300);
  ok(await page.evaluate(() => window.__xss === undefined), "no injected script ran");
  ok(await count("#thread .md img, #thread .md script, #thread .md iframe") === 0, "no images, scripts or frames from the answer");
  ok(await count("#thread .md [onclick], #thread .md [onerror], #thread .md [style]") === 0, "no inline handlers or styles");
  ok(await page.$$eval("#thread .msg.claude .md", (els) => /<img src="x" onerror=/.test(els[els.length - 1].textContent)), "raw HTML in an answer is shown as plain text");
  ok(await page.$$eval("#thread .md a", (as) => as.every((a) => !a.hasAttribute("href") || /^https?:/.test(a.getAttribute("href")))), "only http(s) links survive");
  ok(await page.$$eval("#thread .md a[href]", (as) => as.length >= 1 && as.every((a) => a.target === "_blank" && /noopener/.test(a.rel))), "links open in a new window safely");
  await page.click("#thread .msg.claude:last-of-type .md");
  ok((await openDialogs()).length === 0, "clicking the unsafe answer does nothing");

  // ---------- pictures ----------
  console.log("pictures");
  await sendTask("Draw it [image]");
  await until(() => document.querySelectorAll(".msg.you").length === 4, "fourth task bubble");
  await idle();
  await until(() => document.querySelectorAll(".msg.claude:not(.live) .card .imgs .thumb img").length === 1, "picture shows in the answer");
  await until(() => document.querySelectorAll("#recent-strip .thumb").length === 1, "picture shows under Recent pictures");
  await until(() => [...document.querySelectorAll(".thumb img")].filter((i) => i.offsetParent).every((i) => i.complete && i.naturalWidth > 0), "thumbnails load");
  ok((await text("#st-images")) === "1", "picture counter is 1 (no double count)");
  ok(await count("#gemini-log .hm.reply .imgs .thumb") === 1, "picture shows in the Gemini panel too");
  await page.click(".msg.claude .card .imgs .thumb");
  await until(() => document.querySelector("#dlg-light").open, "picture viewer opens");
  await until(() => { const i = document.querySelector("#light-fig img"); return i && i.complete && i.naturalWidth > 0; }, "full picture loads");
  ok(await visible("#light-attach") && await visible("#light-delete") && await visible("#light-download"), "viewer buttons are shown");
  ok(/\?download=1$/.test(await page.$eval("#light-download", (a) => a.getAttribute("href"))), "download link forces a download");
  await shot("03-lightbox");
  await page.click("#light-attach");
  await until(() => !document.querySelector("#dlg-light").open && document.querySelectorAll("#attachments .file-chip").length === 1, "picture can be attached to the next task");
  await sendTask("What is in this picture?");
  await until(() => document.querySelectorAll(".msg.you").length === 5, "task with attachment is sent");
  ok(await count(".msg.you:last-of-type .file-chips .file-chip") === 1 || await page.$$eval(".msg.you", (els) => els[els.length - 1].querySelectorAll(".file-chip").length === 1), "attachment chip shows on the task");
  ok(await count("#attachments .file-chip") === 0, "attachment tray is cleared");
  await idle();

  // ---------- long answer, formatting ----------
  console.log("long answer");
  await sendTask("Write the plan [long]");
  await until(() => document.querySelectorAll(".msg.you").length === 6, "sixth task bubble");
  await idle();
  const last = ".msg.claude:not(.note):not(.live):last-of-type";
  const fmt = await page.$$eval(".msg.claude:not(.note)", (els) => { const m = els[els.length - 1]; return { table: !!m.querySelector(".table-wrap table"), code: !!m.querySelector("pre .copy-code"), quote: !!m.querySelector("blockquote"), h1: !!m.querySelector("h1"), checks: m.querySelectorAll("input[type=checkbox][disabled]").length, arabic: /مرحبا/.test(m.textContent) }; });
  ok(fmt.table && fmt.code && fmt.quote && fmt.h1 && fmt.checks === 2 && fmt.arabic, "table, code block, quote, heading, checklist and Arabic text render", JSON.stringify(fmt));
  ok(await page.evaluate(() => { const t = document.querySelector("#thread"); return t.scrollHeight - t.scrollTop - t.clientHeight < 90; }), "thread stays scrolled to the newest message");
  await page.$eval("#thread", (t) => { t.scrollTop = 0; });
  await sleep(100);
  await shot("04-long-answer-top");
  await page.$eval("#thread", (t) => { t.scrollTop = t.scrollHeight; });

  // ---------- problems and stopping ----------
  console.log("errors and stop");
  await sendTask("Break [error]");
  await until(() => document.querySelectorAll(".msg.claude.err").length === 1, "a failed task shows an error bubble");
  await idle();
  await sendTask("Go on forever [hang]");
  await until(() => document.querySelector(".msg.live .md")?.textContent.length > 5, "hanging task starts streaming");
  await page.click("#btn-stop");
  await until(() => [...document.querySelectorAll(".msg.sys")].some((m) => /You stopped this task/.test(m.textContent)), "stopping shows a stopped note");
  await idle("idle after Stop");
  await sendTask("Die [crash]");
  await until(() => document.querySelectorAll(".msg.claude.err").length === 2, "a crashed brain shows an error bubble");
  await idle();

  // ---------- waiting list ----------
  console.log("waiting list");
  await sendTask("First in line [slow]");
  await until(() => !document.querySelector("#btn-stop").hidden, "busy with the first task");
  await sendTask("Second in line");
  await until(() => !document.querySelector("#queue-panel").hidden && document.querySelectorAll("#queue .q-item").length === 1, "second task waits in the list");
  await sendTask("Third in line");
  await until(() => document.querySelectorAll("#queue .q-item").length === 2, "third task waits too");
  await page.click("#queue .q-item:last-child button");
  await until(() => document.querySelectorAll("#queue .q-item").length === 1, "a waiting task can be removed");
  await until(() => [...document.querySelectorAll(".msg.you .bubble")].some((b) => b.textContent === "Second in line"), "the waiting task starts by itself", null, 30000);
  await idle();
  ok(await page.$eval("#queue-panel", (el) => el.hidden), "waiting list hides when empty");
  ok(!(await page.$$eval(".msg.you .bubble", (bs) => bs.some((b) => b.textContent === "Third in line"))), "the removed task never ran");

  // ---------- direct message to Gemini ----------
  console.log("direct message");
  await page.click('.p-form[data-who="gemini"] textarea');
  await page.keyboard.type("What is your favourite colour?");
  await page.keyboard.press("Enter");
  await until(() => document.querySelectorAll("#gemini-log .hm.ask.from-you").length === 1, "your direct question shows in the Gemini panel");
  await until(() => document.querySelector('.p-form[data-who="gemini"] button[type=submit]').classList.contains("stop"), "send button turns into Stop");
  await until(() => !document.querySelector('.p-form[data-who="gemini"] button[type=submit]').classList.contains("stop"), "send button comes back after the reply");
  ok(await page.$$eval("#gemini-log .hm.reply", (els) => !!els[els.length - 1].querySelector(".md") && !!els[els.length - 1].querySelector(".actions")), "direct reply is rendered with actions");
  ok(await page.$eval('.p-form[data-who="gemini"] textarea', (t) => t.value === ""), "direct box is cleared");
  await page.$$eval("#gemini-log .hm.reply", (els) => [...els[els.length - 1].querySelectorAll(".act")].find((b) => /brain/i.test(b.textContent)).click());
  ok(/^Gemini said:/.test(await page.$eval("#task", (t) => t.value)), "“To the brain” puts the reply in the task box");
  await page.$eval("#task", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });

  // ---------- maximise, focus mode ----------
  console.log("layout modes");
  await page.click('#p-gemini [data-act="max"]');
  ok(await page.$eval("#p-gemini", (el) => el.classList.contains("max")), "panel can be made bigger");
  await shot("05-gemini-max");
  await page.keyboard.press("Escape");
  ok(!(await page.$eval("#p-gemini", (el) => el.classList.contains("max"))), "Esc brings the panel back");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyZ"); await page.keyboard.up("Alt");
  ok(await page.$eval("body", (b) => b.classList.contains("zen")), "Alt+Z turns focus mode on");
  ok(await page.evaluate(() => window.__panels() === 0) && !(await visible("#p-gemini")) && !(await visible("#rail-panels")), "focus mode hides the side panels");
  await shot("06-focus-mode");
  await page.click("#btn-zen");
  ok(!(await page.$eval("body", (b) => b.classList.contains("zen"))), "focus mode turns off");

  // ---------- the workstation ----------
  console.log("workstation");
  const savedLayout = async () => JSON.parse((await (await fetch(`${BASE}/api/settings`)).json()).layout || "{}");
  await page.click("#presets [data-preset=all]");
  await until(() => window.__panels() === 7 && window.__side("left") === "gemini,activity,recent" && window.__side("right") === "usage,music,discord,stats", "Everything shows seven panels");
  await until(() => document.querySelector("#discord-state").textContent === "Running" && document.querySelector("#discord-state").classList.contains("on"), "the Discord panel shows the app is running");
  ok(!(await count("webview")) && /Show the Discord app/.test(await text("#discord-start")) && !(await visible("#discord-beside")) && !(await visible("#discord-back")), "Discord offers the installed app; side by side only in the desktop window");
  await page.click("#discord-start");
  await until(() => [...document.querySelectorAll(".toast")].some((t) => /Bringing Discord to the front/.test(t.textContent)), "the button opens the Discord app");
  // Pinned chats (made-up numbers).
  ok(await visible("#discord-note") && !(await count("#discord-chats li")), "no pinned chats yet: the panel says how to pin one");
  await page.click("#discord-add");
  ok(await visible("#discord-add-form") && await page.evaluate(() => document.activeElement?.id === "discord-add-name"), "+ opens the pin form");
  await page.type("#discord-add-name", "Sam");
  await page.type("#discord-add-link", "not a link");
  await page.click("#discord-add-form [type=submit]");
  await until(() => [...document.querySelectorAll(".toast")].some((t) => /not a Discord chat link/.test(t.textContent)), "a wrong link is refused");
  await page.$eval("#discord-add-link", (el) => { el.value = ""; });
  await page.type("#discord-add-link", "https://discord.com/channels/@me/100000000000000001/900000000000000009");
  await page.click("#discord-add-form [type=submit]");
  await until(() => document.querySelector("#discord-add-form").hidden && document.querySelectorAll("#discord-chats li").length === 1, "a chat is pinned from a message link");
  await page.click("#discord-add");
  await page.type("#discord-add-name", "Gym <b>crew</b>");
  await page.type("#discord-add-link", "https://ptb.discord.com/channels/200000000000000002/300000000000000003");
  await page.keyboard.press("Enter");
  await until(() => document.querySelectorAll("#discord-chats li").length === 2, "a server chat is pinned");
  const pinned = (await (await fetch(`${BASE}/api/settings`)).json()).discordChats;
  ok(JSON.stringify(pinned) === JSON.stringify([{ name: "Sam", place: "@me", chat: "100000000000000001" }, { name: "Gym <b>crew</b>", place: "200000000000000002", chat: "300000000000000003" }]), "pins keep only the name and the two numbers", JSON.stringify(pinned));
  ok(!(await count("#discord-chats b")) && /Gym <b>crew<\/b>/.test(await text("#discord-chats li:nth-child(2) .dc-name")) && !(await visible("#discord-note")), "names show as plain text; the how-to hides");
  await page.click("#discord-chats li:first-child .dc-open");
  await until(() => [...document.querySelectorAll(".toast")].some((t) => /Opening Sam in Discord/.test(t.textContent)), "a click opens that chat in the Discord app");
  await page.click("#discord-chats li:nth-child(2) .dc-del");
  await until(() => document.querySelectorAll("#discord-chats li").length === 1, "a chat is unpinned");
  ok(/Sam/.test(await text("#discord-chats .dc-name")), "the other chat stays pinned");
  ok(await page.evaluate(() => { const t = document.querySelector("#tiles").getBoundingClientRect(); return [...document.querySelectorAll("#tiles > .panel:not(.t-off)")].every((p) => { const r = p.getBoundingClientRect(); return r.left >= t.left - 1 && r.right <= t.right + 1 && r.top >= t.top - 1 && r.bottom <= t.bottom + 1; }); }), "panels fit inside the work area");
  await shot("06a-everything");
  await page.click("#presets [data-preset=focus]");
  await until(() => window.__panels() === 0 && window.__shown("main"), "Focus hides every panel");
  ok(await count(".split:not([hidden])") === 0, "and the lines between them");
  await page.keyboard.down("Alt"); await page.keyboard.press("Digit2"); await page.keyboard.up("Alt");
  await until(() => window.__side("left") === "gemini,activity" && window.__side("right") === "usage,music,stats", "Alt+2 brings back Station");
  // panel menu
  await page.click('#music .p-more');
  await until(() => !document.querySelector("#menu").hidden && document.querySelectorAll("#menu button").length >= 6, "the panel menu opens");
  ok(await page.evaluate(() => document.activeElement?.closest("#menu") !== null), "the menu takes the keyboard");
  await page.$$eval("#menu button", (bs) => bs.find((b) => /left side/.test(b.textContent)).click());
  await until(() => window.__side("left") === "gemini,activity,music" && !window.__side("right").includes("music") && document.querySelector("#menu").hidden, "a panel moves to the other side");
  ok(await page.$eval("#presets [data-preset=station]", (b) => b.getAttribute("aria-pressed") === "false"), "a changed layout is no longer marked Station");
  await page.click('#music .p-more');
  await page.$$eval("#menu button", (bs) => bs.find((b) => /Move up/.test(b.textContent)).click());
  await until(() => window.__side("left") === "gemini,music,activity", "a panel moves up");
  await page.click('#activity .p-more');
  await page.$$eval("#menu button", (bs) => bs.find((b) => /Hide/.test(b.textContent)).click());
  await until(() => !window.__shown("activity") && document.querySelector("#activity").classList.contains("t-off"), "a panel can be hidden");
  ok(await page.$eval("#rail-panels [data-toggle=activity]", (b) => b.getAttribute("aria-pressed") === "false"), "its rail button shows it is hidden");
  await page.click("#rail-panels [data-toggle=activity]");
  await until(() => window.__side("left") === "gemini,music,activity", "the rail button shows it again, in the same place");
  await page.click('#music .p-more');
  await page.keyboard.press("Escape");
  await until(() => document.querySelector("#menu").hidden, "Esc closes the panel menu");
  // collapse
  await page.click("#music .p-head", { count: 2 });
  await until(() => document.querySelector("#music").classList.contains("collapsed"), "double-clicking a panel title collapses it");
  await page.click("#music .p-head", { count: 2 });
  await until(() => !document.querySelector("#music").classList.contains("collapsed"), "and again expands it");
  // splitters
  const w0 = await page.$eval("#p-gemini", (d) => d.getBoundingClientRect().width);
  await page.evaluate(() => [...document.querySelectorAll(".split.v:not([hidden])")].sort((a, b) => a.offsetLeft - b.offsetLeft)[0].focus());
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await until((w) => document.querySelector("#p-gemini").getBoundingClientRect().width >= w + 40, "arrow keys widen the left panels", w0);
  const sp = await page.evaluate(() => { const s = [...document.querySelectorAll(".split.h:not([hidden])")].sort((a, b) => a.offsetLeft - b.offsetLeft || a.offsetTop - b.offsetTop)[0]; const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const g0 = await page.$eval("#p-gemini", (p) => p.getBoundingClientRect().height);
  await page.mouse.move(sp.x, sp.y); await page.mouse.down(); await page.mouse.move(sp.x, sp.y - 80, { steps: 5 }); await page.mouse.up();
  await until((h0) => document.querySelector("#p-gemini").getBoundingClientRect().height < h0 - 50, "dragging a splitter resizes the panels", g0);
  await sleep(900);
  const lay = await savedLayout();
  ok(lay.v === 2 && lay.root?.k?.[0]?.k?.join() === "gemini,music,activity" && lay.root.s[0] >= 330 && lay.root.k[0].s[0] > 0, "the layout is saved on the server", JSON.stringify(lay).slice(0, 300));
  // save as Mine
  await page.click("#btn-layout");
  await until(() => !document.querySelector("#menu").hidden && /Save this layout/.test(document.querySelector("#menu").textContent), "the layout menu opens");
  await page.$$eval("#menu button", (bs) => bs.find((b) => /Save this layout/.test(b.textContent)).click());
  await until(() => !document.querySelector("#presets [data-preset=mine]").hidden && document.querySelector("#presets [data-preset=mine]").getAttribute("aria-pressed") === "true", "Mine appears and is marked");
  await page.click("#presets [data-preset=station]");
  await until(() => window.__side("left") === "gemini,activity", "Station resets the panels");
  await page.keyboard.down("Alt"); await page.keyboard.press("Digit5"); await page.keyboard.up("Alt");
  await until(() => window.__side("left") === "gemini,music,activity", "Alt+5 brings back Mine");
  // usage panel
  await page.click("#presets [data-preset=station]");
  await until(() => /42% used/.test(document.querySelector("#um-5h").textContent) && /17% used/.test(document.querySelector("#um-7d").textContent), "usage panel shows both limits with words");
  await until(() => Number(document.querySelector('#u-claude tr[data-k="session"] td').textContent) >= 1, "usage panel counts this session's tasks");
  ok(await page.$eval('#u-claude tr[data-k="today"] td:last-child', (td) => /^\$|<\$/.test(td.textContent.trim())), "usage panel shows the API-price value");
  ok(await count("#u-chart .col") === 14 && await count("#u-chart .col i") >= 1, "14-day chart with today's bar");
  
  await page.$eval("#u-chart", (c) => c.scrollIntoView({ block: "center" })); await sleep(150);
  const bar2 = await page.$eval("#u-chart .col:last-child", (c) => { const r = c.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.bottom - 4 }; });
  await page.mouse.move(bar2.x, bar2.y);
  await until(() => !document.querySelector("#u-tip").hidden && /task/.test(document.querySelector("#u-tip").textContent), "hovering a day shows a tooltip");
  await page.mouse.move(5, 5);
  ok(/Gemini \d+ today/.test(await text("#sb-gemini")), "status bar counts Gemini requests today");
  await page.click("#activity .p-more");
  await page.$$eval("#menu button", (bs) => bs.find((b) => /Hide/.test(b.textContent)).click());
  await page.click('#usage-panel .p-more');
  await page.$$eval("#menu button", (bs) => bs.find((b) => /Hide/.test(b.textContent)).click());
  await until(() => !window.__shown("usage"), "usage panel hidden");
  await page.click("#usage");
  await until(() => window.__side("right").startsWith("usage"), "clicking the usage meter in the status bar opens the usage panel");
  await page.click("#presets [data-preset=station]");
  await shot("06b-usage-panel");
  // drag a panel by its title to anywhere
  await page.click("#presets [data-preset=station]");
  await until(() => window.__side("left") === "gemini,activity" && window.__side("right") === "usage,music,stats", "back to Station before dragging");
  const headAt = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + 24, y: r.top + r.height / 2 }; });
  const rectOf = (sel) => page.$eval(sel, (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  {
    const from = await headAt("#music .p-head"), g = await rectOf("#p-gemini");
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x - 200, from.y + 20, { steps: 4 });
    await page.mouse.move(g.x + g.w / 2, g.y + g.h * 0.88, { steps: 6 });
    ok(await page.evaluate(() => document.body.classList.contains("moving") && !document.querySelector("#drop-hint").hidden && !document.querySelector("#move-ghost").hidden), "dragging a panel shows where it will land");
    await page.mouse.up();
    await until(() => window.__side("left") === "gemini,music,activity" && window.__side("right") === "usage,stats" && !document.body.classList.contains("moving"), "a panel dropped on the lower half of another goes under it");
  }
  {
    const before = await page.evaluate(() => JSON.stringify(window.Station.layout().root));
    const from = await headAt("#activity .p-head");
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x + 600, from.y - 100, { steps: 6 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await sleep(150);
    ok(await page.evaluate((b) => JSON.stringify(window.Station.layout().root) === b && !document.body.classList.contains("moving") && document.querySelector("#drop-hint").hidden, before), "Esc while dragging leaves everything where it was");
  }
  {
    const from = await headAt("#p-gemini .p-head"), u = await rectOf("#usage-panel");
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(u.x + u.w / 2, u.y + u.h / 2, { steps: 8 });
    ok(/Swap with Usage/.test(await text("#drop-hint")), "the middle of another panel offers a swap");
    await page.mouse.up();
    await until(() => window.__side("left").startsWith("usage") && window.__side("right").startsWith("gemini"), "dropping in the middle swaps the two");
  }
  {
    // The chat moves too: drag it by its top bar to the left edge.
    const st = await rectOf("#stage"), t = await rectOf("#tiles");
    await page.mouse.move(st.x + st.w / 2, st.y + st.h / 2); await page.mouse.down();
    await page.mouse.move(t.x + 6, t.y + t.h / 2, { steps: 8 });
    await page.mouse.up();
    await until(() => window.Station.layout().rects.main.x <= 8 && window.__panels() === 5, "the chat can be dragged to the left edge");
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.activeElement !== null), "nothing scrolls after moving the chat");
  }
  await page.click("#presets [data-preset=station]");
  await until(() => window.__side("left") === "gemini,activity" && window.Station.layout().rects.main.x > 300, "Station puts everything back");
  // a layout saved by an older version (a left and a right dock) still works
  await page.evaluate(() => window.Station.settings({ ...window.Brain.S.settings, layout: JSON.stringify({ v: 1, preset: "", left: { w: 280, items: ["music", "nope"] }, right: { w: 360, items: ["gemini", "stats", "music"] }, sizes: { gemini: 2 }, collapsed: ["stats"] }) }));
  await until(() => window.__side("left") === "music" && window.__side("right") === "gemini,stats" && document.querySelector("#stats").classList.contains("collapsed"), "an old saved layout is turned into the new one");
  ok(await page.evaluate(() => { const r = window.Station.layout().root; return r.d === "r" && r.k.includes("main") && r.k.includes("app"); }), "and it keeps the chat and the program's place");
  await page.click("#presets [data-preset=station]");
  // free-floating panels (Settings or the layout menu)
  await page.evaluate(() => window.Station.setFloat(true));
  await until(() => document.body.classList.contains("floating") && document.querySelector("#set-float").checked, "free-floating can be switched on");
  {
    const tree = await page.evaluate(() => JSON.stringify(window.Station.layout().root));
    const m0 = await page.evaluate(() => window.Station.layout().rects.music);
    const from = await headAt("#music .p-head");
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x - 400, from.y - 120, { steps: 8 });
    await page.mouse.up();
    await until((m) => { const r = window.Station.layout().rects.music; return Math.abs(r.x - (m.x - 400)) <= 12 && Math.abs(r.y - (m.y - 120)) <= 12; }, "a floating panel goes where it is dropped", m0);
    ok(await page.evaluate((t) => JSON.stringify(window.Station.layout().root) === t, tree), "the other panels stay where they are");
    ok(await page.evaluate(() => Number(document.querySelector("#music").style.zIndex) > Number(document.querySelector("#main").style.zIndex)), "it comes to the front");
    const se = await page.$eval("#music .rz-se", (el) => { const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    const r1 = await page.evaluate(() => window.Station.layout().rects.music);
    await page.mouse.move(se.x, se.y); await page.mouse.down();
    await page.mouse.move(se.x + 90, se.y + 70, { steps: 5 });
    await page.mouse.up();
    await until((r) => { const n = window.Station.layout().rects.music; return Math.abs(n.w - (r.w + 90)) <= 12 && Math.abs(n.h - (r.h + 70)) <= 12; }, "dragging a corner resizes it", r1);
    await sleep(800);
    const fl = await savedLayout();
    ok(fl.float === true && Array.isArray(fl.fl?.music) && fl.fl.music.every((v) => v >= -1 && v <= 1.01), "free-floating places are saved", JSON.stringify(fl.fl));
    await shot("06c-free-floating");
    // A panel made bigger covers the work area, floating or not.
    const bigEnough = () => page.$eval("#music", (el) => { const r = el.getBoundingClientRect(); return el.classList.contains("max") && r.width > innerWidth - 200 && r.height > innerHeight - 200 && document.elementFromPoint(r.left + r.width / 2, r.top + 60)?.closest("#music") !== null; });
    await page.evaluate(() => window.Brain.toggleMax(document.querySelector("#music"), true));
    ok(await bigEnough(), "free-floating: a panel made bigger covers everything");
    await page.keyboard.press("Escape");
    await until(() => !document.querySelector("#music").classList.contains("max"), "Esc puts it back");
    // Showing a hidden panel while floating: it appears on top, inside the window.
    await page.evaluate(() => window.Station.hide("activity"));
    await page.evaluate(() => window.Station.show("activity"));
    await until(() => { const l = window.Station.layout(), r = l.rects.activity, t = document.querySelector("#tiles"); return r && r.x >= 0 && r.y >= 0 && r.x + r.w <= t.clientWidth && r.y + r.h <= t.clientHeight && l.saved.z.at(-1) === "activity" && Array.isArray(l.saved.fl.activity); }, "free-floating: a panel shown again lands on top, inside the window");
    // Picking a layout while floating places every panel and keeps floating.
    await page.click("#presets [data-preset=all]");
    await until(() => { const l = window.Station.layout(), t = document.querySelector("#tiles"); return l.float && window.__panels() === 7 && Object.values(l.rects).every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= t.clientWidth + 1 && r.y + r.h <= t.clientHeight + 1) && Object.keys(l.rects).every((k) => Array.isArray(l.saved.fl[k])); }, "free-floating: picking Everything places every panel inside the window");
    // A saved floating layout with a missing spot still shows that panel.
    await page.evaluate(() => { const s = window.Station.layout().saved; delete s.fl.stats; delete s.fl.main; window.Station.settings({ ...window.Brain.S.settings, layout: JSON.stringify(s) }); });
    await until(() => { const r = window.Station.layout().rects; return r.stats?.w > 100 && r.main?.w > 200; }, "free-floating: a saved layout with a missing spot still shows everything");
    await page.click("#presets [data-preset=station]");
    await until(() => window.__panels() === 5 && window.Station.layout().float, "back to Station, still floating");
  // The switch in Settings, and floating survives a reload.
  await page.evaluate(() => window.Station.setFloat(false));
  await page.click("#btn-settings");
  await until(() => document.querySelector("#dlg-settings").open, "Settings opens");
  await page.$eval("#set-float", (el) => el.scrollIntoView({ block: "center" }));
  await page.click("#set-float");
  await until(() => document.body.classList.contains("floating") && window.Station.layout().float, "the Settings switch turns free-floating on");
  await page.keyboard.press("Escape");
  await until(() => !document.querySelector("#dlg-settings").open, "Settings closes");
  {
    const from = await headAt("#music .p-head");
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(from.x - 300, from.y + 40, { steps: 6 });
    await page.mouse.up();
    await sleep(900);
    const m1 = await page.evaluate(() => window.Station.layout().rects.music);
    const other = await newPage();
    await other.goto(BASE, { waitUntil: "load" });
    await other.waitForFunction(() => window.Station?.layout?.().rects.music, { timeout: 15000 });
    const m2 = await other.evaluate(() => ({ float: window.Station.layout().float, on: document.querySelector("#set-float").checked, r: window.Station.layout().rects.music }));
    ok(m2.float && m2.on && Math.abs(m2.r.x - m1.x) <= 2 && Math.abs(m2.r.y - m1.y) <= 2 && Math.abs(m2.r.w - m1.w) <= 2, "free-floating and each spot are kept after a restart", JSON.stringify({ m1, m2 }));
    await other.close();
    await page.bringToFront();
  }
  await page.click("#btn-settings");
  await until(() => document.querySelector("#dlg-settings").open, "Settings opens again");
  await page.$eval("#set-float", (el) => el.scrollIntoView({ block: "center" }));
  await page.click("#set-float");
  await until(() => !document.body.classList.contains("floating") && !window.Station.layout().float, "the Settings switch turns it off again");
  await page.keyboard.press("Escape");
  await page.click("#presets [data-preset=station]");
  await page.evaluate(() => window.Brain.toggleMax(document.querySelector("#music"), true));
  ok(await bigEnough(), "snapped: a panel made bigger covers everything");
  await page.keyboard.press("Escape");
  await until(() => !document.querySelector("#music").classList.contains("max"), "and Esc puts it back");
  }
  await page.evaluate(() => window.Station.setFloat(false));
  await until(() => !document.body.classList.contains("floating") && !document.querySelector("#set-float").checked && window.__side("right") === "usage,music,stats", "switching it off snaps everything back into place");
  ok(!(await visible("#music .rz-se")), "the resize corners hide again");
  // music
  await until(() => document.querySelector("#music-title").textContent === "Test Song One" && !document.querySelector("#music-next").disabled, "music panel shows the playing song");
  ok(await visible("#sb-music") && /Test Song One/.test(await text("#sb-track")), "the status bar shows the song");
  await page.click("#music-next");
  await until(() => document.querySelector("#music-title").textContent === "Second Track", "Next skips the song");
  const playing = await page.$eval("#music-toggle", (b) => b.title);
  await page.click("#sb-toggle");
  await until((t) => document.querySelector("#music-toggle").title !== t, "play/pause from the status bar", playing);
  await page.type("#music-q", "lofi beats");
  await page.keyboard.press("Enter");
  await until(() => [...document.querySelectorAll("#toasts .toast")].some((t) => /Searching Spotify/.test(t.textContent)) && document.querySelector("#music-q").value === "", "searching Spotify from the panel");
  // work modes
  await page.click('#modes [data-mode="extreme"]');
  ok(await page.$eval('#modes [data-mode="extreme"]', (b) => b.getAttribute("aria-checked") === "true") && /careful/.test(await text("#mode-hint")), "Extreme mode is chosen and explained");
  await sendTask("Plan my week carefully");
  await until(() => [...document.querySelectorAll(".msg.you .mode-badge")].some((b) => b.textContent === "extreme"), "the task shows its work mode");
  await idle();
  ok(/Work mode for this task: EXTREME/.test(JSON.parse(fs.readFileSync(path.join(DATA, "fake-claude-args.jsonl"), "utf8").trim().split("\n").pop()).prompt), "Extreme mode reaches the brain");
  await page.focus('#modes [data-mode="extreme"]');
  await page.keyboard.press("ArrowRight");
  ok(await page.$eval('#modes [data-mode="auto"]', (b) => b.getAttribute("aria-checked") === "true"), "arrow keys move between modes (wraps to Auto)");
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight), "still no page scroll with the workstation");

  // ---------- saving answers ----------
  console.log("saved answers");
  await page.$$eval(".msg.claude:not(.note):not(.err)", (els) => [...els[0].querySelectorAll(".act")].find((b) => b.textContent.trim() === "Save").click());
  await until(() => document.querySelector("#saved-count").textContent === "1", "Save adds to Saved answers");
  await until(() => document.querySelectorAll("#toasts .toast").length >= 1, "a confirmation toast appears");
  await page.click("#btn-saved");
  await until(() => document.querySelector("#dlg-saved").open && document.querySelectorAll("#saved-list .saved-item").length === 1, "Saved answers window lists it");
  ok(await page.evaluate(() => document.querySelector("#toasts").parentNode === document.querySelector("#dlg-saved")), "toasts move into the open window");
  await shot("07-saved");
  await page.$eval("#saved-list .saved-item", (el) => [...el.querySelectorAll(".act")].find((b) => /Delete/.test(b.textContent)).click());
  await until(() => document.querySelector("#dlg-confirm").open, "deleting asks first");
  await page.click("#confirm-no");
  await sleep(150);
  ok(await count("#saved-list .saved-item") === 1, "Cancel keeps the saved answer");
  await page.$eval("#saved-list .saved-item", (el) => [...el.querySelectorAll(".act")].find((b) => /Delete/.test(b.textContent)).click());
  await until(() => document.querySelector("#dlg-confirm").open, "confirm opens again");
  await page.click("#confirm-yes");
  await until(() => document.querySelectorAll("#saved-list .saved-item").length === 0 && document.querySelector("#saved-count").textContent === "0", "confirmed delete removes it");
  await closeTop();
  ok((await openDialogs()).length === 0, "Esc closes the window");
  ok(await page.evaluate(() => document.querySelector("#toasts").parentNode === document.body), "toasts return to the page");

  // ---------- prompt library ----------
  console.log("prompt library");
  await page.click("#btn-prompts");
  await until(() => document.querySelector("#dlg-prompts").open && document.querySelectorAll("#prompts-built .p-item").length === 10, "prompt library lists the built-in prompts");
  await page.type("#prompt-title", "My greeting");
  await page.type("#prompt-text", "Write a greeting for {{name}} in {{language}}.");
  await page.click("#prompt-save");
  await until(() => document.querySelectorAll("#prompts-mine .p-item").length === 1, "a new prompt is saved");
  ok(await page.$eval("#prompt-title", (i) => i.value === ""), "the form is cleared");
  ok(await page.$eval("#mine-ideas", (b) => !b.hidden && b.querySelectorAll("button").length === 1 && /My greeting/.test(b.textContent)), "a saved prompt shows as a button on the start screen");
  await shot("08-prompts");
  await page.$eval("#prompts-mine .p-item", (el) => [...el.querySelectorAll(".act")].find((b) => b.textContent.trim() === "Use").click());
  await until(() => document.querySelector("#dlg-input").open && /name/.test(document.querySelector("#input-title").textContent), "using it asks for the first blank");
  await page.keyboard.type("Asta");
  await page.keyboard.press("Enter");
  await until(() => document.querySelector("#dlg-input").open && /language/.test(document.querySelector("#input-title").textContent), "then asks for the second blank");
  await page.keyboard.type("Spanish");
  await page.keyboard.press("Enter");
  await until(() => document.querySelector("#task").value === "Write a greeting for Asta in Spanish.", "blanks are filled into the task box");
  ok((await openDialogs()).length === 0, "the library closes after choosing");
  await page.$eval("#task", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.$eval("#mine-ideas button", (b) => b.click());
  await until(() => document.querySelector("#dlg-input").open && /name/.test(document.querySelector("#input-title").textContent), "the start-screen prompt button asks for the blanks too");
  await closeTop();
  await until(() => !document.querySelector("#dlg-input").open, "cancelling closes it");
  await page.$eval("#task", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });

  // ---------- image studio ----------
  console.log("image studio");
  await page.click("#btn-studio");
  await until(() => document.querySelector("#dlg-studio").open && document.querySelectorAll("#studio-styles button").length === 10, "Image Studio opens with styles");
  await page.type("#studio-text", "A golden clover image on black");
  await page.$$eval("#studio-styles button", (bs) => bs.find((b) => b.textContent === "Anime").click());
  ok(await page.$$eval("#studio-styles button", (bs) => bs.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent).join() === "Anime"), "one style is selected");
  if (await page.$eval("#studio-improve", (c) => c.checked)) await page.$eval("#studio-improve", (c) => c.click());
  await page.click("#studio-go");
  await until(() => /Stop/.test(document.querySelector("#studio-go").textContent), "Create turns into Stop while drawing");
  await until(() => document.querySelectorAll("#studio-result .thumb img").length === 1, "the new picture appears in the studio");
  ok(/Create/.test(await text("#studio-go")), "button returns to Create");
  await shot("09-studio");
  await closeTop();
  await until(() => document.querySelectorAll("#recent-strip .thumb").length === 2, "the new picture is under Recent pictures");
  ok(await page.$$eval("#gemini-log .hm.ask.from-you .hm-text", (els) => /^Generate image:/.test(els[els.length - 1].textContent) && /anime/i.test(els[els.length - 1].textContent)), "the studio request (with style) shows in the Gemini panel");

  // ---------- gallery ----------
  console.log("gallery");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyG"); await page.keyboard.up("Alt");
  await until(() => document.querySelector("#dlg-gallery").open && document.querySelectorAll("#gal-grid .thumb").length === 2, "Alt+G opens the gallery with both pictures");
  await shot("10-gallery");
  await page.click("#gal-grid .thumb");
  await until(() => document.querySelector("#dlg-light").open, "a gallery picture opens in the viewer");
  ok(/1 of 2/.test(await text("#light-name")), "viewer shows the position");
  await page.keyboard.press("ArrowRight");
  await until(() => /2 of 2/.test(document.querySelector("#light-name").textContent), "arrow keys move between pictures");
  await page.click("#light-delete");
  await until(() => document.querySelector("#dlg-confirm").open, "deleting a picture asks first");
  await page.click("#confirm-yes");
  await until(() => !document.querySelector("#dlg-confirm").open && /\.jpg$/.test(document.querySelector("#light-name").textContent.trim()), "after deleting, the viewer shows the remaining picture");
  await until(() => document.querySelectorAll("#gal-grid .thumb").length === 1, "gallery updates after the delete");
  await closeTop();
  await closeTop();
  ok((await openDialogs()).length === 0, "viewer and gallery close with Esc");

  // ---------- command search ----------
  console.log("command search");
  await page.keyboard.down("Control"); await page.keyboard.press("KeyK"); await page.keyboard.up("Control");
  await until(() => document.querySelector("#dlg-palette").open && document.querySelectorAll("#pal-list .pal-item").length > 10, "Ctrl+K opens command search");
  await page.keyboard.type("prompt greeting");
  await until(() => document.querySelectorAll("#pal-list .pal-item").length === 1, "typing filters the list");
  await shot("11-palette");
  await page.$eval("#pal-q", (i) => { i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await page.keyboard.type("help");
  await page.keyboard.press("Enter");
  await until(() => document.querySelector("#dlg-help").open && !document.querySelector("#dlg-palette").open, "Enter runs the command (Help opens)");
  await shot("12-help");
  await closeTop();

  // ---------- settings ----------
  console.log("settings");
  await page.keyboard.down("Control"); await page.keyboard.press("Comma"); await page.keyboard.up("Control");
  await until(() => document.querySelector("#dlg-settings").open, "Ctrl+, opens Settings");
  await until(() => document.querySelectorAll("#set-gemini-model option").length === 3, "Gemini model list is filled");
  await shot("13-settings-dark");
  await page.$eval('input[name="theme"][value="neon"]', (r) => r.click());
  await until(() => document.documentElement.dataset.theme === "neon", "theme switches to neon");
  await shot("14-settings-neon");
  await page.select("#set-model", "haiku");
  await until(() => /Haiku/.test(document.querySelector("#stage-sub").textContent), "brain model changes and shows on the stage");
  await page.$eval("#set-font", (r) => { r.value = "16"; r.dispatchEvent(new Event("input", { bubbles: true })); r.dispatchEvent(new Event("change", { bubbles: true })); });
  await until(() => document.documentElement.style.getPropertyValue("--fs") === "16px" && document.querySelector("#set-font-val").textContent === "16 px", "text size changes");
  await page.$eval("#set-anim", (c) => c.click());
  await until(() => document.documentElement.classList.contains("no-anim"), "animations can be turned off");
  const bgInput = await q("#set-bg-file");
  await bgInput.uploadFile(FIXTURE);
  await until(() => document.querySelector("#bg-custom").classList.contains("on") && !document.querySelector("#row-dim").hidden, "a custom background can be set");
  await shot("15-custom-background");
  await page.click("#set-bg-remove");
  await until(() => !document.querySelector("#bg-custom").classList.contains("on"), "the custom background can be removed");
  await page.$eval('input[name="accent"][value="green"]', (r) => r.click());
  await until(() => document.documentElement.dataset.accent === "green", "accent colour changes");
  await page.$eval("#set-density", (c) => c.click());
  await until(() => document.documentElement.dataset.density === "comfy" || document.documentElement.dataset.density === "roomy" || (document.documentElement.dataset.density && document.documentElement.dataset.density !== "compact"), "roomier spacing can be switched on");
  await page.$eval("#set-density", (c) => c.click());
  await until(() => document.documentElement.dataset.density === "compact", "and back to compact");
  await page.$eval("#set-clock24", (c) => c.click());
  await until(() => /AM|PM|am|pm/.test(document.querySelector("#sb-clock").textContent), "the clock switches to 12-hour");
  await page.$eval("#set-clock24", (c) => c.click());
  await until(() => !/AM|PM|am|pm/.test(document.querySelector("#sb-clock").textContent), "and back to 24-hour");
  await page.$eval('input[name="accent"][value="blue"]', (r) => r.click());
  await page.$eval("#set-chatgpt", (c) => c.click());
  await until(() => !document.querySelector("#rail-panels [data-toggle=chatgpt]").hidden && !document.querySelector("#chips .chip[data-who='chatgpt']").hidden, "ChatGPT can be switched on");
  const saved = await (await fetch(`${BASE}/api/settings`)).json();
  ok(saved.theme === "neon" && saved.brainModel === "haiku" && saved.fontSize === 16 && saved.animations === false && saved.chatgptEnabled === true && saved.customBg === null, "settings are stored on the server", JSON.stringify(saved));
  await closeTop();
  await page.click("#rail-panels [data-toggle=chatgpt]");
  await until(() => window.__side("left").includes("chatgpt"), "the ChatGPT panel can be shown from the rail");
  await shot("16-neon-two-helpers");

  // ---------- both helpers ----------
  console.log("both helpers");
  await sendTask("Ask everyone [both]");
  await until(() => document.querySelectorAll("#chatgpt-log .hm.reply .md").length === 1, "ChatGPT's reply shows in its panel");
  await until(() => document.querySelectorAll("#gemini-log .hm.reply.err").length === 1, "Gemini's failure shows as an error");
  await idle();
  // ChatGPT usage: one direct message, then the Usage panel and status bar show it.
  await fetch(`${BASE}/api/ask`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ to: "chatgpt", text: "usage check" }) });
  await until(() => /ChatGPT [1-9]\d* today · week 23%/.test(document.querySelector("#sb-chatgpt").textContent) && !document.querySelector("#sb-chatgpt").hidden, "status bar counts ChatGPT requests and shows its weekly limit");
  await page.click("#sb-chatgpt");
  await until(() => window.__shown("usage"), "clicking the ChatGPT counter opens the usage panel");
  await until(() => /23% used/.test(document.querySelector("#uc-long").textContent) && /8% used/.test(document.querySelector("#uc-short").textContent), "usage panel shows ChatGPT's 5-hour and weekly limits");
  ok(/Weekly limit/.test(await text("#uc-long-name")) && /5-hour limit/.test(await text("#uc-short-name")) && /^Resets/.test(await text("#uc-long-note")), "ChatGPT limits are named and show when they reset");
  ok(Number(await text('#u-chatgpt tr[data-k="today"] td')) >= 1 && (await text('#u-chatgpt tr[data-k="today"] td:nth-child(4)')) !== "–", "usage panel counts ChatGPT requests and tokens");
  ok(/last reported/.test(await text("#u-chatgpt-note")), "the panel says where the limits come from");
  await page.$eval("#uc-long", (el) => el.scrollIntoView({ block: "center" })); await sleep(150);
  await shot("16b-chatgpt-usage");
  const args = fs.readFileSync(path.join(DATA, "fake-claude-args.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  ok(args[args.length - 1].args.join(" ").includes("--model haiku"), "the chosen model is passed to the brain");

  // ---------- sessions ----------
  console.log("sessions");
  const before = await count(".msg");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyN"); await page.keyboard.up("Alt");
  await until(() => document.querySelectorAll(".msg").length === 0 && !document.querySelector("#empty").hidden, "Alt+N starts an empty session");
  ok((await text("#session-title")) === "New session", "title resets");
  ok((await text("#st-tasks")) === "0" && await count("#gemini-log .hm") === 0 && await count("#log .log-line") === 0, "panels and counters reset");
  await sendTask("Second session task");
  await until(() => document.querySelectorAll(".msg.you").length === 1, "task in the new session");
  await idle();
  ok(args.length > 0 && !JSON.parse(fs.readFileSync(path.join(DATA, "fake-claude-args.jsonl"), "utf8").trim().split("\n").pop()).args.includes("--resume"), "a new session starts a fresh brain conversation");
  await page.click("#btn-sessions");
  await until(() => document.querySelector("#dlg-sessions").open && document.querySelectorAll("#sess-list .sess").length === 2, "sessions drawer lists both sessions");
  await shot("17-sessions");
  await page.type("#sess-q", "hello");
  await until(() => document.querySelectorAll("#sess-list .sess").length === 1 && /Say hello/.test(document.querySelector("#sess-list .sess-title").textContent), "search finds the first session");
  await page.$eval("#sess-list .sess .sess-btns button[aria-label='Pin']", (b) => b.click());
  await until(() => !!document.querySelector("#sess-list .sess .icon-btn.pinned"), "a session can be pinned");
  await page.$eval("#sess-list .sess .sess-btns button[aria-label='Rename']", (b) => b.click());
  await until(() => document.querySelector("#dlg-input").open, "rename asks for a name");
  await page.keyboard.type("Renamed session");
  await page.keyboard.press("Enter");
  await page.$eval("#sess-q", (i) => { i.value = ""; i.dispatchEvent(new Event("input", { bubbles: true })); });
  await until(() => document.querySelectorAll("#sess-list .sess").length === 2 && document.querySelector("#sess-list .sess .sess-title").textContent.trim() === "Renamed session", "renamed and pinned session is listed first");
  await page.click("#sess-list .sess");
  await until(() => !document.querySelector("#dlg-sessions").open && document.querySelector("#session-title").textContent === "Renamed session", "clicking a session opens it");
  await until((n) => document.querySelectorAll(".msg").length === n, "the whole conversation is restored", before);
  ok((await text("#st-tasks")) === "12" || Number(await text("#st-tasks")) >= 10, "counters are rebuilt from history");
  ok(await count(".typing") === 0, "nothing is left “working” after a replay");
  ok(await page.evaluate(() => window.__xss === undefined), "replaying the unsafe answer is still safe");
  ok(await page.evaluate(() => { const t = document.querySelector("#thread"); return t.scrollHeight - t.scrollTop - t.clientHeight < 90; }), "restored conversation is scrolled to the end");
  await sendTask("Follow-up question");
  await idle();
  await sleep(200);
  ok(JSON.parse(fs.readFileSync(path.join(DATA, "fake-claude-args.jsonl"), "utf8").trim().split("\n").pop()).args.includes("--resume"), "a follow-up continues the same brain conversation");
  await page.click("#btn-sessions");
  await until(() => document.querySelectorAll("#sess-list .sess").length === 2, "drawer opens again");
  await page.$$eval("#sess-list .sess", (els) => els.find((e) => !e.classList.contains("active")).querySelector("button[aria-label='Delete']").click());
  await until(() => document.querySelector("#dlg-confirm").open, "deleting a session asks first");
  await page.click("#confirm-yes");
  await until(() => document.querySelectorAll("#sess-list .sess").length === 1, "the session is deleted");
  await closeTop();

  // ---------- attaching a file ----------
  console.log("attachments");
  const fileInput = await q("#file-input");
  await fileInput.uploadFile(FIXTURE);
  await until(() => document.querySelectorAll("#attachments .file-chip:not(.loading)").length === 1 && !!document.querySelector("#attachments .file-chip img"), "an uploaded picture shows as a chip with a preview");
  await page.click("#attachments .file-chip button");
  ok(await count("#attachments .file-chip") === 0, "an attachment can be removed");
  await fileInput.uploadFile(FIXTURE);
  await until(() => document.querySelectorAll("#attachments .file-chip:not(.loading)").length === 1, "attached again");
  await page.click("#btn-send");
  await until(() => [...document.querySelectorAll(".msg.you .bubble")].some((b) => /attached files/.test(b.textContent)), "sending only a file uses a default question");
  await idle();
  ok(/fixture/.test(JSON.parse(fs.readFileSync(path.join(DATA, "fake-claude-args.jsonl"), "utf8").trim().split("\n").pop()).prompt), "the file path reaches the brain");

  // ---------- composer memory ----------
  console.log("composer");
  await page.click("#task");
  await page.keyboard.press("ArrowUp");
  ok(/attached files/.test(await page.$eval("#task", (t) => t.value)), "Up arrow recalls the last task");
  await page.keyboard.press("ArrowDown");
  ok(await page.$eval("#task", (t) => t.value === ""), "Down arrow clears it again");
  await page.keyboard.type("line one");
  await page.keyboard.down("Shift"); await page.keyboard.press("Enter"); await page.keyboard.up("Shift");
  await page.keyboard.type("line two");
  ok(await page.$eval("#task", (t) => t.value === "line one\nline two"), "Shift+Enter makes a new line");
  await sleep(450);

  // ---------- reload ----------
  console.log("reload");
  const n1 = await count(".msg");
  await page.reload({ waitUntil: "load" });
  await until((n) => document.querySelectorAll(".msg").length === n, "after a reload the conversation is back", n1);
  ok(await page.$eval("#task", (t) => t.value === "line one\nline two"), "the unsent draft survives a reload");
  ok(await page.evaluate(() => document.documentElement.dataset.theme === "neon"), "the theme survives a reload");
  const layoutNow = await page.evaluate(() => Object.keys(window.Station.layout().rects).join());
  ok(/chatgpt/.test(layoutNow) && /gemini/.test(layoutNow), "the panel layout survives a reload", layoutNow);
  await page.$eval("#task", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });

  // ---------- reconnect mid-task ----------
  console.log("join mid-task");
  await sendTask("Slow one [slow] " + "word ".repeat(40));
  await until(() => document.querySelector(".msg.live .md")?.textContent.length > 20, "slow task is streaming");
  const page2 = page; page = await newPage(1366, 768);
  await page.goto(BASE, { waitUntil: "load" });
  await until(() => !!document.querySelector(".msg.live") && document.querySelector(".msg.live .md").textContent.length > 20, "a second window joins the running task with the text so far");
  ok(!(await page.$eval("#btn-stop", (b) => b.hidden)), "the second window shows Stop");
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight), "page does not scroll at 1366x768");
  await shot("18-neon-1366-working");
  await idle("second window sees the task finish");
  await page.$eval('input[name="theme"][value="dark"]', (r) => r.click());
  await until(() => document.documentElement.dataset.theme === "dark", "back to the dark theme");
  await sleep(300);
  await shot("19-dark-1366");
  ok(await page2.evaluate(() => document.documentElement.dataset.theme === "dark"), "the first window follows the theme change");
  await page.close(); page = page2;
  await page.bringToFront();
  await idle("first window is idle too");
  await page.$eval("#set-anim", (c) => { if (!c.checked) c.click(); });
  await until(() => !document.documentElement.classList.contains("no-anim"), "animations back on");
  await sleep(400);
  await shot("20-dark-1680-full");

  // ---------- theme button and the Goth theme ----------
  console.log("theme button and Goth");
  await page.click("#btn-theme");
  await until(() => !document.querySelector("#menu").hidden && document.querySelectorAll("#menu .menu-sw").length === 4, "the theme button lists four themes with colours");
  ok(await page.$$eval("#menu button[data-value]", (bs) => bs.map((b) => b.dataset.value).join() === "dark,neon,goth,berserk"), "the themes are Dark, Neon, Goth and Berserk (the Black Clover ones are gone)");
  ok(await page.$eval('#menu button[data-value="dark"]', (b) => b.getAttribute("aria-checked") === "true"), "the current theme is ticked");
  await page.click('#menu button[data-value="goth"]');
  await until(() => document.documentElement.dataset.theme === "goth", "picking Goth switches the theme");
  await until(async () => (await (await fetch("/api/settings")).json()).theme === "goth", "Goth is saved on the server");
  await page.evaluate(() => document.fonts.ready);
  ok(await page.evaluate(() => document.fonts.check('20px "Pirata One"') && document.fonts.check('700 14px "Cormorant Garamond"')), "the Goth fonts load from the app (no internet needed)");
  ok(await page.$eval(".brand-name", (el) => /Pirata One/.test(getComputedStyle(el).fontFamily) && getComputedStyle(el).textTransform === "none"), "the Goth title font is used without capitals");
  ok(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fx-dir").trim() === "down"), "in Goth the ash falls down");
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight), "Goth: page does not scroll");
  await sleep(500);
  await shot("20b-goth-1680");

  // ---------- Berserk ----------
  console.log("Berserk theme");
  await page.keyboard.down("Control"); await page.keyboard.press("KeyK"); await page.keyboard.up("Control");
  await until(() => document.querySelector("#dlg-palette").open, "command search opens");
  await page.keyboard.type("theme berserk");
  await until(() => document.querySelectorAll("#pal-list .pal-item").length === 1, "Ctrl+K finds the Berserk theme");
  await page.keyboard.press("Enter");
  await until(() => document.documentElement.dataset.theme === "berserk", "Ctrl+K switches to Berserk");
  await until(async () => (await (await fetch("/api/settings")).json()).theme === "berserk", "Berserk is saved on the server");
  await page.evaluate(() => document.fonts.ready);
  ok(await page.$eval(".brand-name", (el) => /Cinzel/.test(getComputedStyle(el).fontFamily) && getComputedStyle(el).textTransform === "uppercase"), "Berserk uses the carved capital title font");
  ok(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--fx-dir").trim() === ""), "in Berserk the embers rise");
  ok(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#c8282f"), "Berserk is blood red");
  ok(await page.evaluate(() => { const e = document.querySelector("#empty"); if (!e || e.offsetParent === null) return true;
    const marks = [...e.querySelectorAll(".empty-mark")].map((m) => getComputedStyle(m).display); return marks[0] === "none" && marks[1] !== "none"; }), "the start screen shows the red eclipse");
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight), "Berserk: page does not scroll");
  await sleep(500);
  await shot("20c-berserk-1680");
  // a choice the server does not accept is not shown as saved
  await page.$eval('input[name="theme"][value="neon"]', (r) => { r.value = "no-such-theme"; r.dispatchEvent(new Event("change")); r.value = "neon"; });
  await until(() => [...document.querySelectorAll(".toast.err")].some((t) => /not saved/.test(t.textContent)), "a setting the server refuses shows a 'not saved' message");
  ok(await page.evaluate(() => document.documentElement.dataset.theme === "berserk"), "and the theme stays as it was");
  await page.keyboard.down("Control"); await page.keyboard.press("KeyK"); await page.keyboard.up("Control");
  await until(() => document.querySelector("#dlg-palette").open, "command search opens");
  await page.keyboard.type("theme dark");
  await until(() => document.querySelectorAll("#pal-list .pal-item").length === 1, "Ctrl+K has one entry per theme");
  await page.keyboard.press("Enter");
  await until(() => document.documentElement.dataset.theme === "dark" && !document.querySelector("#dlg-palette").open, "Ctrl+K switches back to Dark");
  await page.click("#btn-theme");
  await until(() => !document.querySelector("#menu").hidden, "theme menu opens again");
  await page.$$eval("#menu button", (bs) => bs.find((b) => /More in Settings/.test(b.textContent)).click());
  await until(() => document.querySelector("#dlg-settings").open && document.querySelector('.theme-card[data-t="goth"]') && document.querySelector('.theme-card[data-t="berserk"]'), "'More in Settings' opens Settings, which has Goth and Berserk cards");
  ok(await page.$$eval(".theme-card", (c) => c.length === 4 && !document.querySelector('.theme-card[data-t="clover"],.theme-card[data-t="demon"],.theme-card[data-t="wind"]')), "Settings has four theme cards, none of the removed ones");
  ok(await page.$eval(".about", () => /Berserk theme is a fan-made look/.test(document.querySelector("#dlg-settings").textContent) && !/Black Clover/.test(document.body.innerHTML)), "About says Berserk is fan-made; Black Clover is mentioned nowhere");
  await closeTop();
  await until(() => !document.querySelector("#dlg-settings").open, "Settings closes");

  // ---------- Claude asks before it changes something ----------
  console.log("file and command access");
  await page.keyboard.down("Control"); await page.keyboard.press("Comma"); await page.keyboard.up("Control");
  await until(() => document.querySelector("#dlg-settings").open && document.querySelector("#set-access").value === "read" && document.querySelector("#row-folders").hidden, "access is Read only by default, no folder list");
  await page.select("#set-access", "ask");
  await until(() => document.querySelector("#dlg-confirm").open && /change files/.test(document.querySelector("#confirm-title").textContent), "turning access on asks first");
  await page.click("#confirm-no");
  await until(() => document.querySelector("#set-access").value === "read", "cancel keeps Read only");
  ok((await (await fetch(`${BASE}/api/settings`)).json()).access === "read", "nothing was saved after cancel");
  await page.select("#set-access", "ask");
  await until(() => document.querySelector("#dlg-confirm").open, "asked again");
  await page.click("#confirm-yes");
  await until(() => !document.querySelector("#row-folders").hidden && /Every change waits/.test(document.querySelector("#set-access-note").textContent), "access on: the folder list shows");
  ok(/Only its own workspace/.test(await text("#set-folders")), "no extra folders yet");
  const extraDir = path.join(DATA, "ui-extra");
  fs.mkdirSync(extraDir, { recursive: true });
  await page.click("#set-folder-add");
  await until(() => document.querySelector("#dlg-input").open, "Add folder asks for a path");
  await page.type("#input-value", "C:\\");
  await page.keyboard.press("Enter");
  await until(() => [...document.querySelectorAll(".toast.err")].some((t) => /whole drive/.test(t.textContent)), "a whole drive is refused with a reason");
  await sleep(200);
  problems.splice(0, problems.length, ...problems.filter((p) => !/http 400: .*\/api\/settings/.test(p) && !/status of 400 \(Bad Request\)/.test(p)));
  await page.click("#set-folder-add");
  await until(() => document.querySelector("#dlg-input").open, "Add folder again");
  await page.type("#input-value", extraDir);
  await page.keyboard.press("Enter");
  await until((d) => document.querySelector("#set-folders code")?.textContent === d, "a good folder is listed", extraDir);
  await closeTop();
  await sendTask("Please write a file [change] [slow]");
  await until(() => document.querySelector("#dlg-approve").open, "Claude's change opens the approval dialog");
  ok(/write a file/.test(await text("#ap-title")) && (await text("#ap-tool")) === "Write" && (await text("#ap-path")).endsWith("fake-change.txt") && (await text("#ap-detail")) === "hello from the brain", "it shows the tool, the full path and the full new text");
  ok(await visible("#ap-all") && await page.evaluate(() => document.activeElement?.id === "ap-deny"), "allow-all offered for file changes; Deny has the focus");
  await shot("21-approve-dialog");
  await page.click("#ap-allow");
  await until(() => !document.querySelector("#dlg-approve").open, "Allow closes the dialog");
  await idle("the task finishes after Allow");
  ok(/Results: allowed/.test(await page.$$eval(".msg.claude .md", (m) => m.at(-1)?.textContent || "")), "Claude reports the change was allowed");
  ok(fs.existsSync(path.join(DATA, "workspace", "fake-change.txt")), "the file was written after the click");
  ok(await page.$$eval(".log-line", (ls) => ls.some((l) => /Allowed: Write/.test(l.textContent))), "the activity log records the decision");
  fs.unlinkSync(path.join(DATA, "workspace", "fake-change.txt"));
  await sendTask("Run something [command]");
  await until(() => document.querySelector("#dlg-approve").open && document.querySelector("#ap-detail").textContent === "Get-Date -Format yyyy", "a command shows its full text");
  ok(!(await visible("#ap-all")) && /Runs in /.test(await text("#ap-cwd")) && (await text("#ap-note")) === "Show the year", "commands: no allow-all; the folder and reason are shown");
  await page.keyboard.press("Escape");
  await until(() => !document.querySelector("#dlg-approve").open, "Esc closes the question");
  await idle("the task finishes after Esc");
  ok(/denied/.test(await page.$$eval(".msg.claude .md", (m) => m.at(-1)?.textContent || "")), "Esc counts as Deny");
  // A second window sees the same question; answering in one closes it in both.
  await sendTask("Two windows [change]");
  await until(() => document.querySelector("#dlg-approve").open, "the question is open in the first window");
  const pageB = await newPage(1366, 768);
  await pageB.goto(BASE, { waitUntil: "load" });
  await pageB.waitForFunction(() => document.querySelector("#dlg-approve").open, { timeout: 8000 }).then(() => ok(true, "a window that opens now shows the waiting question"), () => ok(false, "a window that opens now shows the waiting question"));
  await pageB.click("#ap-deny");
  await until(() => !document.querySelector("#dlg-approve").open, "answering in one window closes it in the other");
  await idle();
  ok(!fs.existsSync(path.join(DATA, "workspace", "fake-change.txt")), "denied: nothing was written");
  await pageB.close();
  await page.bringToFront();
  await page.reload({ waitUntil: "load" });
  await sleep(600);
  ok(!(await page.$eval("#dlg-approve", (d) => d.open)), "a reload never reopens an answered question");
  // Always allow: from the question itself, then from Settings.
  ok(await page.evaluate(() => { const b = document.querySelector("#sb-access"); return !b.hidden && b.textContent === "Asks first" && !b.classList.contains("warn"); }), "the bottom bar says Claude asks first");
  await sendTask("Stop asking me [change]");
  await until(() => document.querySelector("#dlg-approve").open, "a question opens");
  await page.click("#ap-always");
  await until(() => document.querySelector("#dlg-confirm").open && /Always allow/.test(document.querySelector("#confirm-title").textContent), "Always allow asks once if you are sure");
  await page.click("#confirm-yes");
  await until(() => !document.querySelector("#dlg-approve").open && !document.querySelector("#dlg-confirm").open, "the question closes by itself");
  await until(() => /Results: allowed/.test([...document.querySelectorAll(".msg.claude .md")].at(-1)?.textContent || ""), "the task finishes without another click");
  await idle();
  ok(fs.existsSync(path.join(DATA, "workspace", "fake-change.txt")), "always allow: the waiting change went through");
  fs.rmSync(path.join(DATA, "workspace", "fake-change.txt"), { force: true });
  ok(await page.evaluate(() => { const b = document.querySelector("#sb-access"); return !b.hidden && b.textContent === "Always allow" && b.classList.contains("warn"); }), "the bottom bar shows Always allow");
  await sendTask("Two more [twice]");
  for (let i = 0; i < 80 && !fs.existsSync(path.join(DATA, "workspace", "fake-change-2.txt")); i++) await sleep(100);
  await until(() => /Results: allowed; allowed/.test([...document.querySelectorAll(".msg.claude .md")].at(-1)?.textContent || ""), "always allow: the next task finishes by itself");
  await idle("always allow: the next task never asks");
  ok(!(await page.$eval("#dlg-approve", (d) => d.open)) && fs.existsSync(path.join(DATA, "workspace", "fake-change-2.txt")) && await page.$$eval(".log-line", (ls) => ls.filter((l) => /Allowed .always allow is on.: Write/.test(l.textContent)).length >= 2), "always allow: files change with no question, and Activity lists each one");
  for (const f of ["fake-change-1.txt", "fake-change-2.txt"]) fs.rmSync(path.join(DATA, "workspace", f), { force: true });
  await page.click("#sb-access");
  await until(() => document.querySelector("#dlg-settings").open && document.querySelector("#set-access").value === "auto" && /without asking/.test(document.querySelector("#set-access-note").textContent) && !document.querySelector("#row-folders").hidden, "the bottom bar opens Settings, which shows Always allow");
  await page.select("#set-access", "ask");
  await until(() => document.querySelector("#sb-access").textContent === "Asks first", "switching back to asking needs no question");
  await page.select("#set-access", "auto");
  await until(() => document.querySelector("#dlg-confirm").open, "choosing Always allow in Settings asks if you are sure");
  await page.click("#confirm-no");
  await until(() => document.querySelector("#set-access").value === "ask" && !document.querySelector("#dlg-confirm").open, "Cancel keeps asking");
  await page.select("#set-access", "read");
  await until(() => document.querySelector("#sb-access").hidden && document.querySelector("#row-folders").hidden, "Read only hides the badge again");
  await page.keyboard.press("Escape");
  await fetch(`${BASE}/api/settings`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ access: "read", folders: [] }) });

  // ---------- video ----------
  console.log("video studio");
  {
    const pressed = (sel) => page.$$eval(`${sel} button`, (bs) => bs.filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent.trim()).join());
    const pick = (sel, label) => page.$$eval(`${sel} button`, (bs, l) => bs.find((b) => b.textContent.trim() === l).click(), label);
    await page.keyboard.down("Alt"); await page.keyboard.press("KeyV"); await page.keyboard.up("Alt");
    await until(() => document.querySelector("#dlg-studio").open && !document.querySelector("#studio-vid").hidden && document.querySelector("#studio-pic").hidden && document.querySelector("#t-studio").textContent === "Video Studio", "Alt+V opens the Video Studio");
    await until(() => !document.querySelector("#video-nokey").hidden && document.querySelector("#studio-go").disabled, "without a Google key it says video is not connected, and Create is off");
    await shot("24-video-not-connected");
    await page.click("#video-setup");
    await until(() => document.querySelector("#dlg-settings").open && document.querySelector("#set-video-state").textContent === "Not connected" && document.querySelector("#set-video-remove").hidden, "Set it up opens Settings at the Video section");
    ok(await page.$eval("#set-video-key", (el) => el.type === "password" && document.activeElement === el), "the key box is a password field and is ready to type in");
    await page.type("#set-video-key", "AIzaTestKey_0123456789abcdefghijklmnopqrWXYZ");
    await page.click("#set-video-save");
    await until(() => document.querySelector("#set-video-state").textContent === "Connected (key ends in WXYZ)" && !document.querySelector("#set-video-remove").hidden && document.querySelector("#set-video-key").value === "", "saving the key connects video and empties the box");
    ok(!(await page.content()).includes("AIzaTestKey"), "the key is nowhere on the page afterwards");
    ok(await page.$eval("#set-video-model", (s) => s.options.length >= 3 && s.value === "veo-3.1-generate-preview") && await page.$eval("#set-video-limit", (i) => i.value === "10"), "Settings shows the video model (Veo 3.1) and the daily limit (10)");
    await page.$eval("#sec-video", (el) => el.scrollIntoView());
    await shot("25-video-settings");
    await closeTop();
    await until(() => !document.querySelector("#dlg-settings").open && document.querySelector("#dlg-studio").open && document.querySelector("#video-nokey").hidden && !document.querySelector("#studio-go").disabled, "back in the studio, video is ready");
    ok(await pressed("#video-lengths") === "8 seconds" && await pressed("#video-quality") === "720p" && await pressed("#video-shapes") === "Wide (16:9)", "starts with 8 seconds, 720p, wide");
    await pick("#video-lengths", "4 seconds");
    await pick("#video-quality", "1080p");
    ok(await pressed("#video-lengths") === "8 seconds", "choosing 1080p moves the length to 8 seconds");
    await pick("#video-lengths", "6 seconds");
    ok(await pressed("#video-quality") === "720p", "choosing a shorter length moves the quality back to 720p");
    await pick("#video-shapes", "Tall (9:16)");
    await page.type("#video-text", "A golden clover turning in the wind");
    await page.click("#studio-go");
    await until(() => /Stop/.test(document.querySelector("#studio-go").textContent) && /making your video… \d:\d\d/.test(document.querySelector("#video-status").textContent), "Create turns into Stop and a timer runs");
    await until(() => document.querySelectorAll("#video-result video[controls]").length === 1 && /Done/.test(document.querySelector("#video-status").textContent), "the new video appears in the studio with a player");
    ok(/Create video/.test(await text("#studio-go")) && /Today: 1 of 10/.test(await text("#studio-note")), "the button returns to Create video and today's count goes up");
    ok(await page.$eval("#video-result video", (v) => new Promise((res) => { if (v.readyState >= 1) res(v.duration > 0); else { v.addEventListener("loadedmetadata", () => res(v.duration > 0)); v.addEventListener("error", () => res(false)); } })), "the video really loads in the player");
    await shot("26-video-studio");
    ok(await page.$$eval("#gemini-log .hm.ask.from-you .hm-text", (els) => /^Generate video: A golden clover/.test(els[els.length - 1].textContent)) && await page.$$eval("#gemini-log .hm.reply", (els) => /6 seconds, 9:16/.test(els[els.length - 1].textContent)), "the video request and its result show in the Gemini panel");
    await until(() => document.querySelectorAll("#recent-strip .thumb video").length === 1, "the video is under Recent pictures");

    // stop
    await page.$eval("#video-text", (el) => { el.value = "[slow] a long one"; });
    await page.click("#studio-go");
    await until(() => /Stop/.test(document.querySelector("#studio-go").textContent), "a second video starts");
    ok(await page.$eval("#sb-video", (el) => !el.hidden && /^Making a video… \d:\d\d$/.test(el.textContent)), "the status bar shows that a video is being made");
    await page.click("#studio-go");
    await until(() => /Create video/.test(document.querySelector("#studio-go").textContent) && document.querySelector("#video-status").textContent === "Stopped.", "Stop cancels the video");
    ok(await page.$eval("#sb-video", (el) => el.hidden), "and the status bar note goes away");
    ok(/Today: 1 of 10/.test(await text("#studio-note")), "a stopped video is not counted");

    // a reload while a video is being made keeps the Stop button
    await page.click("#studio-go");
    await until(() => /Stop/.test(document.querySelector("#studio-go").textContent), "a third video starts");
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.Station && document.querySelector("#studio-go"), { timeout: 15000 });
    await page.keyboard.down("Alt"); await page.keyboard.press("KeyV"); await page.keyboard.up("Alt");
    await until(() => document.querySelector("#dlg-studio").open && /Stop/.test(document.querySelector("#studio-go").textContent), "after a reload the running video still shows Stop");
    await page.click("#studio-go");
    await until(() => /Create video/.test(document.querySelector("#studio-go").textContent), "and it can still be stopped");
    await closeTop();

    // from a picture
    await page.keyboard.down("Alt"); await page.keyboard.press("KeyG"); await page.keyboard.up("Alt");
    await until(() => document.querySelector("#dlg-gallery").open && document.querySelectorAll("#gal-grid .thumb img").length >= 1 && document.querySelectorAll("#gal-grid .thumb video").length === 1, "the Gallery shows pictures and the video");
    ok(await page.$eval("#gal-kind", (el) => !el.hidden), "the Gallery offers All / Pictures / Videos");
    await page.click('#gal-kind [data-kind="video"]');
    await until(() => document.querySelectorAll("#gal-grid .thumb video").length === 1 && document.querySelectorAll("#gal-grid .thumb img").length === 0, "Videos shows only the video");
    await page.click('#gal-kind [data-kind="pic"]');
    await until(() => document.querySelectorAll("#gal-grid .thumb video").length === 0 && document.querySelectorAll("#gal-grid .thumb img").length >= 1, "Pictures shows only pictures");
    await page.click('#gal-kind [data-kind="all"]');
    await until(() => document.querySelectorAll("#gal-grid .thumb video").length === 1 && document.querySelectorAll("#gal-grid .thumb img").length >= 1, "All shows both again");
    await until(() => !document.querySelector("#u-video").hidden && /^Videos \(Google Veo\): 1 today · 1 all time · 6 seconds/.test(document.querySelector("#u-video").textContent) && /· 1 video$/.test(document.querySelector("#sb-gemini").textContent), "Usage and the status bar count the video");
    await page.$eval("#gal-grid .thumb video", (el) => el.closest(".thumb").click());
    await until(() => document.querySelector("#dlg-light").open && !!document.querySelector("#light-fig video") && document.querySelector("#light-animate").hidden, "a video opens in the viewer, without the Make a video button");
    await closeTop();
    await page.$eval("#gal-grid .thumb img", (el) => el.closest(".thumb").click());
    await until(() => document.querySelector("#dlg-light").open && !document.querySelector("#light-animate").hidden, "a picture in the viewer has a Make a video button");
    await page.click("#light-animate");
    await until(() => document.querySelector("#dlg-studio").open && !document.querySelector("#dlg-light").open && !document.querySelector("#dlg-gallery").open && !document.querySelector("#video-from").hidden && document.querySelector("#row-video-improve").hidden, "it opens the Video Studio with that picture as the start");
    await page.$eval("#video-text", (el) => { el.value = "make it move gently"; });
    await page.click("#studio-go");
    await until(() => document.querySelectorAll("#video-result video").length === 1, "the video from a picture is made");
    ok(await page.$$eval("#gemini-log .hm.reply", (els) => /from a picture/.test(els[els.length - 1].textContent)), "the result says it started from a picture");
    await page.click("#video-from-clear");
    await until(() => document.querySelector("#video-from").hidden && !document.querySelector("#row-video-improve").hidden, "the start picture can be removed");

    // improve with Claude: the brain makes the video
    await page.$eval("#video-text", (el) => { el.value = "a [video] of a clover"; });
    await page.$eval("#video-improve", (c) => { if (!c.checked) c.click(); });
    await page.click("#studio-go");
    await until(() => !document.querySelector("#dlg-studio").open, "with Let Claude improve, the studio hands the job to the brain");
    await until(() => document.querySelectorAll(".msg.claude:not(.live) .thumb video").length >= 1, "the brain's answer shows the video");
    await idle();

    // the other model, the limit, and removing the key
    await page.keyboard.down("Control"); await page.keyboard.press("Comma"); await page.keyboard.up("Control");
    await until(() => document.querySelector("#dlg-settings").open && /Made today: [23]/.test(document.querySelector("#set-video-today").textContent), "Settings shows how many videos were made today");
    await page.select("#set-video-model", "models/gemini-omni-1.2-flash");
    await closeTop();
    await page.keyboard.down("Alt"); await page.keyboard.press("KeyV"); await page.keyboard.up("Alt");
    await until(() => document.querySelector("#dlg-studio").open && document.querySelector("#video-quality-box").hidden && [...document.querySelectorAll("#video-lengths button")].map((b) => b.textContent).join() === "5 seconds,10 seconds" && /Gemini Omni 1\.2 Flash/.test(document.querySelector("#studio-note").textContent), "the other Google model offers 5 or 10 seconds and no quality choice");
    await closeTop();
    await page.keyboard.down("Control"); await page.keyboard.press("Comma"); await page.keyboard.up("Control");
    await until(() => document.querySelector("#dlg-settings").open, "Settings opens");
    await page.select("#set-video-model", "veo-3.1-generate-preview");
    await page.click("#set-video-remove");
    await until(() => document.querySelector("#dlg-confirm").open, "removing the key asks first");
    await page.click("#confirm-yes");
    await until(() => document.querySelector("#set-video-state").textContent === "Not connected" && document.querySelector("#set-video-remove").hidden, "the key is removed and video is off again");
    await closeTop();
    await page.keyboard.down("Alt"); await page.keyboard.press("KeyI"); await page.keyboard.up("Alt");
    await until(() => document.querySelector("#dlg-studio").open && !document.querySelector("#studio-pic").hidden && document.querySelector("#t-studio").textContent === "Image Studio" && !document.querySelector("#studio-go").disabled, "Alt+I still opens the Image Studio");
    await closeTop();
  }

  // ---------- what's new ----------
  console.log("what's new");
  {
    ok(!(await page.$eval("#dlg-new", (d) => d.open)) && await page.evaluate(() => localStorage.getItem("brain.news") === "3.1"), "a first start does not show What's new");
    await page.evaluate(() => localStorage.setItem("brain.news", "2"));
    await page.reload({ waitUntil: "load" });
    await until(() => document.querySelector("#dlg-new").open && document.querySelectorAll("#dlg-new .new-list li").length === 11 && /version 3\.1/.test(document.querySelector("#t-new").textContent), "after an update, What's new in version 3.1 opens by itself");
    await shot("27-whats-new");
    await page.click('#dlg-new [data-new="video"]');
    await until(() => !document.querySelector("#dlg-new").open && document.querySelector("#dlg-studio").open && document.querySelector("#t-studio").textContent === "Video Studio", "its Video Studio link opens the Video Studio");
    await closeTop();
    await page.reload({ waitUntil: "load" });
    await page.waitForFunction(() => window.Station && document.querySelector("#studio-go"), { timeout: 15000 });
    await sleep(1200);
    ok(!(await page.$eval("#dlg-new", (d) => d.open)), "it is shown only once");
    await page.keyboard.press("F1");
    await until(() => document.querySelector("#dlg-help").open, "F1 opens Help");
    await page.click("#help-new");
    await until(() => !document.querySelector("#dlg-help").open && document.querySelector("#dlg-new").open, "Help has a What's new button");
    await page.evaluate(() => window.Station.hide("usage"));
    await page.click('#dlg-new [data-new="usage"]');
    await until(() => !document.querySelector("#dlg-new").open && window.__shown("usage"), "What's new: 'Show usage' opens the Usage panel");
    const themeBefore = await page.evaluate(() => document.documentElement.dataset.theme);
    await page.keyboard.press("F1");
    await until(() => document.querySelector("#dlg-help").open, "Help again");
    await page.click("#help-new");
    await until(() => document.querySelector("#dlg-new").open, "What's new again");
    await page.click('#dlg-new [data-new="goth"]');
    await until(() => !document.querySelector("#dlg-new").open && document.documentElement.dataset.theme === "goth", "What's new: 'Try Goth' switches to Goth");
    await page.keyboard.press("F1");
    await until(() => document.querySelector("#dlg-help").open, "Help a third time");
    await page.click("#help-new");
    await until(() => document.querySelector("#dlg-new").open, "What's new a third time");
    await page.click('#dlg-new [data-new="berserk"]');
    await until(() => !document.querySelector("#dlg-new").open && document.documentElement.dataset.theme === "berserk", "What's new: 'Try Berserk' switches to Berserk");
    await page.keyboard.press("F1");
    await until(() => document.querySelector("#dlg-help").open, "Help a fourth time");
    await page.click("#help-new");
    await until(() => document.querySelector("#dlg-new").open, "What's new a fourth time");
    await page.click('#dlg-new [data-new="flow-setting"]');
    await until(() => !document.querySelector("#dlg-new").open && document.querySelector("#dlg-settings").open && document.querySelector("#set-flow-brain").checked, "What's new: 'See the setting' opens Settings, where Google Flow for the brain is on");
    await closeTop();
    await page.evaluate((t) => window.Brain.saveSetting({ theme: t }), themeBefore);
    await until((t) => document.documentElement.dataset.theme === t, "theme put back", themeBefore);
    ok(await page.$eval("#about-version", (el) => /3.1.0/.test(el.textContent)).catch(() => false) || /3.1.0/.test(await page.evaluate(() => fetch("/api/ping").then((r) => r.text()))), "the version is 3.1.0");
  }

  // ---------- a program in the middle ----------
  console.log("programs in the middle");
  // In a plain browser there is no desktop window: the panel says so and nothing can be added.
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyA"); await page.keyboard.up("Alt");
  await until(() => window.__shown("apps"), "Alt+A shows the Apps panel");
  ok(/desktop window/.test(await text("#apps-note-title")) && await page.$eval("#apps-add", (b) => b.disabled) && !(await visible("#appview")), "in a browser the Apps panel explains it needs the desktop window");
  // Google Flow: in a plain browser it is a link to Google's site (the test catches it, nothing is opened).
  await page.evaluate(() => { window.__opened = []; window.open = (u, t, f) => { window.__opened.push([u, t, f]); return null; }; });
  ok(await visible("#apps-flow") && !(await page.$eval("#apps-flow", (b) => b.disabled)) && /opens in your browser/.test(await text("#apps-flow-kind")), "the Apps panel offers Google Flow, also in a browser");
  await page.click("#apps-flow");
  ok(JSON.stringify(await page.evaluate(() => window.__opened)) === JSON.stringify([["https://labs.google/fx/tools/flow", "_blank", "noopener"]]), "there it opens Google's Flow site in a new tab");
  await page.keyboard.down("Alt"); await page.keyboard.press("KeyV"); await page.keyboard.up("Alt");
  await until(() => document.querySelector("#dlg-studio").open && !!document.querySelector("#video-flow")?.offsetParent, "the Video Studio has a link to Google Flow");
  await page.click("#video-flow");
  await until(() => !document.querySelector("#dlg-studio").open && window.__opened.length === 2, "the link closes the studio and opens Flow");
  // In the desktop window (a fake bridge here): add a program, open it in the middle, cover it, put it back.
  {
    const pageA = page;
    page = await newPage(1680, 980);
    await page.evaluateOnNewDocument(() => {
      const fns = new Set(), log = [];
      let pins = [], docked = null;
      const emit = (m) => setTimeout(() => fns.forEach((f) => f(m)), 20);
      window.__apps = { log, emit, slot: () => log.filter((c) => c[0] === "slot").at(-1)?.[1] || null };
      window.station = {
        shell: true, version: "test", isFullscreen: false, controlsWidth: 140,
        toggleFullscreen() {}, onFullscreen() {}, setColors() {},
        discord: async () => ({ ok: true, beside: false }),
        onApps: (fn) => fns.add(fn),
        apps: async (what, arg) => {
          log.push([what, arg]);
          if (what === "state") return { ok: true, docked, pins };
          if (what === "add") { pins = [...pins, { id: "p1", name: "Blender <i>3D</i>", icon: "", found: true }]; return { ok: true, id: "p1", pins }; }
          if (what === "remove") { pins = pins.filter((p) => p.id !== arg); return { ok: true, pins }; }
          if (what === "open") { emit({ ev: "starting", name: "Blender <i>3D</i>" }); await new Promise((r) => setTimeout(r, 150)); docked = { name: "Blender <i>3D</i>", title: "Blender [Unsaved]", pin: arg }; emit({ ev: "docked", ...docked }); return { ok: true }; }
          if (what === "windows") return { ok: true, windows: [{ hwnd: 77, title: "Notes <b>bold</b>", app: "Notepad", min: true }] };
          if (what === "dock") return { ok: false, why: "admin" };
          if (what === "release") { docked = null; emit({ ev: "released" }); return { ok: true }; }
          if (what === "flow") { emit({ ev: "starting", name: "Google Flow" }); await new Promise((r) => setTimeout(r, 150)); docked = { name: "Google Flow", title: "Flow", pin: "builtin-flow" }; emit({ ev: "docked", ...docked }); return { ok: true }; }
          return { ok: true };
        },
      };
    });
    await page.goto(BASE, { waitUntil: "load" });
    await page.evaluate(() => window.Station.show("apps"));
    await until(() => !document.querySelector("#apps-add").disabled && !document.querySelector("#apps-note").hidden && /Show a program/.test(document.querySelector("#apps-note-title").textContent), "in the desktop window + is ready and the panel says how to start");
    ok(!(await visible("#appview")) && !(await page.evaluate(() => window.__apps.log.some((c) => c[0] === "slot" && c[1].show))), "nothing in the middle yet: nothing is shown on a slot");
    // Google Flow in the desktop window: one click puts it in the middle; it is not one of "your programs".
    ok(/^Google's video maker$/.test(await text("#apps-flow-kind")), "in the desktop window Google Flow is offered as a program");
    await page.click("#apps-flow");
    await until(() => !document.querySelector("#appview").hidden && document.querySelector("#av-name").textContent === "Google Flow" && document.querySelector("#apps-flow-kind").textContent === "In the middle now" && document.querySelector("#apps-flow-row").classList.contains("on"), "a click shows Google Flow in the middle");
    ok(await page.evaluate(() => window.__apps.log.filter((c) => c[0] === "flow").length === 1 && !window.__apps.log.some((c) => c[0] === "open")) && !(await count("#apps-pins li")), "the page only says 'open Flow' (no address), and Flow is not in your programs list");
    await page.click("#apps-flow");
    await sleep(300);
    ok(await page.evaluate(() => window.__apps.log.filter((c) => c[0] === "flow").length === 1 && window.__apps.log.at(-1)[0] !== "flow"), "a second click does not open it twice");
    await page.click("#av-back");
    await until(() => document.querySelector("#appview").hidden && document.querySelector("#apps-flow-kind").textContent === "Google's video maker", "Put it back takes Flow out of the middle");
    await page.keyboard.down("Control"); await page.keyboard.press("KeyK"); await page.keyboard.up("Control");
    await page.keyboard.type("google flow");
    await page.keyboard.press("Enter");
    await until(() => !document.querySelector("#appview").hidden && document.querySelector("#av-name").textContent === "Google Flow" && !document.querySelector("#av-back").disabled, "Ctrl+K has Google Flow too");
    await page.click("#av-back");
    await until(() => document.querySelector("#appview").hidden, "and it goes back again");
    await page.click("#apps-add");
    await until(() => document.querySelectorAll("#apps-pins li").length === 1 && document.querySelector("#apps-note").hidden, "a picked program shows in the list");
    ok(!(await count("#apps-pins i")) && /Blender <i>3D<\/i>/.test(await text("#apps-pins .dc-name")), "program names show as plain text");
    await page.click("#apps-pins .dc-open");
    await until(() => !document.querySelector("#appview").hidden && /Blender/.test(document.querySelector("#av-name").textContent) && document.body.classList.contains("has-app"), "a click opens the program in the middle");
    await until(() => window.__apps.slot()?.show === true, "the desktop window is told to show it on the slot");
    const fit = await page.evaluate(() => {
      const s = window.__apps.slot(), r = document.querySelector("#av-slot").getBoundingClientRect(), m = document.querySelector("#main").getBoundingClientRect();
      return { same: Math.abs(s.x - r.left) <= 1 && Math.abs(s.y - r.top) <= 1 && Math.abs(s.w - r.width) <= 1 && Math.abs(s.h - r.height) <= 1, w: s.w, chat: Math.round(m.width), right: Math.round(r.right), mainLeft: Math.round(m.left) };
    });
    ok(fit.same && fit.w > 400 && Math.abs(fit.chat - 440) <= 4 && fit.right <= fit.mainLeft, "the slot sits left of the chat, and the chat keeps about 440 px", JSON.stringify(fit));
    ok(/In the middle now/.test(await text("#apps-pins .dc-kind")) && await visible("#apps-back"), "the list marks the program that is in the middle");
    ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight), "page does not scroll with a program in the middle");
    await shot("22-program-in-the-middle");
    // Anything that would be drawn under the program sends it behind AI Brain.
    await page.click("#btn-help");
    await until(() => window.__apps.slot()?.show === false && /behind AI Brain/.test(document.querySelector("#av-note-title").textContent), "a dialog sends the program behind AI Brain");
    await page.keyboard.press("Escape");
    await until(() => window.__apps.slot()?.show === true, "closing the dialog brings it back");
    await page.click("#btn-zen");
    await until(() => window.__apps.slot()?.show === false, "focus mode sends it behind too");
    await page.click("#btn-zen");
    await until(() => window.__apps.slot()?.show === true, "and back after focus mode");
    await page.evaluate(() => { document.querySelector("#drop").hidden = false; });
    await until(() => window.__apps.slot()?.show === false, "the drop-files screen sends it behind too");
    await page.evaluate(() => { document.querySelector("#drop").hidden = true; });
    await until(() => window.__apps.slot()?.show === true, "and back after the drop");
    // While a panel is dragged the program steps back, so the drop places over it can be seen.
    {
      const r = await page.$eval("#p-gemini .p-head", (el) => { const b = el.getBoundingClientRect(); return { x: b.left + 24, y: b.top + b.height / 2 }; });
      await page.mouse.move(r.x, r.y); await page.mouse.down();
      await page.mouse.move(r.x + 300, r.y + 200, { steps: 5 });
      await until(() => window.__apps.slot()?.show === false && document.body.classList.contains("moving"), "dragging a panel sends the program behind");
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await until(() => window.__apps.slot()?.show === true, "and it comes back when the drag ends");
    }
    // The program can be moved like a panel: drag its title bar to the right edge.
    {
      const r = await page.$eval("#av-name", (el) => { const b = el.getBoundingClientRect(); return { x: b.left + 10, y: b.top + b.height / 2 }; });
      const t = await page.$eval("#tiles", (el) => { const b = el.getBoundingClientRect(); return { x: b.right - 6, y: b.top + b.height / 2 }; });
      await page.mouse.move(r.x, r.y); await page.mouse.down();
      await page.mouse.move(t.x, t.y, { steps: 8 });
      await page.mouse.up();
      await until(() => { const l = window.Station.layout(), a = l.rects.app, s = window.__apps.slot(), r = document.querySelector("#av-slot").getBoundingClientRect(); return a.x > l.rects.main.x && s?.show && Math.abs(s.x - r.left) <= 1 && Math.abs(s.w - r.width) <= 1; }, "the program can be dragged to the right edge and its window follows");
      await page.click("#presets [data-preset=station]");
      await page.evaluate(() => window.Station.show("apps"));
    }
    // Free-floating: a panel on top of the program hides the program's window (it is always on top).
    await page.evaluate(() => window.Station.setFloat(true));
    {
      const r = await page.$eval("#p-gemini .p-head", (el) => { const b = el.getBoundingClientRect(); return { x: b.left + 24, y: b.top + b.height / 2 }; });
      await page.mouse.move(r.x, r.y); await page.mouse.down();
      await page.mouse.move(r.x + 260, r.y + 60, { steps: 6 });
      await page.mouse.up();
      await until(() => window.__apps.slot()?.show === false && document.querySelector("#appview").hasAttribute("data-covered"), "free-floating: a panel over the program sends it behind");
      await page.click("#av-name");
      await until(() => window.__apps.slot()?.show === true, "clicking the program brings it to the front again");
      // The program without a saved floating spot (picked after floating was switched on) shows on top.
      await page.evaluate(() => { const s = window.Station.layout().saved; delete s.fl.app; s.z = s.z.filter((x) => x !== "app"); window.Station.settings({ ...window.Brain.S.settings, layout: JSON.stringify(s) }); });
      await until(() => { const l = window.Station.layout(), s = window.__apps.slot(), r = document.querySelector("#av-slot").getBoundingClientRect(); return l.rects.app?.w > 200 && l.saved.z.at(-1) === "app" && s?.show && Math.abs(s.x - r.left) <= 1 && Math.abs(s.w - r.width) <= 1; }, "free-floating: a program with no saved spot shows on top, on its slot");
    }
    await page.evaluate(() => window.Station.setFloat(false));
    await until(() => window.__apps.slot()?.show === true && !document.body.classList.contains("floating"), "snapped again, the program shows");
    // The line between the program and the chat changes the chat's width; the slot follows.
    const sp = await page.evaluate(() => { const a = window.Station.layout().rects.app, t = document.querySelector("#tiles").getBoundingClientRect(); const s = [...document.querySelectorAll(".split.v:not([hidden])")].find((el) => Math.abs(el.offsetLeft - (a.x + a.w)) <= 1); const r = s.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; });
    await page.mouse.move(sp.x + sp.width / 2, sp.y + sp.height / 2);
    await page.mouse.down(); await page.mouse.move(sp.x - 120, sp.y + sp.height / 2, { steps: 4 }); await page.mouse.up();
    await until(() => Math.abs(document.querySelector("#main").getBoundingClientRect().width - 562) <= 8 && Math.abs(window.__apps.slot().w + window.__apps.slot().x - document.querySelector("#av-slot").getBoundingClientRect().right) <= 1, "dragging the line widens the chat and the slot follows");
    ok(await page.evaluate(() => { const l = JSON.parse(localStorage.getItem("brain.layout")); return l.root.s[l.root.k.indexOf("main")] > 520; }), "the chat width is remembered");
    // Docking a window that is already open.
    await page.click("#apps-windows");
    await until(() => document.querySelectorAll("#apps-wins li").length === 1, "open windows are listed");
    ok(!(await count("#apps-wins b")) && /Notes <b>bold<\/b>/.test(await text("#apps-wins .dc-name")) && /minimized/.test(await text("#apps-wins .dc-kind")), "window titles show as plain text");
    await page.click("#apps-wins .dc-open");
    await until(() => /administrator/.test(document.querySelector("#toasts").textContent), "a program running as administrator gets a clear message");
    ok(await page.evaluate(() => window.__apps.log.some((c) => c[0] === "dock" && c[1] === 77)), "the page only passes the window's number");
    // A small screen with every panel showing: nothing scrolls, and the program still fits beside the chat.
    await page.setViewport({ width: 1366, height: 768 });
    await page.click("#presets [data-preset=all]");
    await sleep(700);
    const narrow = await page.evaluate(() => {
      const s = window.__apps.slot(), r = document.querySelector("#av-slot").getBoundingClientRect(), m = document.querySelector("#main").getBoundingClientRect();
      const d = document.documentElement;
      return { scrollW: d.scrollWidth, scrollH: d.scrollHeight, iw: innerWidth, ih: innerHeight, slotW: Math.round(r.width), chat: Math.round(m.width), right: Math.round(r.right), mainLeft: Math.round(m.left),
        same: !!s && s.show && Math.abs(s.x - r.left) <= 1 && Math.abs(s.w - r.width) <= 1 && Math.abs(s.h - r.height) <= 1 };
    });
    ok(narrow.scrollW <= narrow.iw && narrow.scrollH <= narrow.ih, "on a 1366×768 screen with every panel the page does not scroll", JSON.stringify(narrow));
    ok(narrow.right <= narrow.mainLeft && narrow.slotW >= 200 && narrow.chat >= 340 && narrow.same, "and the program still fits beside the chat", JSON.stringify(narrow));
    await shot("23-program-small-screen");
    await page.setViewport({ width: 1050, height: 700 });
    await sleep(700);
    const narrower = await page.evaluate(() => {
      const r = document.querySelector("#av-slot").getBoundingClientRect(), m = document.querySelector("#main").getBoundingClientRect(), d = document.documentElement;
      return { scrollW: d.scrollWidth, iw: innerWidth, slotW: Math.round(r.width), chat: Math.round(m.width), right: Math.round(r.right), mainLeft: Math.round(m.left), scrollH: d.scrollHeight, ih: innerHeight };
    });
    ok(narrower.scrollW <= narrower.iw && narrower.scrollH <= narrower.ih && narrower.right <= narrower.mainLeft && narrower.slotW >= 200 && narrower.chat >= 316, "on a 1050 px screen the panels give way, the chat stays readable", JSON.stringify(narrower));
    await page.click("#presets [data-preset=station]");
    await page.setViewport({ width: 1680, height: 980 });
    await page.evaluate(() => window.Station.show("apps"));
    await sleep(400);
    // Put it back.
    await page.click("#av-back");
    await until(() => document.querySelector("#appview").hidden && !document.body.classList.contains("has-app") && document.querySelector("#apps-back").hidden, "Put it back empties the middle");
    await until(() => Math.round(document.querySelector("#main").getBoundingClientRect().width) > 700, "the chat gets its full width back");
    await page.click("#apps-pins .dc-del");
    await until(() => !document.querySelectorAll("#apps-pins li").length && !document.querySelector("#apps-note").hidden, "a program can be removed from the list");
    await page.close();
    page = pageA;
    await page.bringToFront();
  }

  // ---------- quit ----------
  console.log("quit");
  await page.click("#btn-quit");
  await until(() => document.querySelector("#dlg-confirm").open && /Quit/.test(document.querySelector("#confirm-title").textContent), "Quit asks first");
  await page.click("#confirm-yes");
  await until(() => !document.querySelector("#closed").hidden, "the closed screen shows");
  await sleep(900);
  let up = true;
  try { await fetch(`${BASE}/api/ping`); } catch { up = false; }
  ok(!up, "the server has stopped");
  ok(await page.$eval("#offline", (el) => el.hidden), "no “not responding” banner on a normal quit");
} catch (e) {
  failed++;
  console.log(`  FAIL test run aborted: ${e.stack || e}`);
  try { await shot("zz-aborted"); } catch {}
}

const real = problems.filter((p) => !/ERR_CONNECTION_REFUSED|net::ERR_EMPTY_RESPONSE|ERR_INCOMPLETE_CHUNKED/.test(p) || !/quit/.test(""));
ok(problems.filter((p) => !/ERR_CONNECTION_REFUSED|ERR_EMPTY_RESPONSE|ERR_INCOMPLETE_CHUNKED|ERR_CONNECTION_RESET/.test(p)).length === 0, "no console errors, page errors or failed requests", `\n    ${problems.join("\n    ")}`);
void real;

await browser.close().catch(() => {});
try { server.kill(); } catch {}
await sleep(300);
try { fs.rmSync(DATA, { recursive: true, force: true }); } catch {}
if (!process.argv.includes("--shots") && failed === 0) { /* keep the screenshots: they are small and useful */ }
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
