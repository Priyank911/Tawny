import { z } from 'zod';

const responseSchema = z.object({ text: z.string() });

export async function transcribeWithGroq(apiKey: string, audio: Uint8Array, mimeType = 'audio/webm'): Promise<string> {
  if (!apiKey.trim()) throw new Error('Groq API key is not configured.');
  if (audio.byteLength === 0) throw new Error('No microphone audio was captured.');

  const form = new FormData();
  const audioBuffer = new ArrayBuffer(audio.byteLength);
  new Uint8Array(audioBuffer).set(audio);
  form.append('file', new Blob([audioBuffer], { type: mimeType }), 'tawny-recording.webm');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');

  const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(30_000)
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const detail = body && typeof body === 'object' && 'error' in body ? String((body as { error?: { message?: unknown } }).error?.message ?? '') : '';
    throw new Error(detail || `Groq transcription failed with HTTP ${response.status}.`);
  }
  const parsed = responseSchema.safeParse(body);
  if (!parsed.success) throw new Error('Groq returned an invalid transcription response.');
  return parsed.data.text.trim();
}
