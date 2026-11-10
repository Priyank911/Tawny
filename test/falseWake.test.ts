import { describe, expect, it } from 'vitest';
import { commandFromWakeTranscript } from '../src/main/pipeline/gate';
import { acceptWakeWithoutPhrase, heuristicRoute } from '../src/main/pipeline/router';

/** What the pipeline decides for a hands-free clip, given Whisper's transcript. */
function decide(transcript: string, selectedText = ''): 'run' | 'drop' | 'empty' {
  const wake = commandFromWakeTranscript(transcript);
  if (!wake.ok) return 'empty';
  if (wake.heardWakePhrase) return 'run';
  const route = heuristicRoute({ transcript, source: 'wake', gateRouted: true, gateCommand: wake.text, gateOriginal: wake.original, selectedText });
  return acceptWakeWithoutPhrase(route, selectedText) ? 'run' : 'drop';
}

// Transcripts taken from real hands-free sessions (pipeline.jsonl, 2026-11-10).
describe('false hands-free wakes', () => {
  it('drops overheard conversation that Whisper did not hear addressed to Tawny', () => {
    for (const overheard of [
      'नोगों निया नारो द्रक्सी जया खोल ट्या हुई या खैक।',
      "He's asking me to go, he's asking me...",
      "I'm listening and ready for your command to test the",
      'Can you say it again? In loud manner.',
      'With the height of the building around it showing its',
      'In calculator, in brief manner with import of packages and',
      'Make it shorter.'
    ]) expect(decide(overheard), overheard).toBe('drop');
  });

  it('still runs real requests, with or without the phrase in the transcript', () => {
    for (const request of [
      'Can you open WhatsApp?',
      'Open D Drive.',
      'Hey Tawny. Open Obsidian.',
      'Hey Tawny, create the image of a big robot standing',
      'Certainly. Hey Tawny, open anti-gravity.',
      'Hey Tawny. Hohpun dito hai.',
      'Can you create an image of a fox at dusk?',
      'Write a Python function that sorts a list.'
    ]) expect(decide(request), request).toBe('run');
  });

  it('a rewrite without the phrase needs selected text', () => {
    expect(decide('Make this more formal.', 'hi there')).toBe('run');
    expect(decide('Make this more formal.')).toBe('drop');
  });

  it('filler is reported, not run', () => {
    expect(decide('Terima kasih.')).not.toBe('run');
    expect(decide('Thank you.')).toBe('empty');
  });
});
