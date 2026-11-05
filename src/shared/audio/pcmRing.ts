/**
 * Fixed-capacity ring buffer of 16-bit PCM with absolute sample indexing.
 * Absolute indexes let a hands-free session ask for "everything since 2.2
 * seconds before the wake event" without caring where the write cursor is.
 */
export class PcmRing {
  private readonly data: Int16Array;
  private written = 0;

  constructor(readonly capacitySamples: number) {
    this.data = new Int16Array(capacitySamples);
  }

  /** Total samples ever written. */
  get totalWritten(): number {
    return this.written;
  }

  /** Absolute index of the oldest sample still held. */
  get oldest(): number {
    return Math.max(0, this.written - this.capacitySamples);
  }

  write(samples: Int16Array): void {
    for (let i = 0; i < samples.length; i += 1) {
      this.data[(this.written + i) % this.capacitySamples] = samples[i];
    }
    this.written += samples.length;
  }

  /** Copies [start, end) in absolute sample indexes, clamped to what is still held. */
  slice(start: number, end: number = this.written): Int16Array {
    const from = Math.max(start, this.oldest);
    const to = Math.min(end, this.written);
    if (to <= from) return new Int16Array(0);
    const out = new Int16Array(to - from);
    for (let i = 0; i < out.length; i += 1) out[i] = this.data[(from + i) % this.capacitySamples];
    return out;
  }
}
