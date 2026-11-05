import { describe, expect, it } from 'vitest';
import { CloudflareVision, parseLocated } from '../src/main/control/vision';

const shot = (w: number, h: number, screen = { x: 0, y: 0, w: 2560, h: 1440 }) => ({ w, h, screen, jpeg: 'AAAA' });
const reply = (found: boolean, x: number, y: number) => ({ result: { response: JSON.stringify({ found, x, y }) } });

describe('vision locator', () => {
  it('rejects answers that are not found, not numeric, or off screen', () => {
    expect(parseLocated(reply(false, 0, 0), 100, 100)).toBeUndefined();
    expect(parseLocated(reply(true, 500, 10), 100, 100)).toBeUndefined();
    expect(parseLocated({ result: { response: 'I think it is on the left' } }, 100, 100)).toBeUndefined();
    expect(parseLocated({ result: { response: { found: true, x: 10, y: 20 } } }, 100, 100)).toEqual({ found: true, x: 10, y: 20 });
  });

  it('refines the coarse answer with a zoomed pass and maps back to screen pixels', async () => {
    const calls: string[] = [];
    const vision = new CloudflareVision({
      screenshot: async (options) => (options.region ? shot(480, 480, { x: 0, y: 0, w: 2560, h: 1440 }) : shot(1280, 720)),
      run: async () => { calls.push('run'); return calls.length === 1 ? reply(true, 640, 360) : reply(true, 250, 230); }
    });
    // Coarse answer maps to (1280,720); crop starts at (1040,480); refined point is (1040+250, 480+230).
    expect(await vision.locate('play button', new AbortController().signal)).toEqual({ x: 1290, y: 710 });
    expect(calls).toHaveLength(2);
  });

  it('falls back to the coarse answer only when the zoomed pass finds nothing, never to a made-up point', async () => {
    let n = 0;
    const vision = new CloudflareVision({
      screenshot: async (options) => (options.region ? shot(480, 480) : shot(1280, 720)),
      run: async () => { n += 1; return n === 1 ? reply(true, 640, 360) : reply(false, 0, 0); }
    });
    expect(await vision.locate('x', new AbortController().signal)).toEqual({ x: 1280, y: 720 });
  });

  it('fails closed when the model errors or the screenshot fails', async () => {
    const failing = new CloudflareVision({ screenshot: async () => shot(1280, 720), run: async () => { throw new Error('down'); } });
    expect(await failing.locate('x', new AbortController().signal)).toBeUndefined();
    const blind = new CloudflareVision({ screenshot: async () => { throw new Error('no screen'); }, run: async () => reply(true, 1, 1) });
    expect(await blind.locate('x', new AbortController().signal)).toBeUndefined();
  });
});
