import { describe, expect, it, vi } from 'vitest';
import { transcribeWithGroq } from '../src/main/providers/groqWhisper';

describe('Groq Whisper transcription', () => {
  it('transcribes segmented audio in order and carries context forward', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'This is the first segment.' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: 'This continues the long dictation.' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(transcribeWithGroq('groq-token', [
      new Uint8Array([1, 2, 3]),
      new Uint8Array([4, 5, 6])
    ])).resolves.toBe('This is the first segment.\nThis continues the long dictation.');

    const secondBody = fetchMock.mock.calls[1][1].body as FormData;
    expect(secondBody.get('prompt')).toContain('This is the first segment.');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    vi.unstubAllGlobals();
  });

  it('retries a segment timeout and reports a recoverable error after the attempt limit', async () => {
    const fetchMock = vi.fn().mockRejectedValue(Object.assign(new Error('aborted'), { name: 'TimeoutError' }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(transcribeWithGroq('groq-token', new Uint8Array([1, 2, 3])))
      .rejects.toThrow('Groq transcription timed out for segment 1 of 1 after 3 attempts.');
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.unstubAllGlobals();
  });
});
