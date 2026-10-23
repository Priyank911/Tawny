# Tawny early preview — installation notes

These builds are unsigned preview software. Download only from the official [Tawny GitHub Releases](https://github.com/Priyank911/Tawny/releases) page. Verify the download against `SHA256SUMS` before installing. A matching checksum confirms that your file matches the published release asset; it does not prove who published it.

## Windows

Run the `.exe` installer. Windows may show **Unknown publisher** or a SmartScreen warning because this preview is not Authenticode-signed and has limited download reputation. Continue only if the file came from the official release page and its SHA-256 checksum matches. If the installer is not trusted, cancel it.

## macOS

Open the `.dmg`, move Tawny to Applications, then Control-click Tawny and choose **Open** if Gatekeeper blocks the first launch. macOS may say the developer cannot be verified because this preview is not signed or notarized. Only use this exception for a checksum-verified download from the official release page. Approve microphone access when prompted. For automatic paste, allow Tawny to control System Events under **System Settings → Privacy & Security → Accessibility** (and approve the Automation prompt if shown). Unsigned macOS builds cannot use Tawny's automatic installer; Tawny will notify you and open Releases so you can download the new `.dmg` manually.

## Linux

Use the `.AppImage` (mark it executable, then run it) or install the `.deb` on Debian/Ubuntu. On GNOME Wayland, approve Tawny's global-shortcut portal prompt on first launch. For secure sign-in storage, have GNOME Keyring or KDE Wallet installed and unlocked. Automatic selected-text capture and paste require `xdotool` on X11; Wayland intentionally restricts synthetic keystrokes, so the result stays on the clipboard for manual paste when the compositor does not allow injection. Your distribution may warn because preview packages are unsigned. Verify `SHA256SUMS` first. AppImage installations can receive in-app updates; `.deb` updates are installed through the package manager, so Tawny points you to the new release instead of replacing system-managed files.

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
