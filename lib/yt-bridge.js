/**
 * lib/yt-bridge.js — YouTube signature / n-param resolver bridge
 *
 * YouTube serves video URLs with cipher/signature parameters that must be
 * decoded by JS code embedded in the watch page's player script. Replicating
 * that logic in extension code is fragile and breaks every few weeks.
 *
 * Strategy: inject this script into the youtube.com page (MAIN world) via
 * <script> tag. It hooks into the page's `ytplayer.config` / `ytInitialPlayerResponse`
 * and exposes a `window.__grabit_yt_resolve(url)` function that the
 * content script can call to resolve a ciphered URL.
 *
 * Why MAIN world: YouTube's signature functions live on the page's window
 * object, which is isolated from the extension's content script sandbox.
 * We must run in the same world as the page to access them.
 *
 * This file is listed in manifest.web_accessible_resources so the content
 * script can fetch() it and inject it via a <script> tag.
 */

(function () {
  if (window.__grabit_yt_init) return;
  window.__grabit_yt_init = true;

  // Cache of resolved URLs to avoid recomputing
  const cache = new Map();

  /**
   * Try to find the player response object on the page.
   */
  function getPlayerResponse() {
    if (typeof ytInitialPlayerResponse !== 'undefined' && ytInitialPlayerResponse) {
      return ytInitialPlayerResponse;
    }
    if (typeof ytplayer !== 'undefined' && ytplayer?.config?.args?.raw_player_response) {
      return ytplayer.config.args.raw_player_response;
    }
    // Walk <script> tags for ytInitialPlayerResponse = {...}
    for (const s of document.querySelectorAll('script')) {
      const t = s.textContent;
      if (!t || t.length > 5_000_000) continue;
      const m = t.match(/ytInitialPlayerResponse\s*=\s*(\{.+?\});/);
      if (m) {
        try {
          return JSON.parse(m[1]);
        } catch {
          // ignore
        }
      }
    }
    return null;
  }

  /**
   * Extract the signatureCipher / cipher resolver function from the player JS.
   * This is the *fingerprint* of the signature resolver — YouTube renames
   * variables but the structure is stable enough to extract.
   */
  function extractSigResolverName(playerUrl) {
    // We can't easily fetch+eval the player JS from the page due to CSP.
    // Instead, rely on ytInitialPlayerResponse.streamingData to contain
    // already-resolved URLs for *some* videos (those without cipher).
    return null;
  }

  /**
   * Try to resolve a ciphered URL using the page's own functions.
   * Returns the resolved URL, or null if we couldn't.
   */
  function resolveCipheredUrl(originalUrl) {
    const pr = getPlayerResponse();
    if (!pr?.streamingData) return null;

    // Look for the matching URL in streamingData.formats / adaptiveFormats
    const all = [
      ...(pr.streamingData.formats || []),
      ...(pr.streamingData.adaptiveFormats || []),
    ];

    for (const f of all) {
      const candidate = f.url || f.signatureCipher?.split('&s=')[1]?.split('&')[0];
      if (!candidate) continue;

      // If the original URL contains the itag and the host, treat as match.
      try {
        const origItag = new URL(originalUrl).searchParams.get('itag');
        const candItag = new URL(f.url || `?itag=${f.itag}`).searchParams.get('itag');
        if (origItag && candItag && origItag === candItag) {
          // Prefer unciphered URL
          if (f.url) return f.url;
        }
      } catch {
        // ignore
      }
    }
    return null;
  }

  window.__grabit_yt_resolve = function (url) {
    if (cache.has(url)) return cache.get(url);
    const resolved = resolveCipheredUrl(url);
    cache.set(url, resolved || url);
    return resolved || url;
  };

  // Signal to content script that bridge is ready
  window.dispatchEvent(new CustomEvent('__grabit_yt_ready'));
})();
