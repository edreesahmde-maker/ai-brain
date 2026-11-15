# AI Brain

**One desktop app where an AI "brain" plans your task and calls other AIs for help, using the subscriptions you already have. No API keys needed.**

The brain is **Claude** (through Claude Code) or **ChatGPT** (through the Codex CLI), and you can switch between them in Settings.
It asks the other AIs (**Claude**, **ChatGPT**, **Gemini**) for second opinions, pictures and video. It can also edit files and run commands, but only after you click **Allow**, and it can use the programs you dock inside the app (Blender, Krita, editors, your browser).

> **Status:** works day to day on Windows, built and tested by one person so far. Expect rough edges. Pull requests are very welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).

---

## What it does

- **A brain and helpers.** You type one task. The brain plans it, asks the helpers when that's useful, compares their answers and gives you one. Work modes: *Auto*, *Solo*, *Team*, *Debate*, *Extreme* (draft, review and fix).
- **Pick the brain.** Claude or ChatGPT (Settings > The brain > Brain). The brain is never its own helper.
- **Subscriptions, not API keys.** It drives the official command-line tools (Claude Code, Codex CLI, Antigravity CLI), each signed in with your own account. Video through Google Veo is the one exception: it needs your own Google API key.
- **Safe file and command access.** *Read only* (default), *Ask before each change* (an Allow / Deny box for every file change and command), or *Always allow*. Sign-in folders (`.claude`, `.codex`, `.gemini`), Discord's data and AI Brain's own keys are always off limits.
- **Gemini can edit files.** Gemini writes the new version of a file and AI Brain saves it, after the same Allow / Deny.
- **Programs in the middle.** Dock any program in the app. The brain can work in it through a bridge (Blender and Krita via Python, the "Craft" apps via their MCP servers), through Windows accessibility (press, fill in and tick without moving the mouse), or with mouse and keyboard as a last resort. Move the mouse and it stops.
- **Web inspector.** A small browser extension lets the brain read tabs you choose to share: page code, network, console. Read only unless you ask for more.
- **Pictures and video.** Gemini makes pictures. Video comes from Google Veo (your API key, with a daily limit) or Google Flow (experimental).
- **A workstation, not just a chat.** Panels you can move and resize, sessions, a prompt library, a gallery, usage meters for every plan, themes, music controls and Discord beside you.

## Requirements

| What | Needed for | Notes |
|---|---|---|
| **Windows 10 or 11** | everything | The desktop window, program docking and accessibility helpers are Windows only (C# helpers compiled with the .NET compiler that comes with Windows). |
| **Node.js 22+** | everything | Tested on Node 24. |
| **[Claude Code](https://docs.claude.com/en/docs/claude-code)** signed in (`claude auth login`) | the Claude brain and Claude as a helper | |
| **[Codex CLI](https://github.com/openai/codex)** signed in (`npm i -g @openai/codex`, then `codex login`) | ChatGPT as brain or helper | Optional. |
| **Antigravity CLI** (`agy`) signed in with Google | Gemini (helper, pictures) | Optional. Looked for in `%LOCALAPPDATA%\agy\bin\agy.exe`, or set `AGY_EXE`. |
| Google API key with billing | Veo video | Optional. Added in Settings > Video; Google charges per clip. |
| Chrome, Edge or Brave | the web inspector extension, UI tests | Optional. |

## Download

Get **`AI-Brain-Setup-<version>.exe`** from [Releases](https://github.com/edreesahmde-maker/ai-brain/releases).
- It installs for your user only (no admin rights) and needs no Node.js.
- You still need **Claude Code** installed and signed in (`claude auth login`). ChatGPT and Gemini are optional, as above.
- The installed app keeps your data in `%APPDATA%\AI Brain\data`.

> Until the installer is code-signed, Windows may show "Windows protected your PC" when you run it. Click *More info > Run anyway* only if you downloaded it from this repo's Releases page.

**Code signing policy:** see [docs/CODE_SIGNING.md](docs/CODE_SIGNING.md) (free code signing provided by SignPath.io, certificate by SignPath Foundation, once approved). It also covers privacy: AI Brain sends nothing to its developers, and talks only to the AI services and Google features you choose to use.

## Getting started (from source)

```powershell
git clone https://github.com/edreesahmde-maker/ai-brain.git
cd ai-brain
npm install
npm start          # opens the desktop window (it starts the server itself)
```

The first time, check **Settings > The brain**:
- pick the brain;
- pick the file and command access (Read only is the default);
- switch on ChatGPT as a helper if you use it.

The app opens at `http://127.0.0.1:4777`. It only listens on your own computer and refuses requests from other web pages.

Other ways to start it:
- `powershell -File launch.ps1`: the same desktop window, or a Chrome or Edge app window if Electron isn't installed.
- `npm run server`: only the server; then open `http://127.0.0.1:4777` in a browser. Docking programs needs the desktop window.

Your data stays on your computer, in the project folder: chats (`sessions/`, `conversations/`), settings, usage counts, and pictures (`workspace/`). All of it is in `.gitignore`. Set `BRAIN_DATA_DIR` to keep it somewhere else.

## How it works

```
 you ──> app page (app/public)  <── live events ──  app server (app/app-server.mjs, 127.0.0.1:4777)
                                                         │ starts the brain for each task
                                                         ▼
                     Claude Code  -p --output-format stream-json      or      codex exec --json
                                                         │ MCP (stdio)
                                                         ▼
                                     ai-brain tool server (server.mjs)
             ask_gemini · ask_chatgpt / ask_claude · ask_both · generate_image · generate_video
             gemini_edit_file · flow_* · app_* (programs) · web_* (inspector) · approve
             read_file / list_folder / write_file / edit_file / run_command (when ChatGPT is the brain)
                                                         │
                       lib.mjs runs the helper CLIs (agy, codex, claude) read-only, counts usage
```

- **`app/app-server.mjs`** starts the brain for each task, turns its event stream into chat events, keeps sessions and handles the approvals. Every change and command waits here for your click.
- **`server.mjs`** is the MCP server that gives the brain its tools. The app gives it a fresh key for each task.
- **`lib.mjs`** runs the helper CLIs and holds settings, usage counting and the off-limits check (`forbidden()`).
- **`shell/`** is the Electron desktop window, plus C# helpers for docking programs (`app-dock.cs`) and for using them (`app-control.cs`).
- **`bridges/`** has the Blender and Krita add-ons that let the brain run Python inside them.
- **`extension/`** is the browser extension for the web inspector (load it unpacked).
- **`flow.mjs`** is the Google Flow control (DevTools protocol, `labs.google` pages only).

`HANDOFF.md` is the running development log: what was built, why, what was verified for real and what wasn't. Read it before larger changes.

## Safety model, in short

- **Read only** (default):
  - Claude gets only the `Read` tool.
  - ChatGPT runs read-only with its own shell switched off.
  - Neither can change anything.
- **Ask before each change:** every file change and every command shows you exactly what will happen, and runs only after **Allow**. No answer in 10 minutes counts as **Deny**.
- **Always allow:** nothing waits, but every step still goes through the same check and is listed in Activity.
- **Always:**
  - Sign-in data and AI Brain's keys are refused, whatever you click.
  - Each task gets new one-time keys.
  - Helpers run read-only, with one exception: in its normal requests, Gemini's own tools can still write inside its working folder (see `HANDOFF.md`).
  - Programs and the web inspector are off until you switch them on.

## Tests

The tests use fake CLIs, so they cost nothing and don't need any sign-in.

```powershell
npm test              # API tests: server, tools, approvals, both brains (about 2 minutes)
npm run test:ui       # the page in a real browser, through puppeteer-core (about 6 minutes; needs Chrome or Edge)
```

Tests that need real programs:
- `node test/shell-test.mjs`: the desktop window. **It moves your real mouse.**
- `node test/bridge-test.mjs`: Blender, Krita, Craft apps.
- `node test/inspect-test.mjs`: Brave.
- `node test/flow-test.mjs`: a fake Flow page.

Program paths can be set with environment variables (see the top of each test).

## Known limits

- **Windows only for now.** Porting the server and page is realistic; docking programs is the hard part.
- **ChatGPT as the brain** shows whole messages rather than letter-by-letter typing, and each turn sends a lot of tokens (Codex's own setup is large).
- **Gemini can't be the brain yet.** The Antigravity CLI can't keep its own file writes inside a folder.
- **Google Flow and Veo video** were tested against fakes, not the real services. Automating Flow may go against Google's terms.

## Disclaimer

AI Brain is an independent project. It isn't affiliated with or endorsed by Anthropic, OpenAI, Google, Discord or any program it docks. It uses your own accounts through their official tools: you're responsible for following their terms and for the usage on your plans. The *Berserk* theme is a fan-made look with original artwork. It isn't official and isn't affiliated with the manga or its publishers.

## Third-party code and fonts

- [marked](https://github.com/markedjs/marked) (MIT) and [DOMPurify](https://github.com/cure53/DOMPurify) (Apache-2.0 / MPL-2.0), in `app/public/vendor/`.
- Fonts under the SIL Open Font License 1.1: Inter, JetBrains Mono, Orbitron, Cinzel, Cormorant Garamond, Pirata One. Their licenses are in `app/public/vendor/fonts/OFL-*.txt`.

## License

[MIT](LICENSE). Fork it, change it, ship it.
