// User state: picks, settings, and what you've already seen. Lives in localStorage
// (per browser / per Home Screen app, per conference); backups and share links move it
// between devices.

import { DEFAULT_PLANNER } from './planner.js';
import { nsKey, INSTANCE } from './instance.js';
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
  telemetry: false,     // send anonymous error reports to Honeycomb (issue #140); opt-in, device-only
  startFrom: null,      // where each day starts (building id); null = conference default
  lunch: { on: true, from: 690, to: 810, length: 30, weight: 40 }, // protect a lunch break
  blocks: [],           // [{ id, day, start, end, label, building }] meetings, booth duty…
  custom: [],           // [{ id, title, day, start, end, building, room, note }] sessions missing from the catalog
  repo: 'mannix77/2026Ignite',
};

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

// The saved-state version this code understands. Data saved with a higher one came from a newer
// copy of the planner (an updated tab): load it, but never write over it.
const SCHEMA_VERSION = 1;
let newer = false;
export function newerVersion() { return newer; }

function blank() {
  return {
    v: SCHEMA_VERSION,
    picks: {},          // sessionId -> { p, lock, lockMode, reserved, score, mode, note, g, code, at }
    prefs: {},          // only the settings the user changed; defaults fill the rest
    known: {},          // instKey -> snapshot of fields we alert on, for picked sessions
    seenBatch: null,    // timestamp of newest change batch already viewed
    profile: null,      // quick-start answers and group choices (profile.js); null = never set
    backup: { at: null, changes: 0, dismissed: null }, // last backup, pick edits since, reminder dismissal
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
// The picks as they were last read from or written to storage, in the shape another tab's save is
// read back in (sanitized): what an unsaved change is measured against when that save arrives (#75).
let savedPicks = {};
const canonical = p => JSON.stringify(sanitizePick(p, 0));
const snapshotPicks = () => { savedPicks = Object.fromEntries(Object.entries(state.picks).map(([id, p]) => [id, canonical(p)])); };
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
// Saved text that couldn't be read and couldn't yet be copied aside: it must not be
// overwritten until the copy succeeds (writeNow retries it before every save).
let unreadable = null;
// The saved text as this tab last read or wrote it: different text at save time means another tab
// saved in between and its storage event hasn't arrived yet (#75).
let lastText = null;

export function load(namespace = '') {
  KEY = namespace ? `${BASE_KEY}:${namespace}` : BASE_KEY;
  state = blank();
  unreadable = null;
  newer = false;
  lastText = null;
  try {
    const raw = lastText = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      newer = Number.isFinite(saved?.v) && saved.v > SCHEMA_VERSION;
      delete saved.settings; // pre-release format stored every default
      state = merge(blank(), saved);
      if (!state.ui || typeof state.ui !== 'object' || Array.isArray(state.ui)) state.ui = blank().ui; // startup reads ui.*
      state.known = sanitizeKnown(state.known); // also drops pre-release entries, which had no run id
      state.picks = sanitizePicks(state.picks);
      state.prefs = sanitizePrefs(state.prefs);
      state.profile = saved.profile ? sanitizeProfile(saved.profile) : null;
      state.backup = sanitizeBackup(saved.backup);
    }
  } catch (e) {
    // Unreadable (truncated or corrupt): keep a copy before the next save replaces it.
    console.warn('Could not read saved state; a copy is kept under', `${KEY}#unreadable`, e);
    let raw = null;
    try { raw = localStorage.getItem(KEY); if (raw) localStorage.setItem(`${KEY}#unreadable`, raw); } catch { unreadable = raw; }
  }
  cachedSettings = null;
  snapshotPicks();
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
  let raw = null, stored = null;
  try {
    // Another tab may have saved since this tab last read or wrote, its storage event still queued.
    raw = localStorage.getItem(KEY);
    stored = JSON.parse(raw || 'null');
    if (!newer) newer = Number.isFinite(stored?.v) && stored.v > SCHEMA_VERSION;
  } catch { /* unreadable saved text: handled by the existing copy-first path below */ }
  if (newer) { for (const fn of listeners) fn('newer-version'); return; } // reload to get the new code; don't strip what it wrote
  // Its picks would be overwritten: take them in first and put this tab's unsaved changes on top,
  // as its storage event will. The rest of this tab's state is saved as it is.
  if (raw != null && raw !== lastText && stored && typeof stored === 'object') {
    const unsaved = unsavedPicks();
    state.picks = sanitizePicks(stored.picks);
    reapply(unsaved);
  }
  try {
    if (unreadable != null) { localStorage.setItem(`${KEY}#unreadable`, unreadable); unreadable = null; } // copy first, or don't save
    const text = JSON.stringify(state);
    localStorage.setItem(KEY, text);
    lastText = text;
    snapshotPicks();
    if (saveFailed) { saveFailed = false; for (const fn of listeners) fn('save-ok'); }
  } catch (e) {
    console.warn('Could not save state', e);
    saveFailed = true;
    // A full quota is its own telemetry event (issue #140); anything else (blocked storage,
    // private mode) is reported as the general 'save-error'. Either way the save-error banner
    // in app.js reacts the same way, so this distinction costs that UI nothing.
    for (const fn of listeners) fn(e && e.name === 'QuotaExceededError' ? 'storage-full' : 'save-error');
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

// Pick ids may be names an object inherits ('constructor'): read the maps by own key only.
const own = (o, id) => (Object.hasOwn(o, id) ? o[id] : null);

// The picks this tab changed since its last save: id -> { mine (null = cleared here), base (canonical text) }.
function unsavedPicks() {
  const out = new Map();
  for (const id of new Set([...Object.keys(state.picks), ...Object.keys(savedPicks)])) {
    const mine = own(state.picks, id), base = own(savedPicks, id) ?? canonical(null);
    if (canonical(mine) !== base) out.set(id, { mine, base });
  }
  return out;
}

// After adopting another tab's save, put back what this tab changed and had not saved yet. A
// pick the other tab left alone takes this tab's change outright, even one with no new time
// (lockPicks releases a group's other locks without one). A pick both tabs changed goes to the
// newer (the same rule a merged backup uses), and a pick cleared here that the other tab changed
// keeps their version. Returns whether anything was put back.
function reapply(unsaved) {
  let changed = false;
  for (const [id, { mine, base }] of unsaved) {
    const theirs = own(state.picks, id);
    const untouched = canonical(theirs) === base;
    if (mine ? untouched || !theirs || (mine.at || 0) > (theirs.at || 0) : untouched && theirs) {
      if (mine) state.picks[id] = mine;
      else delete state.picks[id];
      changed = true;
    }
  }
  return changed;
}

// Another tab saved: adopt its state instead of overwriting it, and keep this tab's own
// unsaved pick changes on top of it rather than dropping them.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== KEY || e.newValue == null) return;
    const unsaved = unsavedPicks();   // pending, or failed to save (storage full); empty when all saved
    clearTimeout(saveTimer);
    saveTimer = null;
    load(namespace());
    if (reapply(unsaved)) persist();
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
  state.backup.changes++;
  for (const [id, p] of Object.entries(state.picks)) {
    if (!alive(p)) delete state.picks[id];
    // Saved without a time, it would be dated by every tab that loads it (sanitizePick) and look
    // changed to this one when that tab saves it back: date it now, as a reload would (#75).
    else if (!Number.isFinite(p.at)) p.at = Date.now();
  }
  if (Object.values(state.picks).some(p => p.p > 0)) askPersistent();
  emit('picks');
}

// One note per repeat group: it lives on `holder`; the other records' notes are cleared.
// `at` means "when the rating last changed" (groupPick.js reads it to pick the newest record,
// and a backup merge reads it to decide which side wins, #28), so a note-only edit must not
// bump it: that would make an untouched record look newer and flip the group's rating, or make
// a stale local note outrank a backup made after the actual rating (issue #76). A holder with
// no record yet is a genuinely new one, so it gets `at: Date.now()` same as any other new pick.
export function setGroupNote(ids, holder, note, meta = {}) {
  if (!state.picks[holder] && !note) return;
  for (const id of ids) if (id !== holder && state.picks[id]) state.picks[id].note = '';
  const cur = state.picks[holder];
  state.picks[holder] = { p: null, lock: null, at: Date.now(), ...meta, ...cur, note };
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
  const keep = ['preview', 'hideOnline', 'useLocation', 'telemetry', 'repo', 'overrides', 'blocks', 'custom', 'lunch', 'startFrom'];
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

// ---- backups (health.js decides when to remind)

export function backupState() { return state.backup; }
export function markBackup(at = Date.now()) {
  state.backup = { at, changes: 0, dismissed: null };
  emit('backup');
}
export function dismissBackupReminder(at = Date.now(), day = null) {
  state.backup.dismissed = { at, changes: state.backup.changes, ...(day ? { day } : {}) };
  emit('backup');
}

function sanitizeBackup(b) {
  const out = { at: null, changes: 0, dismissed: null };
  if (!b || typeof b !== 'object') return out;
  if (Number.isFinite(b.at) && b.at > 0) out.at = b.at;
  if (Number.isInteger(b.changes) && b.changes >= 0) out.changes = Math.min(b.changes, 100000);
  if (b.dismissed && Number.isFinite(b.dismissed.at) && Number.isInteger(b.dismissed.changes)) {
    out.dismissed = { at: b.dismissed.at, changes: b.dismissed.changes };
    if (typeof b.dismissed.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.dismissed.day)) out.dismissed.day = b.dismissed.day;
  }
  return out;
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
  // Each snapshot is saved under its own run id, so a blank or different id is not a real entry.
  for (const [inst, k] of Object.entries(known || {})) if (k && typeof k === 'object' && k.inst === inst && inst) out[inst] = k;
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
  for (const k of ['preview', 'hideOnline', 'useLocation', 'telemetry']) if (typeof src[k] === 'boolean') out[k] = src[k];
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
      .filter(b => b && typeof b.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.day) && num(b.start, 0, 1440) !== undefined && num(b.end, 0, 1440) !== undefined && b.end > b.start)
      .slice(0, 50).map((b, i) => ({
        id: typeof b.id === 'string' && ID_RE.test(b.id) ? b.id : `b${i}`, day: b.day, start: b.start, end: b.end,
        label: typeof b.label === 'string' ? b.label.slice(0, 80) : 'Busy',
        building: validBuilding(b.building) ? b.building : null,
      }));
  }
  if (Array.isArray(src.custom)) {
    out.custom = src.custom
      .filter(c => c && typeof c.title === 'string' && c.title.trim() && typeof c.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c.day)
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
  return { app: 'ignite26-planner', v: 1, conference: namespace() || 'ignite2026', exportedAt: new Date().toISOString(), picks: state.picks, settings: state.prefs, profile: state.profile }; // null: never set
}

// What a backup does to the picks here: one rule, used by both the preview and the import,
// so what you're shown is what happens. Adding keeps the newer rating per session, and keeps
// this device's note and reserved seat when the backup has none.
function planImport(obj, replace) {
  return planImportInto(obj, replace, state.picks);
}

// The merge rule for a backup's picks against a base (the live picks, or another conference's
// saved ones): newest `at` wins, an undated backup pick never beats a dated local one, and this
// device's notes and reserved seats are kept when adding.
function planImportInto(obj, replace, base) {
  if (!obj || obj.app !== 'ignite26-planner' || !obj.picks || typeof obj.picks !== 'object' || Array.isArray(obj.picks)) throw new Error('Not an Ignite planner backup file');
  const incoming = sanitizePicks(obj.picks, 0); // undated backup picks are older than anything here
  // Checked before anything changes: a backup from another format must not empty the plan.
  if (Object.keys(obj.picks).length && !Object.keys(incoming).length) throw new Error('This backup has no picks this planner can read; nothing was changed');
  const next = replace ? {} : { ...base };
  let applied = 0;
  const scope = replace ? null : Object.keys(incoming); // merging only touches the backup's sessions
  for (const [id, p] of Object.entries(incoming)) {
    const cur = replace ? null : own(base, id);
    if (cur && !(p.at > (cur.at || 0))) continue;
    const keep = cur?.reserved && !p.reserved ? { reserved: cur.reserved, lock: cur.lock || cur.reserved } : {};
    next[id] = { ...p, note: p.note || cur?.note || '', ...keep };
    if (keep.reserved) delete next[id].lockMode; // a pinned seat is never a preview lock
    applied++;
  }
  return { next, applied, scope };
}

// The fields a person can see; two picks that agree on these are the same pick.
const SHOWN = ['p', 'score', 'mode', 'lock', 'reserved', 'note'];
// scope: the sessions the import mentions (null = all of them, for a replace).
function diffPicks(before, after, scope = null) {
  const out = { added: [], changed: [], unchanged: 0, removed: [], after: {} }; // after: new picks' ratings
  for (const id of scope || Object.keys(after)) {
    const a = own(after, id), b = own(before, id);
    if (!a) continue;
    if (!b) { out.added.push(id); out.after[id] = a.p ?? null; }
    else if (SHOWN.some(k => (a[k] ?? null) !== (b[k] ?? null))) out.changed.push({ id, from: b.p ?? null, to: a.p ?? null });
    else out.unchanged++;
  }
  for (const id of Object.keys(before)) if (!Object.hasOwn(after, id)) out.removed.push(id);
  return out;
}

// What restoring this backup would change, without changing anything.
export function previewImport(obj, { replace = false } = {}) {
  const { next, scope } = planImport(obj, replace);
  return diffPicks(state.picks, next, scope);
}

export function importData(obj, { replace = false } = {}) {
  const { next, applied } = planImport(obj, replace);
  state.picks = next;
  if (obj.settings && replace) { state.prefs = sanitizePrefs(obj.settings); cachedSettings = null; }
  // Replacing restores the backup's preferences, including "never set" (null); merging only fills in.
  if (replace && 'profile' in obj) state.profile = obj.profile ? sanitizeProfile(obj.profile) : null;
  else if (obj.profile && !state.profile) state.profile = sanitizeProfile(obj.profile);
  emit(replace ? 'reset' : 'picks');
  return applied;
}

// ---- one backup file for every conference on this device (specs/features/one-backup-for-all.feature)
//
// Each conference's state lives under its own key (keyFor). The live conference is the store's
// current namespace and changes in place; the others are read from and written to their saved
// state directly, without switching what the app shows. `confs` is [{ id, namespace }] from
// conferences.js. Every key carries the instance suffix (nsKey), so a colleague's copy backs up
// and restores only its own data; the file records which copy made it.

const keyFor = ns => (ns ? `${BASE_KEY}:${ns}` : BASE_KEY);

// Another conference's saved state, sanitized the same way load() does: { status, saved, raw }.
// status 'none' (nothing saved), 'ok', 'unreadable' (raw is kept so it can be copied aside first,
// as load() does) or 'newer' (a newer version wrote it: never read through or written over here).
function readSavedState(ns) {
  let raw = null;
  try { raw = localStorage.getItem(keyFor(ns)); } catch { return { status: 'unreadable', saved: null, raw: null }; }
  if (!raw) return { status: 'none', saved: null, raw };
  try {
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return { status: 'unreadable', saved: null, raw };
    if (Number.isFinite(saved.v) && saved.v > SCHEMA_VERSION) return { status: 'newer', saved: null, raw };
    return { status: 'ok', raw, saved: { ...saved, picks: sanitizePicks(saved.picks), prefs: sanitizePrefs(saved.prefs), profile: saved.profile ? sanitizeProfile(saved.profile) : null } };
  } catch { return { status: 'unreadable', saved: null, raw }; }
}

function partOf(saved) {
  return saved ? { picks: saved.picks, settings: saved.prefs, profile: saved.profile } : null;
}

const hasContent = part => !!part && (Object.keys(part.picks || {}).length > 0 || Object.keys(part.settings || {}).length > 0 || !!part.profile);

// report (optional) gets skipped: [{ id, reason: 'unreadable' | 'newer' }], conferences whose saved
// data is there but can't go in the file.
export function exportAll(confs, now = new Date(), report = null) {
  const conferences = {}, skipped = [];
  for (const c of confs) {
    let part;
    if (c.namespace === namespace()) part = { picks: state.picks, settings: state.prefs, profile: state.profile };
    else {
      const r = readSavedState(c.namespace);
      if (r.status === 'unreadable' || r.status === 'newer') { skipped.push({ id: c.id, reason: r.status }); continue; }
      part = partOf(r.saved);
    }
    if (hasContent(part)) conferences[c.id] = part;
  }
  if (report) report.skipped = skipped;
  return { app: 'ignite26-planner', v: 1, kind: 'all', instance: INSTANCE, exportedAt: now.toISOString(), conferences };
}

export function isAllBackup(doc) {
  return !!doc && doc.app === 'ignite26-planner' && doc.kind === 'all' && !!doc.conferences && typeof doc.conferences === 'object' && !Array.isArray(doc.conferences);
}

// The file's conferences this planner knows, each checked by the same rule a restore applies:
// `missing` lists the ones it doesn't know, `invalid` the ones whose part can't be read (skipped
// and named, so one damaged conference never stops the rest).
function allParts(doc, confs) {
  if (!isAllBackup(doc)) throw new Error('Not an Ignite planner backup file');
  const known = new Map(confs.map(c => [c.id, c]));
  const parts = [], missing = [], invalid = [];
  for (const [id, part] of Object.entries(doc.conferences)) {
    if (!known.has(id)) { missing.push(id); continue; }
    const obj = part && typeof part === 'object' && !Array.isArray(part) ? { ...part, app: 'ignite26-planner' } : null;
    try { planImportInto(obj, false, {}); } catch { invalid.push(id); continue; }
    parts.push({ conf: known.get(id), obj });
  }
  return { parts, missing, invalid };
}

// After saving a backup file: every conference it holds counts as backed up. The others' saved
// state is updated in place; one that can't be read or was written by a newer version is left alone.
export function markBackupFor(confs, ids, at = Date.now()) {
  for (const c of confs) {
    if (!ids.includes(c.id)) continue;
    if (c.namespace === namespace()) { markBackup(at); continue; }
    const r = readSavedState(c.namespace);
    if (r.status !== 'ok') continue;
    try { localStorage.setItem(keyFor(c.namespace), JSON.stringify({ ...r.saved, backup: { at, changes: 0, dismissed: null } })); } catch { /* the reminder stays; nothing lost */ }
  }
}

// What restoring would change, per conference: the live one against the live picks, the others
// against their saved picks. `missing` lists conferences in the file this planner does not know;
// `blocked` those saved by a newer version (left alone); `unreadable` those whose saved data
// can't be read (kept aside as a copy before restoring).
export function previewImportAll(doc, confs, { replace = false } = {}) {
  const { parts, missing, invalid } = allParts(doc, confs);
  const out = {}, blocked = [], unreadable = [];
  for (const { conf, obj } of parts) {
    let base = state.picks;
    if (conf.namespace === namespace()) {
      if (newer) { blocked.push({ id: conf.id, reason: 'newer' }); continue; }   // this tab can't save over it
    } else {
      const r = readSavedState(conf.namespace);
      if (r.status === 'newer') { blocked.push({ id: conf.id, reason: 'newer' }); continue; }
      if (r.status === 'unreadable') unreadable.push(conf.id);
      base = r.saved?.picks || {};
    }
    const { next, scope } = planImportInto(obj, replace, base);
    out[conf.id] = diffPicks(base, next, scope);
  }
  return { parts: out, missing, invalid, blocked, unreadable };
}

// Restore every conference the file holds; returns picks applied per conference id. report
// (optional) gets failed: [{ id, reason }] for a conference left as it was: 'newer' (saved by a
// newer version), 'copy-failed' (unreadable data couldn't be kept aside first) or 'save-failed'.
export function importAllData(doc, confs, { replace = false } = {}, report = null) {
  const { parts, invalid } = allParts(doc, confs);
  const applied = {}, failed = invalid.map(id => ({ id, reason: 'invalid' }));
  if (report) report.failed = failed;
  for (const { conf, obj } of parts) {
    if (conf.namespace === namespace()) {
      if (newer) { failed.push({ id: conf.id, reason: 'newer' }); continue; }
      const n = importData(obj, { replace });
      flushPending();   // saved now, through the usual path, so the report says whether it was kept
      if (saveFailed) failed.push({ id: conf.id, reason: 'save-failed' });
      else applied[conf.id] = n;
      continue;
    }
    const r = readSavedState(conf.namespace);
    if (r.status === 'newer') { failed.push({ id: conf.id, reason: 'newer' }); continue; }
    if (r.status === 'unreadable') {
      // Keep a copy before replacing it, as load() does; no copy (or nothing we could read to copy), no restore.
      try {
        if (r.raw == null) throw new Error('unreadable');
        localStorage.setItem(`${keyFor(conf.namespace)}#unreadable`, r.raw);
      } catch { failed.push({ id: conf.id, reason: 'copy-failed' }); continue; }
    }
    const saved = r.saved || { ...blank() };
    const plan = planImportInto(obj, replace, saved.picks || {});
    saved.picks = plan.next;
    if (obj.settings && replace) saved.prefs = sanitizePrefs(obj.settings);
    if (replace && 'profile' in obj) saved.profile = obj.profile ? sanitizeProfile(obj.profile) : null;
    else if (obj.profile && !saved.profile) saved.profile = sanitizeProfile(obj.profile);
    saved.v = SCHEMA_VERSION;
    try { localStorage.setItem(keyFor(conf.namespace), JSON.stringify(saved)); } catch { failed.push({ id: conf.id, reason: 'save-failed' }); continue; }
    applied[conf.id] = plan.applied;
  }
  return applied;
}

// Compact share token per pick: CODE.p[sSCORE][w][!LOCKCODE | *LOCKCODE]
//   sN  your own score     w  watch the recording instead     !  locked run     *  locked in preview
// BRK101, BRK101-R1, Gartner's 11b / 33jES, re:Invent's DVT212-S, ANT319-R, INV002-S-R1
// A session added by the person has the code MY-<id>, its id being lowercase base 36 (app.js custom-add).
const CODE = '(?:MY-[a-z0-9]{1,16}|[A-Za-z0-9_]{1,24}(?:-[A-Z]\\d*){0,3})';
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

// report (optional) collects what was left out: { unknown: [codes not in the catalog], invalid: n }.
export function parseShare(str, idOfCode, instOfCode, report = null) {
  const out = {};
  if (report) { report.unknown = []; report.invalid = 0; }
  for (const tok of (str || '').split('~')) {
    if (!tok.trim()) continue;
    const m = TOKEN.exec(tok.trim());
    if (!m) { if (report) report.invalid++; continue; }
    const id = idOfCode(m[1]);
    if (!id) { report?.unknown.push(m[1]); continue; }
    const rec = { p: Number(m[2]), lock: m[6] ? instOfCode(m[6]) : null, code: m[1], at: Date.now() };
    if (m[3]) rec.score = Number(m[3]);
    if (m[4]) rec.mode = 'watch';
    if (rec.lock && m[5] === '*') rec.lockMode = 'preview';
    out[id] = rec;
  }
  return out;
}

// Merge shared ratings, scores and locks; never touch local notes or reserved seats.
// siblings (optional): record id -> the other saved records of the same repeat group. A link sets
// the session's choice across all its runs, so their locks give way, except a reserved seat.
function planShared(picks, siblings = {}) {
  const next = { ...state.picks };
  let n = 0;
  const scope = [];
  for (const [id, p] of Object.entries(picks)) {
    if (!ID_RE.test(id) || !p || typeof p !== 'object') continue;
    scope.push(id);
    const cur = state.picks[id] || { note: '' };
    const lock = cur.reserved ? (cur.lock || cur.reserved) : (p.lock || null);
    // Beside a reserved seat the kept lock keeps its own marker (a preview choice stays one);
    // the reserved run itself is never a preview lock.
    const lockMode = !lock ? undefined : cur.reserved ? (lock !== cur.reserved ? cur.lockMode : undefined) : p.lockMode;
    const s = sanitizePick({
      ...cur, p: p.p, lock, lockMode,
      score: p.score, mode: p.mode, code: p.code || cur.code, at: p.at,
    });
    if (s) { next[id] = s; n++; }
    for (const sib of Array.isArray(siblings[id]) ? siblings[id] : []) {
      const other = next[sib];
      // A run the link itself carries keeps what the link says for it, in any order.
      if (sib === id || Object.hasOwn(picks, sib) || !other || !other.lock || other.reserved) continue;
      next[sib] = { ...other, lock: null };
      delete next[sib].lockMode;
      if (!scope.includes(sib)) scope.push(sib);
    }
  }
  return { next, n, scope };
}

// What applying a picks link would change, without changing anything.
export function previewShared(picks, siblings) {
  const { next, scope } = planShared(picks, siblings);
  return diffPicks(state.picks, next, scope);
}

export function applyShared(picks, siblings) {
  const { next, n } = planShared(picks, siblings);
  state.picks = next;
  emit('picks');
  return n;
}

// Erase ratings, locks, notes and change tracking. Settings, display choices and the
// "already seen" marker for the change history stay.
export function resetAll() {
  // The last backup held the erased picks, so it no longer covers what comes next.
  state = { ...blank(), prefs: state.prefs, profile: state.profile, ui: { ...state.ui }, seenBatch: state.seenBatch };
  cachedSettings = null;
  emit('reset');
}
