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
  function send(type, payload = {}) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp || !resp.ok) return reject(new Error(resp?.error || 'No response'));
        resolve(resp.data);
      });
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
    $('#sync-indicator').hidden = false;
    saveTimer = setTimeout(async () => {
      try {
        settings = await send('saveSettings', { patch: saveQueue });
        Object.keys(saveQueue).forEach(k => delete saveQueue[k]);
      } catch (e) {
        showToast(e.message, 'error');
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

    applySettingsToUI();
    await renderSiteToggles();
    await refreshRecentCount();
  });
})();
