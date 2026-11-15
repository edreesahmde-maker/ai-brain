# Contributing to AI Brain

Thanks for wanting to help. AI Brain is a small project with no build step: plain JavaScript (ES modules), one Node server, one HTML page and an Electron window. You can read all of it in an afternoon.

## Getting set up

1. Windows 10 or 11, Node.js 22 or newer.
2. `npm install`
3. `npm test`. The API tests use fake versions of Claude Code, Codex and Gemini, so you don't need any accounts to work on most of the code.
4. `npm start` opens the app. Sign in to Claude Code (`claude auth login`) to use it for real. Codex and the Antigravity CLI are optional (see the README).

Real tasks use **your** subscriptions, so keep manual checks small: Haiku and low effort are enough. For a manual check, run a separate server with its own data folder and port, so your real chats and settings are never touched:

```powershell
$env:BRAIN_DATA_DIR = "$env:TEMP\ai-brain-dev"; $env:BRAIN_PORT = "4790"; node app/app-server.mjs
```

## Where things are

| File | What it does |
|---|---|
| `app/app-server.mjs` | HTTP server and event stream; starts the brain (Claude or Codex) for each task; approvals; sessions; usage |
| `app/public/app.js`, `station.js` | the page: chat, panels, settings (`station.js` is the movable panel layout) |
| `server.mjs` | the MCP tool server the brain talks to (helpers, files, programs, web inspector, video) |
| `lib.mjs` | runs the helper CLIs; settings and their checks (`RULES`); usage files; `forbidden()` |
| `shell/` | Electron window; C# helpers for docking and using programs; app bridges |
| `flow.mjs` | Google Flow control (DevTools protocol) |
| `extension/` | the browser extension for the web inspector |
| `test/` | `api-test.mjs`, `ui-test.mjs`, and the fakes `fake-claude.mjs` and `fake-codex.mjs` |

`HANDOFF.md` is the development log. It records what was tried, what was verified with the real CLIs and what wasn't, and why things are the way they are. Please add a short entry for anything non-obvious you change.

## How we work

- **Small pull requests.** One change per PR, with a description of what you saw before and after.
- **Tests with the change.** New behaviour gets a check in `test/api-test.mjs` (server and tools) or `test/ui-test.mjs` (the page). Run `npm test` before you open the PR, and `npm run test:ui` if you touched the page.
- **Say what you checked for real.** If you tried it with a real CLI or program, say which one and what happened. If you only ran the fakes, say that. Both are fine; just be clear.
- **No new dependencies without a reason.** The app runs from plain files on purpose.
- **Plain words in the app.** Messages are short sentences a non-developer understands ("That folder does not exist.", not "ENOENT").
- **Comments say why**, not what.

## Safety rules (please keep these)

AI Brain lets an AI change files, run commands and click in programs, so these rules matter more than anything else:

1. **Every change goes through the approval check.** A new tool that writes, deletes, runs or sends something must ask through `/api/approval/ask` (see `askUser` / `mayRun` in `server.mjs`). That keeps *Read only*, *Ask* and *Always allow* working the same way for it.
2. **Never touch sign-in data.** Paths and inputs go through `forbidden()` in `lib.mjs`. Don't weaken it.
3. **Local only.** The server binds `127.0.0.1` and checks the `Origin` of every request. Don't open it to the network.
4. **Keys stay out of the page and out of the brain's reach.** Per-task keys live in the environment of the tool server, never in the page and never in commands the brain runs.
5. **Helpers are read-only.** If a helper should change something, AI Brain does the change after approval (see `gemini_edit_file`).

Found a security problem? Please don't open a public issue. Use GitHub's private vulnerability reporting (Security tab > Report a vulnerability).

## Good first issues

Look for the [`good first issue`](../../issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) label. Each one says where to look and how to test it. Comment on the issue before you start, so two people don't do the same work.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
