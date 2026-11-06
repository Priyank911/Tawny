import { EnergyVad, FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE, frameRms } from './vad';
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
  /** Background level the detector measured, and the loudest 20 ms frame of the session (RMS, 0..1). For tuning. */
  noiseFloor: number;
  peakRms: number;
}

export interface CaptureCoreOptions {
  ringSeconds?: number;
  /**
   * How far back before the wake event a clip may start. The Windows recognizer
   * sometimes reports the wake phrase only after the whole sentence is over, so
   * this covers "hey tawny" plus a full command.
   */
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
  /** Recent stretches of speech (absolute sample indices), newest last. */
  private segments: Array<{ start: number; end: number }> = [];
  private wasVoiced = false;
  private rmsFrames = 0;
  private sessionPeakRms = 0;
  private readonly leadSamples: number;
  private readonly liveGapSamples: number;
  private readonly lateGapSamples: number;
  private readonly options: CaptureCoreOptions;

  constructor(options: CaptureCoreOptions) {
    this.options = options;
    this.ring = new PcmRing(Math.round((options.ringSeconds ?? 10) * SAMPLE_RATE));
    this.preRollSamples = Math.round(((options.preRollMs ?? 6000) / 1000) * SAMPLE_RATE);
    this.tailSamples = Math.round(((options.tailMs ?? 320) / 1000) * SAMPLE_RATE);
    this.leadSamples = Math.round((250 / 1000) * SAMPLE_RATE);
    // Pauses shorter than these belong to the same sentence: "hey ... tawny" while the person is still
    // talking, and "hey tawny, ... open d drive" when the wake arrives after the sentence ended.
    this.liveGapSamples = Math.round((700 / 1000) * SAMPLE_RATE);
    this.lateGapSamples = Math.round((1100 / 1000) * SAMPLE_RATE);
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
    if (voiced && !this.wasVoiced) {
      // The detector confirms speech a few frames after it starts.
      this.segments.push({ start: Math.max(this.ring.oldest, this.ring.totalWritten - 3 * FRAME_SAMPLES), end: this.ring.totalWritten });
      while (this.segments.length > 0 && this.segments[0].end < this.ring.oldest) this.segments.shift();
      if (this.segments.length > 64) this.segments.shift();
    }
    this.wasVoiced = voiced;
    if (voiced) {
      this.lastVoicedEnd = this.ring.totalWritten;
      const last = this.segments[this.segments.length - 1];
      if (last) last.end = this.ring.totalWritten;
    }
    if (!this.endpointer) return;

    this.rmsFrames += 1;
    if (rms > this.sessionPeakRms) this.sessionPeakRms = rms;
    if (this.rmsFrames % 3 === 0) this.options.onRms?.(Math.min(1, rms * 6));
    const result = this.endpointer.push(voiced);
    if (result) this.finishSession(result);
  }

  /** Called when the wake phrase is detected. Returns false if a session is already running. */
  beginSession(): boolean {
    if (this.endpointer) return false;
    this.endpointer = new SessionEndpointer(this.options.endpointer);
    this.sessionStart = this.chooseStart();
    this.rmsFrames = 0;
    this.sessionPeakRms = 0;
    return true;
  }

  /**
   * Where the clip begins: the start of the sentence that contains the wake
   * phrase. Walk back from the newest stretch of speech, joining earlier ones
   * across short pauses. A wake reported while the person is still talking
   * joins only brief pauses; a wake reported after the sentence ended may join
   * the pause after "hey tawny," too. Nothing older than the pre-roll is used.
   */
  private chooseStart(): number {
    const windowStart = Math.max(this.ring.oldest, this.ring.totalWritten - this.preRollSamples);
    const recent = this.segments.filter((segment) => segment.end > windowStart);
    if (recent.length === 0) return Math.max(windowStart, this.ring.totalWritten - Math.round(2.2 * SAMPLE_RATE));
    const gap = this.wasVoiced ? this.liveGapSamples : this.lateGapSamples;
    let start = recent[recent.length - 1].start;
    for (let i = recent.length - 2; i >= 0; i -= 1) {
      if (start - recent[i].end > gap) break;
      start = recent[i].start;
    }
    return Math.max(windowStart, start - this.leadSamples);
  }

  /** "Tawny send it", the recognizer's end of sentence, or an explicit cancel. */
  endSession(reason: 'send_it' | 'recognizer' | 'cancelled'): void {
    const result = this.endpointer?.force(reason);
    if (result) this.finishSession(result);
  }

  private finishSession(result: EndpointResult): void {
    this.endpointer = undefined;
    const end = result.reason === 'send_it' || result.reason === 'recognizer' || result.reason === 'cancelled'
      ? this.ring.totalWritten
      : Math.min(this.ring.totalWritten, Math.max(this.lastVoicedEnd, this.sessionStart) + this.tailSamples);
    const samples = this.ring.slice(this.sessionStart, end);
    // Loudest frame over the whole clip, pre-roll included: when the wake is reported late, after the person
    // finished speaking, the request is all in the pre-roll and nothing loud comes after the wake.
    this.sessionPeakRms = Math.max(this.sessionPeakRms, peakFrameRms(samples));
    this.options.onSessionEnd({
      samples,
      reason: result.reason,
      commandVoicedMs: result.commandVoicedMs,
      durationMs: Math.round((samples.length / SAMPLE_RATE) * 1000),
      noiseFloor: this.vad.noiseFloor,
      peakRms: this.sessionPeakRms
    });
  }
}

export { FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE };

export function peakFrameRms(samples: Int16Array): number {
  let peak = 0;
  for (let start = 0; start + FRAME_SAMPLES <= samples.length; start += FRAME_SAMPLES) {
    peak = Math.max(peak, frameRms(samples.subarray(start, start + FRAME_SAMPLES)));
  }
  return peak;
}

/** Below this the session was effectively silent (RMS of the loudest 20 ms frame after the wake). */
export const SILENT_SESSION_PEAK_RMS = 0.004;

/**
 * Whether a finished session should go to Whisper. The voice detector is a
 * loudness threshold and can miss a quiet command, so a session it labelled
 * "no command" is still transcribed unless it was truly silent; Whisper's
 * wake-phrase check then decides. A cancelled session never is.
 */
export function shouldTranscribe(clip: Pick<SessionClip, 'reason' | 'peakRms'>): boolean {
  if (clip.reason === 'cancelled') return false;
  if (clip.reason === 'no_command') return clip.peakRms >= SILENT_SESSION_PEAK_RMS;
  return true;
}
