/**
 * lib/restriction-bypass.js — referer / origin / Sec-Fetch-* rewriting
 *
 * Many CDNs (especially Twitter's video.twimg.com, Instagram's static.cdn,
 * Reddit's v.redd.it) reject direct downloads with 403 unless the request
 * carries the *original* page as Referer. Chrome's MV3 service worker
 * can't set Referer on fetch() (it's a forbidden header), so we use
 * declarativeNetRequest (DNR) rules to rewrite it on the network layer.
 *
 * This module:
 *   1) Maintains a dynamic DNR rule set that maps known CDN hosts → origin.
 *   2) Provides an API to add/remove per-session bypass rules.
 *   3) Provides a fallback that uses fetch() with `credentials: 'include'`
 *      and a custom sec-fetch-mode (works for some sites that ignore referer).
 */

import { logger } from './utils.js';

/**
 * Static mapping: CDN host → origin to spoof as referer.
 * Add new entries here as new CDNs are discovered.
 */
const CDN_ORIGIN_MAP = {
  // Twitter / X
  'video.twimg.com': 'https://twitter.com',
  'video.x.com': 'https://x.com',
  'pmdvodakik.akamaized.net': 'https://twitter.com',
  // Instagram
  'scontent.cdninstagram.com': 'https://www.instagram.com',
  'video-ort.cdninstagram.com': 'https://www.instagram.com',
  // Reddit
  'v.redd.it': 'https://www.reddit.com',
  'reddit-prod.s3-accelerate.amazonaws.com': 'https://www.reddit.com',
  // TikTok
  'v19-webcast.tiktok.com': 'https://www.tiktok.com',
  'v16-webcast.tiktok.com': 'https://www.tiktok.com',
  'v77.tiktokcdn.com': 'https://www.tiktok.com',
  // Twitch
  'd2nvs31859zcd8.cloudfront.net': 'https://www.twitch.tv',
  // Bilibili
  'upos-sz-mirrorhw.bilivideo.com': 'https://www.bilibili.com',
  'upos-sz-mirrorali.bilivideo.com': 'https://www.bilibili.com',
  // YouTube (ytimg serves poster + initial segments)
  'rr[0-9]+---sn-[a-z0-9-]+\.googlevideo\.com': 'https://www.youtube.com',
};

/**
 * Get the spoofed origin for a URL, if any.
 */
export function getSpoofedOrigin(url) {
  if (!url) return null;
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }

  if (CDN_ORIGIN_MAP[host]) return CDN_ORIGIN_MAP[host];

  // Regex match (for googlevideo.com RR servers)
  for (const [pattern, origin] of Object.entries(CDN_ORIGIN_MAP)) {
    if (pattern.includes('[') || pattern.includes('\\')) {
      try {
        const re = new RegExp('^' + pattern + '$', 'i');
        if (re.test(host)) return origin;
      } catch {
        // ignore bad patterns
      }
    }
  }
  return null;
}

/**
 * Convert a static CDN_ORIGIN_MAP entry list into DNR rule objects.
 * These are also persisted in background/dnr_rules.json as static rules,
 * but we keep the dynamic copy so extractors can add per-session rules
 * for CDNs we haven't seen yet.
 *
 * @param {number} startId  first rule id to use (must not collide with static)
 * @returns {Array<{id:number, priority:number, action:object, condition:object}>}
 */
export function buildStaticDnrRules(startId = 1000) {
  const rules = [];
  let id = startId;

  for (const [host, origin] of Object.entries(CDN_ORIGIN_MAP)) {
    if (host.includes('[')) continue; // skip regex hosts (handled separately)

    rules.push({
      id: id++,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: origin + '/' },
          { header: 'Origin', operation: 'set', value: origin },
        ],
      },
      condition: {
        urlFilter: `||${host}^`,
        resourceTypes: ['media', 'xmlhttprequest', 'other'],
      },
    });
  }
  return rules;
}

/**
 * Build a single dynamic DNR rule for an arbitrary CDN host.
 */
export function buildDynamicRule(host, origin, ruleId) {
  return {
    id: ruleId,
    priority: 2,
    action: {
      type: 'modifyHeaders',
      requestHeaders: [
        { header: 'Referer', operation: 'set', value: origin + '/' },
        { header: 'Origin', operation: 'set', value: origin },
      ],
    },
    condition: {
      urlFilter: `||${host}^`,
      resourceTypes: ['media', 'xmlhttprequest', 'other'],
    },
  };
}

/**
 * Apply a list of dynamic DNR rules, replacing any previously-applied
 * dynamic rules in the same id range.
 */
export async function applyDynamicBypassRules(rules) {
  if (!chrome.declarativeNetRequest) {
    logger.warn('DNR API not available — restriction bypass disabled');
    return false;
  }
  try {
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    const removeIds = existing
      .filter(r => r.id >= 5000 && r.id < 6000)
      .map(r => r.id);

    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: removeIds,
      addRules: rules.map((r, i) => ({ ...r, id: 5000 + i })),
    });
    logger.info(`Applied ${rules.length} dynamic bypass rules (removed ${removeIds.length} old)`);
    return true;
  } catch (e) {
    logger.error('Failed to apply DNR rules', e);
    return false;
  }
}

/**
 * Fetch fallback — try to download a media URL using fetch() with credentials.
 * This works for some sites that don't enforce Referer (e.g. Reddit's v.redd.it
 * signed URLs work without spoofing if cookies are sent).
 *
 * Returns a Blob on success, null on failure.
 */
export async function fetchWithCredentials(url, { timeoutMs = 30000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'GET',
      credentials: 'include',
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        // Sec-Fetch-* helps some CDNs that check for "embedded" navigation
        'Sec-Fetch-Site': 'same-site',
        'Sec-Fetch-Mode': 'no-cors',
        'Sec-Fetch-Dest': 'video',
      },
    });
    if (!res.ok) return null;
    return await res.blob();
  } catch (e) {
    logger.warn('fetchWithCredentials failed', e?.message || e);
    return null;
  } finally {
    clearTimeout(t);
  }
}
