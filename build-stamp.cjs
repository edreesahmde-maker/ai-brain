// A short fingerprint of the server's own program files (their size and last-change time).
// The desktop window compares it with the running server's, so an older server left running in the
// background is replaced instead of being used with the newer page (which made new settings fail).
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILES = ["package.json", "lib.mjs", "app/app-server.mjs", "app/music.mjs", "app/discord.mjs", "app/media-helper.ps1", "build-stamp.cjs"];

module.exports = function buildStamp(root = __dirname) {
  const h = crypto.createHash("sha1");
  for (const f of FILES) {
    try { const s = fs.statSync(path.join(root, f)); h.update(`${f}:${s.size}:${Math.round(s.mtimeMs)}\n`); }
    catch { h.update(`${f}:missing\n`); }
  }
  return h.digest("hex").slice(0, 12);
};
