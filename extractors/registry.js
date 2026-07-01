/**
 * extractors/registry.js — extractor registration & dispatch
 *
 * An extractor is a module with:
 *   - id:         string (matches settings.sites keys)
 *   - name:       string (human-readable)
 *   - hostPattern: RegExp or function(url) → boolean
 *   - extract(tab, { settings, runner }): Promise<MediaResult[]>
 *
 * MediaResult shape:
 *   {
 *     id:          string  // stable per-media ID for deduplication
 *     type:        'video' | 'image' | 'audio'
 *     title:       string
 *     author:      string?
 *     thumbnail:   string?
 *     durationSec: number?
 *     variants:    Array<{
 *       url:         string
 *       quality:     string  // '1080p' | '720p' | 'audio' etc.
 *       height:      number
 *       mime:        string
 *       ext:         string
 *       audio:       boolean // true if audio-only
 *       bitrate:     number?
 *       needsReferer?: boolean
 *     }>
 *     meta:        object  // site-specific extras
 *   }
 *
 * Extractors run in the BACKGROUND service worker (they need fetch() and
 * the activeTab permission). Content scripts only do passive scanning
 * (DOM interception) and post the raw URLs to the background for
 * canonicalization.
 */

import { logger, siteKeyFromUrl } from '../lib/utils.js';

import { youtubeExtractor } from './youtube.js';
import { twitterExtractor } from './twitter.js';
import { instagramExtractor } from './instagram.js';
import { tiktokExtractor } from './tiktok.js';
import { redditExtractor } from './reddit.js';
import { facebookExtractor } from './facebook.js';
import { twitchExtractor } from './twitch.js';
import { bilibiliExtractor } from './bilibili.js';

const REGISTRY = new Map();

export function registerExtractor(ext) {
  if (!ext?.id) throw new Error('Extractor must have id');
  REGISTRY.set(ext.id, ext);
  logger.debug(`Registered extractor: ${ext.id}`);
}

// Register in dependency order (none currently, but ordered for readability)
[
  youtubeExtractor,
  twitterExtractor,
  instagramExtractor,
  tiktokExtractor,
  redditExtractor,
  facebookExtractor,
  twitchExtractor,
  bilibiliExtractor,
].forEach(registerExtractor);

/**
 * Get the extractor for a given URL (or null if unsupported).
 */
export function getExtractorForUrl(url) {
  const key = siteKeyFromUrl(url);
  if (!key) return null;
  return REGISTRY.get(key) || null;
}

/**
 * Run the appropriate extractor for the given tab.
 * Returns MediaResult[]. Filters out disabled sites per settings.
 */
export async function runExtractorForTab(tab, { settings }) {
  if (!tab?.url) return [];
  const ext = getExtractorForUrl(tab.url);
  if (!ext) return [];
  if (settings?.sites?.[ext.id] === false) {
    logger.info(`Site ${ext.id} disabled in settings, skipping`);
    return [];
  }
  try {
    const results = await ext.extract(tab, { settings });
    logger.info(`Extractor ${ext.id} returned ${results?.length || 0} media items`);
    return results || [];
  } catch (e) {
    logger.error(`Extractor ${ext.id} failed`, e);
    return [];
  }
}

export function listExtractors() {
  return Array.from(REGISTRY.values()).map(e => ({
    id: e.id,
    name: e.name,
    description: e.description || '',
    domains: e.domains || [],
  }));
}
