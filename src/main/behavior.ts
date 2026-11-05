import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { behaviorSettingsSchema, type BehaviorSettings } from '../shared/contracts';

/**
 * Non-secret behavior switches (hands-free, cursor style, vision fallback).
 * API keys stay in the encrypted provider settings; these live in a small
 * JSON file next to the hotkey preference. A missing or damaged file means
 * the safe defaults: everything that listens or sends screenshots is off.
 */

export const DEFAULT_BEHAVIOR: BehaviorSettings = behaviorSettingsSchema.parse({});

export async function readBehavior(directory: string): Promise<BehaviorSettings> {
  try {
    const parsed = behaviorSettingsSchema.safeParse(JSON.parse(await readFile(join(directory, 'behavior.json'), 'utf8')));
    if (parsed.success) return parsed.data;
  } catch {
    // First launch or an unreadable file.
  }
  return DEFAULT_BEHAVIOR;
}

export async function writeBehavior(directory: string, value: unknown): Promise<BehaviorSettings> {
  const settings = behaviorSettingsSchema.parse(value);
  const path = join(directory, 'behavior.json');
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(settings), { mode: 0o600 });
  await rename(temporaryPath, path);
  return settings;
}
