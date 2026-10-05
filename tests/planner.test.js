// Headless tests for the pure planner modules. Run with macOS's built-in JavaScriptCore:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/planner.test.js
// or with Node:  node tests/planner.test.js

import { transition, canBoth, optimize, optimizeDay, decisionGroups, isResolved, fillers, nowNext, weigh, whatIf, chainValue, DEFAULT_PLANNER } from '../assets/js/planner.js';
import { parseLocation, walkMinutes, sameRoom, ANYWHERE, DEFAULT_WALK } from '../assets/js/venue.js';
import { localParts, fromISO, parseSlot, fmtTime, fmtDay, addDays } from '../assets/js/time.js';

const log = typeof print === 'function' && typeof window === 'undefined' ? print : console.log;
let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} expected ${B}, got ${A}`);
}
function ok(v, msg = 'expected truthy') { if (!v) throw new Error(msg); }

const W2 = parseLocation('Moscone West, Level 2, Room 2001');
const W3 = parseLocation('Moscone West, Level 3, Room 3010');
const S1 = parseLocation('Moscone South, Room 156');
const N = parseLocation('Moscone North, Hall F');
const SW = DEFAULT_WALK.pairs['S|W'];

let n = 0;
function item(start, end, loc = W2, extra = {}) {
  n++;
  return { key: `k${n}`, id: extra.id || `s${n}`, code: extra.code || `BRK${n}`, title: `T${n}`, type: 'Breakout',
    day: '2026-11-18', startMin: start, endMin: end, loc, recorded: null, priority: 2, locked: false, ...extra };
}
const H = h => Math.round(h * 60);

// --- time
test('localParts converts UTC to Pacific (PST in November)', () => {
  eq(localParts(new Date('2026-11-18T17:00:00Z')), { day: '2026-11-18', min: 9 * 60 });
  eq(fromISO('2026-11-19T02:30:00Z'), { day: '2026-11-18', min: 18 * 60 + 30 });
});
test('parseSlot handles wrap past midnight', () => {
  eq(parseSlot('23:15 - 00:00'), { start: 1395, end: 1440 });
  eq(parseSlot('19:50 - 21:20'), { start: 1190, end: 1280 });
  eq(parseSlot('nope'), null);
});
test('fmtTime / fmtDay / addDays', () => {
  eq(fmtTime(0), '12:00 AM'); eq(fmtTime(12 * 60 + 5), '12:05 PM'); eq(fmtTime(9 * 60 + 30), '9:30 AM');
  eq(fmtDay('2026-11-17'), 'Tue, Nov 17');
  eq(addDays('2026-11-30', 1), '2026-12-01');
});

// --- venue
test('parseLocation recognises buildings and floors', () => {
  eq([W2.building, W2.floor, W2.known], ['W', '2', true]);
  eq([S1.building, S1.floor], ['S', '1']);
  eq(parseLocation('zTest84').known, false);
  eq(parseLocation('Marriott Marquis, Yerba Buena Ballroom, BO2').building, 'M');
  eq(parseLocation('Chase Center').building, 'C');
  eq(parseLocation('Moscone South, The Hub, Theater A').floor, 'Hub');
  eq(parseLocation('Moscone South, Level 3, Room 301').floor, '3');
  eq(parseLocation('Moscone West, Level 3, across from Room 3014').floor, '3');
  eq(parseLocation('Room 2014', { 'Room 2014': 'W' }).building, 'W');
});
test('walkMinutes uses floor and building pairs', () => {
  eq(walkMinutes(W2, W2), 0);
  eq(walkMinutes(W2, parseLocation('Moscone West, Level 2, Room 2005')), DEFAULT_WALK.sameFloor);
  eq(walkMinutes(W2, W3), DEFAULT_WALK.diffFloor);
  eq(walkMinutes(W2, S1), DEFAULT_WALK.pairs['S|W']);
  eq(walkMinutes(S1, W2), DEFAULT_WALK.pairs['S|W']);
  eq(walkMinutes(N, S1), DEFAULT_WALK.pairs['N|S']);
  eq(walkMinutes(W2, parseLocation('zTest1')), DEFAULT_WALK.unknown);
});

// --- transitions
test('back-to-back in same room is fine, cross-building with 5 min gap is a conflict', () => {
  const a = item(H(9), H(9.75)), b = item(H(10), H(10.75));
  eq(transition(a, b).status, 'ok');
  const c = item(H(10), H(10.75), S1);
  const t = transition(a, c);
  eq([t.walk, t.gap, t.status], [SW, 15, 'ok']);
  const d = item(H(9.75) + 1, H(10.5), S1);
  eq(transition(a, d).status, 'conflict', 'W->S with 1 min gap');
});
test('tight transfer within tolerance is flagged, not a conflict', () => {
  const a = item(H(9), H(9.75)), b = item(H(9.75) + SW + 2 - 3, H(10.5), S1); // miss 3
  const t = transition(a, b);
  eq([t.status, t.miss], ['tight', 3]);
});
test('tolerance is capped at a quarter of the shorter session', () => {
  const a = item(H(9), H(9) + 15, W2), b = item(H(9) + 15 + SW + 2 - 3, H(10), S1); // 15-min talk: cap 3
  eq(transition(a, b).status, 'tight');
  const c = item(H(9) + 15 + SW + 2 - 5, H(10), S1); // miss 5 > 3
  eq(transition(a, c).status, 'conflict');
});
test('canBoth is symmetric and false for overlaps', () => {
  const a = item(H(9), H(10)), b = item(H(9.5), H(10.5));
  eq([canBoth(a, b), canBoth(b, a)], [false, false]);
  const c = item(H(10.25), H(11));
  eq([canBoth(a, c), canBoth(c, a)], [true, true]);
  const other = item(H(9), H(10), W2, { day: '2026-11-19' });
  eq(canBoth(a, other), true);
});

// --- weights
test('recorded sessions lose to unrecorded at equal priority', () => {
  const a = item(H(9), H(10), W2, { recorded: true }), b = item(H(9), H(10), W3, { recorded: false });
  ok(weigh(b).score > weigh(a).score);
  const lab = item(H(9), H(10), W2, { type: 'Lab' });
  ok(weigh(lab).why.some(w => w.includes('in-person only')));
});

// --- optimizer
test('optimizeDay picks the max-weight feasible chain', () => {
  const must = item(H(9), H(10), W2, { priority: 3 });
  const want1 = item(H(9.5), H(10.5), W2, { priority: 2 });
  const want2 = item(H(10.25), H(11), W2, { priority: 2 });
  const maybe = item(H(11.25), H(12), S1, { priority: 1 });
  const { chosen } = optimizeDay([want1, maybe, must, want2]);
  eq(chosen.map(c => c.key), [must.key, want2.key, maybe.key]);
});
test('two Wants beat one Must only when they add up', () => {
  const must = item(H(9), H(11), W2, { priority: 3 });
  const w1 = item(H(9), H(10), W3, { priority: 2 });
  const w2 = item(H(10.25), H(11), W3, { priority: 2 });
  eq(optimizeDay([must, w1, w2]).chosen.map(c => c.key), [must.key], 'tie keeps the Must');
  w2.recorded = false; // 50 + 60 > 100
  eq(optimizeDay([must, w1, w2]).chosen.map(c => c.key), [w1.key, w2.key]);
  const locked = { ...must, locked: true };
  eq(optimizeDay([locked, w1, w2]).chosen.map(c => c.key), [must.key]);
});
test('walk time makes a pair infeasible and the optimizer drops the cheaper one', () => {
  const a = item(H(9), H(9.75), W2, { priority: 3 });
  const b = item(H(9.75) + 1, H(10.5), S1, { priority: 1 });
  const c = item(H(9.75) + 1, H(10.5), W2, { priority: 1 });
  const res = optimize([a, b, c]);
  eq(res.plan['2026-11-18'].map(x => x.key), [a.key, c.key]);
  const drop = res.dropped.find(d => d.item.key === b.key);
  ok(drop, 'b dropped');
  ok(['walk', 'overlap'].includes(drop.reason.kind));
});
test('explainDrop reports walking problems in words', () => {
  const a = item(H(9), H(9.75), W2, { priority: 3 });
  const b = item(H(9.75) + 1, H(10.5), S1, { priority: 1 });
  const res = optimize([a, b]);
  const d = res.dropped[0];
  eq(d.reason.kind, 'walk');
  ok(new RegExp(`${SW} min walk`).test(d.reason.text), d.reason.text);
});
test('repeat instances: attend once, choose the one that fits', () => {
  const blocker = item(H(14), H(15), W2, { priority: 3 });
  const r1 = item(H(14), H(15), W3, { id: 'rep', code: 'BRK900', priority: 2 });
  const r2 = item(H(10), H(11), W3, { id: 'rep', code: 'BRK900', priority: 2, day: '2026-11-19' });
  const res = optimize([blocker, r1, r2]);
  eq(res.plan['2026-11-18'].map(x => x.key), [blocker.key]);
  eq(res.plan['2026-11-19'].map(x => x.key), [r2.key]);
  // Both instances free: still only one is kept.
  const free1 = item(H(9), H(10), W2, { id: 'rep2', code: 'BRK901' });
  const free2 = item(H(9), H(10), W2, { id: 'rep2', code: 'BRK901', day: '2026-11-19' });
  const res2 = optimize([free1, free2]);
  const kept = Object.values(res2.plan).flat().filter(x => x.id === 'rep2');
  eq(kept.length, 1);
  eq(res2.dropped[0].reason.kind, 'repeat');
});
test('locked conflicts are reported', () => {
  const a = item(H(9), H(10), W2, { locked: true, priority: 3 });
  const b = item(H(9.5), H(10.5), W3, { locked: true, priority: 3 });
  eq(optimize([a, b]).lockedConflicts.length, 1);
});
test('unscheduled items are passed through', () => {
  const u = item(null, null, W2, { day: null });
  eq(optimize([u]).unscheduled.length, 1);
});

// --- decision groups
test('decisionGroups clusters chains of conflicts per day', () => {
  const a = item(H(9), H(10)), b = item(H(9.5), H(10.5), W3), c = item(H(10.25), H(11), S1);
  const lone = item(H(13), H(14));
  const other = item(H(9), H(10), W2, { day: '2026-11-19' });
  const g = decisionGroups([a, b, c, lone, other]);
  eq(g.length, 1);
  eq(g[0].items.map(x => x.key), [a.key, b.key, c.key]);
});

// --- fillers / now-next
test('fillers only suggests sessions that fit around the plan', () => {
  const p1 = item(H(9), H(10)), p2 = item(H(11), H(12));
  const fits = item(H(10.25), H(10.75), W2);
  const tooFar = item(H(10) + 1, H(10.75), S1);
  const clash = item(H(9.5), H(10.25), W2);
  eq(fillers([p1, p2], [fits, tooFar, clash]).map(x => x.key), [fits.key]);
});
test('nowNext gives current, next and leave-by', () => {
  const p1 = item(H(9), H(10), W2), p2 = item(H(10.5), H(11.5), S1);
  const r = nowNext([p1, p2], H(9.5));
  eq([r.current.key, r.next.key, r.walk], [p1.key, p2.key, SW]);
  eq(r.leaveBy, H(10.5) - SW - DEFAULT_PLANNER.buffer);
  const after = nowNext([p1, p2], H(12));
  eq([after.current, after.next], [null, null]);
});

test('whatIf compares the whole day, not just the clashing pair', () => {
  // A (Must) blocks B and C; picking B lets you also do C.
  const A = item(H(9), H(11), W2, { priority: 3 });
  const B = item(H(9), H(10), W3, { priority: 2 });
  const C = item(H(10.25), H(11), W3, { priority: 2, recorded: false });
  const day = [A, B, C];
  const ifA = whatIf(day, A.key), ifB = whatIf(day, B.key);
  eq(ifA.chosen.map(x => x.key), [A.key]);
  eq(ifB.chosen.map(x => x.key), [B.key, C.key]);
  ok(ifB.value > ifA.value, `${ifB.value} > ${ifA.value}`);
  eq(chainValue([A]), 100);
});
test('whatIf releases locks on the competing options only', () => {
  const A = item(H(9), H(10), W2, { priority: 3, locked: true });
  const B = item(H(9), H(10), W3, { priority: 1 });
  const L = item(H(9.5), H(10.5), S1, { priority: 1, locked: true }); // unrelated lock that clashes with B
  eq(whatIf([A, B], B.key, new Set([A.key])).feasible, true);
  eq(whatIf([A, B, L], B.key, new Set([A.key])).feasible, false);
});

// --- regressions from the adversarial review

// Brute force: best set of items with at most one run per id, each day a feasible chain.
function bruteForce(items, ctx = DEFAULT_PLANNER, mustKey = null) {
  let best = -Infinity;
  const n = items.length;
  for (let m = 0; m < 1 << n; m++) {
    const sel = items.filter((_, i) => (m >> i) & 1);
    if (mustKey && !sel.some(x => x.key === mustKey)) continue;
    const ids = sel.map(x => x.id);
    if (new Set(ids).size !== ids.length) continue;
    let v = 0, ok = true;
    for (const day of new Set(sel.map(x => x.day))) {
      const chain = sel.filter(x => x.day === day).sort((a, b) => a.startMin - b.startMin);
      for (let i = 1; i < chain.length && ok; i++) {
        if (chain[i].startMin === chain[i - 1].startMin || transition(chain[i - 1], chain[i], ctx).status === 'conflict') ok = false;
      }
      if (!ok) break;
      v += chainValue(chain, ctx);
    }
    if (ok && v > best) best = v;
  }
  return Math.max(0, best);
}
const planValue = (res, ctx = DEFAULT_PLANNER) => Object.values(res.plan).reduce((a, chain) => a + chainValue(chain, ctx), 0);

test('repeat runs: no group is dropped when one of its runs fits (review p1)', () => {
  const D1 = '2026-11-18', D2 = '2026-11-19';
  const items = [
    item(H(9), H(10), W2, { id: 'A', code: 'A', key: 'a1', day: D1 }),
    item(H(9), H(10), W3, { id: 'Z', code: 'Z', key: 'z1', day: D1, priority: 1, recorded: false }),
    item(H(13), H(14), W2, { id: 'B', code: 'B', key: 'b1', day: D1 }),
    item(H(9), H(10), W2, { id: 'A', code: 'A-R1', key: 'a2', day: D2 }),
    item(H(10.25), H(11), W2, { id: 'B', code: 'B-R1', key: 'b2', day: D2 }),
    item(H(9.5), H(10.75), W3, { id: 'L', code: 'LAB', key: 'w2', day: D2, type: 'Lab', recorded: false }),
  ];
  const res = optimize(items);
  eq(planValue(res), bruteForce(items));
  ok(Object.values(res.plan).flat().some(x => x.id === 'A'), 'A attended');
});

test('optimizer matches brute force on 400 random small instances', () => {
  let seed = 12345;
  const rnd = k => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  const locs = [W2, W3, S1, N, parseLocation('Marriott Marquis, Yerba Buena Ballroom, BO1')];
  for (let t = 0; t < 400; t++) {
    const n0 = 3 + rnd(7);
    const items = [];
    for (let i = 0; i < n0; i++) {
      const start = H(9) + rnd(16) * 15;
      const dur = [15, 25, 30, 45, 75][rnd(5)];
      items.push(item(start, start + dur, locs[rnd(locs.length)], {
        id: `g${rnd(Math.max(2, n0 - 2))}`, day: rnd(2) ? '2026-11-18' : '2026-11-19',
        priority: 1 + rnd(3), recorded: [true, false, null][rnd(3)], type: rnd(4) ? 'Breakout' : 'Lab',
      }));
    }
    const res = optimize(items);
    const ids = Object.values(res.plan).flat().map(x => x.id);
    if (new Set(ids).size !== ids.length) throw new Error(`instance ${t}: a session attended twice`);
    const got = planValue(res), want = bruteForce(items);
    if (Math.abs(got - want) > 1e-9) throw new Error(`instance ${t}: optimizer ${got} vs brute force ${want}`);
  }
});

test('large repeat sets (heuristic branch) stay valid and near-optimal', () => {
  let seed = 777;
  const rnd = k => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % k; };
  const locs = [W2, W3, S1, N];
  let worst = 1;
  for (let t = 0; t < 6; t++) {
    const items = [];
    for (let g = 0; g < 9; g++) {
      for (let r = 0; r < 2; r++) {
        const start = H(9) + rnd(12) * 15;
        items.push(item(start, start + [30, 45, 75][rnd(3)], locs[rnd(4)], {
          id: `G${g}`, day: rnd(2) ? '2026-11-18' : '2026-11-19', priority: 1 + rnd(3), recorded: [true, false][rnd(2)],
        }));
      }
    }
    const res = optimize(items);
    const ids = Object.values(res.plan).flat().map(x => x.id);
    eq(new Set(ids).size, ids.length, 'no session twice');
    worst = Math.min(worst, planValue(res) / bruteForce(items));
  }
  ok(worst >= 0.95, `heuristic reached ${Math.round(worst * 100)}% of optimum`);
});

test('whatIf counts a same-day repeat only once (review p4)', () => {
  const lab1 = item(H(9), H(10.25), W3, { id: 'LAB', code: 'LAB512', type: 'Lab', recorded: false });
  const brk1 = item(H(10), H(10.75), W2, { id: 'B1', priority: 3 });
  const key = item(H(11.25), H(12.25), parseLocation('Chase Center'), { id: 'K', priority: 3, type: 'Keynote' });
  const brk2 = item(H(12.5), H(13.5), W2, { id: 'B2', priority: 3 });
  const lab2 = item(H(13.25), H(14.5), W3, { id: 'LAB', code: 'LAB512-R1', type: 'Lab', recorded: false });
  const day = [lab1, brk1, key, brk2, lab2];
  const r = whatIf(day, key.key, new Set(day.map(x => x.key)));
  eq(r.chosen.filter(x => x.id === 'LAB').length, 1);
  eq(r.value, bruteForce(day, DEFAULT_PLANNER, key.key));
  ok(r.value < bruteForce(day), 'going to the keynote is worse than the best plan');
});

test('staying in the same room needs no buffer (review p3)', () => {
  const a = item(H(10), H(10.5), W2), b = item(H(10.5), H(11), W2);
  const t = transition(a, b);
  eq([t.status, t.miss, t.stay], ['ok', 0, true]);
  const wide = { ...DEFAULT_PLANNER, buffer: 10 };
  eq(transition(a, b, wide).status, 'ok');
  eq(nowNext([a, b], H(10.4)).leaveBy, H(10.5));
});

test('placeholder rooms are never "the same room" (review p6)', () => {
  const z = parseLocation('zTest78');
  eq(sameRoom(z, z), false);
  eq(walkMinutes(z, z), DEFAULT_WALK.unknown);
  const a = item(H(10), H(10.75), z), b = item(H(10.75), H(11.5), z);
  eq(transition(a, b).status, 'conflict');
  const odd = parseLocation('Gateway Pavilion, Level 2, Theater 1'); // real room, unknown building
  eq([odd.known, sameRoom(odd, odd), walkMinutes(odd, odd)], [false, true, 0]);
});

test('decisionGroups finds clashes caused by long walks (review p2 case 2)', () => {
  const C = parseLocation('Chase Center');
  const ctx = { ...DEFAULT_PLANNER, walk: { ...DEFAULT_WALK, pairs: { ...DEFAULT_WALK.pairs, 'C|W': 70 } } };
  const k = item(H(9), H(10.5), C, { type: 'Keynote', priority: 3 });
  const b = item(H(11.5) + 1, H(12.25), W2);
  eq(canBoth(k, b, ctx), false);
  eq(decisionGroups([k, b], ctx).length, 1);
});

test('a lock settles a clash chain only if nothing else still conflicts (review p2 case 3)', () => {
  const A = item(H(9), H(10), W2, { locked: true, priority: 3 });
  const B = item(H(9.5), H(10.5), W2);
  const C = item(H(10.25), H(11), W2);
  const D = item(H(10.75), H(11.5), S1);
  const g = decisionGroups([A, B, C, D]);
  eq(g.length, 1);
  eq(g[0].resolved, false, 'C vs D still open');
  eq(isResolved([A, B]), true);
});

test('explainDrop distinguishes a clashing repeat from a free one (review p8)', () => {
  const r1 = item(H(9), H(10), W2, { id: 'R', code: 'BRK9' });
  const r2 = item(H(9), H(10), W2, { id: 'R', code: 'BRK9-R1', day: '2026-11-19' });
  const res = optimize([r1, r2]);
  const d = res.dropped[0];
  eq([d.reason.kind, d.reason.clash], ['repeat', false]);
  ok(!/clash/i.test(d.reason.text), d.reason.text);
});

test('nowNext uses the start-of-day origin and keynote entry time', () => {
  const C = parseLocation('Chase Center');
  const key = item(H(9), H(11), C, { type: 'Keynote' });
  const r = nowNext([key], H(8), DEFAULT_PLANNER, parseLocation('Moscone West'));
  eq(r.walk, DEFAULT_WALK.pairs['C|W']);
  eq(r.leaveBy, H(9) - DEFAULT_WALK.pairs['C|W'] - DEFAULT_PLANNER.buffer - DEFAULT_PLANNER.keynoteExtra);
});

test('pseudo items (lunch) use their own weight and cost no walking', () => {
  const lunch = { key: 'lunch1', id: 'lunch:d', code: 'Lunch', title: 'Lunch', pseudo: 'lunch', weight: 60, day: '2026-11-18', startMin: H(12), endMin: H(12.5), loc: ANYWHERE, priority: 0 };
  eq(weigh(lunch).score, 60);
  const a = item(H(11.25), H(12), S1), b = item(H(12.5), H(13.25), W2);
  eq(transition(a, lunch).status, 'ok');
  eq(transition(lunch, b).status, 'ok');
  eq(decisionGroups([lunch, item(H(12), H(12.75), W2)]).length, 0, 'pseudo items are not decisions');
});

log(`${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} test(s) failed`);
