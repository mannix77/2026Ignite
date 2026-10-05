// User state: picks, settings, and what you've already seen. Lives in localStorage
// (per browser / per Home Screen app); backups and share links move it between devices.

import { DEFAULT_PLANNER } from './planner.js';
import { BUILDING } from './venue.js';

const BASE_KEY = 'ignite26.planner.v1';
let KEY = BASE_KEY;

export const DEFAULT_SETTINGS = {
  buffer: DEFAULT_PLANNER.buffer,
  tolerance: DEFAULT_PLANNER.tolerance,
  keynoteExtra: DEFAULT_PLANNER.keynoteExtra,
  walk: clone(DEFAULT_PLANNER.walk),
  weights: clone(DEFAULT_PLANNER.weights),
  overrides: {},        // location label -> building id ('' = automatic)
  preview: false,       // simulate days/rooms before the real schedule is published
  hideOnline: false,    // hide online-only sessions in Browse
  startFrom: 'W',       // where each day starts (for "leave by" before the first session)
  lunch: { on: true, from: 690, to: 810, length: 30, weight: 60 }, // protect a lunch break
  blocks: [],           // [{ id, day, start, end, label, building }] meetings, booth duty…
  repo: 'mannix77/2026Ignite',
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function blank() {
  return {
    v: 1,
    picks: {},          // sessionId -> { p: 0-3|null, lock: instKey|null, lockMode, reserved, note, g, code, at }
    prefs: {},          // only the settings the user changed; defaults fill the rest
    known: {},          // instKey -> snapshot of fields we alert on, for picked sessions
    seenBatch: null,    // timestamp of newest change batch already viewed
    ui: { tab: 'browse', filters: {}, day: null },
  };
}

function merge(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) merge(base[k], v);
    else base[k] = v;
  }
  return base;
}

let state = blank();
let cachedSettings = null;
const listeners = new Set();
let saveTimer = null;

// `namespace` keeps test data (?data=…) from touching your real picks.
export function load(namespace = '') {
  KEY = namespace ? `${BASE_KEY}:${namespace}` : BASE_KEY;
  state = blank();
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      delete saved.settings; // pre-release format stored every default
      if (saved.prefs) delete saved.prefs.simNow;
      if (saved.known && Object.values(saved.known).some(k => k && !k.inst)) saved.known = {}; // pre-release keying
      state = merge(blank(), saved);
      state.picks = sanitizePicks(state.picks);
      state.prefs = sanitizePrefs(state.prefs);
    }
  } catch (e) {
    console.warn('Could not read saved state', e);
  }
  cachedSettings = null;
  return state;
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { console.warn('Could not save state', e); }
  }, 150);
}

// Another tab saved: adopt its state instead of overwriting it on our next save.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== KEY || e.newValue == null) return;
    clearTimeout(saveTimer);
    load(KEY === BASE_KEY ? '' : KEY.slice(BASE_KEY.length + 1));
    for (const fn of listeners) fn('reset');
  });
}

let persistAsked = false;
function askPersistent() {
  if (persistAsked) return;
  persistAsked = true;
  try { navigator.storage?.persist?.().catch(() => {}); } catch { /* not supported */ }
}

export function get() { return state; }
export function settings() {
  return (cachedSettings ||= merge(clone(DEFAULT_SETTINGS), clone(state.prefs)));
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { persist(); for (const fn of listeners) fn(what); }

export function pick(id) { return state.picks[id] || null; }

// Batch edit of picks (repeat groups span several records); emits once. Records with no
// rating, lock, reservation or note are dropped; a note alone keeps a record alive.
export function mutatePicks(fn) {
  fn(state.picks);
  for (const [id, p] of Object.entries(state.picks)) {
    if (p.p == null && !p.note && !p.lock && !p.reserved) delete state.picks[id];
  }
  if (Object.values(state.picks).some(p => p.p > 0)) askPersistent();
  emit('picks');
}

export function setNote(id, note, meta = {}) {
  const cur = state.picks[id];
  if (!cur && !note) return;
  state.picks[id] = { p: null, lock: null, ...meta, ...cur, note, at: Date.now() };
  const p = state.picks[id];
  if (!note && p.p == null && !p.lock && !p.reserved) delete state.picks[id];
  emit('note');
}

export function updateSettings(patch) {
  state.prefs = merge(state.prefs || {}, clone(patch));
  cachedSettings = null;
  emit('settings');
}

// Replace one top-level setting outright (lists/objects where merging would keep stale keys).
export function setSetting(key, value) {
  state.prefs = { ...(state.prefs || {}), [key]: clone(value) };
  cachedSettings = null;
  emit('settings');
}

// Restores planner tuning; keeps display choices, room overrides, blocks and lunch.
export function resetSettings() {
  const keep = ['preview', 'hideOnline', 'repo', 'overrides', 'blocks', 'lunch', 'startFrom'];
  state.prefs = Object.fromEntries(Object.entries(state.prefs).filter(([k]) => keep.includes(k)));
  cachedSettings = null;
  emit('settings');
}

export function setUI(patch) {
  Object.assign(state.ui, patch);
  persist();
}

export function setKnown(known) { state.known = known; emit('known'); }
export function setSeenBatch(at) { state.seenBatch = at; emit('seen'); }

// ---- validation (backups, share links and old saves are untrusted input)

const ID_RE = /^[\w.:-]{1,120}$/;
function sanitizePick(p) {
  if (!p || typeof p !== 'object') return null;
  const out = {
    p: [0, 1, 2, 3].includes(p.p) ? p.p : null,
    lock: typeof p.lock === 'string' && ID_RE.test(p.lock) ? p.lock : null,
    note: typeof p.note === 'string' ? p.note.slice(0, 4000) : '',
    at: Number.isFinite(p.at) ? p.at : Date.now(),
  };
  if (p.lockMode === 'preview') out.lockMode = 'preview';
  if (typeof p.reserved === 'string' && ID_RE.test(p.reserved)) out.reserved = p.reserved;
  if (typeof p.g === 'string' && ID_RE.test(p.g)) out.g = p.g;
  if (typeof p.code === 'string' && ID_RE.test(p.code)) out.code = p.code;
  return out.p == null && !out.note && !out.lock && !out.reserved ? null : out;
}

function sanitizePicks(picks) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) {
    if (!ID_RE.test(id)) continue;
    const s = sanitizePick(p);
    if (s) out[id] = s;
  }
  return out;
}

const num = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
function sanitizePrefs(src) {
  const d = DEFAULT_SETTINGS;
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of ['buffer', 'tolerance', 'keynoteExtra']) if (num(src[k], 0, 240) !== undefined) out[k] = src[k];
  if (src.walk && typeof src.walk === 'object') {
    out.walk = {};
    for (const k of ['sameRoom', 'sameFloor', 'diffFloor', 'unknown']) if (num(src.walk[k], 0, 240) !== undefined) out.walk[k] = src.walk[k];
    if (src.walk.pairs && typeof src.walk.pairs === 'object') {
      out.walk.pairs = {};
      for (const k of Object.keys(d.walk.pairs)) if (num(src.walk.pairs[k], 0, 240) !== undefined) out.walk.pairs[k] = src.walk.pairs[k];
    }
  }
  if (src.weights && typeof src.weights === 'object') {
    out.weights = {};
    for (const k of Object.keys(d.weights)) if (num(src.weights[k], 0, 5000) !== undefined) out.weights[k] = src.weights[k];
  }
  if (src.overrides && typeof src.overrides === 'object') {
    out.overrides = {};
    for (const [label, b] of Object.entries(src.overrides)) if (label.length < 300 && (b === '' || (BUILDING[b] && /^[A-Z]$/.test(b)))) out.overrides[label] = b;
  }
  for (const k of ['preview', 'hideOnline']) if (typeof src[k] === 'boolean') out[k] = src[k];
  if (typeof src.startFrom === 'string' && /^[A-Z]$/.test(src.startFrom) && BUILDING[src.startFrom]) out.startFrom = src.startFrom;
  if (src.lunch && typeof src.lunch === 'object') {
    const l = src.lunch;
    out.lunch = {
      on: l.on !== false,
      from: num(l.from, 0, 1440) ?? d.lunch.from, to: num(l.to, 0, 1440) ?? d.lunch.to,
      length: num(l.length, 5, 240) ?? d.lunch.length, weight: num(l.weight, 0, 5000) ?? d.lunch.weight,
    };
  }
  if (Array.isArray(src.blocks)) {
    out.blocks = src.blocks
      .filter(b => b && /^\d{4}-\d{2}-\d{2}$/.test(b.day) && num(b.start, 0, 1440) !== undefined && num(b.end, 0, 1440) !== undefined && b.end > b.start)
      .slice(0, 50).map((b, i) => ({
        id: typeof b.id === 'string' && ID_RE.test(b.id) ? b.id : `b${i}`, day: b.day, start: b.start, end: b.end,
        label: typeof b.label === 'string' ? b.label.slice(0, 80) : 'Busy',
        building: typeof b.building === 'string' && /^[A-Z]$/.test(b.building) && BUILDING[b.building] ? b.building : 'W',
      }));
  }
  if (typeof src.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(src.repo)) out.repo = src.repo;
  return out;
}

// ---- moving picks between devices

export function exportData() {
  return { app: 'ignite26-planner', v: 1, exportedAt: new Date().toISOString(), picks: state.picks, settings: state.prefs };
}

export function importData(obj, { replace = false } = {}) {
  if (!obj || obj.app !== 'ignite26-planner' || !obj.picks || typeof obj.picks !== 'object') throw new Error('Not an Ignite planner backup file');
  const incoming = sanitizePicks(obj.picks);
  if (replace) state.picks = {};
  for (const [id, p] of Object.entries(incoming)) {
    const cur = state.picks[id];
    if (!cur || p.at >= (cur.at || 0)) state.picks[id] = { ...p, note: p.note || cur?.note || '' };
  }
  if (obj.settings && replace) { state.prefs = sanitizePrefs(obj.settings); cachedSettings = null; }
  emit(replace ? 'reset' : 'picks');
  return Object.keys(incoming).length;
}

// Compact share string: CODE.p, or CODE.p!LOCKEDCODE when a specific run is locked.
const CODE = '[A-Za-z]+\\d+[A-Za-z]?(?:-[A-Z]\\d+)?';
const TOKEN = new RegExp(`^(${CODE})\\.([0-3])(?:!(${CODE})?)?$`);

export function shareString(codeOf, lockCodeOf) {
  return Object.entries(state.picks)
    .filter(([, v]) => v.p != null)
    .map(([id, v]) => {
      const c = codeOf(id);
      if (!c) return null;
      const lc = v.lock ? lockCodeOf(v.lock) : null;
      return `${c}.${v.p}${v.lock ? `!${lc || ''}` : ''}`;
    })
    .filter(Boolean)
    .join('~');
}

export function parseShare(str, idOfCode, instOfCode) {
  const out = {};
  for (const tok of (str || '').split('~')) {
    const m = TOKEN.exec(tok.trim());
    if (!m) continue;
    const id = idOfCode(m[1]);
    if (!id) continue;
    out[id] = { p: Number(m[2]), lock: m[3] ? instOfCode(m[3]) : tok.includes('!') ? instOfCode(m[1]) : null, code: m[1], at: Date.now() };
  }
  return out;
}

// Merge shared ratings and locks; never touch local notes. Validated like a backup.
export function applyShared(picks) {
  let n = 0;
  for (const [id, p] of Object.entries(picks)) {
    if (!ID_RE.test(id) || !p || typeof p !== 'object') continue;
    const cur = state.picks[id] || { note: '' };
    const s = sanitizePick({ ...cur, p: p.p, lock: p.lock || null, code: p.code || cur.code, at: p.at });
    if (s) { state.picks[id] = s; n++; }
  }
  emit('picks');
  return n;
}

// Erase ratings, locks, notes and change tracking. Settings and display choices stay.
export function resetAll() {
  state = { ...blank(), prefs: state.prefs, ui: { ...state.ui } };
  cachedSettings = null;
  emit('reset');
}
