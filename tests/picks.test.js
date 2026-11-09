// Pick resolution (specs/features/pick-resolution.feature): what a session's rating, lock and
// reserved seat are, read from the saved records, and how picks stay attached when a session
// is renamed or cancelled. Pure functions in assets/js/picks.js. Run with: node tests/picks.test.js

import { resolveGroup, indexPicks, groupPick, prioOf, ratePicks, setPickField, lockPicks, reservePicks } from '../assets/js/picks.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} expected ${B}, got ${A}`);
}

// A small model: runs with id (session), key (run), code and group, indexed like data.js buildModel.
function model(runs) {
  const byId = new Map(), byKey = new Map(), byCode = new Map(), byGroup = new Map();
  for (const r of runs) {
    const s = { id: r.id, key: r.key, code: r.code, group: r.group || r.code, title: r.title || r.code };
    byKey.set(s.key, s);
    if (!byId.has(s.id)) byId.set(s.id, []);
    byId.get(s.id).push(s);
    if (!byCode.has(s.code)) byCode.set(s.code, s);
    if (!byGroup.has(s.group)) byGroup.set(s.group, []);
    byGroup.get(s.group).push(s);
  }
  return { byId, byKey, byCode, byGroup, sessions: [...byKey.values()] };
}
const lab = model([{ id: 'L', key: 'L-tue', code: 'LAB1' }, { id: 'L', key: 'L-thu', code: 'LAB1' }, { id: 'B', key: 'B-1', code: 'BRK1' }]);
const T0 = 1_700_000_000_000;
const index = (m, picks) => indexPicks(m, picks);
const read = (m, picks, g, mode = 'official') => groupPick(index(m, picks), m, g, mode);

// ---- resolving a saved record to its repeat group

test('should attach a pick by its session, then by its remembered group, then by its code', () => {
  eq(resolveGroup(lab, 'L', {}), 'LAB1');
  eq(resolveGroup(lab, 'gone', { g: 'BRK1' }), 'BRK1');
  eq(resolveGroup(lab, 'gone', { code: 'LAB1' }), 'LAB1', 'the code changed its session id');
  eq(resolveGroup(lab, 'gone', { code: 'LAB1-R1' }), 'LAB1', 'a repeat suffix falls back to the base code');
  eq(resolveGroup(lab, 'gone', { g: 'nope', code: 'nope' }), null, 'cancelled under every name');
});
test('should index picks per group and keep the unattached ones as orphans', () => {
  const idx = index(lab, { L: { p: 3, at: 1 }, B: { p: 1, at: 2 }, old: { p: 2, code: 'LAB1', at: 3 }, gone: { p: 2, g: 'X', code: 'X', at: 4 } });
  eq([...idx.byGroup.keys()].sort(), ['BRK1', 'LAB1']);
  eq(idx.byGroup.get('LAB1').map(r => r.id), ['L', 'old']);
  eq(idx.orphans, [{ id: 'gone', p: 2, g: 'X', code: 'X', at: 4 }]);
});

// ---- the effective pick

test('should take the rating from the newest record', () => {
  eq(read(lab, { L: { p: 2, at: T0 }, old: { p: 3, code: 'LAB1', at: T0 + 1 } }, 'LAB1').p, 3);
  eq(read(lab, { L: { p: 2, at: T0 + 1 }, old: { p: 3, code: 'LAB1', at: T0 } }, 'LAB1').p, 2);
});
test('should keep a lock held by an older record while the newest says Skip', () => {
  const gp = read(lab, { L: { p: 0, at: T0 + 1 }, old: { p: 3, lock: 'L-thu', code: 'LAB1', at: T0 } }, 'LAB1');
  eq([gp.p, gp.lock, gp.holder], [0, 'L-thu', 'old']);
});
test('should pin a reserved run as the lock, and prefer a real lock on another run only when it exists', () => {
  eq(read(lab, { L: { p: 3, reserved: 'L-thu', at: T0 } }, 'LAB1').lock, 'L-thu');
  const gp = read(lab, { L: { p: 3, reserved: 'L-thu', lock: 'L-tue', at: T0 } }, 'LAB1');
  eq([gp.lock, gp.reserved], ['L-tue', 'L-thu']);
});
test('should let a lock on a run that left the catalog give way to the reservation', () => {
  const gp = read(lab, { L: { p: 3, lock: 'L-gone', reserved: 'L-thu', at: T0 } }, 'LAB1');
  eq([gp.lock, gp.reserved, gp.reservedLost], ['L-thu', 'L-thu', null]);
  const lost = read(lab, { L: { p: 3, lock: 'L-gone', reserved: 'L-gone', at: T0 } }, 'LAB1');
  eq([lost.lock, lost.reserved, lost.reservedLost], [null, null, 'L-gone']);
});
test('should ignore a preview lock once the schedule is official, and honour it in preview', () => {
  const picks = { L: { p: 3, lock: 'L-tue', lockMode: 'preview', at: T0 } };
  eq(read(lab, picks, 'LAB1', 'official').lock, null);
  eq(read(lab, picks, 'LAB1', 'preview').lock, 'L-tue');
  eq(read(lab, { L: { p: 3, lock: 'L-tue', at: T0 } }, 'LAB1', 'official').lock, 'L-tue', 'a real lock stands');
});
test('should take the score from the newest record that has one, watch-later from the newest record only, and join notes', () => {
  const gp = read(lab, { L: { p: 2, note: 'a', at: T0 + 2 }, old: { p: 2, score: 7, mode: 'watch', note: 'b', code: 'LAB1', at: T0 } }, 'LAB1');
  eq([gp.score, gp.mode, gp.note, gp.ids], [7, null, 'a\n\nb', ['L', 'old']]);
  eq(read(lab, { L: { p: 1, mode: 'watch', at: T0 } }, 'LAB1').mode, 'watch');
});
test('should give null for a group without records, and prioOf reads a session through its group', () => {
  eq(read(lab, {}, 'LAB1'), null);
  const idx = index(lab, { L: { p: 3, at: T0 } });
  eq([prioOf(idx, lab, lab.byKey.get('L-thu'), 'official'), prioOf(idx, lab, lab.byKey.get('B-1'), 'official')], [3, null]);
});

// ---- the group setters are pure: they take the picks object and a clock

const meta = { g: 'LAB1', code: 'LAB1' };
test('should rate every record of the group and clear locks when the rating is not positive', () => {
  const picks = { L: { p: 3, lock: 'L-thu', lockMode: 'preview', note: 'n', at: 1 } };
  ratePicks(picks, ['L', 'old'], meta, 2, T0);
  eq(picks, { L: { p: 2, lock: 'L-thu', lockMode: 'preview', note: 'n', at: T0, g: 'LAB1', code: 'LAB1' }, old: { note: '', g: 'LAB1', code: 'LAB1', p: 2, at: T0 } });
  ratePicks(picks, ['L'], meta, 0, T0 + 1);
  eq([picks.L.p, picks.L.lock, 'lockMode' in picks.L, picks.L.at], [0, null, false, T0 + 1]);
});
test('should set a score or watch-later on every record, rating an unrated session as it does', () => {
  const picks = {};
  setPickField(picks, ['L'], meta, { score: 9 }, T0);
  eq(picks.L, { note: '', p: 2, lock: null, g: 'LAB1', code: 'LAB1', at: T0, score: 9 });
  setPickField(picks, ['L'], meta, { mode: 'watch' }, T0 + 1);
  eq([picks.L.mode, picks.L.p], ['watch', 2]);
  setPickField(picks, ['L'], meta, { score: null, mode: null }, T0 + 2);
  eq(['score' in picks.L, 'mode' in picks.L], [false, false]);
  const unrated = {};
  setPickField(unrated, ['L'], meta, { mode: 'watch' }, T0);
  eq(unrated.L.p, 1, 'watch-later alone rates it Maybe');
});
test('should lock a run on the holder, release the clash\'s other locks, and mark a preview lock', () => {
  const picks = { L: { p: 3, lock: 'L-tue', at: 1 }, B: { p: 2, lock: 'B-1', at: 1 }, X: { p: 2, lock: 'X-1', at: 1 } };
  const gp = { ids: ['L'], holder: 'L', p: 3 };
  lockPicks(picks, { gp, meta, instKey: 'L-thu', releaseIds: ['B'], preview: true }, T0);
  eq([picks.L.lock, picks.L.lockMode, picks.L.at, picks.B.lock, picks.X.lock], ['L-thu', 'preview', T0, null, 'X-1']);
  lockPicks(picks, { gp, meta, instKey: null, releaseIds: [] }, T0 + 1);
  eq([picks.L.lock, 'lockMode' in picks.L], [null, false]);
});
test('should rate an unrated session Must when a lock lands on it, and drop a reservation only when asked', () => {
  const picks = { L: { p: null, reserved: 'L-tue', lock: 'L-tue', note: '', at: 1 } };
  lockPicks(picks, { gp: { ids: ['L'], holder: 'L', p: null }, meta, instKey: 'L-thu', releaseIds: [], preview: false }, T0);
  eq([picks.L.p, picks.L.lock, picks.L.reserved], [3, 'L-thu', 'L-tue']);
  lockPicks(picks, { gp: { ids: ['L'], holder: 'L', p: 3 }, meta, instKey: 'L-thu', releaseIds: [], preview: false, dropReservation: true }, T0 + 1);
  eq('reserved' in picks.L, false);
});
test('should record a reserved seat as lock and reservation on the holder, replacing an earlier one', () => {
  const picks = { L: { p: 2, reserved: 'L-tue', lock: 'L-tue', lockMode: 'preview', at: 1 } };
  reservePicks(picks, { gp: { ids: ['L'], holder: 'L', p: 2 }, meta, instKey: 'L-thu' }, T0);
  eq(Object.entries(picks.L).sort(), Object.entries({ p: 2, reserved: 'L-thu', lock: 'L-thu', at: T0, g: 'LAB1', code: 'LAB1' }).sort());
  reservePicks(picks, { gp: { ids: ['L'], holder: 'L', p: 2 }, meta, instKey: null }, T0 + 1);
  eq(['reserved' in picks.L, picks.L.lock], [false, null]);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
