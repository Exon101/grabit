/**
 * background/background.js — GrabIt service worker (MV3)
 *
 * Responsibilities:
 *   1) Coordinate extractors on demand (popup → background → extractor → results)
 *   2) Orchestrate the 3-tier download fallback:
 *        Tier 1: chrome.downloads.download() with referer bypass via DNR
 *        Tier 2: fetch() the URL in SW, write Blob to a blob: URL, download
 *        Tier 3: open the URL in a new tab as last resort
 *   3) Maintain recent-downloads list in chrome.storage.local (last 50)
 *   4) Send desktop notifications on completion / error
 *   5) Maintain context menu "GrabIt: download this video" on supported sites
 *   6) Watch active-tab URL changes for SPA navigations (YouTube, Twitter)
 *
 * IPC: popup/options use chrome.runtime.sendMessage; we respond with
 * structured messages { ok: true, data } | { ok: false, error }.
 */

import { logger, getSettings, saveSettings, sanitizeFilename, formatBytes, storageGet, storageSet, setLogLevel, mimeToExt, siteKeyFromUrl, hasHostPermission, hasSitePermission, SITE_HOST_PATTERNS } from '../lib/utils.js';
import { runExtractorForTab, listExtractors } from '../extractors/registry.js';
import { applyDynamicBypassRules, buildStaticDnrRules, fetchWithCredentials } from '../lib/restriction-bypass.js';
import { checkForUpdates, downloadUpdate, getUpdateStatus, scheduleUpdateChecks, clearUpdateSchedule, wireAlarmHandler, wireNotificationHandler, UPDATER_DEFAULTS } from '../lib/updater.js';
import { Sentry } from '../lib/sentry.js';

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener(async (details) => {
  logger.info('GrabIt installed/updated', details);

  // Initialize Sentry error capture
  const manifest = chrome.runtime.getManifest();
  const settings = await getSettings();
  Sentry.init({
    dsn: settings.sentryDsn || null,  // null = local-only error capture
    environment: 'production',
    release: `grabit@${manifest.version}`,
    enabled: settings.errorReporting !== false,
  });
  Sentry.addBreadcrumb({ category: 'lifecycle', message: `onInstalled: ${details.reason}` });

  await initLogLevel();
  await applyStaticDnrRules();
  await createContextMenus();
  await ensureDefaultSettings();
  // Schedule update checks (default every 6h)
  if (settings.autoCheckUpdates !== false) {
    await scheduleUpdateChecks(settings.updateCheckIntervalMin || UPDATER_DEFAULTS.updateCheckIntervalMin);
  }
  // On install or major update, check immediately
  if (details.reason === 'install') {
    setTimeout(() => checkForUpdates({ manual: true }).catch(() => {}), 3000);
  }
});

chrome.runtime.onStartup.addListener(async () => {
  // Initialize Sentry on browser startup too
  const manifest = chrome.runtime.getManifest();
  const startupSettings = await getSettings();
  Sentry.init({
    dsn: startupSettings.sentryDsn || null,
    environment: 'production',
    release: `grabit@${manifest.version}`,
    enabled: startupSettings.errorReporting !== false,
  });

  await initLogLevel();
  await applyStaticDnrRules();
  await createContextMenus();
  // Re-schedule alarms (alarms don't persist across browser restarts)
  if (startupSettings.autoCheckUpdates !== false) {
    await scheduleUpdateChecks(startupSettings.updateCheckIntervalMin || UPDATER_DEFAULTS.updateCheckIntervalMin);
  }
});

// Wire updater event handlers (alarms + notification buttons)
wireAlarmHandler();
wireNotificationHandler();

async function initLogLevel() {
  const s = await getSettings();
  setLogLevel(s.debugLogging ? 'debug' : 'info');
}

async function applyStaticDnrRules() {
  if (!chrome.declarativeNetRequest) return;
  try {
    const rules = buildStaticDnrRules(100);
    // Apply as dynamic rules (static rules from dnr_rules.json are also active,
    // but we add the regex-based googlevideo rule here since static rules can't
    // use regexConditions in MV3 with isUrlFilterCaseSensitive)
    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.filter(r => r.id >= 100 && r.id < 1000).map(r => r.id),
      addRules: rules,
    });
    logger.info(`Static DNR rules applied: ${rules.length}`);
  } catch (e) {
    logger.error('Failed to apply static DNR rules', e);
  }
}

async function createContextMenus() {
  if (!chrome.contextMenus) return;
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: 'grabit-download-current',
    title: 'GrabIt: detect downloadable media on this page',
    contexts: ['page', 'video', 'link'],
    documentUrlPatterns: [
      'https://*.youtube.com/*',
      'https://*.twitter.com/*',
      'https://*.x.com/*',
      'https://*.instagram.com/*',
      'https://*.tiktok.com/*',
      'https://*.reddit.com/*',
      'https://*.facebook.com/*',
      'https://*.twitch.tv/*',
      'https://*.bilibili.com/*',
    ],
  });
}

async function ensureDefaultSettings() {
  const current = await getSettings();
  // Re-save to ensure all default keys exist in storage
  await saveSettings(current);
}

/* ------------------------------------------------------------------ *
 * IPC handlers (popup / options)
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const result = await handleMessage(msg, sender);
      sendResponse({ ok: true, data: result });
    } catch (e) {
      logger.error('Message handler error', msg?.type, e);
      Sentry.captureException(e, { messageType: msg?.type, senderTabId: sender?.tab?.id });
      sendResponse({ ok: false, error: e?.message || String(e) });
    }
  })();
  return true; // async response
});

async function handleMessage(msg, sender) {
  switch (msg?.type) {
    case 'ping':
      return { version: chrome.runtime.getManifest().version };

    case 'getSettings':
      return await getSettings();

    case 'saveSettings':
      return await saveSettings(msg.patch);

    case 'listExtractors':
      return listExtractors();

    case 'scanActiveTab':
      return await scanActiveTab();

    case 'scanTab':
      return await scanTab(msg.tabId);

    case 'hasPermission':
      // Returns { granted: boolean, siteKey: string|null }
      {
        const sk = msg.url ? siteKeyFromUrl(msg.url) : null;
        return {
          granted: sk ? await hasSitePermission(sk) : false,
          siteKey: sk,
        };
      }

    case 'hasSitePermission':
      return { granted: await hasSitePermission(msg.siteKey) };

    case 'requestPermission':
      // NOTE: chrome.permissions.request MUST be called from a user gesture.
      // The popup should call this directly via chrome.permissions.request(),
      // not via the background. We expose this for completeness but it will
      // likely fail without a user gesture context.
      return { error: 'Use chrome.permissions.request() from popup directly' };

    case 'download':
      return await startDownload(msg.payload);

    case 'recentDownloads':
      return await getRecentDownloads(msg.limit || 50);

    case 'clearRecent':
      return await clearRecentDownloads();

    case 'injectYtBridge':
      return await injectYtBridgeIntoTab(sender.tab?.id);

    case 'getUpdateStatus':
      return await getUpdateStatus();

    case 'checkForUpdates':
      return await checkForUpdates({ manual: true });

    case 'downloadUpdate':
      return await downloadUpdate();

    case 'rescheduleUpdateChecks':
      if (msg.enabled) {
        await scheduleUpdateChecks(msg.intervalMin || UPDATER_DEFAULTS.updateCheckIntervalMin);
      } else {
        await clearUpdateSchedule();
      }
      return { scheduled: msg.enabled };

    case 'clearScanCache':
      scanCache.delete(msg.tabId);
      return { ok: true };

    case 'getErrors':
      return await Sentry.getRecentErrors(msg.limit || 50);

    case 'clearErrors':
      await Sentry.clearErrors();
      return { ok: true };

    default:
      throw new Error(`Unknown message type: ${msg?.type}`);
  }
}

/* ------------------------------------------------------------------ *
 * Scanning
 * ------------------------------------------------------------------ */

async function scanActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return { tab: null, media: [] };
  return await scanTab(tab.id);
}

// Per-tab scan cache (TTL 30s) to avoid re-fetching on every popup open
const SCAN_CACHE_TTL = 30_000;
const scanCache = new Map(); // tabId -> { ts, media }

async function scanTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab?.url) return { tab, media: [], status: 'no_url' };

  // Check host permission FIRST — if missing, return a needs_permission status
  // so the popup can show an "Enable for this site" button (which must be
  // clicked from the popup's user-gesture context).
  const siteKey = siteKeyFromUrl(tab.url);
  if (siteKey) {
    // Use hasSitePermission (checks all patterns for the site) instead of
    // hasHostPermission (passes full URL to contains(), which is unreliable).
    const hasPerm = await hasSitePermission(siteKey);
    if (!hasPerm) {
      logger.info(`No host permission for ${tab.url} (site ${siteKey}) — returning needs_permission`);
      return {
        tab,
        media: [],
        status: 'needs_permission',
        siteKey,
        patterns: SITE_HOST_PATTERNS[siteKey] || [],
      };
    }
  }

  const cached = scanCache.get(tabId);
  if (cached && Date.now() - cached.ts < SCAN_CACHE_TTL) {
    logger.debug(`Scan cache hit for tab ${tabId}`);
    return { tab, media: cached.media, status: 'ok' };
  }

  const settings = await getSettings();
  const media = await runExtractorForTab(tab, { settings });

  scanCache.set(tabId, { ts: Date.now(), media });
  // Notify content script (if any) so it can update its overlay state
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'scanResult', media });
  } catch {
    // content script may not be present (e.g. on unsupported page)
  }
  return { tab, media, status: 'ok' };
}

/* ------------------------------------------------------------------ *
 * Download orchestration — 3-tier fallback
 * ------------------------------------------------------------------ */

async function startDownload(payload) {
  const { url, filename, mediaId, quality, needsReferer, mime, meta } = payload;
  const settings = await getSettings();

  const finalFilename = buildFilename(filename, mime, settings, meta, quality);
  logger.info(`Starting download: ${finalFilename}`, { url: url.slice(0, 80) + '…' });

  const entry = {
    id: `dl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    mediaId,
    url,
    filename: finalFilename,
    quality,
    status: 'starting',
    startedAt: Date.now(),
    error: null,
    bytesReceived: 0,
  };
  await recordDownload(entry);

  // Tier 1: chrome.downloads.download — works for URLs without referer requirement
  if (!needsReferer) {
    const ok = await tryChromeDownload(url, finalFilename, settings, entry);
    if (ok) return { ok: true, tier: 1, id: entry.id };
  }

  // Tier 2: fetch() in SW + Blob URL download — bypasses referer via DNR
  logger.info('Tier 1 failed or needs referer; trying Tier 2 (fetch+blob)');
  const ok = await tryFetchBlobDownload(url, finalFilename, settings, entry);
  if (ok) return { ok: true, tier: 2, id: entry.id };

  // Tier 3: open in new tab as last resort
  logger.warn('Tier 2 failed; falling back to Tier 3 (open in tab)');
  await chrome.tabs.create({ url, active: false });
  await updateDownload(entry.id, { status: 'opened-in-tab', completedAt: Date.now() });
  if (settings.notifyOnError) {
    await notify('GrabIt: download fell back to opening in tab',
      `"${finalFilename}" couldn't be downloaded directly — opened in a new tab instead.`);
  }
  return { ok: true, tier: 3, id: entry.id };
}

async function tryChromeDownload(url, filename, settings, entry) {
  try {
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url,
          filename: pathJoin(settings.downloadFolder, filename),
          saveAs: false,
          conflictAction: 'uniquify',
        },
        (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        },
      );
    });

    // Track progress
    const listener = (delta) => {
      if (delta.id !== downloadId) return;
      if (delta.state?.current === 'in_progress' && delta.bytesReceived) {
        updateDownload(entry.id, { bytesReceived: delta.bytesReceived.current, status: 'downloading' });
      }
      if (delta.state?.current === 'complete') {
        chrome.downloads.onChanged.removeListener(listener);
        updateDownload(entry.id, { status: 'complete', completedAt: Date.now() });
        if (settings.notifyOnComplete) {
          notify('GrabIt download complete', filename);
        }
      }
      if (delta.state?.current === 'interrupted') {
        chrome.downloads.onChanged.removeListener(listener);
        updateDownload(entry.id, { status: 'error', error: delta.error?.current || 'interrupted', completedAt: Date.now() });
        if (settings.notifyOnError) {
          notify('GrabIt download failed', `${filename}: ${delta.error?.current || 'interrupted'}`);
        }
      }
    };
    chrome.downloads.onChanged.addListener(listener);
    return true;
  } catch (e) {
    logger.warn('chrome.downloads.download failed', e?.message);
    return false;
  }
}

async function tryFetchBlobDownload(url, filename, settings, entry) {
  try {
    const blob = await fetchWithCredentials(url, { timeoutMs: 60_000 });
    if (!blob || blob.size === 0) {
      logger.warn('fetchWithCredentials returned empty blob');
      return false;
    }
    logger.info(`Fetched ${formatBytes(blob.size)} via Tier 2`);
    await updateDownload(entry.id, { bytesReceived: blob.size, status: 'downloading' });

    // Convert blob to object URL and trigger download
    const objectUrl = URL.createObjectURL(blob);
    const downloadId = await new Promise((resolve, reject) => {
      chrome.downloads.download(
        {
          url: objectUrl,
          filename: pathJoin(settings.downloadFolder, filename),
          saveAs: false,
          conflictAction: 'uniquify',
        },
        (id) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(id);
        },
      );
    });

    // Clean up the blob URL once download completes
    const cleanup = (delta) => {
      if (delta.id !== downloadId && delta.state?.current !== 'complete' && delta.state?.current !== 'interrupted') return;
      chrome.downloads.onChanged.removeListener(cleanup);
      // Revoke after 60s to ensure download has fully started
      setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
      if (delta.state?.current === 'complete') {
        updateDownload(entry.id, { status: 'complete', completedAt: Date.now() });
        if (settings.notifyOnComplete) notify('GrabIt download complete', filename);
      } else {
        updateDownload(entry.id, { status: 'error', error: delta.error?.current || 'interrupted', completedAt: Date.now() });
        if (settings.notifyOnError) notify('GrabIt download failed', filename);
      }
    };
    chrome.downloads.onChanged.addListener(cleanup);

    return true;
  } catch (e) {
    logger.warn('Tier 2 fetch+blob failed', e?.message);
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * Recent downloads storage
 * ------------------------------------------------------------------ */

const RECENT_KEY = 'recent_downloads';
const RECENT_MAX = 50;

async function recordDownload(entry) {
  const list = (await storageGet('local', RECENT_KEY, [])) || [];
  list.unshift(entry);
  if (list.length > RECENT_MAX) list.length = RECENT_MAX;
  await storageSet('local', RECENT_KEY, list);
  // Notify popup if open
  broadcast({ type: 'recentUpdated', list: list.slice(0, 10) }).catch(() => {});
}

async function updateDownload(id, patch) {
  const list = (await storageGet('local', RECENT_KEY, [])) || [];
  const idx = list.findIndex(e => e.id === id);
  if (idx < 0) return;
  list[idx] = { ...list[idx], ...patch };
  await storageSet('local', RECENT_KEY, list);
  broadcast({ type: 'recentUpdated', list: list.slice(0, 10) }).catch(() => {});
}

async function getRecentDownloads(limit = 50) {
  const list = (await storageGet('local', RECENT_KEY, [])) || [];
  return list.slice(0, limit);
}

async function clearRecentDownloads() {
  await storageSet('local', RECENT_KEY, []);
  return true;
}

async function broadcast(msg) {
  const tabs = await chrome.tabs.query({});
  for (const t of tabs) {
    try { await chrome.tabs.sendMessage(t.id, msg); } catch { /* ignore */ }
  }
  try { await chrome.runtime.sendMessage(msg); } catch { /* ignore */ }
}

/* ------------------------------------------------------------------ *
 * Context menu + tab change observers
 * ------------------------------------------------------------------ */

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'grabit-download-current') return;
  if (!tab?.id) return;
  // Open popup by sending a message — popup will handle UI
  // (chrome.action.openPopup() is only available in MV3 since Chrome 127 and requires user gesture)
  // Instead: scan and notify the content script to show overlay
  const { media } = await scanTab(tab.id);
  if (!media.length) {
    await notify('GrabIt: no media found', 'No downloadable media detected on this page.');
    return;
  }
  // Auto-start first media's best variant
  const first = media[0];
  const variant = first.variants[0];
  if (variant) {
    await startDownload({
      url: variant.url,
      filename: first.title,
      mediaId: first.id,
      quality: variant.quality,
      needsReferer: variant.needsReferer,
      mime: variant.mime,
      meta: { site: first.meta?.site, title: first.title, author: first.author },
    });
  }
});

// SPA navigation: re-scan on history state changes
chrome.tabs.onUpdated.addListener(async (tabId, change, tab) => {
  if (change.status === 'complete' && tab.url) {
    // Invalidate scan cache so next popup open re-scans
    scanCache.delete(tabId);
  }
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function buildFilename(rawName, mime, settings, meta, quality) {
  const tmpl = settings.filenameTemplate || '{site}_{title}_{quality}.{ext}';
  const ext = (mime && mimeToExt(mime)) || extFromMeta(meta) || 'mp4';
  const site = meta?.site || 'media';
  const title = sanitizeFilename(rawName || meta?.title || 'untitled', { maxLength: 80 });
  const q = quality || 'source';

  const filled = tmpl
    .replace(/\{site\}/g, site)
    .replace(/\{title\}/g, title)
    .replace(/\{quality\}/g, sanitizeFilename(q, { maxLength: 12 }))
    .replace(/\{ext\}/g, ext)
    .replace(/\{author\}/g, sanitizeFilename(meta?.author || '', { maxLength: 30, fallback: 'unknown' }))
    .replace(/\{date\}/g, new Date().toISOString().slice(0, 10));

  return sanitizeFilename(filled, { maxLength: 180 });
}

function extFromMeta(meta) {
  if (!meta?.site) return '';
  const map = {
    youtube: 'mp4', twitter: 'mp4', instagram: 'mp4', tiktok: 'mp4',
    reddit: 'mp4', facebook: 'mp4', twitch: 'mp4', bilibili: 'mp4',
  };
  return map[meta.site] || '';
}

function pathJoin(folder, filename) {
  if (!folder) return filename;
  const f = folder.replace(/^[/\\]+|[/\\]+$/g, '');
  const n = filename.replace(/^[/\\]+/, '');
  return `${f}/${n}`;
}

/**
 * Inject lib/yt-bridge.js into the page's MAIN world.
 * The bridge exposes window.__grabit_yt_resolve(url) that the YouTube
 * extractor can use to resolve ciphered video URLs.
 */
async function injectYtBridgeIntoTab(tabId) {
  if (!tabId) return { ok: false, error: 'No tabId' };
  if (!chrome.scripting) return { ok: false, error: 'scripting API unavailable' };
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      files: ['lib/yt-bridge.js'],
    });
    logger.info(`YT bridge injected into tab ${tabId}`);
    return { ok: true };
  } catch (e) {
    logger.warn('YT bridge injection failed', e?.message);
    return { ok: false, error: e?.message || 'injection failed' };
  }
}

async function notify(title, message) {
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title,
      message,
      priority: 0,
    });
  } catch (e) {
    logger.warn('Notification failed', e?.message);
  }
}

logger.info('GrabIt background service worker loaded');
