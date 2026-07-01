/**
 * extractors/facebook.js — Facebook video extraction
 *
 * Facebook is one of the harder sites because:
 *   - Requires login for most videos
 *   - The video URL is generated on-the-fly by the GraphQL API
 *   - The page HTML embeds the playable URL inside a complex JSON
 *
 * Strategy:
 *   1) Fetch the video page HTML (with cookies)
 *   2) Scrape the inline `playable_url` / `playable_url_quality_hd` from
 *      the embedded JSON (typically under a "video" key in the relay data)
 *   3) Fall back to og:video meta tag
 */

import { logger, deobfuscateUrl } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';

export const facebookExtractor = {
  id: 'facebook',
  name: 'Facebook',
  description: 'Videos from facebook.com/watch and fb.watch shortlinks',
  domains: ['facebook.com'],

  async extract(tab, _opts) {
    const url = tab.url;
    if (!/facebook\.com\/(watch|permalink|reel|[^/]+\/videos)/.test(url)) return [];

    const idMatch = url.match(/\/(?:videos|watch|reel)\/(?:[\w.-]+\/)?(\d+)/);
    const videoId = idMatch ? idMatch[1] : '';

    try {
      const html = await fetchPage(url);
      const variants = scrapeVideoVariants(html);
      const title = scrapeTitle(html);
      const author = scrapeAuthor(html);
      const thumb = scrapeThumb(html);

      if (!variants.length) {
        return [{
          id: `fb-${videoId || tab.id}`,
          type: 'video',
          title: title || 'Facebook video',
          author,
          thumbnail: thumb,
          variants: [],
          error: 'No video URL found — Facebook may require login or the video is private/removed.',
          meta: { site: 'facebook', videoId },
        }];
      }

      return [{
        id: `fb-${videoId || tab.id}`,
        type: 'video',
        title: title || 'Facebook video',
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
          bitrate: 0,
          needsReferer: !!getSpoofedOrigin(v.url),
        })),
        meta: { site: 'facebook', videoId },
      }];
    } catch (e) {
      logger.error('Facebook extractor failed', e);
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
  if (!res.ok) throw new Error(`Facebook fetch ${res.status}`);
  return res.text();
}

function scrapeVideoVariants(html) {
  const variants = [];
  const seen = new Set();

  // Look for playable_url(_quality_hd) inside the embedded JSON
  const hdMatch = html.match(/"playable_url_quality_hd"\s*:\s*"([^"]+)"/);
  if (hdMatch) {
    const url = deobfuscateUrl(JSON.parse(`"${hdMatch[1]}"`));
    if (url && !seen.has(url)) {
      seen.add(url);
      variants.push({ url, quality: 'HD', height: 1080 });
    }
  }

  const sdMatch = html.match(/"playable_url"\s*:\s*"([^"]+)"/);
  if (sdMatch) {
    const url = deobfuscateUrl(JSON.parse(`"${sdMatch[1]}"`));
    if (url && !seen.has(url)) {
      seen.add(url);
      variants.push({ url, quality: 'SD', height: 720 });
    }
  }

  // Look for browser_native_hd_url / browser_native_sd_url
  const nativeHd = html.match(/"browser_native_hd_url"\s*:\s*"([^"]+)"/);
  if (nativeHd) {
    const url = deobfuscateUrl(JSON.parse(`"${nativeHd[1]}"`));
    if (url && !seen.has(url)) {
      seen.add(url);
      variants.push({ url, quality: 'HD Native', height: 1080 });
    }
  }

  // og:video fallback
  if (!variants.length) {
    const ogRe = /<meta\s+(?:property|name)=["']og:video(?::secure_url|:type)?["']\s+content=["']([^"']+)["']/gi;
    let m;
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

function scrapeAuthor(html) {
  const m = html.match(/"owner"\s*:\s*\{[^}]*"name"\s*:\s*"([^"]+)"/);
  return m ? m[1] : '';
}

function scrapeThumb(html) {
  const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : '';
}
