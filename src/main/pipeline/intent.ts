const imageVerb = '(?:create|make|generate|draw|design|produce|render)';
const imageNoun = '(?:an?\\s+)?(?:image|picture|photo|art|illustration|logo)';

export function isImageGenerationRequest(text: string): boolean {
  const normalized = text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || /\b(?:do not|don't|dont|not|never|without)\b[^.?!]{0,24}\b(?:create|make|generate|draw|design|image|picture|photo)\b/.test(normalized)) {
    return false;
  }
  return new RegExp(`\\b${imageVerb}\\s+${imageNoun}\\b`).test(normalized)
    || /\b(?:image|picture|photo|illustration|art|logo)\s+of\b/.test(normalized);
}
