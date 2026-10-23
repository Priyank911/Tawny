import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'release-assets');
async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  }));
  return nested.flat();
}

const files = (await listFiles(root)).filter((path) => basename(path) !== 'SHA256SUMS').sort();
if (!files.length) throw new Error(`No release artifacts found in ${root}`);
const rows = await Promise.all(files.map(async (path) => {
  const hash = createHash('sha256').update(await readFile(path)).digest('hex');
  return `${hash}  ${relative(root, path).split(sep).join('/')}`;
}));
await writeFile(join(root, 'SHA256SUMS'), `${rows.join('\n')}\n`, 'utf8');
