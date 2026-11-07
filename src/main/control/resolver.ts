import { win32 } from 'node:path';
import { pickConfident, rankMatches, scoreMatch, normalizeName } from '../pipeline/fuzzy';
import type { AppEntry, AppIndex, LaunchTarget } from './appIndex';
import { driveOf, type IndexEntry, type PathIndex } from './pathIndex';

/**
 * Turns a spoken target ("downloads", "projects in D drive", "chrome",
 * "youtube") into one concrete thing to open. The order matters: an explicit
 * drive restricts the search to that drive; folders the person names with a
 * known alias win over guesses; a running window is focused instead of
 * launching a second copy; the folder index is last because it is the
 * broadest and the most likely to be ambiguous.
 */

export type KnownFolderKey = 'desktop' | 'downloads' | 'documents' | 'pictures' | 'music' | 'videos' | 'home';

export interface DriveLike {
  letter: string;
  label: string;
  ready: boolean;
  type: string;
}

export interface WindowLike {
  hwnd: string;
  title: string;
  exe: string;
}

export interface ResolverDeps {
  knownFolders: () => Partial<Record<KnownFolderKey, string>>;
  drives: () => Promise<DriveLike[]>;
  windows: () => Promise<WindowLike[]>;
  apps: AppIndex;
  paths: PathIndex;
  indexRoots: () => Promise<string[]>;
  exists: (path: string) => Promise<'dir' | 'file' | false>;
  listFiles: (dir: string) => Promise<string[]>;
}

export type Resolution =
  | { kind: 'path'; path: string; display: string; isDir: boolean; alternatives?: string[]; ambiguous?: boolean }
  | { kind: 'thispc'; display: string }
  | { kind: 'special'; shell: string; display: string }
  | { kind: 'app'; launch: LaunchTarget; display: string }
  | { kind: 'window'; hwnd: string; display: string }
  | { kind: 'url'; url: string; display: string }
  | { kind: 'none'; reason: string };

const FOLDER_ALIASES: Array<{ key: KnownFolderKey; names: string[] }> = [
  { key: 'desktop', names: ['desktop'] },
  { key: 'downloads', names: ['downloads', 'download', 'downloaded files'] },
  { key: 'documents', names: ['documents', 'document', 'docs', 'my documents'] },
  { key: 'pictures', names: ['pictures', 'picture', 'photos', 'images', 'my pictures'] },
  { key: 'music', names: ['music', 'songs', 'my music'] },
  { key: 'videos', names: ['videos', 'video', 'movies', 'my videos'] },
  { key: 'home', names: ['home', 'home folder', 'user folder', 'my files'] }
];

const SITES: Record<string, string> = {
  youtube: 'https://www.youtube.com', github: 'https://github.com', gmail: 'https://mail.google.com', google: 'https://www.google.com',
  'google drive': 'https://drive.google.com', 'google maps': 'https://maps.google.com', maps: 'https://maps.google.com',
  'google calendar': 'https://calendar.google.com', chatgpt: 'https://chatgpt.com', claude: 'https://claude.ai',
  linkedin: 'https://www.linkedin.com', twitter: 'https://x.com', x: 'https://x.com', reddit: 'https://www.reddit.com',
  'stack overflow': 'https://stackoverflow.com', netflix: 'https://www.netflix.com', 'whatsapp web': 'https://web.whatsapp.com',
  amazon: 'https://www.amazon.in', wikipedia: 'https://www.wikipedia.org', facebook: 'https://www.facebook.com',
  instagram: 'https://www.instagram.com', spotify: 'https://open.spotify.com', notion: 'https://www.notion.so'
};

const THIS_PC = new Set(['this pc', 'my computer', 'computer', 'my pc', 'this computer', 'pc', 'my laptop', 'this laptop']);
const RECYCLE = new Set(['recycle bin', 'trash', 'recycle']);

export class TargetResolver {
  constructor(private readonly deps: ResolverDeps) {}

  async resolve(request: { target: string; drive?: string; hint?: 'folder' | 'app' | 'site' | 'drive' | 'file' | 'any' }): Promise<Resolution> {
    const target = request.target.trim();
    const hint = request.hint ?? 'any';
    const normalized = normalizeName(target);
    if (!normalized) return { kind: 'none', reason: 'No name was given.' };

    if (THIS_PC.has(normalized)) return { kind: 'thispc', display: 'This PC' };
    if (RECYCLE.has(normalized)) return { kind: 'special', shell: 'shell:RecycleBinFolder', display: 'Recycle Bin' };

    // 1. A drive by letter or by its label.
    if (hint === 'drive' || /^[A-Za-z]:?$/.test(target.trim())) {
      const letter = (request.drive ?? target.trim().replace(':', '')).toUpperCase();
      return this.resolveDrive(letter);
    }
    const labelled = await this.driveByLabel(normalized, hint);
    if (labelled) return labelled;

    // 2. Inside a named drive.
    if (request.drive) return this.resolveInDrive(target, request.drive.toUpperCase(), hint);

    // 3. Known folders.
    if (hint !== 'app' && hint !== 'site') {
      const known = await this.resolveKnownFolder(normalized);
      if (known) return known;
    }

    // 4. Running windows and installed apps.
    if (hint !== 'folder' && hint !== 'site' && hint !== 'file') {
      const app = await this.resolveApp(target);
      if (app) return app;
    }

    // 5. Folders anywhere in the index, then files in the usual places.
    if (hint !== 'app' && hint !== 'site') {
      const folder = await this.resolveIndexed(target, undefined);
      if (folder) return folder;
      const file = await this.resolveFile(target);
      if (file) return file;
    }

    // 6. Websites.
    if (hint !== 'folder' && hint !== 'file') {
      const site = SITES[normalized];
      if (site) return { kind: 'url', url: site, display: target };
    }
    return { kind: 'none', reason: `I couldn't find “${target}”.` };
  }

  private async resolveDrive(letter: string): Promise<Resolution> {
    const drives = await this.deps.drives();
    const drive = drives.find((entry) => entry.letter.toUpperCase() === letter);
    if (!drive) return { kind: 'none', reason: `There is no ${letter}: drive on this PC.` };
    if (!drive.ready) return { kind: 'none', reason: `${letter}: is not ready. Check that the disk is connected.` };
    return { kind: 'path', path: `${letter}:\\`, display: drive.label ? `${drive.label} (${letter}:)` : `${letter}:`, isDir: true };
  }

  private async driveByLabel(normalized: string, hint: string): Promise<Resolution | undefined> {
    if (hint === 'app' || hint === 'site' || hint === 'file') return undefined;
    const drives = (await this.deps.drives()).filter((drive) => drive.label && drive.ready);
    const ranked = rankMatches(normalized, drives, (drive) => drive.label, 0.9);
    const pick = pickConfident(ranked, { minimum: 0.9, margin: 0.05 });
    if (!pick.best || pick.ambiguous) return undefined;
    const drive = pick.best.item;
    return { kind: 'path', path: `${drive.letter.toUpperCase()}:\\`, display: `${drive.label} (${drive.letter.toUpperCase()}:)`, isDir: true };
  }

  private async resolveInDrive(target: string, letter: string, hint: string): Promise<Resolution> {
    const drive = await this.resolveDrive(letter);
    if (drive.kind === 'none') return drive;
    const indexed = await this.resolveIndexed(target, letter);
    if (indexed) return indexed;
    const root = `${letter}:\\`;
    const file = hint === 'folder' ? undefined : await this.resolveFileIn(root, target);
    if (file) return file;
    return { kind: 'none', reason: `I couldn't find “${target}” on ${letter}:.` };
  }

  private async resolveKnownFolder(normalized: string): Promise<Resolution | undefined> {
    const folders = this.deps.knownFolders();
    let best: { key: KnownFolderKey; score: number } | undefined;
    for (const alias of FOLDER_ALIASES) {
      for (const name of alias.names) {
        const score = scoreMatch(normalized, name);
        if (score >= 0.9 && (!best || score > best.score)) best = { key: alias.key, score };
      }
    }
    if (!best) return undefined;
    const path = folders[best.key];
    if (!path || (await this.deps.exists(path)) !== 'dir') return undefined;
    return { kind: 'path', path, display: win32.basename(path) || best.key, isDir: true };
  }

  private async resolveApp(target: string): Promise<Resolution | undefined> {
    const windows = await this.deps.windows().catch(() => [] as WindowLike[]);
    const ranked = rankMatches(target, windows, (window) => window.exe.replace(/\.exe$/i, ''), 0.85);
    const byExe = pickConfident(ranked, { minimum: 0.85, margin: 0.04 });
    if (byExe.best && !byExe.ambiguous) {
      return { kind: 'window', hwnd: byExe.best.item.hwnd, display: byExe.best.item.exe.replace(/\.exe$/i, '') };
    }
    const apps = this.deps.apps.find(target);
    const pick = pickConfident(apps, { minimum: 0.8, margin: 0.04 });
    if (pick.best) {
      const entry: AppEntry = pick.best.item;
      const running = windows.find((window) => scoreMatch(window.exe.replace(/\.exe$/i, ''), entry.name) >= 0.85);
      if (running) return { kind: 'window', hwnd: running.hwnd, display: entry.name };
      return { kind: 'app', launch: entry.launch, display: entry.name };
    }
    return undefined;
  }

  private async resolveIndexed(target: string, drive: string | undefined): Promise<Resolution | undefined> {
    let ranked = this.deps.paths.find(target, { ...(drive ? { drive } : {}), minimumScore: 0.85 });
    if (ranked.length === 0) {
      const roots = (await this.deps.indexRoots()).filter((root) => !drive || driveOf(root) === drive);
      const live = await this.deps.paths.liveSearch(target, roots);
      ranked = live.filter((entry) => entry.score >= 0.85);
    }
    const pick = pickConfident(ranked, { minimum: 0.85, margin: 0.05 });
    if (!pick.best) return undefined;
    const entry: IndexEntry = pick.best.item;
    const alternatives = ranked.slice(1, 4).map((candidate) => candidate.item.path);
    return { kind: 'path', path: entry.path, display: entry.name, isDir: true, ...(pick.ambiguous ? { ambiguous: true, alternatives } : {}) };
  }

  private async resolveFile(target: string): Promise<Resolution | undefined> {
    const folders = this.deps.knownFolders();
    for (const key of ['downloads', 'desktop', 'documents'] as const) {
      const dir = folders[key];
      if (!dir) continue;
      const found = await this.resolveFileIn(dir, target);
      if (found) return found;
    }
    return undefined;
  }

  private async resolveFileIn(dir: string, target: string): Promise<Resolution | undefined> {
    const names = await this.deps.listFiles(dir).catch(() => [] as string[]);
    const ranked = rankMatches(target, names, (name) => name.replace(/\.[A-Za-z0-9]{1,5}$/, ''), 0.88);
    const pick = pickConfident(ranked, { minimum: 0.88, margin: 0.05 });
    if (!pick.best) return undefined;
    const path = win32.join(dir, pick.best.item);
    return { kind: 'path', path, display: pick.best.item, isDir: false, ...(pick.ambiguous ? { ambiguous: true, alternatives: ranked.slice(1, 4).map((candidate) => win32.join(dir, candidate.item)) } : {}) };
  }
}
