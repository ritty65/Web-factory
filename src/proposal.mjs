import { mkdir, readFile, writeFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { hash, validateProposal, safeRelative, fail } from './contracts.mjs';
import { noLinks } from './db.mjs';

export { workRelative } from './contracts.mjs';

export async function treeHashes(root) {
  await noLinks(root); const hashes = {};
  async function walk(dir) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const relative = safeRelative(path.relative(root, path.join(dir, e.name)).split(path.sep).join('/'));
      const target = path.join(root, relative);
      if (e.isSymbolicLink()) fail('SYMLINK', 'Proposal tree contains a symlink');
      if (e.isDirectory()) await walk(target);
      else if (e.isFile()) hashes[relative] = hash(await readFile(target));
      else fail('UNSAFE_FILE', 'Proposal trees contain only regular files');
    }
  }
  await walk(root); return Object.fromEntries(Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)));
}
export async function stageProposal(root, input, options) {
  await noLinks(root); const proposal = validateProposal(input, options);
  // Preflight the entire update before writing: different prior bytes are immutable.
  for (const f of proposal.files) {
    const target = path.join(root, f.path); await noLinks(target);
    try { const previous = await readFile(target); if (!previous.equals(Buffer.from(f.content))) fail('IMMUTABLE_PROPOSAL', 'A different prior proposal cannot be overwritten; use a new attempt directory'); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  await mkdir(root, { recursive: true, mode: 0o750 });
  for (const file of proposal.files) {
    const target = path.join(root, file.path); await mkdir(path.dirname(target), { recursive: true, mode: 0o750 });
    try { await writeFile(target, file.content, { flag: 'wx', mode: 0o640 }); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  return { design: proposal.design, hashes: await treeHashes(root) };
}
