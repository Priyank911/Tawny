# Tawny user guide

Tawny is an early-preview desktop voice assistant. This guide covers first launch, everyday use, platform-specific shortcut behavior, privacy, local data, and troubleshooting.

- [Install Tawny](./INSTALL-EARLY-PREVIEW.md)
- [Download releases](https://github.com/Priyank911/Tawny/releases)
- [Report a problem](https://github.com/Priyank911/Tawny/issues)

## First launch

1. Install Tawny using the Windows instructions. Preview builds are unsigned; verify the installer checksum before opening it.
2. Launch Tawny and choose **Continue with Google**. Authentication opens in your system browser and returns to Tawny when complete.
3. Choose **Configure providers** and enter your own Groq API key, Cloudflare account ID, and Cloudflare API token. Save the credentials.
4. Allow microphone access.
5. Choose **Run in background** to use the global shortcut and tray controls.

The release build already contains Tawny’s Firebase project configuration; users do not need to create an OAuth client. API keys for Groq and Cloudflare are user-provided and are stored encrypted on the device. Create a Groq key in the [Groq console](https://console.groq.com/keys); follow Cloudflare’s [Workers AI REST API setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) to create a token and find your account ID.

## The app window

The window has four pages in the left rail:

- **Home**: listening status, shortcut, quick switches, today's tally, what you can say, and recent requests.
- **Recordings**: requests that failed (no network, Groq busy or rate limited, a model outage). Each one can be transcribed again; once the text is ready you can copy it.
- **Activity**: every pipeline step, newest first, with Warnings and Errors filters and a button to open the logs folder.
- **Settings**: shortcut, hands-free and voice control, provider keys, version.

Closing the window keeps Tawny running in the tray.

## Daily use

The default shortcut is **Ctrl + Alt + Space**. It can be changed in **Settings → Recording shortcut**.

| Goal | Steps |
| --- | --- |
| Dictate text | Focus a text field, press the shortcut, speak, then press the shortcut again to stop. Tawny transcribes and pastes the speech as-is. |
| Rewrite selected text | Select text first, press the shortcut, and say what to change—for example, “make this professional and fix the grammar.” Tawny replaces the selection with the rewritten text. |
| Rewrite faster | With text selected, begin the instruction with “quick” or “fast,” such as “quick, make this concise.” |
| Ask for an answer or code | Press the shortcut and make an explicit request, such as “write a Python function that sorts a list.” Tawny pastes the generated response at the cursor. |
| Generate an image | Press the shortcut and describe the image you want. Tawny creates the image, saves a local JPEG, and copies the image to the clipboard. |
| Cancel a job | Press **Esc** while Tawny is working. |
| Recover a failed request | If the network drops or Groq is busy, the pill says the recording was saved. Open **Recordings** and choose **Transcribe again** (or **Transcribe all**), then **Copy** the text. |

The microphone stays active until you stop it. A held shortcut also stops capture on key release; or press the shortcut again to stop. Tawny breaks long recordings into one-minute audio segments for transcription.

### Verify a shortcut

Open **Settings → Recording shortcut**, save the desired combination, then press **Test key** and press the displayed combination. A success message confirms Tawny received it; a timeout means the operating system or compositor did not deliver the trigger.

Tawny asks Electron to register the shortcut and reports whether Windows accepted it. If another app owns the combination, choose a different one.

## Hands-free mode and voice control

Turn on **Settings → Hands-free and voice control → Listen for “Hey Tawny”**. While it is on, the microphone stays open on this PC; a small status line in Settings shows whether the listener is running.

1. Say **“Hey Tawny”**. A small orb appears.
2. Say your request, in the same breath or after a short pause. Everything the shortcut does works here: dictation, rewriting a selection, answers, code, images, and computer control.
3. Stop talking, or say **“Tawny send it”**, to finish. Press **Esc** to cancel.

**With the shortcut instead.** Press the shortcut and say “open …”: “open VS Code”, “open this PC”, “open the recycle bin”, “open D drive”. Tawny opens it only if that app, drive, folder or file exists on your PC; otherwise your words are typed as dictation, so “open the door” stays text. Clicking, typing and other actions need “Hey Tawny” first, for example “Hey Tawny, click the Save button”.

Examples: “Hey Tawny, open the Projects folder on D drive.” “Hey Tawny, switch to Chrome.” “Hey Tawny, click the Save button.” “Hey Tawny, scroll down.” “Hey Tawny, write a Python function that reverses a string.”

**Privacy.** The wake phrase is recognised by Windows on this PC. Nothing is uploaded until it is heard; then your request is sent to Groq for transcription. Turning the switch off releases the microphone. Hands-free pauses while the screen is locked.

**Voice control safety.** Tawny moves the real cursor (turn this off in Settings for instant, direct opening), stops when you move the mouse or press Esc, and asks for confirmation before closing windows, clicking buttons such as Delete, Send or Pay, or opening links it worked out itself. Confirm with **Enter** or the shortcut, refuse with **Esc**. It never starts a command shell or types into a terminal or an administrator window, and it refuses when several items match a name.

**Screenshots.** Off by default. If you enable **Use screenshots when an app cannot be read**, Tawny sends a screenshot to Cloudflare only when it cannot find a control through Windows accessibility.

## Pasting behavior

Tawny writes the result to the system clipboard and then asks the operating system to paste it into the previously focused application. Applications running as administrator, secure fields, remote desktops, and apps that reject simulated input can also prevent automatic pasting. The generated image remains on the clipboard even if the destination app does not accept it.

## Privacy and local data

Tawny requires cloud services for transcription and model-backed tasks:

- Microphone audio is uploaded to Groq for speech transcription. Normal dictated text is not sent to a text-generation model after transcription.
- When you explicitly request a rewrite, answer, code, or image, the instruction is sent to Cloudflare Workers AI. For a rewrite, selected text is sent with the instruction; for a response, selected text may be included as context.
- Google handles account authentication. Tawny stores an encrypted Firebase session locally so you do not have to sign in every launch.
- API credentials and the session are encrypted through Electron’s operating-system secure storage. On Linux, Tawny requires Secret Service (for example GNOME Keyring) or KWallet; it refuses to fall back to plaintext storage.
- Diagnostic logs are local. They record pipeline stages and lengths, not audio, transcripts, selected text, or API keys. Tawny does not send analytics or crash logs to a remote service.
- Failed requests are kept in `recovery/` inside `userData` so they can be transcribed again. The audio, the error and any transcript are AES-256-GCM encrypted with a key protected by Windows (DPAPI). Tawny cannot play them back. Audio is deleted as soon as its text is ready, and everything is removed after 7 days (at most 30 recordings or 200 MB). Use **Recordings → Clear all** to remove them sooner.
- Generated images are saved as `tawny-image-<timestamp>.jpg` inside Tawny’s Electron `userData` directory and are not automatically deleted. The operating system clipboard may also retain the last result.

### Remove Tawny’s local data

Quit Tawny completely, including its tray process. Find the application’s `userData` directory for the current OS account (the directory name is normally **Tawny** for an installed build and can be **voicerouter** in a development build):

- Windows: under `%APPDATA%`

Delete the Tawny/voicerouter application-data folder to clear its local images, logs, shortcut preference, encrypted provider credentials, and saved sign-in session. You will need to sign in and enter provider credentials again. It also holds your hands-free and voice-control choices (`behavior.json`). To remove only generated images, delete the `tawny-image-*.jpg` files and keep the rest of the folder. Clearing Tawny’s files does not clear the operating-system clipboard.

## Troubleshooting

### Hands-free reacted when nobody said “Hey Tawny”

The Windows recognizer sometimes mistakes similar words or background talk (a video, people nearby) for the wake phrase. The orb may appear briefly. Tawny still does nothing unless Whisper hears “Hey Tawny” or the words are a clear command such as “open WhatsApp”. Overheard speech is never typed. Activity shows these as `wake.unconfirmed`.

### Hands-free does not react

1. Open Settings and read the status line under **Hands-free and voice control**.
2. “No speech recognizer”: add an English speech language in Windows **Settings → Time and language → Speech**.
3. “No microphone”: allow desktop apps to use the microphone in Windows privacy settings and check the default input device.
4. Say the phrase clearly, then your request. If it keeps missing, use the shortcut; both paths do the same things. Check **Activity** for `wake.start`, `gate.result` and `job.discarded`.
5. “I only heard …”: Whisper's transcript had no request in it (for example only “Thank you.”). Say the request a little louder or closer to the microphone. Tawny never changes your Windows microphone volume; if requests are often missed, raise it to 80-100% in Windows **Settings → System → Sound → Input**.

### Voice control did nothing or stopped

Check **Activity** for `control.*` events. Apps are found by their Start menu name, including Microsoft Store apps such as WhatsApp and Spotify. Tawny stops when you move the mouse, when a name matches several items, when the front window is an administrator or terminal window, or when `tawny-control.exe` is missing (reinstall Tawny).

### The shortcut does nothing

1. Open Settings and check that the status is **Registered**. Use **Test key**.
2. Try another key combination if another app or the OS already owns it.
3. Check **Activity** for `hotkey.register.failure`, `hotkey.test.failed`, or `hotkey.ignored.settings`.

### Sign-in succeeds in the browser but not in Tawny

Close the authorization tab only after it says sign-in is complete, then return to Tawny. If the app reports an OAuth configuration error, reinstall an official release and contact the maintainer with the sanitized error text. Do not share OAuth secrets, API tokens, or Firebase service-account files.

### The window or paste target is wrong

Verify the intended destination app was focused before starting Tawny. Automatic paste may be blocked by elevation or application security settings; the result stays on the clipboard so you can paste it yourself.

### Find and share useful logs

Open **Activity** in Tawny or read `logs/pipeline.jsonl` inside the application’s `userData` directory. Share only relevant event names and error messages. Remove personal information and never send audio, transcript text, selected text, API keys, or session files.

## Updating Tawny

Tawny checks the GitHub early-preview releases and downloads an update in the background. About a minute after the download finishes, Tawny restarts itself to install it as soon as it is not busy; choose **Restart now** in the update notice to do it at once. Closing the window only hides Tawny to the tray, so you do not need to close it for an update. Read the [install notes](./INSTALL-EARLY-PREVIEW.md) for details.

## Feedback

Tawny is preview software; behavior can vary with Windows version, permissions and input method. When reporting a bug, include the Windows version, Tawny version, exact steps, and sanitized log event names. Do not attach voice recordings or secret values.
