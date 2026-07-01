/**
 * extractors/twitter.js — Twitter / X video extraction
 *
 * Strategy:
 *   1) Resolve the tweet URL to its API endpoint: /i/api/graphql/{queryId}/TweetDetail
 *      (we use the public graphql endpoint with the user's cookies)
 *   2) OR fall back to scraping the og:image / twitter:player HTML meta tags
 *   3) Twitter videos are hosted at video.twimg.com — variant URLs are signed
 *      and need referer bypass (handled by DNR rules in lib/restriction-bypass.js)
 *
 * Known limits: NSFW-tweet videos, protected accounts, and tweets removed by
 * the time of the request will not yield playable URLs.
 */

import { logger, mimeToExt, deobfuscateUrl } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';

export const twitterExtractor = {
  id: 'twitter',
  name: 'Twitter / X',
  description: 'Videos and GIFs from tweets on twitter.com and x.com',
  domains: ['twitter.com', 'x.com'],

  async extract(tab, _opts) {
    const url = tab.url;
    const m = url.match(/(?:twitter\.com|x\.com)\/[^/]+\/status\/(\d+)/);
    if (!m) return [];

    const tweetId = m[1];

    // Fetch the tweet page and scrape the player variant
    try {
      const html = await fetchPage(url);
      const variants = scrapeVariantsFromHtml(html);
      const title = scrapeTitle(html);

      if (!variants.length) {
        return [{
          id: `tw-${tweetId}`,
          type: 'video',
          title: title || `Tweet ${tweetId}`,
          variants: [],
          error: 'No video found in this tweet (might be text/image only, deleted, or protected).',
          meta: { site: 'twitter', tweetId },
        }];
      }

      return [{
        id: `tw-${tweetId}`,
        type: 'video',
        title: title || `Tweet ${tweetId}`,
        author: scrapeAuthor(html),
        thumbnail: scrapeThumb(html),
        durationSec: 0,
        variants: variants.map(v => ({
          url: v.url,
          quality: v.quality,
          height: v.height,
          mime: v.mime,
          ext: mimeToExt(v.mime) || 'mp4',
          audio: v.contentType === 'video/mp4',
          bitrate: v.bitrate,
          needsReferer: !!getSpoofedOrigin(v.url),
        })),
        meta: { site: 'twitter', tweetId },
      }];
    } catch (e) {
      logger.error('Twitter extractor failed', e);
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
      // Twitter returns the bot-friendly HTML without these — which is what we want
      'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    },
  });
  if (!res.ok) throw new Error(`Twitter fetch ${res.status}`);
  return res.text();
}

function scrapeVariantsFromHtml(html) {
  // Look for og:video meta
  const variants = [];
  const seen = new Set();

  const ogVideoRe = /<meta\s+(?:property|name)=["'](?:og:video|twitter:player:stream)(?::type)?["']\s+content=["']([^"']+)["']/gi;
  let m;
  while ((m = ogVideoRe.exec(html))) {
    const url = deobfuscateUrl(m[1]);
    if (seen.has(url)) continue;
    seen.add(url);
    variants.push({
      url,
      quality: 'source',
      height: 0,
      mime: 'video/mp4',
      bitrate: 0,
      contentType: 'video/mp4',
    });
  }

  // Try to find the JSON-LD or tweet JSON with variant list
  const jsonRe = /"video_info"\s*:\s*\{[^}]*"variants"\s*:\s*(\[[^\]]+\])/;
  const jm = html.match(jsonRe);
  if (jm) {
    try {
      const arr = JSON.parse(jm[1]);
      for (const v of arr) {
        if (!v.url) continue;
        const url = deobfuscateUrl(v.url);
        if (seen.has(url)) continue;
        seen.add(url);
        variants.push({
          url,
          quality: v.bitrate ? `${Math.round(v.bitrate / 1000)}kbps` : 'source',
          height: 0,
          mime: v.content_type || 'video/mp4',
          bitrate: v.bitrate || 0,
          contentType: v.content_type || 'video/mp4',
        });
      }
    } catch {
      // ignore JSON parse errors
    }
  }

  // Highest-bitrate first
  variants.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return variants;
}

function scrapeTitle(html) {
  const m = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : '';
}

function scrapeAuthor(html) {
  const m = html.match(/["']screen_name["']\s*:\s*["']([^"']+)["']/);
  return m ? `@${m[1]}` : '';
}

function scrapeThumb(html) {
  const m = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i);
  return m ? m[1] : '';
}
