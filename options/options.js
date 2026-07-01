/**
 * options/options.js — GrabIt options page controller
 *
 * Manages a sidebar of sections (General / Sites / Downloads / Overlay /
 * Advanced / About), loads settings from chrome.storage.sync, and persists
 * changes on every interaction (debounced for text inputs).
 */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------------------------------------------------------------- *
   * IPC
   * ---------------------------------------------------------------- */
  let contextValid = true;

  // Detect when the extension context is invalidated (e.g. after reload)
  if (chrome.runtime?.onConnect) {
    chrome.runtime.onConnect.addListener(() => {});
  }
  // Check periodically if context is still valid
  setInterval(() => {
    if (!chrome.runtime?.id) {
      contextValid = false;
      // Show a banner telling the user to reload
      const banner = document.createElement('div');
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#f59e0b;color:#fff;padding:12px 20px;font-size:14px;font-family:sans-serif;z-index:10000;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,0.2);';
      banner.innerHTML = '⚠️ GrabIt was reloaded. <a href="#" onclick="location.reload()" style="color:#fff;text-decoration:underline;font-weight:700">Refresh this page</a> to continue.';
      if (!document.querySelector('[data-grabit-reload-banner]')) {
        banner.setAttribute('data-grabit-reload-banner', 'true');
        document.body.appendChild(banner);
      }
    }
  }, 2000);

  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      if (!chrome.runtime?.id) {
        return reject(new Error('Extension context invalidated — please reload the page'));
      }
      try {
        chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!resp || !resp.ok) return reject(new Error(resp?.error || 'No response'));
          resolve(resp.data);
        });
      } catch (e) {
        reject(new Error('Extension context invalidated — please reload the page'));
      }
    });
  }

  let settings = null;
  let saveTimer = null;
  const saveQueue = {};

  /* ---------------------------------------------------------------- *
   * Save helpers — debounce text inputs, immediate for toggles
   * ---------------------------------------------------------------- */
  async function persist(patch) {
    Object.assign(saveQueue, patch);
    if (saveTimer) clearTimeout(saveTimer);
    // Don't show sync indicator if context is already invalid
    if (chrome.runtime?.id) {
      $('#sync-indicator').hidden = false;
    }
    saveTimer = setTimeout(async () => {
      try {
        if (!chrome.runtime?.id) {
          // Context invalidated — show reload banner instead of error toast
          return;
        }
        settings = await send('saveSettings', { patch: saveQueue });
        Object.keys(saveQueue).forEach(k => delete saveQueue[k]);
      } catch (e) {
        if (e.message.includes('invalidated')) {
          // Silent — the reload banner is already showing
        } else {
          showToast(e.message, 'error');
        }
      } finally {
        setTimeout(() => { $('#sync-indicator').hidden = true; }, 500);
      }
    }, 300);
  }

  function applyTheme(mode) {
    document.body.setAttribute('data-theme', mode);
  }
  function resolveTheme(setting) {
    if (setting === 'dark' || setting === 'light') return setting;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  /* ---------------------------------------------------------------- *
   * Nav
   * ---------------------------------------------------------------- */
  function wireNav() {
    $$('.nav-item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.preventDefault();
        $$('.nav-item').forEach(n => n.classList.remove('active'));
        $$('.section').forEach(s => s.classList.remove('active'));
        item.classList.add('active');
        const id = item.dataset.section;
        $(`#section-${id}`).classList.add('active');
        $('#page-title').textContent = item.textContent.trim();
        history.replaceState(null, '', `#${id}`);
      });
    });
    // Open from URL hash
    const hash = location.hash.slice(1);
    if (hash) {
      const item = $(`.nav-item[data-section="${hash}"]`);
      if (item) item.click();
    }
  }

  /* ---------------------------------------------------------------- *
   * General
   * ---------------------------------------------------------------- */
  function wireGeneral() {
    // Theme segmented
    $$('#theme-segmented .seg-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('#theme-segmented .seg-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const val = btn.dataset.value;
        settings.theme = val;
        applyTheme(resolveTheme(val));
        persist({ theme: val });
      });
    });

    // Color picker
    $$('#color-picker .color-swatch').forEach(sw => {
      sw.addEventListener('click', () => {
        $$('#color-picker .color-swatch').forEach(s => s.classList.remove('active'));
        sw.classList.add('active');
        const c = sw.dataset.color;
        document.documentElement.style.setProperty('--accent', c);
        settings.accentColor = c;
        persist({ accentColor: c });
      });
    });

    // Default quality
    $('#default-quality').addEventListener('change', (e) => {
      settings.defaultQuality = e.target.value;
      persist({ defaultQuality: e.target.value });
    });
  }

  /* ---------------------------------------------------------------- *
   * Sites
   * ---------------------------------------------------------------- */
  async function renderSiteToggles() {
    const extractors = await send('listExtractors');
    const container = $('#site-toggles');
    container.innerHTML = '';
    for (const ext of extractors) {
      const enabled = settings.sites?.[ext.id] !== false;
      const patterns = (ext.domains || []).map(d => `https://*.${d}/*`);

      // Check if host permission is granted for this site
      let permGranted = false;
      try {
        permGranted = await new Promise((resolve) => {
          chrome.permissions.contains({ origins: patterns }, resolve);
        });
      } catch { /* ignore */ }

      const card = document.createElement('label');
      card.className = 'site-toggle';
      card.innerHTML = `
        <div class="site-info">
          <span class="site-name">${ext.name} ${permGranted ? '' : '<span class="perm-badge">needs permission</span>'}</span>
          <span class="site-host">${ext.domains?.[0] || ext.id}</span>
        </div>
        <input type="checkbox" class="toggle" data-site="${ext.id}" ${enabled && permGranted ? 'checked' : ''} ${!permGranted ? 'disabled' : ''} />
      `;
      container.appendChild(card);
      const cb = card.querySelector('input');

      if (permGranted) {
        cb.addEventListener('change', async () => {
          settings.sites = { ...settings.sites, [ext.id]: cb.checked };
          await persist({ sites: settings.sites });
          // If user unchecks AND wants to fully revoke, offer to remove permission
          if (!cb.checked) {
            try {
              await new Promise((resolve) => {
                chrome.permissions.remove({ origins: patterns }, resolve);
              });
              showToast(`Removed host permission for ${ext.name}`, 'success');
            } catch (e) {
              showToast('Could not remove permission: ' + e.message, 'error');
            }
            // Re-render to reflect the new state
            await renderSiteToggles();
          }
        });
      } else {
        // Replace the disabled checkbox with an "Enable" button
        const enableBtn = document.createElement('button');
        enableBtn.className = 'btn-secondary perm-enable-btn';
        enableBtn.textContent = 'Enable';
        enableBtn.style.padding = '5px 12px';
        enableBtn.style.fontSize = '11px';
        cb.replaceWith(enableBtn);
        enableBtn.addEventListener('click', async () => {
          enableBtn.disabled = true;
          enableBtn.textContent = 'Requesting…';
          try {
            const granted = await new Promise((resolve) => {
              chrome.permissions.request({ origins: patterns }, resolve);
            });
            if (granted) {
              settings.sites = { ...settings.sites, [ext.id]: true };
              await persist({ sites: settings.sites });
              showToast(`${ext.name} enabled`, 'success');
              await renderSiteToggles();
            } else {
              enableBtn.disabled = false;
              enableBtn.textContent = 'Enable';
              showToast('Permission denied', 'error');
            }
          } catch (e) {
            enableBtn.disabled = false;
            enableBtn.textContent = 'Enable';
            showToast('Failed: ' + e.message, 'error');
          }
        });
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Downloads
   * ---------------------------------------------------------------- */
  function wireDownloads() {
    $('#download-folder').addEventListener('input', (e) => {
      persist({ downloadFolder: e.target.value.trim() });
    });
    $('#filename-template').addEventListener('input', (e) => {
      persist({ filenameTemplate: e.target.value.trim() });
    });
    $('#notify-complete').addEventListener('change', (e) => {
      persist({ notifyOnComplete: e.target.checked });
    });
    $('#notify-error').addEventListener('change', (e) => {
      persist({ notifyOnError: e.target.checked });
    });

    $('#clear-recent-btn').addEventListener('click', async () => {
      try {
        await send('clearRecent');
        await refreshRecentCount();
        showToast('Recent downloads cleared', 'success');
      } catch (e) {
        showToast('Failed: ' + e.message, 'error');
      }
    });
  }

  async function refreshRecentCount() {
    try {
      const list = await send('recentDownloads', { limit: 100 });
      $('#recent-count').textContent = `${list?.length || 0} item${list?.length === 1 ? '' : 's'}`;
    } catch {
      $('#recent-count').textContent = '—';
    }
  }

  /* ---------------------------------------------------------------- *
   * Overlay
   * ---------------------------------------------------------------- */
  function wireOverlay() {
    $('#show-overlay').addEventListener('change', (e) => {
      persist({ showHoverOverlay: e.target.checked });
    });
    $('#overlay-position').addEventListener('change', (e) => {
      persist({ overlayPosition: e.target.value });
    });
    $('#overlay-opacity').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      $('#opacity-value').textContent = `${v}%`;
      persist({ overlayOpacity: v / 100 });
    });
  }

  /* ---------------------------------------------------------------- *
   * Advanced
   * ---------------------------------------------------------------- */
  function wireAdvanced() {
    $('#bypass-referer').addEventListener('change', (e) => {
      persist({ bypassRefererRestrictions: e.target.checked });
    });
    $('#max-parallel').addEventListener('input', (e) => {
      const v = parseInt(e.target.value, 10);
      $('#parallel-value').textContent = String(v);
      persist({ maxParallelDownloads: v });
    });
    $('#debug-logging').addEventListener('change', (e) => {
      persist({ debugLogging: e.target.checked });
    });

    $('#test-scan-btn').addEventListener('click', async () => {
      try {
        const result = await send('scanActiveTab');
        const n = result?.media?.length || 0;
        showToast(`Scan complete: ${n} media item${n === 1 ? '' : 's'} found`, n ? 'success' : 'error');
      } catch (e) {
        showToast('Scan failed: ' + e.message, 'error');
      }
    });

    $('#reload-bg-btn').addEventListener('click', () => {
      chrome.runtime.reload();
    });

    // Error reporting
    $('#error-reporting').addEventListener('change', (e) => {
      persist({ errorReporting: e.target.checked });
    });
    $('#sentry-dsn').addEventListener('input', (e) => {
      persist({ sentryDsn: e.target.value.trim() });
    });
    $('#view-errors-btn').addEventListener('click', async () => {
      try {
        const errors = await send('getErrors', { limit: 20 });
        if (!errors || !errors.length) {
          showToast('No errors captured', 'success');
          return;
        }
        const text = errors.map(e =>
          `[${e.timestamp}] ${e.level}: ${e.message}\n${e.stack ? e.stack.split('\n').slice(0, 3).join('\n') : ''}`
        ).join('\n\n---\n\n');
        // Open in a new window
        const w = window.open('', '_blank', 'width=600,height=600');
        w.document.write(`<pre style="font-family:monospace;font-size:12px;padding:20px;white-space:pre-wrap;word-break:break-all;">${text.replace(/</g, '&lt;')}</pre>`);
      } catch (e) {
        showToast('Failed: ' + e.message, 'error');
      }
    });
    $('#clear-errors-btn').addEventListener('click', async () => {
      try {
        await send('clearErrors');
        showToast('Error log cleared', 'success');
      } catch (e) {
        showToast('Clear failed: ' + e.message, 'error');
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * About
   * ---------------------------------------------------------------- */
  function wireAbout() {
    const manifest = chrome.runtime.getManifest();
    $('#about-version').textContent = manifest.version;
    $('#version').textContent = `v${manifest.version}`;
    $('#open-extensions-page').addEventListener('click', (e) => {
      e.preventDefault();
      chrome.tabs.create({ url: 'chrome://extensions/' });
    });
  }

  /* ---------------------------------------------------------------- *
   * Updates
   * ---------------------------------------------------------------- */
  async function loadUpdateStatus() {
    try {
      const status = await send('getUpdateStatus');
      renderUpdateStatus(status);
    } catch (e) {
      console.warn('[GrabIt options] update status load failed', e);
    }
  }

  function renderUpdateStatus(status) {
    const manifest = chrome.runtime.getManifest();
    $('#cur-version').textContent = `v${manifest.version}`;
    $('#latest-version').textContent = status?.latestVersion ? `v${status.latestVersion}` : '—';

    if (status?.checkedAt) {
      const diff = Date.now() - status.checkedAt;
      let str;
      if (diff < 60_000) str = 'just now';
      else if (diff < 3600_000) str = `${Math.floor(diff / 60_000)}m ago`;
      else if (diff < 86400_000) str = `${Math.floor(diff / 3600_000)}h ago`;
      else str = `${Math.floor(diff / 86400_000)}d ago`;
      $('#last-checked').textContent = str;
    } else {
      $('#last-checked').textContent = 'never';
    }

    const badge = $('#update-status-badge');
    badge.classList.remove('status-update', 'status-uptodate', 'status-error');
    if (status?.error) {
      badge.textContent = status.error === 'rate_limited' ? 'rate-limited' : 'error';
      badge.classList.add('status-error');
    } else if (status?.hasUpdate) {
      badge.textContent = 'update available';
      badge.classList.add('status-update');
    } else if (status?.checkedAt) {
      badge.textContent = 'up to date';
      badge.classList.add('status-uptodate');
    } else {
      badge.textContent = 'never checked';
    }

    // Show/hide update-available card
    const availCard = $('#update-available-card');
    if (status?.hasUpdate) {
      availCard.hidden = false;
      $('#update-detail-title').textContent = `v${status.latestVersion}`;
      $('#update-detail-notes').textContent = status.releaseNotes || '(No release notes provided)';
      $('#update-gh-link').href = status.releaseUrl || '#';
    } else {
      availCard.hidden = true;
    }
  }

  function wireUpdates() {
    // Auto-check toggle
    const autoCb = $('#auto-check-updates');
    autoCb.addEventListener('change', async (e) => {
      const enabled = e.target.checked;
      await persist({
        autoCheckUpdates: enabled,
        updateCheckIntervalMin: parseInt($('#update-check-interval').value, 10),
      });
      // Reschedule alarm
      try {
        await send('rescheduleUpdateChecks', {
          enabled,
          intervalMin: parseInt($('#update-check-interval').value, 10),
        });
      } catch (err) {
        showToast('Reschedule failed: ' + err.message, 'error');
      }
      showToast(enabled ? 'Auto-check enabled' : 'Auto-check disabled', 'success');
    });

    // Frequency select
    $('#update-check-interval').addEventListener('change', async (e) => {
      const intervalMin = parseInt(e.target.value, 10);
      await persist({ updateCheckIntervalMin: intervalMin });
      if (autoCb.checked) {
        try {
          await send('rescheduleUpdateChecks', { enabled: true, intervalMin });
          showToast(`Check frequency: every ${intervalMin >= 60 ? (intervalMin / 60) + 'h' : intervalMin + 'min'}`, 'success');
        } catch (err) {
          showToast('Reschedule failed: ' + err.message, 'error');
        }
      }
    });

    // Notify toggle
    $('#notify-on-update').addEventListener('change', (e) => {
      persist({ notifyOnUpdate: e.target.checked });
    });

    // Check now button
    $('#check-now-btn').addEventListener('click', async () => {
      const btn = $('#check-now-btn');
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-3-6.7" class="spinning"/></svg> Checking…`;
      try {
        const status = await send('checkForUpdates');
        renderUpdateStatus(status);
        if (status?.hasUpdate) {
          showToast(`Update available: v${status.latestVersion}`, 'success');
        } else if (status?.error) {
          showToast(`Check failed: ${status.error}`, 'error');
        } else {
          showToast('You\'re up to date', 'success');
        }
      } catch (e) {
        showToast('Check failed: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    });

    // Update now button (in the available card)
    $('#update-now-options-btn').addEventListener('click', async () => {
      const btn = $('#update-now-options-btn');
      const original = btn.innerHTML;
      btn.disabled = true;
      btn.innerHTML = 'Downloading…';
      try {
        await send('downloadUpdate');
        showToast('Update downloading — open the Extensions tab to reload after extracting', 'success');
        // Open the extensions page so user can reload after
        chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
      } catch (e) {
        showToast('Update failed: ' + e.message, 'error');
      } finally {
        btn.disabled = false;
        btn.innerHTML = original;
      }
    });
  }

  function applyUpdaterSettings(settings) {
    $('#auto-check-updates').checked = settings.autoCheckUpdates !== false;
    const interval = settings.updateCheckIntervalMin || 360;
    // Round to nearest option in the select
    const sel = $('#update-check-interval');
    const opts = Array.from(sel.options).map(o => parseInt(o.value, 10));
    const closest = opts.reduce((a, b) => Math.abs(b - interval) < Math.abs(a - interval) ? b : a);
    sel.value = String(closest);
    $('#notify-on-update').checked = settings.notifyOnUpdate !== false;
  }

  /* ---------------------------------------------------------------- *
   * Apply loaded settings → UI
   * ---------------------------------------------------------------- */
  function applySettingsToUI() {
    // Theme
    applyTheme(resolveTheme(settings.theme || 'auto'));
    $$('#theme-segmented .seg-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.value === (settings.theme || 'auto'));
    });

    // Color
    $$('#color-picker .color-swatch').forEach(sw => {
      sw.classList.toggle('active', sw.dataset.color === settings.accentColor);
    });
    if (settings.accentColor) {
      document.documentElement.style.setProperty('--accent', settings.accentColor);
    }

    // Quality
    $('#default-quality').value = settings.defaultQuality || 'auto';

    // Downloads
    $('#download-folder').value = settings.downloadFolder || '';
    $('#filename-template').value = settings.filenameTemplate || '';
    $('#notify-complete').checked = !!settings.notifyOnComplete;
    $('#notify-error').checked = !!settings.notifyOnError;

    // Overlay
    $('#show-overlay').checked = !!settings.showHoverOverlay;
    $('#overlay-position').value = settings.overlayPosition || 'bottom-right';
    const opacityPct = Math.round((settings.overlayOpacity ?? 0.95) * 100);
    $('#overlay-opacity').value = opacityPct;
    $('#opacity-value').textContent = `${opacityPct}%`;

    // Advanced
    $('#bypass-referer').checked = settings.bypassRefererRestrictions !== false;
    $('#max-parallel').value = settings.maxParallelDownloads || 3;
    $('#parallel-value').textContent = String(settings.maxParallelDownloads || 3);
    $('#debug-logging').checked = !!settings.debugLogging;

    // Error reporting
    $('#error-reporting').checked = settings.errorReporting !== false;
    $('#sentry-dsn').value = settings.sentryDsn || '';
  }

  /* ---------------------------------------------------------------- *
   * Toast
   * ---------------------------------------------------------------- */
  function showToast(msg, type = '') {
    let toast = $('.toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.className = 'toast show ' + type;
    setTimeout(() => {
      toast.className = 'toast ' + type;
    }, 2500);
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      settings = await send('getSettings');
    } catch (e) {
      showToast('Failed to load settings: ' + e.message, 'error');
      return;
    }

    wireNav();
    wireGeneral();
    wireDownloads();
    wireOverlay();
    wireAdvanced();
    wireAbout();
    wireUpdates();

    applySettingsToUI();
    applyUpdaterSettings(settings);
    await renderSiteToggles();
    await refreshRecentCount();
    await loadUpdateStatus();
  });
})();
