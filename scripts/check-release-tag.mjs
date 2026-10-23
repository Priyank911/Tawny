import { readFile } from 'node:fs/promises';

const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
const tag = process.env.GITHUB_REF_NAME ?? '';
const expected = `v${packageJson.version}`;
if (tag !== expected) {
  console.error(`Release tag ${tag || '(missing)'} must match package.json version ${expected}.`);
  process.exitCode = 1;
}
