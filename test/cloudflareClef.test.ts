import { describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_CLEF_DECIDER_MODEL,
  CLOUDFLARE_CLEF_LOW_MODEL,
  parseClefDecision,
  rewriteWithCloudflareClef
} from '../src/main/providers/cloudflareClef';

describe('parseClefDecision', () => {
  it('reads structured JSON decisions', () => {
    expect(parseClefDecision('{"tier":"balanced","mode":"respond"}')).toEqual({ tier: 'balanced', mode: 'respond' });
  });

  it('falls back to low rewrite on invalid content', () => {
    expect(parseClefDecision('not-json')).toEqual({ tier: 'low', mode: 'rewrite' });
  });
});

describe('Cloudflare CLEF rewrite provider', () => {
  it('runs decider then rewrite and returns rewritten text', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { response: '{"tier":"low","mode":"rewrite"}' }, success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { response: 'Edited text output' }, success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(rewriteWithCloudflareClef('account-123', 'token-123', {
      selectedText: 'Old paragraph.',
      command: 'Make it concise and clear.'
    })).resolves.toMatchObject({
      text: 'Edited text output',
      tier: 'low',
      mode: 'rewrite',
      model: CLOUDFLARE_CLEF_LOW_MODEL
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      `https://api.cloudflare.com/client/v4/accounts/account-123/ai/run/${CLOUDFLARE_CLEF_DECIDER_MODEL}`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('rejects missing selected text', async () => {
    await expect(rewriteWithCloudflareClef('account', 'token', { selectedText: '   ', command: 'fix grammar' }))
      .rejects.toMatchObject({ cls: 'input' });
  });
});
