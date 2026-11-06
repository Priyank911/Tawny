import { FRAME_MS } from './vad';

/**
 * Decides when a hands-free utterance is over.
 *
 * A session starts the moment the wake phrase is detected, which is usually
 * while the speaker is still finishing "tawny". Three situations follow:
 *
 *  - One breath ("hey tawny make a sunset"): speech keeps going well past the
 *    wake phrase, so the session is already in the speaking phase and ends
 *    after a short silence.
 *  - Wake phrase, then a pause, then the command ("hey tawny ... open
 *    downloads"): only the phrase tail is voiced, then silence. The session
 *    waits up to `initialGraceMs` for the command to begin.
 *  - False wake or nothing said: the grace period runs out and the session
 *    ends with `no_command`, which the caller discards without a model call.
 */

export interface EndpointerConfig {
  /** Silence after command speech that ends the utterance. */
  endSilenceMs: number;
  /** Silence that marks the end of the wake phrase itself. */
  phraseGapMs: number;
  /** How long to wait for a command after a wake-only phrase. */
  initialGraceMs: number;
  /** Voiced time after the wake event beyond which speech is treated as the command. */
  wakeTailMs: number;
  /** Command speech shorter than this is treated as noise. */
  minCommandVoicedMs: number;
  /** Hard cap on one session. */
  maxSessionMs: number;
  /** Voiced time needed to accept that a command started after a pause. */
  resumeVoicedMs: number;
}

export const DEFAULT_ENDPOINTER_CONFIG: EndpointerConfig = {
  endSilenceMs: 1200,
  phraseGapMs: 260,
  initialGraceMs: 6000,
  wakeTailMs: 700,
  minCommandVoicedMs: 320,
  maxSessionMs: 60_000,
  resumeVoicedMs: 100
};

/** 'recognizer': the Windows speech recognizer reported that the sentence was finished. */
export type EndReason = 'silence' | 'send_it' | 'recognizer' | 'max' | 'no_command' | 'cancelled';

export interface EndpointResult {
  reason: EndReason;
  commandVoicedMs: number;
  elapsedMs: number;
}

type Phase = 'wake_tail' | 'await_command' | 'speaking' | 'done';

export class SessionEndpointer {
  private phase: Phase = 'wake_tail';
  private elapsedMs = 0;
  private voicedAfterWakeMs = 0;
  private commandVoicedMs = 0;
  private silenceRunMs = 0;
  private resumeRunMs = 0;
  private graceMs = 0;
  private result: EndpointResult | undefined;
  private readonly config: EndpointerConfig;

  constructor(config: Partial<EndpointerConfig> = {}) {
    this.config = { ...DEFAULT_ENDPOINTER_CONFIG, ...config };
  }

  get currentPhase(): Phase {
    return this.phase;
  }

  get finished(): EndpointResult | undefined {
    return this.result;
  }

  /** Feed one 20 ms voiced/unvoiced decision. Returns the result once, when the session ends. */
  push(voiced: boolean): EndpointResult | undefined {
    if (this.phase === 'done') return undefined;
    this.elapsedMs += FRAME_MS;
    if (this.elapsedMs >= this.config.maxSessionMs) return this.finish('max');

    switch (this.phase) {
      case 'wake_tail':
        if (voiced) {
          this.voicedAfterWakeMs += FRAME_MS;
          this.silenceRunMs = 0;
          if (this.voicedAfterWakeMs > this.config.wakeTailMs) {
            this.phase = 'speaking';
            this.commandVoicedMs = this.voicedAfterWakeMs;
          }
        } else {
          this.silenceRunMs += FRAME_MS;
          if (this.silenceRunMs >= this.config.phraseGapMs) {
            this.phase = 'await_command';
            this.graceMs = this.silenceRunMs;
            this.resumeRunMs = 0;
          }
        }
        return undefined;

      case 'await_command':
        if (voiced) {
          this.resumeRunMs += FRAME_MS;
          if (this.resumeRunMs >= this.config.resumeVoicedMs) {
            this.phase = 'speaking';
            this.commandVoicedMs = this.resumeRunMs;
            this.silenceRunMs = 0;
          }
        } else {
          this.resumeRunMs = 0;
          this.graceMs += FRAME_MS;
          if (this.graceMs >= this.config.initialGraceMs) return this.finish('no_command');
        }
        return undefined;

      case 'speaking':
        if (voiced) {
          this.commandVoicedMs += FRAME_MS;
          this.silenceRunMs = 0;
        } else {
          this.silenceRunMs += FRAME_MS;
          if (this.silenceRunMs >= this.config.endSilenceMs) {
            return this.finish(this.commandVoicedMs >= this.config.minCommandVoicedMs ? 'silence' : 'no_command');
          }
        }
        return undefined;
    }
    return undefined;
  }

  /** The user said "tawny send it", the recognizer heard the sentence end, or the session was cancelled. */
  force(reason: 'send_it' | 'recognizer' | 'cancelled'): EndpointResult | undefined {
    if (this.phase === 'done') return undefined;
    return this.finish(reason);
  }

  private finish(reason: EndReason): EndpointResult {
    this.phase = 'done';
    this.result = { reason, commandVoicedMs: this.commandVoicedMs, elapsedMs: this.elapsedMs };
    return this.result;
  }
}
