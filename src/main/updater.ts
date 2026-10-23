import { app } from 'electron';
import { autoUpdater, type AppUpdater } from 'electron-updater';
import { logPipeline } from './logger';
import type { UpdateNotice } from '../shared/contracts';

const RELEASES_URL = 'https://github.com/Priyank911/Tawny/releases';
const RELEASES_API = 'https://api.github.com/repos/Priyank911/Tawny/releases?per_page=20';
const listeners = new Set<(notice: UpdateNotice) => void>();
let started = false;
let updaterInstance: AppUpdater | undefined;

function emit(notice: UpdateNotice): void {
  for (const listener of listeners) listener(notice);
}

export function onUpdateAvailable(listener: (notice: UpdateNotice) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function openLatestReleasePage(): Promise<void> {
  const { shell } = await import('electron');
  await shell.openExternal(RELEASES_URL);
}

function compareVersions(left: string, right: string): number {
  const parse = (value: string) => {
    const [version] = value.replace(/^v/, '').split('+', 1);
    const [core, prerelease] = version.split('-', 2);
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), prerelease: prerelease?.split('.') };
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const diff = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (diff !== 0) return diff;
  }
  if (!a.prerelease && !b.prerelease) return 0;
  if (!a.prerelease) return 1;
  if (!b.prerelease) return -1;
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index += 1) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined) return -1;
    if (rightPart === undefined) return 1;
    if (leftPart === rightPart) continue;
    const leftNumber = /^\d+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^\d+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber - rightNumber;
    if (leftNumber !== undefined) return -1;
    if (rightNumber !== undefined) return 1;
    return leftPart.localeCompare(rightPart);
  }
  return 0;
}

async function checkManualRelease(): Promise<void> {
  try {
    const response = await fetch(RELEASES_API, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Tawny-Early-Preview' },
      signal: AbortSignal.timeout(8_000)
    });
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}.`);
    const releases: unknown = await response.json();
    if (!Array.isArray(releases)) throw new Error('GitHub returned an invalid release list.');
    const currentRelease = releases.find((release) => release && typeof release === 'object'
      && (release as Record<string, unknown>).prerelease === true
      && typeof (release as Record<string, unknown>).tag_name === 'string'
      && compareVersions(String((release as Record<string, unknown>).tag_name), app.getVersion()) > 0) as Record<string, unknown> | undefined;
    if (!currentRelease) return;
    const version = String(currentRelease.tag_name).replace(/^v/, '');
    const notice = {
      state: 'manual' as const,
      version,
      message: `Early preview ${version} is available. Download it from GitHub Releases and follow the install note for your operating system.`
    };
    logPipeline({ event: 'update.available.manual', message: `A manual update is available for ${process.platform}.`, data: { version, platform: process.platform } });
    emit(notice);
  } catch {
    logPipeline({ level: 'warn', event: 'update.check.failure', message: 'Could not check GitHub Releases for updates.' });
  }
}

export async function initializeUpdateService(): Promise<AppUpdater | undefined> {
  if (started) return updaterInstance;
  started = true;
  if (!app.isPackaged) return undefined;

  if (process.platform === 'darwin' || (process.platform === 'linux' && !process.env.APPIMAGE)) {
    await checkManualRelease();
    const timer = setInterval(() => { void checkManualRelease(); }, 6 * 60 * 60 * 1000);
    timer.unref();
    return undefined;
  }

  updaterInstance = autoUpdater;
  autoUpdater.allowPrerelease = true;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => {
    logPipeline({ event: 'update.check.start', message: 'Checking GitHub Releases for an early-preview update.' });
  });
  autoUpdater.on('update-available', (info) => {
    const version = info.version;
    logPipeline({ event: 'update.available', message: `Early preview ${version} is available and will download in the background.` });
    emit({ state: 'available', version, message: `Early preview ${version} is available. Downloading in the background.` });
  });
  autoUpdater.on('download-progress', (progress) => {
    emit({ state: 'downloading', message: `Downloading update: ${Math.round(progress.percent)}%.` });
  });
  autoUpdater.on('update-downloaded', (info) => {
    logPipeline({ event: 'update.downloaded', message: `Early preview ${info.version} downloaded and will install when Tawny closes.` });
    emit({ state: 'ready', version: info.version, message: `Early preview ${info.version} is ready. Close Tawny to install it.` });
  });
  autoUpdater.on('update-not-available', () => {
    logPipeline({ event: 'update.current', message: 'Tawny is using the latest early-preview release.' });
  });
  autoUpdater.on('error', () => {
    logPipeline({ level: 'warn', event: 'update.check.failure', message: 'The automatic update could not be completed.' });
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch {
    logPipeline({ level: 'warn', event: 'update.check.failure', message: 'The automatic update check could not reach GitHub Releases.' });
  }
  const timer = setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => undefined);
  }, 6 * 60 * 60 * 1000);
  timer.unref();
  return autoUpdater;
}
