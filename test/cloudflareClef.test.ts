import { describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARE_CLEF_DECIDER_MODEL,
  CLOUDFLARE_CLEF_FAST_MODEL,
  CLOUDFLARE_CLEF_LOW_MODEL,
  cleanRewrittenText,
  decideWithCloudflareClef,
  generateResponseWithCloudflareClef,
  parseClefDecision,
  parseClefIntentDecision,
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

  it('keeps only the natural-language rewrite when code and repeated fences follow it', () => {
    const raw = [
      'Rewritten text:',
      'What are you doing, buddy? Can you tell me what your actual plan is for tomorrow?',
      '```python',
      'import re',
      'def rewrite_text(text):',
      '    return text',
      '``` ``` ``` ``` ```'
    ].join('\n');

    expect(cleanRewrittenText(raw))
      .toBe('What are you doing, buddy? Can you tell me what your actual plan is for tomorrow?');
  });

  it('cuts self-review and repeated output after the first rewrite', () => {
    const raw = [
      'Hello, what is the plan for tomorrow, and is there a proper execution of the idea for the day?',
      'I made no changes to the original response as it already follows the required format.',
      'Hello, what is the plan for tomorrow, and is there a proper execution of the idea for the day?',
      'The response is already correct, so no further changes are required.',
      'Hello, what is the plan for tomorrow, and is there a proper execution of the idea for the day?'
    ].join(' ');

    expect(cleanRewrittenText(raw))
      .toBe('Hello, what is the plan for tomorrow, and is there a proper execution of the idea for the day?');
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

describe('parseClefIntentDecision', () => {
  it('accepts direct structured CLEF intent responses', () => {
    expect(parseClefIntentDecision({ result: { intent: 'text_rewrite', tier: 'balanced', confidence: 0.93 } }, 'plain_dictation'))
      .toEqual({ intent: 'text_rewrite', tier: 'balanced', confidence: 0.93 });
  });

  it('parses the official CLEF answers shape', () => {
    expect(parseClefIntentDecision({
      result: {
        model: 'clef',
        answers: {
          intent: { type: 'choice', choice: 'text_rewrite', confidence: 0.91, probabilities: { text_rewrite: 0.91 } },
          tier: { type: 'choice', choice: 'low', confidence: 0.96, probabilities: { low: 0.96, balanced: 0.04 } }
        }
      }
    }, 'plain_dictation')).toEqual({ intent: 'text_rewrite', tier: 'low', confidence: 0.91 });
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

  it('sends the complete selected text and edit command to CLEF', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { response: '{"intent":"text_rewrite","tier":"low"}' }, success: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(decideWithCloudflareClef('acc', 'tok', {
      command: 'translate this to Spanish and fix the grammar',
      selectedText: 'This is the complete selected paragraph.'
    })).resolves.toMatchObject({ intent: 'text_rewrite', tier: 'low' });

    const request = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      model: string;
      state: string;
      questions: { intent: { criteria: Record<string, string> } };
    };
    expect(request.model).toBe('clef');
    expect(request.state).toContain('translate this to Spanish and fix the grammar');
    expect(request.state).toContain('This is the complete selected paragraph.');
    expect(request.questions.intent.criteria.text_rewrite).toContain('edit');
    expect(request.questions.intent).not.toHaveProperty('choices');
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
    const request = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      prompt?: string;
      messages?: Array<{ role: string; content: string }>;
    };
    expect(request.messages?.[1]?.content).toContain('User request: give me python code for calculator');
    expect(request).not.toHaveProperty('prompt');
    vi.unstubAllGlobals();
  });
});

describe('Cloudflare CLEF rewrite provider', () => {
  it('uses the fast model when the caller explicitly selects fast mode', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { response: 'Fast edited output.' }, success: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(rewriteWithCloudflareClef('account', 'token', {
      selectedText: 'Old text.',
      command: 'Make it concise.',
      tier: 'fast'
    })).resolves.toMatchObject({ model: CLOUDFLARE_CLEF_FAST_MODEL, tier: 'fast' });

    expect(fetchMock).toHaveBeenCalledWith(
      `https://api.cloudflare.com/client/v4/accounts/account/ai/run/${CLOUDFLARE_CLEF_FAST_MODEL}`,
      expect.objectContaining({ method: 'POST' })
    );
    vi.unstubAllGlobals();
  });

  it('retries a suspiciously short rewrite before replacing the selection', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { response: 'Hello, sir.' }, success: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { response: 'Hello, sir. I was wondering whether you have observed any positive developments so far, despite not yet meeting to present a promising new project that could become a successful product.' }, success: true }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await rewriteWithCloudflareClef('account', 'token', {
      selectedText: 'Hello sir. I would like to know whether you have seen any positive signs so far, even though I have not yet had the opportunity to meet with you to present a new project that could become a successful product.',
      command: 'Transform this into a professional and grammatically correct sentence.',
      tier: 'balanced'
    });

    expect(result.text).toContain('positive developments so far');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

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
    const rewriteRequest = JSON.parse(fetchMock.mock.calls[1][1].body as string) as {
      prompt?: string;
      messages?: Array<{ role: string; content: string }>;
    };
    expect(rewriteRequest.messages?.[1]?.content).toContain('Old paragraph.');
    expect(rewriteRequest.messages?.[1]?.content).toContain('Make it concise and clear.');
    expect(rewriteRequest).not.toHaveProperty('prompt');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('rejects missing selected text', async () => {
    await expect(rewriteWithCloudflareClef('account', 'token', { selectedText: '   ', command: 'fix grammar' }))
      .rejects.toMatchObject({ cls: 'input' });
  });

  it('rejects a code-only hallucination for a normal text rewrite', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response(JSON.stringify({ result: { response: '```python\nimport re\ndef rewrite_text(text): return text\n```' }, success: true }), { status: 200 })
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(rewriteWithCloudflareClef('account', 'token', {
      selectedText: 'Please fix this sentence.',
      command: 'Make it professional',
      tier: 'low'
    })).rejects.toMatchObject({ cls: 'permanent' });
    vi.unstubAllGlobals();
  });
});
