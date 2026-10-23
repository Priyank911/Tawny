import { clipboard, nativeImage } from 'electron';
import { execFile } from 'node:child_process';

interface ClipboardSnapshot {
  formats: Array<{ format: string; data: Buffer }>;
}

function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: 5_000 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function pasteShortcut(): Promise<void> {
  if (process.platform === 'win32') {
    return runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 80; $wshell.SendKeys("^v")']);
  }
  if (process.platform === 'darwin') {
    return runCommand('/usr/bin/osascript', ['-e', 'delay 0.08', '-e', 'tell application "System Events" to keystroke "v" using {command down}']);
  }
  return runCommand('xdotool', ['key', '--clearmodifiers', 'ctrl+v']).catch((error: unknown) => {
    const reason = error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'Install xdotool and use an X11 session to enable keyboard paste.'
      : 'Linux did not allow keyboard paste. On Wayland, use an X11 session or paste manually from the clipboard.';
    throw new Error(reason);
  });
}

function copyShortcut(): Promise<void> {
  if (process.platform === 'win32') {
    return runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', '$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 110; $wshell.SendKeys("^c"); Start-Sleep -Milliseconds 180']);
  }
  if (process.platform === 'darwin') {
    return runCommand('/usr/bin/osascript', ['-e', 'delay 0.11', '-e', 'tell application "System Events" to keystroke "c" using {command down}', '-e', 'delay 0.18']);
  }
  return runCommand('xdotool', ['key', '--clearmodifiers', 'ctrl+c']).catch(() => {
    throw new Error('Selected-text capture needs xdotool in an X11 session. Dictation can still be used normally.');
  });
}

export async function pasteText(text: string): Promise<void> {
  const value = text.trim();
  if (!value) throw new Error('There is no text to paste.');
  clipboard.writeText(value);
  await pasteShortcut();
}

function snapshotClipboard(): ClipboardSnapshot {
  const formats = clipboard.availableFormats();
  return {
    formats: formats.map((format) => ({ format, data: clipboard.readBuffer(format) }))
  };
}

function restoreClipboard(snapshot: ClipboardSnapshot): void {
  clipboard.clear();
  for (const entry of snapshot.formats) {
    clipboard.writeBuffer(entry.format, entry.data);
  }
}

export async function captureSelectedText(maxLength = 8_000): Promise<string> {
  const before = snapshotClipboard();
  const marker = `__tawny_copy_probe_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}__`;
  try {
    clipboard.writeText(marker);
    // The global shortcut may arrive while Ctrl/Alt/Space are still held.
    // Retry once for slower editors and browser-based text fields.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await copyShortcut();
      const copied = clipboard.readText().trim();
      if (copied && copied !== marker) return copied.slice(0, Math.max(1, maxLength));
    }
    return '';
  } finally {
    restoreClipboard(before);
  }
}

export async function pasteImage(base64: string): Promise<void> {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
  if (image.isEmpty()) throw new Error('Generated image data could not be placed on the clipboard.');
  clipboard.writeImage(image);
  await pasteShortcut();
}
