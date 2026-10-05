// Live check straight from the Ignite site. The official site falls back to a CDN copy of
// its catalog that allows cross-origin reads, so the app can see changes the moment they
// are published, without waiting for the scheduled sync.
//
// normalize() mirrors scripts/sync.py's normalize(); tests/test_sync.py cross-checks them.

const CDN = 'https://eventtools.event.microsoft.com/ignite2026-prod/fallback';
const DEFAULT_WINDOW = ['2026-11-17', '2026-11-20'];
const DELIVERY_NAMES = { inperson: 'In-person', online: 'Online', ondemand: 'On-demand' };
const PLACEHOLDER_ROOM = /^\s*(ztest\S*|tbd|tba|)\s*$/i;
const REPEAT_SUFFIX = /-R\d+$/i;
export const TRACKED = ['title', 'code', 'type', 'start', 'end', 'dur', 'room', 'speakers', 'level', 'delivery', 'recorded', 'desc'];

function vals(lst) {
  const out = [];
  for (const v of lst || []) {
    const s = v && typeof v === 'object' ? v.displayValue : v;
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}
const one = v => (v && typeof v === 'object' ? v.displayValue || '' : v || '');
const isoZ = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function parseIso(s) {
  if (!s || typeof s !== 'string') return null;
  const d = new Date(s.trim());
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
    const title = (s.title || '').trim();
    if (!s.sessionId || isTest(s, title)) { dropped.push(s.sessionCode || s.sessionId); continue; }
    let start = parseIso(s.startDateTime), end = parseIso(s.endDateTime);
    if (start && !(start.getTime() >= lo && start.getTime() < hi)) { draft++; start = end = null; }
    const slot = (s.TimeSlot || s.timeSlot || '').trim();
    const sm = slotMinutes(slot);
    let dur = s.durationInMinutes;
    if (!Number.isInteger(dur) || dur <= 0) {
      if (start && end) dur = Math.floor((end - start) / 60000);
      else dur = sm ? sm[2] : null;
    }
    if (start && !end && dur) end = new Date(start.getTime() + dur * 60000);
    // speakerNames is the complete list; speaker records add company/title when available.
    const known = new Map();
    for (const sid of s.speakerIds || []) {
      const p = spk.get(sid);
      if (p && p.displayName) known.set(p.displayName.trim(), [p.displayName.trim(), p.company || '', p.jobTitle || '']);
    }
    const names = (s.speakerNames || '').split(',').map(n => n.trim()).filter(Boolean);
    let speakers = names.map(n => known.get(n) || (speakerByName && speakerByName.get(n)) || [n, '', '']);
    if (!speakers.length) speakers = [...known.values()];
    const room = one(s.location).trim();
    const viewing = vals(s.viewingOptions).map(v => v.toLowerCase());
    let recorded = null;
    if (viewing.some(v => v.includes('not') && v.includes('record'))) recorded = false;
    else if (viewing.some(v => v.includes('record'))) recorded = true;
    const lv = vals(s.sessionLevel).map(v => /^\((\d+)\)/.exec(v)).find(Boolean);
    out.push({
      id: s.sessionId,
      inst: s.sessionInstanceId || s.sessionId,
      code: (s.sessionCode || '').trim(),
      title,
      desc: (s.description || '').trim(),
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
      related: (s.relatedSessionCodes || []).filter(c => typeof c === 'string'),
      _links: (s.repeatedSessions || []).filter(r => r && typeof r === 'object' && r.sessionCode).map(r => r.sessionCode),
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

const comparable = (rec, f) => (f === 'speakers' ? (rec.speakers || []).map(p => p[0]) : rec[f] ?? null);

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
  for (const [sid, recs] of cg) {
    const olds = pg.get(sid);
    if (!olds) { added.push(...recs.map(brief)); continue; }
    recs.forEach((r, i) => {
      if (i >= olds.length) { added.push({ ...brief(r), repeat: true }); return; }
      const f = {};
      for (const field of TRACKED) {
        const a = comparable(olds[i], field), b = comparable(r, field);
        if (JSON.stringify(a) !== JSON.stringify(b)) f[field] = field === 'desc' ? true : [a, b];
      }
      if (Object.keys(f).length) changed.push({ ...brief(r), f });
    });
    for (const o of olds.slice(recs.length)) removed.push({ ...brief(o), repeat: true });
  }
  for (const [sid, recs] of pg) if (!cg.has(sid)) removed.push(...recs.map(brief));
  return { added, removed, changed };
}

function stripVolatile(list) {
  return JSON.stringify(list.map(({ firstSeen, ...r }) => r));
}

async function getCdn(name, timeoutMs = 25000) {
  const bucket = Math.floor(Date.now() / 300000) * 300000; // same 5-minute bucketing as the official site
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${CDN}/${name}.json?${bucket}`, { signal: ctl.signal, cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// Compare the live catalog against the synced snapshot. Returns null if live is unreachable.
export async function checkLive(snapshotDoc) {
  const [raw, settings] = await Promise.all([getCdn('session-all-en-us'), getCdn('settings', 15000).catch(() => null)]);
  if (!Array.isArray(raw) || raw.length < 50) throw new Error('unexpected live catalog');
  const prev = snapshotDoc.sessions || [];
  const byName = new Map();
  for (const r of prev) for (const p of r.speakers || []) if (p[1] || p[2]) byName.set(p[0], p);
  const window = settings?.eventStartDate && settings?.eventEndDate
    ? [settings.eventStartDate.slice(0, 10), settings.eventEndDate.slice(0, 10)] : DEFAULT_WINDOW;
  const { sessions, dropped, draft } = normalize(raw, null, window, byName);
  if (prev.length && sessions.length < 0.6 * prev.length) throw new Error(`live catalog looks partial (${sessions.length} sessions)`);
  const seenInst = new Map(prev.map(r => [r.inst, r.firstSeen]));
  const seenId = new Map(prev.map(r => [r.id, r.firstSeen]));
  const now = isoZ(new Date());
  for (const r of sessions) {
    r.firstSeen = seenInst.has(r.inst) ? seenInst.get(r.inst) : seenId.has(r.id) ? seenId.get(r.id) : now;
  }
  // Speakers come from a separate feed; ignore company/title-only differences.
  const same = stripVolatile(prev.map(r => ({ ...r, speakers: (r.speakers || []).map(p => p[0]) })))
    === stripVolatile(sessions.map(r => ({ ...r, speakers: (r.speakers || []).map(p => p[0]) })));
  const flags = settings ? {
    showSessionTimeSlots: settings.sessionDetailsFlags?.showSessionTimeSlots ?? null,
    showLocations: settings.showLocations ?? null,
    showRoomsToAnonymousUsers: settings.showRoomsToAnonymousUsers ?? null,
    enableMySchedule: settings.enableMySchedule ?? null,
    rsvp: Object.fromEntries((settings.rsvpConfiguration || []).filter(r => r && r.sessionTypeName).map(r => [r.sessionTypeName, r.opensAt || null])),
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
    diff: same ? { added: [], removed: [], changed: [] } : diff(prev, sessions),
  };
}
