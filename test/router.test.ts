import { describe, expect, it } from 'vitest';
import { gateTranscriptDetailed, gateTranscript, splitWakePhrase, stripSendPhrase } from '../src/main/pipeline/gate';
import { CLASSIFY_MIN_CONFIDENCE, CONTROL_MIN_CONFIDENCE, heuristicRoute, needsSelectionCapture, reconcileIntent, type RouteInput } from '../src/main/pipeline/router';

function input(transcript: string, over: Partial<RouteInput> = {}): RouteInput {
  const gate = gateTranscriptDetailed(transcript);
  return { transcript, source: 'hotkey', gateRouted: gate.routed, gateCommand: gate.text, gateOriginal: gate.original, selectedText: '', ...over };
}

describe('gate (hotkey path) is unchanged and now keeps original casing', () => {
  it('still returns the legacy shape', () => {
    expect(gateTranscript('hey tawny make a sunset')).toEqual({ routed: true, text: 'make a sunset' });
  });
  it('exposes the original-case remainder', () => {
    expect(gateTranscriptDetailed('Hey Tawny, type Hello World.').original).toBe('type Hello World.');
  });
});

describe('hands-free wake phrase (strict)', () => {
  it('accepts hey tawny and its known mishearings', () => {
    expect(splitWakePhrase('Hey Tawny, open downloads').routed).toBe(true);
    expect(splitWakePhrase('hey tony open downloads').routed).toBe(true);
    expect(splitWakePhrase('okay tawny open downloads').original).toBe('open downloads');
  });
  it('rejects room chatter that the lenient hotkey gate would accept', () => {
    expect(splitWakePhrase('hey buddy how are you').routed).toBe(false);
    expect(splitWakePhrase('hey tiny open downloads').routed).toBe(false);
    expect(splitWakePhrase('hey many people came').routed).toBe(false);
    expect(splitWakePhrase('thank you').routed).toBe(false);
  });
  it('requires the greeting to come first', () => {
    expect(splitWakePhrase('i said hey tawny to him yesterday and he left').routed).toBe(false);
  });
  it('strips a trailing send phrase', () => {
    expect(stripSendPhrase('make a sunset image. Hey Tawny, send it.')).toEqual({ text: 'make a sunset image.', hadSendPhrase: true });
    expect(stripSendPhrase('tawny send it')).toEqual({ text: '', hadSendPhrase: true });
    expect(stripSendPhrase('please send it to John')).toEqual({ text: 'please send it to John', hadSendPhrase: false });
  });
});

describe('heuristic routing', () => {
  it('keeps ordinary hotkey dictation local', () => {
    const route = heuristicRoute(input('I think the meeting is at five tomorrow'));
    expect(route).toMatchObject({ intent: 'plain_dictation', matched: false, consult: 'none' });
  });
  it('routes explicit image, query and rewrite requests to the guardrail path with a tier call', () => {
    expect(heuristicRoute(input('create an image of a red fox'))).toMatchObject({ intent: 'image_generate', matched: true, consult: 'tier' });
    expect(heuristicRoute(input('give me python code for a calculator'))).toMatchObject({ intent: 'text_query', matched: true, consult: 'tier' });
    expect(heuristicRoute(input('make it more professional', { selectedText: 'hey whats up' }))).toMatchObject({ intent: 'text_rewrite', matched: true, consult: 'tier' });
  });
  it('does not rewrite when nothing is selected', () => {
    expect(heuristicRoute(input('make it more professional')).intent).toBe('plain_dictation');
  });
  it('fast rewrite needs no model call to decide', () => {
    expect(heuristicRoute(input('quick fix the grammar', { selectedText: 'me go store' }))).toMatchObject({ intent: 'text_rewrite', fastRewrite: true, consult: 'none' });
  });
  it('without the wake phrase, only shortcut "open X" is considered, and only tentatively', () => {
    // The app types it as dictation unless X exists on the PC (ControlService.canResolve).
    expect(heuristicRoute(input('open the door for me'))).toMatchObject({ intent: 'computer_control', tentative: true });
    expect(heuristicRoute(input('click the update button')).intent).toBe('plain_dictation');
    expect(heuristicRoute(input('type hello world')).intent).toBe('plain_dictation');
    expect(heuristicRoute(input('open downloads', { source: 'wake' })).intent).toBe('plain_dictation');
  });
  it('computer control with the wake phrase is not tentative', () => {
    const route = heuristicRoute(input('hey tawny open downloads'));
    expect(route).toMatchObject({ intent: 'computer_control', matched: true, consult: 'none' });
    expect(route.control?.steps[0]).toMatchObject({ verb: 'open', target: 'downloads' });
    expect(route.tentative).toBeUndefined();
  });
  it('a control verb beats a rewrite-looking word when text is selected', () => {
    const route = heuristicRoute(input('hey tawny click the update button', { selectedText: 'some selected words' }));
    expect(route.intent).toBe('computer_control');
  });
  it('asks the decider only for addressed speech no guardrail matched', () => {
    expect(heuristicRoute(input('hey tawny remind me to buy milk'))).toMatchObject({ intent: 'plain_dictation', matched: false, consult: 'classify' });
    expect(heuristicRoute(input('hey tawny'))).toMatchObject({ consult: 'none' });
  });
});

describe('reconciling the decider', () => {
  const unmatched = heuristicRoute(input('hey tawny put the kettle on in my notes'));
  const decision = (intent: Parameters<typeof reconcileIntent>[1] extends infer D ? (D extends { intent: infer I } ? I : never) : never, confidence = 0.9) => ({ intent, tier: 'low' as const, confidence });
  it('guardrails always win over the decider', () => {
    const matched = heuristicRoute(input('create an image of a red fox'));
    expect(reconcileIntent(matched, decision('plain_dictation'), '').intent).toBe('image_generate');
  });
  it('accepts a confident decision for addressed speech', () => {
    expect(reconcileIntent(unmatched, decision('computer_control'), '')).toEqual({ intent: 'computer_control', reason: 'decider' });
    expect(reconcileIntent(unmatched, decision('text_query'), '').intent).toBe('text_query');
  });
  it('falls back to dictation instead of guessing', () => {
    expect(reconcileIntent(unmatched, decision('computer_control', CONTROL_MIN_CONFIDENCE - 0.05), '').intent).toBe('plain_dictation');
    expect(reconcileIntent(unmatched, decision('text_query', CLASSIFY_MIN_CONFIDENCE - 0.05), '').intent).toBe('plain_dictation');
    expect(reconcileIntent(unmatched, { ...decision('computer_control'), usedFallback: true }, '').intent).toBe('plain_dictation');
    expect(reconcileIntent(unmatched, undefined, '').intent).toBe('plain_dictation');
    expect(reconcileIntent(unmatched, decision('text_rewrite'), '').reason).toBe('nothing-selected');
  });
  it('never consults the decider for unaddressed speech', () => {
    const plain = heuristicRoute(input('just a normal sentence'));
    expect(reconcileIntent(plain, decision('computer_control'), '')).toEqual({ intent: 'plain_dictation', reason: 'not-addressed' });
  });
});

describe('selection capture', () => {
  it('only captures for commands that can be rewrites', () => {
    expect(needsSelectionCapture('make it more formal', 'make it more formal')).toBe(true);
    expect(needsSelectionCapture('open downloads', 'open downloads')).toBe(false);
    expect(needsSelectionCapture('click the update button', 'click the update button')).toBe(false);
    expect(needsSelectionCapture('', '')).toBe(false);
  });
});
