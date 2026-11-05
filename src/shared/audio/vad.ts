/**
 * Energy-based voice activity detector with an adaptive noise floor.
 *
 * It runs on 20 ms frames of 16 kHz mono audio. The threshold follows the room:
 * the floor drops quickly when it gets quieter and rises slowly, and it is
 * frozen while speech is detected so a long sentence cannot raise its own
 * threshold. Onset needs a few consecutive loud frames (a door slam is not
 * speech) and a hangover keeps brief dips between words voiced.
 */

export const SAMPLE_RATE = 16_000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000;

export interface VadOptions {
  /** Consecutive loud frames required to start a voiced region. */
  onsetFrames: number;
  /** How long voiced state persists after the last loud frame. */
  hangoverMs: number;
  /** Absolute RMS floor (0..1) so digital silence and faint hiss never trigger. */
  minRms: number;
  /** Speech must exceed the noise floor by this factor. */
  ratio: number;
}

export const DEFAULT_VAD_OPTIONS: VadOptions = { onsetFrames: 3, hangoverMs: 240, minRms: 0.012, ratio: 3 };

export function frameRms(frame: Int16Array | Float32Array): number {
  if (frame.length === 0) return 0;
  const scale = frame instanceof Int16Array ? 1 / 32768 : 1;
  let sum = 0;
  for (let i = 0; i < frame.length; i += 1) {
    const value = frame[i] * scale;
    sum += value * value;
  }
  return Math.sqrt(sum / frame.length);
}

export class EnergyVad {
  private noise = 0.004;
  private loudRun = 0;
  private hangoverLeft = 0;
  private voicedNow = false;
  private readonly options: VadOptions;

  constructor(options: Partial<VadOptions> = {}) {
    this.options = { ...DEFAULT_VAD_OPTIONS, ...options };
  }

  get noiseFloor(): number {
    return this.noise;
  }

  process(frame: Int16Array | Float32Array): { rms: number; voiced: boolean } {
    const rms = frameRms(frame);
    const threshold = Math.max(this.options.minRms, this.noise * this.options.ratio);
    const loud = rms > threshold;

    if (loud) {
      this.loudRun += 1;
      if (this.loudRun >= this.options.onsetFrames || this.voicedNow) {
        this.voicedNow = true;
        this.hangoverLeft = Math.ceil(this.options.hangoverMs / FRAME_MS);
      }
    } else {
      this.loudRun = 0;
      if (this.voicedNow) {
        this.hangoverLeft -= 1;
        if (this.hangoverLeft <= 0) this.voicedNow = false;
      }
    }

    if (!this.voicedNow && !loud) {
      this.noise = rms < this.noise ? this.noise * 0.8 + rms * 0.2 : this.noise + (rms - this.noise) * 0.004;
      this.noise = Math.max(0.0008, this.noise);
    }
    return { rms, voiced: this.voicedNow };
  }
}
