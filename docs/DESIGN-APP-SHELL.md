# App shell and recording recovery: design overview

Status: implemented in 0.1.14. The overlay pill and orb, the pipeline and the
helpers are unchanged. This covers the app window, the recording recovery
store, and the hands-free watchdog.

## 1. Direction

**Field notebook for your voice.** Cream paper, black ink, one orange marker.
There are no gradients, glass or glowing blobs. Hierarchy comes from type and
hairline rules:

| Role | Choice |
|---|---|
| Display (page titles, big numbers) | Serif: `Iowan Old Style`, `Palatino Linotype`, Georgia. All system fonts, so nothing is downloaded. |
| Body | `Segoe UI Variable Text` |
| Labels, timestamps, data | Mono small caps (`Cascadia Mono`, Consolas), 10.5px, tracked +0.08em |
| Colour | `--bg #f6efe3` paper, `--surface #fdf9f2` cards, `--ink #15120f` text, `--accent #ea6a1f` for one thing per view: the primary action or the live state |
| Rules | 1px `--line` hairlines, with dashed rules between list rows like a ledger |
| Signature | A small "tape counter" mark (mono digits in a black capsule) for counts and durations, and a 5-bar orange level glyph for live listening |

The layout is compact: the window stays 980×680, with a 196px rail and a
content column. Rows are 40–44px and corners are 10px (6px on chips).

## 2. Structure

```
┌──────────────┬──────────────────────────────────────────────────────┐
│ [T] Tawny    │  Home                              ─  ×  (drag bar)  │
│              │──────────────────────────────────────────────────────│
│ ● Home       │                                                      │
│ ○ Recordings │                 page content                         │
│   [2]        │                                                      │
│ ○ Activity   │                                                      │
│ ○ Settings   │                                                      │
│              │                                                      │
│──────────────│                                                      │
│ ▮▮▮ Listening│                                                      │
│ (P) priyank… │                                                      │
│ v0.1.14      │                                                      │
└──────────────┴──────────────────────────────────────────────────────┘
```

- **Rail**: the mark and wordmark, then four destinations. Recordings shows
  a counter badge when recordings are waiting. At the bottom: the hands-free
  live chip (click it to toggle), the account (click for the sign-out
  menu), and the version.
- **Title bar**: the page title on the left. Minimize and close (which
  hides to the tray) sit on the right, and the whole bar drags the window.
- Signed out, the rail is hidden and the sign-in card is centred on paper.
- An update notice appears as a slim strip at the top of the content
  column, with a "Restart now" button.

### Home
```
 Good evening.                                   [ Run in background ]
 ─────────────────────────────────────────────────────────────────────
 ┌ STATUS ───────────────────────┐ ┌ TODAY ─────────────────────────┐
 │ ▮▮▮▮▮  Listening for          │ │  [07] done   [01] failed       │
 │        “Hey Tawny”            │ │  [02] waiting in Recordings →  │
 │ Shortcut  Ctrl + Alt + Space  │ │                                │
 │ [x] Hands-free  [x] Show cursor│ └───────────────────────────────┘
 └───────────────────────────────┘
 WHAT TO SAY ──────────────────────────────────────────────────────────
 01 Dictate    02 Rewrite        03 Create           04 Control
 just talk     "make this        "write a poem…"     "open WhatsApp"
               formal"           "image of…"
 RECENT ───────────────────────────────────────────────────────────────
 10:42  Control   Opened WhatsApp.                              done
 10:40  Dictate   Dictation complete.                           done
 10:31  Create    Groq could not be reached. Saved.           failed
```

### Recordings (recovery)
```
 Recordings                                  [ Transcribe all (2) ]
 Kept when a request fails. They are encrypted on this PC and can't be
 played back. They delete themselves after 7 days.
 GROQ BUDGET  req/min 3/20 · audio this hour 0:42/2:00:00 · today 0:42/8:00:00
 ─────────────────────────────────────────────────────────────────────
 10:31 · Hands-free · 0:06 · 192 KB
 Network: could not reach Groq.                 [Transcribe again] [🗑]
 ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
 09:58 · Shortcut · 0:41 · 310 KB                         TRANSCRIBED
 “Write a short note to the team about Friday's demo…”    [Copy] [🗑]
```

### Activity
This replaces the "Live log" modal and fills the page. It has filter chips
(All · Warnings · Errors) and an "Open logs folder" button. Rows are mono
time, event and message.

### Settings
This replaces the modal, and it is one scrolling page with anchored sections:
Shortcut · Hands-free & control · Providers · Updates. It reuses the existing
controls and their behaviour.

## 3. Recording recovery

**When a recording is kept.** It is kept when a job fails after the audio
was captured. That covers Groq being unreachable, timing out, rate limited
or erroring, a missing or invalid key, and failures after transcription
such as a Cloudflare outage. If a transcript was already received, it is
stored with the recording. It is not kept when you cancel, when no audio
was captured, or when you aren't signed in.

**Storage** lives in `%APPDATA%/Tawny/recovery/`.
- `key.bin`: a random 256-bit key, wrapped with Electron `safeStorage`
  (Windows DPAPI). Without the key the files can't be read, and Tawny has no
  playback UI.
- `<id>.bin`: AES-256-GCM over `[header length][header JSON][audio
  segments]`.
- `index.bin`: AES-256-GCM over the JSON list of recordings. It holds the
  metadata, error reason and any transcript.
- Limits: 7 days, 30 recordings, 200 MB in total, with the oldest pruned
  first. When a transcription succeeds, the audio is deleted and only the
  text is kept.
- If secure storage isn't available, nothing is kept and the job fails as
  before, with that reason logged.

**Transcribe again** respects Groq's speech-to-text limits:
- Free tier for `whisper-large-v3-turbo`: 20 requests a minute, 2,000 a
  day, 7,200 audio-seconds an hour and 28,800 a day.
- Each request is billed as at least 10 s.
- An upload can be at most 25 MB.

How Tawny stays within them:
- Retries run one at a time in a queue.
- A local budget counts every Groq call Tawny makes, live requests
  included, in rolling windows. Each one is billed as max(10 s, duration).
- When the next request would go over a limit, Tawny waits if the wait is
  under 65 s. Otherwise the recording is marked "Waiting for Groq limit,
  try after HH:MM".
- A 429 with `retry-after` sets that time.
- A WAV clip over 24 MB is split into PCM chunks with fresh headers. WebM
  recordings are already 60 s segments.

The pill's failure message adds: "Saved in Recordings — transcribe it again
there."

## 4. Hands-free watchdog

The symptom was that after 20–30 minutes "Hey Tawny" stops answering.
There are two causes:
1. The Windows recognizer's input stream can end without an error, for
   example when the device sleeps, is switched, or the session resumes. The
   helper treated "completed without error" as impossible for live input,
   so it sat idle forever.
2. Long `System.Speech` dictation sessions degrade.

The fixes:
- The helper now exits whenever live recognition completes, so the
  service restarts it.
- The helper emits a `level` heartbeat every 5 s from `AudioLevelUpdated`.
  If no line arrives for 30 s while listening, the service recycles it.
- The service recycles the recognizer every 20 minutes. It waits for 8 s
  of quiet first, so it never cuts off someone mid-sentence.
- A recycle does not count toward the crash-restart limit.
