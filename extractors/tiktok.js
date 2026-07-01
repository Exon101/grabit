/**
 * extractors/tiktok.js — TikTok video extraction
 *
 * Strategy:
 *   1) Fetch the TikTok video page HTML (with the user's cookies)
 *   2) Look for the SIGI_STATE / __UNIVERSAL_DATA_FOR_REHYDRATION__ JSON blob
 *      which contains the video URL in ItemModule[].video.playAddr
 *   3) Fall back to og:video meta tag
 *
 * TikTok's video URLs are signed and time-limited — they expire after ~1 hour.
 * Also, the CDN host rotates between v77.tiktokcdn.com, v16-webcast.tiktok.com,
 * etc. We rely on the DNR rules in lib/restriction-bypass.js to handle the
 * referer/origin requirements.
 */

import { logger, mimeToExt, deobfuscateUrl } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';

export const tiktokExtractor = {
  id: 'tiktok',
  name: 'TikTok',
  description: 'Videos from tiktok.com',
  domains: ['tiktok.com'],

  async extract(tab, _opts) {
    const url = tab.url;
    const m = url.match(/tiktok\.com\/@([^/]+)\/video\/(\d+)/);
    if (!m) return [];

    const author = m[1];
    const videoId = m[2];

    try {
      const html = await fetchPage(url);
      const variants = scrapeVideoVariants(html);
      const title = scrapeTitle(html);
      const thumb = scrapeThumb(html);
      const duration = scrapeDuration(html);

      if (!variants.length) {
        return [{
          id: `tt-${videoId}`,
          type: 'video',
          title: title || `TikTok @${author}/${videoId}`,
          author: `@${author}`,
          thumbnail: thumb,
          durationSec: duration,
          variants: [],
          error: 'No video URL found — TikTok may have changed their markup, or the video is private/removed.',
          meta: { site: 'tiktok', videoId, author },
        }];
      }

      return [{
        id: `tt-${videoId}`,
        type: 'video',
        title: title || `TikTok @${author}/${videoId}`,
        author: `@${author}`,
        thumbnail: thumb,
        durationSec: duration,
        variants: variants.map(v => ({
          url: v.url,
          quality: v.quality,
          height: v.height,
          mime: 'video/mp4',
          ext: 'mp4',
          audio: true,
          bitrate: 0,
          needsReferer: !!getSpoofedOrigin(v.url),
        })),
        meta: { site: 'tiktok', videoId, author },
      }];
    } catch (e) {
      logger.error('TikTok extractor failed', e);
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
  if (!res.ok) throw new Error(`TikTok fetch ${res.status}`);
  return res.text();
}

function scrapeVideoVariants(html) {
  const variants = [];
  const seen = new Set();

  // Universal data blob (modern TikTok)
  const re1 = /"playAddr"\s*:\s*(\[[^\]]+\])/g;
  let m;
  while ((m = re1.exec(html))) {
    try {
      const arr = JSON.parse(m[1]);
      for (const v of arr) {
        const url = deobfuscateUrl(v.src || v.url);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        variants.push({
          url,
          quality: v.width ? `${v.width}x${v.height || 0}` : 'source',
          height: v.height || 0,
        });
      }
    } catch {
      // ignore
    }
  }

  // SIGI_STATE blob (older TikTok)
  const re2 = /"video":\s*\{[^}]*"playAddr"\s*:\s*"([^"]+)"/g;
  while ((m = re2.exec(html))) {
    const url = deobfuscateUrl(m[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    variants.push({ url, quality: 'source', height: 0 });
  }

  // og:video fallback
  if (!variants.length) {
    const ogRe = /<meta\s+(?:property|name)=["']og:video(?::secure_url|:type)?["']\s+content=["']([^"']+)["']/gi;
    while ((m = ogRe.exec(html))) {
      const url = deobfuscateUrl(m[1]);
      if (seen.has(url)) continue;
      seen.add(url);
      variants.push({ url, quality: 'source', height: 0 });
    }
  }

  variants.sort((a, b) => (b.height || 0) - (a.height || 0));
  return variants;
}

function scrapeTitle(html) {
  const m = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function scrapeThumb(html) {
  const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function scrapeDuration(html) {
  const m = html.match(/"duration"\s*:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : 0;
}
