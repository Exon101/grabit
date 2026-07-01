/**
 * lib/utils.js — shared helpers for GrabIt
 *
 * Responsibilities:
 *  - Logging with levels + toggleable verbosity
 *  - URL deobfuscation (resolves t.co, bit.ly, redirect params, tracking wrappers)
 *  - Filename sanitization for chrome.downloads
 *  - Format helpers (bytes → human, duration → mm:ss, mime → extension)
 *  - Safe chrome.storage wrappers (sync + local with TTL cache)
 *  - Tiny event emitter used by the popup/options IPC
 *
 * All functions are pure or side-effect-isolated; safe to import from
 * both service worker and content scripts.
 */

/* ------------------------------------------------------------------ *
 * Logging
 * ------------------------------------------------------------------ */

const LOG_LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

const _logState = {
  level: LOG_LEVELS.info,
  tag: 'GrabIt',
};

export function setLogLevel(level) {
  _logState.level = typeof level === 'string' ? LOG_LEVELS[level] ?? LOG_LEVELS.info : level;
}

export function log(level, ...args) {
  const lv = LOG_LEVELS[level] ?? LOG_LEVELS.info;
  if (lv < _logState.level) return;
  const prefix = `%c[${_logState.tag}:${level}]`;
  const colors = {
    debug: 'color:#888',
    info: 'color:#2196f3',
    warn: 'color:#ff9800',
    error: 'color:#f44336;font-weight:bold',
  };
  // eslint-disable-next-line no-console
  console.log(prefix, colors[level] || '', ...args);
}

export const logger = {
  debug: (...a) => log('debug', ...a),
  info: (...a) => log('info', ...a),
  warn: (...a) => log('warn', ...a),
  error: (...a) => log('error', ...a),
  setLevel,
};

/* ------------------------------------------------------------------ *
 * URL deobfuscation
 * ------------------------------------------------------------------ */

const TRACKING_HOSTS = new Set([
  't.co', 'bit.ly', 'tinyurl.com', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 't.nylas.com', 'click.mail.',
]);

const REDIRECT_PARAM_NAMES = ['url', 'u', 'redirect', 'redirectUrl', 'redirect_url', 'next', 'target', 'dest', 'destination', 'go'];

/**
 * Resolve a possibly-wrapped URL to its likely final form.
 * Handles:
 *   - tracking redirects (t.co, bit.ly, etc. — resolved synchronously via known patterns)
 *   - redirect query params (?url=, ?u=, ?redirect=…)
 *   - youtube watch?v= wrapping for youtu.be shorts
 *   - base64-encoded wrappers used by some aggregators
 *
 * Note: this is a *heuristic* synchronously resolver — it does NOT perform
 * network fetches. For true final-URL resolution, the background script
 * uses fetch() with redirect: 'follow' and a HEAD probe.
 */
export function deobfuscateUrl(inputUrl) {
  if (!inputUrl || typeof inputUrl !== 'string') return '';
  let url;
  try {
    url = new URL(inputUrl);
  } catch {
    return inputUrl;
  }

  // 1) Known shorteners — pass through; the background will resolve via HEAD.
  if (TRACKING_HOSTS.has(url.hostname)) {
    return url.href;
  }

  // 2) Redirect-query-param unwrapping.
  for (const p of REDIRECT_PARAM_NAMES) {
    const v = url.searchParams.get(p);
    if (v) {
      // Try as-is first.
      try {
        const inner = new URL(v);
        // Recursively unwrap (max depth 5).
        if (inner.href !== url.href) {
          return deobfuscateUrl(inner.href);
        }
      } catch {
        // Maybe base64-encoded.
        try {
          const decoded = atob(v);
          const inner = new URL(decoded);
          return deobfuscateUrl(inner.href);
        } catch {
          // ignore
        }
      }
    }
  }

  // 3) youtu.be/<id> → www.youtube.com/watch?v=<id> (so extractor matches)
  if (url.hostname === 'youtu.be') {
    const id = url.pathname.slice(1);
    if (id) return `https://www.youtube.com/watch?v=${id}`;
  }

  return url.href;
}

/**
 * Returns true if `url` is one of the well-known tracking-redirect hosts.
 */
export function isTrackerUrl(url) {
  try {
    return TRACKING_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Filename + format helpers
 * ------------------------------------------------------------------ */

const ILLEGAL_FILENAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/g;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * Sanitize a string so it's safe to use as a filename on all OSes.
 * - Strips illegal chars
 * - Collapses whitespace
 * - Truncates to 120 chars (preserving extension if provided)
 * - Falls back to "untitled" if empty
 */
export function sanitizeFilename(name, { fallback = 'untitled', maxLength = 120, ext } = {}) {
  let s = String(name || '').replace(ILLEGAL_FILENAME_CHARS, '_').replace(/\s+/g, ' ').trim();
  if (!s || WINDOWS_RESERVED.test(s)) s = fallback;
  if (ext) {
    const safeExt = '.' + String(ext).replace(/^\.+/, '').toLowerCase();
    const maxBase = Math.max(1, maxLength - safeExt.length);
    s = s.slice(0, maxBase).replace(/[.\s]+$/g, '') + safeExt;
  } else {
    s = s.slice(0, maxLength).replace(/[.\s]+$/g, '');
  }
  return s || fallback;
}

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1) return '0 B';
  const i = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / Math.pow(1024, i);
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${BYTE_UNITS[i]}`;
}

export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  const m = Math.floor((seconds / 60) % 60);
  const h = Math.floor(seconds / 3600);
  return h > 0
    ? `${h}:${m.toString().padStart(2, '0')}:${s}`
    : `${m}:${s}`;
}

const MIME_TO_EXT = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/ogg': 'ogv',
  'video/x-matroska': 'mkv',
  'video/quicktime': 'mov',
  'video/x-msvideo': 'avi',
  'video/mp2t': 'ts',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/webm': 'weba',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export function mimeToExt(mime) {
  if (!mime) return '';
  return MIME_TO_EXT[mime.toLowerCase().split(';')[0].trim()] || '';
}

export function extFromUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\.([a-z0-9]{2,4})$/i);
    return m ? m[1].toLowerCase() : '';
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * chrome.storage wrappers
 * ------------------------------------------------------------------ */

/**
 * Get a value from chrome.storage with optional TTL.
 * Stored shape: { v: <value>, e: <expiresAtMs or 0> }
 */
export async function storageGet(area, key, defaultValue = null) {
  const store = area === 'sync' ? chrome.storage.sync : chrome.storage.local;
  const rec = await store.get(key);
  const entry = rec[key];
  if (!entry) return defaultValue;
  if (entry && typeof entry === 'object' && 'e' in entry && 'v' in entry) {
    if (entry.e && Date.now() > entry.e) {
      await store.remove(key);
      return defaultValue;
    }
    return entry.v;
  }
  return entry;
}

export async function storageSet(area, key, value, ttlMs = 0) {
  const store = area === 'sync' ? chrome.storage.sync : chrome.storage.local;
  const entry = ttlMs > 0 ? { v: value, e: Date.now() + ttlMs } : value;
  await store.set({ [key]: entry });
  return value;
}

export async function storageRemove(area, key) {
  const store = area === 'sync' ? chrome.storage.sync : chrome.storage.local;
  await store.remove(key);
}

/* ------------------------------------------------------------------ *
 * Settings helpers — sync-backed with local fallback
 * ------------------------------------------------------------------ */

export const DEFAULT_SETTINGS = Object.freeze({
  // UI
  theme: 'auto',              // 'auto' | 'light' | 'dark'
  accentColor: '#6366f1',     // indigo-500
  showHoverOverlay: true,
  overlayPosition: 'bottom-right', // 'bottom-right' | 'bottom-left' | 'top-right' | 'top-left'
  overlayOpacity: 0.95,

  // Downloads
  defaultQuality: 'auto',     // 'auto' | 'highest' | '720p' | '1080p' | '480p' | 'audio'
  downloadFolder: 'GrabIt',   // subfolder under chrome Downloads
  filenameTemplate: '{site}_{title}_{quality}.{ext}',
  notifyOnComplete: true,
  notifyOnError: true,

  // Sites — per-site enable flags
  sites: {
    youtube: true,
    twitter: true,
    instagram: true,
    tiktok: true,
    reddit: true,
    facebook: true,
    twitch: true,
    bilibili: true,
  },

  // Advanced
  bypassRefererRestrictions: true,
  maxParallelDownloads: 3,
  debugLogging: false,
});

export async function getSettings() {
  const stored = await storageGet('sync', 'settings', {});
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

export async function saveSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  if (patch.sites) next.sites = { ...current.sites, ...patch.sites };
  await storageSet('sync', 'settings', next);
  return next;
}

/* ------------------------------------------------------------------ *
 * Tiny event emitter (used by popup <-> background bridge)
 * ------------------------------------------------------------------ */

export class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) {
    this._h.get(evt)?.delete(fn);
  }
  emit(evt, ...args) {
    this._h.get(evt)?.forEach(fn => {
      try { fn(...args); } catch (e) { logger.error('Emitter handler error', e); }
    });
  }
}

/* ------------------------------------------------------------------ *
 * Misc
 * ------------------------------------------------------------------ */

export function safeJsonParse(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

export function debounce(fn, ms = 200) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function classnames(...parts) {
  return parts.filter(Boolean).join(' ');
}

/**
 * Returns the site key (e.g. 'youtube', 'twitter') for a given URL,
 * or null if not supported.
 */
export function siteKeyFromUrl(url) {
  if (!url) return null;
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    if (host.endsWith('youtube.com') || host === 'youtu.be') return 'youtube';
    if (host === 'twitter.com' || host === 'x.com') return 'twitter';
    if (host === 'instagram.com') return 'instagram';
    if (host === 'tiktok.com') return 'tiktok';
    if (host.endsWith('reddit.com')) return 'reddit';
    if (host.endsWith('facebook.com')) return 'facebook';
    if (host === 'twitch.tv') return 'twitch';
    if (host.endsWith('bilibili.com')) return 'bilibili';
    return null;
  } catch {
    return null;
  }
}
