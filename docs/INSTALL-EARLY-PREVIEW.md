# Install Tawny (early preview)

Tawny releases are early-preview software and are currently unsigned. Download only from the official [Tawny GitHub Releases](https://github.com/Priyank911/Tawny/releases) page. Each release includes `SHA256SUMS`; verify your installer before opening it. A matching checksum confirms the downloaded bytes match the file listed in that release, but it does not independently prove the publisher’s identity.

Do not run a file if its source or checksum does not match the official release.

## Windows

Download `Tawny-VERSION-windows-x64.exe` and run it, replacing `VERSION` with the release number (for example, `0.1.16`). Windows may show **Unknown publisher** or a SmartScreen warning because the installer is not Authenticode-signed and has limited download reputation. Check its SHA-256 against the matching `SHA256SUMS` entry first. If the source or digest does not match, cancel the installer; do not disable Defender or SmartScreen to proceed.

## Hands-free mode

Hands-free is off until you turn it on in **Settings → Hands-free and voice control**. It needs a microphone, an English Windows speech language (**Settings → Time and language → Speech**) and, for voice control, no extra setup. The microphone stays open while it is on; turn it off to release the microphone completely. Tawny pauses it automatically while the screen is locked or the PC sleeps.

macOS and Linux builds are paused until the Windows experience is finished.

## Verify SHA-256

On Windows PowerShell:

```powershell
Get-FileHash .\Tawny-VERSION-windows-x64.exe -Algorithm SHA256
```

Compare the reported digest with the row for that filename in `SHA256SUMS`. The command computes a digest for one downloaded file; you do not need to download every release asset.
