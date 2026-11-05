import { describe, expect, it } from 'vitest';
import { parseControlCommand } from '../src/main/pipeline/controlGrammar';
import { assessPlan } from '../src/main/control/actions';

/**
 * 30 spoken commands, written the way people actually talk (Whisper output,
 * original case, punctuation). Twenty must produce the right first step; ten
 * must NOT be treated as computer control, because acting on a sentence that
 * was not a command is worse than missing one that was.
 */
const COMMANDS: Array<[string, string]> = [
  ['Can you open that folder Projects which is present in the D drive?', 'open'],
  ['Open the D drive.', 'open'],
  ['Open my downloads folder', 'open'],
  ['Go to This PC', 'open'],
  ['Launch Chrome.', 'open'],
  ['Open Visual Studio Code', 'open'],
  ['Open github dot com', 'open_url'],
  ['Go to youtube.com', 'open_url'],
  ['Open the recycle bin', 'open'],
  ['Please open the documents folder for me', 'open'],
  ['Click the save button.', 'ui_click'],
  ['Double click on report final', 'ui_click'],
  ['Right click the desktop', 'ui_click'],
  ['Press enter', 'key'],
  ['Press control shift t', 'key'],
  ['Switch to Chrome', 'focus_window'],
  ['Scroll down', 'scroll'],
  ['Scroll to the top', 'scroll'],
  ['Minimize this window', 'window'],
  ['Select all', 'key']
];

const NOT_COMMANDS = [
  'I will open the meeting notes tomorrow and send them to Priya after lunch.',
  'Write a python function that opens a file and reads every line.',
  'Generate an image of a fox sitting by a river at sunset.',
  'The click of the keyboard is too loud in this office.',
  'Tell me how to scroll through a large document faster.',
  'Open source software has a long history and many contributors.',
  'Can you explain what the press release said about the new launch?',
  'I need to switch to a different approach for the quarterly plan.',
  'Rewrite this paragraph so it sounds more formal.',
  'What is the difference between minimize and close in a window manager?'
];

describe('control grammar benchmark', () => {
  it('parses at least 90 percent of realistic commands to the right first verb', () => {
    const misses = COMMANDS.filter(([text, verb]) => parseControlCommand(text)?.steps[0]?.verb !== verb).map(([text]) => text);
    expect(misses).toEqual([]);
  });

  it('never treats ordinary sentences, questions or other intents as control commands', () => {
    const falsePositives = NOT_COMMANDS.filter((text) => parseControlCommand(text) !== undefined);
    expect(falsePositives).toEqual([]);
  });

  it('keeps every parsed plan inside the safety policy', () => {
    for (const [text] of COMMANDS) {
      const plan = parseControlCommand(text);
      expect(plan, text).toBeDefined();
      expect(assessPlan(plan!, 'grammar').blocked, text).toBeUndefined();
    }
  });
});
