# Tawny early preview — installation notes

These builds are unsigned preview software. Download only from the official [Tawny GitHub Releases](https://github.com/Priyank911/Tawny/releases) page. Verify the download against `SHA256SUMS` before installing. A matching checksum confirms that your file matches the published release asset; it does not prove who published it.

## Windows

Run the `.exe` installer. Windows may show **Unknown publisher** or a SmartScreen warning because this preview is not Authenticode-signed and has limited download reputation. Continue only if the file came from the official release page and its SHA-256 checksum matches. If the installer is not trusted, cancel it.

## macOS

Open the `.dmg`, move Tawny to Applications, then Control-click Tawny and choose **Open** if Gatekeeper blocks the first launch. macOS may say the developer cannot be verified because this preview is not signed or notarized. Only use this exception for a checksum-verified download from the official release page. Approve microphone access when prompted. For automatic paste, allow Tawny to control System Events under **System Settings → Privacy & Security → Accessibility** (and approve the Automation prompt if shown). Unsigned macOS builds cannot use Tawny's automatic installer; Tawny will notify you and open Releases so you can download the new `.dmg` manually.

## Linux

Use the `.AppImage` (mark it executable, then run it) or install the `.deb` on Debian/Ubuntu. Tawny needs a desktop Secret Service for encrypted sign-in and provider credentials; it will not save these tokens using Linux's plaintext fallback. On non-KDE sessions—including Hyprland—Tawny uses libsecret, so a Secret Service provider such as GNOME Keyring must be installed, running, and unlocked. On Ubuntu/Debian, install it if missing:

```sh
sudo apt install gnome-keyring libsecret-1-0
```

Then sign out of the desktop session and sign back in so the keyring service is started and unlocked. On KDE Plasma, enable and unlock KWallet instead. If Tawny still reports that secure storage is unavailable, check that the keyring is running and unlocked before retrying sign-in.

Tawny starts with `Ctrl+Alt+Space`; change it in **Settings → Recording shortcut**. On Windows, macOS, and X11, Tawny asks Electron to register the chosen global shortcut and reports whether Electron confirmed it. Wayland uses the desktop portal; approve its first shortcut prompt if shown. Hyprland users need `xdg-desktop-portal` and `xdg-desktop-portal-hyprland` running. If Tawny reports **Compositor setup**, copy the command shown in Settings and bind it to your chosen keys in the compositor's own shortcut settings. The command sends `--trigger` to the running Tawny instance. This avoids silently claiming a shortcut is active when the portal did not confirm it.

For automatic text/image paste, Tawny uses `wtype` on Wayland and `xdotool` on X11. Wayland compositors may disable virtual-keyboard input; if `wtype` is missing or blocked, Tawny keeps the result on the clipboard and shows a notification so you can paste with `Ctrl+V`. Wayland also gives the compositor control over window stacking and exact screen placement. If the overlay does not appear above other windows or at the requested top-center position, add a window rule in the compositor; Tawny cannot override that policy itself. On Windows, macOS, and X11, Tawny raises the overlay and positions it at the top center while keeping the target app focused for pasting.

Your distribution may warn because preview packages are unsigned. Verify `SHA256SUMS` first. AppImage installations can receive in-app updates; `.deb` updates are installed through the package manager, so Tawny points you to the new release instead of replacing system-managed files. Tawny shows update notifications when a version becomes available and once when its download finishes—not for every progress update.

## Verify SHA-256

On Windows PowerShell:

```powershell
Get-FileHash .\Tawny-<version>-windows-x64.exe -Algorithm SHA256
```

On macOS/Linux:

```sh
shasum -a 256 -c SHA256SUMS
```

Compare the reported digest with the matching file entry in `SHA256SUMS`.
