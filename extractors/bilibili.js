/**
 * extractors/bilibili.js — Bilibili video extraction
 *
 * Strategy:
 *   1) Resolve the BV id from the URL (e.g. /video/BV1xx411c7mD/)
 *   2) Hit the public API: api.bilibili.com/x/web-interface/view?bvid=...
 *      to get the cid
 *   3) Hit the playurl API: api.bilibili.com/x/player/playurl?bvid=...&cid=...&qn=...
 *      to get the playable URL(s)
 *   4) Map each dash.video[].baseUrl / dash.audio[].baseUrl to a variant
 *
 * Note: Bilibili splits video and audio into separate streams (DASH-style).
 * For now we expose them as separate variants (audio-only and video-only)
 * so the user can grab either. Muxing them into a single MP4 would require
 * ffmpeg.wasm — out of scope for v1.
 */

import { logger, deobfuscateUrl } from '../lib/utils.js';
import { getSpoofedOrigin } from '../lib/restriction-bypass.js';

export const bilibiliExtractor = {
  id: 'bilibili',
  name: 'Bilibili',
  description: 'Videos from bilibili.com',
  domains: ['bilibili.com'],

  async extract(tab, _opts) {
    const url = tab.url;
    const m = url.match(/bilibili\.com\/video\/(BV[A-Za-z0-9]+|av\d+)/i);
    if (!m) return [];

    const idType = m[1].toLowerCase().startsWith('av') ? 'aid' : 'bvid';
    const idValue = m[1];

    try {
      // Step 1: get cid
      const viewRes = await fetchJson(
        `https://api.bilibili.com/x/web-interface/view?${idType}=${idValue}`,
        tab.url,
      );
      if (viewRes.code !== 0) {
        return [{
          id: `bili-${idValue}`,
          type: 'video',
          title: `Bilibili ${idValue}`,
          variants: [],
          error: `Bilibili API error: ${viewRes.message || viewRes.code}`,
          meta: { site: 'bilibili', idType, idValue },
        }];
      }

      const data = viewRes.data;
      const cid = data.cid;
      const aid = data.aid;
      const title = data.title;
      const author = data.owner?.name || '';
      const thumb = data.pic || '';
      const duration = data.duration || 0;

      // Step 2: get playurl
      const playRes = await fetchJson(
        `https://api.bilibili.com/x/player/playurl?avid=${aid}&cid=${cid}&qn=127&fnval=4048&fnver=0&fourk=1`,
        tab.url,
      );

      const variants = [];
      if (playRes.code === 0) {
        const pd = playRes.data;
        // DASH format
        if (pd.dash) {
          for (const v of pd.dash.video || []) {
            if (!v.baseUrl && !v.base_url) continue;
            const u = deobfuscateUrl(v.baseUrl || v.base_url);
            variants.push({
              url: u,
              quality: `${v.height}p (${v.codecs || ''})`,
              height: v.height || 0,
              mime: v.mimeType || 'video/mp4',
              ext: v.mimeType?.includes('av01') ? 'mp4' : 'mp4',
              audio: false,
              bitrate: v.bandwidth || 0,
              needsReferer: !!getSpoofedOrigin(u),
              codecs: v.codecs,
            });
          }
          for (const a of pd.dash.audio || []) {
            if (!a.baseUrl && !a.base_url) continue;
            const u = deobfuscateUrl(a.baseUrl || a.base_url);
            variants.push({
              url: u,
              quality: `audio ${a.codecs || ''}`.trim(),
              height: 0,
              mime: a.mimeType || 'audio/mp4',
              ext: 'm4a',
              audio: true,
              bitrate: a.bandwidth || 0,
              needsReferer: !!getSpoofedOrigin(u),
              codecs: a.codecs,
            });
          }
        }
        // durl format (legacy)
        if (!variants.length && pd.durl) {
          for (const d of pd.durl) {
            variants.push({
              url: deobfuscateUrl(d.url),
              quality: 'source',
              height: 0,
              mime: 'video/mp4',
              ext: 'mp4',
              audio: true,
              bitrate: 0,
              needsReferer: !!getSpoofedOrigin(d.url),
            });
          }
        }
      }

      variants.sort((a, b) => {
        if (a.audio !== b.audio) return a.audio ? 1 : -1;
        return (b.height || b.bitrate || 0) - (a.height || a.bitrate || 0);
      });

      if (!variants.length) {
        return [{
          id: `bili-${idValue}`,
          type: 'video',
          title,
          author,
          thumbnail: thumb,
          durationSec: duration,
          variants: [],
          error: 'No playable URL returned by Bilibili (video may be region-locked or premium).',
          meta: { site: 'bilibili', idType, idValue, aid, cid },
        }];
      }

      return [{
        id: `bili-${idValue}`,
        type: 'video',
        title,
        author,
        thumbnail: thumb,
        durationSec: duration,
        variants,
        meta: { site: 'bilibili', idType, idValue, aid, cid },
      }];
    } catch (e) {
      logger.error('Bilibili extractor failed', e);
      return [];
    }
  },
};

async function fetchJson(url, referer) {
  const res = await fetch(url, {
    credentials: 'include',
    headers: {
      'Accept': 'application/json',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': referer,
      'Sec-Fetch-Site': 'same-site',
    },
  });
  if (!res.ok) throw new Error(`Bilibili fetch ${res.status}`);
  return res.json();
}
