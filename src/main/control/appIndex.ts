import { win32 } from 'node:path';
import { isBlockedAppName } from './actions';
import { rankMatches, type Ranked } from '../pipeline/fuzzy';

/**
 * Installed programs the person can launch by name. Start Menu shortcuts give
 * the real, user-visible names ("Visual Studio Code"); a small alias table
 * covers built-in tools that have no shortcut ("calculator", "settings").
 * Shells and system editors are filtered out at the source.
 */

export type LaunchTarget =
  | { type: 'file'; value: string }
  | { type: 'exe'; value: string }
  | { type: 'uri'; value: string };

export interface AppEntry {
  name: string;
  launch: LaunchTarget;
}

const NOISE = /\b(?:uninstall|readme|read me|license|licence|documentation|release notes|help|manual|website|web site|changelog|samples?|tutorials?|support|repair|updater?)\b/i;

const BUILT_IN: AppEntry[] = [
  { name: 'Notepad', launch: { type: 'exe', value: 'notepad.exe' } },
  { name: 'Calculator', launch: { type: 'exe', value: 'calc.exe' } },
  { name: 'Paint', launch: { type: 'exe', value: 'mspaint.exe' } },
  { name: 'Task Manager', launch: { type: 'exe', value: 'taskmgr.exe' } },
  { name: 'Snipping Tool', launch: { type: 'exe', value: 'snippingtool.exe' } },
  { name: 'Control Panel', launch: { type: 'exe', value: 'control.exe' } },
  { name: 'File Explorer', launch: { type: 'exe', value: 'explorer.exe' } },
  { name: 'Settings', launch: { type: 'uri', value: 'ms-settings:' } },
  { name: 'Microsoft Store', launch: { type: 'uri', value: 'ms-windows-store:' } },
  { name: 'Calendar', launch: { type: 'uri', value: 'outlookcal:' } },
  { name: 'Mail', launch: { type: 'uri', value: 'outlookmail:' } },
  { name: 'Camera', launch: { type: 'uri', value: 'microsoft.windows.camera:' } },
  { name: 'Clock', launch: { type: 'uri', value: 'ms-clock:' } }
];

const ALIASES: Record<string, string> = {
  'vs code': 'Visual Studio Code', vscode: 'Visual Studio Code', code: 'Visual Studio Code',
  'google chrome': 'Chrome', edge: 'Microsoft Edge', explorer: 'File Explorer', files: 'File Explorer',
  'power point': 'PowerPoint', 'ms word': 'Word', 'ms excel': 'Excel', cmd: '', terminal: ''
};

export function entriesFromShortcuts(shortcutPaths: readonly string[]): AppEntry[] {
  const byName = new Map<string, AppEntry>();
  for (const path of shortcutPaths) {
    if (!/\.lnk$/i.test(path)) continue;
    const name = win32.basename(path).replace(/\.lnk$/i, '').trim();
    if (!name || NOISE.test(name) || isBlockedAppName(name)) continue;
    if (!byName.has(name.toLowerCase())) byName.set(name.toLowerCase(), { name, launch: { type: 'file', value: path } });
  }
  return [...byName.values()];
}

export class AppIndex {
  private entries: AppEntry[] = [...BUILT_IN];

  setShortcuts(shortcutPaths: readonly string[]): void {
    const installed = entriesFromShortcuts(shortcutPaths);
    const names = new Set(installed.map((entry) => entry.name.toLowerCase()));
    this.entries = [...installed, ...BUILT_IN.filter((entry) => !names.has(entry.name.toLowerCase()))];
  }

  get size(): number {
    return this.entries.length;
  }

  find(query: string): Ranked<AppEntry>[] {
    const alias = ALIASES[query.trim().toLowerCase()];
    if (alias === '') return [];
    const effective = alias ?? query;
    return rankMatches(effective, this.entries, (entry) => entry.name, 0.8);
  }
}
