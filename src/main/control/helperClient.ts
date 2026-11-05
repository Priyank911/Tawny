import { LineProcess, type Spawner } from '../native/lineProcess';

/**
 * Typed client for tawny-control.exe, the persistent Windows helper that does
 * everything Node cannot: UI Automation, real mouse and keyboard input,
 * window focus and screenshots.
 *
 * Wire format (one request or response per line):
 *   request:  <id> TAB <command> TAB <key>=<percent-encoded value> ...
 *   response: {"id":<id>,"ok":true,...}  or  {"id":<id>,"ok":false,"error":"<code>","message":"..."}
 * Percent-encoding keeps tabs, newlines and non-ASCII text out of the framing.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export interface ForegroundInfo extends Rect {
  hwnd: string;
  pid: number;
  title: string;
  exe: string;
  elevated: boolean;
}

export interface WindowInfo {
  hwnd: string;
  pid: number;
  title: string;
  exe: string;
}

export interface DriveEntry {
  name: string;
  label: string;
  type: string;
  ready: boolean;
}

export interface UiElement extends Rect {
  id: number;
  name: string;
  type: string;
  autoId: string;
  enabled: boolean;
  offscreen: boolean;
  patterns: string;
}

export interface UiSnapshot {
  hwnd: string;
  truncated: boolean;
  elements: UiElement[];
}

export interface ScreenshotResult {
  w: number;
  h: number;
  /** Physical pixels of the full screen the image was taken from. */
  screen: Rect;
  jpeg: string;
}

export class HelperError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'HelperError';
  }
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: unknown;
}

export interface HelperClientOptions {
  spawner: Spawner;
  defaultTimeoutMs?: number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class ControlHelper {
  private readonly process: LineProcess;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly defaultTimeoutMs: number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private ready: Promise<void> | undefined;

  constructor(options: HelperClientOptions) {
    this.process = new LineProcess(options.spawner);
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 6000;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
    this.process.on('line', (line: string) => this.onLine(line));
    this.process.on('exit', () => this.failAll(new HelperError('helper_exited', 'The computer-control helper stopped.')));
    this.process.on('error', (error: Error) => this.failAll(new HelperError('helper_unavailable', `The computer-control helper could not start (${error.message}).`)));
  }

  /** Starts the process on first use and checks it answers. */
  async ensureStarted(): Promise<void> {
    if (this.process.alive && !this.ready) this.ready = undefined;
    if (!this.process.alive) {
      this.ready = undefined;
      this.process.start();
    }
    if (!this.ready) {
      this.ready = this.call('hello', {}, 4000).then(() => undefined);
      this.ready.catch(() => { this.ready = undefined; });
    }
    return this.ready;
  }

  stop(): void {
    this.process.stop();
    this.failAll(new HelperError('helper_exited', 'The computer-control helper was stopped.'));
    this.ready = undefined;
  }

  private onLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === 'number' ? message.id : undefined;
    if (id === undefined) return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    this.clearTimer(pending.timer);
    if (message.ok === true) pending.resolve(message);
    else pending.reject(new HelperError(String(message.error ?? 'failed'), String(message.message ?? 'The helper could not complete the request.')));
  }

  private failAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.clearTimer(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  call(command: string, args: Record<string, string | number | boolean | undefined> = {}, timeoutMs = this.defaultTimeoutMs): Promise<Record<string, unknown>> {
    if (!this.process.alive) this.process.start();
    const id = this.nextId++;
    const fields = Object.entries(args)
      .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
      .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`);
    const line = [String(id), command, ...fields].join('\t');
    return new Promise((resolve, reject) => {
      const timer = this.setTimer(() => {
        this.pending.delete(id);
        reject(new HelperError('timeout', `The computer-control helper did not answer ${command} in time.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      if (!this.process.send(line)) {
        this.pending.delete(id);
        this.clearTimer(timer);
        reject(new HelperError('helper_unavailable', 'The computer-control helper is not running.'));
      }
    });
  }

  async foreground(): Promise<ForegroundInfo> {
    const r = await this.call('foreground');
    return {
      hwnd: String(r.hwnd), pid: Number(r.pid), title: String(r.title ?? ''), exe: String(r.exe ?? ''), elevated: r.elevated === true,
      x: Number(r.x ?? 0), y: Number(r.y ?? 0), w: Number(r.w ?? 0), h: Number(r.h ?? 0)
    };
  }

  async windows(): Promise<WindowInfo[]> {
    const r = await this.call('windows');
    return (Array.isArray(r.windows) ? r.windows : []) as WindowInfo[];
  }

  async focus(hwnd: string): Promise<boolean> {
    const r = await this.call('focus', { hwnd });
    return r.foreground === true;
  }

  async windowState(state: 'minimize' | 'maximize' | 'restore' | 'close', hwnd?: string): Promise<void> {
    await this.call('window_state', { state, hwnd });
  }

  async drives(): Promise<DriveEntry[]> {
    const r = await this.call('drives');
    return (Array.isArray(r.drives) ? r.drives : []) as DriveEntry[];
  }

  async snapshot(options: { hwnd?: string; scope?: 'window' | 'taskbar'; max?: number; budgetMs?: number } = {}): Promise<UiSnapshot> {
    const budget = options.budgetMs ?? 2500;
    const r = await this.call('uia_snapshot', { hwnd: options.hwnd, scope: options.scope ?? 'window', max: options.max ?? 600, budget }, budget + 2500);
    return { hwnd: String(r.hwnd ?? ''), truncated: r.truncated === true, elements: (Array.isArray(r.elements) ? r.elements : []) as UiElement[] };
  }

  async bounds(id: number): Promise<Rect & { offscreen: boolean }> {
    const r = await this.call('uia_bounds', { id });
    return { x: Number(r.x), y: Number(r.y), w: Number(r.w), h: Number(r.h), offscreen: r.offscreen === true };
  }

  async scrollIntoView(id: number): Promise<void> {
    await this.call('uia_scroll_into_view', { id });
  }

  async invoke(id: number): Promise<string> {
    const r = await this.call('uia_invoke', { id });
    return String(r.pattern ?? '');
  }

  async cursor(): Promise<{ x: number; y: number }> {
    const r = await this.call('cursor');
    return { x: Number(r.x), y: Number(r.y) };
  }

  /** Rejects with code "user_moved" if the person moves the mouse during the animation. */
  async move(x: number, y: number, ms: number): Promise<{ x: number; y: number }> {
    const r = await this.call('move', { x: Math.round(x), y: Math.round(y), ms: Math.round(ms) }, ms + 3000);
    return { x: Number(r.x), y: Number(r.y) };
  }

  async click(x: number, y: number, button: 'left' | 'right' = 'left', count = 1): Promise<void> {
    await this.call('click', { x: Math.round(x), y: Math.round(y), button, count });
  }

  async type(text: string): Promise<void> {
    await this.call('type', { text }, 8000);
  }

  async key(combo: string): Promise<void> {
    await this.call('key', { combo });
  }

  async scroll(notches: number): Promise<void> {
    await this.call('scroll', { dy: Math.round(notches) });
  }

  async screenshot(options: { maxWidth?: number; region?: Rect } = {}): Promise<ScreenshotResult> {
    const region = options.region;
    const r = await this.call('screenshot', {
      maxw: options.maxWidth ?? 1280,
      x: region?.x, y: region?.y, w: region?.w, h: region?.h
    }, 8000);
    return { w: Number(r.w), h: Number(r.h), screen: r.screen as Rect, jpeg: String(r.jpeg ?? '') };
  }
}
