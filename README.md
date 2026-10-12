<p align="center">
  <img src="./public/tawny-mark.svg" width="88" height="88" alt="Tawny logo">
</p>

<h1 align="center">Tawny</h1>

<p align="center">
  A quiet, keyboard-first voice layer for Windows.
</p>

<p align="center">
  Speak naturally. Work precisely.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-26302b?style=flat-square" alt="Windows">
  <img src="https://img.shields.io/badge/runtime-Electron-718965?style=flat-square" alt="Electron">
  <img src="https://img.shields.io/badge/license-private-d8d5ce?style=flat-square" alt="Private project">
</p>

## What Tawny is

Tawny is a Windows desktop companion designed to turn a global voice shortcut into focused actions in the app you are already using. It is built as a tray-resident Electron application rather than a browser tab.

The product direction is:

1. Capture a short voice command.
2. Transcribe and classify it safely.
3. Route supported actions.
4. Return the result to the previously focused application.

The current repository contains the desktop shell, first-run page, compact overlay, tray lifecycle, secure provider settings, pipeline state machine, and policy/gating foundations. Provider calls, microphone capture, native clipboard injection, and packaging are still being implemented in subsequent phases.

## Current experience

- Tawny opens with a calm main page on first launch.
- **Configure providers** opens editable credential settings.
- Credentials are encrypted with Electron `safeStorage`.
- **Run in background** changes Tawny into a tray-resident utility.
- `Ctrl + Alt + Space` toggles the compact top-center overlay.
- `Esc` cancels an active pipeline state.
- The overlay is frameless, rounded, transparent outside its light surface, and always on top while active.
- The interface uses local Windows typography and `lucide-react` icons; no external font or icon network request is required.

## Requirements

- Windows 10 or later
- Node.js 22 LTS
- pnpm

## Install

```powershell
git clone <repository-url>
cd Tawny
pnpm install
pnpm dev
```

The development command starts the Electron desktop shell and its local Vite renderer server. Keep the terminal open while Tawny is running.

## Build and verify

```powershell
pnpm typecheck
pnpm test
pnpm build
```

Available scripts:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start the Electron app with hot reload |
| `pnpm typecheck` | Run strict TypeScript validation |
| `pnpm test` | Run Vitest unit tests |
| `pnpm build` | Create the Electron/Vite production bundles |

## Provider credentials

Credentials are entered in the app:

1. Start Tawny with `pnpm dev`.
2. Select **Configure providers** on the main page.
3. Enter or edit the provider values.
4. Select **Save credentials**.

The current settings form supports:

| Setting | Intended use |
| --- | --- |
| Groq API key | Whisper transcription |
| Gemini API key | Image generation |
| Cloudflare account ID | Workers AI account |
| Cloudflare API token | Workers AI access |

Tawny writes encrypted credentials to Electron’s per-user application data directory. They are not stored in this repository, `.env` files, renderer local storage, or logs. `.env` files remain ignored for future development tooling and local test fixtures.

## Background mode

The main page remains open until **Run in background** is selected. Background mode:

- hides the main page,
- keeps Tawny in the Windows system tray,
- registers the global shortcut,
- shows the compact overlay at the top-center of the active monitor.

Tray actions include showing Tawny, hiding the overlay, opening settings, and quitting the app.

## Architecture

```text
src/
├── main/
│   ├── app.ts                 Electron lifecycle, tray, shortcut, windows
│   ├── preload.ts             Minimal contextBridge API
│   ├── settings.ts            Encrypted provider settings
│   └── pipeline/
│       ├── gate.ts            Wake phrase normalization and fuzzy matching
│       ├── machine.ts         XState lifecycle
│       └── policy.ts          Pure action-selection policy
├── renderer/
│   ├── main.tsx               Main page and compact overlay
│   └── styles.css             Light Tawny visual system
└── shared/
    └── contracts.ts           Zod schemas and shared types
```

Security boundaries:

- `contextIsolation: true`
- `nodeIntegration: false`
- Minimal preload API
- Zod validation at shared contract boundaries
- Provider credentials stored through Electron `safeStorage`
- Single-instance Electron lock

## Brand assets

The reusable Tawny mark is [public/tawny-mark.svg](./public/tawny-mark.svg). It is used by the renderer favicon, application identity, and tray icon.

## Roadmap

- [ ] Real microphone capture and audio persistence
- [ ] Groq Whisper provider with retries and fallback
- [ ] Cloudflare/local decision providers
- [ ] Gemini image generation provider
- [ ] Native Windows target-window capture
- [ ] Clipboard backup, paste, restore, and elevation checks
- [ ] Fault-injection and Electron end-to-end tests
- [ ] NSIS packaging and clean-machine verification

## Project principles

- Never lose the user’s input.
- Never paste into a different window.
- Uncertainty degrades to plain dictation.
- Provider failures must be visible and recoverable.
- Credentials never enter source control.
- Every phase ends with tests and explicit evidence.
