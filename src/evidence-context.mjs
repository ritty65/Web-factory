import { publicUrl, publicResourceKey } from './contracts.mjs';

const same = (a, b) => Boolean(publicResourceKey(a) && publicResourceKey(a) === publicResourceKey(b));
const host = url => url.hostname.replace(/^(www|m)\./, '');

// A stable post route is necessary but not sufficient ownership evidence. Callers
// must also bind the exact observed image/link to an identity-matched source.
export function stablePostUrl(value, sourceUrl) {
  try {
    const url = publicUrl(value), source = publicUrl(sourceUrl), platform = host(source);
    if (!['instagram.com', 'facebook.com'].includes(platform) || host(url) !== platform) return null;
    const route = url.pathname.replace(/\/+$/, '');
    const instagramRoute = route.match(/^\/(?:(?<account>[A-Za-z0-9._-]+)\/)?(?:p|reel)\/[A-Za-z0-9_-]+$/);
    const sourceProfile = source.pathname.match(/^\/([A-Za-z0-9._-]+)\/?$/);
    const instagram = platform === 'instagram.com' && instagramRoute && (!instagramRoute.groups.account || !sourceProfile || instagramRoute.groups.account.toLowerCase() === sourceProfile[1].toLowerCase());
    const facebook = platform === 'facebook.com' && (/^\/[^/]+\/(?:posts|videos)\/[A-Za-z0-9_-]+$/.test(route) || /^\/[^/]+\/photos\/(?:[^/]+\/)?\d+$/.test(route) ||
      ['/', '/photo', '/photo.php', '/story.php'].includes(route) && (url.searchParams.has('fbid') || url.searchParams.has('story_fbid')) && [...url.searchParams.entries()].filter(([key]) => ['fbid', 'story_fbid', 'id'].includes(key)).every(([, val]) => /^\d+$/.test(val)));
    return instagram || facebook ? url.href : null;
  } catch { return null; }
}

export function observedImageText(ref, observation) {
  if (!ref || observation?.evidenceContextVersion !== 1 || observation.id !== ref.sourceId) return null;
  const image = observation.images?.find(i => i.id === ref.imageId);
  if (!image || typeof image.alt !== 'string' || !stablePostUrl(image.postUrl, observation.url) || !same(image.postUrl, ref.postUrl) ||
      !(observation.links || []).some(link => same(link.url, image.postUrl))) return null;
  return image.alt;
}

// Deliberately exclude relative dates and ambiguous numeric locales. Validate the
// calendar components instead of accepting Date.parse's rollover of invalid days.
export function observedDate(value) {
  if (typeof value !== 'string') return null;
  let year, month, day, match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) [, year, month, day] = match.map(Number);
  else {
    match = value.match(/^(January|February|March|April|May|June|July|August|September|October|November|December) (\d{1,2}),? (\d{4})$/i);
    if (!match) return null;
    year = Number(match[3]); month = ['january','february','march','april','may','june','july','august','september','october','november','december'].indexOf(match[1].toLowerCase()) + 1; day = Number(match[2]);
  }
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date.toISOString().slice(0, 10) : null;
}
