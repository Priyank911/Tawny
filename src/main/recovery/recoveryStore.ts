import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CaptureSource, RecoveryRecording } from '../../shared/contracts';

/**
 * Keeps the audio of failed requests so they can be transcribed again later.
 * Everything on disk is AES-256-GCM encrypted with a random key that is itself
 * wrapped by the OS (safeStorage / DPAPI), and Tawny has no playback UI: the
 * audio exists only to be re-sent to Groq. Audio is deleted as soon as a
 * transcription succeeds; only the text is kept.
 */

export interface KeyWrapper {
  available(): boolean;
  wrap(plain: string): Buffer;
  unwrap(wrapped: Buffer): string;
}

export interface SaveInput {
  source: CaptureSource;
  mimeType: string;
  segments: readonly Uint8Array[];
  durationMs?: number;
  reason: string;
  stage: string;
  transcript?: string;
}

export interface StoredAudio {
  mimeType: string;
  segments: Uint8Array[];
}

export const RECOVERY_LIMITS = {
  maxAgeMs: 7 * 24 * 60 * 60 * 1000,
  maxCount: 30,
  maxBytes: 200 * 1024 * 1024
};

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function seal(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function open(key: Buffer, sealed: Buffer): Buffer {
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(sealed.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}

/** [4-byte header length][header JSON][segment bytes...] */
export function packAudio(mimeType: string, segments: readonly Uint8Array[]): Buffer {
  const header = Buffer.from(JSON.stringify({ mimeType, lengths: segments.map((segment) => segment.byteLength) }), 'utf8');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(header.byteLength, 0);
  return Buffer.concat([size, header, ...segments.map((segment) => Buffer.from(segment.buffer, segment.byteOffset, segment.byteLength))]);
}

export function unpackAudio(packed: Buffer): StoredAudio {
  const headerLength = packed.readUInt32LE(0);
  const header = JSON.parse(packed.subarray(4, 4 + headerLength).toString('utf8')) as { mimeType: string; lengths: number[] };
  let offset = 4 + headerLength;
  const segments = header.lengths.map((length) => {
    const segment = new Uint8Array(packed.subarray(offset, offset + length));
    offset += length;
    return segment;
  });
  return { mimeType: header.mimeType, segments };
}

/** Rough duration when the capture did not report one: Opus WebM at ~32 kbit/s, WAV from its header. */
export function estimateDurationMs(mimeType: string, segments: readonly Uint8Array[]): number {
  const bytes = segments.reduce((total, segment) => total + segment.byteLength, 0);
  if (mimeType.includes('wav')) {
    let total = 0;
    for (const segment of segments) {
      const byteRate = segment.byteLength >= 44 ? Buffer.from(segment.buffer, segment.byteOffset, segment.byteLength).readUInt32LE(28) : 0;
      total += byteRate > 0 ? ((segment.byteLength - 44) / byteRate) * 1000 : 0;
    }
    return Math.round(total);
  }
  return Math.round((bytes / 4000) * 1000);
}

export class RecoveryStore {
  private key: Buffer | undefined;
  private index: RecoveryRecording[] | undefined;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string, private readonly keys: KeyWrapper, private readonly now: () => number = Date.now) {}

  get available(): boolean {
    return this.keys.available();
  }

  private async getKey(): Promise<Buffer> {
    if (this.key) return this.key;
    if (!this.keys.available()) throw new Error('Secure storage is unavailable, so recordings cannot be kept on this device.');
    await mkdir(this.dir, { recursive: true });
    const keyPath = join(this.dir, 'key.bin');
    try {
      this.key = Buffer.from(this.keys.unwrap(await readFile(keyPath)), 'base64');
    } catch {
      // No key yet (or it can no longer be unwrapped, e.g. a different Windows user): start a fresh store.
      this.key = randomBytes(32);
      this.index = [];
      await writeFile(keyPath, this.keys.wrap(this.key.toString('base64')), { mode: 0o600 });
      await this.persist();
    }
    if (this.key.byteLength !== 32) throw new Error('The recordings key is damaged.');
    return this.key;
  }

  private async load(): Promise<RecoveryRecording[]> {
    if (this.index) return this.index;
    const key = await this.getKey();
    if (this.index) return this.index;
    try {
      this.index = JSON.parse(open(key, await readFile(join(this.dir, 'index.bin'))).toString('utf8')) as RecoveryRecording[];
    } catch {
      this.index = [];
    }
    return this.index;
  }

  private persist(): Promise<void> {
    const run = async (): Promise<void> => {
      const key = await this.getKey();
      await writeFile(join(this.dir, 'index.bin'), seal(key, Buffer.from(JSON.stringify(this.index ?? []), 'utf8')), { mode: 0o600 });
    };
    this.writing = this.writing.then(run, run);
    return this.writing;
  }

  async list(): Promise<RecoveryRecording[]> {
    await this.prune();
    return [...(await this.load())].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async save(input: SaveInput): Promise<RecoveryRecording> {
    const key = await this.getKey();
    const index = await this.load();
    const id = randomUUID();
    const packed = packAudio(input.mimeType, input.segments);
    const hasTranscript = Boolean(input.transcript?.trim());
    if (!hasTranscript) await writeFile(join(this.dir, `${id}.bin`), seal(key, packed), { mode: 0o600 });
    const recording: RecoveryRecording = {
      id,
      createdAt: new Date(this.now()).toISOString(),
      source: input.source,
      mimeType: input.mimeType,
      bytes: packed.byteLength,
      durationMs: Math.max(0, Math.round(input.durationMs ?? estimateDurationMs(input.mimeType, input.segments))),
      reason: input.reason.slice(0, 400),
      stage: input.stage,
      status: hasTranscript ? 'transcribed' : 'pending',
      attempts: 0,
      hasAudio: !hasTranscript,
      ...(hasTranscript ? { transcript: input.transcript!.trim() } : {})
    };
    index.push(recording);
    await this.persist();
    await this.prune();
    return recording;
  }

  async get(id: string): Promise<RecoveryRecording | undefined> {
    return (await this.load()).find((item) => item.id === id);
  }

  async readAudio(id: string): Promise<StoredAudio> {
    const key = await this.getKey();
    return unpackAudio(open(key, await readFile(join(this.dir, `${id}.bin`))));
  }

  async update(id: string, patch: Partial<Omit<RecoveryRecording, 'id' | 'createdAt'>>): Promise<RecoveryRecording | undefined> {
    const index = await this.load();
    const item = index.find((entry) => entry.id === id);
    if (!item) return undefined;
    Object.assign(item, patch);
    if (patch.retryAfter === undefined && 'retryAfter' in patch) delete item.retryAfter;
    await this.persist();
    return item;
  }

  /** A transcription succeeded: keep the text, destroy the audio. */
  async complete(id: string, transcript: string, attempts?: number): Promise<RecoveryRecording | undefined> {
    await rm(join(this.dir, `${id}.bin`), { force: true });
    const index = await this.load();
    const item = index.find((entry) => entry.id === id);
    if (!item) return undefined;
    item.status = 'transcribed';
    item.transcript = transcript;
    item.hasAudio = false;
    if (attempts !== undefined) item.attempts = attempts;
    delete item.retryAfter;
    delete item.lastError;
    await this.persist();
    return item;
  }

  async remove(id: string): Promise<void> {
    const index = await this.load();
    this.index = index.filter((item) => item.id !== id);
    await rm(join(this.dir, `${id}.bin`), { force: true });
    await this.persist();
  }

  async clear(): Promise<void> {
    const index = await this.load();
    await Promise.all(index.map((item) => rm(join(this.dir, `${item.id}.bin`), { force: true })));
    this.index = [];
    await this.persist();
  }

  /** Oldest first: anything past the age limit, then down to the count and size limits. */
  async prune(): Promise<void> {
    if (!this.keys.available()) return;
    const index = await this.load();
    const cutoff = this.now() - RECOVERY_LIMITS.maxAgeMs;
    const sorted = [...index].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const drop = new Set<string>();
    for (const item of sorted) if (Date.parse(item.createdAt) < cutoff) drop.add(item.id);
    const kept = sorted.filter((item) => !drop.has(item.id));
    let bytes = kept.reduce((total, item) => total + (item.hasAudio ? item.bytes : 0), 0);
    while (kept.length > RECOVERY_LIMITS.maxCount || bytes > RECOVERY_LIMITS.maxBytes) {
      const oldest = kept.shift()!;
      drop.add(oldest.id);
      bytes -= oldest.hasAudio ? oldest.bytes : 0;
    }
    if (drop.size === 0) return;
    await Promise.all([...drop].map((id) => rm(join(this.dir, `${id}.bin`), { force: true })));
    this.index = index.filter((item) => !drop.has(item.id));
    await this.persist();
  }
}
