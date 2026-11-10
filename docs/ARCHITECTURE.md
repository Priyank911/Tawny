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

### Windows

| Window | Loads | Shows | Never |
| --- | --- | --- | --- |
| App window | `index.html?view=main` | Rail with Home, Recordings, Activity and Settings pages; sign-in; update strip | Resized into the pill, records audio |
| Overlay window | `index.html?view=overlay` | Listening orb and status pill at the top centre; owns the shortcut recorder | Takes focus (it is non-focusable, so the app you were in stays the paste target) |
| Engine window (hands-free only) | `engine.html` | Nothing (hidden); always-on microphone | Exists while hands-free is off |

Both visible windows load the same React page and receive the same events; each view acts only on its own. They used to be one window that was resized to a 620x72 strip for every job, which crushed Settings into the pill when a wake arrived while Settings was open.

## Request workflow (what happens, and what you see when it fails)

Every request ends in exactly one visible outcome: a result, a confirmation prompt, or a message in the pill that says what went wrong. Nothing ends silently.

| Step | Hands-free | Shortcut | If it fails |
| --- | --- | --- | --- |
| 1. Start | `tawny-wake.exe` hears "hey/hi/okay Tawny" (local grammar). The orb appears. | Shortcut pressed. The pill appears. | Wake not heard: nothing happens (by design). Mic unavailable: pill says so. |
| 2. Capture | Engine clip: up to 6 s look-back, ends on the recognizer's end of sentence, ~1.2 s of silence, "Tawny send it", Esc or 60 s. | Recorder until the shortcut is pressed again. | Silent clip: "I heard Hey Tawny but nothing after it." |
| 3. Transcribe | Groq Whisper (`Hey Tawny.` spelling hint). | Groq Whisper. | Network or key problem: pill shows Groq's error. |
| 4. Command | The local wake is the confirmation. A leading wake phrase is stripped; otherwise the whole text is the command. Whisper's filler on silence ("Thank you.") is refused. | Lenient gate: "Hey Tawny" prefix optional. | "I only heard …" with the words. |
| 5. Route | Guardrails first (image, rewrite of a selection, content/code, control grammar), then the CLEF decider for anything addressed to Tawny. | Same; shortcut "open X" without the wake phrase runs only if X exists on the PC, otherwise it is dictation. | Decider unavailable or unsure: dictation (control needs 0.5 confidence, text needs 0.75). |
| 6. Act | Dictation and results paste into the app that had focus. Control: open (direct), switch (focus, then launch if Windows refuses), click/type via UI Automation; risky steps ask for Enter. | Same. | "I couldn't find X", "X is open but Windows would not bring it forward", or the provider's error. |

Tawny's own windows are never a control target.

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
wake → engine.beginSession → clip (command, often with the wake phrase) → WAV → Groq → commandFromWakeTranscript → router
```

- The local recognizer only triggers capture. It cannot tell "hey Tawny" from "hey honey", "hey Tony" or background talk: measured confidence for false matches (0.18–0.38) overlaps real ones (0.12–0.63). Whisper decides. If its transcript contains the wake phrase, the request runs. If not (people often say "Hey Tawny", wait for the orb, then speak), it runs only when it is a clear command matched by the fixed patterns (`acceptWakeWithoutPhrase`: open X, image, code or writing, or a rewrite with text selected). Otherwise it is dropped quietly (`wake.unconfirmed`), so overheard speech is never typed or acted on. Whisper's filler on near-silence is refused, and silent clips are never uploaded.
- Neither microphone path uses automatic gain control: Chromium's gain control changes the Windows microphone volume itself, which the shared wake recognizer depends on.
- The endpointer has three phases: the wake phrase itself, a grace period if only the phrase was said, then the command, which ends after about 1.4 s of silence, on “Tawny send it”, on Esc, or at 60 s.
- Everything audio-related that does not need a browser lives in `src/shared/audio` and is unit-tested with synthetic audio. The hotkey path still records with `MediaRecorder` and is unchanged.
- Watchdog: `tawny-wake.exe` emits a `level` heartbeat every 5 s and exits whenever live recognition completes (the input stream can end silently when a device sleeps or switches). `WakeService` restarts a helper that has been silent for 30 s, and refreshes a healthy one every 20 minutes after 8 s of quiet. Neither counts toward the crash-restart limit. Log event: `handsfree.recycle`.
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

Renderer `unresponsive`, `responsive`, and `render-process-gone` events are recorded locally for each window, and a crashed window is reloaded once. An unexpected exception or rejection in the main process is logged (`main.exception`, `main.rejection`) and fails the job in progress with a message, instead of Electron's crash dialog.

### Recording recovery

When a job fails after audio was captured (and was not cancelled), `processAudio` hands the audio, the error and any transcript to `RecoveryService.keep` (`src/main/recovery`). `RecoveryStore` writes AES-256-GCM files under `userData/recovery/` with a random key wrapped by `safeStorage`; without secure storage nothing is kept. **Transcribe again** queues retries one at a time. `GroqBudget` counts every Groq call (live ones too) in rolling windows against the free-tier limits for `whisper-large-v3-turbo`: 20 requests/min with 4 kept free for live use, 2,000/day, 7,200 audio-s/hour and 28,800/day, billed at least 10 s each. It waits up to 65 s when a retry would exceed a limit, and otherwise marks the recording as waiting. A 429's `retry-after` blocks retries until then. A WAV over 24 MB is split into valid pieces. On success the audio is deleted and only the text is kept. See `docs/DESIGN-APP-SHELL.md`.

### Updates

electron-updater downloads a new release in the background. Closing the window only hides Tawny to the tray, so waiting for a real quit meant updates never installed. Now a downloaded update installs about a minute later, as soon as Tawny is idle (or at once from **Restart now**, or on tray **Quit**): the helpers (`tawny-wake`, `tawny-control`, `keywatcher`) and the engine are stopped first so no file is locked, then a silent install starts and relaunches Tawny. Update errors are logged with their cause.

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
