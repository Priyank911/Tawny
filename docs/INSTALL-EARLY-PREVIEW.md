# Install Tawny (early preview)

Tawny releases are early-preview software and are currently unsigned. Download only from the official [Tawny GitHub Releases](https://github.com/Priyank911/Tawny/releases) page. Each release includes `SHA256SUMS`; verify your installer before opening it. A matching checksum confirms the downloaded bytes match the file listed in that release, but it does not independently prove the publisher’s identity.

Choose one installer for your operating system. Do not run a file if its source or checksum does not match the official release.

## Windows

Download `Tawny-VERSION-windows-x64.exe` and run it, replacing `VERSION` with the release number (for example, `0.1.7`). Windows may show **Unknown publisher** or a SmartScreen warning because the installer is not Authenticode-signed and has limited download reputation. Check its SHA-256 against the matching `SHA256SUMS` entry first. If the source or digest does not match, cancel the installer; do not disable Defender or SmartScreen to proceed.

## macOS

Download the `.dmg` matching your Mac (`mac-x64` for Intel or `mac-arm64` for Apple silicon), open it, and move Tawny to Applications. macOS may say the developer cannot be verified because the preview is not signed or notarized. Verify the checksum before opening; if you choose to open the app despite Gatekeeper’s warning, use Control-click → **Open** only for that verified official download. Approve microphone access when prompted. For automatic paste, allow Tawny to control System Events in **System Settings → Privacy & Security → Accessibility**, and approve the Automation prompt if macOS shows one. Unsigned macOS builds use manual updates: Tawny opens Releases when a new version is available, and you install the new `.dmg` yourself.

## Linux

Choose the `.AppImage` for a portable install, or the `.deb` for Debian/Ubuntu. Replace `VERSION` in the examples with the release number (for example, `0.1.7`). To run the AppImage:

```sh
chmod +x ./Tawny-VERSION-linux-x86_64.AppImage
./Tawny-VERSION-linux-x86_64.AppImage
```

To install the `.deb` on Debian/Ubuntu:

```sh
sudo apt install ./Tawny-VERSION-linux-amd64.deb
```

Tawny needs a desktop Secret Service for encrypted sign-in and provider credentials; it will not store these tokens using Linux’s plaintext fallback. On non-KDE sessions—including Hyprland—Tawny uses libsecret, so a Secret Service provider such as GNOME Keyring must be installed, running, and unlocked. On Ubuntu/Debian, install it if missing:

```sh
sudo apt install gnome-keyring libsecret-1-0
```

Then sign out of the desktop session and sign back in so the keyring service is started and unlocked. On KDE Plasma, enable and unlock KWallet instead. If Tawny still reports that secure storage is unavailable, check that the keyring is running and unlocked before retrying sign-in.

The default shortcut is `Ctrl+Alt+Space`; change it in **Settings → Recording shortcut** and use **Test key** to check delivery. On Windows, macOS, and X11, Electron reports whether it registered the shortcut. On Wayland, Electron uses the desktop portal; accept its first shortcut prompt if one appears. Hyprland users need a working `xdg-desktop-portal` and `xdg-desktop-portal-hyprland`. If Settings reports **Compositor setup**, copy the command it shows and bind it to your chosen shortcut in the compositor’s keyboard settings. It sends `--trigger` to the running Tawny instance. See the [user guide](./USER-GUIDE.md#verify-a-shortcut) for details.

For automatic text/image paste, Tawny uses `wtype` on Wayland and `xdotool` on X11. Wayland compositors can block virtual-keyboard input; if `wtype` is missing or blocked, Tawny keeps the result on the clipboard and shows a notification so you can paste manually. The compositor also controls window stacking and screen placement. If the overlay appears behind other windows or not at top center, add a compositor window rule; the app cannot override that policy. On Windows, macOS, and X11, Tawny positions its overlay at the top center.

Your distribution may warn because preview packages are unsigned. Verify `SHA256SUMS` first. Windows and AppImage installations can download updates in the background; installation occurs when Tawny closes. Linux `.deb` updates are installed through the package manager, so Tawny points you to the new release rather than replacing system-managed files. macOS updates are manual for unsigned builds. Tawny avoids repeated notifications for each download-progress update.

## Verify SHA-256

On Windows PowerShell:

```powershell
Get-FileHash .\Tawny-VERSION-windows-x64.exe -Algorithm SHA256
```

On macOS/Linux:

```sh
shasum -a 256 Tawny-VERSION-installer.dmg
```

Replace the example filename with the exact installer you downloaded. On Linux, use `sha256sum Tawny-VERSION-installer.AppImage` (or the `.deb` filename). Compare the reported digest with the row for that filename in `SHA256SUMS`. These commands compute a digest for one downloaded file; they do not require downloading every release asset.
