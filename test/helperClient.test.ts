import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { ControlHelper, HelperError } from '../src/main/control/helperClient';
import type { ChildLike } from '../src/main/native/lineProcess';

class FakeChild extends EventEmitter {
  written: string[] = [];
  killed = false;
  autoRespond: ((line: string) => string | undefined) | undefined;
  stdin = { write: (data: string) => { this.written.push(data); const out = this.autoRespond?.(data.trim()); if (out !== undefined) this.stdout.emit('data', `${out}\n`); return true; } };
  stdout = new EventEmitter() as EventEmitter & { setEncoding(): void };
  stderr = new EventEmitter();
  constructor() { super(); this.stdout.setEncoding = () => undefined; }
  kill() { this.killed = true; this.emit('exit', 0); }
}

function harness(respond: (id: number, command: string, args: Record<string, string>) => Record<string, unknown> | undefined) {
  const children: FakeChild[] = [];
  const timers: Array<{ cb: () => void; ms: number; active: boolean }> = [];
  const helper = new ControlHelper({
    spawner: () => {
      const child = new FakeChild();
      child.autoRespond = (line) => {
        const [id, command, ...rest] = line.split('\t');
        if (command === 'exit') return undefined;
        const args: Record<string, string> = {};
        for (const field of rest) { const at = field.indexOf('='); args[field.slice(0, at)] = decodeURIComponent(field.slice(at + 1)); }
        const reply = respond(Number(id), command, args);
        return reply === undefined ? undefined : JSON.stringify({ id: Number(id), ...reply });
      };
      children.push(child);
      return child as unknown as ChildLike;
    },
    setTimer: (cb, ms) => { const t = { cb, ms, active: true }; timers.push(t); return t; },
    clearTimer: (h) => { (h as { active: boolean }).active = false; }
  });
  return { helper, children, timers };
}

describe('control helper client', () => {
  it('frames requests with percent-encoded arguments and parses replies', async () => {
    const seen: Array<{ command: string; args: Record<string, string> }> = [];
    const { helper } = harness((_id, command, args) => {
      seen.push({ command, args });
      if (command === 'foreground') return { ok: true, hwnd: '5', pid: 9, title: 'A\tB', exe: 'notepad.exe', elevated: false, x: 1, y: 2, w: 3, h: 4 };
      return { ok: true };
    });
    await helper.ensureStarted();
    await helper.type('héllo\nworld\ttab 100%');
    expect(seen.find((entry) => entry.command === 'type')?.args.text).toBe('héllo\nworld\ttab 100%');
    expect(await helper.foreground()).toEqual({ hwnd: '5', pid: 9, title: 'A\tB', exe: 'notepad.exe', elevated: false, x: 1, y: 2, w: 3, h: 4 });
  });

  it('keeps concurrent calls apart by id', async () => {
    const queue: Array<() => void> = [];
    const children: FakeChild[] = [];
    const helper = new ControlHelper({ spawner: () => { const c = new FakeChild(); children.push(c); return c as unknown as ChildLike; } });
    helper.call('hello').catch(() => undefined);
    const a = helper.call('cursor');
    const b = helper.call('drives');
    const ids = children[0].written.map((line) => Number(line.split('\t')[0]));
    expect(new Set(ids).size).toBe(3);
    children[0].stdout.emit('data', `${JSON.stringify({ id: ids[2], ok: true, drives: [{ name: 'C', label: '', type: 'fixed', ready: true }] })}\n${JSON.stringify({ id: ids[1], ok: true, x: 7, y: 8 })}\n`);
    expect(await a).toMatchObject({ x: 7, y: 8 });
    expect((await b).drives).toHaveLength(1);
    void queue;
  });

  it('reassembles replies that arrive in pieces', async () => {
    const children: FakeChild[] = [];
    const helper = new ControlHelper({ spawner: () => { const c = new FakeChild(); children.push(c); return c as unknown as ChildLike; } });
    const pending = helper.cursor();
    const id = Number(children[0].written[0].split('\t')[0]);
    const text = JSON.stringify({ id, ok: true, x: 40, y: 50 });
    children[0].stdout.emit('data', text.slice(0, 7));
    children[0].stdout.emit('data', `${text.slice(7)}\r\n`);
    expect(await pending).toEqual({ x: 40, y: 50 });
  });

  it('turns an error reply into a HelperError with its code', async () => {
    const { helper } = harness((_id, command) => (command === 'move' ? { ok: false, error: 'user_moved', message: 'The mouse was moved.' } : { ok: true }));
    await helper.ensureStarted();
    await expect(helper.move(10, 10, 100)).rejects.toMatchObject({ name: 'HelperError', code: 'user_moved' });
  });

  it('times out a call the helper never answers', async () => {
    const { helper, timers } = harness((_id, command) => (command === 'hello' ? { ok: true } : undefined));
    await helper.ensureStarted();
    const pending = helper.key('enter');
    timers.filter((timer) => timer.active).at(-1)!.cb();
    await expect(pending).rejects.toMatchObject({ code: 'timeout' });
  });

  it('rejects in-flight calls when the helper exits, and restarts on the next call', async () => {
    const { helper, children } = harness((_id, command) => (command === 'hello' ? { ok: true } : undefined));
    await helper.ensureStarted();
    const pending = helper.click(1, 1);
    children[0].emit('exit', 1);
    await expect(pending).rejects.toMatchObject({ code: 'helper_exited' });
    await helper.ensureStarted();
    expect(children).toHaveLength(2);
  });

  it('reports a helper that cannot start as unavailable instead of throwing', async () => {
    const helper = new ControlHelper({ spawner: () => { throw new Error('ENOENT'); } });
    await expect(helper.ensureStarted()).rejects.toBeInstanceOf(HelperError);
  });

  it('does not send undefined arguments and clamps coordinates to integers', async () => {
    const { helper, children } = harness(() => ({ ok: true, x: 3, y: 4 }));
    await helper.ensureStarted();
    await helper.screenshot();
    await helper.move(10.6, 20.2, 99.5);
    const lines = children[0].written.map((line) => line.trim());
    expect(lines.find((line) => line.includes('\tscreenshot'))).toMatch(/maxw=1280$/);
    expect(lines.find((line) => line.includes('\tmove'))).toMatch(/x=11\ty=20\tms=100$/);
  });
});
