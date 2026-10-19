import { PipelineError } from '../../shared/contracts';

export const CLOUDFLARE_CLEF_DECIDER_MODEL = '@cf/cloudflare/clef';
export const CLOUDFLARE_CLEF_LOW_MODEL = '@cf/meta/llama-3.1-8b-instruct';
export const CLOUDFLARE_CLEF_BALANCED_MODEL = '@cf/meta/llama-3.1-70b-instruct-fp8';

export type ClefTier = 'low' | 'balanced';
export type ClefMode = 'rewrite' | 'respond';
export type ClefIntent = 'image_generate' | 'text_rewrite' | 'text_query' | 'plain_dictation';

export interface ClefRewriteResult {
  text: string;
  model: string;
  tier: ClefTier;
  mode: ClefMode;
}

export interface ClefDecisionResult {
  intent: ClefIntent;
  tier: ClefTier;
  confidence: number;
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

export function parseClefIntentDecision(body: unknown, fallbackIntent: ClefIntent): ClefDecisionResult {
  if (!body || typeof body !== 'object') {
    return { intent: fallbackIntent, tier: 'low', confidence: 0.8 };
  }

  const resultObj = ('result' in body && body.result && typeof body.result === 'object'
    ? body.result
    : body) as Record<string, unknown>;

  // Check if Clef returned structured choice probability distributions
  if (resultObj.intent && typeof resultObj.intent === 'object') {
    const intentScores = resultObj.intent as Record<string, number>;
    let topIntent: ClefIntent = fallbackIntent;
    let maxScore = -1;
    for (const [key, score] of Object.entries(intentScores)) {
      if (typeof score === 'number' && score > maxScore) {
        if (key === 'image_generate' || key === 'text_rewrite' || key === 'text_query' || key === 'plain_dictation') {
          maxScore = score;
          topIntent = key;
        }
      }
    }
    const tierScores = resultObj.tier && typeof resultObj.tier === 'object'
      ? resultObj.tier as Record<string, number>
      : undefined;
    const tier: ClefTier = (tierScores && (tierScores.balanced ?? 0) > (tierScores.low ?? 0)) ? 'balanced' : 'low';
    return { intent: topIntent, tier, confidence: maxScore > 0 ? maxScore : 0.85 };
  }

  // Check if response contains a JSON string
  const rawText = parseModelTextResponse(body);
  if (rawText) {
    const jsonMatch = rawText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { intent?: unknown; tier?: unknown; mode?: unknown };
        let intent: ClefIntent = fallbackIntent;
        if (parsed.intent === 'image_generate' || parsed.intent === 'text_rewrite' || parsed.intent === 'text_query' || parsed.intent === 'plain_dictation') {
          intent = parsed.intent;
        } else if (parsed.mode === 'rewrite') {
          intent = 'text_rewrite';
        } else if (parsed.mode === 'respond') {
          intent = 'text_query';
        }
        const tier: ClefTier = parsed.tier === 'balanced' ? 'balanced' : 'low';
        return { intent, tier, confidence: 0.9 };
      } catch {
        // Fall back below
      }
    }
  }

  return { intent: fallbackIntent, tier: 'low', confidence: 0.7 };
}

async function runCloudflareModel(
  accountId: string,
  apiToken: string,
  model: string,
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<unknown> {
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
          Authorization: ['Bearer', apiToken].join(' '),
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body),
        signal: controller.signal
      }
    );
    const result: unknown = await response.json().catch(() => undefined);
    if (!response.ok) {
      throw new PipelineError(
        response.status === 429 || response.status >= 500 ? 'transient' : 'permanent',
        'handle',
        `Cloudflare model request failed (${response.status}).`
      );
    }
    return result;
  } catch (error) {
    if (error instanceof PipelineError) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new PipelineError('transient', 'handle', 'Cloudflare model request timed out.');
    }
    throw new PipelineError('transient', 'handle', 'Cloudflare could not be reached.');
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

/**
 * Use @cf/cloudflare/clef as an intelligent decider model to evaluate the user's intent.
 */
export async function decideWithCloudflareClef(
  accountId: string,
  apiToken: string,
  input: { command: string; selectedText?: string },
  fallbackIntent: ClefIntent = 'plain_dictation',
  signal?: AbortSignal
): Promise<ClefDecisionResult> {
  const command = input.command.trim();
  const selectedText = input.selectedText?.trim() ?? '';

  if (!accountId.trim() || !apiToken.trim() || !command) {
    return { intent: fallbackIntent, tier: 'low', confidence: 1 };
  }

  const deciderState = [
    `Spoken command: "${command}"`,
    selectedText ? `Selected text in focused window: "${selectedText.slice(0, 500)}"` : 'Selected text: None (cursor only)'
  ].join('\n');

  const questions = {
    intent: {
      type: 'choice',
      instructions: 'Determine what action the user wants to execute.',
      choices: {
        image_generate: 'User wants to generate, draw, design, or create an image or photo',
        text_rewrite: 'User selected text and asks to edit, rewrite, fix, translate, or transform it',
        text_query: 'User asks a question, requests code, or asks assistant to generate text from scratch',
        plain_dictation: 'User is speaking normal speech to write directly at the cursor'
      }
    },
    tier: {
      type: 'choice',
      instructions: 'Select model tier: low uses fewer neurons for standard tasks, balanced for complex ones.',
      choices: {
        low: 'Standard or simple task for minimum neuron consumption',
        balanced: 'Nuanced, long, or multi-step task'
      }
    }
  };

  try {
    const rawResult = await runCloudflareModel(
      accountId,
      apiToken,
      CLOUDFLARE_CLEF_DECIDER_MODEL,
      {
        state: deciderState,
        questions,
        // Also include prompt for models accepting prompt-based JSON output
        prompt: `You are CLEF, an AI decision model.\n${deciderState}\nReturn strict JSON: {"intent": "image_generate" | "text_rewrite" | "text_query" | "plain_dictation", "tier": "low" | "balanced"}`
      },
      15_000,
      signal
    );

    return parseClefIntentDecision(rawResult, fallbackIntent);
  } catch (err) {
    // If Clef network call fails or times out, gracefully use fallback intent
    console.warn('CLEF decider network call failed; using fallback intent:', err instanceof Error ? err.message : err);
    return { intent: fallbackIntent, tier: 'low', confidence: 0.75 };
  }
}

/**
 * Strips conversational preambles (e.g. "Rewritten text:"), wrapping quotes,
 * hallucinated python code blocks, and runaway repeated backticks from model output.
 */
export function cleanRewrittenText(raw: string): string {
  if (!raw) return '';
  let text = raw.trim();

  // Strip common conversational introductory preambles (case-insensitive)
  text = text.replace(
    /^(?:Here is the rewritten text:?|Rewritten text:?|Professional version:?|Here is the professional version:?|Here is the revised text:?|Revised text:?|Here's the rewritten text:?|Here is your text:?|Here is an improved version:?|Transformed text:?|Formal version:?|Output:?)\s*/i,
    ''
  );

  // If the model hallucinates a code block or python script at the end of a plain text rewrite, truncate at the code block
  const codeBlockIndex = text.indexOf('```');
  if (codeBlockIndex !== -1) {
    const beforeCode = text.slice(0, codeBlockIndex).trim();
    if (beforeCode.length > 0) {
      text = beforeCode;
    } else {
      // If the entire output was wrapped in a code block, extract the content inside
      const match = text.match(/```(?:[a-zA-Z0-9_-]+)?\s*([\s\S]*?)\s*```/);
      if (match && match[1]) {
        text = match[1].trim();
      }
    }
  }

  // Strip trailing backtick loops or runaway punctuation
  text = text.replace(/(`\s*)+$/g, '').trim();

  // Strip wrapping quotes if the whole text was enclosed in quotes by the model
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    if (text.length >= 2) {
      text = text.slice(1, -1).trim();
    }
  }

  return text;
}

/**
 * Generate code, answers, or new content using a low-grade model for minimal neuron usage.
 */
export async function generateResponseWithCloudflareClef(
  accountId: string,
  apiToken: string,
  input: { command: string; context?: string; tier?: ClefTier },
  signal?: AbortSignal
): Promise<string> {
  if (!accountId.trim() || !apiToken.trim()) {
    throw new PipelineError('permanent', 'handle', 'Add your Cloudflare account ID and API token in Settings.');
  }
  const command = input.command.trim();
  if (!command) throw new PipelineError('input', 'handle', 'No command was spoken.');

  const selectedModel = input.tier === 'balanced' ? CLOUDFLARE_CLEF_BALANCED_MODEL : CLOUDFLARE_CLEF_LOW_MODEL;

  const isCodeRequest = /\b(?:code|python|py|javascript|js|typescript|ts|html|css|sql|function|script|algorithm|regex|calculator|increment|decrement)\b/i.test(command);

  const systemInstructions = isCodeRequest
    ? [
        'You are a direct code generator for a Windows desktop application.',
        'Output ONLY the code or script requested ready to be pasted at the cursor.',
        'Do NOT include conversational greetings, explanations, or follow-up tips.',
        'If using markdown code blocks, do not repeat backticks.'
      ].join('\n')
    : [
        'You are a fast, concise desktop assistant.',
        'Respond directly with the exact answer or text requested so it can be pasted at the user\'s cursor.',
        'Do not include conversational pleasantries, introductory sentences, or meta explanations.'
      ].join('\n');

  const userContent = [
    input.context ? `Context:\n${input.context}\n` : '',
    `User request: ${command}`
  ].filter(Boolean).join('\n\n');

  const rawResult = await runCloudflareModel(
    accountId,
    apiToken,
    selectedModel,
    {
      messages: [
        { role: 'system', content: systemInstructions },
        { role: 'user', content: userContent }
      ],
      max_tokens: 1200,
      temperature: 0.2
    },
    45_000,
    signal
  );

  let text = parseModelTextResponse(rawResult);
  // Cut off any runaway backtick repetition
  text = text.replace(/(`\s*){2,}$/g, '').trim();

  // If this was not a code request, sanitize against preambles and hallucinated code
  if (!isCodeRequest) {
    text = cleanRewrittenText(text);
  }

  if (!text.trim()) {
    throw new PipelineError('permanent', 'handle', 'Cloudflare returned an empty response.');
  }
  return text.trim();
}

/**
 * Rewrite or improve selected text according to the user's voice command.
 */
export async function rewriteWithCloudflareClef(
  accountId: string,
  apiToken: string,
  input: { selectedText: string; command: string; tier?: ClefTier },
  signal?: AbortSignal
): Promise<ClefRewriteResult> {
  if (!accountId.trim() || !apiToken.trim()) {
    throw new PipelineError('permanent', 'handle', 'Add your Cloudflare account ID and API token in Settings.');
  }
  const selectedText = input.selectedText.trim();
  const command = input.command.trim();
  if (!selectedText) throw new PipelineError('input', 'handle', 'No selected text was found to rewrite.');
  if (!command) throw new PipelineError('input', 'handle', 'No rewrite command was spoken.');

  let tier = input.tier;
  let mode: ClefMode = 'rewrite';

  // If tier was not pre-decided, run CLEF decider
  if (!tier) {
    const deciderPrompt = [
      'You are CLEF, a model-tier decider for text editing.',
      'Return strict JSON only with keys: tier and mode.',
      'tier: "low" for simple edits, "balanced" for nuanced or complex rewrites.',
      'mode: "rewrite" when user wants selected text edited, "respond" when user asks a new answer.',
      `Command: ${command}`,
      `Selected text length: ${selectedText.length}`
    ].join('\n');

    try {
      const deciderRaw = await runCloudflareModel(
        accountId,
        apiToken,
        CLOUDFLARE_CLEF_DECIDER_MODEL,
        { prompt: deciderPrompt, max_tokens: 96, temperature: 0 },
        15_000,
        signal
      );
      const parsedText = parseModelTextResponse(deciderRaw);
      const decision = parseClefDecision(parsedText);
      tier = decision.tier;
      mode = decision.mode;
    } catch {
      tier = 'low';
      mode = 'rewrite';
    }
  }

  const selectedModel = tier === 'balanced' ? CLOUDFLARE_CLEF_BALANCED_MODEL : CLOUDFLARE_CLEF_LOW_MODEL;
  const isCodeRequested = /\b(?:code|python|py|javascript|js|script|regex|function)\b/i.test(command);

  const systemInstructions = isCodeRequested
    ? 'You are a precise code assistant. Return only the requested code. No pleasantries or meta explanations.'
    : [
        'You are an expert writing and editing assistant for a desktop application.',
        'Your task is to transform the user\'s selected text according to their instruction.',
        '',
        'STRICT RULES:',
        '1. Return ONLY the final transformed text that will replace the user\'s text.',
        '2. NEVER write "Rewritten text:", "Here is the revised text:", or any introductory phrases.',
        '3. NEVER provide code, scripts, python regex, or explanations unless explicitly requested.',
        '4. Do not wrap the text in markdown code fences (```) or quotes.',
        '5. Stop generating immediately when the rewritten text is complete.'
      ].join('\n');

  const userContent = [
    `Instruction: ${command}`,
    '',
    'Selected Text:',
    selectedText
  ].join('\n');

  const rawResult = await runCloudflareModel(
    accountId,
    apiToken,
    selectedModel,
    {
      messages: [
        { role: 'system', content: systemInstructions },
        { role: 'user', content: userContent }
      ],
      prompt: `${systemInstructions}\n\n${userContent}`,
      max_tokens: 600,
      temperature: 0.15
    },
    45_000,
    signal
  );

  const rawText = parseModelTextResponse(rawResult);
  const rewritten = isCodeRequested ? rawText.trim() : cleanRewrittenText(rawText);
  if (!rewritten.trim()) {
    throw new PipelineError('permanent', 'handle', 'Cloudflare returned an empty rewrite response.');
  }
  return { text: rewritten.trim(), model: selectedModel, tier: tier ?? 'low', mode };
}
