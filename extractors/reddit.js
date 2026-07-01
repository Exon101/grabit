/**
 * extractors/reddit.js — Reddit video extraction
 *
 * Reddit serves videos as DASH (.mpd) under v.redd.it/<id>/.
 * The watch page (reddit.com/r/.../comments/...) contains the MPD URL
 * and HLS fallback in the post JSON.
 *
 * Strategy:
 *   1) Fetch the post page JSON via reddit.com/<id>.json
 *   2) Read secure_media.reddit_video.hls_url / dash_url / fallback_url
 *   3) If DASH/HLS: pass the master playlist URL to lib/dash-hls.js
 *   4) If direct mp4: use fallback_url as single variant
 */

import { logger, mimeToExt, deobfuscateUrl } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';
import { parseManifest } from '../lib/dash-hls.js';

export const redditExtractor = {
  id: 'reddit',
  name: 'Reddit',
  description: 'Videos and GIFs from v.redd.it and reddit.com posts',
  domains: ['reddit.com', 'v.redd.it'],

  async extract(tab, _opts) {
    const url = tab.url;
    const m = url.match(/reddit\.com\/(?:r|user)\/[^/]+\/comments\/([a-z0-9]+)/);
    if (!m) return [];

    const postId = m[1];

    try {
      const jsonUrl = `https://www.reddit.com/${postId}.json`;
      const data = await fetchJson(jsonUrl);
      const post = data?.[0]?.data?.children?.[0]?.data;
      const video = post?.secure_media?.reddit_video || post?.media?.reddit_video;
      if (!video) {
        return [{
          id: `rd-${postId}`,
          type: 'video',
          title: post?.title || `Reddit ${postId}`,
          author: post?.author || '',
          variants: [],
          error: 'This post has no Reddit-hosted video (might be a link post, image, or YouTube embed).',
          meta: { site: 'reddit', postId },
        }];
      }

      const variants = [];
      let dashUrl = video.dash_url;
      let hlsUrl = video.hls_url;
      const fallbackUrl = video.fallback_url;

      // 1) Try DASH first (richer variants)
      if (dashUrl) {
        dashUrl = deobfuscateUrl(dashUrl);
        try {
          const dashText = await fetchText(dashUrl);
          const dashVariants = parseManifest(dashText, dashUrl);
          for (const v of dashVariants) {
            variants.push({
              url: v.url,
              quality: v.audio ? `audio ${v.codecs || ''}`.trim() : `${v.height || 0}p`,
              height: v.height || 0,
              mime: v.mime,
              ext: v.ext,
              audio: v.audio,
              bitrate: v.bitrate,
              needsReferer: !!getSpoofedOrigin(v.url),
            });
          }
        } catch (e) {
          logger.warn('Reddit DASH parse failed', e);
        }
      }

      // 2) Try HLS as fallback
      if (!variants.length && hlsUrl) {
        hlsUrl = deobfuscateUrl(hlsUrl);
        try {
          const hlsText = await fetchText(hlsUrl);
          const hlsVariants = parseManifest(hlsText, hlsUrl);
          for (const v of hlsVariants) {
            variants.push({
              url: v.url,
              quality: v.audio ? 'audio' : `${v.height || 0}p`,
              height: v.height || 0,
              mime: v.mime,
              ext: v.ext,
              audio: v.audio,
              bitrate: v.bitrate,
              needsReferer: !!getSpoofedOrigin(v.url),
            });
          }
        } catch (e) {
          logger.warn('Reddit HLS parse failed', e);
        }
      }

      // 3) Fallback URL (single mp4)
      if (!variants.length && fallbackUrl) {
        variants.push({
          url: deobfuscateUrl(fallbackUrl),
          quality: '720p',
          height: 720,
          mime: 'video/mp4',
          ext: 'mp4',
          audio: true,
          bitrate: 0,
          needsReferer: !!getSpoofedOrigin(fallbackUrl),
        });
      }

      variants.sort((a, b) => {
        if (a.audio !== b.audio) return a.audio ? 1 : -1;
        return (b.height || b.bitrate || 0) - (a.height || a.bitrate || 0);
      });

      return [{
        id: `rd-${postId}`,
        type: 'video',
        title: post?.title || `Reddit ${postId}`,
        author: post?.author ? `u/${post.author}` : '',
        thumbnail: post?.thumbnail && post.thumbnail.startsWith('http') ? post.thumbnail : '',
        durationSec: video.duration || 0,
        variants,
        meta: { site: 'reddit', postId },
      }];
    } catch (e) {
      logger.error('Reddit extractor failed', e);
      return [];
    }
  },
};

async function fetchJson(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Accept': 'application/json', 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`Reddit fetch ${res.status}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`Reddit manifest fetch ${res.status}`);
  return res.text();
}
