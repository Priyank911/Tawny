import { app } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { autoUpdater, type AppUpdater } from 'electron-updater';
import { logPipeline } from './logger';
import { blockedMessage, isPolicyBlock, shouldAutoInstall } from './updatePolicy';
import type { UpdateNotice } from '../shared/contracts';

const RELEASES_URL = 'https://github.com/Priyank911/Tawny/releases';
const RELEASES_API = 'https://api.github.com/repos/Priyank911/Tawny/releases?per_page=20';
const listeners = new Set<(notice: UpdateNotice) => void>();
let started = false;
let updaterInstance: AppUpdater | undefined;
let downloadedUpdateReady = false;
let lastProgressBucket = -1;
let downloadedFile: string | undefined;
let downloadedVersion: string | undefined;
/** A version whose install did not happen (blocked by Windows, or the installer failed). */
let failedInstall: InstallAttempt | undefined;

/**
 * Written just before the installer is launched. If Tawny starts again still on
 * the old version, the install did not happen, and the app must not quit every
 * minute to retry it (which is what a blocked installer used to cause).
 */
interface InstallAttempt {
  version: string;
  at: number;
  blocked?: boolean;
  reason?: string;
}

const attemptPath = (): string => join(app.getPath('userData'), 'update-attempt.json');

function readAttempt(): InstallAttempt | undefined {
  try {
    const parsed = JSON.parse(readFileSync(attemptPath(), 'utf8')) as InstallAttempt;
    return typeof parsed.version === 'string' && typeof parsed.at === 'number' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeAttempt(attempt: InstallAttempt | undefined): void {
  try {
    if (attempt) writeFileSync(attemptPath(), JSON.stringify(attempt), 'utf8');
    else rmSync(attemptPath(), { force: true });
  } catch {
    // Best effort: without the marker the only cost is one extra automatic attempt.
  }
}

export function canAutoInstallNow(): boolean {
  return shouldAutoInstall(failedInstall, downloadedVersion);
}

/**
 * Starts the downloaded installer and resolves only once Windows has actually
 * created the process. Rejects, and Tawny keeps running, when it is refused.
 */
export function launchInstaller(): Promise<void> {
  const file = downloadedFile;
  const version = downloadedVersion;
  if (!file || !version) return Promise.reject(new Error('The update is not fully downloaded yet. Wait for the download to finish, then try again.'));
  writeAttempt({ version, at: Date.now() });
  return new Promise((resolve, reject) => {
    const fail = (error: NodeJS.ErrnoException): void => {
      const blocked = isPolicyBlock(error.code);
      failedInstall = { version, at: Date.now(), blocked, reason: error.code ?? error.message };
      writeAttempt(failedInstall);
      logPipeline({
        level: 'warn',
        event: blocked ? 'update.install.blocked' : 'update.install.failure',
        message: blocked
          ? `Windows refused to start the ${version} installer (${error.code}); most likely Smart App Control.`
          : `The ${version} installer could not start: ${error.message}`,
        data: { code: error.code ?? '' }
      });
      const notice: UpdateNotice = blocked
        ? { state: 'blocked', version, message: blockedMessage(version, app.getVersion()) }
        : { state: 'error', version, message: `The Tawny ${version} installer could not start. Try again, or download it from the release page.` };
      emit(notice);
      reject(Object.assign(new Error(notice.message), { code: error.code }));
    };
    let child: ChildProcess;
    try {
      // The arguments electron-updater uses for a silent NSIS update that relaunches the app.
      child = spawn(file, ['--updated', '/S', '--force-run'], { detached: true, stdio: 'ignore' });
    } catch (error) {
      fail(error as NodeJS.ErrnoException);
      return;
    }
    child.once('error', fail);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

function emit(notice: UpdateNotice): void {
  for (const listener of listeners) listener(notice);
}

export function onUpdateAvailable(listener: (notice: UpdateNotice) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isDownloadedUpdateReady(): boolean {
  return downloadedUpdateReady;
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
  // Tawny launches the installer itself (launchInstaller) so a refused installer is noticed before it quits.
  autoUpdater.autoInstallOnAppQuit = false;
  const previous = readAttempt();
  if (previous) {
    if (compareVersions(previous.version, app.getVersion()) > 0) {
      failedInstall = previous;
      logPipeline({ level: 'warn', event: 'update.install.incomplete', message: `The ${previous.version} update did not install; still on ${app.getVersion()}.`, data: { version: previous.version, blocked: String(Boolean(previous.blocked)) } });
    } else {
      writeAttempt(undefined);
      logPipeline({ event: 'update.install.success', message: `Updated to ${app.getVersion()}.` });
    }
  }
  autoUpdater.on('checking-for-update', () => {
    logPipeline({ event: 'update.check.start', message: 'Checking GitHub Releases for an early-preview update.' });
  });
  autoUpdater.on('update-available', (info) => {
    downloadedUpdateReady = false;
    lastProgressBucket = -1;
    const version = info.version;
    logPipeline({ event: 'update.available', message: `Early preview ${version} is available and will download in the background.` });
    emit({ state: 'available', version, message: `Early preview ${version} is available. Downloading in the background.` });
  });
  autoUpdater.on('download-progress', (progress) => {
    const bucket = Math.min(100, Math.floor(progress.percent / 5) * 5);
    if (bucket <= lastProgressBucket && progress.percent < 100) return;
    lastProgressBucket = bucket;
    emit({ state: 'downloading', message: `Downloading update: ${Math.round(progress.percent)}%.` });
  });
  autoUpdater.on('update-downloaded', (info) => {
    downloadedUpdateReady = true;
    downloadedFile = info.downloadedFile;
    downloadedVersion = info.version;
    if (!canAutoInstallNow()) {
      // This version could not be installed recently: say so instead of closing Tawny again.
      logPipeline({ event: 'update.downloaded', message: `Early preview ${info.version} downloaded; its last install did not complete, so it waits for Try again.` });
      emit(failedInstall?.blocked
        ? { state: 'blocked', version: info.version, message: blockedMessage(info.version, app.getVersion()) }
        : { state: 'error', version: info.version, message: `Tawny ${info.version} did not install last time. Choose Try again, or download it from the release page.` });
      return;
    }
    logPipeline({ event: 'update.downloaded', message: `Early preview ${info.version} downloaded; Tawny will restart to install it when it is idle.` });
    emit({ state: 'ready', version: info.version, message: `Tawny ${info.version} is ready. Tawny restarts to install it in about a minute, or choose Restart now.` });
  });
  autoUpdater.on('update-not-available', () => {
    downloadedUpdateReady = false;
    logPipeline({ event: 'update.current', message: 'Tawny is using the latest early-preview release.' });
  });
  autoUpdater.on('error', (error: Error) => {
    downloadedUpdateReady = false;
    // The cause is what makes an update failure fixable (offline, GitHub rate limit, a blocked download).
    const detail = (error?.message ?? 'unknown error').split(/\r?\n/)[0].slice(0, 240);
    logPipeline({ level: 'warn', event: 'update.check.failure', message: `The automatic update could not be completed: ${detail}` });
    emit({ state: 'error', message: 'The update could not be downloaded. Tawny will try again later.' });
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
