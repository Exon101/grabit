/**
 * extractors/instagram.js — Instagram reel / post / story video extraction
 *
 * Strategy:
 *   1) Fetch the post URL (with the user's cookies — Instagram requires login)
 *   2) Parse the JSON-LD or the inline __INITIAL_STATE__ blob for video_url /
 *      carousel_media[].video_versions[]
 *   3) Pick the highest-resolution variant
 *
 * Known limits: private accounts, expired stories, and posts requiring login
 * (when the user isn't signed in) will return zero variants.
 */

import { logger, mimeToExt, deobfuscateUrl } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';

export const instagramExtractor = {
  id: 'instagram',
  name: 'Instagram',
  description: 'Reels and video posts from instagram.com',
  domains: ['instagram.com'],

  async extract(tab, _opts) {
    const url = tab.url;
    const m = url.match(/instagram\.com\/(reel|p|tv)\/([^/?#]+)/);
    if (!m) return [];

    const kind = m[1];
    const shortcode = m[2];

    try {
      const html = await fetchPage(url);
      const variants = scrapeVideoVariants(html);
      const title = scrapeTitle(html);
      const author = scrapeAuthor(html);
      const thumb = scrapeThumb(html);

      if (!variants.length) {
        return [{
          id: `ig-${shortcode}`,
          type: 'video',
          title: title || `Instagram ${kind}/${shortcode}`,
          author,
          thumbnail: thumb,
          variants: [],
          error: 'No video found — post may be a photo, private, deleted, or login-gated.',
          meta: { site: 'instagram', shortcode, kind },
        }];
      }

      return [{
        id: `ig-${shortcode}`,
        type: 'video',
        title: title || `Instagram ${kind}/${shortcode}`,
        author,
        thumbnail: thumb,
        durationSec: 0,
        variants: variants.map(v => ({
          url: v.url,
          quality: v.quality,
          height: v.height,
          mime: 'video/mp4',
          ext: 'mp4',
          audio: true,
          bitrate: v.bitrate || 0,
          needsReferer: !!getSpoofedOrigin(v.url),
        })),
        meta: { site: 'instagram', shortcode, kind },
      }];
    } catch (e) {
      logger.error('Instagram extractor failed', e);
      return [];
    }
  },
};

async function fetchPage(url) {
  const res = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Site': 'same-origin',
    },
  });
  if (!res.ok) throw new Error(`Instagram fetch ${res.status}`);
  return res.text();
}

function scrapeVideoVariants(html) {
  const variants = [];
  const seen = new Set();

  // Modern: video_versions arrays inside JSON
  const re = /"video_versions"\s*:\s*(\[[^\]]+\])/g;
  let m;
  while ((m = re.exec(html))) {
    try {
      const arr = JSON.parse(m[1]);
      for (const v of arr) {
        if (!v.url) continue;
        const url = deobfuscateUrl(v.url);
        if (seen.has(url)) continue;
        seen.add(url);
        variants.push({
          url,
          quality: v.height ? `${v.height}p` : (v.width ? `${v.width}w` : 'source'),
          height: v.height || 0,
          bitrate: v.bitrate || 0,
        });
      }
    } catch {
      // ignore
    }
  }

  // Fallback: og:video meta tag
  if (!variants.length) {
    const ogRe = /<meta\s+(?:property|name)=["']og:video(?::secure_url|:type)?["']\s+content=["']([^"']+)["']/gi;
    while ((m = ogRe.exec(html))) {
      const url = deobfuscateUrl(m[1]);
      if (seen.has(url)) continue;
      seen.add(url);
      variants.push({
        url,
        quality: 'source',
        height: 0,
        bitrate: 0,
      });
    }
  }

  variants.sort((a, b) => (b.height || 0) - (a.height || 0) || (b.bitrate || 0) - (a.bitrate || 0));
  return variants;
}

function scrapeTitle(html) {
  const m = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function scrapeAuthor(html) {
  const m = html.match(/"owner"\s*:\s*\{[^}]*"username"\s*:\s*"([^"]+)"/);
  return m ? `@${m[1]}` : '';
}

function scrapeThumb(html) {
  const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : '';
}
