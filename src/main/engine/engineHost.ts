import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { BrowserWindow, ipcMain } from 'electron';
import type { SessionClip } from '../../shared/audio/captureCore';

/**
 * The hidden window that owns the microphone for hands-free mode. It exists
 * only while hands-free is on, so turning the feature off releases the
 * microphone completely. Emits 'status', 'rms' and 'clip'.
 */

export interface EngineClip {
  samples: Int16Array;
  reason: SessionClip['reason'];
  commandVoicedMs: number;
  durationMs: number;
  noiseFloor: number;
  peakRms: number;
}

export interface EngineStatus {
  state: 'running' | 'stopped' | 'error';
  message?: string;
}

export class EngineHost extends EventEmitter {
  private window: BrowserWindow | undefined;
  private attached = false;

  private attach(): void {
    if (this.attached) return;
    this.attached = true;
    const fromEngine = (sender: Electron.WebContents) => this.window !== undefined && sender === this.window.webContents;
    ipcMain.on('engine:status', (event, status: EngineStatus) => {
      if (fromEngine(event.sender)) this.emit('status', status);
    });
    ipcMain.on('engine:rms', (event, value: unknown) => {
      if (fromEngine(event.sender) && typeof value === 'number') this.emit('rms', Math.min(1, Math.max(0, value)));
    });
    ipcMain.on('engine:clip', (event, clip: { pcm: Uint8Array; reason: EngineClip['reason']; commandVoicedMs: number; durationMs: number; noiseFloor?: number; peakRms?: number }) => {
      if (!fromEngine(event.sender) || !(clip?.pcm instanceof Uint8Array)) return;
      const bytes = new Uint8Array(clip.pcm.byteLength - (clip.pcm.byteLength % 2));
      bytes.set(clip.pcm.subarray(0, bytes.length));
      this.emit('clip', {
        samples: new Int16Array(bytes.buffer, 0, bytes.length / 2),
        reason: clip.reason,
        commandVoicedMs: clip.commandVoicedMs,
        durationMs: clip.durationMs,
        noiseFloor: typeof clip.noiseFloor === 'number' ? clip.noiseFloor : 0,
        peakRms: typeof clip.peakRms === 'number' ? clip.peakRms : 0
      } satisfies EngineClip);
    });
  }

  get running(): boolean {
    return this.window !== undefined && !this.window.isDestroyed();
  }

  start(): void {
    this.attach();
    if (this.running) return;
    const window = new BrowserWindow({
      show: false,
      width: 1,
      height: 1,
      focusable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: join(__dirname, '../preload/enginePreload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        // A hidden window is throttled by default, which would starve the audio worklet's message port.
        backgroundThrottling: false
      }
    });
    this.window = window;
    window.webContents.on('render-process-gone', (_event, details) => {
      if (this.window !== window) return;
      this.window = undefined;
      this.emit('status', { state: 'error', message: `The audio engine stopped (${details.reason}).` } satisfies EngineStatus);
    });
    window.webContents.once('did-finish-load', () => this.send({ type: 'start' }));
    window.webContents.once('did-fail-load', (_event, _code, description) => {
      this.emit('status', { state: 'error', message: `The audio engine could not load (${description}).` } satisfies EngineStatus);
    });
    if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(`${process.env.ELECTRON_RENDERER_URL}/engine.html`);
    else void window.loadFile(join(__dirname, '../renderer/engine.html'));
  }

  stop(): void {
    const window = this.window;
    this.window = undefined;
    if (!window || window.isDestroyed()) return;
    try {
      window.webContents.send('engine:command', { type: 'stop' });
    } catch {
      // The page is already gone.
    }
    setTimeout(() => { if (!window.isDestroyed()) window.destroy(); }, 300);
  }

  private send(command: { type: 'start' | 'stop' | 'begin' | 'end'; reason?: 'send_it' | 'recognizer' | 'cancelled' }): boolean {
    if (!this.window || this.window.isDestroyed()) return false;
    this.window.webContents.send('engine:command', command);
    return true;
  }

  beginSession(): boolean {
    return this.send({ type: 'begin' });
  }

  endSession(reason: 'send_it' | 'recognizer' | 'cancelled'): boolean {
    return this.send({ type: 'end', reason });
  }
}
