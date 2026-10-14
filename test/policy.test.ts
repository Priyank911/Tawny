import { describe, expect, it } from 'vitest';
import { chooseAction } from '../src/main/pipeline/policy';
import { gateTranscript } from '../src/main/pipeline/gate';
import { isImageGenerationRequest } from '../src/main/pipeline/intent';

const decision = (confidence: number, isRequest: number, intent: 'image_generate' | 'plain_text' | 'other_task' = 'image_generate') => ({
  confidence, isRequest, intent, probs: { image_generate: confidence }, decidedBy: 'test', latencyMs: 1
});

describe('gateTranscript', () => {
  it('strips fuzzy wake phrases', () => expect(gateTranscript('hey body make a sunset')).toEqual({ routed: true, text: 'make a sunset' }));
  it('accepts a wake phrase after a short filler', () => expect(gateTranscript('okay hey buddy make a sunset')).toEqual({ routed: true, text: 'make a sunset' }));
  it('accepts the Tawny wake phrase variant', () => expect(gateTranscript('hey tawny make a sunset')).toEqual({ routed: true, text: 'make a sunset' }));
  it('keeps normal dictation out of the agent route', () => expect(gateTranscript('write a line about drawing')).toEqual({ routed: false, text: 'write a line about drawing' }));
});

describe('chooseAction', () => {
  it('dictates low confidence', () => expect(chooseAction(decision(.3, .9))).toEqual({ type: 'dictate' }));
  it('confirms uncertain image intent', () => expect(chooseAction(decision(.6, .8))).toMatchObject({ type: 'confirm' }));
  it('runs a confident image request', () => expect(chooseAction(decision(.95, .9))).toEqual({ type: 'run', intent: 'image_generate' }));
  it('forces confirmation when providers disagree', () => expect(chooseAction(decision(.95, .9), undefined, true)).toMatchObject({ type: 'confirm' }));
});

describe('isImageGenerationRequest', () => {
  it('recognizes image creation without a wake phrase', () => expect(isImageGenerationRequest('Can you create an image of a sunset?')).toBe(true));
  it('recognizes image nouns with an "of" description', () => expect(isImageGenerationRequest('Make a picture of a cabin')).toBe(true));
  it('does not route a negated image request', () => expect(isImageGenerationRequest("Do not make an image")).toBe(false));
  it('keeps ordinary dictation as text', () => expect(isImageGenerationRequest('Write a note about the sunset')).toBe(false));
});
