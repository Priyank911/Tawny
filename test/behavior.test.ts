import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_BEHAVIOR, readBehavior, writeBehavior } from '../src/main/behavior';

describe('behavior settings', () => {
  it('defaults to everything that listens or uploads screenshots being off', () => {
    expect(DEFAULT_BEHAVIOR).toEqual({ handsFree: false, controlStyle: 'visual', visionFallback: false });
  });
  it('round-trips and survives a damaged file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tawny-behavior-'));
    expect(await readBehavior(dir)).toEqual(DEFAULT_BEHAVIOR);
    await writeBehavior(dir, { handsFree: true, controlStyle: 'fast', visionFallback: true });
    expect(await readBehavior(dir)).toEqual({ handsFree: true, controlStyle: 'fast', visionFallback: true });
    await writeFile(join(dir, 'behavior.json'), '{not json');
    expect(await readBehavior(dir)).toEqual(DEFAULT_BEHAVIOR);
    await writeFile(join(dir, 'behavior.json'), JSON.stringify({ handsFree: 'yes' }));
    expect(await readBehavior(dir)).toEqual(DEFAULT_BEHAVIOR);
  });
  it('rejects invalid values instead of storing them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tawny-behavior-'));
    await expect(writeBehavior(dir, { controlStyle: 'turbo' })).rejects.toThrow();
  });
});
