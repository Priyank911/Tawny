import { existsSync } from 'node:fs';
import { join } from 'node:path';

export type NativeName = 'tawny-control.exe' | 'tawny-wake.exe';

/**
 * Locates a compiled Windows helper. Packaged builds ship them in
 * resources/native; development builds use build/native (pnpm build:native).
 * Nothing is ever compiled at runtime. A missing helper returns undefined so
 * the caller can tell the person exactly what is wrong.
 */
export function nativeBinaryCandidates(name: NativeName, resourcesPath: string | undefined, appPath: string): string[] {
  const paths: string[] = [];
  if (resourcesPath) paths.push(join(resourcesPath, 'native', name));
  paths.push(join(appPath, 'build', 'native', name));
  return paths;
}

export function resolveNativeBinary(name: NativeName, resourcesPath: string | undefined, appPath: string, exists: (path: string) => boolean = existsSync): string | undefined {
  return nativeBinaryCandidates(name, resourcesPath, appPath).find((path) => exists(path));
}

/**
 * Explains a helper that failed to start. Windows Smart App Control (or a WDAC
 * policy) refuses unsigned programs it does not recognise; Node reports that as
 * "spawn UNKNOWN" or EACCES, which means nothing to the person reading it.
 */
export function describeHelperStartError(helper: string, error: Error & { code?: string }): string {
  if (error.code === 'UNKNOWN' || error.code === 'EACCES' || error.code === 'EPERM') {
    return `Windows blocked ${helper} from starting (often Smart App Control, which blocks unsigned programs). Check Windows Security > App & browser control, then restart Tawny.`;
  }
  if (error.code === 'ENOENT') return `${helper} is missing from this install. Reinstall Tawny to restore it.`;
  return `${helper} could not start (${error.message}).`;
}
