/**
 * extractors/youtube.js
 *
 * Extracts video variants from a YouTube watch or shorts URL.
 *
 * Strategy:
 *   1) Fetch the watch page HTML (with the user's cookies via fetch)
 *   2) Parse ytInitialPlayerResponse from a <script> tag
 *   3) Read streamingData.formats + streamingData.adaptiveFormats
 *   4) Filter out ciphered URLs (we can't easily decode signatures in the
 *      background SW — those need the yt-bridge.js MAIN-world script)
 *   5) For each unciphered URL, build a MediaResult variant
 *
 * Known limitation: age-restricted, member-only, and DRM-protected videos
 * won't yield playable URLs. We return a single error marker so the popup
 * can show a friendly message.
 */

import { logger, mimeToExt } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';

export const youtubeExtractor = {
  id: 'youtube',
  name: 'YouTube',
  description: 'Videos and Shorts from youtube.com and youtu.be',
  domains: ['youtube.com', 'youtu.be'],

  async extract(tab, _opts) {
    const url = tab.url;
    if (!/youtube\.com\/(watch|shorts|embed)|youtu\.be\//.test(url)) return [];

    try {
      const html = await fetchPage(url);
      const pr = extractPlayerResponse(html);
      if (!pr) {
        logger.warn('YouTube: ytInitialPlayerResponse not found');
        return [];
      }

      const status = pr.playabilityStatus?.status;
      if (status && status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE') {
        return [{
          id: `yt-${pr.videoDetails?.videoId || tab.id}`,
          type: 'video',
          title: pr.videoDetails?.title || 'YouTube video',
          author: pr.videoDetails?.author || '',
          thumbnail: getThumbnail(pr),
          durationSec: parseInt(pr.videoDetails?.lengthSeconds || '0', 10),
          variants: [],
          error: `YouTube says: ${status} — ${pr.playabilityStatus?.reason || ''}`,
          meta: { site: 'youtube' },
        }];
      }

      const formats = [
        ...(pr.streamingData?.formats || []),
        ...(pr.streamingData?.adaptiveFormats || []),
      ];

      const variants = [];
      const seen = new Set();

      for (const f of formats) {
        if (!f.url || f.url.startsWith('http') === false) {
          // Ciphered — skip (would need MAIN-world bridge)
          continue;
        }

        const itag = f.itag;
        if (seen.has(itag)) continue;
        seen.add(itag);

        const isAudio = f.mimeType?.startsWith('audio/');
        const mime = f.mimeType?.split(';')[0] || (isAudio ? 'audio/mp4' : 'video/mp4');
        const height = f.height || (isAudio ? 0 : guessHeightFromItag(itag));
        const quality = isAudio
          ? `${Math.round((f.bitrate || 0) / 1000)}kbps`
          : `${height}p`;

        variants.push({
          url: f.url,
          quality,
          height,
          mime,
          ext: mimeToExt(mime) || (isAudio ? 'm4a' : 'mp4'),
          audio: isAudio,
          bitrate: f.bitrate,
          needsReferer: !!getSpoofedOrigin(f.url),
          itag,
          fps: f.fps,
        });
      }

      // Sort: video by height desc, then audio by bitrate desc
      variants.sort((a, b) => {
        if (a.audio !== b.audio) return a.audio ? 1 : -1;
        return (b.height || b.bitrate || 0) - (a.height || a.bitrate || 0);
      });

      if (!variants.length) {
        return [{
          id: `yt-${pr.videoDetails?.videoId || tab.id}`,
          type: 'video',
          title: pr.videoDetails?.title || 'YouTube video',
          author: pr.videoDetails?.author || '',
          thumbnail: getThumbnail(pr),
          durationSec: parseInt(pr.videoDetails?.lengthSeconds || '0', 10),
          variants: [],
          error: 'All streams are ciphered — try opening the video first, then refresh.',
          meta: { site: 'youtube' },
        }];
      }

      return [{
        id: `yt-${pr.videoDetails?.videoId || tab.id}`,
        type: 'video',
        title: pr.videoDetails?.title || 'YouTube video',
        author: pr.videoDetails?.author || '',
        thumbnail: getThumbnail(pr),
        durationSec: parseInt(pr.videoDetails?.lengthSeconds || '0', 10),
        variants,
        meta: { site: 'youtube', videoId: pr.videoDetails?.videoId },
      }];
    } catch (e) {
      logger.error('YouTube extractor failed', e);
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
  if (!res.ok) throw new Error(`YouTube fetch ${res.status}`);
  return res.text();
}

function extractPlayerResponse(html) {
  // Try several extraction patterns
  const patterns = [
    /ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});\s*<\/script>/,
    /ytInitialPlayerResponse"\s*:\s*(\{[\s\S]*?\})\s*,\s*"ytInitialData"/,
    /var\s+ytInitialPlayerResponse\s*=\s*(\{[\s\S]*?\});/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
        continue;
      }
    }
  }
  return null;
}

function getThumbnail(pr) {
  const thumbs = pr.videoDetails?.thumbnail?.thumbnails || [];
  return thumbs[thumbs.length - 1]?.url || '';
}

// Map common itags to heights when height is missing
function guessHeightFromItag(itag) {
  const map = {
    17: 144, 36: 240, 18: 360, 43: 360, 59: 480, 78: 480,
    22: 720, 136: 720, 247: 720, 135: 480, 244: 480,
    134: 360, 243: 360, 133: 240, 242: 240,
    137: 1080, 248: 1080, 271: 1440, 313: 2160, 272: 4320,
  };
  return map[itag] || 0;
}
