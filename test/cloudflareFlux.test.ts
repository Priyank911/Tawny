import { describe, expect, it, vi } from 'vitest';
import { generateWithCloudflareFlux, CLOUDFLARE_FLUX_MODEL } from '../src/main/providers/cloudflareFlux';
import { PipelineError } from '../src/shared/contracts';

describe('Cloudflare Flux provider', () => {
  it('sends the documented request and unwraps the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      result: { image: 'encoded-image' }, success: true, errors: [], messages: []
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(generateWithCloudflareFlux('account-123', 'token-123', { prompt: 'a tawny bird', steps: 4 }))
      .resolves.toEqual({ base64: 'encoded-image', mimeType: 'image/jpeg' });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/account-123/ai/run/${CLOUDFLARE_FLUX_MODEL}`,
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer token-123', 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'a tawny bird', steps: 4 })
      })
    );
    vi.unstubAllGlobals();
  });

  it('classifies rate limits as transient', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 429 })));
    await expect(generateWithCloudflareFlux('account', 'token', { prompt: 'test' }))
      .rejects.toMatchObject({ cls: 'transient', stage: 'handle' } satisfies Partial<PipelineError>);
    vi.unstubAllGlobals();
  });

  it('rejects missing credentials before making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await expect(generateWithCloudflareFlux('', '', { prompt: 'test' }))
      .rejects.toMatchObject({ cls: 'permanent', userMessage: expect.stringContaining('Cloudflare') });
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
