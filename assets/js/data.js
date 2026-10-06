// Loads a conference's synced catalog and turns it into the in-memory model the views use.

import { fromISO, toISO, parseSlot, hash } from './time.js';

// ?data=<dir> loads a different snapshot directory (testing with past events). Only plain
// relative paths on this site are accepted.
export const DATA_OVERRIDE = (() => {
  const d = new URLSearchParams(location.search).get('data');
  return d && /^[\w-]+(\/[\w.-]+)*\/?$/.test(d) && !d.split('/').includes('..') ? d.replace(/\/$/, '') : null;
})();
export const CUSTOM_DATA = !!DATA_OVERRIDE;

async function getJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' }); // revalidates with ETag: cheap 304s
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json();
}

export async function fetchAll(dataDir) {
  const dir = DATA_OVERRIDE || dataDir;
  const [doc, meta, changes, favorites, profile] = await Promise.all([
    getJSON(`${dir}/sessions.json`),
    getJSON(`${dir}/meta.json`).catch(() => ({})),
    getJSON(`${dir}/changes.json`).catch(() => ({ batches: [] })),
    getJSON(`${dir}/favorites.json`).catch(() => null),
    getJSON(`${dir}/profile.json`).catch(() => null), // starting preferences (profile.js)
  ]);
  // The service worker can hand back a cached sessions.json next to a fresh meta/changes
  // (slow Wi-Fi). Flag it so the app refreshes once the newer copy has landed.
  const newest = [meta.lastChanged, changes.batches?.[0]?.at].filter(Boolean).sort().pop();
  const stale = !!(newest && doc.generatedAt && newest > doc.generatedAt);
  return { doc, meta, changes, favorites, profile, stale };
}

// Preview mode only: deterministic fake day/room so the planner can be rehearsed
// before a schedule is published. Never shown without a "Preview" label.
const PREVIEW_ROOMS = {
  moscone: [['Moscone West', 2], ['Moscone West', 3], ['Moscone West', 3], ['Moscone South', 1], ['Moscone South', 2], ['Marriott Marquis', 'B2']],
  'swan-dolphin': [['WDW Dolphin', 1], ['WDW Dolphin', 2], ['WDW Swan', 1], ["Disney's Yacht & Beach Resort", 1]],
};
// Session hours per day from the official Ignite agenda (minutes after midnight, PT).
const PREVIEW_HOURS = { '2026-11-17': [840, 1080], '2026-11-18': [510, 1035], '2026-11-19': [540, 1080], '2026-11-20': [540, 735] };

function previewTiming(rec, conf) {
  const h = hash(rec.id);
  const day = conf.days[h % conf.days.length];
  const [open, close] = PREVIEW_HOURS[day] || [540, 1080];
  const slot = parseSlot(rec.slot);
  const dur = Math.min(rec.dur || (slot ? slot.end - slot.start : 45), close - open);
  // The catalog's placeholder slot only seeds the position inside that day's session hours.
  const seed = slot ? slot.start : (h >>> 4) % 1440;
  let start = open + (seed % Math.max(1, close - open - dur));
  start = Math.round(start / 5) * 5;
  const rooms = PREVIEW_ROOMS[conf.venue.id] || PREVIEW_ROOMS.moscone;
  const [bName, floor] = rooms[(h >>> 8) % rooms.length];
  const room = `${bName}, Level ${floor}, Room ${floor}0${String((h >>> 12) % 24 + 1).padStart(2, '0')}`;
  return { day, startMin: start, endMin: start + dur, room };
}

// The model is built from catalog files that can be malformed; list fields are always arrays.
const list = v => (Array.isArray(v) ? v.filter(x => x != null && x !== '') : typeof v === 'string' && v ? [v] : []);

// A URL the Cache API accepts as a key (it rejects anything that isn't http(s)).
export function cacheUrl(name, base = location.href) {
  return new URL(`__planner-cache__/${encodeURIComponent(name)}`, base).href;
}

// A catalog copied from someone's export (conf.export; not a live or scheduled sync) is
// flagged once it is a day old. Returns null when it's fine, else { hours, days }.
export function exportAge(conf, generatedAt, now = new Date(), limitHours = 24) {
  if (!conf.export || !generatedAt) return null;
  const hours = (now.getTime() - new Date(generatedAt).getTime()) / 3600000;
  if (!(hours >= limitHours)) return null;
  return { hours: Math.floor(hours), days: Math.floor(hours / 24) };
}

// Sessions you added because they're missing from the catalog (Settings → custom) become
// catalog records of their own, marked `custom`.
export function customRecords(list, conf) {
  return (list || []).map(c => ({
    // The code comes from the id, never the list position: removing one added session must
    // not renumber the others (picks, links and change alerts key on it).
    id: `my-${c.id}`, inst: `my-${c.id}`, code: `MY-${c.id}`, group: `my-${c.id}`, custom: true,
    title: c.title, desc: c.note || 'Added by you: not in the catalog.', type: 'Added by you',
    start: toISO(c.day, c.start, conf.tz), end: toISO(c.day, c.end, conf.tz), dur: c.end - c.start,
    room: c.room || '', building: c.building, delivery: ['In-person'], recorded: false, speakers: [], topics: [], tags: [], audience: [],
  }));
}

// The catalog session an added one turned into after a fresh export: same day, same title
// give or take wording ("&" vs "and", punctuation).
const words = t => new Set(String(t || '').toLowerCase().replace(/&/g, ' and ').split(/[^a-z0-9]+/).filter(w => w.length > 1));
export function catalogMatch(custom, model) {
  const want = words(custom.title);
  if (!want.size) return null;
  let best = null;
  for (const s of model.sessions) {
    if (s.custom || s.day !== custom.day) continue;
    const have = words(s.title);
    const shared = [...want].filter(w => have.has(w)).length;
    const score = shared / Math.max(want.size, have.size);
    if (score >= 0.8 && (!best || score > best.score)) best = { score, s };
  }
  return best ? best.s : null;
}

// rsvp: { type -> opensAt } for conferences where the session type decides (Ignite);
// catalogs can also mark single sessions with rec.rsvp (Gartner's seat reservations).
export function buildModel(doc, settings, rsvp, conf, venue) {
  const overrides = settings.overrides || {};
  const tz = conf.tz;
  const sessions = [];
  const byId = new Map();
  const byKey = new Map();
  const byCode = new Map();
  const byGroup = new Map();
  const facets = { topics: new Map(), types: new Map(), levels: new Map(), audience: new Map(), tags: new Map() };
  const bump = (m, k) => k != null && k !== '' && m.set(k, (m.get(k) || 0) + 1);
  let official = 0;
  // Preview only runs while nothing official exists, so simulated times can never mix
  // with a real (even partially published) schedule.
  const anyOfficial = (Array.isArray(doc.sessions) ? doc.sessions : []).some(r => r?.start && r.dur !== 0 && !r.custom);
  const preview = settings.preview && !anyOfficial;

  for (const rec of Array.isArray(doc.sessions) ? doc.sessions : []) {
    if (!rec || typeof rec !== 'object' || !rec.id) continue;
    const s = { ...rec, key: rec.inst || rec.id };
    for (const k of ['topics', 'tags', 'audience', 'delivery', 'vendors']) s[k] = list(rec[k]);
    s.speakers = Array.isArray(rec.speakers) ? rec.speakers.filter(Array.isArray) : [];
    s.code = typeof rec.code === 'string' && rec.code ? rec.code : String(rec.id);
    s.title = typeof rec.title === 'string' ? rec.title : '';
    s.desc = typeof rec.desc === 'string' ? rec.desc : '';
    s.inPerson = s.delivery.some(d => /^in[- ]?person$/i.test(d));
    s.onlineOnly = !s.inPerson && s.delivery.length > 0;
    if (rec.rsvp === true) s.rsvp = rec.rsvpOpens || true;
    else s.rsvp = s.inPerson && rsvp && rsvp[rec.type] !== undefined ? (rsvp[rec.type] || true) : null;
    let room = rec.room;
    const st = fromISO(rec.start, tz);
    if (st && rec.dur !== 0) {
      const en = fromISO(rec.end, tz);
      s.day = st.day;
      s.startMin = st.min;
      s.endMin = en ? en.min + (en.day !== st.day ? 1440 : 0) : st.min + (rec.dur || 45);
      if (!(s.endMin > s.startMin)) s.endMin = st.min + (rec.dur > 0 ? rec.dur : 45); // end before start: trust the duration
      s.timeSource = rec.custom ? 'custom' : 'official';
      if (!rec.custom) official++;
    } else if (preview && s.inPerson && rec.dur !== 0) {
      const p = previewTiming(rec, conf);
      Object.assign(s, { day: p.day, startMin: p.startMin, endMin: p.endMin, timeSource: 'preview' });
      if (rec.roomTbd) room = p.room;
    } else {
      s.day = null; s.startMin = null; s.endMin = null; s.timeSource = null;
    }
    s.loc = s.onlineOnly ? { label: 'Online', building: 'O', floor: null, known: true }
      : rec.custom && rec.building ? { label: room || '', building: rec.building, floor: null, known: true }
      : venue.parseLocation(room, overrides);
    s.roomLabel = s.onlineOnly ? 'Online' : (rec.roomTbd && s.timeSource !== 'preview' ? 'Room TBA' : room);
    s.hay = [s.code, s.title, s.desc, s.speakers.map(p => `${p[0] ?? ''} ${p[1] ?? ''}`).join(' '),
      s.tags.join(' '), s.topics.join(' '), rec.type].join(' \u0001 ').toLowerCase();
    sessions.push(s);
    byKey.set(s.key, s);
    if (!byId.has(s.id)) byId.set(s.id, []);
    byId.get(s.id).push(s);
    if (!byCode.has(s.code)) byCode.set(s.code, s);
    s.group = rec.group || s.code;
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
    s.topics.forEach(t => bump(facets.topics, t));
    s.tags.forEach(t => bump(facets.tags, t));
    s.audience.forEach(t => bump(facets.audience, t));
    bump(facets.types, rec.type);
    bump(facets.levels, rec.level);
  }
  const days = [...new Set(sessions.filter(s => s.day).map(s => s.day))].sort();
  const locations = [...new Set(sessions.filter(s => s.room && !s.roomTbd && !s.onlineOnly).map(s => s.room))].sort();
  return {
    sessions, byId, byKey, byCode, byGroup, facets, days, locations,
    officialCount: official,
    hasOfficial: official > 0,
    mode: official > 0 ? 'official' : preview ? 'preview' : 'unscheduled',
  };
}

// The fields we watch on every run of the sessions you've picked, keyed by instance.
export function snapshot(s) {
  return { inst: s.key, g: s.group, code: s.code, title: s.title, start: s.start, end: s.end, room: s.roomTbd ? null : s.room };
}

// groups: repeat-group codes you've picked. Returns alerts for runs that moved, were
// retitled or disappeared since you last acknowledged, plus the new snapshot.
export function diffKnown(model, groups, knownIn) {
  const known = Object.fromEntries(Object.entries(knownIn || {}).filter(([, k]) => k && typeof k === 'object'));
  const alerts = [];
  const next = {};
  for (const g of groups) for (const s of model.byGroup.get(g) || []) next[s.key] = snapshot(s);
  for (const [inst, cur] of Object.entries(next)) {
    const old = known[inst];
    if (!old) continue;
    const fields = {};
    for (const k of ['start', 'end', 'room', 'title', 'code']) if ((old[k] ?? null) !== (cur[k] ?? null)) fields[k] = [old[k] ?? null, cur[k] ?? null];
    if (Object.keys(fields).length) alerts.push({ kind: 'changed', inst, g: cur.g, code: cur.code, title: cur.title, fields });
  }
  // A group counts as tracked by its old key or by any run we already snapshotted, so a
  // renamed/regrouped session still reports new and cancelled runs.
  const knownGroups = new Set(Object.values(known).map(k => k.g));
  for (const [inst, cur] of Object.entries(next)) if (known[inst]) knownGroups.add(cur.g);
  for (const [inst, cur] of Object.entries(next)) {
    if (!known[inst] && knownGroups.has(cur.g)) alerts.push({ kind: 'run-added', inst, g: cur.g, code: cur.code, title: cur.title });
  }
  for (const [inst, old] of Object.entries(known)) {
    if (next[inst] || !groups.has(old.g)) continue;
    const left = model.byGroup.get(old.g) || [];
    alerts.push({ kind: left.length ? 'run-removed' : 'removed', inst, g: old.g, code: old.code, title: old.title, remaining: left.map(r => r.code) });
  }
  return { alerts, next };
}
