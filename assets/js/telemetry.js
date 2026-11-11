// Opt-in error telemetry to Honeycomb (issue #140, "app errors from the PWA"). No-build: a
// plain fetch with a timeout, no new dependency.
//
// Nothing is ever sent unless BOTH are true:
//  - a key is stamped into the page (CI copies it from the repo's HONEYCOMB_BROWSER_KEY
//    variable -- a public, ingest-only key, not a secret -- into <meta name="honeycomb-browser-key">;
//    blank until the owner sets that variable);
//  - the person turned on Settings -> "Send anonymous error reports" (default OFF). A key
//    embedded in a public page can be used by anyone to send events, so this stays off until
//    someone explicitly opts in, on their own device.
//
// Only ever sent: event_type, app_version, conference, browser_family, error_name, at. No
// picks, notes, profile answers, settings, or anything that identifies a person -- ALLOWED
// below is the whole list, and send() drops anything else before it ever reaches fetch().
const DATASET = 'app-errors';
const TIMEOUT_MS = 4000;
const ALLOWED = ['event_type', 'app_version', 'conference', 'browser_family', 'error_name', 'at'];

function meta(name) {
  try {
    return document.querySelector(`meta[name="${name}"]`)?.content || '';
  } catch {
    return ''; // no DOM (a test, or a very early failure): telemetry just stays off
  }
}

// Exported for testing with an arbitrary UA string; also used live from navigator.userAgent.
export function browserFamily(ua) {
  ua = ua || '';
  if (/EdgiOS\/|Edg\//.test(ua)) return 'Edge';
  if (/OPR\/|Opera/.test(ua)) return 'Opera';
  if (/FxiOS\/|Firefox\//.test(ua)) return 'Firefox';
  if (/CriOS\/|Chrome\//.test(ua)) return 'Chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'Safari';
  return 'Other';
}

// The allow-listed event this module would send for `eventType`, with no network involved;
// tests assert this directly (CLAUDE.md test rule 11), and reportError() sends exactly this.
export function buildEvent(eventType, { conference, errorName, now = Date.now(), ua } = {}) {
  const event = {
    event_type: eventType,
    app_version: meta('app-version') || 'dev',
    conference: conference || null,
    browser_family: browserFamily(ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '')),
    error_name: errorName || null,
    at: new Date(now).toISOString(),
  };
  const out = {};
  for (const k of ALLOWED) if (event[k] != null) out[k] = event[k];
  return out;
}

function ingestKey() {
  return meta('honeycomb-browser-key');
}

function send(event, key) {
  const body = JSON.stringify([{ data: event }]);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
  return fetch(`https://api.honeycomb.io/1/batch/${DATASET}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Honeycomb-Team': key },
    body,
    signal: controller?.signal,
    keepalive: true, // a crash/unload must not cancel a report already in flight
  }).catch(() => { /* a failed or slow send must never surface to the person using the app */ })
    .finally(() => { if (timer) clearTimeout(timer); });
}

// `enabled` is the live value of Settings -> telemetry (store.settings().telemetry); callers
// pass it in rather than this module reading storage itself, so it works the same in a test
// with no store loaded. Returns false (and sends nothing) when off or unconfigured.
export function reportError(eventType, { enabled, conference, errorName } = {}) {
  const key = ingestKey();
  if (!enabled || !key) return false;
  send(buildEvent(eventType, { conference, errorName }), key);
  return true;
}
