import { PipelineError } from '../../shared/contracts';

export const CLOUDFLARE_CLEF_DECIDER_MODEL = '@cf/cloudflare/clef';
export const CLOUDFLARE_CLEF_FAST_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
// Keep these IDs aligned with the currently routable Workers AI catalog.
// The older llama-3.1-8b-instruct and llama-3.1-70b-instruct-fp8 routes now
// return 7000 ("No route for that URI") from the AI Gateway endpoint.
export const CLOUDFLARE_CLEF_LOW_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
export const CLOUDFLARE_CLEF_BALANCED_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export type ClefTier = 'fast' | 'low' | 'balanced';
export type ClefMode = 'rewrite' | 'respond';
export type ClefIntent = 'image_generate' | 'text_rewrite' | 'text_query' | 'plain_dictation';

const clefIntents: ClefIntent[] = ['image_generate', 'text_rewrite', 'text_query', 'plain_dictation'];

function isClefIntent(value: unknown): value is ClefIntent {
  return typeof value === 'string' && clefIntents.includes(value as ClefIntent);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? value as Record<string, unknown> : undefined;
}

function choiceValue(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if ('choice' in record) return record.choice;
  if ('answer' in record) return record.answer;
  if ('value' in record) return record.value;
  if ('label' in record) return record.label;
  const probabilities = asRecord(record.probabilities);
  if (probabilities) {
    return Object.entries(probabilities)
      .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
      .sort((left, right) => right[1] - left[1])[0]?.[0];
  }
  return undefined;
}

function confidenceValue(value: unknown): number {
  const record = asRecord(value);
  const confidence = record?.confidence;
  return typeof confidence === 'number' ? Math.max(0, Math.min(1, confidence)) : 0.9;
}

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

  // Official CLEF responses return answers under result.answers. A choice
  // answer contains { choice, confidence, probabilities }.
  const answers = asRecord(resultObj.answers);
  const intentAnswer = answers?.intent;
  const tierAnswer = answers?.tier;
  const answeredIntent = choiceValue(intentAnswer);
  if (isClefIntent(answeredIntent)) {
    const answeredTier = choiceValue(tierAnswer);
    return {
      intent: answeredIntent,
      tier: answeredTier === 'balanced' ? 'balanced' : 'low',
      confidence: confidenceValue(intentAnswer)
    };
  }

  // Check if Clef returned a direct structured decision.
  if (isClefIntent(resultObj.intent)) {
    return {
      intent: resultObj.intent,
      tier: resultObj.tier === 'balanced' ? 'balanced' : 'low',
      confidence: typeof resultObj.confidence === 'number' ? Math.max(0, Math.min(1, resultObj.confidence)) : 0.9
    };
  }

  // Check if Clef returned structured choice probability distributions.
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

function cloudflareErrorDetail(body: unknown): string {
  const record = asRecord(body);
  const errors = Array.isArray(record?.errors) ? record.errors : [];
  const details = errors.map((entry) => {
    const item = asRecord(entry);
    if (!item) return '';
    const code = typeof item.code === 'string' || typeof item.code === 'number' ? String(item.code) : '';
    const message = typeof item.message === 'string' ? item.message : '';
    return [code, message].filter(Boolean).join(': ');
  }).filter(Boolean);
  return details.join('; ').slice(0, 240);
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
      const detail = cloudflareErrorDetail(result);
      throw new PipelineError(
        response.status === 429 || response.status >= 500 ? 'transient' : 'permanent',
        'handle',
        `Cloudflare model request failed (${response.status})${detail ? `: ${detail}` : ''}.`
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
    selectedText
      ? `Selected text in focused window (this text is the edit target):\n${selectedText.slice(0, 8_000)}`
      : 'Selected text: None (cursor only)'
  ].join('\n');

  const questions = {
    intent: {
      type: 'choice',
      instructions: 'Determine what action the user wants to execute.',
      criteria: {
        image_generate: 'User wants to generate, draw, design, or create an image or photo',
        text_rewrite: 'User selected text and asks to edit, rewrite, fix, translate, or transform it',
        text_query: 'User asks a question, requests code, or asks assistant to generate text from scratch',
        plain_dictation: 'User is speaking normal speech to write directly at the cursor'
      }
    },
    tier: {
      type: 'choice',
      instructions: 'Select model tier: low uses fewer neurons for standard tasks, balanced for complex ones.',
      criteria: {
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
        model: 'clef',
        state: deciderState,
        questions
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
  let text = raw.replace(/\r\n?/g, '\n').replace(/\u0000/g, '').trim();

  // Strip labels the model may add even though the prompt forbids them.
  text = text.replace(
    /^\s*(?:[*_]{1,3})?(?:here is |here's )?(?:the )?(?:rewritten|edited|revised|transformed|improved|professional|formal|final)?\s*(?:text|version|output)?\s*(?:[*_]{1,3})?\s*:\s*/i,
    ''
  );

  // A plain-text rewrite must never include a markdown/code section.
  const codeBlockIndex = text.search(/\x60\x60\x60/);
  if (codeBlockIndex !== -1) {
    const naturalLead = text.slice(0, codeBlockIndex).trim();
    const fencedBody = text.match(/^\x60\x60\x60(?:[a-zA-Z0-9_+-]+)?\s*([\s\S]*?)\s*\x60\x60\x60/);
    text = naturalLead || fencedBody?.[1]?.trim() || '';
  }

  // Stop at model self-review. Some instruction-tuned models answer the edit,
  // then start evaluating their own answer and repeat it indefinitely.
  text = text.replace(
    /\s+(?:I\s+(?:made|did)\s+no\s+changes|the\s+(?:original\s+)?response\s+(?:is|already)|the\s+final\s+answer\s+(?:is|does)|the\s+response\s+(?:is|already)|(?:no|there\s+are\s+no)\s+(?:further|additional)\s+changes)\b[\s\S]*$/i,
    ''
  ).trim();

  // Handle malformed model output such as repeated single backticks.
  text = text.replace(/(?:\s*\x60){1,}\s*$/g, '').trim();
  text = text.replace(/\n\s*(?:explanation|implementation|here is the code|here's the code)\s*:\s*[\s\S]*$/i, '').trim();

  // If a model repeated the same complete sentence, keep one copy only.
  const sentences = text.match(/[^.!?]+[.!?]+/g) ?? [];
  if (sentences.length >= 2) {
    const counts = new Map<string, number>();
    for (const sentence of sentences) {
      const key = sentence.replace(/\s+/g, ' ').trim().toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const repeated = sentences.find((sentence) => {
      const key = sentence.replace(/\s+/g, ' ').trim().toLowerCase();
      return (counts.get(key) ?? 0) >= 2;
    });
    if (repeated) text = repeated.trim();
  }

  // Strip wrapping quotes if the whole text was enclosed in quotes by the model.
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    if (text.length >= 2) {
      text = text.slice(1, -1).trim();
    }
  }

  return text;
}

function containsUnexpectedCode(text: string): boolean {
  return /(?:^|\n)\s*(?:import\s+[a-z_$]|from\s+[a-z_$].*\s+import\s+|def\s+[a-z_$][\w$]*\s*\(|function\s+[a-z_$][\w$]*\s*\(|(?:const|let|var)\s+[a-z_$][\w$]*\s*=)/im.test(text)
    || /\b(?:re\.sub|rewrite_text\s*\(|print\s*\()/i.test(text);
}

function isCompressionRewrite(command: string): boolean {
  return /\b(?:summari[sz]e|summary|shorten|shorter|concise|brief|condense|simplify|reduce|compress|tl\s*;?\s*dr|one\s+sentence)\b/i.test(command);
}

function wordCount(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function isLikelyIncompleteRewrite(source: string, result: string, command: string): boolean {
  if (isCompressionRewrite(command)) return false;
  const sourceWords = wordCount(source);
  const resultWords = wordCount(result);
  if (sourceWords < 18) return false;
  return resultWords < Math.max(8, Math.floor(sourceWords * 0.45));
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

  const selectedModel = input.tier === 'balanced'
    ? CLOUDFLARE_CLEF_BALANCED_MODEL
    : input.tier === 'fast'
      ? CLOUDFLARE_CLEF_FAST_MODEL
      : CLOUDFLARE_CLEF_LOW_MODEL;

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
    const decision = await decideWithCloudflareClef(
      accountId,
      apiToken,
      { command, selectedText },
      'text_rewrite',
      signal
    );
    tier = decision.tier;
    mode = decision.intent === 'text_query' ? 'respond' : 'rewrite';
  }

  const selectedModel = tier === 'balanced'
    ? CLOUDFLARE_CLEF_BALANCED_MODEL
    : tier === 'fast'
      ? CLOUDFLARE_CLEF_FAST_MODEL
      : CLOUDFLARE_CLEF_LOW_MODEL;
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
        '3. NEVER provide code, scripts, Python, regex, explanations, or a rewrite procedure.',
        '4. Do not include labels such as Rewritten text: or Final answer:.',
        '5. Do not wrap the result in markdown code fences, backticks, or quotes.',
        '6. Return exactly one transformed version, never repeat it.',
        '7. Unless the instruction explicitly asks for a summary or shorter text, preserve every fact, question, greeting, and idea from the selected text.',
        '8. Do not replace a multi-idea paragraph with only its first greeting or first sentence.',
        '9. Do not evaluate, explain, or defend your answer.',
        '10. Stop immediately after the replacement text is complete.'
      ].join('\n');

  const userContent = [
    '<instruction>',
    command,
    '</instruction>',
    '',
    '<selected_text>',
    selectedText,
    '</selected_text>',
    '',
    'Return only the transformed selected text. Do not describe the changes.'
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
      max_tokens: 600,
      temperature: 0.15
    },
    45_000,
    signal
  );

  const rawText = parseModelTextResponse(rawResult);
  let rewritten = isCodeRequested ? rawText.trim() : cleanRewrittenText(rawText);

  // Balanced models can occasionally stop after the first clause. Retry once
  // with an explicit preservation instruction before touching the selection.
  if (!isCodeRequested && isLikelyIncompleteRewrite(selectedText, rewritten, command)) {
    console.warn('Cloudflare rewrite appeared incomplete; retrying with meaning-preservation instructions.');
    const retryResult = await runCloudflareModel(
      accountId,
      apiToken,
      selectedModel,
      {
        messages: [
          { role: 'system', content: `${systemInstructions}\n\nIMPORTANT: This is not a summary request. Preserve every idea and clause from the selected text. Return the complete professional rewrite, not only the greeting or first sentence.` },
          { role: 'user', content: userContent }
        ],
        max_tokens: 900,
        temperature: 0.05
      },
      45_000,
      signal
    );
    const retryText = cleanRewrittenText(parseModelTextResponse(retryResult));
    if (!isLikelyIncompleteRewrite(selectedText, retryText, command)) {
      rewritten = retryText;
    } else {
      throw new PipelineError('transient', 'handle', 'Cloudflare returned an incomplete rewrite. Please try the command again.');
    }
  }

  if (!isCodeRequested && containsUnexpectedCode(rewritten)) {
    throw new PipelineError('permanent', 'handle', 'Cloudflare returned an invalid rewrite response. Please try the command again.');
  }
  if (!rewritten.trim()) {
    throw new PipelineError('permanent', 'handle', 'Cloudflare returned an empty rewrite response.');
  }
  return { text: rewritten.trim(), model: selectedModel, tier: tier ?? 'low', mode };
}
