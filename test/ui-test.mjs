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
    BRAIN_FAKE_IMAGE: FIXTURE, BRAIN_FAKE_DELAY_MS: "400",
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
  ok(await count("#ideas .idea") === 4, "four idea cards");
  ok(!(await text("#ideas")).match(/road|million|bybit/i), "ideas do not mention private projects");
  await until(() => document.querySelector("#p-chatgpt").parentNode.id === "panel-store" && document.querySelector("#rail-panels [data-toggle=chatgpt]").hidden, "ChatGPT panel is left out while off");
  ok(await page.$eval("#chips .chip[data-who='chatgpt']", (el) => el.hidden), "ChatGPT chip hidden while off");
  await until(() => document.querySelector("#chips .chip[data-who='gemini'] .dot").classList.contains("ok"), "Gemini chip is green");
  await until(() => /TEST MODE/.test(document.querySelector("#about").textContent), "about line shows test mode");
  await until(() => [...document.querySelectorAll("#dock-left > .panel")].map((p) => p.dataset.panel).join() === "gemini,activity" && [...document.querySelectorAll("#dock-right > .panel")].map((p) => p.dataset.panel).join() === "usage,music,stats", "Station layout: Gemini + Activity left, Usage + Music + Stats right");
  ok(await page.$eval("#presets [data-preset=station]", (b) => b.getAttribute("aria-pressed") === "true"), "Station preset is marked");
  ok(await count("#dock-left > .hsplit") === 1 && await count("#dock-right > .hsplit") === 2, "splitters between panels");
  ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth && document.documentElement.scrollHeight <= window.innerHeight), "page does not scroll at 1680x980");
  ok(await page.evaluate(() => document.activeElement?.id === "task"), "task box has focus");
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
  ok(!(await visible("#dock-left")) && !(await visible("#dock-right")) && !(await visible("#rail-panels")), "focus mode hides the side panels");
  await shot("06-focus-mode");
  await page.click("#btn-zen");
  ok(!(await page.$eval("body", (b) => b.classList.contains("zen"))), "focus mode turns off");

  // ---------- the workstation ----------
  console.log("workstation");
  const dockIds = (side) => page.$$eval(`#dock-${side} > .panel`, (els) => els.map((p) => p.dataset.panel).join());
  const savedLayout = async () => JSON.parse((await (await fetch(`${BASE}/api/settings`)).json()).layout || "{}");
  await page.click("#presets [data-preset=all]");
  await until(() => document.querySelectorAll("#dock-left > .panel, #dock-right > .panel").length === 7, "Everything shows seven panels");
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
  ok(await page.evaluate(() => [...document.querySelectorAll(".dock")].every((d) => d.scrollHeight <= d.clientHeight + 1)), "panels fit inside the docks");
  await shot("06a-everything");
  await page.click("#presets [data-preset=focus]");
  await until(() => document.querySelector("#dock-left").hidden && document.querySelector("#dock-right").hidden, "Focus hides both docks");
  ok(!(await visible('.vsplit[data-side="left"]')), "the splitter hides with its dock");
  await page.keyboard.down("Alt"); await page.keyboard.press("Digit2"); await page.keyboard.up("Alt");
  await until(() => !document.querySelector("#dock-left").hidden && document.querySelectorAll("#dock-right > .panel").length === 3, "Alt+2 brings back Station");
  // panel menu
  await page.click('#music .p-more');
  await until(() => !document.querySelector("#menu").hidden && document.querySelectorAll("#menu button").length >= 6, "the panel menu opens");
  ok(await page.evaluate(() => document.activeElement?.closest("#menu") !== null), "the menu takes the keyboard");
  await page.$$eval("#menu button", (bs) => bs.find((b) => /left side/.test(b.textContent)).click());
  await until(() => document.querySelector("#music").parentNode.id === "dock-left" && document.querySelector("#menu").hidden, "a panel moves to the other side");
  ok(await page.$eval("#presets [data-preset=station]", (b) => b.getAttribute("aria-pressed") === "false"), "a changed layout is no longer marked Station");
  await page.click('#music .p-more');
  await page.$$eval("#menu button", (bs) => bs.find((b) => /Move up/.test(b.textContent)).click());
  await until(() => [...document.querySelectorAll("#dock-left > .panel")].map((p) => p.dataset.panel).join() === "gemini,music,activity", "a panel moves up");
  await page.click('#activity .p-more');
  await page.$$eval("#menu button", (bs) => bs.find((b) => /Hide/.test(b.textContent)).click());
  await until(() => document.querySelector("#activity").parentNode.id === "panel-store", "a panel can be hidden");
  ok(await page.$eval("#rail-panels [data-toggle=activity]", (b) => b.getAttribute("aria-pressed") === "false"), "its rail button shows it is hidden");
  await page.click("#rail-panels [data-toggle=activity]");
  await until(() => document.querySelector("#activity").parentNode.id === "dock-left", "the rail button shows it again, on the same side");
  await page.click('#music .p-more');
  await page.keyboard.press("Escape");
  await until(() => document.querySelector("#menu").hidden, "Esc closes the panel menu");
  // collapse
  await page.click("#music .p-head", { count: 2 });
  await until(() => document.querySelector("#music").classList.contains("collapsed"), "double-clicking a panel title collapses it");
  await page.click("#music .p-head", { count: 2 });
  await until(() => !document.querySelector("#music").classList.contains("collapsed"), "and again expands it");
  // splitters
  const w0 = await page.$eval("#dock-left", (d) => d.getBoundingClientRect().width);
  await page.focus('.vsplit[data-side="left"]');
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await until((w) => document.querySelector("#dock-left").getBoundingClientRect().width >= w + 40, "arrow keys widen the left dock", w0);
  const sp = await page.$eval("#dock-left > .hsplit", (s) => { const r = s.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  const g0 = await page.$eval("#p-gemini", (p) => p.getBoundingClientRect().height);
  await page.mouse.move(sp.x, sp.y); await page.mouse.down(); await page.mouse.move(sp.x, sp.y - 80, { steps: 5 }); await page.mouse.up();
  await until((h0) => document.querySelector("#p-gemini").getBoundingClientRect().height < h0 - 50, "dragging a splitter resizes the panels", g0);
  await sleep(900);
  const lay = await savedLayout();
  ok(lay.left?.items?.join() === "gemini,music,activity" && lay.left.w >= 330 && lay.sizes?.gemini > 0, "the layout is saved on the server", JSON.stringify(lay).slice(0, 200));
  // save as Mine
  await page.click("#btn-layout");
  await until(() => !document.querySelector("#menu").hidden && /Save this layout/.test(document.querySelector("#menu").textContent), "the layout menu opens");
  await page.$$eval("#menu button", (bs) => bs.find((b) => /Save this layout/.test(b.textContent)).click());
  await until(() => !document.querySelector("#presets [data-preset=mine]").hidden && document.querySelector("#presets [data-preset=mine]").getAttribute("aria-pressed") === "true", "Mine appears and is marked");
  await page.click("#presets [data-preset=station]");
  await until(() => [...document.querySelectorAll("#dock-left > .panel")].map((p) => p.dataset.panel).join() === "gemini,activity", "Station resets the panels");
  await page.keyboard.down("Alt"); await page.keyboard.press("Digit5"); await page.keyboard.up("Alt");
  await until(() => [...document.querySelectorAll("#dock-left > .panel")].map((p) => p.dataset.panel).join() === "gemini,music,activity", "Alt+5 brings back Mine");
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
  await until(() => document.querySelector("#usage-panel").parentNode.id === "panel-store", "usage panel hidden");
  await page.click("#usage");
  await until(() => document.querySelector("#usage-panel").parentNode.id === "dock-right", "clicking the usage meter in the status bar opens the usage panel");
  await page.click("#presets [data-preset=station]");
  await shot("06b-usage-panel");
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
  await until(() => document.querySelector("#p-chatgpt").parentNode.id === "dock-left", "the ChatGPT panel can be shown from the rail");
  await shot("16-neon-two-helpers");

  // ---------- both helpers ----------
  console.log("both helpers");
  await sendTask("Ask everyone [both]");
  await until(() => document.querySelectorAll("#chatgpt-log .hm.reply .md").length === 1, "ChatGPT's reply shows in its panel");
  await until(() => document.querySelectorAll("#gemini-log .hm.reply.err").length === 1, "Gemini's failure shows as an error");
  await idle();
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
  const layoutNow = await page.evaluate(() => [...document.querySelectorAll(".dock > .panel")].map((p) => p.dataset.panel).join());
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
  await fetch(`${BASE}/api/settings`, { method: "POST", headers: { Origin: BASE, "Content-Type": "application/json" }, body: JSON.stringify({ access: "read", folders: [] }) });

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
