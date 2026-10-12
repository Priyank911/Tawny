import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerSettingsSchema, type ProviderSettings } from '../shared/contracts';

const settingsPath = () => join(app.getPath('userData'), 'credentials.bin');

export async function readProviderSettings(): Promise<ProviderSettings> {
  try {
    const encrypted = await readFile(settingsPath());
    if (!safeStorage.isEncryptionAvailable()) return providerSettingsSchema.parse({});
    return providerSettingsSchema.parse(JSON.parse(safeStorage.decryptString(encrypted)));
  } catch {
    return providerSettingsSchema.parse({});
  }
}

export async function saveProviderSettings(input: ProviderSettings): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windows secure storage is unavailable.');
  }
  const parsed = providerSettingsSchema.parse(input);
  const encrypted = safeStorage.encryptString(JSON.stringify(parsed));
  await writeFile(settingsPath(), encrypted, { mode: 0o600 });
}
