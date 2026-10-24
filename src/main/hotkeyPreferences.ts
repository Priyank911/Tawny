import { app } from 'electron';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_GLOBAL_SHORTCUT, normalizeGlobalShortcut } from './hotkeyConfig';

const shortcutPath = () => join(app.getPath('userData'), 'hotkey.json');

export async function readGlobalShortcut(): Promise<string> {
  try {
    const parsed: unknown = JSON.parse(await readFile(shortcutPath(), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'accelerator' in parsed && typeof parsed.accelerator === 'string') {
      return normalizeGlobalShortcut(parsed.accelerator) ?? DEFAULT_GLOBAL_SHORTCUT;
    }
  } catch {
    // First launch or an unreadable preference uses the built-in shortcut.
  }
  return DEFAULT_GLOBAL_SHORTCUT;
}

export async function writeGlobalShortcut(accelerator: string): Promise<void> {
  const normalized = normalizeGlobalShortcut(accelerator);
  if (!normalized) throw new Error('Choose a shortcut with at least one modifier and one key.');
  const path = shortcutPath();
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify({ accelerator: normalized }), { mode: 0o600 });
  await rename(temporaryPath, path);
}
