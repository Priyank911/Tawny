import { z } from 'zod';
import { PipelineError } from '../../shared/contracts';
import { cloudflareEnvelopeSchema, fluxImageResponseSchema } from '../../shared/contracts';

export const CLOUDFLARE_FLUX_MODEL = '@cf/black-forest-labs/flux-1-schnell';

const fluxInputSchema = z.object({
  prompt: z.string().trim().min(1).max(2048),
  steps: z.number().int().min(1).max(8).default(4)
});

export interface FluxImage {
  base64: string;
  mimeType: 'image/jpeg';
}

export async function generateWithCloudflareFlux(
  accountId: string,
  apiToken: string,
  input: { prompt: string; steps?: number },
  signal?: AbortSignal
): Promise<FluxImage> {
  const parsedInput = fluxInputSchema.parse(input);
  if (!accountId.trim() || !apiToken.trim()) {
    throw new PipelineError('permanent', 'handle', 'Add your Cloudflare account ID and API token in Settings.');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${CLOUDFLARE_FLUX_MODEL}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(parsedInput),
        signal: controller.signal
      }
    );
    const body: unknown = await response.json();
    if (!response.ok) {
      throw new PipelineError(response.status === 429 || response.status >= 500 ? 'transient' : 'permanent', 'handle', `Cloudflare image generation failed (${response.status}).`);
    }
    const envelope = cloudflareEnvelopeSchema.safeParse(body);
    if (envelope.success) {
      if (!envelope.data.success) throw new PipelineError('permanent', 'handle', 'Cloudflare rejected the image request.');
      return { base64: envelope.data.result.image, mimeType: 'image/jpeg' };
    }
    const direct = fluxImageResponseSchema.safeParse(body);
    if (direct.success) return { base64: direct.data.image, mimeType: 'image/jpeg' };
    throw new PipelineError('permanent', 'handle', 'Cloudflare returned an invalid image response.');
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new PipelineError('transient', 'handle', 'Cloudflare image generation timed out.');
    }
    throw new PipelineError('transient', 'handle', 'Cloudflare could not be reached.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}
