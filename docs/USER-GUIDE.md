# Tawny user guide

Tawny is an early-preview desktop voice assistant. This guide covers first launch, everyday use, platform-specific shortcut behavior, privacy, local data, and troubleshooting.

- [Install Tawny](./INSTALL-EARLY-PREVIEW.md)
- [Download releases](https://github.com/Priyank911/Tawny/releases)
- [Report a problem](https://github.com/Priyank911/Tawny/issues)

## First launch

1. Install Tawny using the instructions for your operating system. Preview builds are unsigned; verify the installer checksum before opening it.
2. Launch Tawny and choose **Continue with Google**. Authentication opens in your system browser and returns to Tawny when complete.
3. Choose **Configure providers** and enter your own Groq API key, Cloudflare account ID, and Cloudflare API token. Save the credentials.
4. Allow microphone access. On Linux, make sure the desktop keyring is installed, running, and unlocked so Tawny can encrypt credentials and the sign-in session.
5. Choose **Run in background** to use the global shortcut and tray controls.

The release build already contains Tawny’s Firebase project configuration; users do not need to create an OAuth client. API keys for Groq and Cloudflare are user-provided and are stored encrypted on the device. Create a Groq key in the [Groq console](https://console.groq.com/keys); follow Cloudflare’s [Workers AI REST API setup](https://developers.cloudflare.com/workers-ai/get-started/rest-api/) to create a token and find your account ID.

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

The microphone stays active until you stop it. On Windows, a held shortcut can also stop capture on key release. On macOS and Linux, press the shortcut again to stop. Tawny breaks long recordings into one-minute audio segments for transcription.

### Verify a shortcut

Open **Settings → Recording shortcut**, save the desired combination, then press **Test key** and press the displayed combination. A success message confirms Tawny received it; a timeout means the operating system or compositor did not deliver the trigger.

On X11, Windows, and macOS, Tawny asks Electron to register the shortcut. Linux Wayland uses the desktop’s Global Shortcuts portal when available. If Settings says **Compositor setup**, copy the provided `--trigger` command and bind it to the shortcut in your compositor’s settings. On Hyprland or another non-GNOME/KDE compositor, make sure the matching `xdg-desktop-portal` backend is installed and running. Wayland controls window stacking and position; compositor window rules may be needed to keep the overlay above other windows.

## Pasting behavior

Tawny writes the result to the system clipboard and then asks the operating system to paste it into the previously focused application. If Wayland blocks synthetic keyboard input, Tawny leaves the result on the clipboard and shows a notification so you can paste manually. Applications running as administrator/root, secure fields, remote desktops, and apps that reject simulated input can also prevent automatic pasting. The generated image remains on the clipboard even if the destination app does not accept it.

## Privacy and local data

Tawny requires cloud services for transcription and model-backed tasks:

- Microphone audio is uploaded to Groq for speech transcription. Normal dictated text is not sent to a text-generation model after transcription.
- When you explicitly request a rewrite, answer, code, or image, the instruction is sent to Cloudflare Workers AI. For a rewrite, selected text is sent with the instruction; for a response, selected text may be included as context.
- Google handles account authentication. Tawny stores an encrypted Firebase session locally so you do not have to sign in every launch.
- API credentials and the session are encrypted through Electron’s operating-system secure storage. On Linux, Tawny requires Secret Service (for example GNOME Keyring) or KWallet; it refuses to fall back to plaintext storage.
- Diagnostic logs are local. They record pipeline stages and lengths, not audio, transcripts, selected text, or API keys. Tawny does not send analytics or crash logs to a remote service.
- Generated images are saved as `tawny-image-<timestamp>.jpg` inside Tawny’s Electron `userData` directory and are not automatically deleted. The operating system clipboard may also retain the last result.

### Remove Tawny’s local data

Quit Tawny completely, including its tray process. Find the application’s `userData` directory for the current OS account (the directory name is normally **Tawny** for an installed build and can be **voicerouter** in a development build):

- Windows: under `%APPDATA%`
- macOS: under `~/Library/Application Support/`
- Linux: under `${XDG_CONFIG_HOME:-~/.config}/`

Delete the Tawny/voicerouter application-data folder to clear its local images, logs, shortcut preference, encrypted provider credentials, and saved sign-in session. You will need to sign in and enter provider credentials again. To remove only generated images, delete the `tawny-image-*.jpg` files and keep the rest of the folder. Clearing Tawny’s files does not clear the operating-system clipboard.

## Troubleshooting

### The shortcut does nothing

1. Open Settings and check that the status is **Registered**. Use **Test key**.
2. Try another key combination if another app or the OS already owns it.
3. On Wayland, follow the **Compositor setup** command shown in Settings and verify the compositor’s binding. X11 uses `xdotool`; Wayland uses the portal/your compositor.
4. Check **Live log** for `hotkey.register.failure`, `hotkey.test.failed`, or `hotkey.ignored.settings`.

### Tawny cannot sign in on Linux

Install and unlock a Secret Service keyring (GNOME Keyring on many GNOME/Hyprland setups) or unlock KWallet on KDE Plasma. For Debian/Ubuntu:

```sh
sudo apt install gnome-keyring libsecret-1-0
```

Then sign out of the desktop session and sign back in so the keyring service starts.

### Sign-in succeeds in the browser but not in Tawny

Close the authorization tab only after it says sign-in is complete, then return to Tawny. If the app reports an OAuth configuration error, reinstall an official release and contact the maintainer with the sanitized error text. Do not share OAuth secrets, API tokens, or Firebase service-account files.

### The window or paste target is wrong

On Wayland, the compositor controls focus, stacking, and placement. Add a compositor window rule if needed. On other systems, verify the intended destination app was focused before starting Tawny. Automatic paste may be blocked by elevation or application security settings; use the clipboard fallback instead.

### Find and share useful logs

Open **Live log** in Tawny or read `logs/pipeline.jsonl` inside the application’s `userData` directory. Share only relevant event names and error messages. Remove personal information and never send audio, transcript text, selected text, API keys, or session files.

## Updating Tawny

Tawny checks the GitHub early-preview releases. Windows and Linux AppImage can download an update in the background; Tawny installs it when it closes. Unsigned macOS builds and Linux `.deb` installs require a manual download from [Releases](https://github.com/Priyank911/Tawny/releases). For `.deb`, update through your package manager. Read the [install notes](./INSTALL-EARLY-PREVIEW.md) for the current platform-specific behavior.

## Feedback

Tawny is preview software; behavior can vary with operating-system version, permissions, input method, and compositor. When reporting a bug, include OS/version, display server (X11/Wayland), Tawny version, exact steps, and sanitized log event names. Do not attach voice recordings or secret values.
