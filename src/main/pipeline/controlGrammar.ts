import { isImageGenerationRequest } from './intent';
import { MAX_PLAN_STEPS, normalizeCombo, type Action, type Plan } from '../control/actions';

/**
 * Local grammar for spoken computer-control commands. It runs after the wake
 * phrase has been removed and before any model is consulted, so the common
 * commands ("open downloads", "click save", "scroll down") cost no network
 * round trip. Anything it does not understand returns undefined and falls
 * through to the CLEF decider and the LLM planner.
 */

const MAX_WORDS = 16;

const QUERY_LEAD = /^(?:please\s+)?(?:give me|provide|generate|write|draft|compose|produce|explain|calculate|solve|answer|help me|tell me|what|why|how|who|when|where|which)\b/i;
/** Words that mean the sentence is describing something, not commanding it ("open source software has a long history"). */
const NARRATIVE = /\b(?:has|have|had|was|were|will|would|should|does|did|because|although|but)\b|\bopen[\s-]source\b/i;
const MULTI_STEP = /\b(?:and then|after that|afterwards|then|and (?:click|open|type|press|scroll|go|select|switch|close|search|play|send))\b/i;

function clean(raw: string): string {
  let text = raw.trim().replace(/\s+/g, ' ');
  let previous = '';
  while (text !== previous) {
    previous = text;
    text = text
      .replace(/^(?:(?:okay|ok|so|well|um|uh|hmm|please|kindly|just|hey|and)[\s,]+)+/i, '')
      .replace(/^(?:can|could|would|will)\s+you\s+(?:please\s+)?/i, '')
      .replace(/^(?:i\s+(?:want|need|would\s+like)\s+you\s+to\s+)/i, '')
      .replace(/^go\s+ahead\s+and\s+/i, '')
      .replace(/[\s,]*(?:for\s+me|please|now|right\s+now|quickly|real\s+quick|thanks|thank\s+you)$/i, '')
      .replace(/[.!?,;:\s]+$/g, '')
      .trim();
  }
  return text;
}

const MODIFIERS: Record<string, string> = { control: 'ctrl', ctrl: 'ctrl', alt: 'alt', option: 'alt', shift: 'shift', windows: 'win', win: 'win', command: 'win' };
const NAMED_KEYS: Record<string, string> = {
  enter: 'enter', return: 'enter', escape: 'esc', esc: 'esc', tab: 'tab', space: 'space', spacebar: 'space',
  backspace: 'backspace', delete: 'delete', del: 'delete', home: 'home', end: 'end', pageup: 'pageup', pagedown: 'pagedown',
  up: 'up', down: 'down', left: 'left', right: 'right'
};

/** Converts a spoken key description ("control shift t", "page down", "the enter key") to a combo like "ctrl+shift+t". */
export function parseSpokenKey(spoken: string): string | undefined {
  const text = spoken
    .toLowerCase()
    .replace(/[^a-z0-9+\s]/g, ' ')
    .replace(/\bpage\s+up\b/g, 'pageup')
    .replace(/\bpage\s+down\b/g, 'pagedown')
    .replace(/\b(up|down|left|right)\s+arrow\b/g, '$1')
    .replace(/\barrow\s+(up|down|left|right)\b/g, '$1')
    .replace(/\b(?:the|key|button|plus|and)\b/g, ' ');
  const words = text.split(/[\s+]+/).filter(Boolean);
  if (words.length === 0 || words.length > 4) return undefined;
  const key = words[words.length - 1];
  const modifiers = words.slice(0, -1);
  if (!modifiers.every((word) => word in MODIFIERS)) return undefined;
  let main: string | undefined = NAMED_KEYS[key];
  if (!main && /^f(?:[1-9]|1[0-2])$/.test(key)) main = key;
  if (!main && /^[a-z0-9]$/.test(key)) main = key;
  if (!main && key in MODIFIERS) return undefined;
  if (!main) return undefined;
  const mods = [...new Set(modifiers.map((word) => MODIFIERS[word]))];
  return normalizeCombo([...mods, main].join('+'));
}

const SIMPLE_COMMANDS: Array<[RegExp, Action]> = [
  [/^select all$/i, { verb: 'key', combo: 'ctrl+a' }],
  [/^copy(?: that| this| it| selection)?$/i, { verb: 'key', combo: 'ctrl+c' }],
  [/^cut(?: that| this| it)?$/i, { verb: 'key', combo: 'ctrl+x' }],
  [/^paste(?: that| this| it| here)?$/i, { verb: 'key', combo: 'ctrl+v' }],
  [/^undo(?: that| this| it)?$/i, { verb: 'key', combo: 'ctrl+z' }],
  [/^redo(?: that| this| it)?$/i, { verb: 'key', combo: 'ctrl+y' }],
  [/^save(?: this| it| the file| the document)?$/i, { verb: 'key', combo: 'ctrl+s' }],
  [/^(?:open (?:a )?)?new tab$/i, { verb: 'key', combo: 'ctrl+t' }],
  [/^(?:next|switch to (?:the )?next) tab$/i, { verb: 'key', combo: 'ctrl+tab' }],
  [/^(?:previous|switch to (?:the )?previous) tab$/i, { verb: 'key', combo: 'ctrl+shift+tab' }],
  [/^(?:refresh|reload)(?: the)?(?: page| tab)?$/i, { verb: 'key', combo: 'f5' }],
  [/^go back$/i, { verb: 'key', combo: 'alt+left' }],
  [/^go forward$/i, { verb: 'key', combo: 'alt+right' }],
  [/^close (?:this |the |current )?tab$/i, { verb: 'key', combo: 'ctrl+w' }],
  [/^close (?:this |the |current )?(?:window|app|application|program)$/i, { verb: 'window', op: 'close' }],
  [/^(?:minimi[sz]e)(?: this| the| current| that)?(?: window| app)?$/i, { verb: 'window', op: 'minimize' }],
  [/^(?:maximi[sz]e)(?: this| the| current| that)?(?: window| app)?$/i, { verb: 'window', op: 'maximize' }],
  [/^(?:restore)(?: this| the| current| that)?(?: window| app)?$/i, { verb: 'window', op: 'restore' }],
  [/^show (?:the )?desktop$/i, { verb: 'key', combo: 'win+d' }]
];

const DOMAIN = /^(?:https?:\/\/)?(?:www\.)?[a-z0-9][a-z0-9-]{0,62}(?:\.[a-z0-9-]{2,24})+(?:\/\S*)?$/i;

function spokenDomain(target: string): string | undefined {
  const joined = target.trim().replace(/\s+dot\s+/gi, '.').replace(/\s*\.\s*/g, '.').replace(/\s+/g, '');
  if (!/\.[a-z]{2,24}(?:\/|$)/i.test(joined)) return undefined;
  return DOMAIN.test(joined) ? joined : undefined;
}

function parseOpen(rest: string): Action | undefined {
  let text = rest.trim();
  let drive: string | undefined;
  let hint: 'folder' | 'app' | 'site' | 'drive' | 'file' | 'any' = 'any';

  const domain = spokenDomain(text.replace(/^(?:the\s+)?(?:website|site|web\s*page|page)\s+/i, ''));
  if (domain) return { verb: 'open_url', url: /^https?:\/\//i.test(domain) ? domain : `https://${domain}` };

  const driveWhole = /^(?:the\s+|my\s+|that\s+|this\s+)?(?:(?:drive\s+([a-z])\b:?)|(?:([a-z])\b:?\s*drive))$/i.exec(text);
  if (driveWhole) {
    const letter = (driveWhole[1] ?? driveWhole[2]).toUpperCase();
    return { verb: 'open', target: `${letter}:`, drive: letter, hint: 'drive' };
  }

  const driveInside = /\b(?:in|on|from|inside|under|within|of)\s+(?:the\s+|that\s+|this\s+|my\s+)?(?:(?:drive\s+([a-z])\b:?)|(?:([a-z])\b:?\s*drive)|(?:([a-z])\s+colon))\b/i.exec(text);
  if (driveInside) {
    drive = (driveInside[1] ?? driveInside[2] ?? driveInside[3]).toUpperCase();
    text = `${text.slice(0, driveInside.index)} ${text.slice(driveInside.index + driveInside[0].length)}`;
  }

  if (/\b(?:folder|directory)\b/i.test(text)) hint = 'folder';
  else if (/\b(?:app|application|program|software)\b/i.test(text)) hint = 'app';
  else if (/\b(?:website|web\s*site|site|web\s*page)\b/i.test(text)) hint = 'site';
  else if (/\bfile\b/i.test(text)) hint = 'file';

  text = text
    .replace(/\b(?:folder|directory|app|application|program|software|website|web\s*site|site|web\s*page|file|called|named|which\s+is|that\s+is|present|located|situated|there|over\s+there)\b/gi, ' ')
    .replace(/\b(?:the|that|this|my|a|an|up)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text && drive) return { verb: 'open', target: `${drive}:`, drive, hint: 'drive' };
  if (!text) return undefined;
  return { verb: 'open', target: text, ...(drive ? { drive } : {}), hint };
}

function scrollAction(rest: string): Action {
  const text = rest.toLowerCase();
  const direction: 'up' | 'down' = /\b(?:up|top)\b/.test(text) ? 'up' : 'down';
  let amount: 'small' | 'page' | 'top' | 'bottom' = 'small';
  if (/\btop\b/.test(text)) amount = 'top';
  else if (/\bbottom\b/.test(text)) amount = 'bottom';
  else if (/\bpage\b|\ba lot\b|\bfar\b|\bmore\b/.test(text)) amount = 'page';
  return { verb: 'scroll', direction, amount };
}

function stripRoleWords(target: string): string {
  return target
    .replace(/^(?:the|that|this|a|an)\s+/i, '')
    .replace(/\s+(?:button|icon|link|option|tab|menu|item|checkbox|field|box|entry)$/i, '')
    .trim();
}

export function parseControlCommand(original: string): Plan | undefined {
  const text = clean(original);
  if (!text) return undefined;
  if (text.split(/\s+/).length > MAX_WORDS) return undefined;
  if (QUERY_LEAD.test(text) || isImageGenerationRequest(text)) return undefined;
  if (MULTI_STEP.test(text) || NARRATIVE.test(text)) return undefined;

  for (const [pattern, action] of SIMPLE_COMMANDS) {
    if (pattern.test(text)) return { steps: [action], summary: text };
  }

  let match = /^scroll\b(.*)$/i.exec(text) ?? /^page\s+(up|down)$/i.exec(text);
  if (match) {
    const action = text.toLowerCase().startsWith('page') ? scrollAction(`${match[1]} page`) : scrollAction(match[1] ?? '');
    return { steps: [action], summary: text };
  }

  match = /^type(?:\s+out)?\s+(.+)$/i.exec(text);
  if (match) return { steps: [{ verb: 'type', text: match[1].trim() }], summary: 'Type text' };

  match = /^(?:press|hit|push)\s+(.+)$/i.exec(text);
  if (match) {
    const combo = parseSpokenKey(match[1]);
    if (combo) return { steps: [{ verb: 'key', combo }], summary: `Press ${combo}` };
  }

  match = /^(double[\s-]?click|right[\s-]?click|click|tap|select|choose|press|hit|push)\s+(?:on\s+)?(.+)$/i.exec(text);
  if (match) {
    const kind = match[1].toLowerCase().replace(/[\s-]/g, '');
    const query = stripRoleWords(match[2]);
    if (!query) return undefined;
    const step: Action = {
      verb: 'ui_click',
      query,
      ...(kind === 'doubleclick' ? { double: true } : {}),
      ...(kind === 'rightclick' ? { button: 'right' as const } : {})
    };
    return { steps: [step], summary: `Click ${query}` };
  }

  match = /^(?:switch|jump|swap|flip|alt\s*tab)\s+(?:back\s+)?to\s+(.+)$/i.exec(text) ?? /^(?:focus|activate)\s+(?:on\s+)?(.+)$/i.exec(text);
  if (match) {
    const query = match[1].replace(/^(?:the|my|that|this)\s+/i, '').replace(/\s+(?:window|app|application)$/i, '').trim();
    if (query) return { steps: [{ verb: 'focus_window', query }], summary: `Switch to ${query}` };
  }

  match = /^(?:open(?:\s+up)?|launch|start|run|take\s+me\s+to|bring\s+up|pull\s+up|go\s+(?:to|into)|navigate\s+to|browse\s+to|visit)\s+(.+)$/i.exec(text);
  if (match) {
    const action = parseOpen(match[1]);
    if (action) return { steps: [action], summary: text };
  }

  return undefined;
}

export function assertPlanSize(plan: Plan): boolean {
  return plan.steps.length >= 1 && plan.steps.length <= MAX_PLAN_STEPS;
}

/** True when the sentence starts with an explicit control verb; used to skip selection capture for commands. */
export function looksLikeControlCommand(original: string): boolean {
  return parseControlCommand(original) !== undefined;
}

