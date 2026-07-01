/**
 * extractors/twitch.js — Twitch clip and VOD extraction
 *
 * Strategy:
 *   1) For clips: fetch the clip page HTML, scrape the og:video URL
 *      (Twitch exposes the source MP4 directly in the meta tag for clips)
 *   2) For VODs: hit the GQL endpoint with a persistent-access-token query
 *      to get the m3u8 URL, then parse it with lib/dash-hls.js
 *
 * Known limits: VODs past the 7-day free window for non-subscribers return
 * a 403 — we surface a friendly error message.
 */

import { logger, deobfuscateUrl } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';
import { parseManifest } from '../lib/dash-hls.js';

export const twitchExtractor = {
  id: 'twitch',
  name: 'Twitch',
  description: 'Clips and VODs from twitch.tv',
  domains: ['twitch.tv'],

  async extract(tab, _opts) {
    const url = tab.url;

    const clipMatch = url.match(/twitch\.tv\/\w+\/clip\/([A-Za-z0-9_-]+)/);
    if (clipMatch) return extractClip(clipMatch[1], tab);

    const vodMatch = url.match(/twitch\.tv\/videos\/(\d+)/);
    if (vodMatch) return extractVod(vodMatch[1], tab);

    return [];
  },
};

async function extractClip(clipId, tab) {
  try {
    const html = await fetchPage(`https://clips.twitch.tv/${clipId}`);
    const variants = [];
    const seen = new Set();

    // Twitch clips expose multiple qualities in the og:video:tag block
    // but the canonical source MP4 is typically in a "thumbnail" image hosting
    // pattern like: production.assets.clips.twitchcdn.com/<id>/360p.mp4 etc.
    const re = /production\.assets\.clips\.twitchcdn\.com\/[^"'\s]+?\.mp4/gi;
    let m;
    while ((m = re.exec(html))) {
      const url = deobfuscateUrl('https://' + m[0]);
      if (seen.has(url)) continue;
      seen.add(url);
      const hMatch = m[0].match(/(\d+)p\.mp4/i);
      variants.push({
        url,
        quality: hMatch ? hMatch[1] + 'p' : 'source',
        height: hMatch ? parseInt(hMatch[1], 10) : 0,
        mime: 'video/mp4',
        ext: 'mp4',
        audio: true,
        bitrate: 0,
        needsReferer: !!getSpoofedOrigin(url),
      });
    }

    // og:video fallback
    if (!variants.length) {
      const og = html.match(/<meta\s+property=["']og:video(?::secure_url)?["']\s+content=["']([^"']+)["']/i);
      if (og) {
        variants.push({
          url: deobfuscateUrl(og[1]),
          quality: 'source',
          height: 0,
          mime: 'video/mp4',
          ext: 'mp4',
          audio: true,
          bitrate: 0,
          needsReferer: !!getSpoofedOrigin(og[1]),
        });
      }
    }

    const title = html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] || `Twitch clip ${clipId}`;
    const thumb = html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] || '';
    const author = html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)?.[1] || '';

    variants.sort((a, b) => (b.height || 0) - (a.height || 0));

    if (!variants.length) {
      return [{
        id: `tw-clip-${clipId}`,
        type: 'video',
        title,
        author,
        thumbnail: thumb,
        variants: [],
        error: 'Could not extract clip — Twitch may have changed the clip page layout.',
        meta: { site: 'twitch', kind: 'clip', clipId },
      }];
    }

    return [{
      id: `tw-clip-${clipId}`,
      type: 'video',
      title,
      author,
      thumbnail: thumb,
      durationSec: 0,
      variants,
      meta: { site: 'twitch', kind: 'clip', clipId },
    }];
  } catch (e) {
    logger.error('Twitch clip extractor failed', e);
    return [];
  }
}

async function extractVod(vodId, tab) {
  try {
    // GQL: use the public endpoint with the user's cookies
    const gqlRes = await fetch('https://gql.twitch.tv/gql', {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        'Client-Id': 'kimne78kx3ncx6brgo4mv6wki5h1ko', // public web client id
      },
      body: JSON.stringify([{
        operationName: 'VideoPlayer_VODSeekbarPreviewThumbnails',
        variables: { videoID: vodId },
        extensions: {},
      }]),
    });
    // The actual VOD stream URL is gated behind a token — we'll just try the
    // direct approach: twitch.tv/videos/<id> returns the playlist URL in
    // the page HTML for public VODs.
    const html = await fetchPage(`https://www.twitch.tv/videos/${vodId}`);
    const m = html.match(/"playbackAccessToken"[^}]*"value"\s*:\s*"([^"]+)"/);
    const m3u8Match = html.match(/https:\/\/[^"'\s]+\.m3u8[^"'\s]*/i);

    if (!m3u8Match) {
      return [{
        id: `tw-vod-${vodId}`,
        type: 'video',
        title: `Twitch VOD ${vodId}`,
        variants: [],
        error: 'VOD stream URL not found — VOD may be subscriber-only or past the free window.',
        meta: { site: 'twitch', kind: 'vod', vodId },
      }];
    }

    const m3u8Url = deobfuscateUrl(m3u8Match[0].replace(/\\u002F/g, '/'));
    const m3u8Text = await fetchText(m3u8Url);
    const hlsVariants = parseManifest(m3u8Text, m3u8Url);

    const variants = hlsVariants.map(v => ({
      url: v.url,
      quality: v.audio ? 'audio' : `${v.height || 0}p`,
      height: v.height || 0,
      mime: v.mime,
      ext: v.ext,
      audio: v.audio,
      bitrate: v.bitrate,
      needsReferer: !!getSpoofedOrigin(v.url),
    }));

    variants.sort((a, b) => {
      if (a.audio !== b.audio) return a.audio ? 1 : -1;
      return (b.height || b.bitrate || 0) - (a.height || a.bitrate || 0);
    });

    return [{
      id: `tw-vod-${vodId}`,
      type: 'video',
      title: html.match(/<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i)?.[1] || `Twitch VOD ${vodId}`,
      author: html.match(/<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i)?.[1] || '',
      thumbnail: html.match(/<meta\s+property=["']og:image["']\s+content=["']([^"']+)["']/i)?.[1] || '',
      durationSec: 0,
      variants,
      meta: { site: 'twitch', kind: 'vod', vodId },
    }];
  } catch (e) {
    logger.error('Twitch VOD extractor failed', e);
    return [];
  }
}

async function fetchPage(url) {
  const res = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`Twitch fetch ${res.status}`);
  return res.text();
}

async function fetchText(url) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`Twitch manifest fetch ${res.status}`);
  return res.text();
}
