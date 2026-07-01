/**
 * content/content.js — GrabIt content script
 *
 * Runs at document_idle on supported sites. Responsibilities:
 *   1) Listen for messages from the popup/background (scanResult, etc.)
 *   2) Request the YouTube signature bridge injection (MAIN world)
 *   3) Mount the hover-overlay widget (loaded via manifest content_scripts)
 *   4) Watch for SPA navigations (history.pushState/replaceState/popstate)
 *      so the overlay re-mounts on YouTube/Twitter route changes
 *
 * The content script does NOT do extraction — that's the background's job.
 * It only handles UI (overlay) and forwards user actions to the background.
 *
 * NOTE: content/hover-overlay.js is loaded BEFORE this file (per manifest
 * content_scripts js[] ordering). It defines window.GrabItOverlay in the
 * same isolated world, so we can use it directly — no fetch-inject needed.
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
   * Overlay CSS injection (host-element styles only)
   *   The overlay's shadow-DOM styles are inline in hover-overlay.js.
   *   This external CSS only styles the #grabit-overlay-root host
   *   element from the outside.
   * ---------------------------------------------------------------- */
  let cssInjected = false;
  function injectOverlayCss() {
    if (cssInjected) return;
    try {
      const cssUrl = chrome.runtime.getURL('content/hover-overlay.css');
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = cssUrl;
      document.documentElement.appendChild(link);
      cssInjected = true;
    } catch (e) {
      warn('Failed to inject overlay CSS', e);
    }
  }

  /* ---------------------------------------------------------------- *
   * SPA navigation detection
   *   YouTube and Twitter are SPAs — page content changes without a
   *   full document reload. We patch history.pushState/replaceState
   *   and listen for popstate so we can re-scan and re-mount overlay.
   * ---------------------------------------------------------------- */
  let currentUrl = location.href;
  function onSpaNav() {
    if (location.href === currentUrl) return;
    currentUrl = location.href;
    log('SPA navigation →', currentUrl);
    // Ask the background to re-scan the active tab (this tab)
    chrome.runtime.sendMessage({ type: 'scanActiveTab' }).catch(() => {
      // Popup may not be open; that's fine — background still caches results
    });
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
   *   The bridge (lib/yt-bridge.js) must run in the page's MAIN world
   *   to access YouTube's player functions. Content scripts can't do
   *   this directly — we ask the background to inject it via
   *   chrome.scripting.executeScript({ world: 'MAIN' }).
   * ---------------------------------------------------------------- */
  function requestYtBridgeInjection() {
    if (!location.hostname.includes('youtube.com')) return;
    chrome.runtime.sendMessage({ type: 'injectYtBridge' }).catch(() => {
      // Background may not have a handler yet; ignore
    });
  }

  /* ---------------------------------------------------------------- *
   * Hover overlay mount
   *   hover-overlay.js is loaded via manifest content_scripts (before
   *   this file), so window.GrabItOverlay is already defined.
   * ---------------------------------------------------------------- */
  let mountTimer = null;
  function scheduleOverlayMount() {
    if (mountTimer) clearTimeout(mountTimer);
    mountTimer = setTimeout(tryMountOverlay, 800);
  }

  function tryMountOverlay() {
    if (!settings.showHoverOverlay) return;
    if (!window.GrabItOverlay) {
      warn('window.GrabItOverlay not defined — hover-overlay.js failed to load');
      return;
    }
    injectOverlayCss();

    // If overlay already mounted, just update media + settings
    if (overlayWidget) {
      overlayWidget.applySettings(settings);
      overlayWidget.updateMedia(lastScanMedia);
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
    log('Overlay mounted');
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
    log('Content script booted on', location.host, '— overlay available:', !!window.GrabItOverlay);
    requestYtBridgeInjection();
    if (settings.showHoverOverlay) scheduleOverlayMount();
  })();
})();
