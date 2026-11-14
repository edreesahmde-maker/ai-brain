// The Discord desktop app installed on this PC: is it there, is it running, and open it.
// AI Brain only starts the app (or brings its window back). It never reads Discord's data,
// never signs in for you and cannot see or send messages.
import { spawn, execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const NO_OPEN = process.env.BRAIN_NO_OPEN === "1";
// Tests only: "running" | "stopped" | "missing" stands in for the real app.
const FAKE = process.env.BRAIN_FAKE_DISCORD || "";
const UPDATER = path.join(process.env.LOCALAPPDATA || "", "Discord", "Update.exe");

let cache = null;
let cacheAt = 0;

function isRunning() {
  return new Promise((resolve) => {
    execFile("tasklist.exe", ["/FI", "IMAGENAME eq Discord.exe", "/FO", "CSV", "/NH"], { windowsHide: true, timeout: 5000 },
      (err, out) => resolve(!err && /"Discord\.exe"/i.test(String(out))));
  });
}

export async function discordStatus() {
  if (FAKE) return { installed: FAKE !== "missing", running: FAKE === "running" };
  if (cache && Date.now() - cacheAt < 2000) return cache;
  cache = { installed: fs.existsSync(UPDATER), running: await isRunning() };
  cacheAt = Date.now();
  return cache;
}

// Starts Discord, or - when it is already running, even hidden in the tray - shows its window.
// Discord's own updater does this; the path never changes when Discord updates itself.
export function openDiscord() {
  cache = null;
  const installed = FAKE ? FAKE !== "missing" : fs.existsSync(UPDATER);
  if (!installed) {
    // Another kind of install (for example from the Microsoft Store) still answers its link.
    if (!NO_OPEN) spawn("explorer.exe", ["discord://-/channels/@me"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    return { ok: true, how: "link" };
  }
  if (!NO_OPEN) spawn(UPDATER, ["--processStart", "Discord.exe"], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { ok: true, how: "app" };
}

// A pinned chat's link, rebuilt from its two numbers only (nothing typed is passed through).
const ID = /^\d{15,22}$/;
export function chatLink(c) {
  const place = String(c?.place ?? ""), chat = String(c?.chat ?? "");
  if (!(place === "@me" || ID.test(place)) || !ID.test(chat)) return null;
  return `discord://-/channels/${place}/${chat}`;
}

// Opens Discord straight at a pinned chat (Discord starts first if it is not running).
export function openDiscordChat(c) {
  const link = chatLink(c);
  if (!link) return { ok: false, error: "That is not a Discord chat link." };
  cache = null;
  if (!NO_OPEN) spawn("explorer.exe", [link], { detached: true, stdio: "ignore", windowsHide: true }).unref();
  return { ok: true, link };
}
