import { win32 } from 'node:path';

const { basename, dirname, join, sep } = win32;
import { pickConfident, rankMatches, type Pick, type Ranked } from '../pipeline/fuzzy';

/**
 * Cached directory-name index so "open the projects folder in D drive"
 * resolves without crawling a disk while the person waits. The crawl is
 * breadth-first (shallow folders are indexed first), depth-limited, skips
 * system and dependency folders, and stops at an entry or time budget.
 */

export interface DirEntryLike {
  name: string;
  isDirectory: boolean;
}

export interface PathIndexDeps {
  readdir: (path: string) => Promise<DirEntryLike[]>;
  now?: () => number;
}

export interface IndexEntry {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  drive: string;
}

export interface CrawlOptions {
  maxDepth?: number;
  maxEntries?: number;
  budgetMs?: number;
}

const SKIP_NAMES = new Set([
  'node_modules', '.git', '.svn', '.hg', '.cache', '.gradle', '.m2', '.npm', '.nuget', '__pycache__', 'venv', '.venv',
  'site-packages', '$recycle.bin', 'system volume information', 'windows', 'windows.old', 'programdata',
  'program files', 'program files (x86)', 'appdata', 'recovery', 'perflogs', 'config.msi', '$windows.~bt', 'msocache',
  'dist', 'build', 'out', '.next', '.idea', '.vs', 'target'
]);

export function driveOf(path: string): string {
  const match = /^([A-Za-z]):/.exec(path);
  return match ? match[1].toUpperCase() : '';
}

export class PathIndex {
  private entries: IndexEntry[] = [];
  private lastBuilt = 0;
  private building: Promise<void> | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: PathIndexDeps) {
    this.now = deps.now ?? Date.now;
  }

  get size(): number {
    return this.entries.length;
  }

  get ageMs(): number {
    return this.lastBuilt ? this.now() - this.lastBuilt : Number.POSITIVE_INFINITY;
  }

  /** Rebuilds the index. Concurrent calls share one crawl. */
  refresh(roots: string[], options: CrawlOptions = {}): Promise<void> {
    if (!this.building) {
      this.building = this.crawl(roots, options).finally(() => { this.building = undefined; });
    }
    return this.building;
  }

  private async crawl(roots: string[], options: CrawlOptions): Promise<void> {
    const maxDepth = options.maxDepth ?? 3;
    const maxEntries = options.maxEntries ?? 40_000;
    const deadline = this.now() + (options.budgetMs ?? 2500);
    const found: IndexEntry[] = [];
    let level = roots.map((root) => ({ path: root, depth: 0 }));

    for (let depth = 1; depth <= maxDepth && level.length > 0; depth += 1) {
      const next: Array<{ path: string; depth: number }> = [];
      for (const dir of level) {
        if (this.now() > deadline || found.length >= maxEntries) break;
        let children: DirEntryLike[];
        try {
          children = await this.deps.readdir(dir.path);
        } catch {
          continue;
        }
        for (const child of children) {
          if (!child.isDirectory) continue;
          const lower = child.name.toLowerCase();
          if (SKIP_NAMES.has(lower) || child.name.startsWith('.')) continue;
          const path = join(dir.path, child.name);
          found.push({ path, name: child.name, isDir: true, depth, drive: driveOf(path) });
          next.push({ path, depth });
        }
      }
      level = next;
      if (this.now() > deadline || found.length >= maxEntries) break;
    }
    this.entries = found;
    this.lastBuilt = this.now();
  }

  /** Ranked folder matches for a spoken name, optionally restricted to one drive. */
  find(query: string, options: { drive?: string; minimumScore?: number } = {}): Ranked<IndexEntry>[] {
    const drive = options.drive?.toUpperCase();
    const pool = drive ? this.entries.filter((entry) => entry.drive === drive) : this.entries;
    const ranked = rankMatches(query, pool, (entry) => entry.name, options.minimumScore ?? 0.8);
    // Prefer shallow folders when names tie; people say "projects", not the nested copy of it.
    return ranked.sort((a, b) => b.score - a.score || a.item.depth - b.item.depth || a.item.path.length - b.item.path.length);
  }

  pick(query: string, options: { drive?: string } = {}): Pick<IndexEntry> {
    return pickConfident(this.find(query, options), { minimum: 0.85, margin: 0.05 });
  }

  /** Bounded search of the disk when the cache has no answer (first use, or a folder created a moment ago). */
  async liveSearch(query: string, roots: string[], options: CrawlOptions = {}): Promise<Ranked<IndexEntry>[]> {
    const scratch = new PathIndex(this.deps);
    await scratch.refresh(roots, { maxDepth: options.maxDepth ?? 4, maxEntries: options.maxEntries ?? 20_000, budgetMs: options.budgetMs ?? 1500 });
    return scratch.find(query);
  }
}

export function parentAndName(path: string): { parent: string; name: string } {
  const trimmed = path.endsWith(sep) && path.length > 3 ? path.slice(0, -1) : path;
  return { parent: dirname(trimmed), name: basename(trimmed) };
}

export function isDriveRoot(path: string): boolean {
  return /^[A-Za-z]:[\\/]?$/.test(path.trim());
}
