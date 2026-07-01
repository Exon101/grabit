# GrabIt — Universal Media Grabber for Chrome

<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="GrabIt logo" />
</p>

A privacy-respecting Chrome extension that lets you download videos, images, and audio
from **YouTube, Twitter/X, Instagram, TikTok, Reddit, Facebook, Twitch, and Bilibili** —
with a polished popup UI, a floating hover overlay, per-site toggles, dark mode,
settings sync, and a 3-tier download fallback that handles restrictive CDNs.

All extraction and downloading happen **locally in your browser**. No third-party
servers, no telemetry, no account required (beyond being signed into each site as
needed).

---

## Features

### Core
- **8 site extractors** with a unified registry pattern — easy to add more
- **3-tier download fallback** that handles referer-gated CDNs:
  1. `chrome.downloads.download()` (direct, fastest)
  2. Service-worker `fetch()` + Blob URL download (bypasses referer via DNR rules)
  3. Open in new tab (last resort)
- **DASH + HLS manifest parsing** for adaptive streams (Reddit, Twitch VODs)
- **DeclarativeNetRequest rules** that inject `Referer` / `Origin` headers for
  CDNs that require them (video.twimg.com, v.redd.it, tiktokcdn, etc.)

### UI / UX
- **Modern popup** with brand header, tab-info card, loading skeleton, media
  cards with thumbnails, variant grid, recent downloads list, and toast notifications
- **Hover overlay** — a floating "GrabIt" button that appears on supported sites,
  with a popover showing all available quality variants; uses Shadow DOM so site
  styles never leak in
- **Full options page** with sidebar nav (General / Sites / Downloads / Overlay /
  Advanced / About), segmented controls, color picker, range sliders, toggle switches
- **Dark mode** — Auto / Light / Dark with system-preference detection
- **8 accent colors** to choose from
- **Settings sync** via `chrome.storage.sync` — your preferences follow you across
  signed-in Chrome instances
- **Per-site enable/disable** — toggle each extractor independently
- **Filename templates** with variables `{site} {title} {quality} {ext} {author} {date}`
- **Desktop notifications** on completion and errors
- **Recent downloads** list (last 50) with status indicators
- **Context menu** integration ("GrabIt: detect downloadable media on this page")
- **SPA navigation detection** — overlay re-mounts on YouTube/Twitter route changes
- **Reduced-motion** support for accessibility

---

## Supported sites

| Site | URL pattern | Notes |
|------|-------------|-------|
| YouTube | `youtube.com/watch`, `/shorts`, `/embed`; `youtu.be/*` | Ciphered streams fall back to the yt-bridge MAIN-world script |
| Twitter / X | `twitter.com/*/status/*`, `x.com/*/status/*` | Uses bot UA + cookie; referer-bypassed via DNR |
| Instagram | `instagram.com/reel/*`, `/p/*`, `/tv/*` | Requires login (cookies); private/protected posts unsupported |
| TikTok | `tiktok.com/@*/video/*` | Scrapes universal data blob; signed URLs expire ~1h |
| Reddit | `reddit.com/r/*/comments/*` | Uses DASH or HLS master playlist; falls back to direct MP4 |
| Facebook | `facebook.com/watch`, `/permalink`, `/reel`, `/*/videos` | Requires login; scrapes `playable_url` from embedded JSON |
| Twitch | `twitch.tv/*/clip/*`, `twitch.tv/videos/*` | Clips exposed as direct MP4s; VODs via m3u8 |
| Bilibili | `bilibili.com/video/BV*` | Uses public API; DASH video+audio are separate variants |

---

## Architecture

```
grabit-extension/
├── manifest.json              MV3 manifest, permissions, DNR ruleset
├── background/
│   ├── background.js          Service worker: IPC, download orchestration, 3-tier fallback
│   └── dnr_rules.json         Static DNR rules (referer/origin spoofing per CDN)
├── content/
│   ├── content.js             Content script: SPA detection, overlay mount, IPC bridge
│   ├── hover-overlay.js       Floating download button widget (Shadow DOM)
│   └── hover-overlay.css      Overlay host styles
├── extractors/
│   ├── registry.js            Extractor registration + dispatch
│   ├── youtube.js             YouTube (ytInitialPlayerResponse scrape)
│   ├── twitter.js             Twitter (bot UA HTML scrape)
│   ├── instagram.js           Instagram (video_versions JSON scrape)
│   ├── tiktok.js              TikTok (universal data blob scrape)
│   ├── reddit.js              Reddit (.json API + DASH/HLS parse)
│   ├── facebook.js            Facebook (playable_url JSON scrape)
│   ├── twitch.js              Twitch (clip MP4 + VOD m3u8)
│   └── bilibili.js            Bilibili (public API + DASH)
├── lib/
│   ├── utils.js               Logging, URL deobfuscation, settings, storage, helpers
│   ├── dash-hls.js            HLS master + DASH MPD parser
│   ├── restriction-bypass.js  CDN→origin map, DNR rule builder, fetch fallback
│   └── yt-bridge.js           YouTube signature bridge (MAIN-world script)
├── popup/
│   ├── popup.html             380px-wide popup markup
│   ├── popup.css              Modern card UI with dark mode
│   └── popup.js               Popup controller: scan, render, download
├── options/
│   ├── options.html           Full-page options UI (sidebar nav)
│   ├── options.css            Card system, toggles, segmented controls
│   └── options.js             Options controller with debounced save
├── icons/
│   ├── icon16.png             Generated by scripts/gen_icons.py
│   ├── icon48.png
│   └── icon128.png
├── AGENT_MEMORY.md            Architecture notes for AI agents resuming work
├── README.md                  This file
├── LICENSE                    MIT
└── .gitignore
```

### Data flow

```
User clicks toolbar icon
        │
        ▼
   popup.js boots
        │
        │  chrome.runtime.sendMessage({type:'scanActiveTab'})
        ▼
   background.js
        │
        │  runExtractorForTab(tab, settings)
        ▼
   registry.js → site-specific extractor
        │
        │  fetch(url, {credentials:'include'}) → parse HTML/JSON
        ▼
   returns MediaResult[] { id, title, variants[] }
        │
        ▼
   popup.js renders cards
        │
        │  user clicks a variant
        ▼
   background.js.startDownload(payload)
        │
        ▼
   Tier 1: chrome.downloads.download()
        │  └─ if needsReferer or fails →
        ▼
   Tier 2: fetchWithCredentials() → Blob → URL.createObjectURL → chrome.downloads.download()
        │  └─ if fails →
        ▼
   Tier 3: chrome.tabs.create({url})
```

### Hover overlay flow

```
   content.js (document_idle)
        │
        │  loadSettings() → scheduleOverlayMount()
        ▼
   fetch(hover-overlay.js) → inject as <script>
        │
        ▼
   window.GrabItOverlay.mount({settings, onDownload, getMedia})
        │
        │  patches history.pushState/replaceState for SPA detection
        ▼
   user clicks floating button → popover opens
        │
        │  user picks a variant
        ▼
   chrome.runtime.sendMessage({type:'download', payload})
```

---

## Installation

### From source (developer install)

1. Clone this repo:
   ```bash
   git clone https://github.com/Exon101/grabit-extension.git
   cd grabit-extension
   ```
2. Open Chrome and navigate to `chrome://extensions/`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `grabit-extension/` folder
5. The GrabIt icon will appear in your toolbar — pin it for easy access

### Regenerating icons (optional)

The PNG icons are generated from `scripts/gen_icons.py`:

```bash
pip install pillow
python scripts/gen_icons.py
```

### CI / Releases

A GitHub Actions workflow (`.github/workflows/build.yml`) runs on every push to `main`:

1. **Builds a fresh zip** of the extension
2. **Replaces the `latest` release asset** (`grabit-extension.zip`) — the previous zip is clobbered (effectively deleted)
3. **On major version bumps** (e.g. v1.x → v2.x), snapshots the previous `latest` zip into a permanent `v{N}.x-archive` release before replacing it

So users always have:
- **[Latest](../../releases/tag/latest)** — the most recent build, replaced on every commit
- **`v{N}.x-archive`** releases — one per major version, never modified (e.g. `v1.x-archive` contains the last v1.x build, kept forever)

---

## Usage

### From the toolbar popup
1. Navigate to a supported site (e.g. a YouTube video)
2. Click the GrabIt toolbar icon
3. The popup shows the detected media with all available quality variants
4. Click any variant to start the download — a toast confirms the tier used
5. Recent downloads appear at the bottom of the popup

### From the hover overlay
1. On any supported site, a floating "GrabIt" button appears in the corner
2. Click it to see all available media and quality variants
3. Pick a variant to download immediately

### From the context menu
Right-click anywhere on a supported page → **GrabIt: detect downloadable media on this page** →
the first detected media's best variant will download automatically.

### Settings
Open the options page (right-click the toolbar icon → **Options**, or click **Settings** in
the popup footer) to configure:
- Theme (Auto / Light / Dark) and accent color
- Per-site enable/disable
- Default download quality
- Download subfolder and filename template
- Notification preferences
- Hover overlay position, opacity, and visibility
- Restriction bypass (DNR rules)
- Max parallel downloads
- Debug logging

Settings sync across your signed-in Chrome instances via `chrome.storage.sync`.

---

## Permissions explained

| Permission | Why |
|------------|-----|
| `activeTab` | Read the current tab's URL to dispatch to the right extractor |
| `scripting` | Inject the YouTube signature bridge into the MAIN world |
| `storage` | Persist settings (sync) and recent downloads (local) |
| `tabs` | Read tab metadata (title, favicon) for the popup |
| `contextMenus` | Add the right-click "GrabIt" entry on supported sites |
| `notifications` | Desktop notifications on download completion / error |
| `declarativeNetRequest` | Inject Referer/Origin headers for CDNs that require them |
| `declarativeNetRequestFeedback` | (Reserved) observe DNR rule matches for debugging |

**Host permissions** are scoped to the 10 supported sites plus a few common video CDNs.
We deliberately do **not** request `<all_urls>`.

We do **not** request the `downloads` permission for arbitrary URLs — we use
`chrome.downloads.download()` with our own extracted URLs, which doesn't require
the broad `downloads` permission in MV3. (Some references suggest otherwise; see
`AGENT_MEMORY.md` for the bug history.)

---

## Development

### File structure
See the **Architecture** section above.

### Conventions
- All extension code uses **ES modules** (`import`/`export`)
- The service worker is declared as `"type": "module"` in the manifest
- Content scripts are plain IIFEs (content scripts can't easily be modules
  without per-file manifest entries)
- All UI text is in **English**; the codebase has no i18n yet (TODO)
- No external dependencies — pure Chrome Extensions API + vanilla JS/CSS

### Adding a new site extractor
1. Create `extractors/<sitename>.js` exporting an object with `id`, `name`,
   `domains`, and an `async extract(tab, opts)` method returning `MediaResult[]`
2. Import and register it in `extractors/registry.js`
3. Add host permissions and content script matches in `manifest.json`
4. If the CDN requires referer spoofing, add an entry to `CDN_ORIGIN_MAP` in
   `lib/restriction-bypass.js` and a rule to `background/dnr_rules.json`

### Testing
There's no test suite yet. Manual smoke test:
1. Load the extension
2. Visit each of the 8 supported sites with a typical video
3. Open the popup — verify media is detected
4. Click a variant — verify download starts
5. Open DevTools for the service worker (`chrome://extensions` → "Inspect views: service worker`)
   to check logs (enable debug logging in Settings → Advanced for verbose output)

---

## Known limitations

1. **YouTube ciphered streams** — Some YouTube videos serve only ciphered URLs
   that require the page's JS to decode. The yt-bridge script handles many cases
   but not all (especially after YouTube changes the player JS).
2. **Age-restricted YouTube videos** — Return `LOGIN_REQUIRED` even with cookies;
   we surface the error in the popup.
3. **TikTok signed URL expiry** — TikTok video URLs expire after ~1 hour; if you
   scan a tab and wait too long before clicking download, you may need to refresh.
4. **Bilibili video+audio split** — DASH streams expose video and audio as separate
   variants. Downloading just the video variant yields a silent file. Muxing them
   into a single MP4 would require ffmpeg.wasm — planned for v1.1.
5. **Facebook private videos** — Many Facebook videos require the user to be
   signed in AND be a friend/follower of the poster. We surface the "no URL found"
   error.
6. **Reddit HLS audio desync** — On some Reddit posts the HLS audio variant is
   slightly out of sync with the video; we recommend the DASH or fallback MP4
   variant in those cases.
7. **Instagram stories** — Stories expire after 24h and use a different URL
   pattern than reels/posts; not currently supported.
8. **Twitch live streams** — Live streams are not downloadable (only clips and VODs).
9. **Rate limiting** — Aggressive scanning of many tabs in quick succession may
   trigger 429s from some sites (especially Reddit and Bilibili). The 30-second
   per-tab scan cache helps but doesn't fully mitigate this.

---

## Privacy

- **No telemetry** — GrabIt does not collect or transmit any data to any server
  other than the sites you're already browsing
- **No third-party requests** — All requests go directly to the sites you visit
- **Cookies are sent with extraction requests** so logged-in-only content works,
  but cookies are never read or stored by the extension
- **Settings sync** uses Chrome's built-in sync (encrypted, tied to your Google account)
- **Recent downloads** are stored locally in `chrome.storage.local` and never leave
  your device

---

## License

MIT — see [LICENSE](LICENSE).

## Credits

Built by Exon101. Inspired by projects like `yt-dlp`, `cobalt.tools`, and `video-download-helper`.
