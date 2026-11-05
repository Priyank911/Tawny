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

const fastRewritePrefix = /^(?:quick|quickly|fast|instant|instantly|speedy)\b(?:\s+please)?\s*/i;

function normalizeCommand(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

const IMAGE_VERBS = new Set(['create', 'make', 'generate', 'draw', 'design', 'produce', 'render', 'paint', 'sketch', 'imagine']);
const IMAGE_NOUNS = /^(?:images?|pictures?|pics?|photos?|photographs?|art|artwork|illustrations?|logos?|wallpapers?|posters?|drawings?|paintings?|sketch(?:es)?|icons?)$/;
// Words that end the verb's object: "make a list of image formats" is about images, not one.
const IMAGE_GAP_STOP = new Set(['of', 'about', 'for', 'with', 'from', 'to', 'in', 'on', 'and', 'or', 'but', 'than']);

export function isImageGenerationRequest(text: string): boolean {
  const normalized = normalizeCommand(text);
  if (!normalized || /\b(?:do not|don't|dont|not|never|without)\b[^.?!]{0,24}\b(?:create|make|generate|draw|design|image|picture|photo)\b/.test(normalized)) {
    return false;
  }
  if (/\b(?:image|picture|photo|illustration|art|artwork|logo|wallpaper|painting|drawing)\s+of\b/.test(normalized)) return true;
  // "draw a cat", "paint me a sunset": these verbs make pictures on their own when they lead the request.
  if (/^(?:(?:please|can you|could you|will you|would you)\s+)*(?:draw|paint|sketch)\s+(?:me\s+)?(?:a|an|the|some|my|our)\b/.test(normalized)) return true;
  // A creation verb, up to four words of description, then an image noun: "generate that image", "make me a sunset picture".
  const words = normalized.split(' ');
  for (let i = 0; i < words.length; i += 1) {
    if (!IMAGE_VERBS.has(words[i])) continue;
    for (let j = i + 1; j <= Math.min(words.length - 1, i + 5); j += 1) {
      if (IMAGE_NOUNS.test(words[j])) return true;
      if (IMAGE_GAP_STOP.has(words[j]) || IMAGE_VERBS.has(words[j])) break;
    }
  }
  return false;
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

export function isFastRewriteRequest(text: string): boolean {
  const command = text.trim().replace(fastRewritePrefix, '').trim();
  return command !== text.trim() && isTextRewriteRequest(command);
}

export function stripFastRewritePrefix(text: string): string {
  return text.trim().replace(fastRewritePrefix, '').trim();
}
