<p align="center">
  <img src="./public/tawny-mark.svg" width="88" height="88" alt="Tawny logo">
</p>

<h1 align="center">Tawny</h1>

<p align="center">
  A private, keyboard-first voice layer for Windows.
</p>

<p align="center"><strong>Speak naturally. Work precisely.</strong></p>

<p align="center">
  <img src="https://img.shields.io/badge/platform-Windows-26302b?style=flat-square" alt="Windows">
  <img src="https://img.shields.io/badge/runtime-Electron-718965?style=flat-square" alt="Electron">
  <img src="https://img.shields.io/badge/tests-15%20passing-718965?style=flat-square" alt="15 tests passing">
  <img src="https://img.shields.io/badge/license-private-d8d5ce?style=flat-square" alt="Private project">
</p>

## What Tawny does

Tawny is a Windows tray utility that turns one global shortcut into four focused actions:

- **Plain dictation:** transcribe speech and paste the text into the application that was focused before Tawny opened.
- **Image generation:** detect an image request, generate the image with Cloudflare Workers AI Flux, copy the image to the Windows clipboard, paste it into the focused application, and show a preview in Tawny.
- **Selected-text rewriting:** capture text selected in the focused application, combine it with the spoken instruction, ask Cloudflare CLEF to select the correct action/tier, rewrite it with a low or balanced Llama model, and replace the selection.
- **Text/code generation:** use the spoken request and optional selected-text context to generate a response or code, then paste it at the cursor.

The application is designed around a short, observable pipeline. Every important boundary emits a structured log entry, provider failures are surfaced in the overlay, and the pipeline uses explicit states instead of an unbounded loading spinner.

## End-to-end pipeline

```text
Ctrl + Alt + Space
        │
        ▼
   arming
        │  request microphone permission
        ▼
   recording ─────────────── Esc ───────────────▶ cancelled
        │  shortcut / Finish capture
        ▼
   finalizing
        │  WebM/Opus audio from MediaRecorder
        ▼
   transcribing
        │  Groq Whisper: whisper-large-v3-turbo
        ▼
   gating
        │  wake phrase normalization and routing
        ▼
   deciding
      │  selected text + voice command are sent together
      ▼  Cloudflare CLEF: @cf/cloudflare/clef
   ┌──┼───────────────┬────────────────┐
   │  │               │                │
 image rewrite       query/code       dictation
   │  │               │                │
 Flux CLEF/Llama     CLEF/Llama        clipboard text
   │  │               │                │
   └──┴───────────────┴─────── Ctrl + V
                         │
                        done
```

### Plain dictation

Speech is treated as dictation by default, whether or not it contains a wake phrase. Only an explicit rewrite, image, or assistant-generation command is routed to a model; ordinary questions and conversational sentences are pasted exactly as transcribed:

```text
audio → Groq Whisper → transcript → clipboard.writeText → Ctrl+V → done
```

Long recordings are rotated into 60-second WebM segments while the microphone remains open. Groq transcribes the segments in order and carries the previous transcript tail as context, so multi-minute dictation does not depend on one oversized upload or one fixed 30-second request timeout. This also keeps hour-long recordings below Groq's per-upload limits.

### Image generation

Speech containing a supported image request is routed to Cloudflare Flux:

```text
audio → Groq Whisper → intent detection → Cloudflare Flux
      → validated Base64 JPEG → userData image file
      → native Windows image clipboard → Ctrl+V → overlay preview → done
```

The generated image is both saved locally and placed on the clipboard. This makes the result available even when the target application rejects simulated keyboard input.

### Selected-text commands

When text is already selected, Tawny captures it before opening the overlay so the original application remains the paste target. The spoken command and selected text are passed to Cloudflare CLEF together. CLEF chooses one intent (`text_rewrite`, `text_query`, `image_generate`, or `plain_dictation`) and a model tier (`low` or `balanced`), while local explicit-command guardrails prevent ordinary dictation from being upgraded into an assistant response. A local command dictionary acts as a deterministic fallback and guardrail for common editing language such as translation, grammar correction, professional/casual tone, rewriting, paraphrasing, summarizing, and concise/expanded output.

For rewriting, the selected text is sent to the chosen Cloudflare Llama model with strict output instructions. The response is sanitized before injection: labels, markdown/code fences, Python or regex hallucinations, repeated backticks, self-review commentary, and repeated transformed sentences are removed or rejected. Non-summary rewrites that are suspiciously shorter than the source are retried once with meaning-preservation instructions; if the retry is still incomplete, Tawny leaves the selection untouched and reports a recoverable error. Only one complete transformed text result is pasted back over the original selection. For questions or code requests, the selected text is supplied as context and the generated answer is pasted at the cursor.

For an opt-in faster rewrite, begin the voice command with `quick`, `fast`, `instant`, or `speedy`, for example: `quick make it professional`. Tawny removes the trigger, skips the extra CLEF tier-selection request, and uses the active fast 8B model. The normal rewrite path remains the quality-first default and still lets CLEF choose between low and balanced tiers.

## Architecture

```text
src/
├── main/
│   ├── app.ts
│   │   ├── Electron lifecycle and single-instance lock
│   │   ├── tray, global shortcut, overlay positioning
│   │   ├── microphone permission handlers
│   │   ├── pipeline actor and snapshot updates
│   │   └── provider/injection orchestration
│   ├── inject.ts
│   │   ├── clipboard text and simulated Ctrl+V
│   │   └── native image clipboard and simulated Ctrl+V
│   ├── logger.ts
│   │   ├── structured console output
│   │   ├── renderer log events
│   │   └── JSONL persistence
│   ├── preload.ts
│   │   └── minimal contextBridge IPC surface
│   ├── settings.ts
│   │   └── encrypted provider credentials
│   ├── pipeline/
│   │   ├── machine.ts
│   │   │   └── XState lifecycle and legal transitions
│   │   ├── gate.ts
│   │   │   └── wake phrase normalization/matching
│   │   ├── intent.ts
│   │   │   └── local image, rewrite, and query dictionaries
│   │   └── policy.ts
│   │       └── pure routing policy helpers
│   └── providers/
│       ├── groqWhisper.ts
│       │   └── Groq multipart audio transcription
│       ├── cloudflareFlux.ts
│       │   └── Cloudflare Workers AI image client
│       └── cloudflareClef.ts
│           └── CLEF intent/tier decider and low/balanced text models
├── renderer/
│   ├── main.tsx
│   │   ├── first-run page
│   │   ├── compact overlay
│   │   ├── MediaRecorder lifecycle
│   │   ├── provider settings
│   │   └── live diagnostics
│   ├── styles.css
│   │   └── compact light Tawny visual system
│   └── vite-env.d.ts
└── shared/
    └── contracts.ts
        └── Zod schemas and shared IPC/domain types
```

### Process boundaries

The renderer owns visible UI and microphone recording. The main process owns privileged operations:

| Boundary | Responsibility |
| --- | --- |
| Renderer → preload | Request microphone access and collect `MediaRecorder` chunks |
| Preload → main | Send audio bytes, settings operations, pipeline events, and IPC requests |
| Main → providers | Call Groq and Cloudflare over HTTPS |
| Main → Windows | Write encrypted settings, save generated files, access the clipboard, simulate `Ctrl+V` |
| Main → renderer | Send sanitized overlay snapshots and structured log entries |

The preload exposes only explicit functions through `contextBridge`; the renderer never receives Node.js or Electron primitives directly.

## Pipeline state machine

The XState machine in [`src/main/pipeline/machine.ts`](./src/main/pipeline/machine.ts) is the source of truth for user-visible state:

| State | Meaning | Main exit paths |
| --- | --- | --- |
| `idle` | No active job | `HOTKEY → arming` |
| `arming` | Preparing microphone capture | `AUDIO_READY → recording`, `CANCEL → cancelled` |
| `recording` | Capturing microphone audio | `STOP → finalizing`, `CANCEL → cancelled` |
| `finalizing` | Stopping recorder and assembling audio | `STAGE → transcribing`, `FAIL → failed` |
| `transcribing` | Uploading audio to Groq | `STAGE → gating`, `FAIL → failed` |
| `gating` | Checking wake phrase and preparing the command | `STAGE → deciding` |
| `deciding` | Combining selected text, voice command, local dictionary, and CLEF routing | `STAGE → handling` or `STAGE → injecting` |
| `confirming` | Optional confirmation state | `CONFIRM/HOTKEY → handling` |
| `handling` | Running a confirmed action | `STAGE → injecting`, `FAIL → failed` |
| `injecting` | Pasting text or image into the target app | completion → `done` |
| `done` | Successful result; visible for five seconds | `HOTKEY → arming`, timeout → `idle` |
| `failed` | Recoverable visible failure | `HOTKEY → arming`, timeout → `idle` |
| `cancelled` | User cancelled the active job | timeout → `idle` |

All currently supported actions finish through `injecting → done`; the confirmation state remains available for future high-risk actions.

## Providers

### Groq Whisper

- Endpoint: `https://api.groq.com/openai/v1/audio/transcriptions`
- Model: `whisper-large-v3-turbo`
- Input: WebM/Opus bytes from `MediaRecorder`
- Request format: multipart form data
- Timeout: 30 seconds
- Response: validated `{ text: string }`

### Cloudflare Workers AI Flux

- Model: `@cf/black-forest-labs/flux-1-schnell`
- Endpoint: Cloudflare account AI Run API
- Input: validated prompt and diffusion-step count
- Timeout: 45 seconds
- Response: validated Cloudflare envelope or direct image response
- Output: Base64 JPEG

### Cloudflare CLEF and text models

- Decider: @cf/cloudflare/clef
- Fast rewrite tier: @cf/meta/llama-3.1-8b-instruct-fast
- Low tier: @cf/meta/llama-3.1-8b-instruct-fp8
- Balanced tier: @cf/meta/llama-3.3-70b-instruct-fp8-fast

The rewrite models use the current routable Workers AI IDs. Retired
`@cf/meta/llama-3.1-8b-instruct` and `@cf/meta/llama-3.1-70b-instruct-fp8`
IDs must not be used because Cloudflare returns `7000: No route for that URI`.
- CLEF timeout: 15 seconds
- Text generation/rewrite timeout: 45 seconds
- Groq transcription timeout: 60–180 seconds per audio segment, based on segment size
- If CLEF is unavailable, local intent dictionaries preserve safe routing for explicit image, rewrite, and query commands.

Cloudflare errors are classified as permanent, transient, or timeout failures through [`PipelineError`](./src/shared/contracts.ts). API credentials and transcript contents are excluded from logs; diagnostics record only transcript length.

## Credentials

Credentials are entered inside Tawny:

1. Start the application.
2. Select **Configure providers**.
3. Enter the values below.
4. Select **Save credentials**.

| Setting | Used for |
| --- | --- |
| Groq API key | Whisper transcription |
| Cloudflare account ID | Workers AI account endpoint |
| Cloudflare API token | Flux image generation |

Electron `safeStorage` encrypts the credentials in the per-user application data directory. Tawny does not use `.env` files for runtime credentials, does not place keys in renderer storage, and does not write them to logs.

## Running Tawny

### Requirements

- Windows 10 or later
- Node.js 22 LTS
- pnpm
- A Groq API key
- A Cloudflare account ID and API token with Workers AI access

### Install and develop

```powershell
git clone <repository-url>
cd Tawny
pnpm install
pnpm dev
```

Keep the terminal open while running `pnpm dev`. The Vite URL is an internal renderer development server; use the Electron window as the application UI.

### Verify and build

```powershell
pnpm typecheck
pnpm test
pnpm build
```

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start Electron and the Vite renderer in development |
| `pnpm typecheck` | Run strict TypeScript validation |
| `pnpm test` | Run the Vitest suite |
| `pnpm build` | Produce main, preload, and renderer bundles |
| `pnpm preview` | Preview the built Electron/Vite output |

## Background mode and controls

The first-run page stays visible until **Run in background** is selected. Background mode:

- moves Tawny to the Windows tray,
- registers `Ctrl + Alt + Space`,
- shows the compact overlay at the top of the active monitor,
- keeps the overlay above normal windows while a job is active.

| Control | Action |
| --- | --- |
| `Ctrl + Alt + Space` | Start recording, stop recording, or confirm/cancel based on state |
| `Esc` | Cancel the active job |
| Overlay check button | Finish microphone capture |
| Tray menu | Show/hide overlay, open settings, open diagnostics, quit |
| Right-click overlay/window | Open diagnostics, settings, or cancel/finish the current job |

The previously focused application remains the intended paste target. Applications running elevated or blocking simulated input may prevent automatic paste; the generated image remains in the clipboard and is also saved locally.

## Diagnostics and logs

Open **Live log** from the main page, **Diagnostics** from the tray, or the context menu. Logs are available in two forms:

- structured entries in the diagnostics panel,
- newline-delimited JSON at:

```text
%APPDATA%\Tawny\logs\pipeline.jsonl
```

The exact directory is Electron’s `app.getPath("userData")` directory for the current Windows user.

### Healthy dictation run

```text
hotkey.start
state.transition: arming
capture.permission.request
capture.ready
state.transition: recording
capture.stop
state.transition: finalizing
capture.finalized
provider.start (groq-whisper)
provider.success (groq-whisper)
state.transition: transcribing
gate.result
gate.dictation
state.transition: gating
inject.success
state.transition: done
```

### Healthy image run

```text
hotkey.start
capture.finalized
provider.start (groq-whisper)
provider.success (groq-whisper)
gate.result
decision.result: image_generate
image.saved
image.inject.success
state.transition: done
```

### Troubleshooting by last log

| Last useful event | Likely problem |
| --- | --- |
| No `capture.permission.request` | The job did not enter microphone setup |
| `capture.failure` | Windows/Electron microphone permission or recorder failure |
| `capture.finalized` with `bytes: 0` | No audio was produced |
| `provider.failure` for Groq | Missing key, network issue, unsupported response, or Groq error |
| `gate.result` but no decision event | Routing/intent stage failed |
| `decision.result: image_generate` but no `image.saved` | Cloudflare credentials, request, timeout, or response validation failure |
| `image.saved` but no `image.inject.success` | Windows clipboard conversion or simulated paste failed |
| `image.inject.success` but target app is unchanged | Target app rejected simulated `Ctrl+V`, is elevated, or does not accept image clipboard data |

## Security model

- Electron `contextIsolation` is enabled.
- Node integration is disabled in the renderer.
- A single-instance lock prevents multiple Tawny processes competing for the shortcut.
- Credentials are encrypted with Electron `safeStorage`.
- Provider calls run in the main process, not in the renderer.
- Zod validates shared settings, provider responses, snapshots, and log contracts.
- Logs do not persist API keys or transcript contents.
- `.env` files, build output, dependency folders, and local logs are ignored by Git.

## Tests

The current suite contains 44 passing tests covering:

- wake phrase normalization and matching,
- plain dictation routing,
- image-intent detection,
- negation handling,
- selected-text rewrite/query dictionary patterns,
- direct and wrapped CLEF decisions,
- Cloudflare Flux response validation and error behavior,
- Cloudflare CLEF response, rewrite, and low-tier generation behavior.

Run the suite with:

```powershell
pnpm test
```

## Known Windows limitations

- Simulated `Ctrl+V` can fail for elevated applications, protected fields, or applications that block synthetic input.
- Tawny currently does not capture and restore the user’s previous clipboard contents.
- The active target window is inferred from focus behavior; full native HWND capture and elevation reporting remain future hardening work.
- The renderer receives an image data URL for the short-lived preview. A secure local-file preview protocol would be preferable for very large images.
- Image intent detection is deliberately local and heuristic. It handles common image verbs, image nouns, and negations, but is not a general natural-language planner.
- Packaging and clean-machine installer verification are not included in the current development workflow.

## Repository principles

1. Never lose the user’s input.
2. Never silently swallow a provider or injection failure.
3. Keep uncertainty on the safe side of plain dictation.
4. Make every pipeline boundary observable.
5. Keep credentials out of source control, renderer storage, and logs.
6. Prefer explicit state transitions over indefinite loading.

## Brand asset

The reusable Tawny mark is [`public/tawny-mark.svg`](./public/tawny-mark.svg). It is used by the renderer, application identity, and tray icon.
