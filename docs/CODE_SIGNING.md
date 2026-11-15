# Code signing policy

Free code signing provided by [SignPath.io](https://about.signpath.io), certificate by [SignPath Foundation](https://signpath.org).

> Status: AI Brain has applied to the SignPath Foundation program. Until it's approved, installers are **not** signed, and the release notes say so.

## What is signed

Only the Windows installer (`AI-Brain-Setup-<version>.exe`) that GitHub Actions builds from this repository's source (`.github/workflows/release.yml`). Each one is built on GitHub-hosted runners from a version tag, after the test suite passes. Nothing built on a personal computer is ever signed.

Third-party programs AI Brain can work with (Claude Code, Codex CLI, Antigravity CLI, Blender, Krita, Discord, browsers) aren't part of the package and are never signed by this project.

## Team and roles

| Role | Who | What they do |
|---|---|---|
| Author | [Edres Mohamed (@edreesahmde-maker)](https://github.com/edreesahmde-maker) | may change the source |
| Reviewer | [Edres Mohamed (@edreesahmde-maker)](https://github.com/edreesahmde-maker) | reviews every pull request from someone without commit access before it's merged |
| Approver | [Edres Mohamed (@edreesahmde-maker)](https://github.com/edreesahmde-maker) | approves each signing request by hand, one per release |

The current list of people with commit access is in the repository's collaborators. Everyone in these roles uses multi-factor authentication for GitHub and for SignPath.

## Privacy

AI Brain sends **no** information to its developers, and has **no** telemetry or update checks of its own. Everything it keeps (chats, settings, usage counts, pictures) stays on your computer, in `%APPDATA%\AI Brain\data` for the installed app.

It talks to other systems only when you use a feature that needs them, and only to the service that feature is for:

- **The AI services you sign in to:**
  - Anthropic (Claude, through Claude Code)
  - OpenAI (ChatGPT, through the Codex CLI)
  - Google (Gemini, through the Antigravity CLI)

  Your tasks, and the files or pictures you attach or allow the brain to read, are sent to them through their own official command-line tools. Those tools and services have their own privacy policies.
- **Google's video service** (Veo), with your own API key, only when you make a video. **Google Flow** (`labs.google`), only when you open it.
- **Programs you choose to dock or open** (for example Discord or Blender) run as themselves.

Each of these is off or unused until you set it up or ask for it.

## Reporting a problem

If you think a signed AI Brain file is misused or malicious, use GitHub's private vulnerability reporting (Security tab > Report a vulnerability), or contact [SignPath Foundation](https://signpath.org).
