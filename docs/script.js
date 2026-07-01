/**
 * docs/script.js — populates the sites grid + fetches latest release info
 * from the GitHub API so the download button always shows the current size.
 */

(function () {
  'use strict';

  const SITES = [
    { emoji: '📺', name: 'YouTube',     host: 'youtube.com',     id: 'youtube' },
    { emoji: '🐦', name: 'Twitter / X', host: 'twitter.com',     id: 'twitter' },
    { emoji: '📸', name: 'Instagram',   host: 'instagram.com',   id: 'instagram' },
    { emoji: '🎵', name: 'TikTok',      host: 'tiktok.com',      id: 'tiktok' },
    { emoji: '👽', name: 'Reddit',      host: 'reddit.com',      id: 'reddit' },
    { emoji: '👥', name: 'Facebook',    host: 'facebook.com',    id: 'facebook' },
    { emoji: '🎮', name: 'Twitch',      host: 'twitch.tv',       id: 'twitch' },
    { emoji: '📺', name: 'Bilibili',    host: 'bilibili.com',    id: 'bilibili' },
  ];

  function renderSites() {
    const grid = document.getElementById('sites-grid');
    if (!grid) return;
    grid.innerHTML = SITES.map(s => `
      <div class="site-card" data-site="${s.id}">
        <span class="site-emoji">${s.emoji}</span>
        <div class="site-name">${s.name}</div>
        <div class="site-host">${s.host}</div>
      </div>
    `).join('');
  }

  async function fetchLatestRelease() {
    const sizeEl = document.getElementById('download-size');
    if (!sizeEl) return;
    try {
      const res = await fetch('https://api.github.com/repos/Exon101/grabit-extension/releases/latest');
      if (!res.ok) return;
      const data = await res.json();
      const asset = (data.assets || []).find(a => a.name.endsWith('.zip'));
      if (!asset) return;
      const kb = Math.round(asset.size / 1024);
      sizeEl.textContent = `~${kb} KB · .zip`;
    } catch (e) {
      // Keep the default text
      console.warn('Could not fetch release info', e);
    }
  }

  function wireSmoothScroll() {
    document.querySelectorAll('a[href^="#"]').forEach(a => {
      a.addEventListener('click', (e) => {
        const href = a.getAttribute('href');
        if (href === '#' || href.length < 2) return;
        const target = document.querySelector(href);
        if (target) {
          e.preventDefault();
          target.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderSites();
    wireSmoothScroll();
    fetchLatestRelease();
  });
})();
