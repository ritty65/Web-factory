import { createRequire } from 'node:module';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { publicUrl, publicResourceKey, text, hash, fail, now } from './contracts.mjs';
import { safeFetch } from './network.mjs';
import { noLinks } from './db.mjs';
const require = createRequire(import.meta.url);
const sharp = require('sharp');
export const MEDIA_HOSTS = ['fbcdn.net', 'cdninstagram.com'];
function accountUrl(value) { const key = publicResourceKey(value); if (!key) fail('MEDIA_IDENTITY', 'A safe observed account resource is required'); return key; }
export function validateMediaSelection(candidate, selected, observed) {
  if (!observed || observed.id !== selected.sourceId || observed.blocked || !selected.businessPosted) fail('MEDIA_IDENTITY', 'An actually observed business-posted public image is required');
  const accounts = [candidate.contacts?.instagram, candidate.contacts?.facebook].filter(Boolean).map(accountUrl);
  if (!accounts.includes(accountUrl(selected.account))) fail('MEDIA_IDENTITY', 'Image account does not match the researched business');
  const post = publicUrl(selected.postUrl);
  const platform = post.hostname.endsWith('instagram.com') ? 'instagram' : /(^|\.)facebook\.com$/.test(post.hostname) ? 'facebook' : null;
  if (!platform || !candidate.contacts?.[platform] || !['instagram.com', 'www.instagram.com', 'facebook.com', 'www.facebook.com', 'm.facebook.com'].includes(post.hostname)) fail('MEDIA_SOURCE', 'A stable public Instagram/Facebook post/photo source is required');
  const image = observed.images?.find(v => v.id === selected.imageId);
  if (!image || image.width < 300 || image.height < 200) fail('MEDIA_OBSERVATION', 'Selected image was not actually observed at usable dimensions');
  const observedUrl = publicUrl(observed.url);
  if (observedUrl.hostname.replace(/^(www|m)\./, '') !== post.hostname.replace(/^(www|m)\./, '') || (!accounts.includes(accountUrl(observed.url)) && publicResourceKey(observed.url) !== publicResourceKey(post.href))) fail('MEDIA_IDENTITY', 'Observation must be the matched profile or the exact selected post');
  return { asset_id: selected.imageId, platform, account: selected.account, post_url: post.href, posted_at: selected.postedAt || null, credit: text(selected.credit || 'Creator not separately identified in the public observation', 'Credit', 300), role: text(selected.role || 'supporting', 'Image role', 100), alt: text(selected.alt, 'Image description', 300), retrieved_at: now(), observation_id: observed.id, use_status: 'operator_authorized_private_preview', rightsholder_permission: 'unconfirmed', public_release: false };
}
async function immutableWrite(target, bytes) { await noLinks(target); await mkdir(path.dirname(target), { recursive: true, mode: 0o750 }); try { await writeFile(target, bytes, { flag: 'wx', mode: 0o640 }); } catch (e) { if (e.code !== 'EEXIST') throw e; if (hash(await readFile(target)) !== hash(bytes)) fail('IMMUTABLE_MEDIA', 'Different prior media bytes cannot be replaced'); } }
export async function prepareMedia({ candidate, jobRoot, observations, signal, download = url => safeFetch(url, { signed: true, allowedHosts: MEDIA_HOSTS, redirects: 0, maxBytes: 8 * 1024 * 1024, signal }) }) {
  if (!candidate.media?.length || candidate.media.length > 6) fail('MEDIA_REQUIRED', 'Select 1–6 useful business-posted images from actual public observations');
  const manifest = [], used = new Set();
  for (const [i, selected] of candidate.media.entries()) {
    if (signal?.aborted) fail('CANCELLED', 'Media preparation cancelled');
    const observed = observations.find(v => v.id === selected.sourceId);
    const record = validateMediaSelection(candidate, selected, observed);
    const response = await download(observed.images.find(v => v.id === selected.imageId).mediaUrl);
    if (response.status && response.status !== 200 || !['image/jpeg', 'image/png', 'image/webp'].includes(response.contentType)) fail('MEDIA_RESPONSE', 'Public media returned non-image or inaccessible content');
    const bytes = response.bytes; if (bytes.length > 8 * 1024 * 1024 || used.has(hash(bytes))) fail('MEDIA_DUPLICATE', 'Media is duplicate or exceeds the original byte cap');
    used.add(hash(bytes));
    const meta = await sharp(bytes, { limitInputPixels: 24000000, animated: false }).metadata();
    if (!['jpeg', 'png', 'webp', 'heif'].includes(meta.format) || meta.pages > 1 && meta.format !== 'jpeg' || meta.width < 300 || meta.height < 200) fail('MEDIA_FORMAT', 'Media dimensions/format/animation are not suitable');
    const web = await sharp(bytes, { limitInputPixels: 24000000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toBuffer();
    const dims = await sharp(web).metadata();
    const original = `media/originals/photo-${i + 1}.${meta.format === 'jpeg' ? 'jpg' : meta.format}`;
    const local = `site/assets/photos/photo-${i + 1}.webp`;
    await immutableWrite(path.join(jobRoot, original), bytes); await immutableWrite(path.join(jobRoot, local), web);
    manifest.push({ ...record, original_file: original, web_file: local, original_sha256: hash(bytes), web_sha256: hash(web), dimensions: [dims.width, dims.height], original_dimensions: [meta.width, meta.height], bytes: web.length });
  }
  if (manifest.reduce((n, m) => n + m.bytes, 0) > 1500000) fail('MEDIA_BUDGET', 'Prepared imagery leaves insufficient site budget');
  await immutableWrite(path.join(jobRoot, 'media/social-manifest.json'), Buffer.from(JSON.stringify(manifest, null, 2)));
  return manifest;
}
