/**
 * lib/updater.js — GitHub release checker + in-extension update flow
 *
 * Strategy:
 *   1) Periodically (chrome.alarms) fetch the latest release from
 *      https://api.github.com/repos/Exon101/grabit/releases/latest
 *   2) Compare its tag_name to chrome.runtime.getManifest().version
 *   3) If newer, badge the toolbar icon + store update info in
 *      chrome.storage.local under 'update_status'
 *   4) Popup/options query 'getUpdateStatus' to render a banner
 *   5) User clicks "Update now" → background calls 'downloadUpdate' which
 *      triggers chrome.downloads.download() on the zip asset URL
 *   6) After download starts, we open chrome://extensions/?id=<extId> in
 *      a new tab so the user can drag-replace the folder & click Reload.
 *
 * Why not auto-reload? Chrome MV3 extensions cannot programmatically
 * replace their own files or reload themselves — security restriction.
 * The user must manually extract the new zip over the old folder and
 * click "Reload" on chrome://extensions. We make this as painless as
 * possible: download to a known subfolder, open the extensions page
 * with the GrabIt card pre-selected, and show step-by-step instructions.
 */

import { logger, storageGet, storageSet, sanitizeFilename } from './utils.js';

const REPO = 'Exon101/grabit';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const ALARM_NAME = 'grabit-update-check';

/* ------------------------------------------------------------------ *
 * Version comparison
 *   Chrome versions are up to 4 dot-separated integers (e.g. 1.2.0.4)
 * ------------------------------------------------------------------ */

/**
 * Compare two version strings.
 * @returns -1 if a < b, 0 if a == b, 1 if a > b
 */
export function compareVersions(a, b) {
  const pa = String(a || '0').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '0').split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const va = pa[i] || 0;
    const vb = pb[i] || 0;
    if (va < vb) return -1;
    if (va > vb) return 1;
  }
  return 0;
}

/**
 * Strip leading 'v' from a GitHub release tag (e.g. 'v1.2.0' → '1.2.0')
 */
export function normalizeVersion(tag) {
  return String(tag || '').replace(/^v/i, '').trim();
}

/* ------------------------------------------------------------------ *
 * Update status storage
 *
 * Stored shape (chrome.storage.local key: 'update_status'):
 *   {
 *     currentVersion: '1.2.0',
 *     latestVersion:  '1.3.0',
 *     hasUpdate:      true,
 *     releaseUrl:     'https://github.com/.../releases/tag/v1.3.0',
 *     releaseNotes:   'markdown body',
 *     zipUrl:         'https://github.com/.../releases/download/v1.3.0/grabit.zip',
 *     zipSize:        95000,
 *     publishedAt:    '2026-07-01T10:00:00Z',
 *     checkedAt:      1730000000000,
 *     error:          null | 'rate_limited' | 'network' | ...
 *   }
 * ------------------------------------------------------------------ */

const DEFAULT_STATUS = {
  currentVersion: '',
  latestVersion: '',
  hasUpdate: false,
  releaseUrl: '',
  releaseNotes: '',
  zipUrl: '',
  zipSize: 0,
  publishedAt: '',
  checkedAt: 0,
  error: null,
};

export async function getUpdateStatus() {
  const stored = await storageGet('local', 'update_status', null);
  if (!stored) {
    // Initialize with current version
    const initial = {
      ...DEFAULT_STATUS,
      currentVersion: chrome.runtime.getManifest().version,
    };
    await storageSet('local', 'update_status', initial);
    return initial;
  }
  return stored;
}

async function setUpdateStatus(patch) {
  const current = await getUpdateStatus();
  const next = { ...current, ...patch, currentVersion: chrome.runtime.getManifest().version };
  await storageSet('local', 'update_status', next);
  return next;
}

/* ------------------------------------------------------------------ *
 * GitHub API call
 * ------------------------------------------------------------------ */

/**
 * Fetch the latest release from GitHub.
 * Returns a normalized object or throws on error.
 *
 * Note: unauthenticated GitHub API allows 60 req/hr per IP. We check
 * at most every 1 hour, so this is fine.
 */
async function fetchLatestRelease() {
  const res = await fetch(API_URL, {
    headers: {
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'GrabIt-Extension-Updater',
    },
  });

  if (res.status === 403 || res.status === 429) {
    // Rate limited
    const reset = res.headers.get('X-RateLimit-Reset');
    throw Object.assign(new Error('rate_limited'), { code: 'rate_limited', resetAt: reset ? parseInt(reset, 10) * 1000 : null });
  }
  if (res.status === 404) {
    throw Object.assign(new Error('no_releases'), { code: 'no_releases' });
  }
  if (!res.ok) {
    throw Object.assign(new Error(`http_${res.status}`), { code: 'http_error', status: res.status });
  }

  const data = await res.json();
  const tag = normalizeVersion(data.tag_name);
  const asset = (data.assets || []).find(a => a.name.endsWith('.zip')) || null;

  return {
    latestVersion: tag,
    releaseUrl: data.html_url || RELEASES_PAGE,
    releaseNotes: data.body || '',
    zipUrl: asset?.browser_download_url || '',
    zipSize: asset?.size || 0,
    publishedAt: data.published_at || data.created_at || '',
  };
}

/* ------------------------------------------------------------------ *
 * Top-level check function
 * ------------------------------------------------------------------ */

/**
 * Check GitHub for a newer release. Updates chrome.storage.local +
 * badges the toolbar icon if an update is available.
 *
 * @param {object} opts
 * @param {boolean} opts.manual  true if triggered by user (forces re-check
 *                                even if recently checked)
 * @returns {Promise<object>} the new update status
 */
export async function checkForUpdates({ manual = false } = {}) {
  logger.info(`Checking for updates${manual ? ' (manual)' : ''}…`);
  const currentVersion = chrome.runtime.getManifest().version;

  // Throttle automatic checks to once per hour (manual bypasses)
  if (!manual) {
    const existing = await getUpdateStatus();
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    if (existing.checkedAt > oneHourAgo) {
      logger.debug(`Skipping check — last checked ${Math.round((Date.now() - existing.checkedAt) / 60000)}m ago`);
      return existing;
    }
  }

  try {
    const release = await fetchLatestRelease();
    const hasUpdate = compareVersions(currentVersion, release.latestVersion) < 0;
    const status = await setUpdateStatus({
      ...release,
      hasUpdate,
      checkedAt: Date.now(),
      error: null,
    });
    logger.info(`Update check complete: current=${currentVersion} latest=${release.latestVersion} hasUpdate=${hasUpdate}`);
    await badgeUpdate(status);
    return status;
  } catch (e) {
    logger.warn('Update check failed', e?.message || e);
    const status = await setUpdateStatus({
      checkedAt: Date.now(),
      error: e?.code || e?.message || 'unknown',
    });
    await badgeUpdate(status);
    return status;
  }
}

/**
 * Set or clear the toolbar icon badge based on update status.
 */
async function badgeUpdate(status) {
  try {
    if (status.hasUpdate) {
      await chrome.action.setBadgeText({ text: '•' });
      await chrome.action.setBadgeBackgroundColor({ color: '#10b981' });
      await chrome.action.setTitle({ title: `GrabIt — update available: v${status.latestVersion}` });
    } else {
      await chrome.action.setBadgeText({ text: '' });
      await chrome.action.setTitle({ title: 'GrabIt — detect downloadable media on this page' });
    }
  } catch (e) {
    logger.warn('Badge update failed', e?.message);
  }
}

/* ------------------------------------------------------------------ *
 * Download + open-extensions-page flow
 * ------------------------------------------------------------------ */

/**
 * Trigger the update download flow:
 *   1) Download the zip via chrome.downloads.download()
 *   2) Open chrome://extensions/?id=<extId> in a new tab
 *   3) Show a desktop notification with next-step instructions
 *
 * Returns { downloadId, extensionsTabId } on success.
 */
export async function downloadUpdate() {
  const status = await getUpdateStatus();
  if (!status.hasUpdate || !status.zipUrl) {
    throw new Error('No update available or zip URL missing');
  }

  const filename = `GrabIt-Updates/grabit-v${status.latestVersion}.zip`;
  const cleanName = sanitizeFilename(filename, { maxLength: 180 });

  logger.info(`Downloading update: ${status.zipUrl} → ${cleanName}`);

  // Download the zip
  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      {
        url: status.zipUrl,
        filename: cleanName,
        saveAs: false,
        conflictAction: 'overwrite',
      },
      (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(id);
      },
    );
  });

  // Open chrome://extensions/ with this extension pre-selected
  const extId = chrome.runtime.id;
  const extensionsTab = await chrome.tabs.create({
    url: `chrome://extensions/?id=${extId}`,
    active: true,
  });

  // Notify the user with step-by-step instructions
  try {
    await chrome.notifications.create({
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'GrabIt update downloading',
      message: `v${status.latestVersion} is downloading. When it finishes:
1. Open the zip in your file manager
2. Extract it over your existing GrabIt folder
3. Click "Reload" on the GrabIt card in the Extensions tab`,
      priority: 2,
      buttons: [{ title: 'Show download in folder' }],
    });
  } catch (e) {
    logger.warn('Notification failed', e?.message);
  }

  // Mark that the user started the update
  await setUpdateStatus({ updateStartedAt: Date.now(), updateDownloadId: downloadId });

  return { downloadId, extensionsTabId: extensionsTab?.id };
}

/* ------------------------------------------------------------------ *
 * Alarm scheduling
 * ------------------------------------------------------------------ */

/**
 * Schedule the periodic update-check alarm.
 * @param periodInMinutes  number of minutes between checks (min 30)
 */
export async function scheduleUpdateChecks(periodInMinutes = 360) {
  const period = Math.max(30, periodInMinutes);
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.create(ALARM_NAME, {
    delayInMinutes: 5,    // first check 5 min after install/boot
    periodInMinutes: period,
  });
  logger.info(`Update-check alarm scheduled every ${period} min (first in 5 min)`);
}

export async function clearUpdateSchedule() {
  await chrome.alarms.clear(ALARM_NAME);
  logger.info('Update-check alarm cleared');
}

export function isUpdateAlarm(alarm) {
  return alarm?.name === ALARM_NAME;
}

/**
 * Wire chrome.alarms.onAlarm to trigger checkForUpdates.
 * Call once at service-worker boot.
 */
export function wireAlarmHandler() {
  chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (!isUpdateAlarm(alarm)) return;
    logger.debug('Update alarm fired');
    const status = await checkForUpdates({ manual: false });
    if (status.hasUpdate) {
      try {
        await chrome.notifications.create({
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icons/icon128.png'),
          title: `GrabIt v${status.latestVersion} available`,
          message: `Click the GrabIt toolbar icon to update.`,
          priority: 1,
        });
      } catch { /* ignore */ }
    }
  });
}

/**
 * Wire chrome.notifications.onButtonClicked to show the downloaded
 * update in the file manager (downloads.show).
 */
export function wireNotificationHandler() {
  chrome.notifications.onButtonClicked.addListener(async (notifId, btnIdx) => {
    if (btnIdx !== 0) return;
    const status = await getUpdateStatus();
    if (status.updateDownloadId) {
      try { await chrome.downloads.show(status.updateDownloadId); } catch { /* ignore */ }
    }
  });
}

/* ------------------------------------------------------------------ *
 * Default settings
 * ------------------------------------------------------------------ */

export const UPDATER_DEFAULTS = Object.freeze({
  autoCheckUpdates: true,
  updateCheckIntervalMin: 360,   // 6 hours
  notifyOnUpdate: true,
});
