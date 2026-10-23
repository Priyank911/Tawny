import { z } from 'zod';
import { PipelineError } from '../../shared/contracts';

const responseSchema = z.object({ text: z.string() });
const MAX_DIRECT_UPLOAD_BYTES = 25 * 1024 * 1024;
const MAX_TRANSCRIPTION_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 800;

function transcriptionTimeoutMs(bytes: number): number {
  // Keep short clips responsive while allowing slower processing for larger
  // segments. Long recordings are split before reaching this function.
  return Math.min(180_000, Math.max(60_000, 45_000 + Math.ceil(bytes / 250_000) * 5_000));
}

function getErrorName(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'name' in error
    ? String((error as { name?: unknown }).name)
    : undefined;
}

function getNetworkErrorCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    if ('code' in current && typeof (current as { code?: unknown }).code === 'string') {
      return (current as { code: string }).code;
    }
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return undefined;
}

function isRetryableNetworkError(error: unknown): boolean {
  const name = getErrorName(error);
  const code = getNetworkErrorCode(error);
  return name === 'TimeoutError'
    || name === 'AbortError'
    || name === 'TypeError'
    || ['ECONNRESET', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT'].includes(code ?? '');
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  const retryAfter = response?.headers.get('retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(10_000, seconds * 1_000);
    const dateDelay = Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(dateDelay) && dateDelay > 0) return Math.min(10_000, dateDelay);
  }
  return RETRY_BASE_DELAY_MS * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function transcribeWithGroq(
  apiKey: string,
  audio: Uint8Array | readonly Uint8Array[],
  mimeType = 'audio/webm'
): Promise<string> {
  if (!apiKey.trim()) throw new Error('Groq API key is not configured.');
  const segments = Array.isArray(audio) ? audio : [audio];
  if (segments.length === 0 || segments.some((segment) => segment.byteLength === 0)) {
    throw new Error('No microphone audio was captured.');
  }
  if (segments.length === 1 && segments[0].byteLength > MAX_DIRECT_UPLOAD_BYTES) {
    throw new Error('The recording is larger than Groq\'s direct upload limit. Recordings are split into smaller segments automatically; please try again.');
  }

  const transcripts: string[] = [];
  for (const [index, segment] of segments.entries()) {
    const audioBuffer = new ArrayBuffer(segment.byteLength);
    new Uint8Array(audioBuffer).set(segment);

    let response: Response | undefined;
    for (let attempt = 1; attempt <= MAX_TRANSCRIPTION_ATTEMPTS; attempt++) {
      // Recreate multipart data on each attempt; request bodies cannot safely be reused.
      const form = new FormData();
      form.append('file', new Blob([audioBuffer], { type: mimeType }), `tawny-recording-${index + 1}.webm`);
      form.append('model', 'whisper-large-v3-turbo');
      form.append('response_format', 'json');
      form.append('temperature', '0');
      if (transcripts.length > 0) form.append('prompt', transcripts.join(' ').slice(-900));

      try {
        response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${apiKey}` },
          body: form,
          signal: AbortSignal.timeout(transcriptionTimeoutMs(segment.byteLength))
        });
      } catch (error) {
        if (!isRetryableNetworkError(error)) throw error;
        if (attempt === MAX_TRANSCRIPTION_ATTEMPTS) {
          const detail = getErrorName(error) === 'TimeoutError'
            ? 'timed out'
            : 'could not reach Groq (the network connection was interrupted)';
          throw new PipelineError(
            'transient',
            'stt',
            `Groq transcription ${detail} for segment ${index + 1} of ${segments.length} after ${MAX_TRANSCRIPTION_ATTEMPTS} attempts. Check your connection and try again.`
          );
        }
        await wait(retryDelayMs(undefined, attempt));
        continue;
      }

      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        if (attempt < MAX_TRANSCRIPTION_ATTEMPTS) {
          await wait(retryDelayMs(response, attempt));
          response = undefined;
          continue;
        }
      }
      break;
    }
    if (!response) {
      throw new PipelineError('transient', 'stt', 'Groq transcription could not be completed because the network connection was interrupted.');
    }
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      const detail = body && typeof body === 'object' && 'error' in body ? String((body as { error?: { message?: unknown } }).error?.message ?? '') : '';
      if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
        throw new PipelineError('transient', 'stt', detail || `Groq transcription is temporarily unavailable (HTTP ${response.status}). Please try again.`);
      }
      throw new Error(detail || `Groq transcription failed with HTTP ${response.status}.`);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw new Error(`Groq returned an invalid transcription response for segment ${index + 1}.`);
    const text = parsed.data.text.trim();
    if (text) transcripts.push(text);
  }

  return transcripts.join('\n').trim();
}
