/**
 * lib/dash-hls.js — lightweight DASH/HLS manifest parser for GrabIt
 *
 * Goal: given a master playlist URL (m3u8 or mpd) and the response text,
 * produce a flat list of variant streams with { url, mime, height, bitrate,
 * ext } sorted by quality (highest first).
 *
 * We intentionally don't fully parse every DASH/HLS feature — only enough
 * to populate the quality dropdown in the popup. The actual download is
 * performed by the service worker's fetch fallback, which streams the
 * chosen variant URL through chrome.downloads.
 *
 * For sites that don't expose a master playlist (e.g. TikTok direct CDN),
 * the extractor passes a single-variant list and this module is bypassed.
 */

import { logger, mimeToExt } from './utils.js';

/* ------------------------------------------------------------------ *
 * HLS (.m3u8) — RFC 8216
 * ------------------------------------------------------------------ */

/**
 * Parse an HLS master playlist.
 * Returns variants sorted by bandwidth (highest first).
 * Each variant: { url, mime:'video/mp2t', height, bandwidth, ext:'ts' }
 */
export function parseHlsMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(l => l.trim());
  const variants = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    // Parse attributes
    const attrs = parseHlsAttrs(line.substring('#EXT-X-STREAM-INF:'.length));
    const bandwidth = parseInt(attrs.BANDWIDTH || '0', 10);
    const resolution = attrs.RESOLUTION || '';
    const height = resolution ? parseInt(resolution.split('x')[1], 10) : 0;
    const codecs = attrs.CODECS || '';

    const urlLine = lines[i + 1];
    if (!urlLine || urlLine.startsWith('#')) continue;

    const variantUrl = resolveUrl(urlLine, baseUrl);
    if (!variantUrl) continue;

    // Determine container from codecs: if audio-only (no video codec), ext is m4a/mp3
    const audioOnly = !/avc|hevc|vp0?[89]/i.test(codecs) && /mp4a|ec-3|ac-3/i.test(codecs);

    variants.push({
      url: variantUrl,
      mime: 'video/mp2t',
      height,
      bandwidth,
      codecs,
      ext: audioOnly ? 'm4a' : 'ts',
      audio: audioOnly,
    });
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  if (variants.length === 0) {
    logger.warn('HLS master had no variants', { baseUrl });
  }
  return variants;
}

/**
 * Check if an HLS playlist is a master (lists variants) or a media playlist.
 */
export function isHlsMasterPlaylist(text) {
  return /#EXT-X-STREAM-INF/.test(text);
}

/* ------------------------------------------------------------------ *
 * DASH (.mpd) — ISO/IEC 23009-1
 * ------------------------------------------------------------------ */

/**
 * Parse a DASH manifest MPD. Returns a list of variant objects:
 * { url, mime, height, bandwidth, codecs, ext, audio }
 *
 * This is a *pragmatic* parser — it handles the common patterns:
 *   - SegmentBase / SegmentList / SegmentTemplate
 *   - Single-URL AdaptationSet (one Representation = one URL)
 *   - Resolves $Number$ and $Bandwidth$ template vars
 */
export function parseDashManifest(text, baseUrl) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) {
    logger.warn('DASH manifest XML parse error');
    return [];
  }

  const mpd = doc.querySelector('MPD');
  if (!mpd) return [];

  const variants = [];
  const adaptationSets = doc.querySelectorAll('AdaptationSet');

  for (const as of adaptationSets) {
    const asMimeType = as.getAttribute('mimeType') || '';
    const asContentType = as.getAttribute('contentType') || '';
    const isVideo = asContentType === 'video' || /^video\//.test(asMimeType);
    const isAudio = asContentType === 'audio' || /^audio\//.test(asMimeType);

    const representations = as.querySelectorAll('Representation');
    for (const rep of representations) {
      const bandwidth = parseInt(rep.getAttribute('bandwidth') || '0', 10);
      const codecs = rep.getAttribute('codecs') || as.getAttribute('codecs') || '';
      const height = parseInt(rep.getAttribute('height') || '0', 10);
      const width = parseInt(rep.getAttribute('width') || '0', 10);
      const mimeType = rep.getAttribute('mimeType') || asMimeType || (isVideo ? 'video/mp4' : 'audio/mp4');

      const url = resolveDashRepresentationUrl(rep, baseUrl, bandwidth);
      if (!url) continue;

      variants.push({
        url,
        mime: mimeType,
        height: isVideo ? height : 0,
        width: isVideo ? width : 0,
        bandwidth,
        codecs,
        ext: mimeToExt(mimeType) || (isVideo ? 'mp4' : 'm4a'),
        audio: isAudio,
      });
    }
  }

  variants.sort((a, b) => b.bandwidth - a.bandwidth);
  return variants;
}

function resolveDashRepresentationUrl(rep, baseUrl, bandwidth) {
  // 1) <BaseURL> directly inside Representation
  const baseEl = rep.querySelector(':scope > BaseURL');
  if (baseEl && baseEl.textContent.trim()) {
    return resolveUrl(baseEl.textContent.trim(), baseUrl);
  }

  // 2) SegmentTemplate with $Number$ / $Bandwidth$
  const tmpl = rep.querySelector(':scope > SegmentTemplate')
    || rep.parentElement?.querySelector(':scope > SegmentTemplate');
  if (tmpl) {
    const media = tmpl.getAttribute('media');
    if (media) {
      const startNum = parseInt(tmpl.getAttribute('startNumber') || '1', 10);
      const filled = media
        .replace(/\$Bandwidth\$/g, String(bandwidth))
        .replace(/\$Number\$/g, String(startNum))
        .replace(/\$\$/g, '$');
      return resolveUrl(filled, baseUrl);
    }
  }

  // 3) SegmentList (rare) — take first SegmentURL
  const segUrl = rep.querySelector(':scope > SegmentList > SegmentURL');
  if (segUrl && segUrl.getAttribute('media')) {
    return resolveUrl(segUrl.getAttribute('media'), baseUrl);
  }

  return null;
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

function parseHlsAttrs(str) {
  const attrs = {};
  // Match KEY=VALUE, where VALUE may be quoted with embedded commas
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

function resolveUrl(maybeRel, baseUrl) {
  try {
    return new URL(maybeRel, baseUrl).href;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Top-level dispatch
 * ------------------------------------------------------------------ */

export function parseManifest(text, url) {
  if (!text) return [];
  const lower = url.toLowerCase().split('?')[0];
  if (lower.endsWith('.m3u8')) {
    if (isHlsMasterPlaylist(text)) return parseHlsMaster(text, url);
    // Media playlist (no quality variants) — return as single-variant.
    return [{
      url,
      mime: 'video/mp2t',
      height: 0,
      bandwidth: 0,
      ext: 'ts',
      audio: false,
    }];
  }
  if (lower.endsWith('.mpd')) {
    return parseDashManifest(text, url);
  }
  // Sniff by content
  if (/^#EXTM3U/.test(text.trim())) {
    return isHlsMasterPlaylist(text) ? parseHlsMaster(text, url) : [{ url, mime: 'video/mp2t', height: 0, bandwidth: 0, ext: 'ts', audio: false }];
  }
  if (/<MPD[\s>]/.test(text)) {
    return parseDashManifest(text, url);
  }
  return [];
}

/**
 * Given a list of parsed variants and a desired quality key, pick the best match.
 * qualityKey ∈ 'auto' | 'highest' | '1080p' | '720p' | '480p' | '360p' | 'audio'
 */
export function pickVariant(variants, qualityKey = 'auto') {
  if (!variants.length) return null;

  const videoVariants = variants.filter(v => !v.audio);
  const audioVariants = variants.filter(v => v.audio);

  if (qualityKey === 'audio') return audioVariants[0] || null;

  if (qualityKey === 'highest') return videoVariants[0] || variants[0];
  if (qualityKey === 'auto') {
    // Prefer 1080p if available, else highest.
    const v1080 = videoVariants.find(v => v.height >= 1080);
    return v1080 || videoVariants[0] || variants[0];
  }

  const targetHeight = parseInt(qualityKey, 10);
  if (!Number.isFinite(targetHeight)) return videoVariants[0] || variants[0];

  // Pick the variant with height closest to (but not exceeding) target.
  const atOrBelow = videoVariants.filter(v => v.height <= targetHeight);
  if (atOrBelow.length) return atOrBelow[0];

  // Nothing at or below — pick lowest available.
  return videoVariants[videoVariants.length - 1] || variants[0];
}
