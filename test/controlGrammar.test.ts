import { describe, expect, it } from 'vitest';
import { parseControlCommand, parseSpokenKey } from '../src/main/pipeline/controlGrammar';
import { assessPlan, planSchema } from '../src/main/control/actions';

const first = (text: string) => parseControlCommand(text)?.steps[0];

describe('control grammar: opening things', () => {
  it('opens a folder inside a drive from the original request', () => {
    expect(first('can you open that folder Projects which is present in the D drive')).toEqual({ verb: 'open', target: 'Projects', drive: 'D', hint: 'folder' });
  });
  it('opens a drive', () => {
    expect(first('open the D drive')).toEqual({ verb: 'open', target: 'D:', drive: 'D', hint: 'drive' });
    expect(first('open drive e')).toEqual({ verb: 'open', target: 'E:', drive: 'E', hint: 'drive' });
  });
  it('opens known folders and apps by name', () => {
    expect(first('open downloads')).toEqual({ verb: 'open', target: 'downloads', hint: 'any' });
    expect(first('Launch Visual Studio Code.')).toEqual({ verb: 'open', target: 'Visual Studio Code', hint: 'any' });
    expect(first('take me to my documents folder')).toEqual({ verb: 'open', target: 'documents', hint: 'folder' });
  });
  it('turns spoken domains into URLs', () => {
    expect(first('open github dot com')).toEqual({ verb: 'open_url', url: 'https://github.com' });
    expect(first('go to youtube.com')).toEqual({ verb: 'open_url', url: 'https://youtube.com' });
  });
  it('drops polite filler', () => {
    expect(first('could you please open downloads for me')).toEqual({ verb: 'open', target: 'downloads', hint: 'any' });
  });
});

describe('control grammar: UI actions', () => {
  it('clicks named elements', () => {
    expect(first('click the save button')).toEqual({ verb: 'ui_click', query: 'save' });
    expect(first('double click on report final')).toEqual({ verb: 'ui_click', query: 'report final', double: true });
    expect(first('right click the desktop')).toEqual({ verb: 'ui_click', query: 'desktop', button: 'right' });
  });
  it('treats "press" as a key when the object is a key', () => {
    expect(first('press enter')).toEqual({ verb: 'key', combo: 'enter' });
    expect(first('press control shift t')).toEqual({ verb: 'key', combo: 'ctrl+shift+t' });
    expect(first('press the submit button')).toEqual({ verb: 'ui_click', query: 'submit' });
  });
  it('switches windows', () => {
    expect(first('switch to chrome')).toEqual({ verb: 'focus_window', query: 'chrome' });
    expect(first('switch back to the terminal window')).toEqual({ verb: 'focus_window', query: 'terminal' });
  });
  it('scrolls', () => {
    expect(first('scroll down')).toEqual({ verb: 'scroll', direction: 'down', amount: 'small' });
    expect(first('scroll up a lot')).toEqual({ verb: 'scroll', direction: 'up', amount: 'page' });
    expect(first('scroll to the bottom')).toEqual({ verb: 'scroll', direction: 'down', amount: 'bottom' });
  });
  it('types text with its original casing', () => {
    expect(first('type Hello World from Tawny')).toEqual({ verb: 'type', text: 'Hello World from Tawny' });
  });
  it('maps short editing commands to keys and window operations', () => {
    expect(first('select all')).toEqual({ verb: 'key', combo: 'ctrl+a' });
    expect(first('minimize this window')).toEqual({ verb: 'window', op: 'minimize' });
    expect(first('close this window')).toEqual({ verb: 'window', op: 'close' });
  });
});

describe('control grammar: what it must leave alone', () => {
  it.each([
    'give me python code to open a file',
    'write a function that opens a folder',
    'what is the best way to open downloads',
    'make an image of an open door',
    'the meeting is at five tomorrow',
    'open downloads and then click the first file',
    'open the folder and type my name then press enter',
    'tell me how to scroll in excel'
  ])('returns undefined for: %s', (text) => {
    expect(parseControlCommand(text)).toBeUndefined();
  });
});

describe('spoken keys', () => {
  it.each([
    ['page down', 'pagedown'],
    ['the escape key', 'esc'],
    ['alt tab', 'alt+tab'],
    ['control plus c', 'ctrl+c'],
    ['f 5', undefined],
    ['f5', 'f5'],
    ['banana', undefined]
  ])('%s -> %s', (spoken, combo) => {
    expect(parseSpokenKey(spoken)).toBe(combo);
  });
});

describe('plan safety', () => {
  const plan = (steps: unknown[]) => planSchema.parse({ steps });
  it('blocks shells and executables', () => {
    expect(assessPlan(plan([{ verb: 'open', target: 'PowerShell' }]), 'grammar').blocked).toBeTruthy();
    expect(assessPlan(plan([{ verb: 'launch_app', name: 'cmd' }]), 'planner').blocked).toBeTruthy();
    expect(assessPlan(plan([{ verb: 'open_path', path: 'C:\\Users\\me\\Downloads\\setup.exe' }]), 'planner').blocked).toBeTruthy();
    expect(assessPlan(plan([{ verb: 'key', combo: 'win+r' }]), 'planner').blocked).toBeTruthy();
  });
  it('requires confirmation for destructive clicks, closing and submitting typed text', () => {
    expect(assessPlan(plan([{ verb: 'ui_click', query: 'Delete' }]), 'grammar').confirm).toBeTruthy();
    expect(assessPlan(plan([{ verb: 'window', op: 'close' }]), 'grammar').confirm).toBeTruthy();
    expect(assessPlan(plan([{ verb: 'type', text: 'hello' }, { verb: 'key', combo: 'enter' }]), 'planner').confirm).toBeTruthy();
    expect(assessPlan(plan([{ verb: 'key', combo: 'delete' }]), 'grammar').confirm).toBeTruthy();
  });
  it('lets ordinary navigation through', () => {
    expect(assessPlan(plan([{ verb: 'open', target: 'downloads' }, { verb: 'ui_click', query: 'report', double: true }]), 'grammar')).toEqual({});
  });
  it('confirms planner-chosen web addresses but not spoken ones, and rejects other schemes', () => {
    const url = plan([{ verb: 'open_url', url: 'https://example.com' }]);
    expect(assessPlan(url, 'planner').confirm).toBeTruthy();
    expect(assessPlan(url, 'grammar')).toEqual({});
    expect(assessPlan(plan([{ verb: 'open_url', url: 'file:///C:/Windows/System32/cmd.exe' }]), 'grammar').blocked).toBeTruthy();
    expect(assessPlan(plan([{ verb: 'open_url', url: 'https://user:pw@example.com' }]), 'grammar').blocked).toBeTruthy();
  });
  it('rejects plans over the step limit or outside the verb set', () => {
    expect(planSchema.safeParse({ steps: Array.from({ length: 9 }, () => ({ verb: 'wait', ms: 100 })) }).success).toBe(false);
    expect(planSchema.safeParse({ steps: [{ verb: 'shell', command: 'dir' }] }).success).toBe(false);
  });
});
