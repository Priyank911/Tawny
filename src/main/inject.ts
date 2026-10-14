import { clipboard, nativeImage } from 'electron';
import { execFile } from 'node:child_process';

function runPowerShell(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script], (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function pasteText(text: string): Promise<void> {
  const value = text.trim();
  if (!value) throw new Error('There is no text to paste.');
  clipboard.writeText(value);
  await runPowerShell(
    '$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 80; $wshell.SendKeys("^v")'
  );
}

export async function pasteImage(base64: string): Promise<void> {
  const image = nativeImage.createFromBuffer(Buffer.from(base64, 'base64'));
  if (image.isEmpty()) throw new Error('Generated image data could not be placed on the clipboard.');
  clipboard.writeImage(image);
  await runPowerShell(
    '$wshell = New-Object -ComObject WScript.Shell; Start-Sleep -Milliseconds 120; $wshell.SendKeys("^v")'
  );
}
