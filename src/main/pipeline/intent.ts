const imageVerb = '(?:create|make|generate|draw|design|produce|render)';
const imageNoun = '(?:an?\\s+)?(?:image|picture|photo|art|illustration|logo)';

// Local dictionary used as a safe fallback when CLEF is unavailable and as a
// guardrail when selected text is clearly the target of an edit request.
const rewritePatterns = [
  /\b(?:rewrite|reword|rephrase|paraphrase|transform|rework|revise|edit|copyedit|polish|improve|refine|proofread|translate|translation|localize|convert|correct|fix|change|update)\b/,
  /\b(?:grammar|grammatical|gramatical|grammer|spelling|punctuation|typo|clarity|tone|style|professional|formal|casual|informal|friendly|polite|concise|shorter|longer|simpler|simplify|summarize|summary|condense|readable|natural|better|clearer)\b/,
  /\b(?:make|turn|change|update|fix|clean)\b.{0,80}\b(?:professional|formal|casual|friendly|clear|concise|shorter|longer|natural|correct|grammatical|gramatical|grammar|tone|style|better|readable)\b/
];

const queryPatterns = [
  /\b(?:what is|what are|why|when|where|who|how do|how can|explain|tell me|give me|can you answer|answer)\b/,
  /\b(?:code|python|javascript|typescript|html|css|sql|function|script|algorithm|regex|calculator|increment|decrement)\b/,
  /\b(?:write|draft|compose|generate|create)\b.{0,80}\b(?:code|function|script|email|message|list|plan|answer|response)\b/
];

// A normal dictated sentence can contain question words. Keep the broader
// semantic detector above for callers that need it, but use this stricter
// dictionary for routing so ordinary speech is never sent to a model just
// because it contains words such as "what", "how", or "tell me".
const explicitQueryPatterns = [
  /^(?:please\s+)?(?:give me|provide|generate|write|draft|compose|show me|produce)\b.{0,100}\b(?:code|function|script|example|email|message|list|plan|answer|response|content)\b/,
  /\b(?:code|python|javascript|typescript|html|css|sql|function|script|algorithm|regex|calculator|increment|decrement)\b/,
  /\b(?:explain|calculate|solve|answer)\b.{0,80}\b(?:this|that|it|question|problem|code|function|example)\b/,
  /\b(?:help me|can you)\b.{0,80}\b(?:write|draft|generate|create|explain|solve|calculate|answer)\b/
];

function normalizeCommand(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

export function isImageGenerationRequest(text: string): boolean {
  const normalized = normalizeCommand(text);
  if (!normalized || /\b(?:do not|don't|dont|not|never|without)\b[^.?!]{0,24}\b(?:create|make|generate|draw|design|image|picture|photo)\b/.test(normalized)) {
    return false;
  }
  return new RegExp(`\\b${imageVerb}\\s+${imageNoun}\\b`).test(normalized)
    || /\b(?:image|picture|photo|illustration|art|logo)\s+of\b/.test(normalized);
}

export function isTextRewriteRequest(text: string): boolean {
  const normalized = normalizeCommand(text);
  return Boolean(normalized) && rewritePatterns.some((pattern) => pattern.test(normalized));
}

export function isTextQueryRequest(text: string): boolean {
  const normalized = normalizeCommand(text);
  return Boolean(normalized) && queryPatterns.some((pattern) => pattern.test(normalized));
}

export function isExplicitTextQueryRequest(text: string): boolean {
  const normalized = normalizeCommand(text);
  return Boolean(normalized) && explicitQueryPatterns.some((pattern) => pattern.test(normalized));
}
