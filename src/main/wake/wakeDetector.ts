import { splitWakePhrase, stripSendPhrase } from '../pipeline/gate';

/**
 * Turns the speech recognizer's running transcript into "wake" and "send"
 * signals. The recognizer is tuned for recall (it reports early hypotheses),
 * so this layer adds the discipline: one signal per utterance, a cooldown
 * after every session, and a cap on how often a wake can fire. Every wake is
 * verified again by Whisper before anything runs, so a spurious one costs one
 * short transcription at most.
 */

/**
 * 'wake' carries complete=true when the recognizer reported the wake phrase only
 * once the whole sentence was over ("hey tawny open d drive" as one final
 * result): the request has already been said and capture can end at once.
 * 'sentence_end' is a finished sentence during a session that is more than the
 * wake phrase; 'speech' is a partial result, meaning the person is still talking.
 */
export type WakeSignal =
  | { type: 'wake'; complete: boolean }
  | { type: 'send' }
  | { type: 'sentence_end' }
  | { type: 'speech' }
  | { type: 'throttled'; reason: 'cooldown' | 'rate' };

export interface WakeDetectorOptions {
  now?: () => number;
  cooldownMs?: number;
  maxWakesPerMinute?: number;
  /** A hypothesis stream that never produces a final result re-arms after this long. */
  rearmMs?: number;
}

export class WakeDetector {
  private session = false;
  private armed = true;
  private cooldownUntil = 0;
  private lastDetectAt = 0;
  private sendSent = false;
  private wakeTimes: number[] = [];
  private readonly now: () => number;
  private readonly cooldownMs: number;
  private readonly maxPerMinute: number;
  private readonly rearmMs: number;

  constructor(options: WakeDetectorOptions = {}) {
    this.now = options.now ?? Date.now;
    this.cooldownMs = options.cooldownMs ?? 3000;
    this.maxPerMinute = options.maxWakesPerMinute ?? 6;
    this.rearmMs = options.rearmMs ?? 2500;
  }

  get inSession(): boolean {
    return this.session;
  }

  /** Feed a hypothesis or final result from the recognizer. */
  hear(text: string, kind: 'hyp' | 'final'): WakeSignal | undefined {
    const now = this.now();
    if (this.session) {
      if (!this.sendSent && stripSendPhrase(text).hadSendPhrase) {
        this.sendSent = true;
        return { type: 'send' };
      }
      if (kind === 'hyp') return { type: 'speech' };
      // A finished "hey tawny" alone means the person paused after the wake phrase: keep listening.
      const split = splitWakePhrase(text);
      if (split.routed && !split.command) return undefined;
      return text.trim() ? { type: 'sentence_end' } : undefined;
    }

    if (!this.armed) {
      // The final result of the utterance that just triggered (or ended) a session is its tail,
      // not a new request: consume it and re-arm for the next one.
      if (kind === 'final') {
        this.armed = true;
        return undefined;
      }
      if (now - this.lastDetectAt > this.rearmMs) this.armed = true;
    }

    if (!this.armed) return undefined;
    const split = splitWakePhrase(text);
    if (!split.routed) return undefined;

    this.armed = false;
    this.lastDetectAt = now;
    if (now < this.cooldownUntil) return { type: 'throttled', reason: 'cooldown' };
    this.wakeTimes = this.wakeTimes.filter((time) => now - time < 60_000);
    if (this.wakeTimes.length >= this.maxPerMinute) return { type: 'throttled', reason: 'rate' };
    this.wakeTimes.push(now);
    this.session = true;
    this.sendSent = false;
    return { type: 'wake', complete: kind === 'final' && split.command.length > 0 };
  }

  /** The orchestrator rejected a wake (busy, signed out); allow the next one immediately. */
  cancelWake(): void {
    this.session = false;
    this.wakeTimes.pop();
  }

  sessionEnded(): void {
    this.session = false;
    this.sendSent = false;
    this.armed = false;
    this.lastDetectAt = this.now();
    this.cooldownUntil = this.now() + this.cooldownMs;
  }
}
