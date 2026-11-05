# Tawny architecture

This document describes the implementation in `src/`. It is a maintainer reference; for setup and everyday use, see the [user guide](./USER-GUIDE.md).

## Runtime overview

Tawny is an Electron desktop app with three runtime layers:

| Layer | Responsibilities |
| --- | --- |
| Renderer (`src/renderer`) | First-run and sign-in UI, compact overlay, microphone capture via `MediaRecorder`, shortcut/settings controls, and live diagnostics. |
| Preload (`src/main/preload.ts`) | Narrow `contextBridge` API for explicit IPC requests and events; no Node.js integration in the renderer. |
| Main (`src/main`) | App lifecycle, global shortcut and tray, routing, provider calls, secure storage, clipboard, image persistence, OS-specific paste, updater, and structured logs. |

`src/shared/contracts.ts` contains shared Zod schemas and types. Renderer requests cross the preload bridge; the main process validates and performs privileged operations.

## Audio-to-action flow

```text
global shortcut / compositor --trigger
  → capture selected text and preserve current clipboard
  → renderer records mono WebM/Opus audio in 60-second segments
  → main sends segments in order to Groq Whisper
  → wake-phrase extraction + explicit local intent checks
  → optional Cloudflare CLEF decision and text/image model
  → write result to clipboard and attempt paste into prior target app
  → overlay reports done, clipboard fallback, or an actionable failure
```

The wake phrases in `src/main/pipeline/gate.ts` can be used to strip a leading phrase; they are not required for ordinary dictation. The full transcript remains the command if no wake phrase is recognized.

Routing (`src/main/pipeline/router.ts`) follows fixed rules, in priority order:

1. Speech that was not addressed to Tawny (shortcut, no wake phrase) is plain dictation and never reaches a model.
2. Deterministic guardrails win when they match: an explicit image request, an edit of selected text, an explicit answer/code request, or a control command the local grammar understands. CLEF then only chooses the model tier for those.
3. Speech addressed to Tawny that no guardrail matched is classified by CLEF (`plain_dictation`, `text_rewrite`, `text_query`, `image_generate`, `computer_control`). A missing, failed or low-confidence (below 0.75) answer means dictation, never action.
4. A `quick`/`fast` prefix on a selected-text rewrite skips the decider and chooses the fast model.

For an edit, Tawny sends the spoken instruction and selected text together, validates/sanitizes the returned text, retries suspiciously incomplete rewrites once, then replaces the selection only with a complete result. For an answer/code request, selected text is optional context. Image output is saved as a JPEG under Electron `userData` and also written to the native image clipboard.

## Pipeline state machine

`src/main/pipeline/machine.ts` owns the high-level user-visible lifecycle:

| State | Purpose | Typical transition |
| --- | --- | --- |
| `idle` | Ready for a new job | shortcut → `arming` |
| `arming` | Request/start audio capture | ready → `recording`; cancel/failure → terminal state |
| `recording` | Collect audio | stop → `finalizing`; Escape → `cancelled` |
| `finalizing` | Finish current segment and release microphone | → `transcribing` |
| `transcribing` | Upload audio to Groq | → `gating` |
| `gating` | Normalize/strip optional wake phrase | → `deciding` |
| `deciding` | Resolve plain dictation vs. explicit action | → `handling` or `injecting` |
| `confirming` | Waiting for an answer before a risky control step | Enter/shortcut → `handling`; Esc/12 s timeout → `cancelled` |
| `handling` | Call text/image model | → `injecting` |
| `injecting` | Clipboard write and OS paste attempt | success → `done` |
| `done`, `failed`, `cancelled` | Show outcome and return to ready state | timed transition to `idle` |

A `DISCARD` event returns a job to `idle` without any outcome flash. Hands-free uses it for clips that were not a real wake phrase.

The UI receives sanitized snapshots and structured logs. Sensitive payload contents are not included in persisted pipeline logs.

## Provider integrations

| Service | Current route | Purpose |
| --- | --- | --- |
| Groq | `whisper-large-v3-turbo` | Multilingual audio transcription. Segments are uploaded sequentially; request timeout scales with segment size (60–180 seconds), and retryable network/service failures receive up to three attempts. |
| Cloudflare Workers AI | `@cf/cloudflare/clef` | Intent/tier decision for explicit model tasks. |
| Cloudflare Workers AI | `@cf/meta/llama-3.1-8b-instruct-fast` | Opt-in quick rewrite. |
| Cloudflare Workers AI | `@cf/meta/llama-3.1-8b-instruct-fp8` | Low-tier rewrite/response. |
| Cloudflare Workers AI | `@cf/meta/llama-3.3-70b-instruct-fp8-fast` | Balanced rewrite/response. |
| Cloudflare Workers AI | `@cf/black-forest-labs/flux-1-schnell` | Image generation. |

CLEF calls time out after 15 seconds; text operations and image generation use 45-second timeouts. These provider model identifiers are implementation details and should be checked against current provider catalogs before changing them. See the official [Groq speech-to-text guide](https://console.groq.com/docs/speech-to-text) and [Cloudflare FLUX model page](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/).

## Clipboard and platform behavior

- Selected-text capture snapshots clipboard formats, writes a temporary marker, requests `Ctrl+C`/`Cmd+C`, reads the selected text, then restores the snapshot.
- Text/image results are written to the system clipboard before automatic paste is attempted.
- Windows uses PowerShell `SendKeys` and a small native key watcher for release detection/topmost support.
- Releases are Windows only. Source guards for macOS and Linux remain in `inject.ts` and the hotkey code but are not built, tested or shipped.
- Settings and shortcut-capture state are tracked in the main process so incoming shortcut triggers cannot unexpectedly start voice capture while the user is editing settings.

## Hands-free mode

```text
tawny-wake.exe (Windows speech recognizer, offline)  → hypotheses as text → WakeDetector (cooldown, rate limit)
engine window (hidden, mic, 16 kHz AudioWorklet)     → CaptureCore: ring buffer, energy VAD, SessionEndpointer
wake → engine.beginSession → clip (wake phrase + command) → WAV → Groq → splitWakePhrase (strict) → router
```

- The recognizer only suggests a wake; Whisper must confirm that the clip starts with a greeting plus the name, otherwise the job is discarded with no side effects. Clips with almost no speech are never uploaded.
- The endpointer has three phases: the wake phrase itself, a grace period if only the phrase was said, then the command, which ends after about 1.4 s of silence, on “Tawny send it”, on Esc, or at 60 s.
- Everything audio-related that does not need a browser lives in `src/shared/audio` and is unit-tested with synthetic audio. The hotkey path still records with `MediaRecorder` and is unchanged.
- The engine window exists only while hands-free is on, so turning it off releases the microphone. Lock and sleep pause it.

## Computer control

```text
spoken command → controlGrammar (local) ──┐
                  or planner (CLEF 70B, JSON mode) ┴→ Plan (zod, ≤ 8 steps, closed verb set) → assessPlan → confirm?
                  → PlanExecutor → TargetResolver (drive/folder/app/window/site) → tier 0: direct OS open
                                                                                  → tier 1: tawny-control.exe (UI Automation, real cursor, SendInput)
                                                                                  → tier 2: vision (opt-in screenshot)
```

Verbs: `open`, `open_path`, `launch_app`, `open_url`, `focus_window`, `ui_click`, `type`, `key`, `scroll`, `window`, `wait`. There is no shell verb. Shells, scripts and executables are blocked by name and extension; typing and keys are refused while a shell or elevated window is in front; destructive labels, closing windows, type-then-Enter and planner-originated URLs need a confirmation; ambiguous matches are refused instead of guessed; moving the mouse or pressing Esc aborts. Window titles passed to the planner are quoted as untrusted data.

## Authentication and local storage

Google OAuth uses the system browser and a temporary loopback callback. Firebase validates the Google credential. The refresh session is encrypted and stored in `auth-session.bin` under Electron `userData`; provider credentials are encrypted into `credentials.bin`. Shortcut preferences are in `hotkey.json` and behavior switches (hands-free, cursor style, vision) in `behavior.json`; diagnostics are in `logs/pipeline.jsonl`; generated JPEGs are stored beside these files.

Electron `safeStorage` is required. Signing out removes the persisted Firebase session, but does not remove provider credentials or generated images.

## Diagnostics and recovery

`src/main/logger.ts` keeps a bounded in-memory log and appends JSONL locally. Logs include event names, timing, state, byte/character counts, and sanitized errors; they must not include API credentials, transcripts, or selected text.

Renderer `unresponsive`, `responsive`, and `render-process-gone` events are recorded locally. A renderer process exit triggers at most one reload attempt for the process lifetime. This is renderer recovery, not proof that a main-process crash or OS-level hang has been fixed.

## Source map

```text
src/main/app.ts                    Electron lifecycle and orchestration
src/main/pipeline/machine.ts       XState lifecycle
src/main/pipeline/gate.ts          Wake-phrase extraction, strict hands-free gate, send phrase
src/main/pipeline/router.ts        Intent routing rules and reconciliation with the decider
src/main/pipeline/controlGrammar.ts Local grammar for control commands
src/main/control/                  Plan schema and safety, resolver, executor, planner, vision, helper client
src/main/wake/                     Wake detector and recognizer service
src/main/engine/engineHost.ts      Hidden microphone window
src/main/native/                   tawny-control.cs, tawny-wake.cs (C# 5, compiled by pnpm build:native)
src/shared/audio/                  VAD, endpointer, ring buffer, capture core, WAV
src/main/pipeline/intent.ts        Explicit local intent dictionaries
src/main/pipeline/policy.ts        Pure action policy helpers
src/main/providers/groqWhisper.ts  Audio upload, timeout, retries, schema validation
src/main/providers/cloudflareClef.ts CLEF, rewrite, and response APIs
src/main/providers/cloudflareFlux.ts Image generation API
src/main/inject.ts                 Clipboard and OS paste/copy behavior
src/main/auth.ts                   Google OAuth, Firebase session, secure storage
src/main/settings.ts               Encrypted provider credentials
src/main/updater.ts                Release checks and platform updater
src/main/logger.ts                 Local structured diagnostics
src/renderer/main.tsx              UI, audio capture, app-side settings
src/shared/contracts.ts            Shared schemas and types
test/                              Unit and provider contract tests
```

For local commands, credentials, CI, and release publishing, see [Development and releases](./DEVELOPMENT.md).
