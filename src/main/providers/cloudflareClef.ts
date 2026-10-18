import { PipelineError } from '../../shared/contracts';

export const CLOUDFLARE_CLEF_DECIDER_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const CLOUDFLARE_CLEF_LOW_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const CLOUDFLARE_CLEF_BALANCED_MODEL = '@cf/meta/llama-3.1-70b-instruct-fp8';

type ClefTier = 'low' | 'balanced';
type ClefMode = 'rewrite' | 'respond';

export interface ClefRewriteResult {
  text: string;
  model: string;
  tier: ClefTier;
  mode: ClefMode;
}

function parseModelTextResponse(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const source = 'result' in body && body.result && typeof body.result === 'object'
    ? body.result as Record<string, unknown>
    : body as Record<string, unknown>;
  if (typeof source.response === 'string') return source.response.trim();
  if (typeof source.output_text === 'string') return source.output_text.trim();
  if (Array.isArray(source.response)) {
    const joined = source.response.filter((part): part is string => typeof part === 'string').join('\n').trim();
    if (joined) return joined;
  }
  if (Array.isArray(source.output) && source.output.length > 0) {
    const first = source.output[0];
    if (first && typeof first === 'object' && 'content' in first && typeof first.content === 'string') {
      return first.content.trim();
    }
  }
  return '';
}

export function parseClefDecision(raw: string): { tier: ClefTier; mode: ClefMode } {
  const fallback = { tier: 'low' as const, mode: 'rewrite' as const };
  const objectMatch = raw.match(/\{[\s\S]*\}/);
  const payload = objectMatch?.[0] ?? raw;
  try {
    const parsed = JSON.parse(payload) as { tier?: unknown; mode?: unknown };
    const tier: ClefTier = parsed.tier === 'balanced' ? 'balanced' : 'low';
    const mode: ClefMode = parsed.mode === 'respond' ? 'respond' : 'rewrite';
    return { tier, mode };
  } catch {
    return fallback;
  }
}

async function runCloudflareTextModel(
  accountId: string,
  apiToken: string,
  model: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/run/${model}`,
      {
        method: 'POST',
        headers: {
          Authorization: `******
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
    const result: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new PipelineError(response.status === 429 || response.status >= 500 ? 'transient' : 'permanent', 'handle', `Cloudflare text model failed (${response.status}).`);
    }
    const parsedText = parseModelTextResponse(result);
    if (!parsedText) throw new PipelineError('permanent', 'handle', 'Cloudflare returned an empty text response.');
    return parsedText;
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new PipelineError('transient', 'handle', 'Cloudflare text processing timed out.');
    }
    throw new PipelineError('transient', 'handle', 'Cloudflare text processing could not be reached.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function rewriteWithCloudflareClef(
  accountId: string,
  apiToken: string,
  input: { selectedText: string; command: string },
  signal?: AbortSignal
): Promise<ClefRewriteResult> {
  if (!accountId.trim() || !apiToken.trim()) {
    throw new PipelineError('permanent', 'handle', 'Add your Cloudflare account ID and API token in Settings.');
  }
  const selectedText = input.selectedText.trim();
  const command = input.command.trim();
  if (!selectedText) throw new PipelineError('input', 'handle', 'No selected text was found to rewrite.');
  if (!command) throw new PipelineError('input', 'handle', 'No rewrite command was spoken.');

  const deciderPrompt = [
    'You are CLEF, a model-tier decider for text editing.',
    'Return strict JSON only with keys: tier and mode.',
    'tier: "low" for simple edits, "balanced" for nuanced or complex rewrites.',
    'mode: "rewrite" when user wants selected text edited, "respond" when user asks a new answer.',
    `Command: ${command}`,
    `Selected text length: ${selectedText.length}`
  ].join('\n');

  const deciderRaw = await runCloudflareTextModel(
    accountId,
    apiToken,
    CLOUDFLARE_CLEF_DECIDER_MODEL,
    { prompt: deciderPrompt, max_tokens: 96, temperature: 0 },
    20_000,
    signal
  );
  const decision = parseClefDecision(deciderRaw);
  const selectedModel = decision.tier === 'balanced' ? CLOUDFLARE_CLEF_BALANCED_MODEL : CLOUDFLARE_CLEF_LOW_MODEL;

  const taskPrompt = [
    'You are a precise writing assistant.',
    decision.mode === 'respond'
      ? 'Create a direct response for the command using the selected text as context.'
      : 'Rewrite the selected text exactly according to the command.',
    'Return plain text only. Do not include markdown fences.',
    `Command: ${command}`,
    `Selected text:\n${selectedText}`
  ].join('\n\n');

  const rewritten = await runCloudflareTextModel(
    accountId,
    apiToken,
    selectedModel,
    { prompt: taskPrompt, max_tokens: 900, temperature: 0.2 },
    45_000,
    signal
  );
  if (!rewritten.trim()) {
    throw new PipelineError('permanent', 'handle', 'Cloudflare returned an empty rewrite response.');
  }
  return { text: rewritten.trim(), model: selectedModel, tier: decision.tier, mode: decision.mode };
}
