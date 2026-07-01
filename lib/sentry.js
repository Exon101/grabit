/**
 * lib/sentry.js — lightweight error capture for GrabIt
 *
 * Provides a Sentry-compatible API (init, captureException, captureMessage,
 * addBreadcrumb) that works in Chrome MV3 extensions. No external SDK
 * needed — this is self-contained.
 *
 * Storage: errors are stored in chrome.storage.local under 'error_log'
 * (max 100 entries, FIFO). The Debug modal in the popup reads this log.
 *
 * Remote reporting: if a Sentry DSN is configured in settings, errors
 * are also POSTed to the Sentry ingest endpoint. Otherwise, errors
 * stay local only (no network calls).
 *
 * API:
 *   import { Sentry } from './sentry.js';
 *   Sentry.init({ dsn: 'https://...@sentry.io/...', environment: 'production' });
 *   Sentry.captureException(new Error('something broke'));
 *   Sentry.captureMessage('user did X', 'info');
 *   Sentry.addBreadcrumb({ category: 'ui', message: 'clicked download' });
 *
 *   // Get stored errors (for the Debug panel)
 *   const errors = await Sentry.getRecentErrors();
 *   await Sentry.clearErrors();
 */

const STORAGE_KEY = 'error_log';
const MAX_ERRORS = 100;
const MAX_BREADCRUMBS = 20;

const state = {
  dsn: null,
  environment: 'production',
  release: null,
  enabled: true,
  breadcrumbs: [],
  user: null,
};

/* ------------------------------------------------------------------ *
 * Initialization
 * ------------------------------------------------------------------ */

export function init(opts = {}) {
  state.dsn = opts.dsn || null;
  state.environment = opts.environment || 'production';
  state.release = opts.release || null;
  state.enabled = opts.enabled !== false;
  state.user = opts.user || null;

  // Wire global error handlers
  if (typeof self !== 'undefined') {
    self.addEventListener('error', (event) => {
      captureException(event.error || event.message, {
        type: 'global_error',
        filename: event.filename,
        lineno: event.lineno,
        colno: event.colno,
      });
    });
    self.addEventListener('unhandledrejection', (event) => {
      const err = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
      captureException(err, { type: 'unhandled_promise_rejection' });
    });
  }
}

/* ------------------------------------------------------------------ *
 * Breadcrumbs
 * ------------------------------------------------------------------ */

export function addBreadcrumb(crumb) {
  state.breadcrumbs.push({
    timestamp: new Date().toISOString(),
    ...crumb,
  });
  if (state.breadcrumbs.length > MAX_BREADCRUMBS) {
    state.breadcrumbs = state.breadcrumbs.slice(-MAX_BREADCRUMBS);
  }
}

/* ------------------------------------------------------------------ *
 * Capture
 * ------------------------------------------------------------------ */

export function captureException(error, context = {}) {
  if (!state.enabled) return;

  const entry = {
    id: `err-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type: 'exception',
    level: 'error',
    message: error?.message || String(error),
    stack: error?.stack || '',
    name: error?.name || 'Error',
    context,
    breadcrumbs: [...state.breadcrumbs],
    environment: state.environment,
    release: state.release,
  };

  storeError(entry);
  sendToSentry(entry);
}

export function captureMessage(message, level = 'info', context = {}) {
  if (!state.enabled) return;

  const entry = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    type: 'message',
    level,
    message: String(message),
    context,
    breadcrumbs: [...state.breadcrumbs],
    environment: state.environment,
    release: state.release,
  };

  storeError(entry);
  sendToSentry(entry);
}

/* ------------------------------------------------------------------ *
 * Storage
 * ------------------------------------------------------------------ */

async function storeError(entry) {
  try {
    if (!chrome?.storage?.local) return;
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (r) => resolve(r[STORAGE_KEY] || []));
    });
    stored.unshift(entry);
    if (stored.length > MAX_ERRORS) stored.length = MAX_ERRORS;
    await new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: stored }, resolve);
    });
  } catch (e) {
    // Storage failed — nothing we can do
  }
}

export async function getRecentErrors(limit = 50) {
  try {
    if (!chrome?.storage?.local) return [];
    const stored = await new Promise((resolve) => {
      chrome.storage.local.get(STORAGE_KEY, (r) => resolve(r[STORAGE_KEY] || []));
    });
    return stored.slice(0, limit);
  } catch {
    return [];
  }
}

export async function clearErrors() {
  try {
    if (!chrome?.storage?.local) return;
    await new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: [] }, resolve);
    });
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ *
 * Remote reporting (Sentry-compatible)
 * ------------------------------------------------------------------ */

async function sendToSentry(entry) {
  if (!state.dsn) return; // No DSN = local only

  try {
    const dsn = new URL(state.dsn);
    const projectId = dsn.pathname.replace(/^\//, '');
    const publicKey = dsn.username;
    const ingestUrl = `${dsn.protocol}//${dsn.host}/api/${projectId}/store/`;

    const envelope = {
      event_id: entry.id.replace(/^(err|msg)-/, ''),
      timestamp: entry.timestamp,
      platform: 'javascript',
      environment: entry.environment,
      release: entry.release,
      level: entry.level,
      message: entry.message,
      exception: entry.type === 'exception' ? {
        values: [{
          type: entry.name,
          value: entry.message,
          stacktrace: parseStack(entry.stack),
        }],
      } : undefined,
      extra: entry.context,
      breadcrumbs: entry.breadcrumbs.map(b => ({
        timestamp: b.timestamp,
        category: b.category || 'default',
        message: b.message,
        level: b.level || 'info',
      })),
    };

    await fetch(ingestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_key=${publicKey}, sentry_version=7, sentry_client=grabit-extension/1.0`,
      },
      body: JSON.stringify(envelope),
    });
  } catch (e) {
    // Network failed — error is still stored locally
  }
}

function parseStack(stack) {
  if (!stack) return { frames: [] };
  const frames = [];
  const lines = stack.split('\n');
  for (const line of lines) {
    const m = line.match(/at\s+(.+?)\s+\((.+?):(\d+):(\d+)\)/);
    if (m) {
      frames.push({
        function: m[1],
        filename: m[2],
        lineno: parseInt(m[3], 10),
        colno: parseInt(m[4], 10),
      });
    }
  }
  return { frames: frames.reverse() };
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

export const Sentry = {
  init,
  captureException,
  captureMessage,
  addBreadcrumb,
  getRecentErrors,
  clearErrors,
};

export default Sentry;
