/**
 * Rules for installing a downloaded update on Windows, kept free of Electron so
 * they can be tested. See launchInstaller in updater.ts.
 */

/** After an install that did not happen, Tawny waits this long before closing itself to try again. */
export const RETRY_AFTER_FAILURE_MS = 6 * 60 * 60 * 1000;

/** Smart App Control / WDAC refusals surface from spawn as these codes. */
export function isPolicyBlock(code: string | undefined): boolean {
  return code === 'UNKNOWN' || code === 'EACCES' || code === 'EPERM';
}

export function blockedMessage(version: string, current: string): string {
  return `Windows blocked the Tawny ${version} installer, so you are still on ${current}. Smart App Control only runs unsigned apps it already trusts, and a brand-new release is not trusted yet. Try again later, or download it from the release page.`;
}

/** Whether Tawny may close by itself to install the downloaded update. */
export function shouldAutoInstall(failed: { version: string; at: number } | undefined, version: string | undefined, now = Date.now()): boolean {
  if (!failed || failed.version !== version) return true;
  return now - failed.at > RETRY_AFTER_FAILURE_MS;
}
