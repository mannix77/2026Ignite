// Loads the synced catalog and turns it into the in-memory model the views use.

import { fromISO, parseSlot, hash } from './time.js';
import { parseLocation } from './venue.js';

export const EVENT = {
  name: 'Microsoft Ignite 2026',
  days: ['2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20'],
  // The site resolves both the instance id (canonical) and the session code.
  sessionUrl: s => `https://ignite.microsoft.com/en-US/sessions/${encodeURIComponent(s.inst || s.code)}`,
  // Session types that need an RSVP, and when RSVPs open (site settings; used if the live value is missing).
  rsvp: { 'Lab': '2026-10-26T08:00:00+08:00', 'Lightning Talk': '2026-10-26T08:00:00+08:00', 'Table Talk': '2026-10-26T08:00:00+08:00', 'Invite Only': '2026-10-26T08:00:00+08:00' },
};

// ?data=<dir> loads a different snapshot directory (used for testing with past events).
const DATA_DIR = (() => {
  const d = new URLSearchParams(location.search).get('data');
  return d && /^[\w./-]+$/.test(d) && !d.includes('..') ? d.replace(/\/$/, '') : 'data';
})();

export const CUSTOM_DATA = DATA_DIR !== 'data';

async function getJSON(path) {
  path = path.replace(/^data\//, `${DATA_DIR}/`);
  const res = await fetch(`${path}?t=${Math.floor(Date.now() / 60000)}`, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function fetchAll() {
  const [doc, meta, changes] = await Promise.all([
    getJSON('data/sessions.json'),
    getJSON('data/meta.json').catch(() => ({})),
    getJSON('data/changes.json').catch(() => ({ batches: [] })),
  ]);
  return { doc, meta, changes };
}

// Preview mode only: deterministic fake day/room so the planner can be rehearsed
// before Microsoft publishes the real schedule. Never shown without a "Preview" label.
const PREVIEW_BUILDINGS = [
  ['Moscone West', 2], ['Moscone West', 3], ['Moscone West', 3],
  ['Moscone South', 1], ['Moscone South', 2], ['Marriott Marquis', 'B2'],
];

// Session hours per day from the official agenda (minutes after midnight, PT).
const PREVIEW_HOURS = { '2026-11-17': [840, 1080], '2026-11-18': [510, 1035], '2026-11-19': [540, 1080], '2026-11-20': [540, 735] };

function previewTiming(rec) {
  const h = hash(rec.id);
  const day = EVENT.days[h % EVENT.days.length];
  const [open, close] = PREVIEW_HOURS[day] || [540, 1080];
  const slot = parseSlot(rec.slot);
  const dur = Math.min(rec.dur || (slot ? slot.end - slot.start : 45), close - open);
  // The catalog's placeholder slot only seeds the position inside that day's session hours.
  const seed = slot ? slot.start : (h >>> 4) % 1440;
  let start = open + (seed % Math.max(1, close - open - dur));
  start = Math.round(start / 5) * 5;
  const [bName, floor] = PREVIEW_BUILDINGS[(h >>> 8) % PREVIEW_BUILDINGS.length];
  const room = `${bName}, Level ${floor}, Room ${floor}0${String((h >>> 12) % 24 + 1).padStart(2, '0')}`;
  return { day, startMin: start, endMin: start + dur, room };
}

export function buildModel(doc, settings, rsvp = EVENT.rsvp) {
  const overrides = settings.overrides || {};
  const sessions = [];
  const byId = new Map();
  const byKey = new Map();
  const byCode = new Map();
  const byGroup = new Map();
  const facets = { topics: new Map(), types: new Map(), levels: new Map(), audience: new Map(), tags: new Map() };
  const bump = (m, k) => k != null && k !== '' && m.set(k, (m.get(k) || 0) + 1);
  let official = 0;

  for (const rec of doc.sessions || []) {
    const s = { ...rec, key: rec.inst };
    s.inPerson = (rec.delivery || []).some(d => /^in[- ]?person$/i.test(d));
    s.rsvp = s.inPerson && rsvp && rsvp[rec.type] !== undefined ? (rsvp[rec.type] || true) : null;
    s.onlineOnly = !s.inPerson && (rec.delivery || []).length > 0;
    let room = rec.room;
    const st = fromISO(rec.start);
    if (st && rec.dur !== 0) {
      const en = fromISO(rec.end);
      s.day = st.day;
      s.startMin = st.min;
      s.endMin = en ? en.min + (en.day !== st.day ? 1440 : 0) : st.min + (rec.dur || 45);
      s.timeSource = 'official';
      official++;
    } else if (settings.preview && s.inPerson && rec.dur !== 0) {
      const p = previewTiming(rec);
      Object.assign(s, { day: p.day, startMin: p.startMin, endMin: p.endMin, timeSource: 'preview' });
      if (rec.roomTbd) room = p.room;
    } else {
      s.day = null; s.startMin = null; s.endMin = null; s.timeSource = null;
    }
    s.loc = s.onlineOnly ? { label: 'Online', building: 'O', floor: null, known: true } : parseLocation(room, overrides);
    s.roomLabel = s.onlineOnly ? 'Online' : (rec.roomTbd && s.timeSource !== 'preview' ? 'Room TBA' : room);
    s.hay = [rec.code, rec.title, rec.desc, (rec.speakers || []).map(p => `${p[0]} ${p[1]}`).join(' '),
      (rec.tags || []).join(' '), (rec.topics || []).join(' '), rec.type].join(' \u0001 ').toLowerCase();
    sessions.push(s);
    byKey.set(s.key, s);
    if (!byId.has(s.id)) byId.set(s.id, []);
    byId.get(s.id).push(s);
    if (!byCode.has(s.code)) byCode.set(s.code, s);
    s.group = rec.group || rec.code;
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
    (rec.topics || []).forEach(t => bump(facets.topics, t));
    (rec.tags || []).forEach(t => bump(facets.tags, t));
    (rec.audience || []).forEach(t => bump(facets.audience, t));
    bump(facets.types, rec.type);
    bump(facets.levels, rec.level);
  }
  const days = [...new Set(sessions.filter(s => s.day).map(s => s.day))].sort();
  const locations = [...new Set(sessions.filter(s => s.room && !s.roomTbd && !s.onlineOnly).map(s => s.room))].sort();
  return {
    sessions, byId, byKey, byCode, byGroup, facets, days, locations,
    officialCount: official,
    hasOfficial: official > 0,
    mode: official > 0 ? 'official' : settings.preview ? 'preview' : 'unscheduled',
  };
}

// The fields we watch on sessions you've picked, so we can tell you what moved.
export function snapshot(s) {
  return { title: s.title, code: s.code, start: s.start, end: s.end, room: s.roomTbd ? null : s.room };
}

export function diffKnown(model, picks, known) {
  const alerts = [];
  const next = {};
  for (const [id, pick] of Object.entries(picks)) {
    if (!(pick.p > 0)) continue;
    const inst = model.byId.get(id);
    if (!inst) {
      if (known[id]) alerts.push({ id, kind: 'removed', title: known[id].title, code: known[id].code });
      continue;
    }
    const cur = snapshot(inst[0]);
    next[id] = cur;
    const old = known[id];
    if (!old) continue;
    const fields = {};
    for (const k of ['start', 'end', 'room', 'title', 'code']) if ((old[k] ?? null) !== (cur[k] ?? null)) fields[k] = [old[k] ?? null, cur[k] ?? null];
    if (Object.keys(fields).length) alerts.push({ id, kind: 'changed', title: cur.title, code: cur.code, fields });
  }
  return { alerts, next };
}
