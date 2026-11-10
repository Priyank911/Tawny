import { describe, expect, it } from 'vitest';
import { AppIndex, entriesFromStartApps } from '../src/main/control/appIndex';
import { parseControlCommand } from '../src/main/pipeline/controlGrammar';
import { commandFromWakeTranscript, confirmWakePhrase, splitWakePhrase } from '../src/main/pipeline/gate';
import { isImageGenerationRequest } from '../src/main/pipeline/intent';
import { CONTROL_MIN_CONFIDENCE, heuristicRoute, reconcileIntent, type RouteInput } from '../src/main/pipeline/router';

describe('Whisper confirmation of a hands-free wake', () => {
  it.each([
    ['Hey Tawny, open D drive.', 'open D drive.'],
    ['Hey, Tawny. Open WhatsApp.', 'Open WhatsApp.'],
    ['Tawny, open the recycle bin.', 'open the recycle bin.'],
    ['HeyTawny open downloads', 'open downloads'],
    ['Hey-Tawny open downloads', 'open downloads'],
    ['A Tawny, generate an image of a sunset.', 'generate an image of a sunset.'],
    ['Hello Tawny, open Chrome', 'open Chrome'],
    ['Okay. Hey Tawny, open Chrome', 'open Chrome'],
    ['Yeah. Hey Tony, open Chrome', 'open Chrome'],
    ['Hey Tani, open Chrome', 'open Chrome']
  ])('accepts %j', (transcript, original) => {
    const result = confirmWakePhrase(transcript);
    expect(result.routed).toBe(true);
    expect(result.original).toBe(original);
  });

  it.each([
    'hey buddy how are you',
    'hey many people came',
    'i said hey tawny to him yesterday and he left',
    'thank you',
    'open D drive'
  ])('still rejects %j', (transcript) => {
    expect(confirmWakePhrase(transcript).routed).toBe(false);
  });

  it('leaves the live-room detector strict', () => {
    expect(splitWakePhrase('Tony, open the door').routed).toBe(false);
    expect(splitWakePhrase('hey tawny open downloads').routed).toBe(true);
  });
});

describe('drive names', () => {
  it.each(['open D-Drive', 'Open D-Drive.', 'open the D drive', 'go to drive D', 'open D drive'])('%j opens D:', (spoken) => {
    expect(parseControlCommand(spoken)?.steps[0]).toMatchObject({ verb: 'open', target: 'D:', drive: 'D' });
  });
  it('finds a folder inside a hyphenated drive', () => {
    expect(parseControlCommand('open projects in D-drive')?.steps[0]).toMatchObject({ verb: 'open', target: 'projects', drive: 'D' });
  });
});

describe('image requests', () => {
  it.each([
    'can you generate that image',
    'generate an image of a red fox',
    'make me a beautiful sunset picture',
    'create a logo for my bakery',
    'draw a cat sitting on a wall',
    'paint me a mountain lake',
    'picture of a dog in the rain'
  ])('%j is an image request', (text) => {
    expect(isImageGenerationRequest(text)).toBe(true);
  });
  it.each([
    'make a list of image formats',
    'do not generate an image',
    'I need to make a decision about the photo shoot',
    'write an email about the picture we took'
  ])('%j is not', (text) => {
    expect(isImageGenerationRequest(text)).toBe(false);
  });
  it('wins over the text-answer rule on the hotkey path', () => {
    const input: RouteInput = { transcript: 'Can you generate that image?', source: 'hotkey', gateRouted: false, gateCommand: '', gateOriginal: '', selectedText: '' };
    expect(heuristicRoute(input)).toMatchObject({ intent: 'image_generate', matched: true });
  });
});

describe('decider threshold for control', () => {
  const route = { command: 'recycle bin', fastRewrite: false, intent: 'plain_dictation' as const, matched: false, consult: 'classify' as const };
  it('acts on a wake-phrase control request the decider is fairly sure about', () => {
    expect(reconcileIntent(route, { intent: 'computer_control', tier: 'low', confidence: 0.63 }, '')).toEqual({ intent: 'computer_control', reason: 'decider' });
  });
  it('still dictates when the decider is unsure', () => {
    expect(reconcileIntent(route, { intent: 'computer_control', tier: 'low', confidence: CONTROL_MIN_CONFIDENCE - 0.01 }, '').intent).toBe('plain_dictation');
    expect(reconcileIntent(route, { intent: 'text_query', tier: 'low', confidence: 0.63 }, '').intent).toBe('plain_dictation');
  });
});

describe('Microsoft Store apps', () => {
  const startApps = [
    { name: 'WhatsApp', appId: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' },
    { name: 'Spotify', appId: 'SpotifyAB.SpotifyMusic_zpdnekdrzrea0!Spotify' },
    { name: 'Terminal', appId: 'Microsoft.WindowsTerminal_8wekyb3d8bbwe!App' },
    { name: 'Windows PowerShell', appId: '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe' },
    { name: 'Chrome', appId: 'Chrome' }
  ];
  it('indexes packaged apps and never shells', () => {
    // "Chrome" is a registered desktop app ID, also launchable through shell:AppsFolder.
    expect(entriesFromStartApps(startApps).map((entry) => entry.name)).toEqual(['WhatsApp', 'Spotify', 'Chrome']);
  });
  it('finds WhatsApp by name', () => {
    const index = new AppIndex();
    index.setShortcuts([], startApps);
    expect(index.find('whatsapp')[0].item.launch).toEqual({ type: 'appid', value: '5319275A.WhatsAppDesktop_cv1g1gvanyjgm!App' });
  });
  it('prefers a shortcut when both exist', () => {
    const index = new AppIndex();
    index.setShortcuts(['C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Spotify.lnk'], startApps);
    expect(index.find('spotify')[0].item.launch.type).toBe('file');
  });
});

describe('the command of a hands-free request (the local wake is the confirmation)', () => {
  it.each([
    // The person said "Hey Tawny", waited for the orb, then spoke: the clip holds only the command.
    ['Open this PC.', 'Open this PC.', false],
    ['Can you open D Drive?', 'Can you open D Drive?', false],
    // Whisper heard the wake phrase too: it is removed.
    ['Hey Tawny, open WhatsApp.', 'open WhatsApp.', true],
    ['Hey, Tawny. Generate an image of a sunset.', 'Generate an image of a sunset.', true],
    ['Tawny, open the recycle bin. Tawny send it.', 'open the recycle bin.', true]
  ])('%j -> %j', (transcript, original, heardWakePhrase) => {
    const result = commandFromWakeTranscript(transcript);
    expect(result).toMatchObject({ ok: true, original, heardWakePhrase });
  });

  it.each(['Thank you.', 'Here you go.', 'Hey Tawny.', '', '  ', 'Thanks for watching!', 'Tawny'])('%j is not a request', (transcript) => {
    expect(commandFromWakeTranscript(transcript).ok).toBe(false);
  });
});
