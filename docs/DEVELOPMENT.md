# Development and releases

This guide is for maintainers and contributors. End-user setup is in the [user guide](./USER-GUIDE.md); packaged app installation is in the [early-preview install notes](./INSTALL-EARLY-PREVIEW.md).

## Requirements

- Node.js 22
- pnpm 10 (CI pins pnpm 10.28.2)
- Windows, macOS, or Linux for platform development; native packaging should be run on its matching OS
- Optional Groq and Cloudflare Workers AI credentials for manual provider verification
- Firebase project/OAuth configuration for local sign-in development

## Get the source

```sh
git clone https://github.com/Priyank911/Tawny.git
cd Tawny
pnpm install --frozen-lockfile
```

Start the app in development:

```sh
pnpm dev
```

The Vite URL is the internal renderer server; interact with the Electron window.

## Local Firebase configuration

Copy `.env.example` to `.env` and set all four values:

```text
TAWNY_FIREBASE_API_KEY=
TAWNY_FIREBASE_PROJECT_ID=
TAWNY_GOOGLE_CLIENT_ID=
TAWNY_GOOGLE_CLIENT_SECRET=
```

Enable Google in Firebase Authentication and create a Google OAuth 2.0 client of type **Desktop app**. Keep the Firebase values and Google client values from the same project/client configuration. Tawny opens the system browser and uses PKCE with a loopback callback, following [Google’s native-app OAuth guidance](https://developers.google.com/identity/protocols/oauth2/native-app). Do not use a Firebase service-account key. The Google Desktop OAuth client secret is embedded in the Electron main-process bundle for token exchange and is recoverable from a distributed desktop binary; Google treats installed-app credentials as public-client values, not secrets suitable for protecting server resources. Never commit `.env`.

End users of an official release do not configure Firebase. The release workflow embeds the Firebase/OAuth configuration from GitHub Actions repository secrets and verifies it is present before publishing.

## Checks and builds

```sh
pnpm typecheck
pnpm test
pnpm build
```

| Command | Result |
| --- | --- |
| `pnpm typecheck` | Strict TypeScript validation. |
| `pnpm test` | Run the Vitest suite. |
| `pnpm build` | Build Electron main, preload, and renderer bundles. |
| `pnpm package` | Build and package unsigned installers for the current OS. |
| `pnpm preview` | Preview the built Electron/Vite app. |

GitHub Actions runs typecheck, tests, build, and native bundle packaging on Windows, macOS, and Ubuntu for pushes and pull requests.

## Release process

The **Early preview release** workflow runs only when a `v*` tag is pushed. It checks that the tag exactly matches `package.json` (for example, version `0.2.0` requires tag `v0.2.0`), builds installers on native CI runners, writes a `SHA256SUMS` manifest, and publishes a GitHub prerelease with installation notes.

Before tagging, configure these Actions repository secrets:

- `TAWNY_FIREBASE_API_KEY`
- `TAWNY_FIREBASE_PROJECT_ID`
- `TAWNY_GOOGLE_CLIENT_ID`
- `TAWNY_GOOGLE_CLIENT_SECRET`

The workflow uses GitHub’s provided `GITHUB_TOKEN` for publishing. Code-signing certificates are not currently configured, so Windows/macOS previews remain unsigned and may show reputation/security warnings. Read the [install notes](./INSTALL-EARLY-PREVIEW.md) before distributing a build.

Release checklist:

1. Update `package.json` version to a new version and run the local checks above.
2. Review `git status`, `git diff --check`, and the staged diff; confirm `.env` is ignored and not staged.
3. Commit and push the source commit to `main`; confirm cross-platform CI passes.
4. Create and push the exact matching version tag, such as `v0.2.0`.
5. In GitHub **Actions → Early preview release**, wait for Windows, macOS, Ubuntu packaging and the publishing job to succeed.
6. Open GitHub **Releases** and verify the platform installers, update metadata, installation notes, and `SHA256SUMS` are attached.

Do not re-push a tag for a different commit or overwrite an already-published release. If a release needs correction, increment the package version and publish a new tag.

## Adding tests and reporting issues

Keep provider response parsing, intent helpers, and policy logic testable without network calls. Add deterministic Vitest coverage for both expected responses and failure cases. Do not include API credentials, audio, transcripts, or selected text in fixtures or logs.

When opening a bug report, include the operating system, desktop session (X11/Wayland), Tawny version, reproduction steps, and sanitized event names/error messages. Never attach `.env`, `credentials.bin`, `auth-session.bin`, or an unredacted diagnostics file.
