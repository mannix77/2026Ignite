// User state: picks, settings, and what you've already seen. Lives in localStorage
// (per browser / per Home Screen app, per conference); backups and share links move it
// between devices.

import { DEFAULT_PLANNER } from './planner.js';

const BASE_KEY = 'ignite26.planner.v1';
let KEY = BASE_KEY;
let validBuilding = id => typeof id === 'string' && /^[A-Z]$/.test(id);

export const DEFAULT_SETTINGS = {
  buffer: DEFAULT_PLANNER.buffer,
  tolerance: DEFAULT_PLANNER.tolerance,
  keynoteExtra: DEFAULT_PLANNER.keynoteExtra,
  walk: null,           // per-conference walking matrix; null = the conference default
  weights: clone(DEFAULT_PLANNER.weights),
  overrides: {},        // location label -> building id ('' = automatic)
  preview: false,       // simulate days/rooms before the real schedule is published
  hideOnline: false,    // hide online-only sessions in Browse
  startFrom: null,      // where each day starts (building id); null = conference default
  lunch: { on: true, from: 690, to: 810, length: 30, weight: 40 }, // protect a lunch break
  blocks: [],           // [{ id, day, start, end, label, building }] meetings, booth duty…
  repo: 'mannix77/2026Ignite',
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

function blank() {
  return {
    v: 1,
    picks: {},          // sessionId -> { p, lock, lockMode, reserved, score, mode, note, g, code, at }
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
let conferenceDefaults = {};
const listeners = new Set();
let saveTimer = null;

// Conference-specific defaults (walking matrix, start building) and the building ids
// that settings may reference.
export function configure({ defaults = {}, buildingIds = [] } = {}) {
  conferenceDefaults = clone(defaults);
  const ids = new Set(buildingIds);
  validBuilding = id => typeof id === 'string' && ids.has(id);
  cachedSettings = null;
}

// `namespace` keeps each conference (and test data) in its own storage.
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

export function namespace() { return KEY === BASE_KEY ? '' : KEY.slice(BASE_KEY.length + 1); }

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
    load(namespace());
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
  return (cachedSettings ||= merge(merge(clone(DEFAULT_SETTINGS), clone(conferenceDefaults)), clone(state.prefs)));
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { persist(); for (const fn of listeners) fn(what); }

export function pick(id) { return state.picks[id] || null; }

const alive = p => p.p != null || p.note || p.lock || p.reserved;

// Batch edit of picks (repeat groups span several records); emits once. Records with no
// rating, lock, reservation or note are dropped; a note alone keeps a record alive.
export function mutatePicks(fn) {
  fn(state.picks);
  for (const [id, p] of Object.entries(state.picks)) if (!alive(p)) delete state.picks[id];
  if (Object.values(state.picks).some(p => p.p > 0)) askPersistent();
  emit('picks');
}

// One note per repeat group: it lives on `holder`; the other records' notes are cleared.
export function setGroupNote(ids, holder, note, meta = {}) {
  if (!state.picks[holder] && !note) return;
  for (const id of ids) if (id !== holder && state.picks[id]) state.picks[id].note = '';
  state.picks[holder] = { p: null, lock: null, ...meta, ...state.picks[holder], note, at: Date.now() };
  for (const id of new Set([...ids, holder])) if (state.picks[id] && !alive(state.picks[id])) delete state.picks[id];
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
  if (p.lockMode === 'preview' && out.lock) out.lockMode = 'preview';
  if (typeof p.reserved === 'string' && ID_RE.test(p.reserved)) out.reserved = p.reserved;
  if (Number.isFinite(p.score) && p.score >= 0 && p.score <= 100) out.score = Math.round(p.score * 10) / 10;
  if (p.mode === 'watch') out.mode = 'watch';
  if (typeof p.g === 'string' && ID_RE.test(p.g)) out.g = p.g;
  if (typeof p.code === 'string' && ID_RE.test(p.code)) out.code = p.code;
  return alive(out) ? out : null;
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
      for (const [k, v] of Object.entries(src.walk.pairs)) {
        const [a, b] = k.split('|');
        if (validBuilding(a) && validBuilding(b) && num(v, 0, 240) !== undefined) out.walk.pairs[k] = v;
      }
    }
  }
  if (src.weights && typeof src.weights === 'object') {
    out.weights = {};
    for (const k of Object.keys(d.weights)) if (num(src.weights[k], 0, 5000) !== undefined) out.weights[k] = src.weights[k];
  }
  if (src.overrides && typeof src.overrides === 'object') {
    out.overrides = {};
    for (const [label, b] of Object.entries(src.overrides)) if (label.length < 300 && (b === '' || validBuilding(b))) out.overrides[label] = b;
  }
  for (const k of ['preview', 'hideOnline']) if (typeof src[k] === 'boolean') out[k] = src[k];
  if (validBuilding(src.startFrom)) out.startFrom = src.startFrom;
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
        building: validBuilding(b.building) ? b.building : null,
      }));
  }
  if (typeof src.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(src.repo)) out.repo = src.repo;
  return out;
}

// ---- moving picks between devices

export function exportData() {
  return { app: 'ignite26-planner', v: 1, conference: namespace() || 'ignite2026', exportedAt: new Date().toISOString(), picks: state.picks, settings: state.prefs };
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

// Compact share token per pick: CODE.p[sSCORE][w][!LOCKCODE | *LOCKCODE]
//   sN  your own score     w  watch the recording instead     !  locked run     *  locked in preview
const CODE = '[A-Za-z0-9_]{1,24}(?:-[A-Z]\\d+)?'; // BRK101, BRK101-R1, Gartner's 11b / 33jES
const TOKEN = new RegExp(`^(${CODE})\\.([0-3])(?:s(\\d{1,3}(?:\\.\\d)?))?(w)?(?:([!*])(${CODE}))?$`);

export function shareString(codeOf, lockCodeOf) {
  return Object.entries(state.picks)
    .filter(([, v]) => v.p != null)
    .map(([id, v]) => {
      const c = codeOf(id);
      if (!c) return null;
      const lc = v.lock ? lockCodeOf(v.lock) : null;
      const score = Number.isFinite(v.score) ? `s${v.score}` : '';
      return `${c}.${v.p}${score}${v.mode === 'watch' ? 'w' : ''}${lc ? `${v.lockMode === 'preview' ? '*' : '!'}${lc}` : ''}`;
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
    const rec = { p: Number(m[2]), lock: m[6] ? instOfCode(m[6]) : null, code: m[1], at: Date.now() };
    if (m[3]) rec.score = Number(m[3]);
    if (m[4]) rec.mode = 'watch';
    if (rec.lock && m[5] === '*') rec.lockMode = 'preview';
    out[id] = rec;
  }
  return out;
}

// Merge shared ratings, scores and locks; never touch local notes or reserved seats.
export function applyShared(picks) {
  let n = 0;
  for (const [id, p] of Object.entries(picks)) {
    if (!ID_RE.test(id) || !p || typeof p !== 'object') continue;
    const cur = state.picks[id] || { note: '' };
    const lock = cur.reserved ? (cur.lock || cur.reserved) : (p.lock || null);
    const s = sanitizePick({
      ...cur, p: p.p, lock, lockMode: lock && !cur.reserved ? p.lockMode : undefined,
      score: p.score, mode: p.mode, code: p.code || cur.code, at: p.at,
    });
    if (s) { state.picks[id] = s; n++; }
  }
  emit('picks');
  return n;
}

// Erase ratings, locks, notes and change tracking. Settings, display choices and the
// "already seen" marker for the change history stay.
export function resetAll() {
  state = { ...blank(), prefs: state.prefs, ui: { ...state.ui }, seenBatch: state.seenBatch };
  cachedSettings = null;
  emit('reset');
}
