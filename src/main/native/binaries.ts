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
