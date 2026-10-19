import { describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_CLEF_DECIDER_MODEL,
  CLOUDFLARE_CLEF_LOW_MODEL,
  cleanRewrittenText,
  decideWithCloudflareClef,
  generateResponseWithCloudflareClef,
  parseClefDecision,
  rewriteWithCloudflareClef
} from '../src/main/providers/cloudflareClef';

describe('cleanRewrittenText', () => {
  it('strips Rewritten text: preamble, hallucinated python code, and backtick spam', () => {
    const raw = `Rewritten text:
What are you doing? Can you tell me what your actual plan is for tomorrow?  \`\`\`python
import re
def rewrite_text(text): pass
\`\`\` \`\`\` \`\`\` \`\`\``;

    const cleaned = cleanRewrittenText(raw);
    expect(cleaned).toBe('What are you doing? Can you tell me what your actual plan is for tomorrow?');
  });

  it('strips surrounding quotes', () => {
    expect(cleanRewrittenText('"Please let me know your plan for tomorrow."')).toBe('Please let me know your plan for tomorrow.');
  });
});

describe('parseClefDecision', () => {
  it('reads structured JSON decisions', () => {
    expect(parseClefDecision('{"tier":"balanced","mode":"respond"}')).toEqual({ tier: 'balanced', mode: 'respond' });
  });

  it('falls back to low rewrite on invalid content', () => {
    expect(parseClefDecision('not-json')).toEqual({ tier: 'low', mode: 'rewrite' });
  });
});

describe('decideWithCloudflareClef', () => {
  it('identifies image generation requests', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { response: '{"intent":"image_generate","tier":"low","confidence":0.95}' }, success: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const decision = await decideWithCloudflareClef('acc', 'tok', { command: 'generate a cat image' });
    expect(decision.intent).toBe('image_generate');
    vi.unstubAllGlobals();
  });

  it('identifies text query requests like code generation', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { response: '{"intent":"text_query","tier":"low","confidence":0.9}' }, success: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const decision = await decideWithCloudflareClef('acc', 'tok', { command: 'give me python code for calculator' });
    expect(decision.intent).toBe('text_query');
    expect(decision.tier).toBe('low');
    vi.unstubAllGlobals();
  });

  it('falls back to provided fallbackIntent if network fails', async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error('Network offline'));
    vi.stubGlobal('fetch', fetchMock);

    const decision = await decideWithCloudflareClef('acc', 'tok', { command: 'hello friend' }, 'plain_dictation');
    expect(decision.intent).toBe('plain_dictation');
    vi.unstubAllGlobals();
  });
});

describe('generateResponseWithCloudflareClef', () => {
  it('calls low-grade model for minimal neuron usage and returns answer', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { response: 'def add(a, b): return a + b' }, success: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    const response = await generateResponseWithCloudflareClef('acc', 'tok', {
      command: 'give me python code for calculator',
      tier: 'low'
    });

    expect(response).toBe('def add(a, b): return a + b');
    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/acc/ai/run/${CLOUDFLARE_CLEF_LOW_MODEL}`,
      expect.objectContaining({ method: 'POST' })
    );
    vi.unstubAllGlobals();
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
