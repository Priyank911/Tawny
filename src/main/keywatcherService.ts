import { spawn, execSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { app } from 'electron';

let watcherProcess: ChildProcessWithoutNullStreams | undefined;
let releaseCallback: (() => void) | undefined;

function getBinaryPath(): string {
  const devPath = join(__dirname, '../../src/main/native/keywatcher.exe');
  if (existsSync(devPath)) return devPath;

  const appPath = join(app.getAppPath(), 'src/main/native/keywatcher.exe');
  if (existsSync(appPath)) return appPath;

  const altPath = join(__dirname, '../native/keywatcher.exe');
  if (existsSync(altPath)) return altPath;

  // Try compiling if source exists
  const csSource = join(__dirname, '../../src/main/native/keywatcher.cs');
  if (existsSync(csSource)) {
    try {
      execSync(`"C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe" /nologo /optimize /target:exe /out:"${devPath}" "${csSource}"`, { windowsHide: true });
      if (existsSync(devPath)) return devPath;
    } catch {
      // compilation failed
    }
  }

  return devPath;
}

export function startKeyWatcher(): void {
  if (watcherProcess && !watcherProcess.killed) return;
  const binary = getBinaryPath();
  if (!existsSync(binary)) {
    console.warn('keywatcher.exe binary not found at', binary);
    return;
  }

  try {
    watcherProcess = spawn(binary, [], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    watcherProcess.stdout.setEncoding('utf8');
    watcherProcess.stdout.on('data', (chunk: string) => {
      const lines = chunk.split(/\r?\n/);
      for (const line of lines) {
        if (line.trim() === 'released') {
          const cb = releaseCallback;
          releaseCallback = undefined;
          cb?.();
        }
      }
    });

    watcherProcess.on('error', (err) => {
      console.warn('Key watcher process error:', err.message);
      watcherProcess = undefined;
    });

    watcherProcess.on('exit', () => {
      watcherProcess = undefined;
    });
  } catch (err) {
    console.error('Failed to spawn key watcher:', err);
  }
}

export function watchKeyRelease(onReleased: () => void): void {
  releaseCallback = onReleased;
  if (!watcherProcess || watcherProcess.killed) {
    startKeyWatcher();
  }
  if (watcherProcess && !watcherProcess.killed) {
    watcherProcess.stdin.write('watch\n');
  } else {
    // Fallback: in case binary couldn't run, poll via timeout
    setTimeout(() => {
      const cb = releaseCallback;
      releaseCallback = undefined;
      cb?.();
    }, 1500);
  }
}

export function cancelKeyReleaseWatch(): void {
  releaseCallback = undefined;
}

export function makeWindowTopmost(hwndNumber: number | bigint): void {
  if (!watcherProcess || watcherProcess.killed) {
    startKeyWatcher();
  }
  if (watcherProcess && !watcherProcess.killed) {
    watcherProcess.stdin.write(`topmost ${hwndNumber.toString()}\n`);
  }
}

export function stopKeyWatcher(): void {
  releaseCallback = undefined;
  if (watcherProcess && !watcherProcess.killed) {
    try {
      watcherProcess.stdin.write('exit\n');
      watcherProcess.kill();
    } catch {
      // ignore
    }
    watcherProcess = undefined;
  }
}
