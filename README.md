<p align="center">
  <img src="./public/tawny-mark.svg" width="88" height="88" alt="Tawny logo">
</p>

<h1 align="center">Tawny</h1>

<p align="center">
  A keyboard-first desktop voice layer for Windows, macOS, and Linux.
</p>

<p align="center"><strong>Speak naturally. Work precisely.</strong></p>

<p align="center">
  <a href="https://github.com/Priyank911/Tawny/actions/workflows/ci.yml"><img src="https://github.com/Priyank911/Tawny/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-26302b?style=flat-square" alt="Windows, macOS, and Linux">
  <a href="https://github.com/Priyank911/Tawny/releases"><img src="https://img.shields.io/badge/channel-early%20preview-718965?style=flat-square" alt="Early preview releases"></a>
</p>

> **Early preview:** Tawny is actively being tested across Windows, macOS, and Linux. Preview installers are unsigned and may show operating-system security warnings. Download only from the [official releases page](https://github.com/Priyank911/Tawny/releases), and read the [installation and verification notes](./docs/INSTALL-EARLY-PREVIEW.md) before installing.

**[Get Tawny](https://github.com/Priyank911/Tawny/releases) · [Install safely](./docs/INSTALL-EARLY-PREVIEW.md) · [User guide](./docs/USER-GUIDE.md) · [Report an issue](https://github.com/Priyank911/Tawny/issues)**

## Tawny, at a glance

Tawny is a small desktop voice layer for writing and common text tasks. Press a configurable keyboard shortcut, speak, and Tawny returns the result to the application you were using.

| Say what you want | What Tawny does |
| --- | --- |
| Speak a message | Transcribes it and pastes the words as dictation. |
| Select text, then give an editing instruction | Rewrites the selection and replaces it with the result. |
| Ask for an answer or code | Generates a response and pastes it at the cursor. |
| Describe an image to create | Generates an image, saves a local copy, and copies it to the clipboard. |

Ordinary speech remains dictation; Tawny does not turn every spoken question into an AI answer. Model-based rewriting, responses, and image generation are used for explicit requests.

## Get started

1. Download the installer for your operating system from [GitHub Releases](https://github.com/Priyank911/Tawny/releases). Use the install note for your OS, including checksum verification and unsigned-app warnings.
2. Open Tawny and sign in with Google. The sign-in page opens in your system browser and returns to the app.
3. Open **Configure providers** and add your own **Groq API key**, **Cloudflare account ID**, and **Cloudflare API token**, then save them. Create credentials in the [Groq console](https://console.groq.com/keys) and follow Cloudflare’s [Workers AI REST API setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/).
4. Grant microphone permission when prompted. Choose **Run in background** to use Tawny from the tray and keep the shortcut available.
5. Use **Settings → Recording shortcut** to change the shortcut and **Test key** to verify it.

The default shortcut is **Ctrl + Alt + Space**. Press it to start recording and press it again to stop. On Windows, holding the shortcut can also stop capture when it is released. The shortcut can be changed in Settings on all supported desktop platforms.

The app needs a network connection and accounts/API credentials for Groq and Cloudflare Workers AI. Provider usage may be subject to their current limits, terms, and pricing; check those directly before use.

## How a voice request flows

```text
Shortcut → microphone capture → Groq Whisper transcription → local intent guardrails
                                                     ├─ ordinary speech → clipboard → paste
                                                     ├─ selected-text edit → Cloudflare CLEF/Llama → replace selection
                                                     ├─ explicit answer/code request → Cloudflare CLEF/Llama → paste response
                                                     └─ image request → Cloudflare Flux → local image + clipboard
```

When text is selected, Tawny captures it before showing the overlay so it can keep the original app as the paste target. The spoken instruction and selected text are used together for an edit. A fast rewrite is optional: begin a selected-text rewrite with **“quick”**, for example, “quick, make this professional.”

Long recordings are divided into one-minute audio segments for transcription. On Linux Wayland, the desktop compositor controls global shortcuts and window placement; Tawny provides a compositor command when portal registration is unavailable. See the [user guide](./docs/USER-GUIDE.md) and [platform installation notes](./docs/INSTALL-EARLY-PREVIEW.md) for details.

## Privacy and data

- Microphone audio is sent to Groq for transcription. Plain dictation is not sent to a text-generation model after transcription.
- For explicit AI actions, the spoken instruction—and selected text when applicable—is sent to Cloudflare Workers AI. Image prompts are sent to Cloudflare for image generation.
- Provider credentials and the Firebase sign-in session are encrypted with the operating system’s secure storage. Linux requires a working Secret Service keyring or KWallet.
- Pipeline logs are stored locally and omit API keys, audio, transcript text, and selected-text contents. Tawny does not upload usage analytics or diagnostic logs.
- Generated images are saved in Tawny’s local application-data directory and copied to the clipboard. They are not automatically removed.

Read [Privacy, data handling, and local cleanup](./docs/USER-GUIDE.md#privacy-and-local-data) before using sensitive content.

## Documentation

- [User guide](./docs/USER-GUIDE.md) — first run, daily use, shortcut setup, troubleshooting, and local data.
- [Install notes](./docs/INSTALL-EARLY-PREVIEW.md) — Windows/macOS/Linux install steps, security warnings, and checksums.
- [Architecture](./docs/ARCHITECTURE.md) — pipeline states, provider routing, process boundaries, and failure handling.
- [Development and releases](./docs/DEVELOPMENT.md) — local setup, tests, Firebase configuration, CI, and publishing.

## Status and support

Tawny is an early-preview desktop app, not a finished or signed commercial release. Report reproducible bugs in [GitHub Issues](https://github.com/Priyank911/Tawny/issues). Before posting logs, remove personal details and never include API keys, audio, transcripts, or selected text. See [Troubleshooting](./docs/USER-GUIDE.md#troubleshooting) for the safest useful log entries to share.

---

## For contributors

Tawny is a small Electron app with separate main, preload, renderer, and platform layers. The main process owns provider calls, secure storage, shortcut registration, clipboard and paste integration, update checks, and local diagnostics. The renderer provides the overlay and settings UI.

For source setup, tests, Firebase development configuration, CI, and the release checklist, see [Development and releases](./docs/DEVELOPMENT.md). For the complete request-routing flow and platform boundaries, see [Architecture](./docs/ARCHITECTURE.md).
