# AI Brain - where we left off (2026-11-14)

Version 3.1.0. Start it with the "AI Brain" desktop shortcut, or `powershell -File launch.ps1`.
Server on http://127.0.0.1:4777, desktop window = Electron (`shell/main.cjs`).
On GitHub (private): https://github.com/edreesahmde-maker/ai-brain (branch master).

## Done on 2026-11-14: the brain can USE the program in the middle (mouse + keyboard)
- Setting `appsBrain` (default OFF): Settings > The brain > "Let the brain use the program in the middle".
- Brain tools (server.mjs, only with the setting on): app_open (a program pinned in the Apps panel), app_look,
  app_click, app_type, app_key, app_scroll, app_drag. Every step answers with a PNG picture of the program
  (MCP image content) + a numbered list from Windows UI Automation (buttons, boxes, list items...; positions in
  picture pixels). Click by number or by x/y. Programs that draw themselves (Blender, games) list ~nothing:
  the brain uses the picture and shortcuts. System prompt section "PROGRAMS" has the rules (no passwords,
  no buying/sending/deleting unless asked, stop when the user moves the mouse).
- Path of one step: tool -> POST /api/apps/control (header X-Brain-Key = per-task key `ctlKey`, env
  AI_BRAIN_CONTROL_KEY; dies with the task) -> SSE `app-control` -> page `Station.control` ->
  `station.apps('control')` (preload whitelists the fields) -> main.cjs `brainControl` -> `shell/app-control.cs`
  (compiled once like app-dock.cs, one run per step) -> answer POST /api/apps/control/answer (16 MB limit).
  A plain browser tab answers "no" softly (counts only if no desktop window answers within 4 s).
  Stop, the task ending, a new task and switching the setting off end waiting steps.
- Safety in app-control.cs/main.cjs: only the docked window's process; refuses when another program's window
  covers the spot ("covered"), when the program cannot come to the front, when the window moved since the
  last picture (look again), keys that leave the program (Win, Alt+Tab, Alt+Esc, Ctrl+Esc, Ctrl+Alt+Del);
  password boxes are never read. If the mouse is not where the brain left it, the USER moved it: the brain
  stops for the rest of that task (badge off, toast). The page shows a pulsing badge "The brain is using it".
- UI Automation clipping: rows scrolled out of a list/tree/table/document are dropped (WinForms reports them
  as on screen).
- Test window: `test/fixture-app.cs` (built by shell-test.mjs) writes every click/key/scroll/drag to a JSON file.
- NOT yet tried with the real Claude on a real program (Blender etc.). The tools and the whole path are tested
  with the fake Claude and the test window.

## Done on 2026-11-14: web inspector in the user's OWN browser (Brave) - extension
- Why an extension: since Chrome 136 (Brave/Edge too) `--remote-debugging-port` is ignored on the normal profile,
  so the Flow approach cannot reach the user's logged-in browser. The user chose the extension (their logins).
- `extension/` (MV3, load unpacked): popup pairs with the code from Settings > Web inspector and shares the
  current tab ("Share this tab" / "Stop sharing"); background.js attaches `chrome.debugger` ONLY to shared
  tabs (browser shows its debugging bar; Cancel there = unshared), keeps network (500) and console (300)
  from the moment of sharing, and long-polls AI Brain (`/api/inspect/ext/next`, 25 s; alarm every minute).
  Only talks to http://127.0.0.1 (default port 4777). Browser pages (chrome://, store) cannot be shared.
- Server: setting `inspectBrain` (default OFF). Pairing code in DATA/inspect-key.json (gitignored, in
  forbidden(), never in brain-mcp.json). Extension routes /api/inspect/ext/{hello,next,answer} are let in
  before the Origin check only from `chrome-extension://<32 a-p>` + the code. Brain: POST /api/inspect/request
  with the task key (same ctlKey as app control; issued when appsBrain OR inspectBrain). GET /api/inspect,
  POST /api/inspect/code {renew}. SSE "inspect" updates Settings.
- Brain tools (server.mjs, env AI_BRAIN_INSPECT=1): web_tabs, web_html, web_eval (replMode; promises awaited),
  web_network, web_response, web_console, web_cookies (values only with include_values), web_styles,
  web_screenshot, web_go (reload / open http(s)). System prompt "WEB INSPECTOR" with rules (read only unless
  asked; no passwords/cookie values/tokens in answers unless asked).
- NOT yet tried with the real Claude, or in the user's own Brave profile. Tested with the real extension in an
  empty Brave profile (`test/inspect-test.mjs`).

## Tests
- `node test/inspect-test.mjs` -> 43 passed, 0 failed (real extension in a throw-away Brave profile, local test
  page, real server, the brain's tool server: pairing, share, every web_ tool, refusals, unshare, key, new code)
- `node test/api-test.mjs`    -> 277 passed, 0 failed (30 app control + 21 web inspector checks)
- `node test/ui-test.mjs`     -> 487 passed, 0 failed (about 6 minutes)
- `node test/shell-test.mjs`  -> 62 passed, 0 failed (real desktop window against a test server; Google Flow
  with a local test page in an empty browser profile, incl. switching to "open only to sign in" and back;
  System Information docking; the "older server" stubs; 27 new: the brain uses the test window - open, look,
  click, type, keys, scroll, double/right click, drag, covered spot, window moved, user takes over, and the whole
  way server -> page -> window). It moves the real mouse: do not touch it while it runs.
  With Blender: `BRAIN_SHELL_APP_EXE="C:\Program Files\Blender Foundation\Blender 5.3\blender-launcher.exe" node test/shell-test.mjs` -> 32 passed (before the 2 sign-in switch checks were added).
- `node test/flow-test.mjs`   -> 26 passed, 0 failed (the brain's Flow tools against a FAKE Flow page, in a test
  browser with a temporary profile; also checks another site is never touched and the MCP tool list on/off).
- Real check done 2026-11-13: "Always allow" with the real Claude on a separate port wrote a file and ran
  `node --version` with 0 permission questions.
- Real check done 2026-11-13: the real Claude (Always allow, separate port, temp data) was asked for one Flow video
  against a FAKE Flow page (video after 150 s) in a temp browser profile: it used flow_make_video, 0 permission
  questions, the mp4 was saved byte-for-byte into workspace/media and shown in the final answer. It first
  described sounds it could not know; the system prompt now says it cannot watch the video.

## Done on 2026-11-13, fourth session: version 3.1.0
### Why "Always allow" and the theme "did not work"
- An OLD server (v2.2.0, started before the update) was still running on 4777 and serving the NEW page. It
  refused the new settings. Fix: `build-stamp.cjs` (hash of size+mtime of the server files) -> `/api/ping`
  returns `{app, version, build}`. `shell/server-check.cjs` (`serverState`, `stopOld`): when the desktop
  window starts and finds an older server, it asks it to stop (`/api/shutdown`), and if needed ends it - but
  ONLY if that process's command line is this project's `app\app-server.mjs`. Log line `SERVER REPLACED`.
- The page now shows "That setting was not saved..." when the server's answer does not match what was sent.
- The old 2.2.0 server was stopped on 2026-11-13 (it was idle, no window open).
### Themes
- Removed Clover, Anti-Magic (demon) and Wind Spirit. Saved choices move to `berserk` (`OLD_THEMES` in lib.mjs;
  app.js does the same for its cached copy). THEMES = dark, neon, goth, berserk.
- Berserk: black iron, blood red #c8282f, Cinzel capitals, rising embers, iron corner plates, an ORIGINAL red
  eclipse mark on the start screen (`<symbol id="eclipse">`). About says it is fan-made, not official.
- Helper boxes now say "Ask Gemini…" / "Ask ChatGPT…" (the old text wrapped and was cut off at 1366 wide).
### The brain can use Google Flow (experimental, no API key) - tested ONLY on a fake Flow page
- Flow now always opens with its own browser profile (`%APPDATA%\AI Brain\flow-profile`) and a control port
  on 127.0.0.1 (9447; tests 9448; env `BRAIN_FLOW_PORT`). The user must sign in to Google in that window once.
  Ctrl+K "Google Flow: open only to sign in" opens it WITHOUT the port, in case Google refuses the sign-in.
  Switching between the two ways closes that Flow window gently (taskkill without /F, forced only after 10 s; only
  if its command line has the Flow profile - never the user's browser) and opens it again
  (`flowWin.port` in main.cjs). If AI Brain restarts while the Flow window stays open, main.cjs no longer knows
  how it was opened; the brain's tools then say "close the Flow window and open it again".
- `flow.mjs` (raw DevTools protocol over Node's WebSocket; only pages on `https://labs.google`, env
  `BRAIN_FLOW_ORIGIN` for tests; never cookies; only reads the URL of a Google sign-in page):
  flow_make_video, flow_look, flow_click, flow_type, flow_wait, flow_save_videos (MCP tools in server.mjs,
  only when `AI_BRAIN_FLOW=1`). No hard-coded Flow selectors: the brain reads the page and decides.
  Videos are saved into the gallery; each Flow video counts toward "Videos per day at most" once (flow_make_video
  counts on start; flow_save_videos counts any video not counted yet). flow_type / flow_click also stop at the limit.
  A Google sign-in page is only reported after it stays for 8 seconds (redirects pass through it).
- If Flow is not open, the tool asks the window (`POST /api/flow/open` -> SSE `flow-open` -> `Station.openFlow(true)`).
- Setting `flowBrain` (default on): Settings > Video > "Let the brain use Google Flow".
- NOT tried on the real Flow site. Flow's page may need extra steps (e.g. "New project") - the brain is told to
  use flow_look and the small tools then. Automated use may go against Google's terms; uses the user's Flow credits.
- What's new is now "version 3.1" (11 items; `NEWS = 3.1`, shown once after the update).

## Done on 2026-11-13, third session: ChatGPT usage, Goth theme, new look (still version 3.0.0)
### ChatGPT usage
- Every ChatGPT request is counted in `DATA/usage-chatgpt.jsonl` (ok/failed, time, tokens in/cached/out).
- Plan limits (5-hour and weekly %) are read from Codex's OWN local conversation file
  (`~/.codex/sessions/Y/M/D/rollout-*-<thread>.jsonl`, only the `rate_limits` numbers; `codexLimits` in lib.mjs).
  They update each time ChatGPT is asked; after the reset time the bar goes blank.
- Usage panel has a ChatGPT section; status bar item "ChatGPT N today · week X%" (`#sb-chatgpt`, hidden
  below 1100px wide, and when ChatGPT is off and unused today). Toast at 90% or more.
- Tests use a fake Codex folder through `BRAIN_FAKE_CODEX_HOME`.
### Goth theme and new look
- New theme "goth" (last in `THEMES`): black velvet, amethyst, bone, a little wine red; ash falls down
  (`--fx-dir: down`; Wind Spirit drifts sideways). Fonts Pirata One (titles only, never uppercase) and
  Cormorant Garamond, from npm `@fontsource/*` (OFL), copied to `app/public/vendor/fonts/` - no internet needed.
- `app/public/polish.css` (loaded last): depth, gradients, message fade-in, dialog blur, glowing meters,
  start-screen cards, Goth touches. Rule: no transforms or filters on panels, `#appview` or their parents
  (the docked program windows depend on exact sizes). The plain Dark theme is kept quiet on purpose.
- Palette button in the top bar (`#btn-theme`) opens a theme menu; Ctrl+K has "Theme: <name>" entries.
- Start screen: 6 cards with icons (added Make a video, Fix some code) and "Your prompts" buttons
  (`#mine-ideas`, up to 6 saved prompts). The "Make a video" card opens the Video Studio with the idea filled in (video needs the Google key).
- What's new now lists 8 items (test checks 8); Help mentions the theme button and usage.
- Font licences (OFL) are next to the fonts: `app/public/vendor/fonts/OFL-*.txt`.

## Done on 2026-11-13, second session: version 3 (always allow, video, Google Flow)
### "Always allow" (Settings > The brain > File and command access)
- Third choice next to "Read only" and "Ask before each change": "Always allow (never asks)". A confirm box
  explains it once; the status bar shows a badge while it is on.
- It still goes through the same approval tool, so everything is logged in Activity and the never-allowed
  list still applies whatever is chosen: Discord's data, the `.claude` / `.codex` / `.gemini` folders,
  `brain-mcp.json` and the Google key. Helpers (Gemini, ChatGPT) stay read-only.
- Code: `access` = `read | ask | auto` in lib.mjs; `askApproval` / `forbidden` in app-server.mjs.

### Video (Google Veo 3.1) - built and tested with a fake Google, NOT yet tried with a real key
- Video Studio (Alt+V, or the Picture/Video switch in the Image Studio): describe it, pick wide/tall,
  4/6/8 seconds, 720p/1080p, "Let Claude improve my description first", Stop, timer. A picture in the
  viewer has "Make a video" (the video starts from that picture). Videos land in the Gallery and play there.
- The brain can make videos too (MCP tool `generate_video`, only offered once a key is saved).
- Needs the user's own Google API key (Settings > Video; from https://aistudio.google.com/apikey, billing on).
  Google charges per video. "Videos per day at most" (default 10, 0 = no limit) protects from a surprise bill.
- The key is saved in `%APPDATA%\ai-brain\google-key.json` (outside the project and outside any folder the
  brain may work in), or read from the environment (`GEMINI_API_KEY` / `GOOGLE_API_KEY`). It is never sent
  to the page again; only its last 4 characters are shown.
- Models: `veo-3.1-generate-preview` (default), `veo-3.1-fast-generate-preview`, and
  `models/gemini-omni-1.2-flash` (the one from the user's pasted sample; uses the Interactions API).
  Package: `@google/genai`.
- Code: lib.mjs (`generateVideo`, `saveGoogleKey`, `googleKeyState`, `VIDEO_MODELS`), server.mjs
  (`generate_video`), app-server.mjs (`/api/video`, `/api/google-key`, `directVideo`, Range support in
  `sendFile` so videos can be scrubbed), app.js (`video` state, `openStudio(mode, from)`).
- FIRST THING TO CHECK with a real key: one 4-second 720p Veo 3.1 Fast video (the cheapest). If Google
  refuses an option, the code retries once with only the shape; read the error text shown in the studio.

### Google Flow
- Flow has no API. Apps panel > "Google Flow" (also Ctrl+K "Google Flow", and a link in the Video Studio)
  opens https://labs.google/fx/tools/flow as a browser window of its own (`--app=`, the default browser when
  it is Chrome/Edge/Brave, with the user's normal profile and Google sign-in) and shows it in the middle.
  With another default browser, or in a plain browser tab, it simply opens the site.
- Only the window it opened itself is ever moved (a new window whose title does not end with the
  browser's name); the user's own browser windows are never touched. A second click reuses that window.
- Code: `openFlow` / `flowBrowser` in shell/main.cjs (the address is fixed there; the page can only send
  "flow"), `openFlow` in station.js, `#apps-flow` in index.html.
- Not checked: the real Flow site inside the docked window (needs the user's Google sign-in).

### ChatGPT
- Now switched on (`chatgptEnabled: true`); Codex CLI 0.167.2 is signed in with ChatGPT.
- Checked for real on 2026-11-13 (no fakes, a separate server on its own data folder and port): the brain
  asked ChatGPT through the app and got its answer, and with "Always allow" on it wrote a file in its
  workspace with no question; Activity logged "Allowed (always allow is on)".

### Small things in version 3
- "What's new in version 3" opens once for someone who used an older version in that window (never on a
  first start); Help has a "What's new" button, and Ctrl+K has it too. `NEWS` / `newsDue` in app.js.
- Gallery: All / Pictures / Videos (shown once there is at least one of each).
- Status bar: "Making a video… 0:42" while a video is being made (click opens the Video Studio); the
  Gemini counter also shows today's videos. Usage panel: a line with videos today / all time.
- Version is 3.0.0 in package.json, package-lock.json, app/app-server.mjs and server.mjs.

## Done in the last session (2026-11-13): programs in the middle (step 1)
- Apps panel (Alt+A). Press + to pick a program (.exe or shortcut). Click it: it starts (or its running
  window is found) and is shown in the middle of AI Brain, beside the chat (it can be moved like a panel).
  "Use it" brings it to the front, "Put it back" gives it its own size and place back.
  "Use a window that is open" docks any open window.
- How: the program stays its own window. A small helper (`shell/app-dock.cs`, compiled on first use with
  the .NET compiler that comes with Windows, into `%APPDATA%\AI Brain\helpers`) keeps it glued to the slot
  and right above AI Brain. Nothing is reparented. Dialogs, menus, a maximized panel, focus mode, the
  drop-files screen send it behind AI Brain while they are open.
- On small screens the panels shrink first, so the chat stays readable (at least about 320 px wide).
- Closing AI Brain puts the program back first. After a crash, `docked.json` puts it back on the next start.
- Refused: Discord, AI Brain itself, programs running as administrator (Windows does not allow it).
- Pins live in `%APPDATA%\AI Brain\apps.json`. A launcher (blender-launcher.exe -> blender.exe) is
  remembered as `ran`, so a running copy is found next time.

## Done in the last session (2026-11-13): move and resize everything
- Every panel, the chat and the program can be dragged by their title bar to any side of any other
  (or to an edge of the window); dropping in the middle of a panel swaps the two. Esc cancels a drag.
- The lines between them can be dragged (or focused and moved with the arrow keys) to change sizes.
- Settings > "Free-floating panels" (also in the Layout menu): panels go exactly where you drop them,
  overlap, and resize from any edge or corner. Switching it off snaps everything back into place.
  A floating panel on top of the program sends the program behind; clicking the program brings it back.
- The layout is a tree saved in settings ("v":2). Old saved layouts (left/right docks) are converted.
  The presets (Focus, Station, Everything, Social, Mine) work as before.
- Code: station.js (tiling engine at the top: tree helpers, solve(), layout(), drag and float);
  #tiles in index.html; #tiles/.leaf/.split/.rz rules in station.css.
- Small fix in shell/main.cjs (pinLaunched): a pinned program path written with forward slashes now
  matches the window a launcher opens (found while testing Blender).

## Next: step 2 (not started)
The AI edits the program while you watch, every change asking Allow/Deny first:
Blender through Python scripts (`blender --python` / a small add-on listening locally), Godot through the
project files (it reloads changed scenes and scripts).

## Still to check / ideas
- The brain with the REAL Google Flow: open Flow from Apps, sign in once, then ask the brain for one short video.
  If Flow changed, check `flow_look` output first. Also the real Veo key path is still untried.
- Try it with your own programs (Godot, Chrome). Chrome: an already-open Chrome window is docked, not a new one.
- A second monitor; Windows scaling other than 125%.
- Pin one of your REAL Discord chats and click it (only tested with a made-up chat number).
- Old Discord website data (38 MB) is still at `%APPDATA%\AI Brain\Partitions\discord` - safe to delete if you want.

## Earlier (2026-11-12)
1. File and command access (Settings > The brain): "Read only" or "Ask before each change" (Allow/Deny each).
2. Discord = the installed desktop app, pinned chats in the panel (Alt+D), nothing read from Discord.

## Files
- `lib.mjs` - settings, CLIs (Claude / Gemini / ChatGPT)
- `server.mjs` - MCP tools the brain uses (helpers, approve, Flow)
- `flow.mjs` - the brain's Google Flow control (DevTools protocol, labs.google pages only)
- `build-stamp.cjs`, `shell/server-check.cjs` - finding and replacing an older running server
- `app/app-server.mjs` - the web server and API
- `app/public/` - the page (index.html, app.js, station.js, css)
- `shell/` - the desktop window (Electron); `shell/app-dock.cs` the window helper for programs in the middle
- `test/` - automated tests (fake brain, no cost); `test/shell-test.mjs` the desktop window test
