import type { Rect, ScreenshotResult } from './helperClient';
import type { VisionLocator } from './executor';

/**
 * Tier 2: when UI Automation cannot see a control (canvas apps, games, some
 * custom-drawn UIs), ask a vision model where it is. This sends a screenshot
 * to Cloudflare, so it is opt-in and off by default. Two passes keep it
 * accurate: a coarse pass on the whole screen, then a zoomed pass on a crop
 * around the first answer. A point that is not on screen is rejected, and any
 * failure returns nothing so the caller reports "not found" instead of
 * clicking a guess.
 */

export const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';

export type VisionRunner = (model: string, body: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal) => Promise<unknown>;
export type Screenshotter = (options: { maxWidth?: number; region?: Rect }) => Promise<ScreenshotResult>;

interface Located { found: boolean; x: number; y: number }

function prompt(query: string, width: number, height: number): string {
  return `The image is ${width} by ${height} pixels. Find the clickable item described as "${query.replace(/["\n]/g, ' ').slice(0, 120)}". ` +
    'Reply with only JSON: {"found":true,"x":<pixel x of its center>,"y":<pixel y of its center>} or {"found":false,"x":0,"y":0}. Do not guess: say found false if it is not clearly visible.';
}

export function parseLocated(body: unknown, width: number, height: number): Located | undefined {
  const response = (body as { result?: { response?: unknown } } | undefined)?.result?.response;
  let candidate: unknown = response;
  if (typeof response === 'string') {
    const start = response.indexOf('{');
    const end = response.lastIndexOf('}');
    if (start < 0 || end <= start) return undefined;
    try { candidate = JSON.parse(response.slice(start, end + 1)); } catch { return undefined; }
  }
  if (!candidate || typeof candidate !== 'object') return undefined;
  const { found, x, y } = candidate as Record<string, unknown>;
  if (found !== true || typeof x !== 'number' || typeof y !== 'number') return undefined;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > width || y > height) return undefined;
  return { found: true, x, y };
}

export class CloudflareVision implements VisionLocator {
  constructor(private readonly deps: { run: VisionRunner; screenshot: Screenshotter }) {}

  private async ask(query: string, shot: ScreenshotResult, signal: AbortSignal): Promise<Located | undefined> {
    const body = {
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt(query, shot.w, shot.h) },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${shot.jpeg}` } }
        ]
      }],
      temperature: 0,
      max_tokens: 80
    };
    try {
      return parseLocated(await this.deps.run(VISION_MODEL, body, 12_000, signal), shot.w, shot.h);
    } catch {
      return undefined;
    }
  }

  async locate(query: string, signal: AbortSignal): Promise<{ x: number; y: number } | undefined> {
    const coarse = await this.deps.screenshot({ maxWidth: 1280 }).catch(() => undefined);
    if (!coarse || coarse.w <= 0 || coarse.h <= 0) return undefined;
    const first = await this.ask(query, coarse, signal);
    if (!first || signal.aborted) return undefined;

    const scaleX = coarse.screen.w / coarse.w;
    const scaleY = coarse.screen.h / coarse.h;
    const guess = { x: coarse.screen.x + first.x * scaleX, y: coarse.screen.y + first.y * scaleY };

    const size = 480;
    const region: Rect = {
      x: Math.round(Math.min(Math.max(guess.x - size / 2, coarse.screen.x), coarse.screen.x + coarse.screen.w - size)),
      y: Math.round(Math.min(Math.max(guess.y - size / 2, coarse.screen.y), coarse.screen.y + coarse.screen.h - size)),
      w: size,
      h: size
    };
    const zoom = await this.deps.screenshot({ region, maxWidth: size }).catch(() => undefined);
    if (zoom && zoom.w > 0 && zoom.h > 0 && !signal.aborted) {
      const second = await this.ask(query, zoom, signal);
      if (second) {
        const point = { x: region.x + second.x * (region.w / zoom.w), y: region.y + second.y * (region.h / zoom.h) };
        return { x: Math.round(point.x), y: Math.round(point.y) };
      }
    }
    return { x: Math.round(guess.x), y: Math.round(guess.y) };
  }
}
