import { EnergyVad, FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE } from './vad';
import { SessionEndpointer, type EndpointerConfig, type EndpointResult } from './endpointer';
import { PcmRing } from './pcmRing';

/**
 * The always-on capture engine, free of any browser API so it can be tested
 * with synthetic audio. The hidden engine window feeds it 20 ms frames from
 * an AudioWorklet. It keeps a few seconds of audio so a session can include
 * the wake phrase and anything said in the same breath, and it reports when
 * the utterance is over.
 */

export interface SessionClip {
  samples: Int16Array;
  reason: EndpointResult['reason'];
  commandVoicedMs: number;
  durationMs: number;
}

export interface CaptureCoreOptions {
  ringSeconds?: number;
  /** Audio kept from before the wake event so the phrase and first words are never clipped. */
  preRollMs?: number;
  /** Silence kept after the last speech so words are not cut off. */
  tailMs?: number;
  endpointer?: Partial<EndpointerConfig>;
  onRms?: (rms: number) => void;
  onSessionEnd: (clip: SessionClip) => void;
}

export class CaptureCore {
  private readonly ring: PcmRing;
  private readonly vad = new EnergyVad();
  private readonly preRollSamples: number;
  private readonly tailSamples: number;
  private endpointer: SessionEndpointer | undefined;
  private sessionStart = 0;
  private lastVoicedEnd = 0;
  private clusterStart = -1;
  private wasVoiced = false;
  private rmsFrames = 0;
  private readonly leadSamples: number;
  private readonly clusterGapSamples: number;
  private readonly options: CaptureCoreOptions;

  constructor(options: CaptureCoreOptions) {
    this.options = options;
    this.ring = new PcmRing(Math.round((options.ringSeconds ?? 8) * SAMPLE_RATE));
    this.preRollSamples = Math.round(((options.preRollMs ?? 2200) / 1000) * SAMPLE_RATE);
    this.tailSamples = Math.round(((options.tailMs ?? 320) / 1000) * SAMPLE_RATE);
    this.leadSamples = Math.round((250 / 1000) * SAMPLE_RATE);
    // Pauses shorter than this inside "hey ... tawny" belong to the same utterance.
    this.clusterGapSamples = Math.round((700 / 1000) * SAMPLE_RATE);
  }

  get sessionActive(): boolean {
    return this.endpointer !== undefined;
  }

  get noiseFloor(): number {
    return this.vad.noiseFloor;
  }

  /** Feed exactly one 20 ms frame. */
  pushFrame(frame: Int16Array): void {
    if (frame.length !== FRAME_SAMPLES) throw new Error(`Expected ${FRAME_SAMPLES} samples per frame, received ${frame.length}.`);
    this.ring.write(frame);
    const { rms, voiced } = this.vad.process(frame);
    if (voiced && !this.wasVoiced && this.ring.totalWritten - this.lastVoicedEnd > this.clusterGapSamples) {
      // The detector confirms speech a few frames after it starts.
      this.clusterStart = Math.max(this.ring.oldest, this.ring.totalWritten - 3 * FRAME_SAMPLES);
    }
    this.wasVoiced = voiced;
    if (voiced) this.lastVoicedEnd = this.ring.totalWritten;
    if (!this.endpointer) return;

    this.rmsFrames += 1;
    if (this.rmsFrames % 3 === 0) this.options.onRms?.(Math.min(1, rms * 6));
    const result = this.endpointer.push(voiced);
    if (result) this.finishSession(result);
  }

  /** Called when the wake phrase is detected. Returns false if a session is already running. */
  beginSession(): boolean {
    if (this.endpointer) return false;
    this.endpointer = new SessionEndpointer(this.options.endpointer);
    const preRollStart = Math.max(this.ring.oldest, this.ring.totalWritten - this.preRollSamples);
    // Start just before the speech that triggered the wake, not at the start of the pre-roll window.
    this.sessionStart = this.clusterStart >= 0 ? Math.max(preRollStart, this.clusterStart - this.leadSamples) : preRollStart;
    this.rmsFrames = 0;
    return true;
  }

  /** "Tawny send it" or an explicit cancel. */
  endSession(reason: 'send_it' | 'cancelled'): void {
    const result = this.endpointer?.force(reason);
    if (result) this.finishSession(result);
  }

  private finishSession(result: EndpointResult): void {
    this.endpointer = undefined;
    const end = result.reason === 'send_it' || result.reason === 'cancelled'
      ? this.ring.totalWritten
      : Math.min(this.ring.totalWritten, Math.max(this.lastVoicedEnd, this.sessionStart) + this.tailSamples);
    const samples = this.ring.slice(this.sessionStart, end);
    this.options.onSessionEnd({
      samples,
      reason: result.reason,
      commandVoicedMs: result.commandVoicedMs,
      durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000)
    });
  }
}

export { FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE };
