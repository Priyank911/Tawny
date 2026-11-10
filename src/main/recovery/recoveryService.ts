import { EventEmitter } from 'node:events';
import { PipelineError, type RecoveryState } from '../../shared/contracts';
import { GroqBudget, splitWavForUpload } from './groqBudget';
import type { RecoveryStore, SaveInput } from './recoveryStore';

export type Transcriber = (segments: Uint8Array[], mimeType: string) => Promise<string>;

export interface RecoveryServiceOptions {
  store: RecoveryStore;
  budget: GroqBudget;
  transcribe: Transcriber;
  /** Waits shorter than this happen in place; longer ones mark the recording "waiting". */
  maxInlineWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (event: string, message: string, level?: 'info' | 'warn' | 'error') => void;
}

/**
 * Re-sends saved recordings to Groq one at a time, inside the local budget.
 * Emits 'change' whenever the list or a status changes.
 */
export class RecoveryService extends EventEmitter {
  private queue: string[] = [];
  private running = false;
  private readonly maxInlineWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: NonNullable<RecoveryServiceOptions['log']>;

  constructor(private readonly options: RecoveryServiceOptions) {
    super();
    this.maxInlineWaitMs = options.maxInlineWaitMs ?? 65_000;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => undefined);
  }

  async state(): Promise<RecoveryState> {
    const { store, budget } = this.options;
    const snapshot = budget.snapshot();
    const { limits } = snapshot;
    return {
      available: store.available,
      recordings: store.available ? await store.list().catch(() => []) : [],
      budget: {
        requestsLastMinute: snapshot.requestsLastMinute,
        requestsToday: snapshot.requestsToday,
        audioSecondsLastHour: snapshot.audioSecondsLastHour,
        audioSecondsToday: snapshot.audioSecondsToday,
        limits: {
          requestsPerMinute: limits.requestsPerMinute,
          requestsPerDay: limits.requestsPerDay,
          audioSecondsPerHour: limits.audioSecondsPerHour,
          audioSecondsPerDay: limits.audioSecondsPerDay
        }
      }
    };
  }

  /** Keeps a failed request. Never throws: losing the backup must not mask the original failure. */
  async keep(input: SaveInput): Promise<boolean> {
    if (!this.options.store.available) {
      this.log('recovery.unavailable', 'Secure storage is unavailable; the failed recording was not kept.', 'warn');
      return false;
    }
    try {
      const saved = await this.options.store.save(input);
      this.log('recovery.saved', `Failed request kept for retry (${Math.round(saved.durationMs / 1000)} s, ${saved.status}).`);
      this.changed();
      return true;
    } catch (error) {
      this.log('recovery.save.failure', error instanceof Error ? error.message : 'The failed recording could not be kept.', 'warn');
      return false;
    }
  }

  /** Queues one recording (or every pending one) for transcription. */
  async retry(id?: string): Promise<void> {
    const recordings = await this.options.store.list();
    const ids = id ? [id] : recordings.filter((item) => item.hasAudio && item.status !== 'working').map((item) => item.id);
    for (const next of ids) {
      if (this.queue.includes(next)) continue;
      const item = recordings.find((entry) => entry.id === next);
      if (!item?.hasAudio) continue;
      this.queue.push(next);
      await this.options.store.update(next, { status: 'working', lastError: undefined });
    }
    this.changed();
    void this.drain();
  }

  async remove(id: string): Promise<void> {
    this.queue = this.queue.filter((item) => item !== id);
    await this.options.store.remove(id);
    this.changed();
  }

  async clear(): Promise<void> {
    this.queue = [];
    await this.options.store.clear();
    this.changed();
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const id = this.queue.shift()!;
        await this.transcribeOne(id).catch((error: unknown) => {
          this.log('recovery.retry.failure', error instanceof Error ? error.message : 'Retry failed.', 'warn');
        });
        this.changed();
      }
    } finally {
      this.running = false;
    }
  }

  private async transcribeOne(id: string): Promise<void> {
    const { store, budget, transcribe } = this.options;
    const item = await store.get(id);
    if (!item?.hasAudio) return;
    const wait = budget.waitFor(item.durationMs);
    if (wait > this.maxInlineWaitMs) {
      const finite = Number.isFinite(wait);
      const retryAfter = finite ? new Date(this.now() + wait).toISOString() : undefined;
      await store.update(id, {
        status: 'waiting',
        lastError: finite
          ? `Waiting for Groq's limit. Try again after ${new Date(this.now() + wait).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
          : 'This recording is longer than Groq allows in one hour.',
        ...(retryAfter ? { retryAfter } : {})
      });
      return;
    }
    if (wait > 0) {
      this.log('recovery.retry.wait', `Waiting ${Math.ceil(wait / 1000)} s to stay inside Groq's limits.`);
      await this.sleep(wait);
    }
    const audio = await store.readAudio(id);
    const segments = audio.segments.flatMap((segment) => splitWavForUpload(segment));
    budget.note(item.durationMs);
    const attempts = item.attempts + 1;
    try {
      const transcript = (await transcribe(segments, audio.mimeType)).trim();
      if (!transcript) {
        await store.update(id, { status: 'failed', attempts, lastError: 'Groq heard no speech in this recording.' });
        return;
      }
      await store.complete(id, transcript, attempts);
      this.log('recovery.retry.success', 'A saved recording was transcribed.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Groq transcription failed.';
      const retryAfterMs = error instanceof PipelineError ? error.retryAfterMs : undefined;
      if (retryAfterMs) budget.blockFor(retryAfterMs);
      await store.update(id, {
        status: retryAfterMs ? 'waiting' : 'failed',
        attempts,
        lastError: message,
        ...(retryAfterMs ? { retryAfter: new Date(this.now() + retryAfterMs).toISOString() } : {})
      });
    }
  }

  private changed(): void {
    this.emit('change');
  }
}
