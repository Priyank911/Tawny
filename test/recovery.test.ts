import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PipelineError } from '../src/shared/contracts';
import { encodeWav } from '../src/shared/audio/wav';
import { GroqBudget, billedSeconds, splitWavForUpload } from '../src/main/recovery/groqBudget';
import { RecoveryStore, estimateDurationMs, packAudio, unpackAudio, type KeyWrapper } from '../src/main/recovery/recoveryStore';
import { RecoveryService } from '../src/main/recovery/recoveryService';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const fakeKeys: KeyWrapper = {
  available: () => true,
  wrap: (plain) => Buffer.from(`wrapped:${plain}`, 'utf8'),
  unwrap: (wrapped) => wrapped.toString('utf8').replace(/^wrapped:/, '')
};

function tempStore(now?: () => number, keys = fakeKeys) {
  const dir = mkdtempSync(join(tmpdir(), 'tawny-recovery-'));
  dirs.push(dir);
  return { dir, store: new RecoveryStore(dir, keys, now) };
}

const audio = new Uint8Array(Buffer.from('PRIVATE-SPOKEN-AUDIO-'.repeat(50), 'utf8'));

describe('RecoveryStore', () => {
  it('round-trips audio and never writes it in the clear', async () => {
    const { dir, store } = tempStore();
    const saved = await store.save({ source: 'hotkey', mimeType: 'audio/webm', segments: [audio, audio], durationMs: 4000, reason: 'Network down', stage: 'stt' });
    expect(saved).toMatchObject({ status: 'pending', hasAudio: true, attempts: 0, durationMs: 4000 });
    const back = await store.readAudio(saved.id);
    expect(back.mimeType).toBe('audio/webm');
    expect(back.segments).toHaveLength(2);
    expect(Buffer.from(back.segments[1]).equals(Buffer.from(audio))).toBe(true);
    for (const file of readdirSync(dir)) {
      if (file === 'key.bin') continue;
      const raw = readFileSync(join(dir, file)).toString('utf8');
      expect(raw).not.toContain('PRIVATE-SPOKEN');
      expect(raw).not.toContain('Network down');
    }
    // A fresh instance (app restart) reads the same index with the wrapped key.
    const reopened = new RecoveryStore(dir, fakeKeys);
    expect((await reopened.list()).map((item) => item.id)).toEqual([saved.id]);
  });

  it('keeps only the text once a transcript exists', async () => {
    const { dir, store } = tempStore();
    const saved = await store.save({ source: 'wake', mimeType: 'audio/wav', segments: [audio], reason: 'Cloudflare down', stage: 'decide', transcript: 'open whatsapp' });
    expect(saved).toMatchObject({ status: 'transcribed', hasAudio: false, transcript: 'open whatsapp' });
    expect(readdirSync(dir).filter((file) => file.startsWith(saved.id))).toEqual([]);
  });

  it('prunes by age and count', async () => {
    let now = Date.parse('2026-11-01T00:00:00Z');
    const { store } = tempStore(() => now);
    const old = await store.save({ source: 'hotkey', mimeType: 'audio/webm', segments: [audio], reason: 'x', stage: 'stt' });
    now += 8 * 24 * 60 * 60 * 1000;
    const fresh = await store.save({ source: 'hotkey', mimeType: 'audio/webm', segments: [audio], reason: 'y', stage: 'stt' });
    expect((await store.list()).map((item) => item.id)).toEqual([fresh.id]);
    expect((await store.list()).some((item) => item.id === old.id)).toBe(false);
    for (let i = 0; i < 32; i++) {
      now += 1000;
      await store.save({ source: 'hotkey', mimeType: 'audio/webm', segments: [audio], reason: String(i), stage: 'stt' });
    }
    expect(await store.list()).toHaveLength(30);
  });

  it('refuses to keep anything without secure storage', async () => {
    const { store } = tempStore(undefined, { ...fakeKeys, available: () => false });
    await expect(store.save({ source: 'hotkey', mimeType: 'audio/webm', segments: [audio], reason: 'x', stage: 'stt' })).rejects.toThrow(/Secure storage/);
  });

  it('packs and estimates durations', () => {
    const packed = packAudio('audio/wav', [audio]);
    expect(unpackAudio(packed).segments[0].byteLength).toBe(audio.byteLength);
    const wav = encodeWav(new Int16Array(16_000 * 3));
    expect(estimateDurationMs('audio/wav', [wav])).toBe(3000);
  });
});

describe('GroqBudget', () => {
  it('bills at least 10 seconds per request', () => {
    expect(billedSeconds(2000)).toBe(10);
    expect(billedSeconds(42_100)).toBe(43);
  });

  it('leaves live headroom in the per-minute request limit', () => {
    let now = 0;
    const budget = new GroqBudget(() => now);
    for (let i = 0; i < 16; i++) budget.note(1000);
    expect(budget.waitFor(1000)).toBeGreaterThan(0);
    now = 60_001;
    expect(budget.waitFor(1000)).toBe(0);
  });

  it('waits for the hourly audio window and honours retry-after', () => {
    let now = 0;
    const budget = new GroqBudget(() => now);
    budget.note(7100 * 1000);
    const wait = budget.waitFor(200 * 1000);
    expect(wait).toBeGreaterThan(59 * 60_000);
    expect(budget.waitFor(8000 * 1000)).toBe(Number.POSITIVE_INFINITY);
    now = 3_600_001;
    expect(budget.waitFor(200 * 1000)).toBe(0);
    budget.blockFor(30_000);
    expect(budget.waitFor(1000)).toBe(30_000);
  });

  it('splits oversized WAV into valid pieces under the upload limit', () => {
    const wav = encodeWav(new Int16Array(16_000 * 10));
    const pieces = splitWavForUpload(wav, 100_000);
    expect(pieces.length).toBe(4);
    for (const piece of pieces) {
      const view = Buffer.from(piece);
      expect(view.toString('ascii', 0, 4)).toBe('RIFF');
      expect(view.readUInt32LE(40)).toBe(piece.byteLength - 44);
      expect(piece.byteLength).toBeLessThanOrEqual(100_000);
    }
    expect(splitWavForUpload(new Uint8Array(10), 5)).toHaveLength(1);
  });
});

describe('RecoveryService', () => {
  it('transcribes again, keeps the text and destroys the audio', async () => {
    const { dir, store } = tempStore();
    const sent: number[] = [];
    const service = new RecoveryService({ store, budget: new GroqBudget(), transcribe: async (segments) => { sent.push(segments.length); return ' hello there '; }, sleep: async () => undefined });
    expect(await service.keep({ source: 'hotkey', mimeType: 'audio/webm', segments: [audio], reason: 'offline', stage: 'stt' })).toBe(true);
    const [item] = (await service.state()).recordings;
    await service.retry(item.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [done] = (await service.state()).recordings;
    expect(done).toMatchObject({ status: 'transcribed', transcript: 'hello there', hasAudio: false, attempts: 1 });
    expect(sent).toEqual([1]);
    expect(readdirSync(dir).filter((file) => file.startsWith(item.id))).toEqual([]);
  });

  it('marks a rate-limited retry as waiting with the time Groq asked for', async () => {
    const { store } = tempStore();
    const budget = new GroqBudget();
    const service = new RecoveryService({ store, budget, transcribe: async () => { throw new PipelineError('transient', 'stt', 'Groq rate limit reached.', 120_000); }, sleep: async () => undefined });
    await service.keep({ source: 'wake', mimeType: 'audio/wav', segments: [audio], durationMs: 3000, reason: 'offline', stage: 'stt' });
    await service.retry();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const [item] = (await service.state()).recordings;
    expect(item).toMatchObject({ status: 'waiting', hasAudio: true, attempts: 1 });
    expect(item.retryAfter).toBeDefined();
    expect(budget.waitFor(1000)).toBeGreaterThan(100_000);
  });
});
