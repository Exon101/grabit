/**
 * popup/popup.js — GrabIt popup controller
 *
 * Lifecycle:
 *   1) On DOMContentLoaded: query active tab, fetch favicon, render tab card
 *   2) Send 'scanActiveTab' message to background; render results
 *   3) On variant click: send 'download' message; show toast
 *   4) Subscribe to chrome.runtime.onMessage for 'recentUpdated' updates
 *   5) Theme toggle persists to chrome.storage.sync
 */

(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  /* ---------------------------------------------------------------- *
   * State
   * ---------------------------------------------------------------- */
  let settings = null;
  let scanResult = null;

  /* ---------------------------------------------------------------- *
   * IPC helpers
   * ---------------------------------------------------------------- */
  function send(type, payload) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type, ...payload }, (resp) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!resp) return reject(new Error('No response'));
        if (!resp.ok) return reject(new Error(resp.error || 'Unknown error'));
        resolve(resp.data);
      });
    });
  }

  /* ---------------------------------------------------------------- *
   * Theme
   * ---------------------------------------------------------------- */
  function applyTheme(mode) {
    document.body.setAttribute('data-theme', mode);
  }

  function resolveTheme(setting) {
    if (setting === 'dark' || setting === 'light') return setting;
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function cycleTheme() {
    const order = ['auto', 'light', 'dark'];
    const next = order[(order.indexOf(settings.theme || 'auto') + 1) % order.length];
    settings.theme = next;
    applyTheme(resolveTheme(next));
    saveSettings({ theme: next });
  }

  /* ---------------------------------------------------------------- *
   * Tab info
   * ---------------------------------------------------------------- */
  async function renderTabCard() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return null;

    $('#tab-card').hidden = false;
    $('#tab-title').textContent = tab.title || 'Untitled';
    try {
      const host = new URL(tab.url).hostname;
      $('#tab-host').textContent = host;
      $('#tab-favicon').style.backgroundImage = `url("https://www.google.com/s2/favicons?domain=${host}&sz=64")`;
    } catch {
      $('#tab-host').textContent = '';
    }
    return tab;
  }

  /* ---------------------------------------------------------------- *
   * Scan
   * ---------------------------------------------------------------- */
  async function scanAndRender() {
    try {
      $('#loading-skeleton').hidden = false;
      $('#media-list').hidden = true;
      $('#empty-state').hidden = true;
      $('#permission-state').hidden = true;
      $('#brand-status').textContent = 'Detecting media…';

      const result = await send('scanActiveTab');
      scanResult = result;
      const media = result?.media || [];

      $('#loading-skeleton').hidden = true;

      // Handle permission-required state
      if (result?.status === 'needs_permission') {
        showPermissionState(result.siteKey, result.tab?.url);
        $('#brand-status').textContent = 'Permission needed';
        return;
      }

      if (!media.length) {
        showEmpty();
        $('#brand-status').textContent = 'No media found';
        return;
      }

      $('#brand-status').textContent = `${media.length} item${media.length === 1 ? '' : 's'} found`;
      renderMediaList(media);
      $('#media-list').hidden = false;
    } catch (e) {
      console.error('[GrabIt popup] scan failed', e);
      $('#loading-skeleton').hidden = true;
      showEmpty();
      $('#brand-status').textContent = 'Scan failed';
      showToast(e.message, 'error');
    }
  }

  /* ---------------------------------------------------------------- *
   * Permission state
   * ---------------------------------------------------------------- */
  function showPermissionState(siteKey, url) {
    $('#permission-state').hidden = false;
    let host = 'this site';
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    $('#perm-host').textContent = host;

    // Wire up the grant button — MUST use chrome.permissions.request from
    // the popup's user-gesture context (can't go through background)
    const btn = $('#grant-permission-btn');
    btn.onclick = async () => {
      btn.disabled = true;
      btn.innerHTML = '<span class="v-spinner"></span> Requesting…';
      try {
        // Patterns come from the scan response, or we re-derive from siteKey
        const patterns = scanResult?.patterns?.length
          ? scanResult.patterns
          : await derivePatterns(siteKey);
        const granted = await new Promise((resolve) => {
          chrome.permissions.request({ origins: patterns }, (ok) => {
            resolve(!!ok);
          });
        });
        if (granted) {
          showToast('Permission granted — scanning…', 'success');
          // Clear scan cache so the background re-scans with permission now granted
          try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
            if (tab) await send('clearScanCache', { tabId: tab.id });
          } catch { /* ignore */ }
          // Re-scan after granting
          setTimeout(scanAndRender, 200);
        } else {
          btn.disabled = false;
          btn.innerHTML = 'Enable for this site';
          showToast('Permission denied', 'error');
        }
      } catch (e) {
        btn.disabled = false;
        btn.innerHTML = 'Enable for this site';
        showToast('Failed: ' + e.message, 'error');
      }
    };

    $('#open-options-from-perm').onclick = (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    };
  }

  async function derivePatterns(siteKey) {
    if (!siteKey) return [];
    // Ask background for patterns (re-uses SITE_HOST_PATTERNS constant)
    const extractors = await send('listExtractors');
    const ext = extractors.find(e => e.id === siteKey);
    if (!ext?.domains?.length) return [];
    return ext.domains.map(d => `https://*.${d}/*`);
  }

  function showEmpty() {
    $('#empty-state').hidden = false;
    renderSupportedSites();
  }

  async function renderSupportedSites() {
    try {
      const extractors = await send('listExtractors');
      $('#supported-sites').innerHTML = extractors.map(e =>
        `<span class="site-chip">${e.name}</span>`
      ).join('');
    } catch {
      // ignore
    }
  }

  /* ---------------------------------------------------------------- *
   * Media list render
   * ---------------------------------------------------------------- */
  function renderMediaList(media) {
    const list = $('#media-list');
    list.innerHTML = '';

    for (const m of media) {
      const card = document.createElement('div');
      card.className = 'media-card';

      // Header
      const head = document.createElement('div');
      head.className = 'media-head';

      const thumb = document.createElement('div');
      thumb.className = 'media-thumb';
      if (m.thumbnail) thumb.style.backgroundImage = `url("${m.thumbnail}")`;
      head.appendChild(thumb);

      const meta = document.createElement('div');
      meta.className = 'media-meta';
      const title = document.createElement('div');
      title.className = 'media-title';
      title.textContent = m.title || 'Untitled media';
      meta.appendChild(title);

      if (m.author) {
        const author = document.createElement('div');
        author.className = 'media-author';
        author.textContent = m.author;
        meta.appendChild(author);
      }
      if (m.durationSec) {
        const dur = document.createElement('div');
        dur.className = 'media-duration';
        dur.textContent = formatDuration(m.durationSec);
        meta.appendChild(dur);
      }
      head.appendChild(meta);
      card.appendChild(head);

      // Error block
      if (m.error) {
        const err = document.createElement('div');
        err.className = 'media-error';
        err.textContent = m.error;
        card.appendChild(err);
      }

      // Variants grid
      if (m.variants && m.variants.length) {
        const grid = document.createElement('div');
        grid.className = 'variant-grid';

        // Show top 6 variants (sorted by quality from extractor)
        const shown = m.variants.slice(0, 6);
        for (const v of shown) {
          const btn = document.createElement('button');
          btn.className = 'variant-btn';
          btn.dataset.url = v.url;
          btn.innerHTML = `
            <span class="v-quality">${v.quality || 'source'}</span>
            <span class="v-meta">
              <span class="v-badge ${v.audio ? 'audio' : ''}">${v.audio ? 'audio' : (v.ext || 'mp4').toUpperCase()}</span>
              ${v.height ? `· ${v.height}p` : ''}
            </span>
          `;
          btn.addEventListener('click', () => handleDownload(btn, v, m));
          grid.appendChild(btn);
        }

        // "+N more" if more than 6
        if (m.variants.length > 6) {
          const more = document.createElement('button');
          more.className = 'variant-btn';
          more.style.gridColumn = '1 / -1';
          more.style.alignItems = 'center';
          more.style.justifyContent = 'center';
          more.innerHTML = `<span class="v-quality" style="font-size:11px;font-weight:600;color:var(--fg-muted)">+${m.variants.length - 6} more variants</span>`;
          more.addEventListener('click', () => {
            // Show all
            grid.innerHTML = '';
            for (const v of m.variants) {
              const btn = document.createElement('button');
              btn.className = 'variant-btn';
              btn.innerHTML = `
                <span class="v-quality">${v.quality || 'source'}</span>
                <span class="v-meta">
                  <span class="v-badge ${v.audio ? 'audio' : ''}">${v.audio ? 'audio' : (v.ext || 'mp4').toUpperCase()}</span>
                  ${v.height ? `· ${v.height}p` : ''}
                </span>
              `;
              btn.addEventListener('click', () => handleDownload(btn, v, m));
              grid.appendChild(btn);
            }
          });
          grid.appendChild(more);
        }

        card.appendChild(grid);
      }

      list.appendChild(card);
    }
  }

  /* ---------------------------------------------------------------- *
   * Download
   * ---------------------------------------------------------------- */
  async function handleDownload(btn, variant, media) {
    btn.classList.add('downloading');
    const original = btn.innerHTML;
    btn.innerHTML = `<span class="v-spinner"></span><span class="v-meta">starting…</span>`;

    try {
      const resp = await send('download', {
        payload: {
          url: variant.url,
          filename: media.title,
          mediaId: media.id,
          quality: variant.quality,
          needsReferer: variant.needsReferer,
          mime: variant.mime,
          meta: { ...media.meta, title: media.title, author: media.author },
        },
      });
      const tierLabel = ['', 'direct', 'fetch+blob', 'open in tab'][resp.tier || 1];
      showToast(`Download started (${tierLabel})`, 'success');
      // Refresh recent
      loadRecent();
    } catch (e) {
      showToast(`Failed: ${e.message}`, 'error');
    } finally {
      setTimeout(() => {
        btn.classList.remove('downloading');
        btn.innerHTML = original;
      }, 1500);
    }
  }

  /* ---------------------------------------------------------------- *
   * Recent downloads
   * ---------------------------------------------------------------- */
  async function loadRecent() {
    try {
      const list = await send('recentDownloads', { limit: 10 });
      if (!list || !list.length) {
        $('#recent-section').hidden = true;
        return;
      }
      $('#recent-section').hidden = false;
      const ul = $('#recent-list');
      ul.innerHTML = list.map(item => `
        <div class="recent-item">
          <span class="r-status ${item.status}"></span>
          <span class="r-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span>
          <span class="r-time">${formatTime(item.startedAt)}</span>
        </div>
      `).join('');
    } catch (e) {
      console.warn('[GrabIt popup] loadRecent failed', e);
    }
  }

  async function clearRecent() {
    try {
      await send('clearRecent');
      loadRecent();
      showToast('Recent cleared', 'success');
    } catch (e) {
      showToast('Failed to clear', 'error');
    }
  }

  /* ---------------------------------------------------------------- *
   * Settings
   * ---------------------------------------------------------------- */
  async function loadSettings() {
    settings = await send('getSettings');
    applyTheme(resolveTheme(settings.theme || 'auto'));
    if (settings.accentColor) {
      document.documentElement.style.setProperty('--accent', settings.accentColor);
    }
  }
  async function saveSettings(patch) {
    settings = { ...settings, ...patch };
    await send('saveSettings', { patch });
  }

  /* ---------------------------------------------------------------- *
   * Helpers
   * ---------------------------------------------------------------- */
  function showToast(msg, type = '') {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast show ' + type;
    t.hidden = false;
    setTimeout(() => {
      t.className = 'toast ' + type;
      setTimeout(() => { t.hidden = true; }, 250);
    }, 2500);
  }

  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function formatDuration(sec) {
    if (!sec) return '';
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    const m = Math.floor((sec / 60) % 60);
    const h = Math.floor(sec / 3600);
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  function formatTime(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 60_000) return 'just now';
    if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
    if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
    return new Date(ts).toLocaleDateString();
  }

  /* ---------------------------------------------------------------- *
   * Live updates
   * ---------------------------------------------------------------- */
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'recentUpdated') {
      loadRecent();
    }
  });

  /* ---------------------------------------------------------------- *
   * Updater
   * ---------------------------------------------------------------- */
  let updateStatus = null;

  async function loadUpdateBanner() {
    try {
      updateStatus = await send('getUpdateStatus');
      renderUpdateBanner(updateStatus);
    } catch (e) {
      console.warn('[GrabIt popup] update status load failed', e);
    }
  }

  function renderUpdateBanner(status) {
    const banner = $('#update-banner');
    if (!status?.hasUpdate) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    $('#update-version').textContent = `v${status.latestVersion}`;

    const notesLink = $('#update-notes-link');
    if (status.releaseNotes) {
      notesLink.hidden = false;
      notesLink.onclick = (e) => {
        e.preventDefault();
        showReleaseNotesModal(status);
      };
    } else {
      notesLink.hidden = true;
    }

    // Wire "Update now" button
    const updateBtn = $('#update-now-btn');
    updateBtn.onclick = () => triggerUpdate(status);

    // Wire dismiss
    $('#update-dismiss-btn').onclick = () => {
      banner.hidden = true;
      // Also clear the badge so the user isn't bothered again until next check
      try { chrome.action.setBadgeText({ text: '' }); } catch { /* ignore */ }
    };
  }

  function showReleaseNotesModal(status) {
    const modal = $('#release-notes-modal');
    $('#release-notes-title').textContent = `What's new in v${status.latestVersion}`;
    const body = $('#release-notes-body');
    body.className = 'modal-body release-notes';
    body.textContent = status.releaseNotes || '(No release notes provided)';
    $('#release-notes-gh-link').href = status.releaseUrl || '#';
    $('#release-notes-update-btn').onclick = () => {
      closeModal('#release-notes-modal');
      triggerUpdate(status);
    };
    modal.hidden = false;

    $('#release-notes-close').onclick = () => closeModal('#release-notes-modal');
    $('#release-notes-backdrop').onclick = () => closeModal('#release-notes-modal');
  }

  function showUpdateInstructionsModal(latestVersion) {
    const modal = $('#update-instructions-modal');
    $('#instr-version').textContent = latestVersion;
    modal.hidden = false;

    $('#update-instructions-close').onclick = () => closeModal('#update-instructions-modal');
    $('#update-instructions-backdrop').onclick = () => closeModal('#update-instructions-modal');

    $('#instr-show-download').onclick = async () => {
      try {
        const status = await send('getUpdateStatus');
        if (status.updateDownloadId) {
          chrome.downloads.show(status.updateDownloadId);
        }
      } catch (e) {
        showToast('Could not show download: ' + e.message, 'error');
      }
    };

    $('#instr-open-extensions').onclick = () => {
      chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
    };
  }

  function closeModal(sel) {
    $(sel).hidden = true;
  }

  async function triggerUpdate(status) {
    const btn = $('#update-now-btn');
    const originalHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="v-spinner"></span> Downloading…`;
    try {
      await send('downloadUpdate');
      showToast('Update downloading — see instructions', 'success');
      showUpdateInstructionsModal(status.latestVersion);
    } catch (e) {
      showToast('Update failed: ' + e.message, 'error');
    } finally {
      btn.disabled = false;
      btn.innerHTML = originalHtml;
    }
  }

  /* ---------------------------------------------------------------- *
   * Debug diagnostics
   * ---------------------------------------------------------------- */
  async function showDebugInfo() {
    const modal = $('#debug-modal');
    const body = $('#debug-body');
    body.textContent = 'Collecting debug info...';
    modal.hidden = false;

    try {
      const manifest = chrome.runtime.getManifest();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = tab?.url || 'unknown';
      let host = 'unknown', siteKey = null;
      try {
        host = new URL(url).hostname;
        siteKey = await send('hasPermission', { url }).then(r => r.siteKey);
      } catch {}

      // Check permission
      let permGranted = false;
      if (siteKey) {
        try {
          const r = await send('hasSitePermission', { siteKey });
          permGranted = r.granted;
        } catch {}
      }

      // Check scan status
      let scanStatus = 'not scanned';
      let mediaCount = 0;
      let scanError = null;
      try {
        const result = await send('scanActiveTab');
        scanStatus = result?.status || 'unknown';
        mediaCount = result?.media?.length || 0;
        if (result?.media?.[0]?.error) scanError = result.media[0].error;
      } catch (e) {
        scanError = e.message;
      }

      // Check settings
      let settingsSummary = 'unknown';
      try {
        const s = await send('getSettings');
        settingsSummary = `theme=${s.theme}, overlay=${s.showHoverOverlay}, sites=${Object.entries(s.sites || {}).filter(([_,v]) => v).map(([k]) => k).join(',')}`;
      } catch {}

      // Check update status
      let updateInfo = 'unknown';
      try {
        const u = await send('getUpdateStatus');
        updateInfo = `current=v${manifest.version}, latest=${u.latestVersion ? 'v' + u.latestVersion : '?'}, hasUpdate=${u.hasUpdate}, error=${u.error || 'none'}`;
      } catch {}

      const info = [
        `=== GrabIt Debug Info ===`,
        `Time: ${new Date().toISOString()}`,
        ``,
        `=== Extension ===`,
        `Version: v${manifest.version}`,
        `Manifest: v${manifest.manifest_version}`,
        `ID: ${chrome.runtime.id}`,
        ``,
        `=== Active Tab ===`,
        `URL: ${url}`,
        `Host: ${host}`,
        `Site key: ${siteKey || 'none (unsupported site)'}`,
        ``,
        `=== Permission ===`,
        `Granted: ${permGranted}`,
        siteKey && !permGranted ? `→ Click "Enable for this site" in the popup` : '',
        ``,
        `=== Scan Result ===`,
        `Status: ${scanStatus}`,
        `Media found: ${mediaCount}`,
        scanError ? `Error: ${scanError}` : '',
        ``,
        `=== Settings ===`,
        settingsSummary,
        ``,
        `=== Update ===`,
        updateInfo,
        ``,
        `=== Troubleshooting ===`,
        `1. If permission=false: click "Enable for this site"`,
        `2. If status=needs_permission: grant permission, then click "Re-scan"`,
        `3. If media=0 + no error: site may not have a video, or extractor didn't find any`,
        `4. If media=0 + error: read the error message above`,
        `5. If status=unknown: background script may have crashed — reload extension`,
        ``,
        `Copy this info and paste it in a GitHub issue:`,
        `https://github.com/Exon101/grabit/issues`,
      ].filter(Boolean).join('\n');

      body.textContent = info;
    } catch (e) {
      body.textContent = `Error collecting debug info: ${e.message}\n\nStack: ${e.stack || ''}`;
    }

    // Wire buttons
    $('#debug-close').onclick = () => { modal.hidden = true; };
    $('#debug-backdrop').onclick = () => { modal.hidden = true; };
    $('#debug-copy').onclick = () => {
      navigator.clipboard.writeText(body.textContent).then(() => {
        showToast('Copied to clipboard', 'success');
      }).catch(() => {
        showToast('Copy failed', 'error');
      });
    };
    $('#debug-rescan').onclick = async () => {
      body.textContent = 'Re-scanning...';
      try {
        // Clear cache first
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab) await send('clearScanCache', { tabId: tab.id });
        // Re-run scan
        await scanAndRender();
        modal.hidden = true;
      } catch (e) {
        body.textContent = `Re-scan failed: ${e.message}`;
      }
    };
  }

  /* ---------------------------------------------------------------- *
   * Boot
   * ---------------------------------------------------------------- */
  document.addEventListener('DOMContentLoaded', async () => {
    // Wire up controls
    $('#theme-toggle').addEventListener('click', cycleTheme);
    $('#open-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
    $('#clear-recent').addEventListener('click', clearRecent);
    $('#debug-btn').addEventListener('click', showDebugInfo);

    // Show version
    const manifest = chrome.runtime.getManifest();
    $('#version').textContent = `v${manifest.version}`;

    // Bootstrap
    await loadSettings();
    await renderTabCard();
    await loadRecent();
    await loadUpdateBanner();  // Load update banner BEFORE scan so it's visible immediately
    await scanAndRender();
  });
})();
