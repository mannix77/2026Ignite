// User state: picks, settings, and what you've already seen. Lives in localStorage
// (per browser / per Home Screen app, per conference); backups and share links move it
// between devices.

import { DEFAULT_PLANNER } from './planner.js';
import { nsKey } from './instance.js';
import { blankProfile, sanitizeProfile } from './profile.js';

const BASE_KEY = nsKey('ignite26.planner.v1');
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
  useLocation: false,   // GPS: walking times and "leave by" count from where you are
  startFrom: null,      // where each day starts (building id); null = conference default
  lunch: { on: true, from: 690, to: 810, length: 30, weight: 40 }, // protect a lunch break
  blocks: [],           // [{ id, day, start, end, label, building }] meetings, booth duty…
  custom: [],           // [{ id, title, day, start, end, building, room, note }] sessions missing from the catalog
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
    profile: null,      // quick-start answers and group choices (profile.js); null = never set
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
      state.known = sanitizeKnown(state.known);
      state.picks = sanitizePicks(state.picks);
      state.prefs = sanitizePrefs(state.prefs);
      state.profile = saved.profile ? sanitizeProfile(saved.profile) : null;
    }
  } catch (e) {
    console.warn('Could not read saved state', e);
  }
  cachedSettings = null;
  return state;
}

export function namespace() { return KEY === BASE_KEY ? '' : KEY.slice(BASE_KEY.length + 1); }

// A failed save (storage full, blocked or private mode) is reported to subscribers as
// 'save-error' so the page can say so; the next successful save reports 'save-ok'.
let saveFailed = false;
export function saveFailing() { return saveFailed; }

function writeNow() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    if (saveFailed) { saveFailed = false; for (const fn of listeners) fn('save-ok'); }
  } catch (e) {
    console.warn('Could not save state', e);
    saveFailed = true;
    for (const fn of listeners) fn('save-error');
  }
}

function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeNow, 150);
}

// Leaving or hiding the page (switching conference, the Reload button, locking the phone)
// can come within the save delay: write a pending change at once instead of losing it.
function flushPending() { if (saveTimer) writeNow(); }
if (typeof window !== 'undefined') window.addEventListener('pagehide', flushPending);
if (typeof document !== 'undefined' && document.addEventListener) {
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushPending(); });
}

// Another tab saved: adopt its state instead of overwriting it on our next save.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== KEY || e.newValue == null) return;
    clearTimeout(saveTimer);
    saveTimer = null;
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

// Settings are cleaned as they are saved, exactly as a reload would clean them.
export function updateSettings(patch) {
  state.prefs = sanitizePrefs(merge(state.prefs || {}, clone(patch)));
  cachedSettings = null;
  emit('settings');
}

// Replace one top-level setting outright (lists/objects where merging would keep stale keys).
export function setSetting(key, value) {
  state.prefs = sanitizePrefs({ ...(state.prefs || {}), [key]: clone(value) });
  cachedSettings = null;
  emit('settings');
}

// Restores planner tuning; keeps display choices, room overrides, blocks and lunch.
export function resetSettings() {
  const keep = ['preview', 'hideOnline', 'useLocation', 'repo', 'overrides', 'blocks', 'custom', 'lunch', 'startFrom'];
  state.prefs = Object.fromEntries(Object.entries(state.prefs).filter(([k]) => keep.includes(k)));
  cachedSettings = null;
  emit('settings');
}

export function setUI(patch) {
  Object.assign(state.ui, patch);
  persist();
}

// ---- preferences (profile.js)

export function profile() { return state.profile || blankProfile(); }

// Replaces the given top-level fields (lists are replaced, not merged).
export function updateProfile(patch) {
  state.profile = sanitizeProfile({ ...profile(), ...patch });
  emit('profile');
}

// value: 1 = want the whole group, -1 = hide it, 0 = no choice.
export function setProfileGroup(key, value) {
  const groups = { ...profile().groups };
  if (value === 1 || value === -1) groups[key] = value; else delete groups[key];
  updateProfile({ groups });
}

// The conference can ship starting preferences (data/<conf>/profile.json). They apply only
// on a device that has never saved any.
export function seedProfile(file) {
  if (state.profile || !file?.profile) return false;
  state.profile = sanitizeProfile(file.profile);
  emit('profile');
  return true;
}

export function setKnown(known) { state.known = known; emit('known'); }
export function setSeenBatch(at) { state.seenBatch = at; emit('seen'); }

// ---- validation (backups, share links and old saves are untrusted input)

const ID_RE = /^[\w.:-]{1,120}$/;
// `undatedAt` is the time given to a pick that doesn't say when it was made.
function sanitizePick(p, undatedAt = Date.now()) {
  if (!p || typeof p !== 'object') return null;
  const out = {
    p: [0, 1, 2, 3].includes(p.p) ? p.p : null,
    lock: typeof p.lock === 'string' && ID_RE.test(p.lock) ? p.lock : null,
    note: typeof p.note === 'string' ? p.note.slice(0, 4000) : '',
    at: Number.isFinite(p.at) ? p.at : undatedAt,
  };
  if (p.lockMode === 'preview' && out.lock) out.lockMode = 'preview';
  if (typeof p.reserved === 'string' && ID_RE.test(p.reserved)) out.reserved = p.reserved;
  if (Number.isFinite(p.score) && p.score >= 0 && p.score <= 100) out.score = Math.round(p.score * 10) / 10;
  if (p.mode === 'watch') out.mode = 'watch';
  if (typeof p.g === 'string' && ID_RE.test(p.g)) out.g = p.g;
  if (typeof p.code === 'string' && ID_RE.test(p.code)) out.code = p.code;
  return alive(out) ? out : null;
}

function sanitizePicks(picks, undatedAt) {
  const out = {};
  for (const [id, p] of Object.entries(picks || {})) {
    if (!ID_RE.test(id)) continue;
    const s = sanitizePick(p, undatedAt);
    if (s) out[id] = s;
  }
  return out;
}

function sanitizeKnown(known) {
  const out = {};
  for (const [inst, k] of Object.entries(known || {})) if (k && typeof k === 'object' && typeof k.inst === 'string') out[inst] = k;
  return out;
}

const num = (v, lo, hi) => (Number.isFinite(v) && v >= lo && v <= hi ? v : undefined);
// Tuning numbers are held at the nearest limit, so the value shown is the value kept.
const clamp = (v, lo, hi) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined);
function sanitizePrefs(src) {
  const d = DEFAULT_SETTINGS;
  const out = {};
  if (!src || typeof src !== 'object') return out;
  for (const k of ['buffer', 'tolerance', 'keynoteExtra']) if (clamp(src[k], 0, 240) !== undefined) out[k] = clamp(src[k], 0, 240);
  if (src.walk && typeof src.walk === 'object') {
    out.walk = {};
    for (const k of ['sameRoom', 'sameFloor', 'diffFloor', 'unknown']) if (clamp(src.walk[k], 0, 240) !== undefined) out.walk[k] = clamp(src.walk[k], 0, 240);
    if (src.walk.pairs && typeof src.walk.pairs === 'object') {
      out.walk.pairs = {};
      for (const [k, v] of Object.entries(src.walk.pairs)) {
        const [a, b] = k.split('|');
        if (validBuilding(a) && validBuilding(b) && clamp(v, 0, 240) !== undefined) out.walk.pairs[k] = clamp(v, 0, 240);
      }
    }
  }
  if (src.weights && typeof src.weights === 'object') {
    out.weights = {};
    for (const k of Object.keys(d.weights)) if (clamp(src.weights[k], 0, 5000) !== undefined) out.weights[k] = clamp(src.weights[k], 0, 5000);
  }
  if (src.overrides && typeof src.overrides === 'object') {
    out.overrides = {};
    for (const [label, b] of Object.entries(src.overrides)) if (label.length < 300 && (b === '' || validBuilding(b))) out.overrides[label] = b;
  }
  for (const k of ['preview', 'hideOnline', 'useLocation']) if (typeof src[k] === 'boolean') out[k] = src[k];
  if (validBuilding(src.startFrom)) out.startFrom = src.startFrom;
  // Only the lunch fields you changed are kept; the conference's own window fills the rest.
  if (src.lunch && typeof src.lunch === 'object') {
    const l = src.lunch;
    const lunch = {};
    if (typeof l.on === 'boolean') lunch.on = l.on;
    for (const [k, lo, hi] of [['from', 0, 1440], ['to', 0, 1440]]) if (num(l[k], lo, hi) !== undefined) lunch[k] = l[k];
    for (const [k, lo, hi] of [['length', 5, 240], ['weight', 0, 5000]]) if (clamp(l[k], lo, hi) !== undefined) lunch[k] = clamp(l[k], lo, hi);
    if (Object.keys(lunch).length) out.lunch = lunch;
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
  if (Array.isArray(src.custom)) {
    out.custom = src.custom
      .filter(c => c && typeof c.title === 'string' && c.title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(c.day)
        && num(c.start, 0, 1440) !== undefined && num(c.end, 0, 1440) !== undefined && c.end > c.start)
      .slice(0, 50).map((c, i) => ({
        id: typeof c.id === 'string' && /^[\w-]{1,40}$/.test(c.id) ? c.id : `c${i}`, title: c.title.trim().slice(0, 160), day: c.day, start: c.start, end: c.end,
        building: validBuilding(c.building) ? c.building : null, room: typeof c.room === 'string' ? c.room.slice(0, 120) : '',
        note: typeof c.note === 'string' ? c.note.slice(0, 1000) : '',
      }));
  }
  if (typeof src.repo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(src.repo)) out.repo = src.repo;
  return out;
}

// ---- moving picks between devices

export function exportData() {
  return { app: 'ignite26-planner', v: 1, conference: namespace() || 'ignite2026', exportedAt: new Date().toISOString(), picks: state.picks, settings: state.prefs, profile: profile() };
}

export function importData(obj, { replace = false } = {}) {
  if (!obj || obj.app !== 'ignite26-planner' || !obj.picks || typeof obj.picks !== 'object') throw new Error('Not an Ignite planner backup file');
  const incoming = sanitizePicks(obj.picks, 0); // undated backup picks are older than anything here
  // Checked before anything changes: a backup from another format must not empty the plan.
  if (Object.keys(obj.picks).length && !Object.keys(incoming).length) throw new Error('This backup has no picks this planner can read; nothing was changed');
  if (replace) state.picks = {};
  for (const [id, p] of Object.entries(incoming)) {
    const cur = state.picks[id];
    if (!cur || p.at > (cur.at || 0)) state.picks[id] = { ...p, note: p.note || cur?.note || '' };
  }
  if (obj.settings && replace) { state.prefs = sanitizePrefs(obj.settings); cachedSettings = null; }
  if (obj.profile && (replace || !state.profile)) state.profile = sanitizeProfile(obj.profile);
  emit(replace ? 'reset' : 'picks');
  return Object.keys(incoming).length;
}

// Compact share token per pick: CODE.p[sSCORE][w][!LOCKCODE | *LOCKCODE]
//   sN  your own score     w  watch the recording instead     !  locked run     *  locked in preview
// BRK101, BRK101-R1, Gartner's 11b / 33jES, re:Invent's DVT212-S, ANT319-R, INV002-S-R1
const CODE = '[A-Za-z0-9_]{1,24}(?:-[A-Z]\\d*){0,3}';
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
  state = { ...blank(), prefs: state.prefs, profile: state.profile, ui: { ...state.ui }, seenBatch: state.seenBatch };
  cachedSettings = null;
  emit('reset');
}
