import { describe, expect, it } from 'vitest';
import { parseControlCommand } from '../src/main/pipeline/controlGrammar';
import { gateTranscriptDetailed } from '../src/main/pipeline/gate';
import { heuristicRoute } from '../src/main/pipeline/router';

function route(transcript: string, selectedText = '') {
  const gate = gateTranscriptDetailed(transcript);
  return heuristicRoute({ transcript, source: 'hotkey', gateRouted: gate.routed, gateCommand: gate.text, gateOriginal: gate.original, selectedText });
}

describe('the four shortcut features', () => {
  it.each([
    'I will reach the office by ten tomorrow.',
    'Please let me know if you have any questions about the project.',
    'What time is the meeting tomorrow? I think it is at five.',
    'Tell me when you are free so we can talk.',
    'The code review went well and we can merge today.',
    'The function starts at six in the hall.'
  ])('dictation: %j', (text) => {
    expect(route(text).intent).toBe('plain_dictation');
  });

  it.each([
    ['Make it more professional.', 'hey whats up can u send file'],
    ['Fix the grammar.', 'me and him goes to market'],
    ['Translate this into Hindi.', 'good morning everyone'],
    ['Reframe this sentence.', 'some text'],
    ['Make this shorter.', 'a very long paragraph'],
    ['Summarize this.', 'long text']
  ])('rewrite of the selection: %j', (text, selected) => {
    expect(route(text, selected).intent).toBe('text_rewrite');
  });

  it.each([
    'Generate an image of a sunset over mountains.',
    'Can you generate that image of a cat?',
    'Create a picture of a red car.',
    'Draw a dog playing in the park.',
    'Make a logo for my coffee shop.'
  ])('image: %j', (text) => {
    expect(route(text).intent).toBe('image_generate');
  });

  it.each([
    'Write an email to my manager asking for leave tomorrow.',
    'Give me python code for a calculator.',
    'Write a short poem about the rain.',
    'Generate a cover letter for a software engineer job.',
    'Draft a message to my team about the release.',
    'Write a paragraph about climate change.',
    'Explain what an API is.',
    'Can you write a LinkedIn post about my new job?',
    'Create a to do list for my trip.'
  ])('content: %j', (text) => {
    expect(route(text).intent).toBe('text_query');
  });

  it.each(['Open VS Code.', 'Can you open the VS Code?', 'Open this PC.', 'Open the recycle bin.', 'Open Antigravity.'])('shortcut open command (tentative): %j', (text) => {
    expect(route(text)).toMatchObject({ intent: 'computer_control', tentative: true });
  });
});

describe('open targets whose names contain stripped words', () => {
  it.each(['open this PC', 'open my computer', 'open this laptop'])('%j opens This PC', (spoken) => {
    expect(parseControlCommand(spoken)?.steps[0]).toMatchObject({ verb: 'open', target: 'this pc' });
  });
  it.each(['open file explorer', 'open Windows Explorer'])('%j opens File Explorer as an app', (spoken) => {
    expect(parseControlCommand(spoken)?.steps[0]).toMatchObject({ verb: 'open', target: 'File Explorer', hint: 'app' });
  });
});
