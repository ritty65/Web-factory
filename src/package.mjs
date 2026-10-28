import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { treeHashes } from './proposal.mjs';
import { safeRelative, hash, fail } from './contracts.mjs';
import { noLinks } from './db.mjs';
import {validateEffectsPlan, effectsDigest} from './effects-contract.mjs';
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) { crc ^= byte; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); } return (crc ^ 0xffffffff) >>> 0; }
// Stored ZIP entries (no compression dependency), fixed DOS date, UTF-8 names.
// ZIP format: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
export function zipBytes(entries) {
  const parts = [], central = []; let offset = 0;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    const name = Buffer.from(safeRelative(entry.name)), bytes = entry.bytes, crc = crc32(bytes);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6); local.writeUInt16LE(0x21, 12); local.writeUInt32LE(crc, 14); local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22); local.writeUInt16LE(name.length, 26);
    parts.push(local, name, bytes);
    const header = Buffer.alloc(46); header.writeUInt32LE(0x02014b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8); header.writeUInt16LE(0x21, 14); header.writeUInt32LE(crc, 16); header.writeUInt32LE(bytes.length, 20); header.writeUInt32LE(bytes.length, 24); header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42); central.push(header, name); offset += local.length + name.length + bytes.length;
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, directory, end]);
}
export async function packageReview({ siteRoot, outputRoot, candidate, media, qa, design, effectsPlan = null }) {
  const files = await treeHashes(siteRoot);
  if (!qa?.pass || hash(files) !== hash(qa.siteHashes)) fail('STALE_QA', 'Passing QA must match the exact current site digest; missing or changed bytes block packaging');
  if(qa.effectsPlan&&!effectsPlan)fail('STALE_EFFECTS_QA','The checked premium plan cannot be dropped from a package');
  if(effectsPlan) {
    effectsPlan=validateEffectsPlan(effectsPlan,{candidate,media,pages:Object.keys(files).filter(f=>f.endsWith('.html'))});
    if(qa.effectsDigest!==effectsDigest(effectsPlan)||hash(qa.effectsPlan)!==effectsDigest(effectsPlan)||qa.effectsChecks?.length!==25||qa.effectsChecks.some(c=>!c.pass))fail('STALE_EFFECTS_QA','Passing effect observations must bind the exact frozen plan and all page/viewport checks');
  }
  const manifest = { schema: 1, intent: 'private_operator_review', businessId: candidate.id, businessName: candidate.name, candidateEvidenceDigest: hash(candidate), siteHashes: files, siteDigest: hash(files), reviewStatus: 'operator_review_required', humanDecision: null, ownerAcceptance: 'unconfirmed', publicRelease: false, imageRights: 'operator_authorized_private_preview', media, design, qaCoverage: qa.coverage, qaDigest: hash(qa) };
  if(effectsPlan)Object.assign(manifest,{designProfile:effectsPlan.profile,effectsPlan,effectsDigest:effectsDigest(effectsPlan),effectsChecks:qa.effectsChecks});
  const entries = await Promise.all(Object.keys(files).map(async name => ({ name, bytes: await readFile(path.join(siteRoot, name)) })));
  entries.push({ name: 'PRIVATE-REVIEW-STATUS.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) });
  const bytes = zipBytes(entries), checksum = hash(bytes), archive = `private-proposal-${checksum.slice(0, 12)}.zip`;
  await noLinks(outputRoot); await mkdir(outputRoot, { recursive: true, mode: 0o750 });
  for (const [name, data] of [[archive, bytes], ['manifest.json', Buffer.from(JSON.stringify({ ...manifest, archive, sha256: checksum, bytes: bytes.length, entries: entries.length }, null, 2))], ['PACKAGE.sha256', Buffer.from(`${checksum}  ${archive}\n`)]]) {
    const target = path.join(outputRoot, name); await noLinks(target); try { await writeFile(target, data, { flag: 'wx', mode: 0o640 }); } catch (e) { if (e.code !== 'EEXIST' || hash(await readFile(target)) !== hash(data)) throw e; }
  }
  return { ...manifest, archive, sha256: checksum, bytes: bytes.length, entries: entries.length };
}
