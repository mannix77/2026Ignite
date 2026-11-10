// Headless tests for the pure planner modules. Run with macOS's built-in JavaScriptCore:
//   /System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc -m tests/planner.test.js
// or with Node:  node tests/planner.test.js

import { transition, canBoth, optimize, optimizeDay, decisionGroups, isResolved, fillers, nowNext, weigh, whatIf, chainValue, DEFAULT_PLANNER } from '../assets/js/planner.js';
import { parseLocation, walkMinutes, sameRoom, DEFAULT_WALK } from '../assets/js/venue.js';
import { localParts, fromISO, parseSlot, fmtTime, fmtDay, addDays, relTime, fmtDuration, fmtRange } from '../assets/js/time.js';
import { createVenue } from '../assets/js/venue.js';
import { CONFERENCES, LAS_VEGAS_DEF, SWAN_DOLPHIN_DEF } from '../assets/js/conferences.js';
import { parseShare } from '../assets/js/store.js';
import { upNext, onwardWalk, nextPlanned } from '../assets/js/upnext.js';
import { arrivalExtra, lunchConfig, compareOptions } from '../assets/js/planner.js';

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
test('back-to-back in one room is fine; across buildings a 15 min gap is fine and a 1 min gap is a conflict', () => {
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
});
test('a hands-on session scores its in-person bonus', () => {
  const talk = item(H(9), H(10), W2), lab = item(H(9), H(10), W2, { type: 'Lab' });
  eq([weigh(lab).score - weigh(talk).score, weigh(lab).why.some(w => w.includes('in-person only'))], [DEFAULT_PLANNER.weights.handsOnBonus, true]);
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
test('should plan only the locked run of a repeated session', () => {
  const tue = item(H(9), H(10), W2, { id: 'rep3', code: 'BRK902', priority: 3, locked: true });
  const thu = item(H(9), H(10), W2, { id: 'rep3', code: 'BRK902', priority: 3, day: '2026-11-20' });
  const kept = Object.values(optimize([tue, thu]).plan).flat().filter(x => x.id === 'rep3');
  eq(kept.map(x => x.key), [tue.key]);
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

// --- an independent reference for the optimizer (#77, specs/features/plan-building.feature)
// bruteForce above prices plans with the planner's own weigh/transition/chainValue, so a wrong
// weight or walking rule agrees with itself, and its instances hold no locks, blocked time,
// lunch or other venue. refBest is written from the rules as Settings states them, with the
// default numbers and each venue's published walking minutes typed in; it calls nothing in
// planner.js. Rooms are [building, floor, label] as the reference sees them.
const REF = {
  tier: { 3: 100, 2: 50, 1: 20 }, perScorePoint: 10, recorded: -15, notRecorded: 10,
  handsOn: 10, handsOnTypes: ['Lab', 'Table Talk', 'Workshop', "Builders' session"],
  buffer: 2, keynoteEntry: 15, maxMiss: 5, perMissedMin: 2, lunchLength: 30,
};
const REF_MS = createVenue(CONFERENCES.ignite2026.venue), REF_LV = createVenue(LAS_VEGAS_DEF), REF_SD = createVenue(SWAN_DOLPHIN_DEF);
const REF_VENUES = [
  { name: 'Ignite', days: ['2026-11-18', '2026-11-19'], lunch: [H(11.5), H(13.5)], keynoteVenues: ['C'],
    sameFloor: 3, diffFloor: 5, minutes: { 'S|W': 7, 'M|W': 13, 'M|S': 14, 'C|W': 40, 'C|S': 40, 'C|M': 40 },
    rooms: [['W', '2', 'Moscone West, Level 2, Room 2001'], ['W', '2', 'Moscone West, Level 2, Room 2005'],
      ['W', '3', 'Moscone West, Level 3, Room 3010'], ['S', '1', 'Moscone South, Room 156'],
      ['M', null, 'Marriott Marquis, Yerba Buena Ballroom, BO1'], ['C', null, 'Chase Center']],
    block: ['W', null, 'Moscone West'], keynoteBlock: ['C', null, 'Chase Center'], types: ['Breakout', 'Breakout', 'Lab', 'Table Talk', 'Keynote'],
    planner: { parse: REF_MS.parseLocation, walk: REF_MS.walk, keynoteBuildings: REF_MS.keynoteBuildings } },
  { name: 're:Invent', days: ['2026-12-01', '2026-12-02'], lunch: [H(11), H(14)], keynoteVenues: [],
    sameFloor: 5, diffFloor: 8, minutes: { 'C|F': 10, 'C|V': 15, 'F|V': 15, 'C|M': 35, 'F|M': 35, 'M|V': 35 },
    rooms: [['C', 'Promenade Level', 'Caesars Palace | Promenade Level | Roman I'], ['F', '1', 'Caesars Forum | Level 1 | Forum 120'],
      ['V', '2', 'Venetian | Level 2 | Hall B'], ['V', '3', 'Venetian | Level 3 | West Alcove'], ['M', '1', 'MGM Grand | Level 1 | Grand 122']],
    block: ['V', null, 'Venetian / Palazzo (Venetian Expo)'], types: ['Breakout', 'Chalk talk', "Builders' session", 'Workshop', 'Keynote'],
    planner: { parse: REF_LV.parseLocation, walk: REF_LV.walk, keynoteBuildings: REF_LV.keynoteBuildings } },
  { name: 'Gartner', days: ['2026-10-19', '2026-10-20'], lunch: [H(11.75), H(14.75)], keynoteVenues: [],
    sameFloor: 3, diffFloor: 5, minutes: { 'D|S': 10, 'D|Y': 15, 'S|Y': 18 },
    rooms: [['D', 'Convention', 'Upper Peninsula 4, WDW Dolphin Hotel'], ['D', 'Ballroom', 'Southern Hemisphere III, WDW Dolphin Hotel'],
      ['S', null, 'Swan Ballroom 6, WDW Swan Hotel'], ['Y', null, "Grand Harbor Salon 1, Disney's Yacht & Beach Resort"]],
    block: ['D', null, 'WDW Dolphin'], types: ['Track session', 'Workshop', 'Roundtable', 'Keynote'],
    planner: { parse: REF_SD.parseLocation, walk: REF_SD.walk, keynoteBuildings: REF_SD.keynoteBuildings } },
];
const refCtx = v => ({ ...DEFAULT_PLANNER, walk: v.planner.walk, keynoteBuildings: v.planner.keynoteBuildings });   // as app.js builds it
const roomOf = (v, label) => v.rooms.find(r => r[2] === label);
const refSession = (v, label, start, end, extra = {}) => item(start, end, v.planner.parse(label), { refRoom: roomOf(v, label), ...extra });
const refBlock = (v, key, day, start, end, room = v.block) => ({ key, id: key, code: 'Meeting', title: 'Customer meeting', pseudo: 'block', weight: 1e7,
  locked: true, priority: 0, day, startMin: start, endMin: end, refRoom: room,
  loc: { label: room[2], building: room[0], floor: null, known: true } });   // as app.js builds blocked time

function refWalk(v, [ba, fa, la], [bb, fb, lb]) {
  if (la === lb) return 0;
  if (ba === bb) return fa && fb && fa !== fb ? v.diffFloor : v.sameFloor;
  return v.minutes[[ba, bb].sort().join('|')];
}
// Minutes needed to get from a to b: none to stay put, else the walk, the buffer and keynote entry.
function refNeed(v, a, b) {
  if (a.refRoom[2] === b.refRoom[2]) return 0;
  const keynote = !b.pseudo && (b.type === 'Keynote' || v.keynoteVenues.includes(b.refRoom[0]));
  return refWalk(v, a.refRoom, b.refRoom) + REF.buffer + (keynote ? REF.keynoteEntry : 0);
}
function refWorth(x) {
  if (x.pseudo === 'block') return 0;              // in every plan, so it adds nothing to compare
  if (Number.isFinite(x.score)) return x.score * REF.perScorePoint;
  return REF.tier[x.priority] + (x.recorded === true ? REF.recorded : x.recorded === false ? REF.notRecorded : 0)
    + (REF.handsOnTypes.includes(x.type) ? REF.handsOn : 0);
}
// One day's sessions in time order: can they all be attended, and what are they worth?
function refChain(v, chain) {
  let value = 0, missed = 0;
  for (let i = 0; i < chain.length; i++) {
    value += refWorth(chain[i]);
    if (!i) continue;
    const a = chain[i - 1], b = chain[i];
    if (b.startMin <= a.startMin) return { ok: false };
    const miss = Math.max(0, refNeed(v, a, b) - (b.startMin - a.endMin));
    // Missing is fine up to 5 minutes, and never more than a quarter of either session.
    if (miss > REF.maxMiss || 4 * miss > a.endMin - a.startMin || 4 * miss > b.endMin - b.startMin) return { ok: false };
    value -= miss * REF.perMissedMin;
    missed += miss;
  }
  return { ok: true, value, missed };
}
// Can lunch start at minute t? It sits inside the window, overlaps no session, and leaves the
// walk between the sessions around it either before or after eating.
function refLunchAt(v, chain, L, t) {
  const end = t + REF.lunchLength;
  if (t < L.from || end > L.to) return false;
  if (!chain.length || end <= chain[0].startMin || t >= Math.max(...chain.map(x => x.endMin))) return true;
  for (let i = 1; i < chain.length; i++) {
    const a = chain[i - 1], b = chain[i], need = refNeed(v, a, b);
    if (t >= a.endMin && end <= b.startMin && (end + need <= b.startMin || a.endMin + need <= t)) return true;
  }
  return false;
}
const refLunchFits = (v, chain, L) => { for (let t = L.from; t <= L.to; t++) if (refLunchAt(v, chain, L, t)) return true; return false; };
const byStart = xs => xs.slice().sort((a, b) => a.startMin - b.startMin);
// Every combination that keeps each lock and block and attends no session twice; the best value.
function refBest(v, items, L = null, { keepLocks = true } = {}) {
  const days = [...new Set(items.map(x => x.day))];
  let best = -Infinity;
  for (let m = 0; m < 1 << items.length; m++) {
    const sel = items.filter((_, i) => (m >> i) & 1);
    if (items.some((x, i) => (keepLocks || x.pseudo === 'block') && x.locked && !((m >> i) & 1))) continue;
    if (new Set(sel.map(x => x.id)).size !== sel.length) continue;
    let total = 0, ok = true;
    for (const d of days) {
      const chain = byStart(sel.filter(x => x.day === d)), c = refChain(v, chain);
      if (!c.ok) { ok = false; break; }
      total += c.value + (L && refLunchFits(v, chain, L) ? L.weight : 0);
    }
    if (ok && total > best) best = total;
  }
  return best;
}

test('the reference and the planner agree with the plan rules worked by hand', () => {
  const v = REF_VENUES[0], ctx = refCtx(v);
  const [W2a, , W3a, S1a, Ma, Ca] = v.rooms.map(r => r[2]);
  const s = (label, start, end, extra = {}) => refSession(v, label, start, end, { priority: 2, ...extra });
  const lunch40 = { from: H(11.5), to: H(13.5), length: 30, weight: 40 };
  const lockedMaybe = s(W3a, H(9.5), H(10.5), { priority: 1, locked: true }), must = s(W2a, H(9), H(10), { priority: 3 });
  const block = refBlock(v, 'block:hand', '2026-11-18', H(9), H(10)), blockedMust = s(W2a, H(9.5), H(10.5), { priority: 3 });
  const easy = [s(S1a, H(9), H(10)), s(Ma, H(10) + 11, H(11) + 11), s(S1a, H(10) + 11, H(11) + 11, { recorded: true, type: 'Lab' })];
  // West to South is 7 minutes plus the buffer: leave at 11:21, arrive 11:30, eat until noon.
  const walkFirst = [s(W2a, H(10.5), H(11.5) - 9), s(S1a, H(12), H(13.5))];
  const toChase = s(W2a, H(9), H(10)), chaseBlock = refBlock(v, 'block:chase', '2026-11-18', H(10) + 42, H(11.5), v.keynoteBlock);
  const cases = [
    ['a Must that is not recorded', [s(W2a, H(9), H(10), { priority: 3, recorded: false })], null, 110],
    ['a recorded Maybe lab', [s(W2a, H(9), H(10), { priority: 1, recorded: true, type: 'Lab' })], null, 15],
    ['a workbook score replaces the tier', [s(W2a, H(9), H(10), { priority: 3, score: 7 })], null, 70],
    ['five minutes missed between buildings', [s(S1a, H(9), H(10)), s(Ma, H(10) + 11, H(11) + 11)], null, 90],
    ['an easy move beats a tight one worth a little more', easy, null, 95],
    ['six minutes missed', [s(S1a, H(9), H(10)), s(Ma, H(10) + 10, H(11) + 10)], null, 50],
    ['a 20-minute session can be missed by 5 minutes', [s(S1a, H(9), H(10)), s(Ma, H(10) + 11, H(10) + 31)], null, 90],
    ['a 19-minute session only by 4', [s(S1a, H(9), H(10)), s(Ma, H(10) + 11, H(10) + 30)], null, 50],
    ['a keynote one floor up, 22 minutes later', [s(W2a, H(9), H(10)), s(W3a, H(10) + 22, H(11), { type: 'Keynote' })], null, 100],
    ['a keynote one floor up, 21 minutes later', [s(W2a, H(9), H(10)), s(W3a, H(10) + 21, H(11), { type: 'Keynote' })], null, 98],
    ['a keynote one floor up, 16 minutes later', [s(W2a, H(9), H(10)), s(W3a, H(10) + 16, H(11), { type: 'Keynote' })], null, 50],
    ['a gap one minute short of lunch and the walk', [s(W2a, H(11), H(12)), s(S1a, H(12) + 38, H(13.5))], lunch40, 100],
    ['a gap just long enough for lunch and the walk', [s(W2a, H(11), H(12)), s(S1a, H(12) + 39, H(13.5))], lunch40, 140],
    ['walk to the next room first, then eat', walkFirst, lunch40, 140],
    ['a minute too late to walk first, then eat', [s(W2a, H(10.5), H(11.5) - 8), s(S1a, H(12), H(13.5))], lunch40, 100],
    ['a minute too early to eat after the walk', [s(W2a, H(10.5), H(11.5) - 9), s(S1a, H(12) - 1, H(13.5))], lunch40, 100],
    ['blocked time at Chase Center needs the walk, no keynote entry', [toChase, chaseBlock], null, 50],
    ['blocked time at Chase Center a minute short of the walk', [toChase, refBlock(v, 'block:chase41', '2026-11-18', H(10) + 41, H(11.5), v.keynoteBlock)], null, 48],
    ['a session at Chase Center needs the keynote entry', [toChase, s(Ca, H(10) + 42, H(11.5))], null, 50],
    ['a locked Maybe against a Must', [must, lockedMaybe], null, 20],
    ['a Must during blocked time', [block, blockedMust], null, 0],
  ];
  for (const [name, items, L, want] of cases) {
    eq(refBest(v, items, L), want, `${name} (reference)`);
    eq(optimize(items, ctx, L && lunchConfig({ on: true, ...L })).value, want, `${name} (planner)`);
  }
  eq(optimize([must, lockedMaybe], ctx).plan['2026-11-18'].map(x => x.key), [lockedMaybe.key], 'the locked Maybe is planned, the Must is not');
  eq(optimize([block, blockedMust], ctx).plan['2026-11-18'].map(x => x.key), [block.key], 'the blocked time is planned, the Must is not');
  eq(optimize(easy, ctx).plan['2026-11-18'].map(x => x.key), [easy[0].key, easy[2].key], 'the lab in the same room, not the tight walk to the Marriott');
  const lunchFirst = optimize(walkFirst, ctx, lunchConfig({ on: true, ...lunch40 }));
  eq([lunchFirst.plan['2026-11-18'].map(x => x.key), lunchFirst.lunch['2026-11-18']], [walkFirst.map(x => x.key), { start: H(11.5), end: H(12) }], 'both Wants, lunch 11:30-12:00 after the walk');
  eq(optimize([toChase, chaseBlock], ctx).plan['2026-11-18'].map(x => x.key), [toChase.key, chaseBlock.key], 'the Want and the blocked time at Chase Center');
});

test('optimizer matches the independent reference with locks, blocked time and lunch at three venues', () => {
  // The high bits: this generator's low bits repeat with a short period.
  const lcg = seed => k => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return Math.floor(seed / 0x80000000 * k); };
  const rnd = lcg(4242), rndChase = lcg(77);   // a second stream, so Chase Center blocks leave the other draws as they were
  // The walking minutes and keynote buildings typed into REF_VENUES are the ones each venue publishes.
  for (const v of REF_VENUES) {
    const blocks = [v.block, v.keynoteBlock].filter(Boolean), places = [...v.rooms, ...blocks];
    const locOf = r => (blocks.includes(r) ? refBlock(v, 'b', v.days[0], 0, 1, r).loc : v.planner.parse(r[2]));
    for (const a of places) for (const b of places) eq(walkMinutes(locOf(a), locOf(b), v.planner.walk), refWalk(v, a, b), `${v.name}: ${a[2]} -> ${b[2]}`);
    eq(v.planner.keynoteBuildings, v.keynoteVenues, `${v.name}: keynote buildings`);
  }
  const seen = { Ignite: 0, 're:Invent': 0, Gartner: 0, lockDecides: 0, blockDisplaces: 0, lunchDays: 0, noLunchDays: 0, lunchCosts: 0,
    tight: 0, keynoteEntry: 0, keynoteBlockNoEntry: 0, lockedRepeat: 0, scored: 0 };
  let done = 0;
  for (let tries = 0; done < 300; tries++) {
    if (tries > 2000) throw new Error(`only ${done} usable instances in ${tries} tries`);
    const v = REF_VENUES[rnd(REF_VENUES.length)];
    const n0 = 3 + rnd(6), items = [];
    for (let i = 0; i < n0; i++) {
      const start = H(10.5) + rnd(49) * 5, room = v.rooms[rnd(v.rooms.length)];
      items.push(refSession(v, room[2], start, start + [15, 20, 30, 45, 60, 90][rnd(6)], {
        id: `g${rnd(Math.max(2, n0 - 2))}`, day: v.days[rnd(2)], priority: 1 + rnd(3), recorded: [true, false, null][rnd(3)],
        type: v.types[rnd(v.types.length)], score: rnd(6) ? undefined : 1 + rnd(13), locked: rnd(5) === 0,
      }));
    }
    const sessionDays = [...new Set(items.map(x => x.day))];
    for (let b = [0, 0, 1, 2][rnd(4)]; b > 0; b--) {
      let start = H(10) + rnd(49) * 5, room = v.block;
      const day = sessionDays[rnd(sessionDays.length)], length = [30, 60][rnd(2)];
      // At Ignite, half the blocked time is at Chase Center, starting 40 to 55 minutes after a session
      // ends: around the 42-minute walk, where a keynote entry would cost minutes.
      if (v.keynoteBlock && rndChase(2)) {
        const that = items.filter(x => !x.pseudo && x.day === day);
        start = that[rndChase(that.length)].endMin + 40 + 5 * rndChase(4);
        room = v.keynoteBlock;
      }
      items.push(refBlock(v, `block:${tries}-${b}`, day, start, start + length, room));
    }
    const L = rnd(4) ? { from: v.lunch[0], to: v.lunch[1], length: 30, weight: [15, 40, 120][rnd(3)] } : null;
    const best = refBest(v, items, L);
    if (best === -Infinity) continue;   // locks and blocked time that can't all be kept: not this test's subject
    done++;

    const res = optimize(items, refCtx(v), L && lunchConfig({ on: true, ...L }));
    const planned = Object.values(res.plan).flat();
    const where = `${v.name} instance ${done}`;
    eq(items.filter(x => x.locked && !planned.includes(x)).map(x => x.key), [], `${where}: every lock and block kept`);
    eq(new Set(planned.map(x => x.id)).size, planned.length, `${where}: no session twice`);
    eq([res.lockedConflicts, res.unscheduled], [[], []], `${where}: nothing locked left out, nothing unscheduled`);
    eq(res.dropped.map(d => d.item.key).sort(), items.filter(x => !planned.includes(x)).map(x => x.key).sort(), `${where}: everything not planned is listed as dropped`);
    // The planner's own plan, priced by the reference, is feasible and as good as the best.
    let mine = 0;
    for (const d of sessionDays) {
      const chain = byStart(res.plan[d] || []), c = refChain(v, chain), slot = res.lunch[d];
      ok(c.ok, `${where}: ${d} can't be walked: ${chain.map(x => `${x.refRoom[2]} ${x.startMin}-${x.endMin}`).join(', ')}`);
      ok(!slot || (L && slot.end - slot.start === REF.lunchLength && refLunchAt(v, chain, L, slot.start)), `${where}: ${d} lunch ${JSON.stringify(slot)} doesn't fit`);
      mine += c.value + (slot ? L.weight : 0);
      if (c.missed) seen.tight++;
      if (L) seen[slot ? 'lunchDays' : 'noLunchDays']++;
      if (chain.some((x, i) => i && x.type === 'Keynote' && refNeed(v, chain[i - 1], x) > refWalk(v, chain[i - 1].refRoom, x.refRoom) + REF.buffer)) seen.keynoteEntry++;
      // Blocked time in a keynote building, reached so tightly that a keynote entry would have cost minutes.
      if (chain.some((x, i) => i && x.pseudo && v.keynoteVenues.includes(x.refRoom[0]) && x.refRoom[2] !== chain[i - 1].refRoom[2]
        && x.startMin - chain[i - 1].endMin < refNeed(v, chain[i - 1], x) + REF.keynoteEntry)) seen.keynoteBlockNoEntry++;
    }
    eq([mine, res.value], [best, best], `${where}: plan value (priced by the reference, by the planner) vs the best`);

    seen[v.name]++;
    if (refBest(v, items, L, { keepLocks: false }) > best) seen.lockDecides++;
    if (items.some(b => b.pseudo === 'block' && items.some(x => !x.pseudo && x.day === b.day && !refChain(v, byStart([b, x])).ok))) seen.blockDisplaces++;
    if (items.some(x => x.locked && !x.pseudo && items.some(y => y !== x && y.id === x.id))) seen.lockedRepeat++;
    if (planned.some(x => Number.isFinite(x.score))) seen.scored++;
    if (L && best < refBest(v, items) + L.weight * sessionDays.length) seen.lunchCosts++;   // on some day lunch cost a session, or did not fit
  }
  // The random weeks did exercise what this test is for.
  for (const [k, count] of Object.entries(seen)) ok(count >= 10, `only ${count} with ${k}: ${JSON.stringify(seen)}`);
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
test('explainDrop says when the dropped run of a repeat also clashes', () => {
  const blocker = item(H(9), H(10), W2, { priority: 3 });
  const r1 = item(H(9), H(10), W3, { id: 'R2', code: 'BRK8' }), r2 = item(H(9), H(10), W3, { id: 'R2', code: 'BRK8-R1', day: '2026-11-19' });
  const d = optimize([blocker, r1, r2]).dropped.find(x => x.item.key === r1.key);
  eq([d.reason.kind, d.reason.clash], ['repeat', true]);
});

test('nowNext uses the start-of-day origin and keynote entry time', () => {
  const C = parseLocation('Chase Center');
  const key = item(H(9), H(11), C, { type: 'Keynote' });
  const r = nowNext([key], H(8), DEFAULT_PLANNER, parseLocation('Moscone West'));
  eq(r.walk, DEFAULT_WALK.pairs['C|W']);
  eq(r.leaveBy, H(9) - DEFAULT_WALK.pairs['C|W'] - DEFAULT_PLANNER.buffer - DEFAULT_PLANNER.keynoteExtra);
});

test('blocked time is a chain item with a real location', () => {
  const M = parseLocation('Marriott Marquis, Yerba Buena Ballroom, BO1');
  const blk = { key: 'block:1', id: 'block:1', code: 'Meeting', title: 'Customer meeting', pseudo: 'block', weight: 1e7, locked: true, priority: 0, day: '2026-11-18', startMin: H(12), endMin: H(13), loc: M };
  const a = item(H(11), H(11.5), S1);          // S -> M: 14 + 2 = 16 <= 30 min gap
  const b = item(H(13.25), H(14), W2);         // M -> W: 13 + 2 = 15 <= 15 min gap
  const res = optimize([blk, a, b]);
  eq(res.plan['2026-11-18'].map(x => x.key), [a.key, blk.key, b.key]);
  eq(transition(a, blk).walk, DEFAULT_WALK.pairs['M|S']);
  eq(weigh(blk).score > 1e7, true);
  const during = item(H(12), H(12.75), W2);
  eq(decisionGroups([blk, during]).length, 0, 'blocks are not decisions');
  eq(optimize([blk, during]).dropped[0].reason.kind, 'block');
});

test('two overlapping runs of one session are not a decision to make', () => {
  const r1 = item(H(9), H(10), W2, { id: 'rep4', code: 'BRK903' }), r2 = item(H(9.5), H(10.5), W3, { id: 'rep4', code: 'BRK903-R1' });
  eq(decisionGroups([r1, r2]), []);
});
test('two overlapping different sessions are a decision to make', () => {
  eq(decisionGroups([item(H(9), H(10), W2), item(H(9.5), H(10.5), W3)]).length, 1);
});

// --- where you are now ("I'm at…" or GPS) and comparing the options of a clash
test("leave-by counts from where you are, not from your last session's room", () => {
  const done = item(H(9), H(10), S1), next = item(H(11), H(12), W3);
  const here = { ...parseLocation('Moscone West, Level 2'), live: true };
  const r = nowNext([done, next], H(10.5), DEFAULT_PLANNER, here);
  eq([r.from.key, r.leaveBy], ['origin', H(11) - walkMinutes(here, W3) - DEFAULT_PLANNER.buffer]);
});
test('compareOptions releases the session\'s own lock on another run, but never blocked time', () => {
  // The locked Tuesday run of a lab sits inside blocked time; its Wednesday run is on a card.
  const tue = item(H(9), H(10.25), W2, { id: 'lab', code: 'LAB', priority: 3, locked: true, day: '2026-11-17' });
  const block = { key: 'block:1', id: 'block:1', code: 'Dinner', title: 'Dinner', pseudo: 'block', weight: 1e7, locked: true, priority: 0, day: '2026-11-17', startMin: H(9), endMin: H(11), loc: W2 };
  const wed = item(H(9), H(10.25), W2, { id: 'lab', code: 'LAB-R1', priority: 3, day: '2026-11-18' });
  const other = item(H(9.5), H(10.5), S1, { priority: 2, day: '2026-11-18' });
  const { outcomes } = compareOptions([tue, block, wed, other], [wed, other]);
  eq(outcomes.get(wed.key).feasible, true, 'choosing the Wednesday run replaces the Tuesday lock');
  eq(outcomes.get(wed.key).chosen.find(x => x.key === block.key)?.locked, true, 'the blocked time stays, and stays locked');
  eq(outcomes.get(wed.key).chosen.some(x => x.key === tue.key), false);
});
test('choosing the other side of a clash with a locked session is possible: the lock gives way', () => {
  const locked = item(H(9), H(10), W2, { priority: 3, locked: true }), other = item(H(9.5), H(10.5), S1, { priority: 2 });
  const { outcomes } = compareOptions([locked, other], [locked, other]);
  eq([outcomes.get(other.key).feasible, outcomes.get(locked.key).feasible], [true, true]);
});

// --- small time and venue helpers the pages show
test('a late Eastern session belongs to its local day, not the UTC one', () => {
  eq(fromISO('2026-10-21T01:00:00Z', 'America/New_York'), { day: '2026-10-20', min: 21 * 60 });
});
test('two different off-site hotels are a long walk, not a same-floor hop', () => {
  eq(walkMinutes(parseLocation('Hilton Union Square'), parseLocation('Westin St. Francis'), DEFAULT_WALK), 12);
});
test('relative times read naturally', () => {
  const now = Date.parse('2026-10-07T12:00:00Z'), ago = s => new Date(now - s * 1000).toISOString();
  eq([ago(30), ago(5 * 60), ago(3 * 3600), ago(2 * 86400), null, 'not a date'].map(t => relTime(t, now)),
    ['just now', '5 min ago', '3 h ago', '2 d ago', 'never', 'unknown']);
});
test('durations read in hours and minutes', () => {
  eq([45, 60, 90, NaN].map(fmtDuration), ['45 min', '1 h', '1 h 30 min', '']);
});
test('a time range reads as start – end', () => {
  eq(fmtRange(540, 600), '9:00 AM – 10:00 AM');
});

// --- lunch: a slot in a gap, never a place

const LUNCH = { from: H(11.5), to: H(13.5), length: 30, weight: 40 };
const D = '2026-11-18';

test('lunch never hides the walk between the sessions around it (review)', () => {
  const key = item(H(12), H(13), parseLocation('Chase Center'), { type: 'Keynote', priority: 3 });
  const thr = item(H(13.5), H(14), W3, { priority: 3 });
  const res = optimize([key, thr], DEFAULT_PLANNER, LUNCH);
  eq(Object.values(res.plan).flat().length, 1, '40 min walk + 2 + 15 keynote entry > 30 min gap');
});

test('lunch is taken only in a gap long enough for walking and eating', () => {
  const a = item(H(11), H(12), W2), b = item(H(12.75), H(13.5), parseLocation('Moscone West, Level 2, Room 2005'));
  const res = optimize([a, b], DEFAULT_PLANNER, LUNCH);
  const l = res.lunch[D];
  ok(l && l.start >= H(12) && l.end + DEFAULT_WALK.sameFloor + 2 <= H(12.75), `slot ${JSON.stringify(l)}`);
  eq(res.value, chainValue([a, b]) + 40);
  const c = item(H(12.25), H(13.25), S1);      // 15 min gap from a, 14 needed: no room to eat
  const r2 = optimize([a, c], DEFAULT_PLANNER, LUNCH);
  eq(Object.values(r2.plan).flat().length, 2);
  eq(r2.lunch[D], null);
});

test('lunch before the first or after the last session', () => {
  eq(optimize([item(H(13.5), H(14.25), W2)], DEFAULT_PLANNER, LUNCH).lunch[D], { start: H(13), end: H(13.5) });
  eq(optimize([item(H(9), H(10), W2)], DEFAULT_PLANNER, LUNCH).lunch[D], { start: H(11.5), end: H(12) });
});

test('lunch outranks only what it is worth more than', () => {
  const a = item(H(11.5), H(12.25), W2), b = item(H(12.5), H(13.25), W2); // same room, 15 min gap: no lunch
  const res = optimize([a, b], DEFAULT_PLANNER, LUNCH);
  eq([Object.values(res.plan).flat().length, res.lunch[D]], [2, null], 'two Wants (100) beat lunch (40)');
  const maybe = item(H(11.5), H(13.5), W2, { priority: 1 });
  const r2 = optimize([maybe], DEFAULT_PLANNER, LUNCH);
  eq([Object.values(r2.plan).flat().length, !!r2.lunch[D]], [0, true], 'a Maybe (20) over the whole window loses to lunch (40)');
});

test('lunch turned off in Settings keeps a Maybe that lunch would otherwise beat', () => {
  const maybe = item(H(11.5), H(13.5), W2, { priority: 1 });
  const res = optimize([maybe], DEFAULT_PLANNER, lunchConfig({ ...LUNCH, on: false }));
  eq([Object.values(res.plan).flat().length, res.lunch[D] ?? null], [1, null]);
});
test('a lunch longer than its window plans no lunch', () => {
  eq(lunchConfig({ ...LUNCH, length: 180 }), null);
});
test('lunch settings saved as text still plan a lunch', () => {
  const fromText = lunchConfig({ on: true, from: '690', to: '810', length: '30', weight: '40' });
  eq(optimize([item(H(9), H(10), W2)], DEFAULT_PLANNER, fromText).lunch[D], { start: H(11.5), end: H(12) });
});
test('lunch does not multiply the repeat-run search (review e5)', () => {
  const A = item(H(9), H(10), W2, { id: 'A', code: 'A', day: '2026-11-17' });
  const B = item(H(9), H(10), W2, { id: 'B', code: 'B', day: D });
  const C = item(H(9), H(10), W3, { id: 'C', code: 'C', day: D });
  const C1 = item(H(9), H(10), W3, { id: 'C', code: 'C-R1', day: '2026-11-19' });
  const E = item(H(10.25), H(11), W3, { id: 'E', code: 'E', day: '2026-11-19' });
  const res = optimize([A, B, C, C1, E], DEFAULT_PLANNER, LUNCH);
  const chosen = Object.values(res.plan).flat();
  ok(chosen.some(x => x.key === C1.key), 'C attended via its repeat');
  eq(chosen.length, 4);
  eq(Object.values(res.lunch).filter(Boolean).length, 3, 'lunch on all three days');
});

test('whatIf compares the whole plan: a session that moves to its repeat is not missed', () => {
  const b1 = item(H(9), H(10), W2, { id: 'BRK1', code: 'BRK1', priority: 3, day: '2026-11-17' });
  const b2 = item(H(9), H(10), S1, { id: 'BRK2', code: 'BRK2', priority: 3, day: '2026-11-17' });
  const b3 = item(H(10) + 5, H(10.75), S1, { id: 'BRK3', code: 'BRK3', day: '2026-11-17' }); // reachable from BRK2 only
  const b3r = item(H(10), H(11), W2, { id: 'BRK3', code: 'BRK3-R1', day: D });
  const all = [b1, b2, b3, b3r];
  const w1 = whatIf(all, b1.key, new Set(all.map(x => x.key)));
  const w2 = whatIf(all, b2.key, new Set(all.map(x => x.key)));
  eq([w1.feasible, w2.feasible], [true, true]);
  eq(w1.value, w2.value, 'a real toss-up');
  ok(w1.chosen.some(x => x.key === b3r.key), 'BRK3 moves to Wed when BRK1 is chosen');
});

test('nowNext treats lunch as a slot, never as a place to walk from', () => {
  const a = item(H(11), H(12), W2), b = item(H(13), H(13.75), S1);
  const l = { start: H(12), end: H(12.5) };
  const r = nowNext([a, b], H(12) + 10, DEFAULT_PLANNER, null, l);
  eq([r.current.pseudo, r.next.key, r.from.key, r.walk], ['lunch', b.key, a.key, SW]);
  eq(r.leaveBy, H(13) - SW - DEFAULT_PLANNER.buffer);
  const r2 = nowNext([a, b], H(11.5), DEFAULT_PLANNER, null, l);
  eq([r2.current.key, r2.next.pseudo, r2.leaveBy], [a.key, 'lunch', null]);
});

test('your own score overrides the tier weights', () => {
  const a = item(H(9), H(10), W2, { priority: 1, score: 13 });
  eq(weigh(a).score, 130);
  ok(/your score 13/.test(weigh(a).why[0]));
  const b = item(H(9), H(10), W3, { priority: 3 });
  eq(optimizeDay([a, b]).chosen[0].key, a.key);
});

// --- Las Vegas (re:Invent)
const LV = createVenue(LAS_VEGAS_DEF);
const lv = r => LV.parseLocation(r);
const LVW = LV.walk;
test('Las Vegas: the building comes from the first segment', () => {
  eq(['MGM Grand | Level 1 | Grand 122', 'Wynn/Encore | Level 1 | Chopin 4', 'Caesars Palace | Promenade Level | Roman I',
    'Caesars Forum | Level 1 | Forum 120 | Content Hub | Purple Theater', 'Venetian | Level 2 | Hall B | Expo | Industry Theater']
    .map(r => lv(r).building), ['M', 'W', 'C', 'F', 'V']);
});
test('Las Vegas: numbered levels parse as floors', () => {
  eq(lv('MGM Grand | Level 3 | Premier 311').floor, '3');
});
test('Las Vegas: named promenades parse as floors', () => {
  eq(['Caesars Palace | Promenade Level | Roman I', 'Caesars Palace | Promenade South | Milano I',
    'Wynn/Encore | Convention Promenade | Lafite 4', 'Wynn/Encore | Upper Convention Promenade | Cristal 5',
    'Wynn/Encore | Lower Convention Promenade | Fleurie', 'Caesars Palace | Emperors Level | Palace Ballroom I']
    .map(r => lv(r).floor), ['Promenade Level', 'Promenade South', 'Convention Promenade', 'Upper Convention Promenade',
    'Lower Convention Promenade', 'Emperors Level']);
});
test('Las Vegas: two theaters in one Content Hub are a same-floor walk, not the same room', () => {
  eq(walkMinutes(lv('Caesars Forum | Level 1 | Forum 120 | Content Hub | Purple Theater'),
    lv('Caesars Forum | Level 1 | Forum 120 | Content Hub | Red Theater'), LVW), LVW.sameFloor);
});
test('Las Vegas: Caesars Palace then Caesars Forum 15 minutes later is fine (a short walk)', () => {
  const palace = lv('Caesars Palace | Promenade Level | Roman I'), forum = lv('Caesars Forum | Level 1 | Forum 120');
  eq(transition(item(H(9), H(10), palace), item(H(10) + 15, H(11), forum), { ...DEFAULT_PLANNER, walk: LVW, keynoteBuildings: [] }).status, 'ok');
});
test('Las Vegas: changing floors in one resort takes the diffFloor estimate', () => {
  eq(walkMinutes(lv('MGM Grand | Level 1 | Grand 122'), lv('MGM Grand | Level 3 | Premier 311'), LVW), LVW.diffFloor);
});
test('Las Vegas: every building pair has a walking estimate', () => {
  const ids = LV.ids.filter(id => id !== 'O');
  const missing = ids.flatMap(a => ids.filter(b => a < b).map(b => `${a}|${b}`)).filter(k => LVW.pairs[k] == null);
  eq(missing, []);
});
// Plans at the Gartner and re:Invent venues, through their own walking times.
const SD = createVenue(SWAN_DOLPHIN_DEF);
const at = (venue, keynote = []) => ({ ...DEFAULT_PLANNER, walk: venue.walk, keynoteBuildings: keynote });
const dolphin = SD.parseLocation('Upper Peninsula 4, WDW Dolphin Hotel');
const beachClub = SD.parseLocation("Grand Harbor Salon 1, Disney's Yacht & Beach Resort");
test('Gartner: the Dolphin then the Yacht & Beach Club 10 minutes later is a conflict', () => {
  eq(transition(item(H(9), H(10), dolphin), item(H(10) + 10, H(11), beachClub), at(SD)).status, 'conflict');
});
test('Gartner: the Dolphin then the Yacht & Beach Club 20 minutes later is fine', () => {
  eq(transition(item(H(9), H(10), dolphin), item(H(10) + 20, H(11), beachClub), at(SD)).status, 'ok');
});
test('Gartner: a plan keeps only one of two Musts too far apart to walk between', () => {
  const a = item(H(9), H(10), dolphin, { priority: 3 }), b = item(H(10) + 10, H(11), beachClub, { priority: 3 });
  eq(optimize([a, b], at(SD)).plan['2026-11-18'].length, 1);
});
test('Las Vegas: the MGM Grand then the Venetian 20 minutes later is a conflict', () => {
  const mgm = lv('MGM Grand | Level 1 | Grand 122'), venetian = lv('Venetian | Level 2 | Hall B');
  eq(transition(item(H(9), H(10), mgm), item(H(10) + 20, H(11), venetian), at(LV)).status, 'conflict');
});
test('a session at Caesars Palace gets no keynote entry time', () => {
  const ctx = { ...DEFAULT_PLANNER, keynoteBuildings: LV.keynoteBuildings };
  eq(arrivalExtra(item(H(9), H(10), lv('Caesars Palace | Promenade Level | Roman I')), ctx), 0);
});
test('a re:Invent keynote still gets keynote entry time', () => {
  const ctx = { ...DEFAULT_PLANNER, keynoteBuildings: LV.keynoteBuildings };
  eq(arrivalExtra(item(H(9), H(10), lv('Venetian | Level 2 | Hall D'), { type: 'Keynote' }), ctx), ctx.keynoteExtra);
});
test('Chase Center still gets keynote entry time at Ignite', () => {
  eq(arrivalExtra(item(H(9), H(10), parseLocation('Chase Center')), DEFAULT_PLANNER), DEFAULT_PLANNER.keynoteExtra);
});
test('re:Invent session links search the catalog by code', () => {
  eq(CONFERENCES.reinvent2026.sessionUrl({ code: 'DVT212-S' }),
    'https://registration.awsevents.com/flow/awsevents/reinvent2026/eventcatalog/page/eventcatalog?search=DVT212-S');
});
test('share links accept re:Invent session codes', () => {
  const ids = { 'DVT212-S': 'a', 'ANT319-R': 'b', 'INV002-S-R1': 'c' };
  eq(Object.keys(parseShare('DVT212-S.3~ANT319-R.2!ANT319-R~INV002-S-R1.1', c => ids[c], c => ids[c])), ['a', 'b', 'c']);
});

// ---- Up next: what's coming up that I care about, and how far it is
const un = (key, startMin, endMin, extra = {}) => ({ key, group: key, code: key, title: key, day: 'd1', inPerson: true, startMin, endMin, ...extra });
const unRun = (sessions, o = {}) => upNext({
  sessions, day: 'd1', nowMin: 660, horizon: 120, tolerance: 5,
  walkTo: s => s.walk ?? null, prio: s => s.prio ?? null, interest: s => s.interest ?? 0,
  chosen: s => !!s.planned, minInterest: 25, ...o });
const unStatus = slots => Object.fromEntries(slots.flatMap(x => x.items).map(i => [i.s.key, i.status]).sort());
const unKeys = slots => slots.map(x => x.items.map(i => i.s.key));

test('up next lists planned, rated and likely sessions, not rejected or unrelated ones', () => {
  const slots = unRun([
    un('A', 690, 720, { planned: true }), un('B', 690, 720, { prio: 2 }), un('C', 690, 720, { interest: 40 }),
    un('D', 690, 720, { prio: 0 }), un('E', 690, 720, { interest: 10 }), un('F', 690, 720)]);
  eq(unKeys(slots).flat().sort(), ['A', 'B', 'C']);
});
test('a rejected session stays hidden even when planned or resembling picks', () => {
  eq(unKeys(unRun([un('D', 690, 720, { prio: 0, planned: true, interest: 90 }), un('ok', 690, 720, { prio: 1 })])), [['ok']]);
});
test('up next groups by start time inside the horizon', () => {
  const slots = unRun([un('L', 800, 830, { prio: 1 }), un('Y', 720, 750, { prio: 1 }), un('X', 690, 720, { prio: 1 })]);
  eq(slots.map(x => x.startMin), [690, 720]);
  eq(unKeys(slots), [['X'], ['Y']]);
});
test('the horizon is inclusive at its edge and refuses just beyond it', () => {
  eq(unKeys(unRun([un('in', 780, 810, { prio: 1 }), un('out', 781, 810, { prio: 1 })])), [['in']]);
});
test('enough time: walk and spare minutes', () => {
  const [{ items: [i] }] = unRun([un('S', 690, 720, { prio: 1, walk: 9 })]);
  eq([i.walk, i.slack, i.status], [9, 21, 'ok']);
});
test('arriving exactly at the start is fine; one minute past the tolerance is not', () => {
  const r = unRun([un('edge', 669, 700, { prio: 1, walk: 9 }), un('tol', 665, 700, { prio: 1, walk: 10 }), un('late', 665, 700, { prio: 1, walk: 11 })]);
  const by = unStatus(r);
  eq(by, { edge: 'ok', late: 'unreachable', tol: 'ok' });
});
test('unreachable sessions sort after reachable ones in their group', () => {
  const r = unRun([un('far', 665, 700, { prio: 3, walk: 18 }), un('near', 665, 700, { prio: 1, walk: 2 })]);
  eq(unKeys(r), [['near', 'far']]);
  eq(r[0].items.map(i => i.status), ['ok', 'unreachable']);
});
test('a session in progress is listed as such and reachable until 15 minutes before it ends', () => {
  const r = unRun([un('now', 645, 705, { prio: 1, walk: 5 }), un('over', 645, 670, { prio: 1, walk: 5 }), un('gone', 600, 660, { prio: 1, walk: 1 })]);
  const by = unStatus(r);
  eq(by, { now: 'inprogress', over: 'unreachable' }); // 'gone' ended and is not listed
});
test('in-progress cutoff: 15 minutes left is joinable, 14 is not', () => {
  // now 660, walk 5 -> arrive 665; ends 680 leaves exactly 15, ends 679 leaves 14
  eq(unStatus(unRun([un('edge', 645, 680, { prio: 1, walk: 5 }), un('short', 645, 679, { prio: 1, walk: 5 })])), { edge: 'inprogress', short: 'unreachable' });
});
test('lateness never exceeds a quarter of the session, and never reaches past its end', () => {
  // tolerance 5: a 20-min session allows 5, a 16-min allows 4, a 2-min allows 0
  const r = unRun([un('q20', 665, 685, { prio: 1, walk: 10 }), un('q16', 665, 681, { prio: 1, walk: 9 }), un('q16late', 665, 681, { prio: 1, walk: 10 }), un('tiny', 665, 667, { prio: 1, walk: 6 }), un('tinyok', 665, 667, { prio: 1, walk: 5 })]);
  eq(unStatus(r), { q16: 'ok', q16late: 'unreachable', q20: 'ok', tiny: 'unreachable', tinyok: 'ok' });
});
test('unknown position lists sessions with no walk time and no verdict', () => {
  const [{ items: [i] }] = unRun([un('U', 690, 720, { prio: 1 })]);
  eq([i.walk, i.slack, i.status], [null, null, 'unknown']);
});
test('within a group planned sessions come first, then higher rating, then likeness', () => {
  const r = unRun([un('c', 690, 720, { interest: 60 }), un('b', 690, 720, { prio: 3 }), un('a', 690, 720, { planned: true, prio: 1 })]);
  eq(unKeys(r), [['a', 'b', 'c']]);
});
// ---- a detour is judged against where I need to be next (issue 100): walk there, the session,
// the walk on to the destination, and whether that is on time
const yacht = { building: 'Y', onward: { S: 20, D: 12 } };          // minutes from the Yacht Club on to the Swan / Dolphin
const candidate = (extra = {}) => un('C', 680, 710, { prio: 1, walk: 18, loc: yacht, ...extra });   // 11:20-11:50, 18 min from here
const swanAt = startMin => ({ key: 'N', loc: { building: 'S' }, startMin });
const detourOf = (sessions, dest) => unRun(sessions, { dest, walkBetween: (a, b) => a.onward?.[b.building] ?? null })[0].items[0].detour;

test('detour: the default destination is the next planned session, reached with time to spare', () => {
  eq(detourOf([candidate()], swanAt(750)), { onward: 20, arrive: 730, slack: 20 });   // 12:10 for a 12:30 start
});
test('detour: a later next session means arriving late', () => {
  eq(detourOf([candidate()], swanAt(725)), { onward: 20, arrive: 730, slack: -5 });
});
test('detour: a chosen place has a walk on but no deadline', () => {
  eq(detourOf([candidate()], { loc: { building: 'D' }, startMin: null }), { onward: 12, arrive: 722, slack: null });
});
const itemOf = (sessions, dest, seen = []) => unRun(sessions, { dest, walkBetween: (a, b) => { seen.push([a.building, b.building]); return a.onward?.[b.building] ?? null; } })[0].items[0];
test('detour: nothing planned after it, or the candidate is the next session itself, means no detour', () => {
  const none = itemOf([candidate()], null);
  eq([none.status, none.walk, none.detour], ['ok', 18, null], 'the candidate itself is fine; there is just nowhere to go on to');
  const self = itemOf([candidate({ key: 'N' })], swanAt(750));
  eq([self.status, self.detour], ['ok', null]);
});
test('detour: unknown onward walk or an unreachable candidate gives no detour', () => {
  const seen = [];
  const guess = itemOf([candidate({ loc: { building: 'Y' } })], swanAt(750), seen);
  eq([guess.status, guess.walk, seen, guess.detour], ['ok', 18, [['Y', 'S']], null], 'reachable, the walk on was asked for and unknown');
  const far = itemOf([candidate({ walk: 40 })], swanAt(750));
  eq([far.status, far.walk, far.detour], ['unreachable', 40, null]);
});
test('detour: with no position the walk there is unknown but the walk on is still shown', () => {
  const it = itemOf([candidate({ walk: null })], swanAt(750));
  eq([it.status, it.walk, it.detour], ['unknown', null, { onward: 20, arrive: 730, slack: 20 }]);
});
test("onwardWalk: the venue matrix for known rooms, 0 for the same room or online, null for a room the venue doesn't know", () => {
  const zTest = parseLocation('zTest1');
  eq(onwardWalk(W2, S1, DEFAULT_WALK), DEFAULT_WALK.pairs['S|W']);
  eq(onwardWalk(W2, W3, DEFAULT_WALK), DEFAULT_WALK.diffFloor);
  eq(onwardWalk(W2, W2, DEFAULT_WALK), 0);
  eq(onwardWalk(W2, { label: 'Online', building: 'O', floor: null, known: true }, DEFAULT_WALK), 0);
  eq([onwardWalk(W2, zTest, DEFAULT_WALK), onwardWalk(zTest, W2, DEFAULT_WALK), onwardWalk(W2, null, DEFAULT_WALK)], [null, null, null], 'never the matrix\'s unknown guess');
  eq(walkMinutes(W2, zTest, DEFAULT_WALK), DEFAULT_WALK.unknown, 'which the raw matrix would have given');
  const noPair = { ...DEFAULT_WALK, pairs: { ...DEFAULT_WALK.pairs } };
  delete noPair.pairs['S|W'];
  eq([onwardWalk(W2, S1, noPair), walkMinutes(W2, S1, noPair), onwardWalk(W2, W3, noPair)], [null, DEFAULT_WALK.unknown, DEFAULT_WALK.diffFloor],
    'two known buildings without a pair in the matrix: null, where the matrix would have guessed; the same building still works');
});
test('nextPlanned: the first planned session after now, skipping lunch and blocked time', () => {
  const now = H(11);
  const lunch = { key: 'lunch', pseudo: 'lunch', startMin: H(11.5), endMin: H(12) };
  const block = { key: 'block:1', pseudo: 'block', startMin: H(12), endMin: H(12.5), locked: true };
  const later = item(H(13), H(13.75), S1, { code: 'LATER' }), sooner = item(H(12.5), H(13), W2, { code: 'SOONER' }), running = item(H(10.5), H(11.5), W2, { code: 'NOW' });
  eq(nextPlanned([running, lunch, block, later, sooner], now)?.code, 'SOONER');
  eq(nextPlanned([running, lunch, block], now), null, 'only lunch and a block ahead: nothing to walk on to');
  eq(nextPlanned([], now), null);
  eq(nextPlanned(null, now), null);
});

test('online-only, other-day and ended sessions are not listed', () => {
  eq(unKeys(unRun([un('o', 690, 720, { prio: 1, inPerson: false }), un('d', 690, 720, { prio: 1, day: 'd2' }), un('e', 600, 660, { prio: 1 }), un('ok', 690, 720, { prio: 1 })])), [['ok']]);
});

log(`${pass} passed, ${fail} failed`);
if (fail) throw new Error(`${fail} test(s) failed`);
