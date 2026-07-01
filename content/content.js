/**
 * content/content.js — GrabIt content script
 *
 * Runs at document_idle on supported sites. Responsibilities:
 *   1) Listen for messages from the popup/background (scanResult, etc.)
 *   2) Inject the YouTube signature bridge on youtube.com
 *   3) Mount the hover-overlay widget on detected video players
 *   4) Watch for SPA navigations (history.pushState/replaceState/popstate)
 *      so the overlay re-mounts on YouTube/Twitter route changes
 *
 * The content script does NOT do extraction — that's the background's job.
 * It only handles UI (overlay) and forwards user actions to the background.
 */

(function () {
  'use strict';

  if (window.__grabit_content_init) return;
  window.__grabit_content_init = true;

  /* ---------------------------------------------------------------- *
   * Lightweight logger (content scripts can't easily use ES modules
   * without manifest changes; we keep this file plain IIFE)
   * ---------------------------------------------------------------- */
  const LOG_PREFIX = '%c[GrabIt:content]';
  const LOG_STYLE = 'color:#6366f1;font-weight:bold';
  function log(...args) { console.log(LOG_PREFIX, LOG_STYLE, ...args); }
  function warn(...args) { console.warn(LOG_PREFIX, LOG_STYLE, ...args); }

  let lastScanMedia = [];
  let overlayWidget = null;
  let settings = null;

  /* ---------------------------------------------------------------- *
   * Settings bootstrap (sync storage)
   * ---------------------------------------------------------------- */
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get('settings', (rec) => {
        const defaults = {
          showHoverOverlay: true,
          overlayPosition: 'bottom-right',
          overlayOpacity: 0.95,
          theme: 'auto',
          sites: {},
        };
        const stored = rec?.settings;
        if (stored && typeof stored === 'object' && 'v' in stored) {
          settings = { ...defaults, ...(stored.v || {}) };
        } else {
          settings = { ...defaults, ...(stored || {}) };
        }
        resolve(settings);
      });
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !changes.settings) return;
    const next = changes.settings.newValue;
    settings = (next && typeof next === 'object' && 'v' in next) ? next.v : next;
    if (overlayWidget && overlayWidget.applySettings) overlayWidget.applySettings(settings);
  });

  /* ---------------------------------------------------------------- *
   * SPA navigation detection
   *   YouTube and Twitter are SPAs — page content changes without a
   *   full document reload. We patch history.pushState/replaceState
   *   and listen for popstate so we can re-inject the overlay.
   * ---------------------------------------------------------------- */
  let currentUrl = location.href;
  function onSpaNav() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    log('SPA navigation →', currentUrl);
    // Tell the background to re-scan
    chrome.runtime.sendMessage({ type: 'scanTab', tabId: null }).catch(() => {});
    // Remount overlay
    scheduleOverlayMount();
  }

  ['pushState', 'replaceState'].forEach((method) => {
    const orig = history[method];
    history[method] = function (...args) {
      const ret = orig.apply(this, args);
      setTimeout(onSpaNav, 50);
      return ret;
    };
  });
  window.addEventListener('popstate', () => setTimeout(onSpaNav, 50));

  /* ---------------------------------------------------------------- *
   * YouTube signature bridge injection
   *   We inject lib/yt-bridge.js into the page's MAIN world via a
   *   <script> tag. The bridge exposes window.__grabit_yt_resolve(url)
   *   that the extractor can call via chrome.tabs.executeScript or
   *   window.postMessage from a script that runs in MAIN world too.
   *
   *   For MV3 we use chrome.scripting.executeScript({ world: 'MAIN' })
   *   from the background, so here we just request that injection.
   * ---------------------------------------------------------------- */
  function injectYtBridge() {
    if (!location.hostname.includes('youtube.com')) return;
    chrome.runtime.sendMessage({ type: 'injectYtBridge' }).catch(() => {
      // Background may not have a handler yet; ignore
    });
  }

  /* ---------------------------------------------------------------- *
   * Hover overlay mount (lazy-loaded)
   *   The overlay UI lives in content/hover-overlay.js + .css.
   *   We load them lazily to keep the content script boot fast.
   * ---------------------------------------------------------------- */
  let overlayLoaded = false;
  async function ensureOverlayLoaded() {
    if (overlayLoaded) return true;
    try {
      // Inject CSS
      const cssUrl = chrome.runtime.getURL('content/hover-overlay.css');
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssUrl;
      document.documentElement.appendChild(link);

      // Inject JS — we use import() but content scripts are non-module,
      // so we fetch the file and inject as a classic script.
      const jsUrl = chrome.runtime.getURL('content/hover-overlay.js');
      const res = await fetch(jsUrl);
      const code = await res.text();
      const s = document.createElement('script');
      s.textContent = code;
      (document.head || document.documentElement).appendChild(s);

      overlayLoaded = true;
      return true;
    } catch (e) {
      warn('Failed to load overlay', e);
      return false;
    }
  }

  let mountTimer = null;
  function scheduleOverlayMount() {
    if (mountTimer) clearTimeout(mountTimer);
    mountTimer = setTimeout(tryMountOverlay, 800);
  }

  function tryMountOverlay() {
    if (!settings.showHoverOverlay) return;
    if (!window.GrabItOverlay) {
      // Overlay script not yet loaded — try loading it now
      ensureOverlayLoaded().then(ok => {
        if (ok) setTimeout(tryMountOverlay, 100);
      });
      return;
    }
    overlayWidget = window.GrabItOverlay.mount({
      settings,
      onDownload: (variant, media) => {
        chrome.runtime.sendMessage({
          type: 'download',
          payload: {
            url: variant.url,
            filename: media.title,
            mediaId: media.id,
            quality: variant.quality,
            needsReferer: variant.needsReferer,
            mime: variant.mime,
            meta: media.meta,
          },
        }).catch((e) => warn('Download request failed', e));
      },
      getMedia: () => lastScanMedia,
    });
  }

  /* ---------------------------------------------------------------- *
   * Message handlers (from background / popup)
   * ---------------------------------------------------------------- */
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'scanResult':
        lastScanMedia = msg.media || [];
        log(`Got scan result: ${lastScanMedia.length} media items`);
        if (overlayWidget && overlayWidget.updateMedia) {
          overlayWidget.updateMedia(lastScanMedia);
        }
        sendResponse({ ok: true });
        return;

      case 'recentUpdated':
        // Could be used to show a toast on the page
        if (overlayWidget && overlayWidget.showRecentToast) {
          overlayWidget.showRecentToast(msg.list || []);
        }
        sendResponse({ ok: true });
        return;

      case 'ping':
        sendResponse({ ok: true, data: { url: location.href } });
        return;
    }
    return false;
  });

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */
  (async () => {
    await loadSettings();
    log('Content script booted on', location.host);
    injectYtBridge();
    if (settings.showHoverOverlay) scheduleOverlayMount();
  })();
})();
