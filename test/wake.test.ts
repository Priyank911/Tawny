import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { WakeDetector } from '../src/main/wake/wakeDetector';
import { WakeService } from '../src/main/wake/wakeService';
import { LineProcess, type ChildLike } from '../src/main/native/lineProcess';

describe('WakeDetector', () => {
  const make = () => {
    const clock = { now: 1_000_000 };
    return { clock, detector: new WakeDetector({ now: () => clock.now }) };
  };

  it('fires once per utterance even as the hypothesis keeps growing', () => {
    const { detector } = make();
    expect(detector.hear('hey', 'hyp')).toBeUndefined();
    expect(detector.hear('hey tawny', 'hyp')).toEqual({ type: 'wake', complete: false });
    // Inside the session, partial results mean "still talking" and the final result ends the sentence.
    expect(detector.hear('hey tawny open', 'hyp')).toEqual({ type: 'speech' });
    expect(detector.hear('hey tawny open downloads', 'final')).toEqual({ type: 'sentence_end' });
  });

  it('marks a wake that arrives with the whole request as complete', () => {
    const { detector } = make();
    expect(detector.hear('hey tawny open d drive', 'final')).toEqual({ type: 'wake', complete: true });
  });

  it('keeps listening when only the wake phrase was finished', () => {
    const { detector } = make();
    detector.hear('hey tawny', 'hyp');
    expect(detector.hear('hey tawny', 'final')).toBeUndefined();
    expect(detector.hear('open whatsapp', 'final')).toEqual({ type: 'sentence_end' });
  });

  it('ignores conversation that merely resembles the wake phrase', () => {
    const { detector } = make();
    for (const text of ['hey buddy how are you', 'what is the weather today', 'hey tiny', 'i told tawny yesterday']) {
      expect(detector.hear(text, 'hyp')).toBeUndefined();
      expect(detector.hear(text, 'final')).toBeUndefined();
    }
  });

  it('detects the send phrase once, only while a session is running', () => {
    const { detector } = make();
    expect(detector.hear('tawny send it', 'hyp')).toBeUndefined();
    detector.hear('hey tawny', 'hyp');
    expect(detector.hear('hey tawny make a sunset image tawny', 'hyp')).toEqual({ type: 'speech' });
    expect(detector.hear('hey tawny make a sunset image tawny send it', 'hyp')).toEqual({ type: 'send' });
    expect(detector.hear('hey tawny make a sunset image tawny send it', 'final')).not.toEqual({ type: 'send' });
  });

  it('still catches the send phrase in the final result when no hypothesis did', () => {
    const { detector } = make();
    detector.hear('hey tawny', 'hyp');
    expect(detector.hear('hey tawny open downloads tawny send it', 'final')).toEqual({ type: 'send' });
  });

  it('does not treat "send it" in ordinary dictation as the send phrase', () => {
    const { detector } = make();
    detector.hear('hey tawny', 'hyp');
    expect(detector.hear('hey tawny please send it to john', 'hyp')).toEqual({ type: 'speech' });
  });

  it('enforces a cooldown after each session', () => {
    const { detector, clock } = make();
    detector.hear('hey tawny', 'hyp');
    detector.sessionEnded();
    clock.now += 1000;
    expect(detector.hear('hey tawny again', 'final')).toBeUndefined(); // re-arms on the final
    expect(detector.hear('hey tawny', 'hyp')).toEqual({ type: 'throttled', reason: 'cooldown' });
    clock.now += 4000;
    detector.hear('something else', 'final');
    expect(detector.hear('hey tawny', 'hyp')).toEqual({ type: 'wake', complete: false });
  });

  it('caps wakes per minute', () => {
    const { detector, clock } = make();
    const results: string[] = [];
    for (let i = 0; i < 8; i += 1) {
      const signal = detector.hear('hey tawny', 'hyp');
      results.push(signal?.type === 'throttled' ? signal.reason : signal?.type ?? 'none');
      detector.sessionEnded();
      clock.now += 3500;
      detector.hear('x', 'final');
    }
    expect(results.filter((value) => value === 'wake')).toHaveLength(6);
    expect(results.slice(6)).toEqual(['rate', 'rate']);
  });

  it('lets the orchestrator reject a wake without penalty', () => {
    const { detector } = make();
    expect(detector.hear('hey tawny', 'hyp')).toEqual({ type: 'wake', complete: false });
    detector.cancelWake();
    detector.hear('x', 'final');
    expect(detector.hear('hey tawny', 'hyp')).toEqual({ type: 'wake', complete: false });
  });
});

class FakeChild extends EventEmitter implements ChildLike {
  written: string[] = [];
  killed = false;
  stdin = { write: (data: string) => { this.written.push(data); return true; } };
  stdout = Object.assign(new EventEmitter(), { setEncoding: () => undefined }) as unknown as ChildLike['stdout'];
  stderr = null;
  kill() { this.killed = true; return true; }
  say(object: unknown) { (this.stdout as unknown as EventEmitter).emit('data', `${JSON.stringify(object)}\n`); }
  exit(code = 1) { this.emit('exit', code); }
}

function harness(options: { maxRestarts?: number } = {}) {
  const children: FakeChild[] = [];
  const timers: Array<{ callback: () => void; ms: number }> = [];
  const service = new WakeService({
    spawner: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    setTimer: (callback, ms) => { timers.push({ callback, ms }); return timers.length; },
    clearTimer: () => undefined,
    ...options
  });
  const events: string[] = [];
  service.on('wake', () => events.push('wake'));
  service.on('send', () => events.push('send'));
  service.on('throttled', () => events.push('throttled'));
  return { service, children, timers, events };
}

describe('LineProcess', () => {
  it('reassembles lines split across chunks and survives a dead pipe', () => {
    const child = new FakeChild();
    const process = new LineProcess(() => child);
    const lines: string[] = [];
    process.on('line', (line: string) => lines.push(line));
    process.start();
    const out = child.stdout as unknown as EventEmitter;
    out.emit('data', '{"a":1}\n{"b"');
    out.emit('data', ':2}\r\n\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    child.stdin = { write: () => { throw new Error('EPIPE'); } };
    expect(process.send('x')).toBe(false);
  });
});

describe('WakeService', () => {
  it('reports listening, then emits wake and send from recognizer text', () => {
    const { service, children, events } = harness();
    service.start();
    expect(service.current.state).toBe('starting');
    children[0].say({ t: 'ready', culture: 'en-IN' });
    expect(service.current).toMatchObject({ enabled: true, state: 'listening' });
    expect(service.current.message).toContain('en-IN');
    children[0].say({ t: 'hyp', text: 'hey tawny' });
    children[0].say({ t: 'hyp', text: 'hey tawny open downloads tawny send it' });
    expect(events).toEqual(['wake', 'send']);
  });

  it('restarts a crashed helper with growing backoff, then gives up', () => {
    const { service, children, timers } = harness({ maxRestarts: 2 });
    service.start();
    children[0].say({ t: 'ready' });
    children[0].exit();
    expect(timers.map((timer) => timer.ms)).toEqual([1000]);
    timers[0].callback();
    expect(children).toHaveLength(2);
    children[1].exit();
    expect(timers.map((timer) => timer.ms)).toEqual([1000, 2000]);
    timers[1].callback();
    children[2].exit();
    expect(service.current.state).toBe('error');
    expect(timers).toHaveLength(2);
  });

  it('does not restart after a permanent error such as a missing recognizer', () => {
    const { service, children, timers } = harness();
    service.start();
    children[0].say({ t: 'error', code: 'no_recognizer' });
    children[0].exit(2);
    expect(service.current.state).toBe('error');
    expect(service.current.message).toContain('speech');
    expect(timers).toHaveLength(0);
  });

  it('pauses and resumes, ignoring speech while paused', () => {
    const { service, children, events } = harness();
    service.start();
    children[0].say({ t: 'ready' });
    service.pause('Paused while the screen is locked.');
    expect(service.current.state).toBe('paused');
    expect(children[0].killed).toBe(true);
    children[0].exit(0);
    children[0].say({ t: 'hyp', text: 'hey tawny' });
    expect(events).toEqual([]);
    service.resume();
    expect(children).toHaveLength(2);
    children[1].say({ t: 'ready' });
    expect(service.current.state).toBe('listening');
  });

  it('stop turns it off and sends exit to the helper', () => {
    const { service, children } = harness();
    service.start();
    service.stop();
    expect(service.current).toMatchObject({ enabled: false, state: 'off' });
    expect(children[0].written).toContain('exit\n');
  });

  it('shows a clear message when the helper binary cannot be started', () => {
    const service = new WakeService({ spawner: () => { throw new Error('ENOENT'); } });
    service.start();
    expect(service.current.state).toBe('error');
    expect(service.current.message).toContain('ENOENT');
  });
});

describe('WakeService watchdog', () => {
  function watched() {
    let now = 0;
    const children: FakeChild[] = [];
    const service = new WakeService({
      spawner: () => { const child = new FakeChild(); children.push(child); return child; },
      setTimer: () => 0,
      clearTimer: () => undefined,
      watchdog: { setInterval: () => 1, clearInterval: () => undefined, now: () => now, stallMs: 30_000, recycleAfterMs: 20 * 60_000, quietMs: 8_000 }
    });
    const recycles: string[] = [];
    service.on('recycle', (reason: string) => recycles.push(reason));
    return { service, children, recycles, advance: (ms: number) => { now += ms; } };
  }

  it('restarts a recognizer whose audio heartbeat stopped, without counting a crash', () => {
    const { service, children, recycles, advance } = watched();
    service.start();
    children[0].say({ t: 'ready' });
    advance(20_000);
    children[0].say({ t: 'level', l: 3 });
    service.checkHealth();
    expect(recycles).toEqual([]);
    advance(31_000);
    service.checkHealth();
    expect(recycles).toEqual(['stalled']);
    expect(children[0].killed).toBe(true);
    children[0].exit(0);
    expect(children).toHaveLength(2);
    children[1].say({ t: 'ready' });
    expect(service.current.state).toBe('listening');
  });

  it('recycles a long-running recognizer only during quiet', () => {
    const { service, children, recycles, advance } = watched();
    service.start();
    children[0].say({ t: 'ready' });
    advance(20 * 60_000 + 1);
    children[0].say({ t: 'hyp', text: 'some dictation' });
    service.checkHealth();
    expect(recycles).toEqual([]);
    advance(9_000);
    children[0].say({ t: 'level', l: 1 });
    service.checkHealth();
    expect(recycles).toEqual(['scheduled']);
  });

  it('a live-input end is followed by a normal restart', () => {
    const { service, children } = watched();
    service.start();
    children[0].say({ t: 'ready' });
    children[0].say({ t: 'end', reason: 'input_ended' });
    children[0].exit(0);
    expect(service.current.message).toContain('Restarting');
  });
});
