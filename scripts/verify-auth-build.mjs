import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const outputDirectory = new URL('../out/main/', import.meta.url);
const files = (await readdir(outputDirectory)).filter((file) => file.endsWith('.js'));
const bundles = await Promise.all(files.map((file) => readFile(new URL(file, outputDirectory), 'utf8')));
const source = bundles.join('\n');

const configMatch = source.match(/(?:var|const)\s+define_TAWNY_FIREBASE_CONFIG_default\s*=\s*\{([^}]+)\}/);
if (!configMatch || source.includes('__TAWNY_FIREBASE_CONFIG__')) {
  console.error('Firebase configuration was not compiled into the Electron main bundle.');
  process.exitCode = 1;
} else {
  const config = configMatch[1];
  const fields = ['apiKey', 'projectId', 'googleClientId', 'googleClientSecret'];
  const missing = fields.filter((field) => !new RegExp(`${field}:\\s*["'][^"']+["']`).test(config));
  if (missing.length) {
    console.error(`Electron main bundle is missing Firebase configuration fields: ${missing.join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('Firebase config is embedded in the Electron main bundle (values omitted).');
  }
}
