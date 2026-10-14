const WAKE_PHRASES = ['hey buddy', 'hi buddy', 'hey body', 'hey tawny'];

function normalize(value: string): string {
  return value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

function distance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const previous = row[j];
      row[j] = left[i - 1] === right[j - 1]
        ? diagonal
        : Math.min(row[j - 1] + 1, row[j] + 1, diagonal + 1);
      diagonal = previous;
    }
  }
  return row[right.length];
}

export function gateTranscript(transcript: string, alwaysRoute = false): { routed: boolean; text: string } {
  const text = normalize(transcript);
  if (alwaysRoute) return { routed: true, text };
  const tokens = text ? text.split(' ') : [];
  for (let start = 0; start <= Math.min(2, tokens.length - 2); start += 1) {
    for (const phrase of WAKE_PHRASES) {
      const phraseTokens = phrase.split(' ');
      const candidate = tokens.slice(start, start + phraseTokens.length).join(' ');
      if (distance(candidate, phrase) <= 2) {
        return { routed: true, text: tokens.slice(start + phraseTokens.length).join(' ').trim() };
      }
    }
  }
  return { routed: false, text };
}
