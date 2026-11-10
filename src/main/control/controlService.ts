import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app, shell } from 'electron';
import type { BehaviorSettings } from '../../shared/contracts';
import { resolveNativeBinary } from '../native/binaries';
import type { ChildLike } from '../native/lineProcess';
import { runCloudflareModel } from '../providers/cloudflareClef';
import { AppIndex, type LaunchTarget, type StartApp } from './appIndex';
import type { Plan } from './actions';
import { PlanExecutor, type ExecResult, type ShellApi } from './executor';
import { ControlHelper } from './helperClient';
import { PathIndex } from './pathIndex';
import type { PlannerContext } from './planner';
import { TargetResolver, type DriveLike, type KnownFolderKey } from './resolver';
import { CloudflareVision } from './vision';

/** Tawny's own overlay and app windows are never a target ("switch to Tawny" focused the overlay). */
function isOwnWindow(window: { pid?: number; exe?: string }): boolean {
  return window.pid === process.pid || /^tawny(?:\.exe)?$/i.test(window.exe ?? '');
}

/**
 * Owns the Windows control helper and the name indexes, and runs plans.
 * Everything here is created lazily on first use so a person who never uses
 * voice control pays nothing: no helper process, no disk crawl.
 */

const INDEX_MAX_AGE_MS = 10 * 60_000;

export interface ControlRunOptions {
  plan: Plan;
  signal: AbortSignal;
  style: BehaviorSettings['controlStyle'];
  vision?: { accountId: string; apiToken: string };
  confirm: (message: string) => Promise<boolean>;
  progress: (message: string) => void;
  note: (event: string, message: string) => void;
}

export class ControlService {
  private helper: ControlHelper | undefined;
  private readonly paths = new PathIndex({
    readdir: async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))
  });
  private readonly apps = new AppIndex();
  private refreshing: Promise<void> | undefined;
  private appsLoadedAt = 0;

  binaryPath(): string | undefined {
    return resolveNativeBinary('tawny-control.exe', process.resourcesPath, app.getAppPath());
  }

  private ensureHelper(): ControlHelper {
    if (this.helper) return this.helper;
    const binary = this.binaryPath();
    this.helper = new ControlHelper({
      spawner: () => {
        if (!binary) throw new Error('tawny-control.exe is missing');
        return spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildLike;
      }
    });
    return this.helper;
  }

  /** A short reason voice control cannot run, or undefined when it can. */
  unavailableReason(): string | undefined {
    if (process.platform !== 'win32') return 'Voice control is available on Windows only.';
    if (!this.binaryPath()) return 'Voice control needs tawny-control.exe, which is missing from this install. Reinstall Tawny to restore it.';
    return undefined;
  }

  /** Starts the helper and the name indexes in the background so the first command is fast. */
  async prewarm(): Promise<void> {
    if (this.unavailableReason()) return;
    await this.ensureHelper().ensureStarted().catch(() => undefined);
    void this.refreshIndexes();
  }

  stop(): void {
    this.helper?.stop();
    this.helper = undefined;
  }

  private knownFolders(): Partial<Record<KnownFolderKey, string>> {
    const folders: Partial<Record<KnownFolderKey, string>> = { home: homedir() };
    const names: Array<[KnownFolderKey, 'desktop' | 'downloads' | 'documents' | 'pictures' | 'music' | 'videos']> = [
      ['desktop', 'desktop'], ['downloads', 'downloads'], ['documents', 'documents'], ['pictures', 'pictures'], ['music', 'music'], ['videos', 'videos']
    ];
    for (const [key, name] of names) {
      try {
        folders[key] = app.getPath(name);
      } catch {
        // The folder is not defined for this account.
      }
    }
    return folders;
  }

  private async drives(): Promise<DriveLike[]> {
    const entries = await this.ensureHelper().drives();
    return entries.map((entry) => ({ letter: entry.name, label: entry.label, ready: entry.ready, type: entry.type }));
  }

  private async indexRoots(): Promise<string[]> {
    const roots = [homedir()];
    for (const drive of await this.drives().catch(() => [] as DriveLike[])) {
      if (drive.ready && (drive.type === 'fixed' || drive.type === 'removable')) roots.push(`${drive.letter}:\\`);
    }
    return roots;
  }

  private async shortcutFiles(): Promise<string[]> {
    const roots: string[] = [];
    for (const base of [process.env.ProgramData, process.env.APPDATA]) {
      if (base) roots.push(join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    }
    const found: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && depth < 3) await walk(path, depth + 1);
        else if (entry.isFile() && /\.lnk$/i.test(entry.name)) found.push(path);
      }
    };
    for (const root of roots) await walk(root, 0);
    return found;
  }

  /** Start menu apps from Windows itself, which is the only place Microsoft Store apps are listed. */
  private startApps(): Promise<StartApp[]> {
    return new Promise((resolve) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-StartApps | Select-Object Name,AppID | ConvertTo-Json -Compress'], { windowsHide: true });
      let output = '';
      const timer = setTimeout(() => child.kill(), 15_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => { output += chunk; });
      child.on('error', () => { clearTimeout(timer); resolve([]); });
      child.on('close', () => {
        clearTimeout(timer);
        try {
          const parsed: unknown = JSON.parse(output);
          const rows = Array.isArray(parsed) ? parsed : [parsed];
          resolve(rows.flatMap((row) => row && typeof row === 'object' && typeof (row as { Name?: unknown }).Name === 'string' && typeof (row as { AppID?: unknown }).AppID === 'string'
            ? [{ name: (row as { Name: string }).Name, appId: (row as { AppID: string }).AppID }]
            : []));
        } catch {
          resolve([]);
        }
      });
    });
  }

  refreshIndexes(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing;
    const stale = this.paths.ageMs > INDEX_MAX_AGE_MS || Date.now() - this.appsLoadedAt > INDEX_MAX_AGE_MS;
    if (!force && !stale) return Promise.resolve();
    this.refreshing = (async () => {
      const [roots, shortcuts, startApps] = await Promise.all([this.indexRoots(), this.shortcutFiles(), this.startApps()]);
      this.apps.setShortcuts(shortcuts, startApps);
      this.appsLoadedAt = Date.now();
      await this.paths.refresh(roots);
    })().catch(() => undefined).finally(() => { this.refreshing = undefined; });
    return this.refreshing;
  }

  private shellApi(): ShellApi {
    return {
      openPath: (path) => shell.openPath(path),
      openExternal: (url) => shell.openExternal(url),
      showItemInFolder: (path) => shell.showItemInFolder(path),
      launch: async (target: LaunchTarget) => {
        if (target.type === 'file') {
          const failure = await shell.openPath(target.value);
          if (failure) throw new Error(failure);
        } else if (target.type === 'uri') {
          await shell.openExternal(target.value);
        } else if (target.type === 'appid') {
          spawn('explorer.exe', [`shell:AppsFolder\\${target.value}`], { detached: true, stdio: 'ignore' }).unref();
        } else {
          spawn(target.value, [], { detached: true, stdio: 'ignore' }).unref();
        }
      },
      openThisPc: async () => { spawn('explorer.exe', ['shell:MyComputerFolder'], { detached: true, stdio: 'ignore' }).unref(); },
      openSpecial: async (uri) => { spawn('explorer.exe', [uri], { detached: true, stdio: 'ignore' }).unref(); }
    };
  }

  /** Window titles and drives for the LLM planner. Titles are untrusted and are quoted as data there. */
  async plannerContext(): Promise<PlannerContext> {
    const helper = this.ensureHelper();
    await helper.ensureStarted();
    const [foreground, windows, drives] = await Promise.all([
      helper.foreground().catch(() => undefined),
      helper.windows().catch(() => []),
      this.drives().catch(() => [] as DriveLike[])
    ]);
    return {
      ...(foreground && !isOwnWindow(foreground) ? { foreground: { title: foreground.title, exe: foreground.exe } } : {}),
      windows: windows.filter((window) => !isOwnWindow(window)).map((window) => ({ title: window.title, exe: window.exe })),
      drives: drives.filter((drive) => drive.ready).map((drive) => ({ letter: drive.letter, label: drive.label }))
    };
  }

  private makeResolver(helper: ControlHelper): TargetResolver {
    return new TargetResolver({
      knownFolders: () => this.knownFolders(),
      drives: () => this.drives(),
      windows: async () => (await helper.windows()).filter((window) => !isOwnWindow(window)).map((window) => ({ hwnd: window.hwnd, title: window.title, exe: window.exe })),
      apps: this.apps,
      paths: this.paths,
      indexRoots: () => this.indexRoots(),
      exists: async (path) => {
        try {
          return (await stat(path)).isDirectory() ? 'dir' : 'file';
        } catch {
          return false;
        }
      },
      listFiles: async (dir) => (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name).slice(0, 4000)
    });
  }

  /**
   * Whether every "open" step of a plan names something that exists on this PC
   * (an app, drive, folder, file, known site, This PC or the Recycle Bin), with
   * one clear match. Used for shortcut speech without the wake phrase: "open VS
   * Code" runs, "open the door" stays dictation.
   */
  async canResolve(plan: Plan): Promise<boolean> {
    if (this.unavailableReason()) return false;
    const helper = this.ensureHelper();
    try {
      await helper.ensureStarted();
    } catch {
      this.helper = undefined;
      return false;
    }
    await this.refreshIndexes();
    const resolver = this.makeResolver(helper);
    for (const step of plan.steps) {
      if (step.verb !== 'open') return false;
      const resolution = await resolver.resolve({ target: step.target, ...(step.drive ? { drive: step.drive } : {}), ...(step.hint ? { hint: step.hint } : {}) }).catch(() => ({ kind: 'none' as const }));
      if (resolution.kind === 'none' || ('ambiguous' in resolution && resolution.ambiguous)) return false;
    }
    return true;
  }

  async run(options: ControlRunOptions): Promise<ExecResult> {
    const reason = this.unavailableReason();
    if (reason) return { ok: false, message: reason };
    const helper = this.ensureHelper();
    try {
      await helper.ensureStarted();
    } catch (error) {
      this.helper = undefined;
      return { ok: false, message: error instanceof Error ? error.message : 'The computer-control helper could not start.' };
    }
    await this.refreshIndexes();
    const resolver = this.makeResolver(helper);
    const vision = options.vision
      ? new CloudflareVision({
        run: (model, body, timeoutMs, signal) => runCloudflareModel(options.vision!.accountId, options.vision!.apiToken, model, body, timeoutMs, signal),
        screenshot: (screenshotOptions) => helper.screenshot(screenshotOptions)
      })
      : undefined;
    const executor = new PlanExecutor({
      helper,
      resolver,
      shell: this.shellApi(),
      confirm: options.confirm,
      progress: options.progress,
      note: options.note,
      ...(vision ? { vision } : {}),
      style: () => options.style,
      signal: options.signal
    });
    return executor.run(options.plan);
  }
}
