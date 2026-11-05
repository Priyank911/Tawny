import { describe, expect, it } from 'vitest';
import { CaptureCore, type SessionClip } from '../src/shared/audio/captureCore';
import { SessionEndpointer } from '../src/shared/audio/endpointer';
import { PcmRing } from '../src/shared/audio/pcmRing';
import { EnergyVad, FRAME_MS, FRAME_SAMPLES, SAMPLE_RATE } from '../src/shared/audio/vad';
import { encodeWav } from '../src/shared/audio/wav';

let seed = 12345;
const random = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 0xffffffff - 0.5;
};

let phase = 0;
/** One 20 ms frame of room noise or syllable-modulated "speech". */
function frame(kind: 'silence' | 'speech' | 'hiss' | 'click', amplitude = 0.12): Int16Array {
  const out = new Int16Array(FRAME_SAMPLES);
  for (let i = 0; i < FRAME_SAMPLES; i += 1) {
    phase += 1;
    let value = random() * 0.004;
    if (kind === 'hiss') value = random() * 0.016;
    if (kind === 'speech') {
      const envelope = 0.65 + 0.35 * Math.sin((2 * Math.PI * 4 * phase) / SAMPLE_RATE);
      value += amplitude * envelope * (Math.sin((2 * Math.PI * 190 * phase) / SAMPLE_RATE) * 0.6 + Math.sin((2 * Math.PI * 820 * phase) / SAMPLE_RATE) * 0.4);
    }
    if (kind === 'click') value += amplitude * (random() * 2);
    out[i] = Math.round(Math.max(-1, Math.min(1, value)) * 32767);
  }
  return out;
}

const frames = (ms: number) => Math.round(ms / FRAME_MS);

function run(core: CaptureCore, kind: Parameters<typeof frame>[0], ms: number): void {
  for (let i = 0; i < frames(ms); i += 1) core.pushFrame(frame(kind));
}

function makeCore(clips: SessionClip[]): CaptureCore {
  return new CaptureCore({ onSessionEnd: (clip) => clips.push(clip) });
}

describe('EnergyVad', () => {
  it('marks speech voiced and room noise unvoiced', () => {
    const vad = new EnergyVad();
    for (let i = 0; i < 100; i += 1) expect(vad.process(frame('silence')).voiced).toBe(false);
    let voiced = 0;
    for (let i = 0; i < 50; i += 1) if (vad.process(frame('speech')).voiced) voiced += 1;
    expect(voiced).toBeGreaterThan(44);
  });
  it('ignores a single click shorter than the onset window', () => {
    const vad = new EnergyVad();
    for (let i = 0; i < 50; i += 1) vad.process(frame('silence'));
    expect(vad.process(frame('click', 0.5)).voiced).toBe(false);
    for (let i = 0; i < 3; i += 1) expect(vad.process(frame('silence')).voiced).toBe(false);
  });
  it('keeps brief dips between words voiced, then releases', () => {
    const vad = new EnergyVad();
    for (let i = 0; i < 50; i += 1) vad.process(frame('silence'));
    for (let i = 0; i < 20; i += 1) vad.process(frame('speech'));
    for (let i = 0; i < 5; i += 1) expect(vad.process(frame('silence')).voiced).toBe(true); // 100 ms inside the 240 ms hangover
    for (let i = 0; i < 20; i += 1) vad.process(frame('silence'));
    expect(vad.process(frame('silence')).voiced).toBe(false);
  });
  it('adapts to steady background hiss instead of treating it as speech', () => {
    const vad = new EnergyVad();
    let voiced = 0;
    for (let i = 0; i < 400; i += 1) if (vad.process(frame('hiss')).voiced) voiced += 1;
    expect(voiced).toBeLessThan(5);
    let speech = 0;
    for (let i = 0; i < 40; i += 1) if (vad.process(frame('speech')).voiced) speech += 1;
    expect(speech).toBeGreaterThan(30);
  });
});

describe('PcmRing', () => {
  it('returns recent audio by absolute index and clamps to what it still holds', () => {
    const ring = new PcmRing(10);
    ring.write(Int16Array.from([1, 2, 3, 4, 5, 6]));
    ring.write(Int16Array.from([7, 8, 9, 10, 11, 12, 13, 14]));
    expect(ring.totalWritten).toBe(14);
    expect(ring.oldest).toBe(4);
    expect(Array.from(ring.slice(0, 14))).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(Array.from(ring.slice(10, 12))).toEqual([11, 12]);
    expect(ring.slice(20, 30)).toHaveLength(0);
  });
});

describe('encodeWav', () => {
  it('writes a valid 16 kHz mono header', () => {
    const wav = encodeWav(Int16Array.from([0, 1000, -1000]));
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe('RIFF');
    expect(String.fromCharCode(...wav.slice(8, 12))).toBe('WAVE');
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(40, true)).toBe(6);
    expect(view.getInt16(48, true)).toBe(-1000);
    expect(wav.byteLength).toBe(50);
  });
});

describe('hands-free session', () => {
  it('captures a one-breath command including the wake phrase, and ends on silence', () => {
    const clips: SessionClip[] = [];
    const core = makeCore(clips);
    run(core, 'silence', 3000);
    run(core, 'speech', 900); // "hey tawny make..."
    expect(core.beginSession()).toBe(true); // wake detected about 0.9 s in
    run(core, 'speech', 1600); // the rest of the command
    run(core, 'silence', 1200);
    expect(clips).toHaveLength(0); // not yet: 240 ms hangover plus 1.2 s of silence
    run(core, 'silence', 400);
    expect(clips).toHaveLength(1);
    const clip = clips[0];
    expect(clip.reason).toBe('silence');
    expect(clip.commandVoicedMs).toBeGreaterThan(1500);
    // 2.5 s of speech, started before the wake event, plus a short lead and tail; leading silence is trimmed
    expect(clip.durationMs).toBeGreaterThanOrEqual(2500 + 200);
    expect(clip.durationMs).toBeLessThan(3500);
    expect(core.sessionActive).toBe(false);
  });

  it('waits through a pause between the wake phrase and the command', () => {
    const clips: SessionClip[] = [];
    const core = makeCore(clips);
    run(core, 'silence', 3000);
    run(core, 'speech', 700);
    core.beginSession();
    run(core, 'speech', 100);
    run(core, 'silence', 2500); // the user thinks for 2.5 s
    expect(clips).toHaveLength(0);
    run(core, 'speech', 1800); // "open downloads"
    run(core, 'silence', 1700);
    expect(clips).toHaveLength(1);
    expect(clips[0].reason).toBe('silence');
    expect(clips[0].commandVoicedMs).toBeGreaterThan(1500);
    expect(clips[0].durationMs).toBeGreaterThan(4500);
  });

  it('gives up quietly when only the wake phrase was said', () => {
    const clips: SessionClip[] = [];
    const core = makeCore(clips);
    run(core, 'silence', 3000);
    run(core, 'speech', 700);
    core.beginSession();
    run(core, 'silence', 5500);
    expect(clips).toHaveLength(0);
    run(core, 'silence', 1000);
    expect(clips).toHaveLength(1);
    expect(clips[0].reason).toBe('no_command');
    expect(clips[0].commandVoicedMs).toBe(0);
  });

  it('ends immediately on "tawny send it" and keeps everything up to that moment', () => {
    const clips: SessionClip[] = [];
    const core = makeCore(clips);
    run(core, 'silence', 3000);
    run(core, 'speech', 900);
    core.beginSession();
    run(core, 'speech', 2000);
    run(core, 'silence', 200);
    core.endSession('send_it');
    expect(clips).toHaveLength(1);
    expect(clips[0].reason).toBe('send_it');
    expect(clips[0].durationMs).toBeGreaterThan(3000);
    expect(core.sessionActive).toBe(false);
  });

  it('caps a runaway session', () => {
    const clips: SessionClip[] = [];
    const core = new CaptureCore({ onSessionEnd: (clip) => clips.push(clip), endpointer: { maxSessionMs: 5000 }, ringSeconds: 8 });
    run(core, 'silence', 1000);
    core.beginSession();
    run(core, 'speech', 6000);
    expect(clips[0].reason).toBe('max');
  });

  it('does not start a second session while one is running', () => {
    const core = makeCore([]);
    run(core, 'silence', 500);
    expect(core.beginSession()).toBe(true);
    expect(core.beginSession()).toBe(false);
  });

  it('reports level while a session runs, and stays quiet otherwise', () => {
    const levels: number[] = [];
    const core = new CaptureCore({ onSessionEnd: () => undefined, onRms: (value) => levels.push(value) });
    run(core, 'speech', 400);
    expect(levels).toHaveLength(0);
    core.beginSession();
    run(core, 'speech', 400);
    expect(levels.length).toBeGreaterThan(5);
    expect(Math.max(...levels)).toBeLessThanOrEqual(1);
  });

  it('rejects frames of the wrong size', () => {
    expect(() => makeCore([]).pushFrame(new Int16Array(100))).toThrow();
  });
});

describe('SessionEndpointer', () => {
  it('treats a short blip after the pause as noise, not a command', () => {
    const endpointer = new SessionEndpointer();
    for (let i = 0; i < frames(700); i += 1) endpointer.push(true);
    for (let i = 0; i < frames(400); i += 1) endpointer.push(false);
    for (let i = 0; i < 3; i += 1) endpointer.push(true); // 60 ms blip
    let result;
    for (let i = 0; i < frames(7000) && !result; i += 1) result = endpointer.push(false);
    expect(result?.reason).toBe('no_command');
  });
});
