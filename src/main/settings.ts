import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { providerSettingsSchema, type ProviderSettings } from '../shared/contracts';

const settingsPath = () => join(app.getPath('userData'), 'credentials.bin');

function secureStorageAvailable(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text';
}

export async function readProviderSettings(): Promise<ProviderSettings> {
  try {
    const encrypted = await readFile(settingsPath());
    if (!secureStorageAvailable()) return providerSettingsSchema.parse({});
    return providerSettingsSchema.parse(JSON.parse(safeStorage.decryptString(encrypted)));
  } catch {
    return providerSettingsSchema.parse({});
  }
}

export async function saveProviderSettings(input: ProviderSettings): Promise<void> {
  if (!secureStorageAvailable()) {
    throw new Error(process.platform === 'linux'
      ? 'Secure credential storage is unavailable. Install and unlock GNOME Keyring or KDE Wallet.'
      : 'Secure credential storage is unavailable on this device.');
  }
  const parsed = providerSettingsSchema.parse(input);
  const encrypted = safeStorage.encryptString(JSON.stringify(parsed));
  await writeFile(settingsPath(), encrypted, { mode: 0o600 });
}
