# Releasing AI Brain

## Build the installer on your own PC

```powershell
npm run dist
```

This makes `dist\AI-Brain-Setup-<version>.exe`, a normal Windows setup.
- It installs for the current user only, so it needs no admin rights.
- It lets you pick the folder.
- It adds Start menu and desktop shortcuts.

`dist\win-unpacked\` holds the same app without the installer.

How the installed app differs from running from source:
- **No Node.js needed.** The server runs on the Node that's built into Electron (`ELECTRON_RUN_AS_NODE`).
- **Data lives in `%APPDATA%\AI Brain\data`**, not in the program folder, so updates never touch your chats or settings. Running from source still uses the project folder.
- **People still need Claude Code** (signed in) for the brain. The Codex CLI and the Antigravity CLI stay optional.

To run the whole API test suite against the packaged app:

```powershell
$env:BRAIN_TEST_NODE = "dist\win-unpacked\AI Brain.exe"
$env:BRAIN_TEST_APP_DIR = "dist\win-unpacked\resources\app"
npm test
```

## Make a release

1. Raise the version in `package.json`, `package-lock.json` (two places), `VERSION` in `app/app-server.mjs` and `server.mjs`. Update "What's new" (`#dlg-new` in `app/public/index.html`, `NEWS` in `app/public/app.js`) and the version check in `test/ui-test.mjs`.
2. Run `npm test` and `npm run test:ui`.
3. Commit, then tag and push:
   ```powershell
   git tag v3.3.0
   git push origin master v3.3.0
   ```
4. GitHub Actions (`.github/workflows/release.yml`) runs the tests, builds the installer, and attaches it to the release for that tag (it creates the release if needed). Then write the release notes on GitHub.

You can also start the workflow by hand (Actions > *Build the Windows installer* > *Run workflow*). It then only builds, and the installer is a download on the run's page.

## Code signing (SignPath Foundation)

AI Brain uses the [SignPath Foundation](https://signpath.org) program: free code signing for open-source projects. The certificate belongs to SignPath Foundation, so Windows shows **"SignPath Foundation"** as the publisher. The project's policy (roles, privacy, what is signed) is in [CODE_SIGNING.md](CODE_SIGNING.md).

**What signing does and doesn't do:**
- Signing removes "Unknown publisher", and Windows can tell nobody changed the installer.
- SmartScreen also looks at *reputation*, which a new app builds up as people download it, so the first signed releases may still show a warning for a while. No certificate skips that.

### One-time set-up (the project owner)

1. Turn on two-factor login on GitHub (*Settings > Password and authentication*). SignPath requires it for everyone on the project.
2. Apply at <https://signpath.org/apply> with:
   - the repository: `https://github.com/edreesahmde-maker/ai-brain`
   - the license (MIT)
   - the download page (GitHub Releases)
   - the code signing policy (`docs/CODE_SIGNING.md`)
   - a short description: *a Windows desktop app where Claude or ChatGPT plans a task and asks other AIs for help, through the user's own signed-in command-line tools; it can change files, run commands and use programs only after the user allows it.*
3. Once approved, in SignPath:
   - create the project;
   - add a *trusted build system* for GitHub.com and link it;
   - create a signing policy with you as the **Approver**;
   - paste the artifact configuration from [`signpath/artifact-configuration.xml`](signpath/artifact-configuration.xml) (SignPath may adjust it);
   - make an API token for a user who is a **Submitter**.
4. In the GitHub repo (*Settings > Secrets and variables > Actions*), add:
   - **Secret** `SIGNPATH_API_TOKEN`
   - **Variables:**
     - `SIGNPATH_ORGANIZATION_ID`
     - `SIGNPATH_PROJECT_SLUG`
     - `SIGNPATH_SIGNING_POLICY_SLUG`

### Every release, after that

What happens when you push a tag:
1. The workflow builds the installer and sends it to SignPath.
2. You get a signing request to approve in SignPath. The workflow waits up to an hour.
3. Once you approve, it checks the signature (`Get-AuthenticodeSignature` must say *Valid*) and attaches the signed installer to the release.

If the signature isn't valid, nothing is published.

Each release's notes must link the code signing policy. To check a signature yourself: right-click the `.exe` > *Properties* > *Digital Signatures*, or run `Get-AuthenticodeSignature .\AI-Brain-Setup-<version>.exe`.

### Other ways to sign

If SignPath doesn't fit, two paid options put your own name on the installer. The workflow's signing step would need to change for either.
- Microsoft's Azure Artifact Signing (about US$10 a month; not open to individuals in every country).
- A certificate from a certificate authority such as Certum or Sectigo.
