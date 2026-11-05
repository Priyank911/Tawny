import { describe, expect, it } from 'vitest';
import { audioFileName } from '../src/main/providers/groqWhisper';

describe('audio upload file name', () => {
  it('matches the container so Groq decodes it correctly', () => {
    expect(audioFileName('audio/wav', 0)).toBe('tawny-recording-1.wav');
    expect(audioFileName('audio/webm;codecs=opus', 1)).toBe('tawny-recording-2.webm');
    expect(audioFileName('audio/ogg', 0)).toBe('tawny-recording-1.ogg');
    expect(audioFileName('', 0)).toBe('tawny-recording-1.webm');
  });
});
