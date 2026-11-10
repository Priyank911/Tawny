import { EventEmitter } from 'node:events';
import type { HandsFreeStatus } from '../../shared/contracts';
import { describeHelperStartError } from '../native/binaries';
import { LineProcess, type Spawner } from '../native/lineProcess';
import { WakeDetector, type WakeDetectorOptions, type WakeSignal } from './wakeDetector';

/**
 * Owns the speech-recognizer helper process and the detector on top of it.
 * Emits 'wake', 'send', 'throttled' and 'status'. If the helper dies it is
 * restarted with backoff; if it keeps dying, hands-free reports an error
 * instead of looping forever.
 */

interface WakeLine {
  t: 'ready' | 'hyp' | 'final' | 'error' | 'level' | 'end';
  text?: string;
  culture?: string;
  code?: string;
  message?: string;
}

export interface WakeServiceOptions {
  spawner: Spawner;
  detector?: WakeDetectorOptions;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  maxRestarts?: number;
  /** Watchdog against a recognizer that silently stops hearing. */
  watchdog?: {
    setInterval?: (callback: () => void, ms: number) => unknown;
    clearInterval?: (handle: unknown) => void;
    now?: () => number;
    intervalMs?: number;
    /** No line at all (not even the 5 s level heartbeat) for this long: the stream is dead. */
    stallMs?: number;
    /** Recycle a healthy recognizer this often; long System.Speech sessions degrade. */
    recycleAfterMs?: number;
    /** A scheduled recycle waits for this much quiet so nobody is cut off mid-sentence. */
    quietMs?: number;
  };
}

export const WATCHDOG_DEFAULTS = { intervalMs: 10_000, stallMs: 30_000, recycleAfterMs: 20 * 60_000, quietMs: 8_000 };

const ERROR_MESSAGES: Record<string, string> = {
  no_recognizer: 'Windows has no speech recognizer installed. Add an English speech language in Settings, Time and language, Speech.',
  no_audio_device: 'No microphone is available. Plug one in or allow desktop apps to use the microphone in Windows privacy settings.',
  start_failed: 'The speech recognizer could not start.'
};

export class WakeService extends EventEmitter {
  private readonly process: LineProcess;
  readonly detector: WakeDetector;
  private status: HandsFreeStatus = { enabled: false, state: 'off', message: 'Hands-free is off.' };
  private wanted = false;
  private paused = false;
  private restarts = 0;
  private restartTimer: unknown;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly maxRestarts: number;
  private readonly watch: Required<NonNullable<WakeServiceOptions['watchdog']>>;
  private watchHandle: unknown;
  private recyclePending = false;
  private readyAt = 0;
  private lastLineAt = 0;
  private lastSpeechAt = 0;

  constructor(options: WakeServiceOptions) {
    super();
    this.process = new LineProcess(options.spawner);
    this.detector = new WakeDetector(options.detector);
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.maxRestarts = options.maxRestarts ?? 5;
    this.watch = {
      setInterval: options.watchdog?.setInterval ?? ((callback, ms) => {
        const handle = setInterval(callback, ms);
        handle.unref?.();
        return handle;
      }),
      clearInterval: options.watchdog?.clearInterval ?? ((handle) => clearInterval(handle as NodeJS.Timeout)),
      now: options.watchdog?.now ?? Date.now,
      intervalMs: options.watchdog?.intervalMs ?? WATCHDOG_DEFAULTS.intervalMs,
      stallMs: options.watchdog?.stallMs ?? WATCHDOG_DEFAULTS.stallMs,
      recycleAfterMs: options.watchdog?.recycleAfterMs ?? WATCHDOG_DEFAULTS.recycleAfterMs,
      quietMs: options.watchdog?.quietMs ?? WATCHDOG_DEFAULTS.quietMs
    };
    this.process.on('line', (line: string) => this.onLine(line));
    this.process.on('exit', () => this.onExit());
    this.process.on('error', (error: Error) => this.fail(describeHelperStartError('The speech recognizer (tawny-wake.exe)', error)));
  }

  get current(): HandsFreeStatus {
    return this.status;
  }

  start(): void {
    this.wanted = true;
    this.paused = false;
    this.restarts = 0;
    this.setStatus({ enabled: true, state: 'starting', message: 'Starting the speech recognizer…' });
    this.process.start();
    this.startWatchdog();
  }

  stop(): void {
    this.wanted = false;
    this.stopWatchdog();
    this.recyclePending = false;
    if (this.restartTimer !== undefined) this.clearTimer(this.restartTimer);
    this.restartTimer = undefined;
    this.process.stop();
    this.setStatus({ enabled: false, state: 'off', message: 'Hands-free is off.' });
  }

  /** Stop listening without turning the feature off (screen locked, user signed out). */
  pause(reason: string): void {
    if (!this.wanted || this.paused) return;
    this.paused = true;
    this.process.stop();
    this.setStatus({ enabled: true, state: 'paused', message: reason });
  }

  resume(): void {
    if (!this.wanted || !this.paused) return;
    this.paused = false;
    this.setStatus({ enabled: true, state: 'starting', message: 'Starting the speech recognizer…' });
    this.process.start();
  }

  sessionEnded(): void {
    this.detector.sessionEnded();
  }

  /** Restarts a recognizer that stopped hearing, without counting it as a crash. */
  recycle(reason: 'stalled' | 'scheduled'): void {
    if (!this.wanted || this.paused || this.recyclePending || !this.process.alive) return;
    this.recyclePending = true;
    this.emit('recycle', reason);
    this.process.stop();
  }

  private startWatchdog(): void {
    if (this.watchHandle !== undefined) return;
    this.watchHandle = this.watch.setInterval(() => this.checkHealth(), this.watch.intervalMs);
  }

  private stopWatchdog(): void {
    if (this.watchHandle !== undefined) this.watch.clearInterval(this.watchHandle);
    this.watchHandle = undefined;
  }

  /** Called by the watchdog interval; public for tests. */
  checkHealth(): void {
    if (!this.wanted || this.paused || this.status.state !== 'listening') return;
    const now = this.watch.now();
    if (now - this.lastLineAt > this.watch.stallMs) {
      this.recycle('stalled');
      return;
    }
    if (now - this.readyAt > this.watch.recycleAfterMs && now - this.lastSpeechAt > this.watch.quietMs) this.recycle('scheduled');
  }

  private onLine(line: string): void {
    let parsed: WakeLine;
    try {
      parsed = JSON.parse(line) as WakeLine;
    } catch {
      return;
    }
    const now = this.watch.now();
    this.lastLineAt = now;
    if (parsed.t === 'level' || parsed.t === 'end') return;
    if (parsed.t === 'hyp' || parsed.t === 'final') this.lastSpeechAt = now;
    if (parsed.t === 'ready') {
      this.readyAt = now;
      this.restarts = 0;
      this.setStatus({ enabled: true, state: 'listening', message: `Listening for “Hey Tawny”${parsed.culture ? ` (${parsed.culture})` : ''}.` });
      return;
    }
    if (parsed.t === 'error') {
      this.fail(ERROR_MESSAGES[parsed.code ?? ''] ?? parsed.message ?? 'The speech recognizer reported an error.', parsed.code === 'no_recognizer');
      return;
    }
    if ((parsed.t === 'hyp' || parsed.t === 'final') && typeof parsed.text === 'string' && !this.paused) {
      const signal = this.detector.hear(parsed.text, parsed.t);
      if (signal) this.emitSignal(signal);
    }
  }

  private emitSignal(signal: WakeSignal): void {
    this.emit(signal.type, signal);
  }

  private onExit(): void {
    if (this.recyclePending) {
      this.recyclePending = false;
      if (this.wanted && !this.paused) {
        this.setStatus({ enabled: true, state: 'starting', message: 'Refreshing the speech recognizer…' });
        this.process.start();
      }
      return;
    }
    if (!this.wanted || this.paused) return;
    if (this.status.state === 'error') return;
    if (this.restarts >= this.maxRestarts) {
      this.fail('The speech recognizer stopped repeatedly. Turn hands-free off and on to retry.');
      return;
    }
    const delay = Math.min(30_000, 1000 * 2 ** this.restarts);
    this.restarts += 1;
    this.setStatus({ enabled: true, state: 'starting', message: 'Restarting the speech recognizer…' });
    this.restartTimer = this.setTimer(() => {
      this.restartTimer = undefined;
      if (this.wanted && !this.paused) this.process.start();
    }, delay);
  }

  private fail(message: string, permanent = false): void {
    if (permanent) {
      this.wanted = false;
      this.stopWatchdog();
    }
    this.process.stop();
    this.setStatus({ enabled: this.wanted, state: 'error', message });
  }

  private setStatus(next: HandsFreeStatus): void {
    this.status = next;
    this.emit('status', next);
  }
}
