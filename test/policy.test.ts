import { describe, expect, it } from 'vitest';
import { chooseAction } from '../src/main/pipeline/policy';
import { gateTranscript } from '../src/main/pipeline/gate';
import { isExplicitTextQueryRequest, isFastRewriteRequest, isImageGenerationRequest, isTextQueryRequest, isTextRewriteRequest, stripFastRewritePrefix } from '../src/main/pipeline/intent';

const decision = (confidence: number, isRequest: number, intent: 'image_generate' | 'plain_text' | 'other_task' = 'image_generate') => ({
  confidence, isRequest, intent, probs: { image_generate: confidence }, decidedBy: 'test', latencyMs: 1
});

describe('selected-text command dictionary', () => {
  it.each([
    'Can you translate this to Spanish?',
    'Make it professional with grammatical correction',
    'Rewrite this in a casual tone',
    'Fix spelling and punctuation',
    'Transform this to be concise'
  ])('recognizes rewrite intent: %s', (command) => {
    expect(isTextRewriteRequest(command)).toBe(true);
  });

  it('recognizes a question or code request', () => {
    expect(isTextQueryRequest('Can you explain this Python function?')).toBe(true);
  });

  it('requires an explicit generation or answer command for model routing', () => {
    expect(isExplicitTextQueryRequest('give me python code for a calculator')).toBe(true);
    expect(isExplicitTextQueryRequest('what are you doing buddy can you tell me your plan')).toBe(false);
    expect(isExplicitTextQueryRequest('I need to write a message to my friend')).toBe(false);
  });

  it('recognizes and removes the opt-in fast rewrite trigger', () => {
    expect(isFastRewriteRequest('quick make it professional')).toBe(true);
    expect(stripFastRewritePrefix('quick make it professional')).toBe('make it professional');
    expect(isFastRewriteRequest('quick what is the plan')).toBe(false);
  });

  it('does not classify ordinary dictation as an edit request', () => {
    expect(isTextRewriteRequest('Please type this sentence')).toBe(false);
  });
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
