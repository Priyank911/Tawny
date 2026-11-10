// Checks that tawny-wake.exe actually hears "Hey Tawny". Windows text-to-speech
// speaks a few phrases into WAV files, the helper recognizes them in --wav mode,
// and every wake phrase must be caught by at least one voice while the unrelated
// sentence must never wake it. A single voice can miss: the Windows speech
// profile on a long-used PC drifts, and one synthetic voice's "hey" may stop
// matching while real speech still does. Run after `pnpm build:native`:
//
//   node scripts/test-wake.mjs
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') {
  console.log('test-wake: skipped (Windows only).');
  process.exit(0);
}

const root = resolve(import.meta.dirname, '..');
const helper = join(root, 'build', 'native', 'tawny-wake.exe');
const dir = mkdtempSync(join(tmpdir(), 'tawny-wake-'));
const phrases = {
  'wake-command': 'Hey Tawny, open D drive.',
  'wake-downloads': 'Hey Tawny, open downloads.',
  'wake-only': 'Hey Tawny.',
  'noise': 'I was telling my friend about the weather today.'
};

const synth = `
param([string]$dir, [string]$json)
Add-Type -AssemblyName System.Speech
$phrases = $json | ConvertFrom-Json
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo 16000, ([System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen), ([System.Speech.AudioFormat.AudioChannel]::Mono)
foreach ($voice in (New-Object System.Speech.Synthesis.SpeechSynthesizer).GetInstalledVoices()) {
  $name = $voice.VoiceInfo.Name -replace '[^A-Za-z]', ''
  foreach ($p in $phrases.PSObject.Properties) {
    $s = New-Object System.Speech.Synthesis.SpeechSynthesizer
    $s.SelectVoice($voice.VoiceInfo.Name)
    $s.SetOutputToWaveFile((Join-Path $dir "$name--$($p.Name).wav"), $fmt)
    $s.Speak($p.Value)
    $s.Dispose()
  }
}`;
const scriptPath = join(dir, 'synth.ps1');
writeFileSync(scriptPath, synth);
const made = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-dir', dir, '-json', JSON.stringify(phrases)], { encoding: 'utf8' });
const wavs = readdirSync(dir).filter((name) => name.endsWith('.wav'));
if (made.status !== 0 || wavs.length === 0) {
  console.log(`test-wake: skipped, no text-to-speech voices available.\n${made.stderr}`);
  rmSync(dir, { recursive: true, force: true });
  process.exit(0);
}

const failures = [];
const caught = new Map();
for (const wav of wavs) {
  const run = spawnSync(helper, ['--wav', join(dir, wav)], { encoding: 'utf8', timeout: 30000 });
  // Smart App Control / WDAC refuses a freshly built unsigned helper on some PCs (same as build-native).
  if (run.error && ['UNKNOWN', 'EACCES', 'EPERM'].includes(run.error.code) && !process.env.CI) {
    console.warn(`test-wake: WARNING: Windows blocked running the freshly built helper (${run.error.code}), most likely Smart App Control. Skipping locally; CI runs this test before every release.`);
    rmSync(dir, { recursive: true, force: true });
    process.exit(0);
  }
  const lines = (run.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  const error = lines.find((line) => line.t === 'error');
  if (error?.code === 'no_recognizer') {
    console.log('test-wake: skipped, no English speech recognizer installed.');
    process.exit(0);
  }
  const heardWake = lines.some((line) => (line.t === 'hyp' || line.t === 'final') && /\b(hey|hi|okay) tawny\b/i.test(line.text));
  const phrase = wav.split('--')[1];
  const expectWake = phrase !== 'noise.wav';
  if (expectWake) {
    caught.set(phrase, (caught.get(phrase) ?? false) || heardWake);
    console.log(`${heardWake ? 'pass' : 'miss'}  ${wav}  expected wake`);
  } else {
    console.log(`${heardWake ? 'FAIL' : 'pass'}  ${wav}  expected no wake`);
    if (heardWake) failures.push(`${wav} woke Tawny`);
  }
}
for (const [phrase, ok] of caught) if (!ok) failures.push(`no voice woke Tawny with ${phrase}`);
rmSync(dir, { recursive: true, force: true });
if (failures.length > 0) {
  console.error(`test-wake: failed.\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`test-wake: passed (${wavs.length} clips; every wake phrase caught, no false wakes).`);
