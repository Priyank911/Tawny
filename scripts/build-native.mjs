// Compiles the Windows helpers (tawny-control.exe, tawny-wake.exe) with the
// C# 5 compiler that ships with .NET Framework 4, which every Windows 10 and
// 11 machine and every GitHub windows runner has. Output goes to build/native.
// The app never compiles anything at runtime: a missing helper is reported to
// the person instead of being rebuilt behind their back.
//
//   node scripts/build-native.mjs          build, then smoke-test the control helper
//   node scripts/build-native.mjs --no-run build only
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

if (process.platform !== 'win32') {
  console.log('build-native: skipped. The Windows helpers can only be compiled on Windows.');
  process.exit(0);
}

const root = resolve(import.meta.dirname, '..');
const outDir = join(root, 'build', 'native');
const windir = process.env.WINDIR ?? 'C:\\Windows';
const frameworkDir = join(windir, 'Microsoft.NET', 'Framework64', 'v4.0.30319');
const csc = join(frameworkDir, 'csc.exe');
if (!existsSync(csc)) {
  console.error(`build-native: csc.exe not found at ${csc}. Install the .NET Framework 4.x developer pack.`);
  process.exit(1);
}

const gacRoots = [join(windir, 'Microsoft.NET', 'assembly', 'GAC_MSIL'), join(windir, 'assembly', 'GAC_MSIL')];
const searchDirs = [frameworkDir, join(frameworkDir, 'WPF')];

function findAssembly(name) {
  for (const dir of searchDirs) {
    const candidate = join(dir, `${name}.dll`);
    if (existsSync(candidate)) return candidate;
  }
  for (const gac of gacRoots) {
    const folder = join(gac, name);
    if (!existsSync(folder)) continue;
    for (const version of readdirSync(folder).sort().reverse()) {
      const candidate = join(folder, version, `${name}.dll`);
      if (existsSync(candidate)) return candidate;
    }
  }
  console.error(`build-native: could not find ${name}.dll in the framework folder or the GAC.`);
  process.exit(1);
}

const helpers = [
  { source: 'tawny-control.cs', output: 'tawny-control.exe', references: ['System', 'System.Core', 'System.Drawing', 'System.Windows.Forms', 'UIAutomationClient', 'UIAutomationTypes', 'WindowsBase'] },
  { source: 'tawny-wake.cs', output: 'tawny-wake.exe', references: ['System', 'System.Core', 'System.Speech'] }
];

mkdirSync(outDir, { recursive: true });
for (const helper of helpers) {
  const args = [
    '/nologo', '/optimize+', '/target:exe', '/platform:x64', '/warn:4',
    `/out:${join(outDir, helper.output)}`,
    ...helper.references.map((name) => `/reference:${findAssembly(name)}`),
    join(root, 'src', 'main', 'native', helper.source)
  ];
  const result = spawnSync(csc, args, { encoding: 'utf8' });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    console.error(`build-native: ${helper.source} failed to compile.`);
    process.exit(1);
  }
  console.log(`build-native: built ${helper.output}`);
}

if (process.argv.includes('--no-run')) process.exit(0);

// Smoke test: the control helper must answer its basic read-only commands.
const requests = ['1\thello', '2\tdrives', '3\twindows', '4\tcursor', 'exit'].join('\n') + '\n';
// A freshly compiled exe can be locked for a moment by antivirus scanning, so a failure to start is retried.
let run;
let failed = [];
for (let attempt = 1; attempt <= 4; attempt += 1) {
  run = spawnSync(join(outDir, 'tawny-control.exe'), [], { input: requests, encoding: 'utf8', timeout: 20000 });
  const replies = (run.stdout ?? '').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  failed = [1, 2, 3, 4].filter((id) => replies.find((reply) => reply.id === id)?.ok !== true);
  if ((run.status === 0 && failed.length === 0) || !run.error) break;
  await new Promise((resolve) => setTimeout(resolve, 1500));
}
// Windows Smart App Control / WDAC refuses to start unsigned binaries it has no reputation for, and every
// rebuild is a new binary. That is a property of this PC, not a broken helper: warn and continue. CI has no
// Smart App Control, so the release workflow always runs the full smoke test.
const blockedByPolicy = run.error && ['UNKNOWN', 'EACCES', 'EPERM'].includes(run.error.code);
if (blockedByPolicy && !process.env.CI) {
  console.warn(`build-native: WARNING: Windows blocked running the freshly built helper (${run.error.code}), most likely Smart App Control. Skipping the local smoke test; CI runs it before every release.`);
  process.exit(0);
}
if (run.status !== 0 || failed.length > 0) {
  console.error(`build-native: smoke test failed for request ids ${failed.join(', ') || '(process error)'}.\n${run.error ? `start error: ${run.error.message}\n` : ''}${run.stdout ?? ''}\n${run.stderr ?? ''}`);
  process.exit(1);
}
console.log('build-native: tawny-control.exe smoke test passed (hello, drives, windows, cursor).');
