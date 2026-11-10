import { describe, expect, it } from 'vitest';
import { PlanExecutor, type ExecutorDeps, type HelperApi, type ShellApi } from '../src/main/control/executor';
import { HelperError, type ForegroundInfo, type UiElement } from '../src/main/control/helperClient';
import type { Resolution } from '../src/main/control/resolver';
import { planSchema } from '../src/main/control/actions';

const element = (over: Partial<UiElement>): UiElement => ({
  id: 1, name: 'Save', type: 'Button', autoId: '', x: 100, y: 200, w: 80, h: 30, enabled: true, offscreen: false, patterns: 'invoke', ...over
});

interface World {
  foreground: ForegroundInfo;
  windows: Array<{ hwnd: string; pid: number; title: string; exe: string }>;
  elements: UiElement[];
  taskbar: UiElement[];
  cursor: { x: number; y: number };
  log: string[];
  onClick?: (x: number, y: number, count: number) => void;
  moveError?: HelperError;
  blockFocus?: boolean;
}

function newWorld(over: Partial<World> = {}): World {
  return {
    foreground: { hwnd: '10', pid: 4, title: 'Notes', exe: 'notepad.exe', elevated: false, x: 0, y: 0, w: 1000, h: 800 },
    windows: [{ hwnd: '10', pid: 4, title: 'Notes', exe: 'notepad.exe' }],
    elements: [],
    taskbar: [],
    cursor: { x: 5, y: 5 },
    log: [],
    ...over
  };
}

function fakeHelper(world: World): HelperApi {
  return {
    foreground: async () => ({ ...world.foreground }),
    windows: async () => world.windows.map((window) => ({ ...window })),
    focus: async (hwnd) => {
      world.log.push(`focus ${hwnd}`);
      if (world.blockFocus) return false;
      const target = world.windows.find((window) => window.hwnd === hwnd);
      if (target) world.foreground = { ...world.foreground, hwnd, title: target.title, exe: target.exe };
      return true;
    },
    windowState: async (state) => { world.log.push(`window ${state}`); },
    snapshot: async (options = {}) => ({ hwnd: options.hwnd ?? '', truncated: false, elements: options.scope === 'taskbar' ? world.taskbar : world.elements }),
    bounds: async () => { throw new HelperError('no_element', 'gone'); },
    scrollIntoView: async () => { world.log.push('scrollIntoView'); },
    invoke: async (id) => { world.log.push(`invoke ${id}`); return 'invoke'; },
    cursor: async () => ({ ...world.cursor }),
    move: async (x, y, ms) => {
      if (world.moveError) throw world.moveError;
      world.cursor = { x: Math.round(x), y: Math.round(y) };
      world.log.push(`move ${Math.round(x)},${Math.round(y)} ${ms}ms`);
      return world.cursor;
    },
    click: async (x, y, button = 'left', count = 1) => { world.log.push(`click ${x},${y} ${button} x${count}`); world.onClick?.(x, y, count); },
    type: async (text) => { world.log.push(`type ${text}`); },
    key: async (combo) => { world.log.push(`key ${combo}`); },
    scroll: async (notches) => { world.log.push(`scroll ${notches}`); }
  };
}

function setup(world: World, overrides: Partial<ExecutorDeps> = {}, resolution?: Resolution) {
  const shellLog: string[] = [];
  const shell: ShellApi = {
    openPath: async (path) => { shellLog.push(`openPath ${path}`); return ''; },
    openExternal: async (url) => { shellLog.push(`openExternal ${url}`); },
    showItemInFolder: (path) => { shellLog.push(`show ${path}`); world.log.push(`show ${path}`); world.onShow?.(path); },
    launch: async (target) => { shellLog.push(`launch ${target.value}`); },
    openThisPc: async () => { shellLog.push('thispc'); },
    openSpecial: async (uri) => { shellLog.push(`special ${uri}`); }
  };
  const progress: string[] = [];
  const controller = new AbortController();
  const deps: ExecutorDeps = {
    helper: fakeHelper(world),
    resolver: { resolve: async () => resolution ?? { kind: 'none', reason: 'nothing' } },
    shell,
    confirm: async () => true,
    progress: (message) => progress.push(message),
    style: () => 'visual',
    sleep: async () => undefined,
    signal: controller.signal,
    ...overrides
  };
  return { executor: new PlanExecutor(deps), shellLog, progress, controller };
}

declare module '../src/main/control/executor' {}
interface World { onShow?: (path: string) => void }

const plan = (...steps: unknown[]) => planSchema.parse({ steps });

describe('clicking by name (UI Automation tier)', () => {
  it('moves the cursor to the element, then clicks it', async () => {
    const world = newWorld({ elements: [element({ id: 7, name: 'Save', x: 100, y: 200, w: 80, h: 30 }), element({ id: 8, name: 'Cancel', x: 200, y: 200 })] });
    const { executor } = setup(world);
    const result = await executor.run(plan({ verb: 'ui_click', query: 'save' }));
    expect(result).toEqual({ ok: true, message: 'Clicked “Save”.' });
    expect(world.log.filter((line) => /^(move|click)/.test(line))).toEqual(['move 140,215 120ms', 'click 140,215 left x1']);
  });

  it('double-clicks and right-clicks when asked', async () => {
    const world = newWorld({ elements: [element({ name: 'Report' })] });
    await setup(world).executor.run(plan({ verb: 'ui_click', query: 'report', double: true }));
    expect(world.log).toContain('click 140,215 left x2');
    const second = newWorld({ elements: [element({ name: 'Report' })] });
    await setup(second).executor.run(plan({ verb: 'ui_click', query: 'report', button: 'right' }));
    expect(second.log).toContain('click 140,215 right x1');
  });

  it('refuses to guess between two different matching controls', async () => {
    const world = newWorld({ elements: [element({ id: 1, name: 'Open file', x: 10 }), element({ id: 2, name: 'Open files', x: 400 })] });
    const result = await setup(world).executor.run(plan({ verb: 'ui_click', query: 'open file' }));
    expect(result.ok).toBe(true); // exact label wins
    const ambiguous = newWorld({ elements: [element({ id: 1, name: 'Quarterly report A', x: 10 }), element({ id: 2, name: 'Quarterly report B', x: 400 })] });
    const failed = await setup(ambiguous).executor.run(plan({ verb: 'ui_click', query: 'quarterly report' }));
    expect(failed).toEqual({ ok: false, message: 'Several items match “quarterly report”. Say a more specific name.' });
    expect(ambiguous.log.some((line) => line.startsWith('click'))).toBe(false);
  });

  it('looks at the taskbar when the front window has no such control', async () => {
    const world = newWorld({ taskbar: [element({ id: 3, name: 'Start', x: 20, y: 1050, w: 40, h: 40 })] });
    const result = await setup(world).executor.run(plan({ verb: 'ui_click', query: 'start' }));
    expect(result.ok).toBe(true);
    expect(world.log).toContain('click 40,1070 left x1');
  });

  it('uses vision only when it is provided, and reports honestly when nothing is found', async () => {
    const empty = newWorld();
    expect(await setup(empty).executor.run(plan({ verb: 'ui_click', query: 'mystery' }))).toEqual({ ok: false, message: 'I couldn\'t find “mystery” on screen.' });
    const world = newWorld();
    const { executor } = setup(world, { vision: { locate: async () => ({ x: 300, y: 400 }) } });
    const result = await executor.run(plan({ verb: 'ui_click', query: 'mystery' }));
    expect(result.ok).toBe(true);
    expect(world.log).toContain('click 300,400 left x1');
  });

  it('clicks once and never re-fires the control behind the person\'s back', async () => {
    const world = newWorld({ elements: [element({ id: 9, name: 'Apply', patterns: 'invoke' })] });
    await setup(world).executor.run(plan({ verb: 'ui_click', query: 'apply' }));
    expect(world.log.filter((line) => line.startsWith('click'))).toHaveLength(1);
    expect(world.log.some((line) => line.startsWith('invoke'))).toBe(false);
  });

  it('stops when the person moves the mouse between actions', async () => {
    const world = newWorld({ elements: [element({ id: 1, name: 'One' }), element({ id: 2, name: 'Two', x: 300 })] });
    const { executor } = setup(world);
    world.onClick = () => { world.cursor = { x: 900, y: 900 }; }; // the person grabs the mouse after the first click
    const result = await executor.run(plan({ verb: 'ui_click', query: 'one' }, { verb: 'ui_click', query: 'two' }));
    expect(result).toEqual({ ok: false, message: 'Stopped because you moved the mouse.' });
    expect(world.log.filter((line) => line.startsWith('click'))).toHaveLength(1);
  });

  it('reports a helper-detected mouse move during the animation', async () => {
    const world = newWorld({ elements: [element({})], moveError: new HelperError('user_moved', 'moved') });
    expect(await setup(world).executor.run(plan({ verb: 'ui_click', query: 'save' }))).toEqual({ ok: false, message: 'Stopped because you moved the mouse.' });
  });
});

describe('safety inside the executor', () => {
  it('will not control an elevated window', async () => {
    const world = newWorld();
    world.foreground.elevated = true;
    const result = await setup(world).executor.run(plan({ verb: 'type', text: 'hi' }));
    expect(result.ok).toBe(false);
    expect(world.log).toEqual([]);
  });
  it('will not type or press keys into a command shell', async () => {
    const world = newWorld();
    world.foreground.exe = 'powershell.exe';
    const { executor } = setup(world);
    expect((await executor.run(plan({ verb: 'type', text: 'dir' }))).ok).toBe(false);
    expect((await executor.run(plan({ verb: 'key', combo: 'enter' }))).ok).toBe(false);
    expect(world.log).toEqual([]);
  });
  it('refuses to open a program even if name resolution produced one', async () => {
    const world = newWorld();
    const { executor, shellLog } = setup(world, {}, { kind: 'path', path: 'C:\\Users\\me\\Downloads\\setup.exe', display: 'setup.exe', isDir: false });
    const result = await executor.run(plan({ verb: 'open', target: 'setup' }));
    expect(result.ok).toBe(false);
    expect(shellLog).toEqual([]);
  });
  it('stops at once when cancelled', async () => {
    const world = newWorld({ elements: [element({})] });
    const { executor, controller } = setup(world);
    controller.abort();
    expect(await executor.run(plan({ verb: 'ui_click', query: 'save' }))).toEqual({ ok: false, message: 'Cancelled.' });
    expect(world.log).toEqual([]);
  });
});

describe('opening things', () => {
  it('navigates Explorer with the real cursor and verifies the folder opened', async () => {
    const world = newWorld();
    world.onShow = () => {
      world.windows.push({ hwnd: '20', pid: 9, title: 'Local Disk (D:)', exe: 'explorer.exe' });
      world.elements = [element({ id: 5, name: 'Projects', type: 'ListItem', x: 300, y: 300, w: 600, h: 24 }), element({ id: 6, name: 'Projects', type: 'TreeItem', x: 20, y: 300, w: 120, h: 22 })];
    };
    world.onClick = (_x, _y, count) => { if (count === 2) world.foreground = { ...world.foreground, hwnd: '20', title: 'Projects', exe: 'explorer.exe' }; };
    const { executor, shellLog } = setup(world, {}, { kind: 'path', path: 'D:\\Projects', display: 'Projects', isDir: true });
    const result = await executor.run(plan({ verb: 'open', target: 'projects', drive: 'D', hint: 'folder' }));
    expect(result).toEqual({ ok: true, message: 'Opened Projects.' });
    expect(world.log).toContain('show D:\\Projects');
    expect(world.log).toContain('click 370,312 left x2'); // list item, not the navigation-pane copy
    expect(shellLog.some((line) => line.startsWith('openPath'))).toBe(false); // never needed the direct call
  });

  it('falls back to the direct call when the item cannot be found on screen', async () => {
    const world = newWorld();
    world.onShow = () => { world.windows.push({ hwnd: '20', pid: 9, title: 'Local Disk (D:)', exe: 'explorer.exe' }); };
    const { executor, shellLog } = setup(world, {}, { kind: 'path', path: 'D:\\Projects', display: 'Projects', isDir: true });
    const result = await executor.run(plan({ verb: 'open', target: 'projects', drive: 'D' }));
    expect(result).toEqual({ ok: true, message: 'Opened Projects.' });
    expect(shellLog).toContain('openPath D:\\Projects');
  });

  it('opens directly without touching the cursor in fast mode', async () => {
    const world = newWorld();
    const { executor, shellLog } = setup(world, { style: () => 'fast' }, { kind: 'path', path: 'C:\\Users\\me\\Downloads', display: 'Downloads', isDir: true });
    await executor.run(plan({ verb: 'open', target: 'downloads' }));
    expect(shellLog).toEqual(['openPath C:\\Users\\me\\Downloads']);
    expect(world.log).toEqual([]);
  });

  it('opens a drive root through This PC', async () => {
    const world = newWorld();
    world.onShow = () => undefined;
    const { executor, shellLog } = setup(world, { style: () => 'fast' }, { kind: 'path', path: 'D:\\', display: 'Data (D:)', isDir: true });
    await executor.run(plan({ verb: 'open', target: 'D:', drive: 'D', hint: 'drive' }));
    expect(shellLog).toEqual(['openPath D:\\']);
  });

  it('asks before opening an ambiguous match and respects a refusal', async () => {
    const world = newWorld();
    const asked: string[] = [];
    const { executor, shellLog } = setup(world, { style: () => 'fast', confirm: async (message) => { asked.push(message); return false; } },
      { kind: 'path', path: 'D:\\Work\\Report', display: 'Report', isDir: true, ambiguous: true, alternatives: ['E:\\Report'] });
    const result = await executor.run(plan({ verb: 'open', target: 'report' }));
    expect(result).toEqual({ ok: false, message: 'Cancelled.' });
    expect(asked[0]).toContain('D:\\Work\\Report');
    expect(shellLog).toEqual([]);
  });

  it('switches to an already running app instead of launching another copy', async () => {
    const world = newWorld({ windows: [{ hwnd: '10', pid: 4, title: 'Notes', exe: 'notepad.exe' }, { hwnd: '30', pid: 5, title: 'Docs - Chrome', exe: 'chrome.exe' }] });
    const { executor, shellLog } = setup(world, {}, { kind: 'window', hwnd: '30', display: 'chrome' });
    expect(await executor.run(plan({ verb: 'open', target: 'chrome' }))).toEqual({ ok: true, message: 'Switched to chrome.' });
    expect(shellLog).toEqual([]);
  });

  it('launches an already running app when Windows refuses to bring its window forward', async () => {
    const world = newWorld({ blockFocus: true, windows: [{ hwnd: '30', pid: 5, title: 'WhatsApp', exe: 'WhatsApp.exe' }] });
    const launch = { type: 'appid' as const, value: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' };
    const { executor, shellLog } = setup(world, {}, { kind: 'window', hwnd: '30', display: 'WhatsApp', launch });
    expect(await executor.run(plan({ verb: 'open', target: 'whatsapp' }))).toEqual({ ok: true, message: 'Opened WhatsApp.' });
    expect(shellLog).toEqual([`launch ${launch.value}`]);
  });

  it('says what to do when a running window cannot be focused and there is nothing to launch', async () => {
    const world = newWorld({ blockFocus: true, windows: [{ hwnd: '30', pid: 5, title: 'Tool', exe: 'tool.exe' }] });
    const result = await setup(world, {}, { kind: 'window', hwnd: '30', display: 'tool' }).executor.run(plan({ verb: 'open', target: 'tool' }));
    expect(result.ok).toBe(false);
    expect(result.message).toContain('taskbar');
  });

  it('reports a clear message when the name cannot be resolved', async () => {
    const result = await setup(newWorld(), {}, { kind: 'none', reason: 'I couldn\'t find “zebra”.' }).executor.run(plan({ verb: 'open', target: 'zebra' }));
    expect(result).toEqual({ ok: false, message: 'I couldn\'t find “zebra”.' });
  });
});

describe('windows, keys and scrolling', () => {
  it('focuses the best matching window by title or program name', async () => {
    const world = newWorld({ windows: [{ hwnd: '10', pid: 4, title: 'Notes', exe: 'notepad.exe' }, { hwnd: '30', pid: 5, title: 'Inbox - Mail', exe: 'chrome.exe' }] });
    expect((await setup(world).executor.run(plan({ verb: 'focus_window', query: 'chrome' }))).ok).toBe(true);
    expect(world.log).toContain('focus 30');
  });
  it('reports when no window matches or Windows refuses the switch', async () => {
    expect((await setup(newWorld()).executor.run(plan({ verb: 'focus_window', query: 'photoshop' }))).ok).toBe(false);
    const world = newWorld({ blockFocus: true });
    const result = await setup(world).executor.run(plan({ verb: 'focus_window', query: 'notes' }));
    expect(result.ok).toBe(false);
    expect(world.log).toContain('window restore');
  });
  it('scrolls over the front window, moving the cursor there first', async () => {
    const world = newWorld({ cursor: { x: 2000, y: 2000 } });
    await setup(world).executor.run(plan({ verb: 'scroll', direction: 'down', amount: 'small' }));
    expect(world.log).toEqual(['move 500,400 140ms', 'scroll -4']);
    const top = newWorld();
    await setup(top).executor.run(plan({ verb: 'scroll', direction: 'up', amount: 'top' }));
    expect(top.log).toEqual(['key ctrl+home']);
  });
  it('normalizes key combos and reports progress for each step', async () => {
    const world = newWorld();
    const { executor, progress } = setup(world);
    const result = await executor.run(plan({ verb: 'key', combo: 'Control Shift T' }, { verb: 'wait', ms: 100 }));
    expect(result.ok).toBe(true);
    expect(world.log).toEqual(['key ctrl+shift+t']);
    expect(progress).toEqual(['Pressing Control Shift T', 'Waiting']);
  });
});
