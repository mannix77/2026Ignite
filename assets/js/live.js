// Live check straight from the Ignite site. The official site falls back to a CDN copy of
// its catalog that allows cross-origin reads, so the app can see changes the moment they
// are published, without waiting for the scheduled sync.
//
// normalize() mirrors scripts/sync.py's normalize(); tests/test_sync.py cross-checks them.

const cdnBase = event => `https://eventtools.event.microsoft.com/${event}/fallback`;
const DEFAULT_EVENT = 'ignite2026-prod';
const DEFAULT_WINDOW = ['2026-11-17', '2026-11-20'];
const DELIVERY_NAMES = { inperson: 'In-person', online: 'Online', ondemand: 'On-demand' };
const MAX_DUR = 1440;
const PLACEHOLDER_ROOM = /^(ztest\S*|tbd|tba|)$/i;
const REPEAT_SUFFIX = /-R\d+$/i;
// Must match TRIM in scripts/sync.py.
const TRIM = /^[ \t\n\r\x0b\x0c\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[ \t\n\r\x0b\x0c\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$/g;
const text = v => (typeof v === 'string' ? v.replace(TRIM, '') : '');
export const TRACKED = ['title', 'code', 'type', 'start', 'end', 'dur', 'room', 'speakers', 'level', 'delivery', 'recorded', 'desc'];

// Accepts a list, a single value, or junk; keeps non-empty strings, deduped, order kept.
const listOf = v => (Array.isArray(v) ? v : v ? [v] : []);
function vals(lst) {
  const out = [];
  for (const v of listOf(lst)) {
    const s = v && typeof v === 'object' ? v.displayValue : v;
    if (typeof s === 'string' && s && !out.includes(s)) out.push(s);
  }
  return out;
}
function one(v) {
  if (Array.isArray(v)) v = v.length ? v[0] : '';
  if (v && typeof v === 'object') v = v.displayValue || '';
  return typeof v === 'string' ? v : '';
}
const isoZ = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

// Same accepted shapes as sync.py's parse_iso; a missing offset means UTC.
function parseIso(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?)(\.\d+)?([+-]\d{2}:?\d{2}|Z)?$/.exec(text(s));
  if (!m) return null;
  // Reject impossible values the way Python's strptime does (JS would roll Feb 30 or
  // 24:00 over into the next day).
  const [y, mo, day, h, mi, sec = 0] = m[1].split(/[-T:]/).map(Number);
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (y < 1 || !dim || day < 1 || day > dim || h > 23 || mi > 59 || sec > 59) return null;
  let off = m[3] || 'Z';
  if (off !== 'Z' && !off.includes(':')) off = `${off.slice(0, 3)}:${off.slice(3)}`;
  const d = new Date(`${m[1].length === 16 ? `${m[1]}:00` : m[1]}${off}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function slotMinutes(slot) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})\s*$/.exec(slot || '');
  if (!m) return null;
  const a = +m[1] * 60 + +m[2], b = +m[3] * 60 + +m[4];
  return [a, b, (((b - a) % 1440) + 1440) % 1440];
}

function windowBounds([first, last]) {
  const lo = Date.parse(`${first}T00:00:00Z`) - 86400000;
  const hi = Date.parse(`${last}T00:00:00Z`) + 2 * 86400000;
  return [lo, hi];
}

function isTest(s, title) {
  return ['test', 'testing', 'test session'].includes(title.toLowerCase()) || String(s.sessionTimeId || '').toLowerCase().endsWith('test');
}

// rawSpeakers: speaker records (optional). speakerByName: fallback [name, company, title] lookup.
export function normalize(rawSessions, rawSpeakers, window = DEFAULT_WINDOW, speakerByName = null) {
  const spk = new Map();
  for (const p of rawSpeakers || []) if (p && p.speakerId) spk.set(p.speakerId, p);
  const [lo, hi] = windowBounds(window);
  const out = [], dropped = [];
  let draft = 0;
  for (const s of rawSessions) {
    const title = text(s.title);
    const sid = s.sessionId == null || s.sessionId === '' ? '' : String(s.sessionId);
    if (!sid || isTest(s, title)) { dropped.push(text(s.sessionCode) || sid); continue; }
    let start = parseIso(s.startDateTime), end = parseIso(s.endDateTime);
    if (start && !(start.getTime() >= lo && start.getTime() < hi)) { draft++; start = end = null; }
    if (end && (!start || end < start)) end = null; // an end on its own, or before the start, is noise
    const slot = text(s.TimeSlot || s.timeSlot);
    const sm = slotMinutes(slot);
    let dur = s.durationInMinutes;
    if (!(Number.isInteger(dur) && dur > 0 && dur <= MAX_DUR)) {
      if (start && end) dur = Math.floor((end - start) / 60000);
      else dur = sm ? sm[2] : null;
    }
    if (start && !end && dur) end = new Date(start.getTime() + dur * 60000);
    // speakerNames is the complete list; speaker records add company/title when available.
    const known = new Map();
    for (const spkId of listOf(s.speakerIds)) {
      const p = typeof spkId === 'string' ? spk.get(spkId) : null;
      if (p && text(p.displayName)) known.set(text(p.displayName), [text(p.displayName), text(p.company), text(p.jobTitle)]);
    }
    const names = text(s.speakerNames).split(',').map(text).filter(Boolean);
    let speakers = names.map(n => known.get(n) || (speakerByName && speakerByName.get(n)) || [n, '', '']);
    if (!speakers.length) speakers = [...known.values()];
    const room = text(one(s.location));
    const viewing = vals(s.viewingOptions).map(v => v.toLowerCase());
    let recorded = null;
    if (viewing.some(v => v.includes('not') && v.includes('record'))) recorded = false;
    else if (viewing.some(v => v.includes('record'))) recorded = true;
    const lv = vals(s.sessionLevel).map(v => /\((\d{3})\)/.exec(v)).find(Boolean);
    out.push({
      id: sid,
      inst: text(String(s.sessionInstanceId ?? '')) || sid,
      code: text(s.sessionCode),
      title,
      desc: text(s.description),
      type: one(s.sessionType),
      level: lv ? Number(lv[1]) : null,
      topics: vals(s.topic),
      tags: vals(s.tags),
      audience: vals(s.audienceTypes),
      delivery: vals(s.deliveryTypes).map(v => DELIVERY_NAMES[v.toLowerCase().replace(/[^a-z]/g, '')] || v),
      recorded,
      speakers,
      start: start ? isoZ(start) : null,
      end: end ? isoZ(end) : null,
      slot: slot || null,
      dur,
      room: room || null,
      roomTbd: PLACEHOLDER_ROOM.test(room),
      popular: !!s.isPopular,
      related: listOf(s.relatedSessionCodes).filter(c => typeof c === 'string' && c),
      _links: listOf(s.repeatedSessions).filter(r => r && typeof r === 'object' && typeof r.sessionCode === 'string' && r.sessionCode).map(r => r.sessionCode),
    });
  }
  assignGroups(out);
  out.sort((a, b) => cmp(a.code, b.code) || cmp(a.inst, b.inst));
  return { sessions: out, dropped, draft };
}

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function assignGroups(recs) {
  const parent = new Map();
  const find = c => {
    if (!parent.has(c)) parent.set(c, c);
    while (parent.get(c) !== c) { parent.set(c, parent.get(parent.get(c))); c = parent.get(c); }
    return c;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra === rb) return;
    const [keep, drop] = [ra, rb].sort((x, y) => x.length - y.length || cmp(x, y));
    parent.set(drop, keep);
  };
  const firstCodeOfId = new Map();
  for (const r of recs) {
    const code = r.code || r.inst;
    union(code.replace(REPEAT_SUFFIX, '') || code, code);
    for (const link of r._links) union(code, link);
    delete r._links;
    if (firstCodeOfId.has(r.id)) union(firstCodeOfId.get(r.id), code);
    else firstCodeOfId.set(r.id, code);
  }
  const members = new Map();
  for (const r of recs) {
    r.group = find(r.code || r.inst);
    if (!members.has(r.group)) members.set(r.group, []);
    members.get(r.group).push(r.code);
  }
  for (const r of recs) r.repeats = [...new Set(members.get(r.group).filter(c => c !== r.code))].sort(cmp);
}

// Speakers compared as a set: reordering isn't a change.
const comparable = (rec, f) => (f === 'speakers' ? (rec.speakers || []).map(p => p[0]).sort(cmp) : rec[f] ?? null);

export function diff(prev, cur) {
  const group = lst => {
    const g = new Map();
    for (const r of lst) { if (!g.has(r.id)) g.set(r.id, []); g.get(r.id).push(r); }
    for (const v of g.values()) v.sort((a, b) => cmp(a.start || '', b.start || '') || cmp(a.inst, b.inst));
    return g;
  };
  const pg = group(prev), cg = group(cur);
  const added = [], removed = [], changed = [];
  const brief = r => ({ id: r.id, inst: r.inst, code: r.code, title: r.title });
  const compare = (o, r) => {
    const f = {};
    for (const field of TRACKED) {
      const a = comparable(o, field), b = comparable(r, field);
      if (JSON.stringify(a) !== JSON.stringify(b)) f[field] = field === 'desc' ? true : [a, b];
    }
    if (Object.keys(f).length) changed.push({ ...brief(r), f });
  };
  for (const [sid, recs] of cg) {
    const olds = pg.get(sid);
    if (!olds) { added.push(...recs.map(brief)); continue; }
    // Runs keep their instance id; pair leftovers by time only if ids were regenerated.
    const oldByInst = new Map(olds.map(o => [o.inst, o]));
    const leftNew = [];
    for (const r of recs) {
      const o = oldByInst.get(r.inst);
      if (o) { oldByInst.delete(r.inst); compare(o, r); } else leftNew.push(r);
    }
    const leftOld = olds.filter(o => oldByInst.has(o.inst));
    leftOld.forEach((o, i) => { if (i < leftNew.length) compare(o, leftNew[i]); });
    added.push(...leftNew.slice(leftOld.length).map(r => ({ ...brief(r), repeat: recs.length > 1 })));
    removed.push(...leftOld.slice(leftNew.length).map(o => ({ ...brief(o), repeat: olds.length > 1 })));
  }
  for (const [sid, recs] of pg) if (!cg.has(sid)) removed.push(...recs.map(brief));
  return { added, removed, changed };
}

async function getCdn(base, name, timeoutMs = 25000) {
  const bucket = Math.floor(Date.now() / 300000) * 300000; // same 5-minute bucketing as the official site
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/${name}.json?${bucket}`, { signal: ctl.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Compare the live catalog against the synced snapshot. Throws if live is unreachable.
// conf.cdn names the event folder on the CDN (conferences.js).
export async function checkLive(snapshotDoc, conf = {}) {
  const base = cdnBase(conf.cdn || DEFAULT_EVENT);
  const [raw, settings] = await Promise.all([getCdn(base, 'session-all-en-us'), getCdn(base, 'settings', 15000).catch(() => null)]);
  if (!Array.isArray(raw) || raw.length < 50) throw new Error('unexpected live catalog');
  const prev = snapshotDoc.sessions || [];
  const byName = new Map();
  for (const r of prev) for (const p of r.speakers || []) if (p[1] || p[2]) byName.set(p[0], p);
  const window = typeof settings?.eventStartDate === 'string' && typeof settings?.eventEndDate === 'string' && settings.eventStartDate.length >= 10 && settings.eventEndDate.length >= 10
    ? [settings.eventStartDate.slice(0, 10), settings.eventEndDate.slice(0, 10)] : (conf.days?.length ? [conf.days[0], conf.days[conf.days.length - 1]] : DEFAULT_WINDOW);
  const { sessions, dropped, draft } = normalize(raw, null, window, byName);
  if (prev.length && sessions.length < 0.6 * prev.length) throw new Error(`live catalog looks partial (${sessions.length} sessions)`);
  const seenInst = new Map(prev.map(r => [r.inst, r.firstSeen]));
  const seenId = new Map(prev.map(r => [r.id, r.firstSeen]));
  const now = isoZ(new Date());
  for (const r of sessions) {
    r.firstSeen = seenInst.has(r.inst) ? seenInst.get(r.inst) : seenId.has(r.id) ? seenId.get(r.id) : now;
  }
  // "Same" means nothing the app tracks or shows differs (speakers by name: companies come
  // from a separate feed). Untracked churn like isPopular doesn't count as a change.
  const d = diff(prev, sessions);
  const same = !d.added.length && !d.removed.length && !d.changed.length;
  const flags = settings ? {
    showSessionTimeSlots: settings.sessionDetailsFlags?.showSessionTimeSlots ?? null,
    showLocations: settings.showLocations ?? null,
    showRoomsToAnonymousUsers: settings.showRoomsToAnonymousUsers ?? null,
    enableMySchedule: settings.enableMySchedule ?? null,
    rsvp: Object.fromEntries(listOf(settings.rsvpConfiguration).filter(r => r && typeof r === 'object' && typeof r.sessionTypeName === 'string').map(r => [r.sessionTypeName, typeof r.opensAt === 'string' ? r.opensAt : null])),
  } : null;
  const stats = {
    sessions: sessions.length,
    withDates: sessions.filter(r => r.start).length,
    withRooms: sessions.filter(r => r.room && !r.roomTbd).length,
    draftTimes: draft,
  };
  return {
    at: now,
    same,
    flags,
    doc: { generatedAt: now, source: 'live', dropped, stats, sessions },
    diff: d,
  };
}
