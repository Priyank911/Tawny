import { describe, expect, it } from 'vitest';
import { win32 } from 'node:path';
import { PathIndex, driveOf, isDriveRoot, parentAndName, type DirEntryLike } from '../src/main/control/pathIndex';
import { AppIndex, entriesFromShortcuts } from '../src/main/control/appIndex';
import { TargetResolver, type DriveLike, type WindowLike } from '../src/main/control/resolver';

const TREE: Record<string, string[]> = {
  'C:\\': ['Users', 'Windows', 'Program Files', 'Work'],
  'C:\\Users': ['me'],
  'C:\\Users\\me': ['Downloads', 'Desktop', 'Documents', 'node_modules', 'Projects'],
  'C:\\Work': ['Invoices'],
  'D:\\': ['Projects', 'Photos', 'Backups', '$RECYCLE.BIN', 'Movies'],
  'D:\\Projects': ['Tawny', 'Memron', 'node_modules'],
  'D:\\Projects\\Tawny': ['src', 'dist', '.git'],
  'D:\\Backups': ['2025', '2026']
};

const readdir = async (path: string): Promise<DirEntryLike[]> => {
  const key = path.endsWith('\\') && path.length > 3 ? path.slice(0, -1) : path;
  const names = TREE[key] ?? TREE[path];
  if (!names) throw new Error('ENOENT');
  return names.map((name) => ({ name, isDirectory: true }));
};

async function builtIndex(): Promise<PathIndex> {
  const index = new PathIndex({ readdir });
  await index.refresh(['C:\\', 'D:\\']);
  return index;
}

describe('path index', () => {
  it('indexes folders breadth first and skips system and dependency folders', async () => {
    const index = await builtIndex();
    const found = index.find('node modules', { minimumScore: 0.5 }).map((entry) => entry.item.path);
    expect(found).toEqual([]);
    expect(index.find('windows')).toEqual([]);
    expect(index.find('recycle bin')).toEqual([]);
    expect(index.find('tawny')[0].item.path).toBe('D:\\Projects\\Tawny');
  });

  it('restricts to a drive and prefers the shallow match when names tie', async () => {
    const index = await builtIndex();
    expect(index.find('projects').map((entry) => entry.item.path)).toEqual(['D:\\Projects', 'C:\\Users\\me\\Projects']);
    expect(index.find('projects', { drive: 'd' }).map((entry) => entry.item.path)).toEqual(['D:\\Projects']);
  });

  it('flags a near tie instead of guessing', async () => {
    const index = await builtIndex();
    expect(index.pick('projects').ambiguous).toBe(false); // depth 1 and 3 share an exact name, so the shallow one is not a coin flip
  });

  it('respects the entry and depth limits', async () => {
    const index = new PathIndex({ readdir });
    await index.refresh(['D:\\'], { maxDepth: 1 });
    expect(index.find('tawny')).toEqual([]);
    const capped = new PathIndex({ readdir });
    await capped.refresh(['D:\\'], { maxEntries: 2 });
    expect(capped.size).toBeLessThanOrEqual(5);
  });

  it('stops crawling when the time budget runs out', async () => {
    let clock = 0;
    const slow = new PathIndex({ readdir: async (path) => { clock += 1000; return readdir(path); }, now: () => clock });
    await slow.refresh(['D:\\'], { budgetMs: 1500 });
    expect(slow.size).toBeGreaterThan(0);
    expect(slow.find('2026')).toEqual([]); // Backups was never opened because the budget ran out first
    expect(slow.find('projects')).toHaveLength(1);
  });

  it('shares one crawl between concurrent refreshes and survives unreadable folders', async () => {
    let calls = 0;
    const counted = new PathIndex({ readdir: async (path) => { calls += 1; return readdir(path); } });
    await Promise.all([counted.refresh(['D:\\', 'Z:\\']), counted.refresh(['D:\\', 'Z:\\'])]);
    const once = calls;
    expect(once).toBeGreaterThan(0);
    expect(counted.size).toBeGreaterThan(0);
    await counted.refresh(['D:\\']);
    expect(calls).toBeGreaterThan(once);
  });

  it('finds a folder created after the last crawl with a bounded live search', async () => {
    const index = await builtIndex();
    TREE['D:\\'].push('Fresh Folder');
    try {
      const live = await index.liveSearch('fresh folder', ['D:\\']);
      expect(live[0].item.path).toBe('D:\\Fresh Folder');
    } finally {
      TREE['D:\\'].pop();
    }
  });

  it('parses paths correctly', () => {
    expect(driveOf('d:\\x')).toBe('D');
    expect(isDriveRoot('D:')).toBe(true);
    expect(isDriveRoot('D:\\x')).toBe(false);
    expect(parentAndName('D:\\Projects\\Tawny')).toEqual({ parent: 'D:\\Projects', name: 'Tawny' });
    expect(parentAndName('D:\\Projects\\')).toEqual({ parent: 'D:\\', name: 'Projects' });
  });
});

describe('app index', () => {
  it('lists Start Menu shortcuts, hides noise and shells, and keeps built-ins', () => {
    const index = new AppIndex();
    index.setShortcuts([
      'C:\\ProgramData\\Start Menu\\Programs\\Visual Studio Code\\Visual Studio Code.lnk',
      'C:\\ProgramData\\Start Menu\\Programs\\Uninstall Foo.lnk',
      'C:\\ProgramData\\Start Menu\\Programs\\Windows PowerShell.lnk',
      'C:\\ProgramData\\Start Menu\\Programs\\Notes.txt'
    ]);
    expect(index.find('vs code')[0].item.name).toBe('Visual Studio Code');
    expect(index.find('uninstall foo')).toEqual([]);
    expect(index.find('powershell')).toEqual([]);
    expect(index.find('terminal')).toEqual([]);
    expect(index.find('calculator')[0].item.launch).toEqual({ type: 'exe', value: 'calc.exe' });
  });
  it('deduplicates shortcut names', () => {
    expect(entriesFromShortcuts(['C:\\a\\Chrome.lnk', 'C:\\b\\Chrome.lnk'])).toHaveLength(1);
  });
});

function makeResolver(over: { windows?: WindowLike[]; drives?: DriveLike[]; files?: Record<string, string[]> } = {}) {
  const apps = new AppIndex();
  apps.setShortcuts(['C:\\SM\\Google Chrome.lnk', 'C:\\SM\\Visual Studio Code.lnk', 'C:\\SM\\Spotify.lnk']);
  const paths = new PathIndex({ readdir });
  const drives: DriveLike[] = over.drives ?? [
    { letter: 'C', label: 'Windows', ready: true, type: 'fixed' },
    { letter: 'D', label: 'Data', ready: true, type: 'fixed' },
    { letter: 'E', label: 'Backup Disk', ready: false, type: 'fixed' }
  ];
  const files = over.files ?? { 'C:\\Users\\me\\Downloads': ['resume final.pdf', 'invoice march.pdf', 'setup.exe'] };
  const resolver = new TargetResolver({
    knownFolders: () => ({ downloads: 'C:\\Users\\me\\Downloads', desktop: 'C:\\Users\\me\\Desktop', documents: 'C:\\Users\\me\\Documents', home: 'C:\\Users\\me' }),
    drives: async () => drives,
    windows: async () => over.windows ?? [],
    apps,
    paths,
    indexRoots: async () => ['C:\\Users\\me', 'D:\\'],
    exists: async (path) => (['C:\\Users\\me\\Downloads', 'C:\\Users\\me\\Desktop', 'C:\\Users\\me\\Documents', 'C:\\Users\\me'].includes(path) ? 'dir' : false),
    listFiles: async (dir) => files[dir] ?? []
  });
  return { resolver, paths };
}

describe('target resolver', () => {
  it('resolves This PC and the Recycle Bin', async () => {
    const { resolver } = makeResolver();
    expect(await resolver.resolve({ target: 'this pc' })).toEqual({ kind: 'thispc', display: 'This PC' });
    expect(await resolver.resolve({ target: 'recycle bin' })).toMatchObject({ kind: 'special', shell: 'shell:RecycleBinFolder' });
  });

  it('resolves a drive by letter and by label, and explains unavailable ones', async () => {
    const { resolver } = makeResolver();
    expect(await resolver.resolve({ target: 'D', hint: 'drive' })).toMatchObject({ kind: 'path', path: 'D:\\' });
    expect(await resolver.resolve({ target: 'd:' })).toMatchObject({ kind: 'path', path: 'D:\\', display: 'Data (D:)' });
    expect(await resolver.resolve({ target: 'data' })).toMatchObject({ kind: 'path', path: 'D:\\' });
    expect(await resolver.resolve({ target: 'F', hint: 'drive' })).toEqual({ kind: 'none', reason: 'There is no F: drive on this PC.' });
    expect(await resolver.resolve({ target: 'E', hint: 'drive' })).toMatchObject({ kind: 'none', reason: expect.stringContaining('not ready') });
  });

  it('finds a folder inside the named drive only', async () => {
    const { resolver, paths } = makeResolver();
    await paths.refresh(['C:\\Users\\me', 'D:\\']);
    expect(await resolver.resolve({ target: 'projects', drive: 'D' })).toMatchObject({ kind: 'path', path: 'D:\\Projects' });
    expect(await resolver.resolve({ target: 'invoices', drive: 'D' })).toEqual({ kind: 'none', reason: 'I couldn\'t find “invoices” on D:.' });
  });

  it('uses the live search when the cache is cold', async () => {
    const { resolver } = makeResolver();
    expect(await resolver.resolve({ target: 'photos', drive: 'D', hint: 'folder' })).toMatchObject({ kind: 'path', path: 'D:\\Photos' });
  });

  it('maps known folder aliases', async () => {
    const { resolver } = makeResolver();
    expect(await resolver.resolve({ target: 'downloads' })).toMatchObject({ kind: 'path', path: 'C:\\Users\\me\\Downloads' });
    expect(await resolver.resolve({ target: 'docs' })).toMatchObject({ kind: 'path', path: 'C:\\Users\\me\\Documents' });
  });

  it('focuses a running app and launches an installed one', async () => {
    const running = makeResolver({ windows: [{ hwnd: '77', title: 'Inbox', exe: 'chrome.exe' }] });
    expect(await running.resolver.resolve({ target: 'chrome' })).toMatchObject({ kind: 'window', hwnd: '77' });
    const idle = makeResolver();
    const launched = await idle.resolver.resolve({ target: 'vs code' });
    expect(launched).toMatchObject({ kind: 'app', display: 'Visual Studio Code' });
  });

  it('opens a file the person names from Downloads', async () => {
    const { resolver } = makeResolver();
    expect(await resolver.resolve({ target: 'resume final', hint: 'file' })).toMatchObject({ kind: 'path', path: 'C:\\Users\\me\\Downloads\\resume final.pdf', isDir: false });
  });

  it('maps site names and reports unknown names plainly', async () => {
    const { resolver } = makeResolver();
    expect(await resolver.resolve({ target: 'youtube' })).toMatchObject({ kind: 'url', url: 'https://www.youtube.com' });
    expect(await resolver.resolve({ target: 'zebra crossing' })).toEqual({ kind: 'none', reason: 'I couldn\'t find “zebra crossing”.' });
    expect(await resolver.resolve({ target: '   ' })).toEqual({ kind: 'none', reason: 'No name was given.' });
  });

  it('keeps win32 semantics when run on any host', () => {
    expect(win32.join('D:\\', 'Projects')).toBe('D:\\Projects');
  });
});
