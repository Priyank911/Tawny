import { win32 } from 'node:path';
import { describeAction, isExecutablePath, isShellProcess, normalizeCombo, type Action, type Plan } from './actions';
import type { ControlHelper, ForegroundInfo, UiElement } from './helperClient';
import { HelperError } from './helperClient';
import { isDriveRoot, parentAndName } from './pathIndex';
import type { LaunchTarget } from './appIndex';
import type { Resolution, TargetResolver } from './resolver';
import { normalizeName, pickConfident, rankMatches, scoreMatch } from '../pipeline/fuzzy';

/**
 * Runs a validated plan one step at a time. Principles:
 *  - Use the lowest tier that works: direct OS calls, then UI Automation,
 *    then (opt-in) vision. A cursor animation is shown for the person's benefit
 *    but correctness never depends on it: every visual path falls back to the
 *    direct call.
 *  - Verify after acting and say plainly what happened.
 *  - Stop immediately when the person moves the mouse, presses Escape, or a
 *    target is ambiguous. Guessing is how the wrong thing gets clicked.
 */

export class ControlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControlError';
  }
}

export type HelperApi = Pick<ControlHelper,
  'foreground' | 'windows' | 'focus' | 'windowState' | 'snapshot' | 'bounds' | 'scrollIntoView' | 'invoke' |
  'cursor' | 'move' | 'click' | 'type' | 'key' | 'scroll'>;

export interface ShellApi {
  openPath(path: string): Promise<string>;
  openExternal(url: string): Promise<void>;
  showItemInFolder(path: string): void;
  launch(target: LaunchTarget): Promise<void>;
  openThisPc(): Promise<void>;
  openSpecial(shellUri: string): Promise<void>;
}

export interface VisionLocator {
  locate(query: string, signal: AbortSignal): Promise<{ x: number; y: number } | undefined>;
}

export interface ExecutorDeps {
  helper: HelperApi;
  resolver: Pick<TargetResolver, 'resolve'>;
  shell: ShellApi;
  confirm: (message: string) => Promise<boolean>;
  progress: (message: string) => void;
  note?: (event: string, message: string) => void;
  vision?: VisionLocator;
  style: () => 'visual' | 'fast';
  sleep?: (ms: number) => Promise<void>;
  signal: AbortSignal;
}

export type ExecResult = { ok: true; message: string } | { ok: false; message: string };

const INTERACTIVE_TYPES = new Set(['Button', 'Hyperlink', 'MenuItem', 'TabItem', 'ListItem', 'TreeItem', 'CheckBox', 'RadioButton', 'DataItem', 'SplitButton', 'ComboBox', 'Edit']);
const MOVED_TOLERANCE_PX = 14;

function isExplorer(exe: string): boolean {
  return /^explorer(?:\.exe)?$/i.test(exe);
}

export class PlanExecutor {
  private lastCursor: { x: number; y: number } | undefined;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: ExecutorDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(plan: Plan): Promise<ExecResult> {
    let last = 'Done.';
    try {
      for (const step of plan.steps) {
        this.throwIfAborted();
        this.deps.progress(describeAction(step));
        last = await this.runStep(step);
      }
      return { ok: true, message: last };
    } catch (error) {
      return { ok: false, message: this.explain(error) };
    }
  }

  private explain(error: unknown): string {
    if (error instanceof ControlError) return error.message;
    if (error instanceof HelperError) {
      if (error.code === 'user_moved') return 'Stopped because you moved the mouse.';
      if (error.code === 'helper_unavailable' || error.code === 'helper_exited') return 'Computer control is unavailable because its helper is not running.';
      if (error.code === 'timeout') return 'The app took too long to respond.';
      if (error.code === 'no_element') return 'That item is no longer on screen.';
      return error.message;
    }
    if (error instanceof Error && error.name === 'AbortError') return 'Cancelled.';
    return error instanceof Error ? error.message : 'Computer control failed.';
  }

  private throwIfAborted(): void {
    if (this.deps.signal.aborted) throw Object.assign(new Error('Cancelled.'), { name: 'AbortError' });
  }

  private async runStep(step: Action): Promise<string> {
    switch (step.verb) {
      case 'open': return this.open(step);
      case 'open_path': return this.openExact(step.path);
      case 'launch_app': return this.open({ verb: 'open', target: step.name, hint: 'app' });
      case 'open_url': {
        await this.deps.shell.openExternal(step.url);
        return `Opened ${new URL(step.url).hostname}.`;
      }
      case 'focus_window': return this.focusWindow(step.query);
      case 'ui_click': return this.clickByName(step);
      case 'type': return this.typeText(step.text);
      case 'key': return this.pressKey(step.combo);
      case 'scroll': return this.scroll(step);
      case 'window': {
        await this.deps.helper.windowState(step.op);
        return { minimize: 'Minimized the window.', maximize: 'Maximized the window.', restore: 'Restored the window.', close: 'Closed the window.' }[step.op];
      }
      case 'wait':
        await this.sleep(step.ms);
        return 'Done.';
    }
  }

  // --- Tier 0: open things -------------------------------------------------

  private async open(step: Extract<Action, { verb: 'open' }>): Promise<string> {
    const resolution: Resolution = await this.deps.resolver.resolve({ target: step.target, drive: step.drive, hint: step.hint });
    switch (resolution.kind) {
      case 'none':
        throw new ControlError(resolution.reason);
      case 'thispc':
        await this.deps.shell.openThisPc();
        return 'Opened This PC.';
      case 'special':
        await this.deps.shell.openSpecial(resolution.shell);
        return `Opened ${resolution.display}.`;
      case 'url':
        await this.deps.shell.openExternal(resolution.url);
        return `Opened ${resolution.display}.`;
      case 'app':
        await this.deps.shell.launch(resolution.launch);
        return `Starting ${resolution.display}.`;
      case 'window': {
        const focused = await this.deps.helper.focus(resolution.hwnd).catch(() => false);
        if (focused) return `Switched to ${resolution.display}.`;
        // Windows refused to bring it forward. Starting an app that is already running brings its window to
        // the front for nearly every app (single-instance apps hand over to the running copy).
        if (resolution.launch) {
          await this.deps.shell.launch(resolution.launch);
          return `Opened ${resolution.display}.`;
        }
        throw new ControlError(`${resolution.display} is open, but Windows would not bring it to the front. Click it in the taskbar.`);
      }
      case 'path': {
        if (resolution.ambiguous) {
          const others = resolution.alternatives?.length ? ` Other matches: ${resolution.alternatives.map((path) => win32.basename(path)).join(', ')}.` : '';
          const approved = await this.deps.confirm(`Open ${resolution.path}?${others}`);
          if (!approved) throw new ControlError('Cancelled.');
        }
        return this.openExact(resolution.path, resolution.display);
      }
    }
  }

  private async openExact(path: string, display = win32.basename(path) || path): Promise<string> {
    if (isExecutablePath(path)) throw new ControlError('Tawny will not run programs by voice. Open it yourself if you meant to.');
    if (this.deps.style() === 'visual') {
      try {
        if (await this.openVisually(path)) return `Opened ${display}.`;
      } catch (error) {
        if (error instanceof HelperError && error.code === 'user_moved') throw error;
        if (error instanceof Error && error.name === 'AbortError') throw error;
        this.deps.note?.('control.visual_fallback', `Cursor navigation did not complete (${error instanceof Error ? error.message : 'unknown'}); opening directly.`);
      }
    }
    const failure = await this.deps.shell.openPath(path);
    if (failure) throw new ControlError(`Windows could not open ${display}: ${failure}`);
    return `Opened ${display}.`;
  }

  /** Opens the parent in Explorer, moves the real cursor to the item and double-clicks it. Returns false to request the direct fallback. */
  private async openVisually(path: string): Promise<boolean> {
    const helper = this.deps.helper;
    const root = isDriveRoot(path);
    const { parent, name } = parentAndName(path);
    const parentIsRoot = isDriveRoot(parent);
    const expectedTitle = root ? 'this pc' : win32.basename(parent);
    const parentLetter = parent[0]?.toUpperCase() ?? '';
    const titleMatches = (title: string): boolean => parentIsRoot
      ? new RegExp(`\\(${parentLetter}:\\)|^${parentLetter}:`, 'i').test(title)
      : scoreMatch(title, expectedTitle) >= 0.8;
    const before = new Set((await helper.windows()).map((window) => window.hwnd));

    if (root) await this.deps.shell.openThisPc();
    else this.deps.shell.showItemInFolder(path);

    const explorer = await this.waitForWindow(before, (window) => isExplorer(window.exe) && titleMatches(window.title), 3200);
    if (!explorer) return false;
    await helper.focus(explorer.hwnd);
    this.throwIfAborted();

    const snapshot = await helper.snapshot({ hwnd: explorer.hwnd, max: 900, budgetMs: 2200 });
    const letter = root ? path[0].toUpperCase() : '';
    const wanted = root ? new RegExp(`\\(${letter}:\\)`, 'i') : undefined;
    const stripExt = (value: string) => value.replace(/\.[A-Za-z0-9]{1,5}$/, '');
    const candidates = snapshot.elements.filter((element) => element.name && (element.type === 'ListItem' || element.type === 'DataItem' || element.type === 'TreeItem'));
    const matches = wanted
      ? candidates.filter((element) => wanted.test(element.name))
      : candidates.filter((element) => scoreMatch(stripExt(element.name), stripExt(name)) >= 0.95 || scoreMatch(element.name, name) >= 0.95);
    // The file list beats the navigation pane, which also contains the same names.
    const element = matches.sort((a, b) => Number(b.type !== 'TreeItem') - Number(a.type !== 'TreeItem'))[0];
    if (!element) return false;

    await this.moveAndClick(element, { count: 2 });
    const opened = await this.waitFor(async () => {
      const fg = await helper.foreground();
      return !isExplorer(fg.exe) || scoreMatch(fg.title, root ? letter : stripExt(name)) >= 0.8 || (root && fg.title.toUpperCase().includes(`(${letter}:)`));
    }, 1600);
    if (opened) return true;
    await helper.key('enter');
    return this.waitFor(async () => {
      const fg = await helper.foreground();
      return !isExplorer(fg.exe) || scoreMatch(fg.title, stripExt(name)) >= 0.8;
    }, 1200);
  }

  private async waitForWindow(before: Set<string>, matches: (window: { hwnd: string; title: string; exe: string }) => boolean, timeoutMs: number): Promise<{ hwnd: string; title: string; exe: string } | undefined> {
    const interval = 120;
    const attempts = Math.ceil(timeoutMs / interval);
    let existing: { hwnd: string; title: string; exe: string } | undefined;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.throwIfAborted();
      const windows = await this.deps.helper.windows();
      const fresh = windows.find((window) => !before.has(window.hwnd) && matches(window));
      if (fresh) return fresh;
      existing = windows.find(matches) ?? existing;
      // Explorer sometimes reuses a window that was already open; give a new one a moment to appear first.
      if (existing && attempt >= 5) return existing;
      await this.sleep(interval);
    }
    return existing;
  }

  private async waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
    const interval = 110;
    const attempts = Math.max(1, Math.ceil(timeoutMs / interval));
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      this.throwIfAborted();
      if (await check().catch(() => false)) return true;
      await this.sleep(interval);
    }
    return false;
  }

  // --- Windows ---------------------------------------------------------------

  private async focusWindow(query: string): Promise<string> {
    const windows = await this.deps.helper.windows();
    const ranked = rankMatches(query, windows, (window) => window.title, 0.6)
      .map((entry) => ({ item: entry.item, score: Math.max(entry.score, scoreMatch(query, entry.item.exe.replace(/\.exe$/i, ''))) }));
    for (const window of windows) {
      if (!ranked.some((entry) => entry.item.hwnd === window.hwnd)) {
        const score = scoreMatch(query, window.exe.replace(/\.exe$/i, ''));
        if (score >= 0.8) ranked.push({ item: window, score });
      }
    }
    ranked.sort((a, b) => b.score - a.score);
    const pick = pickConfident(ranked, { minimum: 0.8, margin: 0.04 });
    if (!pick.best) throw new ControlError(`No open window matches “${query}”.`);
    const target = pick.best.item;
    let focused = await this.deps.helper.focus(target.hwnd);
    if (!focused) {
      await this.deps.helper.windowState('restore', target.hwnd);
      focused = await this.deps.helper.focus(target.hwnd);
    }
    if (!focused) throw new ControlError(`Windows would not bring “${target.title || query}” to the front.`);
    return `Switched to ${target.title || query}.`;
  }

  // --- Tier 1: UI Automation ---------------------------------------------------

  private async clickByName(step: Extract<Action, { verb: 'ui_click' }>): Promise<string> {
    const helper = this.deps.helper;
    const fg = await helper.foreground();
    this.requireControllable(fg);

    let found = this.pickElement(step.query, (await helper.snapshot({ hwnd: fg.hwnd })).elements);
    if (!found.element && !found.ambiguous) {
      found = this.pickElement(step.query, (await helper.snapshot({ scope: 'taskbar', max: 300, budgetMs: 1200 }).catch(() => ({ elements: [] as UiElement[] }))).elements);
    }
    if (found.ambiguous) throw new ControlError(`Several items match “${step.query}”. Say a more specific name.`);

    if (!found.element) {
      if (this.deps.vision) {
        const point = await this.deps.vision.locate(step.query, this.deps.signal);
        if (point) {
          await this.moveAndClickPoint(point.x, point.y, { count: step.double ? 2 : 1, button: step.button });
          return `Clicked “${step.query}” (found by looking at the screen).`;
        }
      }
      throw new ControlError(`I couldn't find “${step.query}” on screen.`);
    }

    const element = found.element;
    if (element.offscreen) await helper.scrollIntoView(element.id).catch(() => undefined);
    await this.moveAndClick(element, { count: step.double ? 2 : 1, button: step.button });
    // One real click only. Re-invoking the control could fire a toggle or a button twice.
    await this.sleep(60);
    return `Clicked “${element.name}”.`;
  }

  private pickElement(query: string, elements: readonly UiElement[]): { element?: UiElement; ambiguous: boolean } {
    const usable = elements.filter((element) => element.enabled && (element.name || element.autoId) && element.w > 2 && element.h > 2);
    const scored = usable.map((element) => ({
      item: element,
      score: Math.max(scoreMatch(query, element.name), element.autoId ? scoreMatch(query, element.autoId) * 0.9 : 0)
    })).filter((entry) => entry.score >= 0.8);
    scored.sort((a, b) => b.score - a.score
      || Number(INTERACTIVE_TYPES.has(b.item.type)) - Number(INTERACTIVE_TYPES.has(a.item.type))
      || Number(a.item.offscreen) - Number(b.item.offscreen));
    const exact = scored.filter((entry) => normalizeName(entry.item.name) === normalizeName(query));
    const pool = exact.length > 0 ? exact : scored;
    // Two different controls with the same label (a menu item and a button) are not a tie worth guessing over
    // when they are in the same place; different places are.
    const distinct = pool.filter((entry, index) => pool.findIndex((other) => Math.abs(other.item.x - entry.item.x) < 6 && Math.abs(other.item.y - entry.item.y) < 6) === index);
    const pick = pickConfident(distinct, { minimum: 0.8, margin: 0.05 });
    if (!pick.best) return { ambiguous: false };
    if (pick.ambiguous && !(exact.length === 1)) return { ambiguous: true };
    return { element: pick.best.item, ambiguous: false };
  }

  private requireControllable(fg: ForegroundInfo): void {
    if (fg.elevated) throw new ControlError('The front window is running as administrator, so Tawny cannot control it.');
  }

  // --- Cursor ---------------------------------------------------------------------

  private async moveAndClick(element: UiElement, options: { count: number; button?: 'left' | 'right' }): Promise<void> {
    let box = element;
    if (element.offscreen) {
      const fresh = await this.deps.helper.bounds(element.id);
      box = { ...element, ...fresh };
    }
    // Aim near the left of wide rows (icon and name), at the middle of small controls.
    const x = box.x + Math.min(box.w / 2, 70);
    const y = box.y + box.h / 2;
    await this.moveAndClickPoint(x, y, options);
  }

  private async moveAndClickPoint(x: number, y: number, options: { count: number; button?: 'left' | 'right' }): Promise<void> {
    this.throwIfAborted();
    const helper = this.deps.helper;
    const current = await helper.cursor();
    if (this.lastCursor && Math.abs(current.x - this.lastCursor.x) + Math.abs(current.y - this.lastCursor.y) > MOVED_TOLERANCE_PX) {
      throw new ControlError('Stopped because you moved the mouse.');
    }
    const distance = Math.hypot(x - current.x, y - current.y);
    const duration = Math.round(Math.min(260, Math.max(120, distance / 6)));
    const landed = await helper.move(x, y, duration);
    await helper.click(landed.x, landed.y, options.button ?? 'left', options.count);
    this.lastCursor = { x: landed.x, y: landed.y };
  }

  // --- Keyboard and scrolling -----------------------------------------------------

  private async typeText(text: string): Promise<string> {
    const fg = await this.deps.helper.foreground();
    this.requireControllable(fg);
    if (isShellProcess(fg.exe)) throw new ControlError('Tawny does not type into command shells.');
    await this.deps.helper.type(text);
    return 'Typed.';
  }

  private async pressKey(combo: string): Promise<string> {
    const fg = await this.deps.helper.foreground();
    this.requireControllable(fg);
    if (isShellProcess(fg.exe)) throw new ControlError('Tawny does not send keys to command shells.');
    const normalized = normalizeCombo(combo);
    await this.deps.helper.key(normalized);
    return `Pressed ${normalized}.`;
  }

  private async scroll(step: Extract<Action, { verb: 'scroll' }>): Promise<string> {
    const helper = this.deps.helper;
    const fg = await helper.foreground();
    this.requireControllable(fg);
    if (step.amount === 'top' || step.amount === 'bottom') {
      await helper.key(step.amount === 'top' ? 'ctrl+home' : 'ctrl+end');
      return step.amount === 'top' ? 'Scrolled to the top.' : 'Scrolled to the bottom.';
    }
    const cursor = await helper.cursor();
    const inside = cursor.x >= fg.x && cursor.x <= fg.x + fg.w && cursor.y >= fg.y && cursor.y <= fg.y + fg.h;
    if (!inside && fg.w > 0 && fg.h > 0) {
      const landed = await helper.move(fg.x + fg.w / 2, fg.y + fg.h / 2, 140);
      this.lastCursor = landed;
    } else {
      this.lastCursor = cursor;
    }
    const notches = step.amount === 'page' ? 12 : 4;
    await helper.scroll(step.direction === 'up' ? notches : -notches);
    return `Scrolled ${step.direction}.`;
  }
}
