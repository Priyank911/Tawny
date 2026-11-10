/**
 * Local accounting of Groq speech-to-text usage, so re-sending saved
 * recordings never trips the account's limits (and never starves live
 * requests). Groq free tier for whisper-large-v3(-turbo), checked 2026-11:
 *   20 requests/minute, 2,000 requests/day,
 *   7,200 audio seconds/hour, 28,800 audio seconds/day,
 *   every request billed as at least 10 seconds, uploads up to 25 MB.
 * Live requests are noted too, but only retries wait on the budget.
 */

export const GROQ_LIMITS = {
  requestsPerMinute: 20,
  requestsPerDay: 2000,
  audioSecondsPerHour: 7200,
  audioSecondsPerDay: 28_800,
  minBilledSeconds: 10,
  maxUploadBytes: 25 * 1024 * 1024,
  /** Retries keep this many requests per minute free for live use. */
  liveHeadroomPerMinute: 4
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

interface UsageEntry {
  at: number;
  billedSeconds: number;
}

export interface BudgetSnapshot {
  requestsLastMinute: number;
  requestsToday: number;
  audioSecondsLastHour: number;
  audioSecondsToday: number;
  limits: typeof GROQ_LIMITS;
}

export function billedSeconds(durationMs: number): number {
  return Math.max(GROQ_LIMITS.minBilledSeconds, Math.ceil(durationMs / 1000));
}

export class GroqBudget {
  private entries: UsageEntry[] = [];
  private blockedUntil = 0;

  constructor(private readonly now: () => number = Date.now) {}

  note(durationMs: number): void {
    this.entries.push({ at: this.now(), billedSeconds: billedSeconds(durationMs) });
    this.trim();
  }

  /** Groq said 429 with retry-after: nothing goes out before then. */
  blockFor(ms: number): void {
    this.blockedUntil = Math.max(this.blockedUntil, this.now() + Math.max(0, ms));
  }

  snapshot(): BudgetSnapshot {
    this.trim();
    const now = this.now();
    const within = (span: number) => this.entries.filter((entry) => entry.at > now - span);
    const sum = (items: UsageEntry[]) => items.reduce((total, entry) => total + entry.billedSeconds, 0);
    return {
      requestsLastMinute: within(MINUTE).length,
      requestsToday: within(DAY).length,
      audioSecondsLastHour: sum(within(HOUR)),
      audioSecondsToday: sum(within(DAY)),
      limits: GROQ_LIMITS
    };
  }

  /**
   * How long a retry of this much audio must wait before it fits every window.
   * 0 means send now; Infinity means it can never fit (longer than an hour's budget).
   */
  waitFor(durationMs: number, requests = 1): number {
    this.trim();
    const now = this.now();
    const cost = billedSeconds(durationMs);
    if (cost > GROQ_LIMITS.audioSecondsPerHour) return Number.POSITIVE_INFINITY;
    let wait = Math.max(0, this.blockedUntil - now);
    const rpm = GROQ_LIMITS.requestsPerMinute - GROQ_LIMITS.liveHeadroomPerMinute;
    wait = Math.max(wait, this.waitForCount(MINUTE, rpm - requests + 1));
    wait = Math.max(wait, this.waitForCount(DAY, GROQ_LIMITS.requestsPerDay - requests + 1));
    wait = Math.max(wait, this.waitForSeconds(HOUR, GROQ_LIMITS.audioSecondsPerHour - cost));
    wait = Math.max(wait, this.waitForSeconds(DAY, GROQ_LIMITS.audioSecondsPerDay - cost));
    return wait;
  }

  /** Time until fewer than `allowed` entries remain inside the window. */
  private waitForCount(span: number, allowed: number): number {
    const now = this.now();
    const inside = this.entries.filter((entry) => entry.at > now - span);
    if (inside.length < allowed) return 0;
    const releasing = inside[inside.length - Math.max(1, allowed)];
    return Math.max(0, releasing.at + span - now + 1);
  }

  /** Time until the billed seconds inside the window drop to `allowed` or less. */
  private waitForSeconds(span: number, allowed: number): number {
    const now = this.now();
    const inside = this.entries.filter((entry) => entry.at > now - span);
    let total = inside.reduce((sum, entry) => sum + entry.billedSeconds, 0);
    if (total <= allowed) return 0;
    for (const entry of inside) {
      total -= entry.billedSeconds;
      if (total <= allowed) return Math.max(0, entry.at + span - now + 1);
    }
    return span;
  }

  private trim(): void {
    const cutoff = this.now() - DAY;
    if (this.entries.length && this.entries[0].at <= cutoff) this.entries = this.entries.filter((entry) => entry.at > cutoff);
  }
}

/**
 * Splits a 16-bit PCM WAV into pieces that each fit Groq's upload limit,
 * every piece with its own header. Other formats are returned unchanged.
 */
export function splitWavForUpload(segment: Uint8Array, maxBytes = GROQ_LIMITS.maxUploadBytes - 1024 * 1024): Uint8Array[] {
  if (segment.byteLength <= maxBytes || segment.byteLength < 44) return [segment];
  const view = Buffer.from(segment.buffer, segment.byteOffset, segment.byteLength);
  if (view.toString('ascii', 0, 4) !== 'RIFF' || view.toString('ascii', 8, 12) !== 'WAVE') return [segment];
  const blockAlign = view.readUInt16LE(32) || 2;
  const header = Buffer.from(view.subarray(0, 44));
  const pcm = view.subarray(44);
  const chunk = Math.floor((maxBytes - 44) / blockAlign) * blockAlign;
  const pieces: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.byteLength; offset += chunk) {
    const body = pcm.subarray(offset, Math.min(pcm.byteLength, offset + chunk));
    const piece = Buffer.alloc(44 + body.byteLength);
    header.copy(piece, 0);
    piece.writeUInt32LE(36 + body.byteLength, 4);
    piece.writeUInt32LE(body.byteLength, 40);
    body.copy(piece, 44);
    pieces.push(new Uint8Array(piece.buffer, piece.byteOffset, piece.byteLength));
  }
  return pieces;
}
