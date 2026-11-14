# AI Brain - where we left off (2026-11-12)

Version 2.2.0. Start it with the "AI Brain" desktop shortcut, or `powershell -File launch.ps1`.
Server on http://127.0.0.1:4777, desktop window = Electron (`shell/main.cjs`).

## Tests
- `node test/api-test.mjs`  -> 167 passed, 0 failed
- `node test/ui-test.mjs`   -> 286 passed, 0 failed

## Done in the last session
1. **File and command access** (Settings > The brain > File and command access)
   - "Read only" (default) or "Ask before each change". Every write, edit and command pops up an Allow/Deny window.
   - Brain works only in `workspace/` plus folders you add. Discord, `.claude`, `.codex`, `.gemini` are always refused.
   - Currently switched ON ("ask") in the live settings.
2. **Discord = the installed desktop app** (no website pane any more)
   - `app/discord.mjs` (status + open), `shell/discord-window.ps1` (moves/brings Discord's window to the front only).
   - Panel (Alt+D): pinned chats like the Spotify card. Press + and paste a `https://discord.com/channels/...` link.
     A click opens that chat in the Discord app, placed on the right; AI Brain goes left. "Put the windows back" undoes it.
   - Discord does not let other apps list chats, so pins are added by hand. Nothing is read from Discord.

## Still to check / ideas
- Pin one of your REAL Discord chats and click it (only tested with a made-up chat number).
- Not tested: clicking a pin while Discord is closed or maximized; a second monitor.
- ChatGPT is switched off and was never tested.
- Old Discord website data (38 MB) is still at `%APPDATA%\AI Brain\Partitions\discord` - safe to delete if you want.

## Files
- `lib.mjs` - settings, CLIs (Claude / Gemini / ChatGPT)
- `server.mjs` - MCP tools the brain uses (helpers, approve)
- `app/app-server.mjs` - the web server and API
- `app/public/` - the page (index.html, app.js, station.js, css)
- `shell/` - the desktop window (Electron)
- `test/` - automated tests (fake brain, no cost)
