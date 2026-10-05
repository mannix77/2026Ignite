// User state: picks, settings, and what you've already seen. Lives in localStorage
// (per browser); export/import and share links move it between devices.

import { DEFAULT_PLANNER } from './planner.js';

const KEY = 'ignite26.planner.v1';

export const DEFAULT_SETTINGS = {
  buffer: DEFAULT_PLANNER.buffer,
  tolerance: DEFAULT_PLANNER.tolerance,
  walk: structuredCloneSafe(DEFAULT_PLANNER.walk),
  weights: structuredCloneSafe(DEFAULT_PLANNER.weights),
  overrides: {},        // location label -> building id
  preview: false,       // simulate days/rooms before the real schedule is published
  simNow: null,         // { day, min } to rehearse "Now" mode
  hideOnline: false,    // hide online-only sessions in Browse
  repo: 'mannix77/2026Ignite',
};

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}

function blank() {
  return {
    v: 1,
    picks: {},          // sessionId -> { p: 0-3, lock: instKey|null, note: '', at: epoch ms }
    prefs: {},          // only the settings the user changed; defaults fill the rest
    known: {},          // sessionId -> snapshot of fields we alert on
    seenBatch: null,    // timestamp of newest change batch already viewed
    ui: { tab: 'browse', filters: {}, day: null, triageIdx: 0 },
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

export function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw);
      delete saved.settings; // pre-release format stored every default; drop it
      state = merge(blank(), saved);
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

// Another tab (or the Home Screen app on the same origin) saved: adopt its state instead of
// overwriting it with ours on the next save.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== KEY || e.newValue == null) return;
    clearTimeout(saveTimer);
    load();
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
  return (cachedSettings ||= merge(structuredCloneSafe(DEFAULT_SETTINGS), structuredCloneSafe(state.prefs)));
}

export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(what) { persist(); for (const fn of listeners) fn(what); }

export function pick(id) { return state.picks[id] || null; }
export function priority(id) { return state.picks[id]?.p ?? null; }

export function setPriority(id, p) {
  const cur = state.picks[id];
  if (p == null) {
    delete state.picks[id];
  } else {
    state.picks[id] = { lock: null, note: '', ...cur, p, at: Date.now() };
    askPersistent();
    if (p === 0) state.picks[id].lock = null;
  }
  emit('picks');
}

export function setLock(id, instKey) {
  const cur = state.picks[id] || { p: 3, note: '' };
  state.picks[id] = { ...cur, p: cur.p > 0 ? cur.p : 3, lock: instKey, at: Date.now() };
  emit('picks');
}

export function setNote(id, note) {
  const cur = state.picks[id];
  if (!cur && !note) return;
  state.picks[id] = { p: null, lock: null, ...cur, note, at: Date.now() };
  emit('note');
}

export function updateSettings(patch) {
  state.prefs = merge(state.prefs || {}, structuredCloneSafe(patch));
  cachedSettings = null;
  emit('settings');
}

// Restores planner tuning; keeps display choices like preview and the simulated clock.
export function resetSettings() {
  const { preview, simNow, hideOnline, repo, overrides } = state.prefs;
  state.prefs = Object.fromEntries(Object.entries({ preview, simNow, hideOnline, repo, overrides }).filter(([, v]) => v !== undefined));
  cachedSettings = null;
  emit('settings');
}

export function setUI(patch) {
  Object.assign(state.ui, patch);
  persist();
}

export function setKnown(known) { state.known = known; emit('known'); }
export function setSeenBatch(at) { state.seenBatch = at; emit('seen'); }

// ---- moving picks between devices

export function exportData() {
  return { app: 'ignite26-planner', v: 1, exportedAt: new Date().toISOString(), picks: state.picks, settings: state.prefs };
}

export function importData(obj, { replace = false } = {}) {
  if (!obj || obj.app !== 'ignite26-planner' || typeof obj.picks !== 'object') throw new Error('Not an Ignite planner backup file');
  if (replace) state.picks = {};
  for (const [id, p] of Object.entries(obj.picks)) {
    const cur = state.picks[id];
    if (!cur || (p.at || 0) >= (cur.at || 0)) state.picks[id] = p;
  }
  if (obj.settings && replace) { state.prefs = structuredCloneSafe(obj.settings); cachedSettings = null; }
  emit('picks');
  return Object.keys(obj.picks).length;
}

// Compact share string: CODE.p[!] joined by '~' (codes are stable and short).
export function shareString(codeOf) {
  return Object.entries(state.picks)
    .filter(([, v]) => v.p != null)
    .map(([id, v]) => { const c = codeOf(id); return c ? `${c}.${v.p}${v.lock ? '!' : ''}` : null; })
    .filter(Boolean)
    .join('~');
}

export function parseShare(str, idOfCode, instOfCode) {
  const out = {};
  for (const tok of (str || '').split('~')) {
    const m = /^([A-Za-z]+\d+[A-Za-z]?)\.([0-3])(!?)$/.exec(tok.trim());
    if (!m) continue;
    const id = idOfCode(m[1]);
    if (!id) continue;
    out[id] = { p: Number(m[2]), lock: m[3] ? instOfCode(m[1]) : null, note: '', at: Date.now() };
  }
  return out;
}

export function applyShared(picks) {
  for (const [id, p] of Object.entries(picks)) state.picks[id] = { ...state.picks[id], ...p };
  emit('picks');
  return Object.keys(picks).length;
}

export function resetAll() {
  state = blank();
  cachedSettings = null;
  emit('reset');
}
