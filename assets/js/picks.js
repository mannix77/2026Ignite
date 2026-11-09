// Pick resolution (specs/features/pick-resolution.feature). Ratings are saved per session
// record, but a session can have several runs (repeat records or shared ids), be renamed, or
// be cancelled. Every record is resolved to its repeat group, and every view reads one
// effective pick per group: the newest rating wins; the lock and reservation come from the
// record that holds them; a lock made in preview does not count once the schedule is official.
// Pure: the model and the picks come in as arguments, writes take the picks object and a clock,
// so app.js stays the DOM controller and all of this can be tested.

const REPEAT_SUFFIX = /-R\d+$/i;

// The repeat group a saved record belongs to: by its session id, then the group it remembers,
// then its code (a renamed session keeps its code; a code with a repeat suffix falls back to
// the base code). null when the session has left the catalog under every name it had.
export function resolveGroup(model, id, pk) {
  const s = model.byId.get(id)?.[0];
  if (s) return s.group;
  if (pk.g && model.byGroup.has(pk.g)) return pk.g;
  if (pk.code) {
    const byCode = model.byCode.get(pk.code);
    if (byCode) return byCode.group;
    const base = pk.code.replace(REPEAT_SUFFIX, '');
    if (model.byGroup.has(base)) return base;
  }
  return null;
}

// All saved records by repeat group, plus the orphans (records of cancelled sessions).
export function indexPicks(model, picks) {
  const byGroup = new Map();
  const orphans = [];
  for (const [id, pk] of Object.entries(picks || {})) {
    const g = resolveGroup(model, id, pk);
    if (!g) { orphans.push({ id, ...pk }); continue; }
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push({ id, ...pk });
  }
  return { byGroup, orphans };
}

// The group's effective pick, or null without records. `mode` is the model's schedule mode:
// in 'official' a lock made in preview is ignored. A reserved seat pins that run unless a real
// lock on another run exists; a reservation whose run left the catalog is reported as
// reservedLost, never as a lock.
export function groupPick(index, model, g, mode = 'official') {
  const recs = index.byGroup.get(g);
  if (!recs?.length) return null;
  const byAt = recs.slice().sort((a, b) => (b.at || 0) - (a.at || 0));
  const latest = byAt[0];
  const official = mode === 'official';
  const keys = new Set((model.byGroup.get(g) || []).map(s => s.key));
  const lockRec = byAt.find(r => r.lock && !(official && r.lockMode === 'preview'));
  const reserved = byAt.map(r => r.reserved).find(k => k && keys.has(k)) || null;
  const reservedLost = reserved ? null : byAt.map(r => r.reserved).find(Boolean) || null;
  const scored = byAt.find(r => Number.isFinite(r.score));
  return {
    p: latest.p ?? null,
    lock: (lockRec && keys.has(lockRec.lock) ? lockRec.lock : null) || reserved,
    reserved,
    reservedLost,
    score: scored ? scored.score : null,
    mode: latest.mode === 'watch' ? 'watch' : null,
    note: recs.map(r => r.note).filter(Boolean).join('\n\n'),
    ids: recs.map(r => r.id),
    holder: (lockRec || latest).id,
  };
}

export function prioOf(index, model, s, mode = 'official') {
  return groupPick(index, model, s.group, mode)?.p ?? null;
}

// ---- writes: each takes the saved picks object and changes it in place

// Rate every record of the group; a rating that is not positive also drops its lock.
export function ratePicks(picks, ids, meta, p, now) {
  for (const id of ids) {
    const cur = picks[id] || { note: '' };
    picks[id] = { ...cur, ...meta, p, at: now };
    if (!(p > 0)) { picks[id].lock = null; delete picks[id].lockMode; }
  }
}

// Score / watch-later live on every record of the group. Setting them on an unrated session
// rates it too (a score means you care about it; watch-later alone is a Maybe).
export function setPickField(picks, ids, meta, patch, now) {
  for (const id of ids) {
    const cur = picks[id] || { note: '', p: null, lock: null };
    const next = { ...cur, ...meta, at: now };
    if ('score' in patch) { if (patch.score == null) delete next.score; else next.score = patch.score; }
    if ('mode' in patch) { if (patch.mode) next.mode = patch.mode; else delete next.mode; }
    if (next.p == null && (next.score != null || next.mode)) next.p = next.mode ? 1 : 2;
    picks[id] = next;
  }
}

function clearLocks(picks, ids) {
  for (const id of ids) if (picks[id]) { picks[id].lock = null; delete picks[id].lockMode; }
}

// Lock a run (instKey) on the group's holder record, or unlock with instKey null. releaseIds are
// the records of the other groups whose locks this choice replaces (the other options of a clash).
export function lockPicks(picks, { gp, meta, instKey, releaseIds = [], preview = false, dropReservation = false, fallbackId = null }, now) {
  const ids = gp?.ids?.length ? gp.ids : (fallbackId ? [fallbackId] : []);
  clearLocks(picks, releaseIds);
  clearLocks(picks, ids);
  if (dropReservation) for (const id of ids) if (picks[id]) delete picks[id].reserved;
  if (!instKey) return;
  const holder = gp?.holder || fallbackId;
  const cur = picks[holder] || { note: '' };
  picks[holder] = { ...cur, ...meta, p: cur.p > 0 ? cur.p : gp?.p > 0 ? gp.p : 3, lock: instKey, at: now };
  if (preview) picks[holder].lockMode = 'preview';
  else delete picks[holder].lockMode;
}

// "I reserved a seat for this run": attend that run, and stop nagging about the RSVP.
export function reservePicks(picks, { gp, meta, instKey, fallbackId = null }, now) {
  const ids = gp?.ids?.length ? gp.ids : (fallbackId ? [fallbackId] : []);
  for (const id of ids) if (picks[id]) delete picks[id].reserved;
  clearLocks(picks, ids);
  if (!instKey) return;
  const holder = gp?.holder || fallbackId;
  const cur = picks[holder] || { note: '' };
  picks[holder] = { ...cur, ...meta, p: cur.p > 0 ? cur.p : gp?.p > 0 ? gp.p : 3, lock: instKey, reserved: instKey, at: now };
  delete picks[holder].lockMode;
}
