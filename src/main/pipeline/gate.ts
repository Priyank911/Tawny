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

export interface DetailedGate {
  routed: boolean;
  /** Normalized command after the wake phrase. */
  text: string;
  /** The same remainder with the speaker's own capitalization and punctuation. */
  original: string;
}

export function gateTranscriptDetailed(transcript: string, alwaysRoute = false): DetailedGate {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const tokens: string[] = [];
  const tokenWord: number[] = [];
  words.forEach((word, index) => {
    for (const token of normalize(word).split(' ').filter(Boolean)) {
      tokens.push(token);
      tokenWord.push(index);
    }
  });
  const text = tokens.join(' ');
  if (alwaysRoute) return { routed: true, text, original: transcript.trim() };
  for (let start = 0; start <= Math.min(2, tokens.length - 2); start += 1) {
    for (const phrase of WAKE_PHRASES) {
      const phraseTokens = phrase.split(' ');
      const candidate = tokens.slice(start, start + phraseTokens.length).join(' ');
      if (distance(candidate, phrase) <= 2) {
        const remainderStart = start + phraseTokens.length;
        return {
          routed: true,
          text: tokens.slice(remainderStart).join(' ').trim(),
          original: remainderStart < tokens.length ? words.slice(tokenWord[remainderStart]).join(' ') : ''
        };
      }
    }
  }
  return { routed: false, text, original: transcript.trim() };
}

export function gateTranscript(transcript: string, alwaysRoute = false): { routed: boolean; text: string } {
  const { routed, text } = gateTranscriptDetailed(transcript, alwaysRoute);
  return { routed, text };
}

// ---------------------------------------------------------------------------
// Hands-free wake phrase handling
//
// The hotkey gate above is deliberately forgiving (a whole-phrase edit distance
// of 2, and "hey buddy" counts). Hands-free mode listens to a live room, so it
// uses a stricter rule: an explicit greeting word followed by a name that is
// "tawny" or a known mishearing of it. Anything else is room noise and is
// discarded without a model call.
// ---------------------------------------------------------------------------

const GREETINGS = new Set(['hey', 'hay', 'hi', 'hai', 'ok', 'okay', 'yo']);
const NAME_VARIANTS = new Set([
  'tawny', 'tawney', 'tawni', 'tawnie', 'tauni', 'tauny', 'taunie', 'tauney', 'tanny', 'tonny', 'tony', 'toni', 'tonie', 'tonee'
]);

export function isTawnyName(token: string): boolean {
  return NAME_VARIANTS.has(token) || (token.length >= 4 && token.length <= 6 && distance(token, 'tawny') <= 1);
}

export interface WakeSplit {
  routed: boolean;
  /** Normalized (lower case, no punctuation) command that follows the wake phrase. */
  command: string;
  /** The same command with the speaker's original capitalization and punctuation. */
  original: string;
}

const LEADING_FILLERS = new Set(['uh', 'um', 'er', 'so', 'and', 'well', 'hmm', 'oh', 'okay', 'ok']);

/**
 * Detects "hey tawny" at the very start of a hands-free clip (optionally after
 * one filler word) and returns what follows it. A phrase buried later in a
 * sentence is conversation about Tawny, not a command to it.
 */
export function splitWakePhrase(transcript: string): WakeSplit {
  const words = transcript.trim().split(/\s+/).filter(Boolean);
  const tokens = words.map((word) => normalize(word));
  const lastStart = tokens.length > 1 && LEADING_FILLERS.has(tokens[0]) ? 1 : 0;
  for (let start = 0; start <= Math.min(lastStart, words.length - 2); start += 1) {
    const greeting = tokens[start];
    const name = tokens[start + 1];
    if (greeting && name && GREETINGS.has(greeting) && isTawnyName(name)) {
      const rest = words.slice(start + 2);
      return {
        routed: true,
        command: rest.map((word) => normalize(word)).filter(Boolean).join(' '),
        original: rest.join(' ').trim()
      };
    }
  }
  return { routed: false, command: tokens.filter(Boolean).join(' '), original: transcript.trim() };
}

const SEND_PHRASE_TAIL = /[\s,;:-]*(?:(?:hey|hay|hi|ok|okay|yo)[\s,.;:!?-]+)?(?:tawny|tawney|tawni|tawnie|tauni|tauny|tanny|tonny|tony|toni)[\s,.;:!?-]*send[\s,.;:!?-]+(?:it|that|this|now)[\s.!?]*$/i;

/** Removes a trailing "(hey) tawny send it" that ended the utterance. */
export function stripSendPhrase(text: string): { text: string; hadSendPhrase: boolean } {
  const stripped = text.replace(SEND_PHRASE_TAIL, '').trim();
  return { text: stripped, hadSendPhrase: stripped.length !== text.trim().length };
}
