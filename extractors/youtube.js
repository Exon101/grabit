/**
 * extractors/youtube.js
 *
 * Extracts video variants from a YouTube watch or shorts URL.
 *
 * Strategy (three-tier, most reliable first):
 *
 *   1) MAIN-WORLD SCRIPT INJECTION (primary):
 *      Use chrome.scripting.executeScript({ world: 'MAIN' }) to read
 *      ytInitialPlayerResponse directly from the page's JavaScript context.
 *      This is the SAME data YouTube's own player uses. No HTML parsing,
 *      no consent pages, no bot detection — the page is already loaded
 *      in the user's browser with their cookies.
 *
 *      For ciphered URLs (signatureCipher), we also try to resolve them
 *      by calling the page's own player functions.
 *
 *   2) HTML SCRAPE (fallback):
 *      Fetch the watch page HTML and extract ytInitialPlayerResponse
 *      using balanced-brace matching. Used when the content script
 *      isn't available (e.g. tab not fully loaded).
 *
 *   3) INNERTUBE API (last resort):
 *      POST to youtubei/v1/player. Often returns UNPLAYABLE without
 *      a valid signatureTimestamp, but worth trying as a last resort.
 */

import { logger, mimeToExt } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';

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

    logger.info(`YouTube: extracting video ${videoId} from ${url}`);

    // 1) PRIMARY: Read ytInitialPlayerResponse from the page's MAIN world.
    //    This is the most reliable method — the page is already loaded
    //    with the user's cookies, so no consent/bot-detection issues.
    let playerResponse = null;
    try {
      playerResponse = await fetchViaMainWorld(tab.id);
      if (playerResponse?.streamingData?.formats?.length || playerResponse?.streamingData?.adaptiveFormats?.length) {
        logger.info('YouTube: MAIN-world extraction succeeded — got streaming data');
      } else {
        logger.warn('YouTube: MAIN-world extraction returned no streaming data');
        playerResponse = null;
      }
    } catch (e) {
      logger.warn('YouTube: MAIN-world extraction failed:', e?.message);
    }

    // 2) FALLBACK: HTML scrape
    if (!playerResponse) {
      try {
        playerResponse = await fetchViaHtmlScrape(url);
        if (playerResponse?.streamingData?.formats?.length || playerResponse?.streamingData?.adaptiveFormats?.length) {
          logger.info('YouTube: HTML scrape succeeded — got streaming data');
        } else {
          logger.warn('YouTube: HTML scrape returned no streaming data');
          playerResponse = null;
        }
      } catch (e) {
        logger.warn('YouTube: HTML scrape failed:', e?.message);
      }
    }

    // 3) LAST RESORT: Innertube API
    if (!playerResponse) {
      try {
        playerResponse = await fetchViaInnertube(videoId, tab.url);
        logger.info('YouTube: Innertube API succeeded');
      } catch (e) {
        logger.warn('YouTube: Innertube API failed:', e?.message);
      }
    }

    if (!playerResponse) {
      return [{
        id: `yt-${videoId}`,
        type: 'video',
        title: 'YouTube video',
        variants: [],
        error: `Could not extract video data after trying 3 methods (page script, HTML scrape, Innertube API). This may be due to YouTube's bot detection, a consent page, or the video being age-restricted/private. Try: 1) Refresh the YouTube page, 2) Make sure you're logged in, 3) Open in a regular (not incognito) window.`,
        meta: { site: 'youtube', videoId },
      }];
    }

    // Try to resolve ciphered URLs via the page's MAIN world
    let resolvedFormats = playerResponse.streamingData?.formats || [];
    let resolvedAdaptive = playerResponse.streamingData?.adaptiveFormats || [];

    // If we have ciphered URLs, try to resolve them via the page
    const hasCiphered = [...resolvedFormats, ...resolvedAdaptive].some(f => !f.url && f.signatureCipher);
    if (hasCiphered) {
      logger.info(`YouTube: found ciphered URLs, attempting to resolve via page...`);
      try {
        const resolved = await resolveCipheredViaMainWorld(tab.id, playerResponse);
        if (resolved?.formats?.length) resolvedFormats = resolved.formats;
        if (resolved?.adaptiveFormats?.length) resolvedAdaptive = resolved.adaptiveFormats;
        logger.info(`YouTube: resolved ${resolvedFormats.length + resolvedAdaptive.length} formats via page`);
      } catch (e) {
        logger.warn('YouTube: could not resolve ciphered URLs via page:', e?.message);
      }
    }

    return buildResult(playerResponse, resolvedFormats, resolvedAdaptive, videoId, tab.id);
  },
};

function extractVideoId(url) {
  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/live\/([a-zA-Z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

/**
 * Read ytInitialPlayerResponse from the page's MAIN world.
 * The page is already loaded in the user's browser, so this bypasses
 * all consent/bot-detection issues.
 */
async function fetchViaMainWorld(tabId) {
  if (!tabId || !chrome.scripting) throw new Error('No tabId or scripting API');

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: () => {
      // Return ytInitialPlayerResponse if it exists
      if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse) {
        return ytInitialPlayerResponse;
      }
      return null;
    },
  });

  return results?.[0]?.result || null;
}

/**
 * Try to resolve ciphered URLs by calling the page's own player functions.
 * The page's YouTube player has already decoded these URLs — we just need
 * to find them.
 */
async function resolveCipheredViaMainWorld(tabId, playerResponse) {
  if (!tabId || !chrome.scripting) return null;

  const formats = playerResponse?.streamingData?.formats || [];
  const adaptive = playerResponse?.streamingData?.adaptiveFormats || [];

  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: (formatsJson, adaptiveJson) => {
      const formats = JSON.parse(formatsJson);
      const adaptive = JSON.parse(adaptiveJson);
      const all = [...formats, ...adaptive];

      // Try to find resolved URLs in the page's player
      const resolved = all.map(f => {
        if (f.url) return { ...f, url: f.url };

        // Parse signatureCipher: "s=SIG&url=URL&sp=SIG_PARAM"
        if (f.signatureCipher) {
          const params = new URLSearchParams(f.signatureCipher);
          const sig = params.get('s');
          const url = params.get('url');
          const sp = params.get('sp') || 'signature';

          if (url && sig) {
            // Try to resolve using the page's signature decoder
            // The decoder is in the player JS — we can try to access it
            // via ytplayer or the player's internal API
            try {
              // Method 1: Check if window.ytplayer has the decode function
              if (typeof ytplayer !== 'undefined' && ytplayer?.config?.args) {
                // The player may have already decoded some URLs
                const raw = ytplayer.config.args.raw_player_response;
                if (raw) {
                  const rawFormats = [...(raw.streamingData?.formats || []), ...(raw.streamingData?.adaptiveFormats || [])];
                  const match = rawFormats.find(rf => rf.itag === f.itag && rf.url);
                  if (match) return { ...f, url: match.url };
                }
              }
            } catch {}

            // Method 2: Try the player's internal signature resolver
            // This is fragile — YouTube renames these functions often
            try {
              if (typeof document !== 'undefined') {
                const player = document.getElementById('movie_player');
                if (player && player.getPlayerResponse) {
                  const pr = player.getPlayerResponse();
                  const prFormats = [...(pr?.streamingData?.formats || []), ...(pr?.streamingData?.adaptiveFormats || [])];
                  const match = prFormats.find(rf => rf.itag === f.itag && rf.url);
                  if (match) return { ...f, url: match.url };
                }
              }
            } catch {}

            // Method 3: Return the URL with the ciphered signature as-is
            // (will likely fail, but better than nothing)
            return { ...f, url: url + '&' + sp + '=' + sig, ciphered: true };
          }
        }

        return f;
      });

      return {
        formats: resolved.filter(f => f.itag && formats.some(orig => orig.itag === f.itag)),
        adaptiveFormats: resolved.filter(f => f.itag && adaptive.some(orig => orig.itag === f.itag)),
      };
    },
    args: [JSON.stringify(formats), JSON.stringify(adaptive)],
  });

  return results?.[0]?.result || null;
}

/**
 * Fallback: fetch the watch page HTML and extract ytInitialPlayerResponse.
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

function extractPlayerResponseFromHtml(html) {
  const markers = [
    'ytInitialPlayerResponse = ',
    'ytInitialPlayerResponse":',
    '"ytInitialPlayerResponse":',
  ];

  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;

    const braceStart = html.indexOf('{', idx);
    if (braceStart === -1) continue;

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
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`Innertube API ${res.status}`);
  }

  return res.json();
}

function buildResult(pr, formats, adaptive, videoId, tabId) {
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

  const variants = [];
  const seen = new Set();

  for (const f of [...formats, ...adaptive]) {
    if (!f.url) continue; // Skip URLs we couldn't resolve

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
      ciphered: !!f.ciphered,
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
      error: 'No downloadable streams found. YouTube now ciphered all video URLs and GrabIt could not resolve them via the page\'s player. This is a known limitation — see GitHub issues for progress on a signature decoder.',
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
