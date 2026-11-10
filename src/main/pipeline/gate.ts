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

const GREETINGS = new Set(['hey', 'hay', 'hei', 'he', 'a', 'hi', 'hai', 'hello', 'ok', 'okay', 'yo']);
const NAME_VARIANTS = new Set([
  'tawny', 'tawney', 'tawni', 'tawnie', 'tawnee', 'tauni', 'tauny', 'taunie', 'tauney', 'tanny', 'tani', 'taani', 'tanni', 'tonny', 'tony', 'toni', 'tonie', 'tonee', 'torni', 'tarni'
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

/** "heytawny" / "hitawny": Whisper sometimes writes the phrase as one word. */
function joinedWake(token: string): boolean {
  const match = /^(?:hey|hi|he|hay|ok|okay)(.{4,7})$/.exec(token);
  return Boolean(match && isTawnyName(match[1]));
}

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

/**
 * Confirms the wake phrase in Whisper's transcript of a hands-free clip and
 * returns what follows it. More forgiving than splitWakePhrase, which watches
 * the live room audio. Accepted openings, after at most one stray word (the clip's
 * pre-roll can catch the tail of an earlier sound) and any fillers:
 *   greeting + name   "Hey Tawny, ...", "A Tawny ..."
 *   joined            "HeyTawny ..."
 *   name alone        "Tawny, ..." (the clip started just after "hey")
 * The local recognizer has already heard the phrase before this runs, so this
 * check confirms rather than detects. A phrase buried later in a sentence is
 * conversation about Tawny, not a command to it.
 */
export function confirmWakePhrase(transcript: string): WakeSplit {
  // "Hey-Tawny" and "D-Drive" split into words; the command keeps the spaced form.
  const words = transcript.trim().replace(/(\p{L})[-–](\p{L})/gu, '$1 $2').split(/\s+/).filter(Boolean);
  const tokens = words.map((word) => normalize(word));
  const routedFrom = (restStart: number): WakeSplit => {
    const rest = words.slice(restStart);
    return {
      routed: true,
      command: rest.map((word) => normalize(word)).filter(Boolean).join(' '),
      original: rest.join(' ').trim()
    };
  };
  let start = 0;
  let strays = 0;
  while (start < tokens.length) {
    const token = tokens[start];
    const next = tokens[start + 1];
    if (!token) {
      start += 1;
      continue;
    }
    if (GREETINGS.has(token) && next && isTawnyName(next)) return routedFrom(start + 2);
    if (joinedWake(token) || isTawnyName(token)) return routedFrom(start + 1);
    if (LEADING_FILLERS.has(token)) {
      start += 1;
      continue;
    }
    if (strays >= 1 || start >= 3) break;
    strays += 1;
    start += 1;
  }
  return { routed: false, command: tokens.filter(Boolean).join(' '), original: transcript.trim() };
}

const SEND_PHRASE_TAIL = /[\s,;:-]*(?:(?:hey|hay|hi|ok|okay|yo)[\s,.;:!?-]+)?(?:tawny|tawney|tawni|tawnie|tauni|tauny|tanny|tonny|tony|toni)[\s,.;:!?-]*send[\s,.;:!?-]+(?:it|that|this|now)[\s.!?]*$/i;

/** Removes a trailing "(hey) tawny send it" that ended the utterance. */
export function stripSendPhrase(text: string): { text: string; hadSendPhrase: boolean } {
  const stripped = text.replace(SEND_PHRASE_TAIL, '').trim();
  return { text: stripped, hadSendPhrase: stripped.length !== text.trim().length };
}

// ---------------------------------------------------------------------------
// The command of a hands-free request
//
// The Windows recognizer on this PC has already heard "Hey Tawny" when a clip
// reaches Whisper, so that wake is the confirmation. People usually say the
// phrase, wait for the orb, then speak, and the clip may begin at the command:
// requiring Whisper to find the phrase again threw those requests away. The
// phrase is removed when Whisper did hear it; otherwise the whole text is the
// command. Whisper's well-known filler on near-silence is not a request.
// ---------------------------------------------------------------------------

const WHISPER_FILLER = new Set([
  'thank you', 'thanks', 'thank you very much', 'thank you so much', 'thanks for watching', 'thank you for watching',
  'thanks for listening', 'thank you for listening', 'here you go', 'bye', 'bye bye', 'goodbye', 'you', 'okay', 'ok',
  'so', 'um', 'uh', 'hmm', 'mm', 'yeah', 'oh', 'ah', 'subscribe', 'please subscribe', 'i m sorry', 'sorry'
]);

export interface WakeCommand {
  /** False when nothing usable was said after the wake phrase. */
  ok: boolean;
  /** Normalized command (lower case, no punctuation). */
  text: string;
  /** The command as spoken, original casing and punctuation. */
  original: string;
  /** Whisper's transcript included the wake phrase. */
  heardWakePhrase: boolean;
}

export function commandFromWakeTranscript(transcript: string): WakeCommand {
  const spoken = stripSendPhrase(transcript).text;
  const split = confirmWakePhrase(spoken);
  const original = (split.routed ? split.original : spoken).trim().replace(/^[\s,.;:!?-]+/, '');
  const text = normalize(original);
  const ok = text.length > 0 && !WHISPER_FILLER.has(text) && !isTawnyName(text);
  return { ok, text, original, heardWakePhrase: split.routed };
}
