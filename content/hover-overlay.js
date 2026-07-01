/**
 * content/hover-overlay.js — floating "Download with GrabIt" widget
 *
 * Mounts a small floating button near detected <video> elements on
 * supported sites. On click, shows a popover with the available
 * quality variants from the last scan.
 *
 * Exposed as window.GrabItOverlay with three methods:
 *   mount(opts)         → mounts the overlay widget; returns controller
 *   unmount()           → removes the overlay
 *   applySettings(s)    → updates position/opacity/theme at runtime
 *
 * The widget is site-agnostic — it just needs the parent to provide
 * `getMedia()` returning MediaResult[] from the background scan.
 */

(function () {
  'use strict';
  if (window.GrabItOverlay) return;

  const SVG_DOWNLOAD = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 12 5 5 5-5"/><path d="M5 21h14"/></svg>`;
  const SVG_CLOSE = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18M6 6l12 12"/></svg>`;
  const SVG_SPINNER = `<svg class="grabit-spinner" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56" /></svg>`;

  function createOverlay() {
    const root = document.createElement('div');
    root.id = 'grabit-overlay-root';
    root.setAttribute('data-grabit', '');
    root.style.cssText = 'all:initial;';
    return root;
  }

  function applyPosition(el, pos) {
    const map = {
      'bottom-right': { bottom: '20px', right: '20px', top: 'auto', left: 'auto' },
      'bottom-left': { bottom: '20px', left: '20px', top: 'auto', right: 'auto' },
      'top-right': { top: '20px', right: '20px', bottom: 'auto', left: 'auto' },
      'top-left': { top: '20px', left: '20px', bottom: 'auto', right: 'auto' },
    };
    Object.assign(el.style, map[pos] || map['bottom-right']);
  }

  function controller(opts) {
    let settings = opts.settings || {};
    let media = [];
    let root, btn, popover, popoverList;

    function build() {
      root = createOverlay();
      // Shadow DOM keeps styles contained
      const shadow = root.attachShadow({ mode: 'open' });

      const style = document.createElement('style');
      style.textContent = `
        :host { all: initial; }
        * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; }
        .btn {
          position: fixed;
          z-index: 2147483646;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          padding: 10px 16px 10px 12px;
          background: ${() => ''} var(--grabit-accent, #6366f1);
          color: #fff;
          border: 0;
          border-radius: 999px;
          font-size: 14px;
          font-weight: 600;
          letter-spacing: 0.2px;
          cursor: pointer;
          opacity: ${settings.overlayOpacity ?? 0.95};
          box-shadow: 0 6px 20px -4px rgba(99,102,241,0.5), 0 2px 6px rgba(0,0,0,0.15);
          transition: transform 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease;
          backdrop-filter: blur(8px);
          user-select: none;
        }
        .btn:hover { transform: translateY(-1px) scale(1.02); box-shadow: 0 10px 28px -4px rgba(99,102,241,0.6), 0 3px 8px rgba(0,0,0,0.2); }
        .btn:active { transform: translateY(0) scale(0.98); }
        .btn .icon { display: inline-flex; width: 22px; height: 22px; align-items: center; justify-content: center; background: rgba(255,255,255,0.18); border-radius: 50%; }
        .btn .count { background: rgba(255,255,255,0.22); padding: 1px 7px; border-radius: 10px; font-size: 11px; font-weight: 700; min-width: 18px; text-align: center; }

        .popover {
          position: fixed;
          z-index: 2147483647;
          background: var(--grabit-popover-bg, #fff);
          color: var(--grabit-popover-fg, #1f2937);
          border: 1px solid var(--grabit-popover-border, rgba(0,0,0,0.08));
          border-radius: 14px;
          box-shadow: 0 24px 60px -12px rgba(0,0,0,0.25), 0 8px 16px -4px rgba(0,0,0,0.1);
          min-width: 280px;
          max-width: 360px;
          padding: 8px;
          opacity: 0;
          transform: translateY(8px) scale(0.97);
          transition: opacity 0.15s ease, transform 0.15s ease;
          pointer-events: none;
        }
        .popover.open { opacity: 1; transform: translateY(0) scale(1); pointer-events: auto; }
        .popover .header {
          display: flex; align-items: center; justify-content: space-between;
          padding: 6px 10px 10px; border-bottom: 1px solid var(--grabit-popover-border, rgba(0,0,0,0.06));
          margin-bottom: 6px;
        }
        .popover .header .title { font-size: 13px; font-weight: 700; letter-spacing: 0.3px; }
        .popover .header .close { background: transparent; border: 0; color: inherit; cursor: pointer; padding: 4px; border-radius: 6px; opacity: 0.6; }
        .popover .header .close:hover { opacity: 1; background: rgba(127,127,127,0.12); }
        .popover .media-item { padding: 8px 10px; border-bottom: 1px solid var(--grabit-popover-border, rgba(0,0,0,0.05)); }
        .popover .media-item:last-child { border-bottom: 0; }
        .popover .media-title { font-size: 12px; font-weight: 600; margin-bottom: 4px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
        .popover .variant-list { display: flex; flex-direction: column; gap: 3px; }
        .popover .variant {
          display: flex; align-items: center; justify-content: space-between;
          padding: 7px 10px; background: var(--grabit-variant-bg, rgba(127,127,127,0.06));
          border: 0; border-radius: 8px; cursor: pointer; color: inherit; font-size: 12px; font-weight: 500;
          transition: background 0.12s ease, transform 0.08s ease;
        }
        .popover .variant:hover { background: var(--grabit-variant-hover-bg, rgba(99,102,241,0.14)); transform: translateX(2px); }
        .popover .variant .q { font-weight: 600; }
        .popover .variant .badge { background: var(--grabit-accent, #6366f1); color: #fff; padding: 2px 6px; border-radius: 6px; font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
        .popover .variant .badge.audio { background: #10b981; }
        .popover .empty { padding: 14px 10px; text-align: center; font-size: 12px; opacity: 0.6; }
        .spinner { animation: grabit-spin 0.8s linear infinite; }
        @keyframes grabit-spin { to { transform: rotate(360deg); } }
        .variant.downloading { pointer-events: none; opacity: 0.7; }
      `;
      shadow.appendChild(style);

      btn = document.createElement('button');
      btn.className = 'btn';
      btn.innerHTML = `<span class="icon">${SVG_DOWNLOAD}</span><span>GrabIt</span>`;
      applyPosition(btn, settings.overlayPosition || 'bottom-right');
      btn.style.setProperty('--grabit-accent', settings.accentColor || '#6366f1');
      shadow.appendChild(btn);

      popover = document.createElement('div');
      popover.className = 'popover';
      popover.innerHTML = `
        <div class="header">
          <span class="title">Available media</span>
          <button class="close" aria-label="Close">${SVG_CLOSE}</button>
        </div>
        <div class="media-list"></div>
      `;
      applyPosition(popover, settings.overlayPosition || 'bottom-right');
      // Offset popover above/beside the button
      const pos = settings.overlayPosition || 'bottom-right';
      if (pos.startsWith('bottom')) {
        popover.style.bottom = `${70}px`;
      } else {
        popover.style.top = `${70}px`;
      }
      popoverList = popover.querySelector('.media-list');
      shadow.appendChild(popover);

      // Event handlers
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePopover();
      });
      popover.querySelector('.close').addEventListener('click', closePopover);
      document.addEventListener('click', (e) => {
        if (!root.contains(e.target) && popover.classList.contains('open')) {
          closePopover();
        }
      });

      // Apply theme
      applyTheme();

      document.documentElement.appendChild(root);
      updateButton();
    }

    function applyTheme() {
      const wantDark = settings.theme === 'dark' ||
        (settings.theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
      popover.style.setProperty('--grabit-popover-bg', wantDark ? '#1f2937' : '#fff');
      popover.style.setProperty('--grabit-popover-fg', wantDark ? '#f3f4f6' : '#1f2937');
      popover.style.setProperty('--grabit-popover-border', wantDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)');
      popover.style.setProperty('--grabit-variant-bg', wantDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)');
      popover.style.setProperty('--grabit-variant-hover-bg', wantDark ? 'rgba(99,102,241,0.25)' : 'rgba(99,102,241,0.14)');
    }

    function togglePopover() {
      if (popover.classList.contains('open')) closePopover();
      else openPopover();
    }
    function openPopover() { popover.classList.add('open'); renderList(); }
    function closePopover() { popover.classList.remove('open'); }

    function renderList() {
      if (!media.length) {
        popoverList.innerHTML = `<div class="empty">No media detected on this page yet. Try refreshing.</div>`;
        return;
      }
      popoverList.innerHTML = '';
      for (const m of media.slice(0, 3)) {
        const item = document.createElement('div');
        item.className = 'media-item';
        const titleEl = document.createElement('div');
        titleEl.className = 'media-title';
        titleEl.textContent = m.title || 'Untitled media';
        if (m.error) {
          titleEl.style.opacity = '0.6';
          titleEl.textContent += ' — ' + m.error;
        }
        item.appendChild(titleEl);

        if (m.variants?.length) {
          const vlist = document.createElement('div');
          vlist.className = 'variant-list';
          for (const v of m.variants.slice(0, 6)) {
            const btn = document.createElement('button');
            btn.className = 'variant';
            const q = document.createElement('span'); q.className = 'q'; q.textContent = v.quality || 'source';
            const badge = document.createElement('span');
            badge.className = 'badge' + (v.audio ? ' audio' : '');
            badge.textContent = v.audio ? 'audio' : (v.ext || 'mp4').toUpperCase();
            btn.appendChild(q); btn.appendChild(badge);
            btn.addEventListener('click', () => {
              btn.classList.add('downloading');
              btn.querySelector('.q').innerHTML = `${SVG_SPINNER} starting…`;
              try { opts.onDownload(v, m); } catch (e) { console.error('[GrabIt] onDownload failed', e); }
              setTimeout(() => btn.classList.remove('downloading'), 1500);
              closePopover();
            });
            vlist.appendChild(btn);
          }
          item.appendChild(vlist);
        }
        popoverList.appendChild(item);
      }
    }

    function updateButton() {
      const count = media.reduce((n, m) => n + (m.variants?.length ? 1 : 0), 0);
      const countEl = btn.querySelector('.count');
      if (count > 0) {
        if (!countEl) {
          const c = document.createElement('span');
          c.className = 'count';
          c.textContent = String(count);
          btn.appendChild(c);
        } else {
          countEl.textContent = String(count);
        }
        btn.style.opacity = String(settings.overlayOpacity ?? 0.95);
      } else {
        if (countEl) countEl.remove();
        btn.style.opacity = String((settings.overlayOpacity ?? 0.95) * 0.55);
      }
    }

    function applySettings(s) {
      settings = s;
      if (!root) return;
      applyPosition(btn, s.overlayPosition || 'bottom-right');
      applyPosition(popover, s.overlayPosition || 'bottom-right');
      btn.style.opacity = String(s.overlayOpacity ?? 0.95);
      btn.style.setProperty('--grabit-accent', s.accentColor || '#6366f1');
      applyTheme();
      updateButton();
    }

    function updateMedia(next) {
      media = next || [];
      updateButton();
      if (popover.classList.contains('open')) renderList();
    }

    function showRecentToast(list) {
      // Lightweight: no-op for v1 (notifications handled by chrome.notifications)
    }

    function unmount() {
      if (root && root.parentNode) root.parentNode.removeChild(root);
      root = null;
    }

    build();

    return { applySettings, updateMedia, showRecentToast, unmount };
  }

  window.GrabItOverlay = {
    mount: controller,
  };
})();
