/**
 * extractors/reddit.js — Reddit video extraction
 *
 * Strategy:
 *   1) Fetch the post page HTML (with cookies) — Reddit embeds all post
 *      data in a <script id="data"> or window.___r blob
 *   2) Extract the JSON, find secure_media.reddit_video
 *   3) Try DASH (dash_url) → HLS (hls_url) → direct MP4 (fallback_url)
 *
 * Previous approach (fetching /{id}.json) stopped working because Reddit
 * now returns 429 for most unauthenticated .json requests. The HTML page
 * is more reliable because it's the same content Reddit serves to browsers.
 */

import { logger, deobfuscateUrl } from '../lib/utils.js';
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
      const html = await fetchPage(url);
      const post = extractPostFromHtml(html, postId);

      if (!post) {
        return [{
          id: `rd-${postId}`,
          type: 'video',
          title: `Reddit ${postId}`,
          variants: [],
          error: 'Could not parse Reddit page data. The post may require login, be private, or Reddit changed their page structure.',
          meta: { site: 'reddit', postId },
        }];
      }

      const video = post.secure_media?.reddit_video || post.media?.reddit_video;
      if (!video) {
        return [{
          id: `rd-${postId}`,
          type: 'video',
          title: post.title || `Reddit ${postId}`,
          author: post.author ? `u/${post.author}` : '',
          variants: [],
          error: 'This post has no Reddit-hosted video (might be a link post, image, or YouTube embed).',
          meta: { site: 'reddit', postId },
        }];
      }

      const variants = await buildVariants(video);
      variants.sort((a, b) => {
        if (a.audio !== b.audio) return a.audio ? 1 : -1;
        return (b.height || b.bitrate || 0) - (a.height || a.bitrate || 0);
      });

      return [{
        id: `rd-${postId}`,
        type: 'video',
        title: post.title || `Reddit ${postId}`,
        author: post.author ? `u/${post.author}` : '',
        thumbnail: (post.thumbnail && post.thumbnail.startsWith('http')) ? post.thumbnail : '',
        durationSec: video.duration || 0,
        variants,
        meta: { site: 'reddit', postId },
      }];
    } catch (e) {
      logger.error('Reddit extractor failed', e);
      return [{
        id: `rd-${postId}`,
        type: 'video',
        title: `Reddit ${postId}`,
        variants: [],
        error: `Extraction failed: ${e?.message || 'unknown error'}`,
        meta: { site: 'reddit', postId },
      }];
    }
  },
};

async function fetchPage(url) {
  // Fetch the HTML page (not .json — that endpoint rate-limits aggressively)
  const res = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  if (!res.ok) throw new Error(`Reddit fetch ${res.status}`);
  return res.text();
}

/**
 * Extract the post data from Reddit's HTML.
 * Reddit embeds data in several places:
 *   1) <script id="data">window.___r = {...}</script>
 *   2) <script>window.___r = {...}</script>
 *   3) <script type="application/ld+json">{...}</script>
 *   4) Inline JSON in data-* attributes
 */
function extractPostFromHtml(html, postId) {
  // Method 1: Look for the post data in the JSON blob
  // Reddit's modern HTML has the data inside a big JSON in <script> tags
  const patterns = [
    // Modern Reddit (2023+)
    /"posts"\s*:\s*\{[^}]*"t3_[a-z0-9]+"\s*:\s*(\{[\s\S]*?\})\s*[,}]/,
    // Older format
    /"t3_[a-z0-9]+"\s*:\s*(\{[^}]*"secure_media"[\s\S]*?\})\s*[,}]/,
    // JSON-LD
    /<script\s+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/,
  ];

  for (const pattern of patterns) {
    const m = html.match(pattern);
    if (m) {
      try {
        const data = JSON.parse(m[1]);
        // Navigate to the post object
        const post = findPostInObject(data, postId);
        if (post && (post.secure_media?.reddit_video || post.media?.reddit_video)) {
          return post;
        }
      } catch {
        // JSON parse failed, try next pattern
      }
    }
  }

  // Method 2: Find the video URL directly in the HTML
  const dashMatch = html.match(/"dash_url"\s*:\s*"([^"]+\.mpd[^"]*)"/);
  const hlsMatch = html.match(/"hls_url"\s*:\s*"([^"]+\.m3u8[^"]*)"/);
  const fallbackMatch = html.match(/"fallback_url"\s*:\s*"([^"]+\.mp4[^"]*)"/);
  const durationMatch = html.match(/"duration"\s*:\s*(\d+(?:\.\d+)?)/);
  const titleMatch = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i);

  if (dashMatch || hlsMatch || fallbackMatch) {
    return {
      title: titleMatch ? decodeHtml(titleMatch[1]) : `Reddit ${postId}`,
      author: '',
      thumbnail: '',
      secure_media: {
        reddit_video: {
          dash_url: dashMatch ? decodeUnicode(dashMatch[1]) : '',
          hls_url: hlsMatch ? decodeUnicode(hlsMatch[1]) : '',
          fallback_url: fallbackMatch ? decodeUnicode(fallbackMatch[1]) : '',
          duration: durationMatch ? parseFloat(durationMatch[1]) : 0,
        },
      },
    };
  }

  return null;
}

function findPostInObject(obj, postId, depth = 0) {
  if (depth > 10 || !obj || typeof obj !== 'object') return null;
  // Check if this object looks like a post (has secure_media or media)
  if ((obj.secure_media?.reddit_video || obj.media?.reddit_video) && obj.id) {
    return obj;
  }
  for (const key of Object.keys(obj)) {
    const val = obj[key];
    if (val && typeof val === 'object') {
      const found = findPostInObject(val, postId, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function buildVariants(video) {
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

  // 3) Fallback URL (single mp4) — always include as last resort
  if (fallbackUrl) {
    variants.push({
      url: deobfuscateUrl(fallbackUrl),
      quality: '720p (direct)',
      height: 720,
      mime: 'video/mp4',
      ext: 'mp4',
      audio: true,
      bitrate: 0,
      needsReferer: !!getSpoofedOrigin(fallbackUrl),
    });
  }

  return variants;
}

async function fetchText(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`Manifest fetch ${res.status}`);
  return res.text();
}

function decodeHtml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

function decodeUnicode(s) {
  return s.replace(/\\u002F/g, '/').replace(/\\u0026/g, '&').replace(/\\"/g, '"');
}
