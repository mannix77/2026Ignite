// Clash cards per time slot and the ranking of their options (specs/features/clash-ranking.feature).
// Run with: node tests/clash.test.js

import { slotGroups, rankOptions, rankTie } from '../assets/js/clash.js';
import { DEFAULT_PLANNER } from '../assets/js/planner.js';
import { parseLocation } from '../assets/js/venue.js';

let pass = 0, fail = 0;
function test(name, fn) {
  try { fn(); pass++; } catch (e) { fail++; console.log(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, msg = '') {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${msg} expected ${B}, got ${A}`);
}

const W = parseLocation('Moscone West, Level 2, Room 2001');
const S = parseLocation('Moscone South, Level 2, Room 209');
const TUE = '2026-11-17', THU = '2026-11-19';
let n = 0;
// A planned run: start/end in minutes; `extra` overrides (id = repeat group, priority 3/2/1, score, locked, reserved, recorded).
function item(start, end, extra = {}) {
  n++;
  return { key: `k${n}`, id: `s${n}`, code: `BRK${n}`, title: `T${n}`, type: 'Breakout', day: TUE, startMin: start, endMin: end,
    loc: W, recorded: null, priority: 2, locked: false, reserved: false, ...extra };
}
const H = h => Math.round(h * 60);
const ctx = DEFAULT_PLANNER;
const codes = list => list.map(x => x.code);

// ---- slots

test('should put a late starter that overlaps only placed picks on their card', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(15.25), { code: 'B' }), c = item(H(15.08), H(15.83), { code: 'C' });
  const slots = slotGroups([c, b, a], ctx);
  eq(slots.map(s => [s.day, s.start, s.end, codes(s.items)]), [[TUE, H(14), H(15.83), ['A', 'B', 'C']]]);
  eq(slots.map(s => s.resolved), [false]);
});
test('should give two later picks that overlap each other their own card', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(15.25), { code: 'B' });
  const d = item(H(15.08), H(15.83), { code: 'D' }), e = item(H(15.17), H(15.67), { code: 'E' });
  const slots = slotGroups([e, d, b, a], ctx);
  eq(slots.map(s => [s.start, codes(s.items)]), [[H(14), ['A', 'B']], [H(15.08), ['D', 'E']]]);
});
test('should attach a lone late starter to the card it overlaps most', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(14.75), { code: 'B' });
  const d = item(H(14.5), H(15.5), { code: 'D' }), e = item(H(14.5), H(15.5), { code: 'E' }), f = item(H(14.5), H(15.5), { code: 'F' });
  const late = item(H(15.25), H(16), { code: 'LATE' });
  const slots = slotGroups([a, b, d, e, f, late], ctx);
  eq(slots.map(s => codes(s.items)), [['A', 'B', 'D', 'E', 'F', 'LATE']], 'D, E, F overlap A so they are on its card; LATE overlaps three of them');
  const g = item(H(16), H(16.5), { code: 'G' }), h = item(H(16), H(16.5), { code: 'H' }), late2 = item(H(16.25), H(17), { code: 'LATE2' });
  eq(slotGroups([a, b, g, h, late2], ctx).map(s => codes(s.items)), [['A', 'B'], ['G', 'H', 'LATE2']], 'LATE2 overlaps the later card only');
});
test('should leave out a pick that overlaps nothing', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(14.75), { code: 'B' }), lone = item(H(16), H(16.75), { code: 'LONE' });
  eq(slotGroups([a, b, lone], ctx).map(s => codes(s.items)), [['A', 'B']]);
});
test('should keep runs of the same session out of one slot and keep days apart', () => {
  const a = item(H(14), H(14.75), { code: 'A', id: 'g' }), a2 = item(H(14), H(14.75), { code: 'A-R1', id: 'g' });
  const b = item(H(14), H(14.75), { code: 'B' }), thu = item(H(14), H(14.75), { code: 'THU', day: THU }), thu2 = item(H(14), H(14.75), { code: 'THU2', day: THU });
  eq(slotGroups([a, a2, b, thu, thu2], ctx).map(s => [s.day, codes(s.items)]), [[TUE, ['A', 'A-R1', 'B']], [THU, ['THU', 'THU2']]]);
});
test('should put two picks on one card when the walk between them is too long for the gap, and not when it fits', () => {
  const M = parseLocation('Marriott Marquis, Yerba Buena Ballroom, Salon 8');
  const a = item(H(14), H(14.75), { code: 'A', loc: W }), b = item(H(14.75) + 5, H(15.5) + 5, { code: 'B', loc: M });
  eq(slotGroups([a, b], ctx).map(s => [s.start, codes(s.items)]), [[H(14), ['A', 'B']]], 'a 5 min gap for a 13 min walk is a clash');
  const later = item(H(15.25), H(16), { code: 'B2', loc: M });
  eq(slotGroups([a, later], ctx), [], 'a 30 min gap is not');
});
test('should call a slot decided when a lock settles it', () => {
  const a = item(H(14), H(14.75), { code: 'A', locked: true }), b = item(H(14), H(14.75), { code: 'B' });
  eq(slotGroups([a, b], ctx).map(s => s.resolved), [true]);
});

// ---- ranking (no other runs: `runsOf` returns the option alone)

const alone = x => [x];
const rank = (opts, plan = {}, runsOf = alone) => rankOptions(opts, { plan, ctx, runsOf });

test('should rank a reserved seat first, before a Must', () => {
  const want = item(H(14), H(15.25), { code: 'LABR', priority: 2, locked: true, reserved: true }), must = item(H(14), H(14.75), { code: 'MUST', priority: 3 });
  const r = rank([must, want]);
  eq(codes(r.map(o => o.item)), ['LABR', 'MUST']);
  eq(r[0].reasons[0], 'Reserved seat');
});
test('should rank by tier, then score within a tier', () => {
  const must = item(H(14), H(14.75), { code: 'MUST', priority: 3 }), w12 = item(H(14), H(14.75), { code: 'W12', priority: 2, score: 12 }), w6 = item(H(14), H(14.75), { code: 'W6', priority: 2, score: 6 });
  eq(codes(rank([w6, w12, must]).map(o => o.item)), ['MUST', 'W12', 'W6']);
});
test('should rank an unrecorded session above a recorded one of the same tier', () => {
  const rec = item(H(14), H(14.75), { code: 'REC', recorded: true }), live = item(H(14), H(14.75), { code: 'LIVE', recorded: false });
  const r = rank([rec, live]);
  eq(codes(r.map(o => o.item)), ['LIVE', 'REC']);
  eq(r[0].reasons.includes('not recorded'), true);
});
test('should break a tie by the building of the session before or after', () => {
  const west = item(H(14), H(14.75), { code: 'A-WEST', loc: W }), south = item(H(14), H(14.75), { code: 'B-SOUTH', loc: S });
  const before = item(H(13), H(13.75), { code: 'PREV', loc: S });
  const r = rank([west, south], { [TUE]: [before] });
  eq(codes(r.map(o => o.item)), ['B-SOUTH', 'A-WEST']);
  eq(r[0].reasons.includes('same building as the session before'), true);
  eq(codes(rank([west, south]).map(o => o.item)), ['A-WEST', 'B-SOUTH'], 'without a neighbour the order falls back to the code');
});

test('should never call two unknown rooms the same building', () => {
  const U = parseLocation('');
  const a = item(H(14), H(14.75), { code: 'A-TBA', loc: U }), b = item(H(14), H(14.75), { code: 'B-TBA', loc: U });
  const before = item(H(13), H(13.75), { code: 'PREV', loc: U });
  const r = rank([b, a], { [TUE]: [before] });
  eq(codes(r.map(o => o.item)), ['A-TBA', 'B-TBA'], 'the order is the code fallback');
  eq(r.map(o => o.reasons.some(t => t.startsWith('same building'))), [false, false]);
  eq(rankTie(r), true);
  const known = item(H(13), H(13.75), { code: 'PREV2', loc: W });
  eq(rank([b, item(H(14), H(14.75), { code: 'C-WEST', loc: W })], { [TUE]: [known] })[0].item.code, 'C-WEST', 'a known building still counts');
});

// ---- other runs

test('should push down a Must whose other run is free, and say so', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const want = item(H(14), H(14.75), { code: 'WANT', priority: 2 });
  const r = rank([must, want], { [THU]: [] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['WANT', 'LAB']);
  eq(r[1].elsewhere.map(e => [e.run.code, e.free, e.clashes]), [['LAB-R1', true, []]]);
  eq(r[1].reasons.includes('also runs Thu, Nov 19 1:00 PM, nothing against it'), true);
});
test('should push down a Must whose other run only displaces a Maybe, naming it', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const maybe = item(H(13), H(13.75), { code: 'MAYBE', priority: 1, day: THU }), other = item(H(14), H(14.75), { code: 'OTHER', priority: 2 });
  const r = rank([must, other], { [THU]: [maybe] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['OTHER', 'LAB']);
  eq(r[1].elsewhere.map(e => [e.run.code, e.free, e.clashes.map(c => [c.code, c.priority])]), [['LAB-R1', false, [['MAYBE', 1]]]]);
  eq(r[1].reasons.includes('also runs Thu, Nov 19 1:00 PM, clashes with MAYBE (Maybe)'), true);
});
test('should keep a Must in place when its other run clashes with another Must, and still describe it', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const must2 = item(H(13), H(13.75), { code: 'MUST2', priority: 3, day: THU }), other = item(H(14), H(14.75), { code: 'OTHER', priority: 2 });
  const r = rank([other, must], { [THU]: [must2] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['LAB', 'OTHER']);
  eq(r[0].elsewhere, []);
  eq(r[0].alts.map(a => [a.run.code, a.clashes.map(c => c.code)]), [['LAB-R1', ['MUST2']]]);
  eq(r[0].reasons.includes('also runs Thu, Nov 19 1:00 PM, clashes with MUST2 (Must)'), true);
});
test('should count blocked time against an other run, and never as something to displace', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const other = item(H(14), H(14.75), { code: 'OTHER', priority: 2 });
  const dinner = { key: 'block:1', id: 'block:1', code: 'Dinner', title: 'Customer dinner', pseudo: 'block', locked: true, priority: 0, day: THU, startMin: H(13), endMin: H(15), loc: W };
  const r = rank([other, must], { [THU]: [dinner] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['LAB', 'OTHER']);
  eq(r[0].elsewhere, []);
  eq(r[0].alts.map(a => [a.free, a.clashes.map(c => [c.code, c.block, c.fixed])]), [[false, [['Customer dinner', true, true]]]]);
  eq(r[0].reasons.includes('also runs Thu, Nov 19 1:00 PM, clashes with Customer dinner (blocked time)'), true);
  eq(codes(rank([other, must], { [THU]: [] }, id => (id === 'lab' ? [must, thu] : [])).map(o => o.item)), ['OTHER', 'LAB'], 'without the block the run is free and the Must is pushed down');
});
test('should not treat a locked lower pick on the other run as something to displace', () => {
  const must = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3 }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const other = item(H(14), H(14.75), { code: 'OTHER', priority: 2 });
  const reservedWant = item(H(13), H(14.25), { code: 'LABR', priority: 2, locked: true, reserved: true, day: THU });
  const r = rank([other, must], { [THU]: [reservedWant] }, id => (id === 'lab' ? [must, thu] : []));
  eq(codes(r.map(o => o.item)), ['LAB', 'OTHER']);
  eq(r[0].elsewhere, []);
  eq(r[0].reasons.includes('also runs Thu, Nov 19 1:00 PM, clashes with LABR (Want, your choice)'), true);
  const plainWant = { ...reservedWant, locked: false, reserved: false };
  eq(codes(rank([other, must], { [THU]: [plainWant] }, id => (id === 'lab' ? [must, thu] : [])).map(o => o.item)), ['OTHER', 'LAB'], 'the same Want unlocked is displaceable');
});
test('should never push down a reserved seat for having a free run', () => {
  const lab = item(H(14), H(15.25), { code: 'LAB', id: 'lab', priority: 3, locked: true, reserved: true }), thu = item(H(13), H(14.25), { code: 'LAB-R1', id: 'lab', priority: 3, day: THU });
  const must = item(H(14), H(14.75), { code: 'MUST', priority: 3 });
  const r = rank([must, lab], { [THU]: [] }, id => (id === 'lab' ? [lab, thu] : []));
  eq(codes(r.map(o => o.item)), ['LAB', 'MUST']);
  eq(r[0].elsewhere.length, 1, 'the free run is still reported');
});
test('should list only the other runs outside this clash that have a time', () => {
  const a = item(H(14), H(15.25), { code: 'A', id: 'g' }), a2 = item(H(14), H(15.25), { code: 'A-R1', id: 'g' });
  const tba = { ...item(0, 0, { code: 'A-R2', id: 'g' }), day: null, startMin: null, endMin: null };
  const thu = item(H(9), H(10.25), { code: 'A-R3', id: 'g', day: THU });
  const r = rank([a, a2], {}, () => [a, a2, tba, thu]);
  eq(r.map(o => [o.item.code, o.alts.map(x => x.run.code)]), [['A', ['A-R3']], ['A-R1', ['A-R3']]]);
});

// ---- toss-up

test('should call the top two a toss-up only when every ranking rule ties', () => {
  const a = item(H(14), H(14.75), { code: 'A' }), b = item(H(14), H(14.75), { code: 'B' });
  eq(rankTie(rank([a, b])), true);
  const c = item(H(14), H(14.75), { code: 'C', score: 9 });
  eq(rankTie(rank([a, c])), false);
  eq(rankTie(rank([a])), false);
});

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
