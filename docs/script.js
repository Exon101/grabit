/**
 * docs/script.js — populates the sites grid with official brand logos
 * and fetches latest release info from the GitHub API.
 */

(function () {
  'use strict';

  /**
   * Official brand SVG logos (path data only — viewBox is 0 0 24 24).
   * Source: simpleicons.org (CC0). Brand colors are official.
   */
  const SITE_LOGOS = {
    youtube: {
      name: 'YouTube',
      host: 'youtube.com',
      color: '#FF0000',
      path: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
    },
    twitter: {
      name: 'Twitter / X',
      host: 'x.com',
      color: '#000000',
      path: 'M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z',
    },
    instagram: {
      name: 'Instagram',
      host: 'instagram.com',
      color: '#E4405F',
      path: 'M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zm0-2.163C8.741 0 8.332.014 7.052.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 1 0 0 12.324 6.162 6.162 0 0 0 0-12.324zM12 16a4 4 0 1 1 0-8 4 4 0 0 1 0 8zm6.406-11.845a1.44 1.44 0 1 0 0 2.881 1.44 1.44 0 0 0 0-2.881z',
    },
    tiktok: {
      name: 'TikTok',
      host: 'tiktok.com',
      color: '#000000',
      path: 'M12.525.02c1.31-.02 2.61-.01 3.91-.02.08 1.53.63 3.09 1.75 4.17 1.12 1.11 2.7 1.62 4.24 1.79v4.03c-1.44-.05-2.89-.35-4.2-.97-.57-.26-1.1-.59-1.62-.93-.01 2.92.01 5.84-.02 8.75-.08 1.4-.54 2.79-1.35 3.94-1.31 1.92-3.58 3.17-5.91 3.21-1.43.08-2.86-.31-4.08-1.03-2.02-1.19-3.44-3.37-3.65-5.71-.02-.5-.03-1-.01-1.49.18-1.9 1.12-3.72 2.58-4.96 1.66-1.44 3.98-2.13 6.15-1.72.02 1.48-.04 2.96-.04 4.44-.99-.32-2.15-.23-3.02.37-.63.41-1.11 1.04-1.36 1.75-.21.51-.15 1.07-.14 1.61.24 1.64 1.82 3.02 3.5 2.87 1.12-.01 2.19-.66 2.77-1.61.19-.33.4-.67.41-1.06.1-1.79.06-3.57.07-5.36.01-4.03-.01-8.05.02-12.07z',
    },
    reddit: {
      name: 'Reddit',
      host: 'reddit.com',
      color: '#FF4500',
      path: 'M12 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0zm5.01 4.744c.688 0 1.25.561 1.25 1.249a1.25 1.25 0 0 1-2.498.056l-2.597-.547-.801 3.704c1.895.07 3.577.671 4.832 1.621.413-.402.971-.651 1.587-.651 1.256 0 2.274 1.018 2.274 2.274 0 .879-.499 1.641-1.229 2.024.045.225.068.456.068.693 0 2.526-2.962 4.574-6.613 4.574-3.65 0-6.612-2.048-6.612-4.574 0-.238.023-.469.068-.694-.73-.383-1.229-1.145-1.229-2.024 0-1.256 1.018-2.274 2.274-2.274.616 0 1.174.249 1.587.651 1.255-.95 2.937-1.55 4.832-1.621l.889-4.123a.346.346 0 0 1 .41-.265l2.931.615a1.25 1.25 0 0 1 1.067-.604zm-7.95 7.5a1.072 1.072 0 1 0 0 2.144 1.072 1.072 0 0 0 0-2.144zm5.876 0a1.072 1.072 0 1 0 0 2.144 1.072 1.072 0 0 0 0-2.144zm-2.938 4.014a.625.625 0 0 0-.434.183.625.625 0 0 0 0 .884.625.625 0 0 0 .884 0 .625.625 0 0 0 0-.884.625.625 0 0 0-.45-.183z',
    },
    facebook: {
      name: 'Facebook',
      host: 'facebook.com',
      color: '#1877F2',
      path: 'M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z',
    },
    twitch: {
      name: 'Twitch',
      host: 'twitch.tv',
      color: '#9146FF',
      path: 'M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714Z',
    },
    bilibili: {
      name: 'Bilibili',
      host: 'bilibili.com',
      color: '#00A1D6',
      path: 'M17.813 4.653h.854c1.51.054 2.769.578 3.773 1.574 1.004.995 1.524 2.249 1.56 3.76v7.36c-.036 1.51-.556 2.769-1.56 3.773s-2.262 1.524-3.773 1.56H5.333c-1.51-.036-2.769-.556-3.773-1.56S.036 18.858 0 17.347v-7.36c.036-1.511.556-2.765 1.56-3.76 1.004-.996 2.262-1.52 3.773-1.574h.774l-1.174-1.12a1.234 1.234 0 0 1-.373-.906c0-.356.124-.658.373-.907l.027-.027c.267-.249.573-.373.92-.373.347 0 .653.124.92.373L9.653 4.44c.071.071.134.142.187.213h4.267a.836.836 0 0 1 .16-.213l2.853-2.747c.267-.249.573-.373.92-.373.347 0 .662.151.929.4.267.249.391.551.391.907 0 .355-.124.657-.373.906zM5.333 7.24c-.746.018-1.373.276-1.88.773-.506.498-.769 1.13-.786 1.894v7.52c.017.764.28 1.395.786 1.893.507.498 1.134.756 1.88.773h13.334c.746-.017 1.373-.275 1.88-.773.506-.498.769-1.129.786-1.893v-7.52c-.017-.764-.28-1.396-.786-1.894-.507-.497-1.134-.755-1.88-.773zM8 11.107c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c0-.373.129-.689.387-.947.258-.257.574-.386.946-.386zm8 0c.373 0 .684.124.933.373.25.249.383.569.4.96v1.173c-.017.391-.15.711-.4.96-.249.25-.56.374-.933.374s-.684-.125-.933-.374c-.25-.249-.383-.569-.4-.96V12.44c.017-.391.15-.711.4-.96.249-.249.56-.373.933-.373z',
    },
  };

  function renderSites() {
    const grid = document.getElementById('sites-grid');
    if (!grid) return;
    grid.innerHTML = Object.entries(SITE_LOGOS).map(([id, s]) => `
      <div class="site-card" data-site="${id}" style="--brand: ${s.color}">
        <div class="site-logo">
          <svg viewBox="0 0 24 24" width="32" height="32" fill="currentColor" aria-hidden="true">
            <path d="${s.path}"/>
          </svg>
        </div>
        <div class="site-name">${s.name}</div>
        <div class="site-host">${s.host}</div>
      </div>
    `).join('');
  }

  async function fetchLatestRelease() {
    const sizeEl = document.getElementById('download-size');
    if (!sizeEl) return;
    try {
      const res = await fetch('https://api.github.com/repos/Exon101/grabit/releases/latest');
      if (!res.ok) return;
      const data = await res.json();
      const asset = (data.assets || []).find(a => a.name.endsWith('.zip'));
      if (!asset) return;
      const kb = Math.round(asset.size / 1024);
      sizeEl.textContent = `~${kb} KB · .zip`;
    } catch (e) {
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

  function wireNavScroll() {
    const nav = document.querySelector('.nav');
    if (!nav) return;
    let lastScroll = 0;
    window.addEventListener('scroll', () => {
      const scroll = window.scrollY;
      if (scroll > 20) {
        nav.classList.add('nav-scrolled');
      } else {
        nav.classList.remove('nav-scrolled');
      }
      lastScroll = scroll;
    }, { passive: true });
  }

  function wireMobileMenu() {
    const toggle = document.getElementById('nav-toggle');
    const menu = document.getElementById('nav-mobile');
    if (!toggle || !menu) return;

    toggle.addEventListener('click', () => {
      const isOpen = !menu.hidden;
      if (isOpen) {
        menu.hidden = true;
        toggle.classList.remove('active');
        toggle.setAttribute('aria-expanded', 'false');
      } else {
        menu.hidden = false;
        toggle.classList.add('active');
        toggle.setAttribute('aria-expanded', 'true');
      }
    });

    // Close menu when a link is clicked
    menu.querySelectorAll('a').forEach(a => {
      a.addEventListener('click', () => {
        menu.hidden = true;
        toggle.classList.remove('active');
        toggle.setAttribute('aria-expanded', 'false');
      });
    });

    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
      if (menu.hidden) return;
      const nav = document.querySelector('.nav');
      if (nav && !nav.contains(e.target)) {
        menu.hidden = true;
        toggle.classList.remove('active');
        toggle.setAttribute('aria-expanded', 'false');
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    renderSites();
    wireSmoothScroll();
    wireNavScroll();
    wireMobileMenu();
    fetchLatestRelease();
  });
})();
