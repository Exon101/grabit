/**
 * extractors/youtube.js
 *
 * Extracts video variants from a YouTube watch or shorts URL.
 *
 * Strategy (two-tier):
 *   1) PRIMARY: YouTube Innertube API (youtubei/v1/player)
 *      - This is the same API the YouTube player uses internally
 *      - Returns clean JSON with streamingData.formats + adaptiveFormats
 *      - Handles most videos including age-restricted (with login cookies)
 *      - No HTML parsing, no regex, no consent page issues
 *
 *   2) FALLBACK: HTML scrape of the watch page
 *      - Extract ytInitialPlayerResponse from <script> tags
 *      - Used when Innertube API fails (rare)
 *      - Uses balanced-brace matching (not regex) for robust JSON extraction
 *
 * The Innertube API requires:
 *   - An API key (extracted from the watch page or hard-coded public key)
 *   - A client context (video ID + client name/version)
 *
 * We use the public web client key (AIzaSyAO...) which is the same key
 * the youtube.com web player uses. It's not secret.
 */

import { logger, mimeToExt } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';

// Public Innertube API key used by the youtube.com web player.
// This is not secret — it's embedded in every youtube.com page.
const INNERTUBE_API_KEY = 'AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const INNERTUBE_ENDPOINT = 'https://www.youtube.com/youtubei/v1/player';

export const youtubeExtractor = {
  id: 'youtube',
  name: 'YouTube',
  description: 'Videos and Shorts from youtube.com and youtu.be',
  domains: ['youtube.com', 'youtu.be'],

  async extract(tab, _opts) {
    const url = tab.url;
    const videoId = extractVideoId(url);
    if (!videoId) return [];

    logger.info(`YouTube: extracting video ${videoId}`);

    // Try Innertube API first (most reliable)
    let playerResponse = null;
    try {
      playerResponse = await fetchViaInnertube(videoId, tab.url);
      logger.info('YouTube: Innertube API succeeded');
    } catch (e) {
      logger.warn('YouTube: Innertube API failed, falling back to HTML scrape', e?.message);
    }

    // Fallback: HTML scrape
    if (!playerResponse) {
      try {
        playerResponse = await fetchViaHtmlScrape(url);
        logger.info('YouTube: HTML scrape succeeded');
      } catch (e) {
        logger.error('YouTube: both extraction methods failed', e);
        return [{
          id: `yt-${videoId}`,
          type: 'video',
          title: 'YouTube video',
          variants: [],
          error: `Could not extract video data: ${e?.message || 'unknown error'}. Try refreshing the page or check your network.`,
          meta: { site: 'youtube', videoId },
        }];
      }
    }

    return buildResult(playerResponse, videoId, tab.id);
  },
};

function extractVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,           // watch?v=ID
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,       // youtu.be/ID
    /\/shorts\/([a-zA-Z0-9_-]{11})/,        // /shorts/ID
    /\/embed\/([a-zA-Z0-9_-]{11})/,         // /embed/ID
    /\/live\/([a-zA-Z0-9_-]{11})/,          // /live/ID
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * Fetch video info via the Innertube player API.
 * Returns the playerResponse JSON object.
 */
async function fetchViaInnertube(videoId, refererUrl) {
  const payload = {
    context: {
      client: {
        clientName: 'WEB',
        clientVersion: '2.20240101.00.00',
        hl: 'en',
        gl: 'US',
      },
    },
    videoId,
    playbackContext: {
      contentPlaybackContext: {
        html5Preference: 'HTML5_PREF_WANTS',
        signatureTimestamp: Date.now(),
      },
    },
    contentCheckOk: true,
    racyCheckOk: true,
  };

  const res = await fetch(`${INNERTUBE_ENDPOINT}?key=${INNERTUBE_API_KEY}`, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': '2.20240101.00.00',
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Innertube API ${res.status}`);
  }

  return res.json();
}

/**
 * Fallback: fetch the watch page HTML and extract ytInitialPlayerResponse.
 * Uses balanced-brace matching instead of regex for robust JSON extraction.
 */
async function fetchViaHtmlScrape(url) {
  const html = await fetchPage(url);
  return extractPlayerResponseFromHtml(html);
}

async function fetchPage(url) {
  const res = await fetch(url, {
    credentials: 'include',
    redirect: 'follow',
    headers: {
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1',
    },
  });
  if (!res.ok) throw new Error(`YouTube fetch ${res.status}`);
  return res.text();
}

/**
 * Extract ytInitialPlayerResponse from HTML using balanced-brace matching.
 * More robust than regex — handles nested JSON correctly.
 */
function extractPlayerResponseFromHtml(html) {
  // Find the start of ytInitialPlayerResponse
  const markers = [
    'ytInitialPlayerResponse = ',
    'ytInitialPlayerResponse":',
    '"ytInitialPlayerResponse":',
  ];

  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;

    // Find the opening brace after the marker
    const braceStart = html.indexOf('{', idx);
    if (braceStart === -1) continue;

    // Balanced-brace matching
    const json = extractBalancedJson(html, braceStart);
    if (json) {
      try {
        return JSON.parse(json);
      } catch {
        continue;
      }
    }
  }

  throw new Error('ytInitialPlayerResponse not found in HTML (page may be a consent/redirect page)');
}

/**
 * Extract a balanced JSON object starting at position `start` in `str`.
 * Returns the JSON string (including outer braces) or null.
 */
function extractBalancedJson(str, start) {
  if (str[start] !== '{') return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < str.length; i++) {
    const ch = str[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return str.substring(start, i + 1);
      }
    }
  }
  return null;
}

function buildResult(pr, videoId, tabId) {
  const status = pr?.playabilityStatus?.status;
  if (status && status !== 'OK' && status !== 'LIVE_STREAM_OFFLINE') {
    return [{
      id: `yt-${videoId}`,
      type: 'video',
      title: pr?.videoDetails?.title || 'YouTube video',
      author: pr?.videoDetails?.author || '',
      thumbnail: getThumbnail(pr),
      durationSec: parseInt(pr?.videoDetails?.lengthSeconds || '0', 10),
      variants: [],
      error: `YouTube says: ${status} — ${pr?.playabilityStatus?.reason || 'This video may be age-restricted, private, or unavailable.'}`,
      meta: { site: 'youtube', videoId },
    }];
  }

  const formats = [
    ...(pr?.streamingData?.formats || []),
    ...(pr?.streamingData?.adaptiveFormats || []),
  ];

  const variants = [];
  const seen = new Set();

  for (const f of formats) {
    // Skip ciphered URLs — we'd need the signature decoder for those.
    // (Innertube API usually returns unciphered URLs for WEB client.)
    if (!f.url) {
      // Try to construct URL from signatureCipher if we have it
      // (but we can't decode it without the player JS)
      continue;
    }

    const itag = f.itag;
    if (seen.has(itag)) continue;
    seen.add(itag);

    const isAudio = f.mimeType?.startsWith('audio/');
    const mime = f.mimeType?.split(';')[0] || (isAudio ? 'audio/mp4' : 'video/mp4');
    const height = f.height || (isAudio ? 0 : guessHeightFromItag(itag));
    const quality = isAudio
      ? `${Math.round((f.bitrate || f.averageBitrate || 0) / 1000)}kbps`
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
      id: `yt-${videoId}`,
      type: 'video',
      title: pr?.videoDetails?.title || 'YouTube video',
      author: pr?.videoDetails?.author || '',
      thumbnail: getThumbnail(pr),
      durationSec: parseInt(pr?.videoDetails?.lengthSeconds || '0', 10),
      variants: [],
      error: 'No downloadable streams found (video may use ciphered URLs that GrabIt can\'t decode yet).',
      meta: { site: 'youtube', videoId },
    }];
  }

  return [{
    id: `yt-${videoId}`,
    type: 'video',
    title: pr?.videoDetails?.title || 'YouTube video',
    author: pr?.videoDetails?.author || '',
    thumbnail: getThumbnail(pr),
    durationSec: parseInt(pr?.videoDetails?.lengthSeconds || '0', 10),
    variants,
    meta: { site: 'youtube', videoId },
  }];
}

function getThumbnail(pr) {
  const thumbs = pr?.videoDetails?.thumbnail?.thumbnails || [];
  return thumbs[thumbs.length - 1]?.url || `https://i.ytimg.com/vi/${pr?.videoDetails?.videoId}/hqdefault.jpg`;
}

function guessHeightFromItag(itag) {
  const map = {
    17: 144, 36: 240, 18: 360, 43: 360, 59: 480, 78: 480,
    22: 720, 136: 720, 247: 720, 135: 480, 244: 480,
    134: 360, 243: 360, 133: 240, 242: 240,
    137: 1080, 248: 1080, 271: 1440, 313: 2160, 272: 4320,
  };
  return map[itag] || 0;
}
