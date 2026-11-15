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

## Code signing

Without a signature, Windows SmartScreen shows "Windows protected your PC" and "Unknown publisher" when someone runs the installer. They can still click *More info > Run anyway*, but many people won't.

**What signing does and doesn't do:**
- Signing puts a verified publisher name on the installer, and Windows can tell nobody changed it.
- SmartScreen also looks at *reputation*, which a new app builds up as people download it.
- So for the first releases, a signed app can still get a warning, but with your name instead of "Unknown publisher". Since 2024, even the expensive "EV" certificates no longer skip this.

A certificate is always issued to a verified person or company, so the project owner has to get it. Three ways:

| Option | Cost | Publisher name shown | Notes |
|---|---|---|---|
| **SignPath Foundation** (free code signing for open-source projects) | free | SignPath Foundation | You apply with the project. Once approved, signing runs from GitHub Actions through SignPath's own action (added to the workflow then). |
| **Azure Artifact Signing** (formerly "Trusted Signing") | about US$10 a month | your verified name | Microsoft checks your identity. Not open to individuals in every country, so check Microsoft's current eligibility. Already wired into the workflow (below). |
| **A certificate from a certificate authority** (Certum, Sectigo, DigiCert, ...) | about US$50 to $500 a year | your verified name | The key must live on a hardware token or the CA's cloud service. Some CAs have cheaper offers for open-source developers. Using one from GitHub Actions depends on the CA's cloud signing. |

### Switching on Azure Artifact Signing

Once your Azure account, identity validation, signing account and certificate profile are set up, add these to the GitHub repo (*Settings > Secrets and variables > Actions*):

- **Secrets** (from an app registration that has the *Artifact Signing Certificate Profile Signer* role):
  - `AZURE_TENANT_ID`
  - `AZURE_CLIENT_ID`
  - `AZURE_CLIENT_SECRET`
- **Variables:**
  - `AZURE_SIGNING_ENDPOINT`: for example `https://eus.codesigning.azure.net/`
  - `AZURE_SIGNING_ACCOUNT`: the signing account name
  - `AZURE_SIGNING_PROFILE`: the certificate profile name
  - `AZURE_SIGNING_PUBLISHER`: the name on the certificate, exactly as it appears there

The next tag builds a signed installer. To check a signature, right-click the `.exe` > *Properties* > *Digital Signatures*, or run `Get-AuthenticodeSignature .\AI-Brain-Setup-<version>.exe`.
